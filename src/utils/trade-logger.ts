/**
 * src/utils/trade-logger.ts
 *
 * Структурированный логгер торговых событий.
 *
 * Пишет JSONL в logs/trades-YYYY-MM-DD.log — одна JSON-строка на событие.
 * Каждое событие содержит полный контекст сделки для последующего анализа.
 *
 * Типы событий:
 *   TRADE_OPEN      — открытие позиции
 *   PARTIAL_SELL    — частичная фиксация прибыли (TP-уровень)
 *   TRADE_CLOSE     — закрытие позиции (+ история цены)
 *
 * Использование:
 *   import { tradeLog } from '../utils/trade-logger';
 *   tradeLog.open({ mint, protocol, entryPrice, ... });
 *   tradeLog.close({ mint, reason, priceHistory, ... });
 *
 * Анализ:
 *   npx ts-node scripts/analyze-trades.ts [--date 2024-01-01]
 */

import pino from 'pino';
import { mkdirSync } from 'fs';
import { resolve } from 'path';

const LOG_DIR = resolve(process.env.LOG_DIR ?? './logs');
try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ok */ }

// ─── Типы ──────────────────────────────────────────────────────────────────

export interface PriceTick {
  t: number;
  p: number;
  pnl: number;
  solReserve?: number;
  tokenReserve?: number;
}

export interface TradeOpenPayload {
  mint: string;
  protocol: 'pump.fun' | 'pumpswap' | 'mayhem' | 'raydium-launch' | 'raydium-cpmm' | 'raydium-ammv4';
  entryPrice: number;
  amountSol: number;
  tokensReceived: number;
  slippageBps: number;
  jitoTipSol: number;
  txId: string;
  openedAt: number;
  isCopyTrade?: boolean;
  tokenScore?: number;
}

export interface PartialSellPayload {
  mint: string;
  protocol: 'pump.fun' | 'pumpswap' | 'mayhem' | 'raydium-launch' | 'raydium-cpmm' | 'raydium-ammv4';
  tpLevelPercent: number;
  tpIndex: number;
  portion: number;
  tokensSold: number;
  solReceived: number;
  priceAtSell: number;
  pnlPercent: number;
  accumulatedSolSoFar: number;
  txId: string;
  msFromOpen: number;
}

/** Тип причины закрытия позиции */
export type CloseReason =
  | 'stop_loss'
  | 'velocity_drop'
  | 'trailing_stop'
  | 'slow_drawdown'
  | 'hard_stop'
  | 'manual'
  | 'tp_all'
  | 'tp_partial'
  | 'stagnation'
  | 'time_stop'
  | 'break_even'
  | 'rpc_error'
  | 'creator_sell'
  | 'bundle_failed'     // покупка не подтверждена (Jito bundle Failed/Dropped)
  | 'bundle_invalid_repeated' // 2+ Invalid bundles подряд — optimistic position удалена
  | 'empty_curve'       // sell вернул <0.001 SOL (curve дренирована)
  | 'ata_empty'         // ATA пуст после N failed sells (токены потеряны)
  | 'stale_close'      // позиция закрыта при загрузке (too old)
  | 'early_exit'
  | 'dead_volume'
  | 'whale_sell'
  | 'reserve_imbalance'
  | 'unknown';

export interface TradeClosePayload {
  mint: string;
  protocol: 'pump.fun' | 'pumpswap' | 'mayhem' | 'raydium-launch' | 'raydium-cpmm' | 'raydium-ammv4';
  reason: CloseReason;
  urgent: boolean;

  entryPrice: number;
  exitPrice: number;
  peakPrice: number;
  peakPnlPercent: number;

  entryAmountSol: number;
  finalSolReceived: number;
  partialSolReceived: number;
  totalSolReceived: number;
  pnlSol: number;
  pnlPercent: number;

  /** Estimated overhead not captured in pnlSol (ATA rent + tips + buy fees) */
  overheadSol?: number;
  /** PnL adjusted for estimated overhead */
  netPnlSol?: number;
  netPnlPercent?: number;
  /** Whether this was a copy-trade entry */
  isCopyTrade?: boolean;
  /** Token quality score at close time */
  tokenScore?: number;

  openedAt: number;
  closedAt: number;
  durationMs: number;
  durationSec: number;

  txId: string;
  sellPath?: 'jito' | 'direct' | 'direct+bx' | 'jupiter' | 'rescue';
  partialSells: number;
  priceHistory: PriceTick[];

  configSnapshot: {
    entryStopLossPercent: number;
    trailingActivationPercent: number;
    trailingDrawdownPercent: number;
    slowDrawdownPercent: number;
    hardStopPercent: number;
    velocityDropPercent: number;
    velocityWindowMs: number;
    stagnationWindowMs: number;
    stagnationMinMove: number;
    timeStopAfterMs: number;
    timeStopMinPnl: number;
    breakEvenAfterTrailingPercent: number;
  };
}

// ─── Инициализация логгера ─────────────────────────────────────────────────

const _tradesLogger = pino(
  {
    level: 'debug',
    timestamp: pino.stdTimeFunctions.isoTime,
    base: undefined,
  },
  pino.transport({
    target: require.resolve('pino-roll'),
    options: {
      file: `${LOG_DIR}/trades`,
      extension: '.jsonl',
      frequency: 'daily',
      size: '100m',
      mkdir: true,
      dateFormat: 'yyyy-MM-dd',
    },
  })
);

export const tradeLog = {
  open(payload: TradeOpenPayload): void {
    _tradesLogger.info({ event: 'TRADE_OPEN', ...payload });
  },

  partial(payload: PartialSellPayload): void {
    _tradesLogger.info({ event: 'PARTIAL_SELL', ...payload });
  },

  close(payload: TradeClosePayload): void {
    _tradesLogger.info({ event: 'TRADE_CLOSE', ...payload });
  },
};

export function calcPnlPercent(currentPrice: number, entryPrice: number): number {
  if (entryPrice === 0) return 0;
  return ((currentPrice - entryPrice) / entryPrice) * 100;
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}