// src/bot/bot.ts
//
// Telegram-бот: ТОЛЬКО для чтения и push-уведомлений.
//
// Управление ботом (start/stop/blacklist/dust-cleanup) перенесено в CLI —
// см. README.md и scripts/. Эта эволюция сделана сознательно, чтобы:
//   1. Telegram-аккаунт (и его компрометация) не давали возможности
//      управлять торговлей или менять конфигурацию.
//   2. Операции вроде blacklist / cleanup были в audit-friendly среде
//      (CLI с явным argv и логами).
//
// Что умеет TG:
//   • Кнопки on-demand (по запросу пользователя):
//       📊 Статус       — открытые позиции, PnL сессии, баланс
//       💰 Баланс       — SOL + краткая разбивка
//       📈 Анализ сессии — сводка по торгам (Этап 3)
//       ⚙️ Рекомендации  — советы по конфигу (Этап 3)
//   • Push-уведомления (автоматически):
//       💰 Купил <mint>             — событие 'position:open'
//       💸 Продал <mint> <PnL>      — событие 'position:close' (нормальный exit)
//       ❌ Ошибка <mint> <reason>   — событие 'position:close' (failed exit)

import * as path from 'path';
import { Telegraf, Markup } from 'telegraf';
import { config } from '../config';
import { Sniper } from '../core/sniper';
import { logger } from '../utils/logger';
import {
  loadTradeEvents,
  filterCloses,
  computeSessionStats,
} from '../analysis/session';
import { generateRecommendations } from '../analysis/recommendations';
import {
  formatStatsForTG,
  formatRecommendationsForTG,
} from '../analysis/format';

// ── Helpers ───────────────────────────────────────────────────────────────

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

/** CloseReason'ы, означающие техническую ошибку, а не штатный exit. */
const ERROR_REASONS = new Set([
  'bundle_failed',
  'bundle_invalid_repeated',
  'ata_empty',
  'rpc_error',
]);

function isErrorReason(reason: string | undefined): boolean {
  return !!reason && ERROR_REASONS.has(reason);
}

// ── TelegramBot ───────────────────────────────────────────────────────────

export class TelegramBot {
  private bot: Telegraf;
  private sniper: Sniper;
  /** chatId владельца (откуда пришёл /start или из ALLOWED_CHAT_ID). */
  private chatId: number | null = null;

  constructor(sniper: Sniper) {
    this.bot = new Telegraf(config.telegram.botToken);
    this.sniper = sniper;

    // Если ALLOWED_CHAT_ID задан в .env, сразу используем его как
    // получателя push'ей — не ждём первого /start.
    const envChatId = parseInt(process.env.ALLOWED_CHAT_ID ?? '0', 10);
    if (envChatId > 0) this.chatId = envChatId;

    this.setupHandlers();
    this.subscribeToSniperEvents();
  }

  // ── Auth ────────────────────────────────────────────────────────────────

  private isAuthorized(ctx: any): boolean {
    const allowedId = parseInt(process.env.ALLOWED_CHAT_ID ?? '0', 10);
    if (!allowedId) {
      logger.warn('ALLOWED_CHAT_ID не задан — доступ открыт всем!');
      return true;
    }
    if (ctx.chat?.id !== allowedId) {
      logger.warn(`Неавторизованный доступ от chat_id=${ctx.chat?.id}`);
      return false;
    }
    return true;
  }

  // ── Handlers ────────────────────────────────────────────────────────────

  private setupHandlers() {
    this.bot.start(async (ctx) => {
      if (!this.isAuthorized(ctx)) {
        await ctx.reply('⛔ Доступ запрещён');
        return;
      }
      this.chatId = ctx.chat.id;
      await ctx.reply(
        '👋 Главное меню (read-only).\n\n' +
        'Управление ботом — через CLI на сервере.\n' +
        'См. README.md → раздел «CLI».',
        this.mainKeyboard()
      );
    });

    this.bot.hears('📊 Статус', async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      this.chatId = ctx.chat.id;
      try {
        const msg = await this.buildStatusMessage();
        await ctx.reply(msg, { parse_mode: 'HTML' });
      } catch (e) {
        logger.error('Ошибка построения статуса:', e);
        await ctx.reply('❌ Не удалось получить статус');
      }
    });

