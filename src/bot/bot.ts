// src/bot/bot.ts
import { Telegraf, Markup } from 'telegraf';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { PublicKey, Transaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, createCloseAccountInstruction } from '@solana/spl-token';
import { config } from '../config';
import { Sniper } from '../core/sniper';
import { logger } from '../utils/logger';
import { rpc } from '../infra/rpc';

interface TradeClose {
  event: 'TRADE_CLOSE';
  mint: string;
  protocol: string;
  reason: string;
  urgent: boolean;
  entryPrice: number;
  exitPrice: number;
  peakPrice: number;
  peakPnlPercent: number;
  entryAmountSol: number;
  totalSolReceived: number;
  pnlSol: number;
  pnlPercent: number;
  durationMs: number;
  partialSells: number;
  configSnapshot: Record<string, number>;
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}ч ${m % 60}м`;
  if (m > 0) return `${m}м ${s % 60}с`;
  return `${s}с`;
}

function posEmoji(pnl: number): string {
  if (pnl >= 100) return '🚀';
  if (pnl >= 30)  return '🟢';
  if (pnl >= 0)   return '📈';
  if (pnl >= -5)  return '🟡';
  return '🔴';
}

function reasonEmoji(reason: string): string {
  const map: Record<string, string> = {
    stop_loss:     '🔴',
    velocity_drop: '⚡',
    trailing_stop: '📉',
    slow_drawdown: '🐌',
    hard_stop:     '🛑',
    tp_partial:    '🟡',
    stagnation:    '💤',
    time_stop:     '⏱',
    manual:        '🤚',
    break_even:    '🔄',
  };
  return map[reason] ?? '❓';
}

export class TelegramBot {
  private bot: Telegraf;
  private sniper: Sniper;
  private statusInterval: NodeJS.Timeout | null = null;
  private chatId: number | null = null;

  constructor(sniper: Sniper) {
    this.bot = new Telegraf(config.telegram.botToken);
    this.sniper = sniper;
    this.setupHandlers();
  }

  private isAuthorized(ctx: any): boolean {
    const allowedId = parseInt(process.env.ALLOWED_CHAT_ID ?? '0', 10);
    if (!allowedId) {
      logger.warn('ALLOWED_CHAT_ID не задан — доступ открыт всем!');
      return true;
    }
    if (ctx.chat.id !== allowedId) {
      logger.warn(`Неавторизованный доступ от chat_id=${ctx.chat.id}`);
      return false;
    }
    return true;
  }

  private setupHandlers() {
    this.bot.start((ctx) => {
      if (!this.isAuthorized(ctx)) {
        ctx.reply('⛔ Доступ запрещён');
        return;
      }
      this.chatId = ctx.chat.id;
      ctx.reply('Главное меню:', this.mainKeyboard());
    });

    this.bot.hears('🚀 Запустить', async (ctx) => {
      if (!this.isAuthorized(ctx)) {
        ctx.reply('⛔ Доступ запрещён');
        return;
      }
      try {
        this.chatId = ctx.chat.id;
        const result = await this.sniper.start();
        await ctx.reply(result);
        this.startStatusUpdates();
      } catch (e) {
        await ctx.reply('❌ Ошибка при запуске');
      }
    });

    this.bot.hears('🛑 Остановить', async (ctx) => {
      if (!this.isAuthorized(ctx)) {
        ctx.reply('⛔ Доступ запрещён');
        return;
      }
      try {
        const result = await this.sniper.stop();
        await ctx.reply(result);
        this.stopStatusUpdates();
      } catch (e) {
        await ctx.reply('❌ Ошибка при остановке');
      }
    });

    this.bot.hears('🧹 Dust Cleanup', async (ctx) => {
      if (!this.isAuthorized(ctx)) {
        ctx.reply('⛔ Доступ запрещён');
        return;
      }
      await ctx.reply('🔍 Сканирую кошелёк на dust-токены...');
      try {
        const result = await this.cleanupDustTokens();
        await ctx.reply(result, { parse_mode: 'HTML' });
      } catch (e) {
        logger.error('Dust cleanup error:', e);
        await ctx.reply('❌ Ошибка при очистке dust-токенов');
      }
    });

    // F7: Blacklist management via Telegram
    this.bot.hears(/^\/blacklist\s+(\S+)$/i, async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      const mint = ctx.match[1];
      this.sniper.addToBlacklist(mint);
      await ctx.reply(`🚫 Token blacklisted: ${mint.slice(0, 8)}...`);
    });

    this.bot.hears(/^\/unblacklist\s+(\S+)$/i, async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      const mint = ctx.match[1];
      const removed = this.sniper.removeFromBlacklist(mint);
      await ctx.reply(removed ? `✅ Removed from blacklist: ${mint.slice(0, 8)}...` : `Token not in blacklist`);
    });

    this.bot.hears(/^\/blacklist_creator\s+(\S+)$/i, async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      const creator = ctx.match[1];
      this.sniper.addCreatorToBlacklist(creator);
      await ctx.reply(`🚫 Creator blacklisted: ${creator.slice(0, 8)}...`);
    });

    this.bot.hears(/^\/blacklist_stats$/i, async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      const stats = this.sniper.getBlacklistStats();
      await ctx.reply(`Blacklist: ${stats.tokens} tokens, ${stats.creators} creators`);
    });
  }

  private mainKeyboard() {
    return Markup.keyboard([
      ['🚀 Запустить', '🛑 Остановить'],
      ['🧹 Dust Cleanup'],
    ]).resize();
  }

  private async buildStatusMessage(): Promise<string> {
    const s = await this.sniper.getStatus();

    const pnlSign = s.pnl >= 0 ? '+' : '';
    const winRate = s.totalTrades > 0
      ? `  WR ${((s.winTrades / s.totalTrades) * 100).toFixed(0)}%`
      : '';

    const lines: string[] = [
      `<b>🤖 ${s.running ? '✅ ЗАПУЩЕН' : '⛔ ОСТАНОВЛЕН'}</b>  ⏱ ${fmtUptime(s.uptimeMs)}`,
      ``,
      `💰 Баланс: <b>${s.balance.toFixed(4)} SOL</b>`,
      `${s.pnl >= 0 ? '📈' : '📉'} PnL сессии: <b>${pnlSign}${s.pnl.toFixed(4)} SOL</b>`,
      `🔢 Сделок: ${s.totalTrades}  (✅ ${s.winTrades} / ❌ ${s.totalTrades - s.winTrades})${winRate}`,
    ];

    const maxFun  = config.strategy.maxPumpFunPositions ?? 2;
    const funPos  = s.positions.filter((p: any) => p.protocol === 'pump.fun' || p.protocol === 'mayhem');

    lines.push(``);
    lines.push(`🔥 <b>Pump.fun</b>  [${funPos.length}/${maxFun}]`);
    for (const pos of funPos) {
      const pnlStr  = `${pos.pnlPercent >= 0 ? '+' : ''}${pos.pnlPercent.toFixed(1)}%`;
      const peakStr = pos.peakPnlPercent > 2 ? `  пик +${pos.peakPnlPercent.toFixed(0)}%` : '';
      const trail   = pos.trailingActivated ? '  🎯' : '';
      lines.push(
        `  ${posEmoji(pos.pnlPercent)} <code>${pos.mint.slice(0, 8)}...</code>  <b>${pnlStr}</b>${peakStr}${trail}  ${fmtUptime(pos.msOpen)}`
      );
    }
    for (let i = 0; i < maxFun - funPos.length; i++) lines.push(`  ⏳ Свободен`);

    const maxSwap = config.strategy.maxPumpSwapPositions ?? 1;
    const swapPos = s.positions.filter((p: any) => p.protocol === 'pumpswap');

    lines.push(``);
    lines.push(`💧 <b>PumpSwap</b>  [${swapPos.length}/${maxSwap}]`);
    for (const pos of swapPos) {
      const pnlStr  = `${pos.pnlPercent >= 0 ? '+' : ''}${pos.pnlPercent.toFixed(1)}%`;
      const peakStr = pos.peakPnlPercent > 2 ? `  пик +${pos.peakPnlPercent.toFixed(0)}%` : '';
      const trail   = pos.trailingActivated ? '  🎯' : '';
      lines.push(
        `  ${posEmoji(pos.pnlPercent)} <code>${pos.mint.slice(0, 8)}...</code>  <b>${pnlStr}</b>${peakStr}${trail}  ${fmtUptime(pos.msOpen)}`
      );
    }
    for (let i = 0; i < maxSwap - swapPos.length; i++) lines.push(`  ⏳ Свободен`);

    // Raydium positions (all 3 subtypes combined)
    const maxRay = (config.strategy.maxRaydiumLaunchPositions ?? 1)
                 + (config.strategy.maxRaydiumCpmmPositions ?? 1)
                 + (config.strategy.maxRaydiumAmmV4Positions ?? 1);
    const rayPos = s.positions.filter((p: any) =>
      p.protocol === 'raydium-launch' || p.protocol === 'raydium-cpmm' || p.protocol === 'raydium-ammv4'
    );

    if (maxRay > 0) {
      lines.push(``);
      lines.push(`🟣 <b>Raydium</b>  [${rayPos.length}/${maxRay}]`);
      for (const pos of rayPos) {
        const pnlStr  = `${pos.pnlPercent >= 0 ? '+' : ''}${pos.pnlPercent.toFixed(1)}%`;
        const peakStr = pos.peakPnlPercent > 2 ? `  пик +${pos.peakPnlPercent.toFixed(0)}%` : '';
        const trail   = pos.trailingActivated ? '  🎯' : '';
        const proto   = pos.protocol.replace('raydium-', '');
        lines.push(
          `  ${posEmoji(pos.pnlPercent)} <code>${pos.mint.slice(0, 8)}...</code>  <b>${pnlStr}</b>${peakStr}${trail}  ${proto}  ${fmtUptime(pos.msOpen)}`
        );
      }
      for (let i = 0; i < maxRay - rayPos.length; i++) lines.push(`  ⏳ Свободен`);
    }

    if (s.pendingCount > 0) {
      lines.push(``);
      lines.push(`⌛ Ожидают подтверждения: ${s.pendingCount}`);
    }

    return lines.join('\n');
  }

  private startStatusUpdates() {
    if (!this.chatId) return;
    this.stopStatusUpdates();

    this.statusInterval = setInterval(async () => {
      const status = await this.sniper.getStatus();
      if (!status.running) {
        this.stopStatusUpdates();
        return;
      }
      try {
        const msg = await this.buildStatusMessage();
        await this.bot.telegram.sendMessage(this.chatId!, msg, { parse_mode: 'HTML' });
      } catch (e) {
        logger.error('Ошибка отправки статуса:', e);
      }
    }, 10_000);
  }

  private stopStatusUpdates() {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
      this.chatId = null;
      logger.debug('Status updates stopped');
    }
  }

  /**
   * Сканирует кошелёк на dust-токены (баланс = 0 или < порога)
   * и закрывает пустые ATA, возвращая rent SOL.
   */
  private async cleanupDustTokens(): Promise<string> {
    const connection = rpc;
    const wallet = this.sniper.getPayerPublicKey();

    // Получаем все token accounts
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet, {
      programId: TOKEN_PROGRAM_ID,
    });

    // Фильтруем: dust = баланс 0, или < 1 токена (по uiAmount)
    const openPositionMints = new Set(this.sniper.getOpenPositionMints());
    const dustAccounts: { pubkey: PublicKey; mint: string; balance: number }[] = [];

    for (const { pubkey, account } of tokenAccounts.value) {
      const parsed = account.data.parsed?.info;
      if (!parsed) continue;
      const mint = parsed.mint as string;
      const uiAmount = Number(parsed.tokenAmount?.uiAmount ?? 0);

      // Не трогаем токены с открытыми позициями
      if (openPositionMints.has(mint)) continue;

      // Dust = баланс 0 или очень маленький (< 0.001 SOL value, т.е. мусор)
      if (uiAmount === 0) {
        dustAccounts.push({ pubkey, mint, balance: uiAmount });
      }
    }

    if (dustAccounts.length === 0) {
      return '✅ Dust-токенов не найдено. Кошелёк чист!';
    }

    // Закрываем пустые ATA пачками по 10 (лимит инструкций в транзакции)
    const BATCH_SIZE = 10;
    let closed = 0;
    let rentRecovered = 0;

    for (let i = 0; i < dustAccounts.length; i += BATCH_SIZE) {
      const batch = dustAccounts.slice(i, i + BATCH_SIZE);
      const tx = new Transaction();

      for (const acc of batch) {
        tx.add(createCloseAccountInstruction(
          acc.pubkey,
          wallet,  // destination (rent goes here)
          wallet,  // owner
        ));
      }

      try {
        const { blockhash } = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet;

        const signed = await this.sniper.signTransaction(tx);
        const txId = await connection.sendRawTransaction(signed.serialize(), {
          skipPreflight: true,
          maxRetries: 2,
        });

        logger.info(`🧹 Dust cleanup tx sent: ${txId} (${batch.length} accounts)`);
        closed += batch.length;
        rentRecovered += batch.length * 0.00203928; // ~rent per ATA
      } catch (err) {
        logger.error(`Dust cleanup batch failed:`, err);
      }
    }

    const lines = [
      `🧹 <b>Dust Cleanup завершён</b>`,
      ``,
      `Найдено пустых ATA: ${dustAccounts.length}`,
      `Закрыто: ${closed}`,
      `Возвращено rent: ~${rentRecovered.toFixed(4)} SOL`,
    ];

    if (dustAccounts.length > 0) {
      lines.push(``);
      lines.push(`Токены:`);
      for (const acc of dustAccounts.slice(0, 15)) {
        lines.push(`  <code>${acc.mint.slice(0, 12)}...</code>`);
      }
      if (dustAccounts.length > 15) {
        lines.push(`  ... и ещё ${dustAccounts.length - 15}`);
      }
    }

    return lines.join('\n');
  }

  launch() {
    this.bot.launch();
    logger.info('Telegram bot started');
  }

  stop() {
    this.stopStatusUpdates();
    this.bot.stop();
  }

  async sendAlert(message: string): Promise<void> {
    if (!this.chatId) return;
    try {
      await this.bot.telegram.sendMessage(this.chatId, message, { parse_mode: 'HTML' });
    } catch (e) {
      logger.error('Ошибка sendAlert:', e);
    }
  }
}