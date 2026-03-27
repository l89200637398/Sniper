// src/bot/bot.ts
import { Telegraf, Markup } from 'telegraf';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { config } from '../config';
import { Sniper } from '../core/sniper';
import { logger } from '../utils/logger';

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

    // УДАЛЕНЫ обработчики '📊 Статус' и '📋 Анализ'
  }

  private mainKeyboard() {
    // УДАЛЕНЫ кнопки '📊 Статус' и '📋 Анализ'
    return Markup.keyboard([
      ['🚀 Запустить', '🛑 Остановить'],
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

  // Удалены методы buildAnalysisMessage, formatAnalysis и buildHints
  // (они больше не используются)

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