    this.bot.hears('💰 Баланс', async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      this.chatId = ctx.chat.id;
      try {
        const msg = await this.buildBalanceMessage();
        await ctx.reply(msg, { parse_mode: 'HTML' });
      } catch (e) {
        logger.error('Ошибка построения баланса:', e);
        await ctx.reply('❌ Не удалось получить баланс');
      }
    });

    this.bot.hears('📈 Анализ сессии', async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      this.chatId = ctx.chat.id;
      try {
        const msg = await this.buildSessionAnalysisMessage();
        await ctx.reply(msg, { parse_mode: 'HTML' });
      } catch (e) {
        logger.error('Ошибка анализа сессии:', e);
        await ctx.reply('❌ Не удалось построить анализ сессии');
      }
    });

    this.bot.hears('⚙️ Рекомендации', async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      this.chatId = ctx.chat.id;
      try {
        const msg = await this.buildRecommendationsMessage();
        await ctx.reply(msg, { parse_mode: 'HTML' });
      } catch (e) {
        logger.error('Ошибка рекомендаций:', e);
        await ctx.reply('❌ Не удалось сформировать рекомендации');
      }
    });
  }

  private mainKeyboard() {
    return Markup.keyboard([
      ['📊 Статус', '💰 Баланс'],
      ['📈 Анализ сессии', '⚙️ Рекомендации'],
    ]).resize();
  }

  // ── Message builders ────────────────────────────────────────────────────

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

    const maxFun = config.strategy.maxPumpFunPositions ?? 2;
    const funPos = s.positions.filter((p: any) => p.protocol === 'pump.fun' || p.protocol === 'mayhem');

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

  /**
   * Для on-demand анализа в TG берём только сегодняшние логи (UTC):
   * этого достаточно чтобы понять «как идёт день», и укладывается в
   * Telegram 4096-char limit. Полный отчёт — через CLI `npm run analyze`.
   */
  private async buildSessionAnalysisMessage(): Promise<string> {
    const logDir = process.env.LOG_DIR ?? path.resolve('./logs');
    const today  = new Date().toISOString().slice(0, 10);
    const events = await loadTradeEvents(logDir, { dateFilter: today, quiet: true });
    const stats  = computeSessionStats(filterCloses(events));
    return formatStatsForTG(stats);
  }

  /**
   * Для рекомендаций берём все доступные логи (не только сегодня) —
   * эвристикам полезнее больше выборки. Остальной конфиг (MIN_SAMPLE и т.д.)
   * живёт в src/analysis/recommendations.ts.
   */
  private async buildRecommendationsMessage(): Promise<string> {
    const logDir = process.env.LOG_DIR ?? path.resolve('./logs');
    const events = await loadTradeEvents(logDir, { quiet: true });
    const closes = filterCloses(events);
    const stats  = computeSessionStats(closes);
    const recs   = generateRecommendations(stats, closes);
    return formatRecommendationsForTG(recs);
  }

  private async buildBalanceMessage(): Promise<string> {
    const s = await this.sniper.getStatus();
    const pubkey = this.sniper.getPayerPublicKey().toBase58();
    const pnlSign = s.pnl >= 0 ? '+' : '';

    return [
      `💰 <b>Баланс кошелька</b>`,
      ``,
      `SOL: <b>${s.balance.toFixed(4)}</b>`,
      `Сессия PnL: <b>${pnlSign}${s.pnl.toFixed(4)} SOL</b>`,
      `Открытых позиций: <b>${s.positions.length}</b>`,
      ``,
      `<code>${pubkey}</code>`,
    ].join('\n');
  }

  // ── Push notifications (Sniper events → TG) ─────────────────────────────

  private subscribeToSniperEvents() {
    this.sniper.on('position:open', (d: any) => {
      const mintShort = String(d.mint ?? '').slice(0, 8);
      const protocol  = d.protocol ?? '?';
      const amountSol = Number(d.entryAmountSol ?? 0).toFixed(3);
      const price     = Number(d.entryPrice ?? 0).toFixed(8);
      const msg = [
        `💰 <b>КУПИЛ</b>  [${protocol}]`,
        `<code>${mintShort}...</code>`,
        `Сумма: ${amountSol} SOL  ·  цена ${price}`,
      ].join('\n');
      this.pushAlert(msg).catch((e) => logger.error('TG push (open) failed:', e));
    });

    this.sniper.on('position:close', (d: any) => {
      const mintShort = String(d.mint ?? '').slice(0, 8);
      const reason    = String(d.reason ?? 'unknown');
      const pnlPct    = Number(d.pnlPercent ?? 0);
      const isError   = isErrorReason(reason);

      const header = isError ? `❌ <b>ОШИБКА</b>` : `💸 <b>ПРОДАЛ</b>`;
      const pnlStr = `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;
      const msg = [
        `${header}  ${posEmoji(pnlPct)}`,
        `<code>${mintShort}...</code>  <b>${pnlStr}</b>`,
        `Причина: <code>${reason}</code>`,
      ].join('\n');
      this.pushAlert(msg).catch((e) => logger.error('TG push (close) failed:', e));
    });
  }

  /**
   * Отправить сообщение владельцу. Если chatId ещё не известен
   * (нет ALLOWED_CHAT_ID и /start не сделан) — тихо игнорируем.
   */
  private async pushAlert(message: string): Promise<void> {
    if (!this.chatId) return;
    try {
      await this.bot.telegram.sendMessage(this.chatId, message, { parse_mode: 'HTML' });
    } catch (e) {
      logger.error('Ошибка pushAlert:', e);
    }
  }

  async sendNotification(message: string): Promise<void> {
    return this.pushAlert(message);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  launch() {
    this.bot.launch();
    logger.info('Telegram bot started (read-only mode)');
  }

  stop() {
    this.bot.stop();
  }
}
