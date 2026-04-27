// src/analysis/session.ts
//
// Модуль анализа торговой сессии. Чистая логика без форматирования:
//   * loadTradeEvents(dir, dateFilter?) — читает JSONL логи
//   * computeSessionStats(closes)      — агрегирует метрики
//
// Используется:
//   * scripts/analyze-trades.ts  (CLI-анализ полного дня)
//   * scripts/recommend-config.ts (рекомендации для cron)
//   * src/bot/bot.ts              (кнопки "📈 Анализ сессии" и "⚙️ Рекомендации")
//
// Типы событий читаются из JSONL и дублируют структуры trade-logger.ts —
// мы не импортируем оттуда, чтобы этот модуль оставался пассивным читателем
// файлов и не тащил pino/transport dependencies.

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// ── Типы событий (зеркало trade-logger.ts) ───────────────────────────────

export interface PriceTick {
  t: number;
  p: number;
  pnl: number;
  solReserve?: number;
  tokenReserve?: number;
}

export interface TradeOpen {
  event: 'TRADE_OPEN';
  time: string;
  mint: string;
  protocol: string;
  entryPrice: number;
  amountSol: number;
  tokensReceived: number;
  txId: string;
  openedAt?: number;
}

export interface PartialSell {
  event: 'PARTIAL_SELL';
  time: string;
  mint: string;
  protocol: string;
  tpLevelPercent: number;
  solReceived: number;
  pnlPercent: number;
  msFromOpen?: number;
}

export interface TradeClose {
  event: 'TRADE_CLOSE';
  time: string;
  mint: string;
  protocol: string;
  reason: string;
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
  openedAt: number;
  closedAt: number;
  durationMs: number;
  durationSec: number;
  txId: string;
  partialSells: number;
  priceHistory: PriceTick[];
  configSnapshot: Record<string, number>;
}

export type LogEvent = TradeClose | TradeOpen | PartialSell;

// ── Чтение JSONL ──────────────────────────────────────────────────────────

export interface LoadOptions {
  /** "YYYY-MM-DD" → фильтр по имени файла. undefined = все файлы. */
  dateFilter?: string;
  /** Не кидать, если папка пуста/нет файлов — вернуть пустой массив. */
  quiet?: boolean;
}

/**
 * Читает logs/trades-*.jsonl, возвращает все события. Битые строки
 * пропускает молча (логгер pino-roll иногда обрезает хвост).
 */
export async function loadTradeEvents(
  logDir: string,
  opts: LoadOptions = {},
): Promise<LogEvent[]> {
  if (!fs.existsSync(logDir)) {
    if (opts.quiet) return [];
    throw new Error(`Log directory not found: ${logDir}`);
  }

  const files = fs.readdirSync(logDir)
    .filter(f => f.startsWith('trades') && f.endsWith('.jsonl'))
    .filter(f => !opts.dateFilter || f.includes(opts.dateFilter))
    .map(f => path.join(logDir, f))
    .sort();

  if (files.length === 0 && !opts.quiet) {
    throw new Error(`No trades*.jsonl files in ${logDir}`);
  }

  const events: LogEvent[] = [];
  for (const file of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(file) });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as LogEvent);
      } catch {
        /* битая строка — пропускаем */
      }
    }
  }
  return events;
}

/** Только TRADE_CLOSE события — то, что нужно для статистики. */
export function filterCloses(events: LogEvent[]): TradeClose[] {
  return events.filter((e): e is TradeClose => e.event === 'TRADE_CLOSE');
}

// ── Агрегирование метрик ──────────────────────────────────────────────────

export interface ReasonBreakdown {
  reason: string;
  count: number;
  pnlSol: number;
  /** Доля от общего числа закрытий, 0..1. */
  share: number;
}

export interface ProtocolBreakdown {
  protocol: string;
  count: number;
  wins: number;
  pnlSol: number;
  winRate: number; // 0..1
}

export interface HourBreakdown {
  /** 0..23 (UTC). */
  hour: number;
  count: number;
  pnlSol: number;
  winRate: number;
}

export interface SessionStats {
  /** Число закрытых сделок, включённых в выборку. */
  total: number;
  /** Пустая ли выборка (все остальные поля тогда дефолтные). */
  empty: boolean;

  wins: number;
  losses: number;
  winRate: number; // 0..1

  totalPnlSol: number;
  totalInSol: number;
  roi: number;        // totalPnl / totalIn, 0..1 (может быть отрицательным)
  avgPnlPercent: number;
  avgWinPercent: number;  // средний процент по прибыльным
  avgLossPercent: number; // средний процент по убыточным
  avgPeakPercent: number; // средний пиковый % за сделку
  avgDurationMs: number;

  /** Лучшая и худшая сделки (по pnlPercent). undefined если empty. */
  best?: TradeClose;
  worst?: TradeClose;

  /** Разбивка по причинам закрытия, отсортировано по count desc. */
  byReason: ReasonBreakdown[];

  /** Разбивка по протоколам. */
  byProtocol: ProtocolBreakdown[];

  /** Разбивка по часу входа (UTC), только для часов где есть сделки. */
  byHour: HourBreakdown[];

  /** Urgent-продажи. */
  urgentCount: number;
  urgentPnlSol: number;

  /** Максимальная серия убытков подряд (по времени закрытия). */
  maxLossStreak: number;
  /** Максимальная серия прибылей подряд. */
  maxWinStreak: number;
  /** Текущая серия (знак: + прибылей, − убытков). */
  currentStreak: number;

  /** Разница: средний пик vs средний итог (во сколько раз «отдали» прибыли). */
  peakToCloseRatio: number; // avgPeakPct - avgPnlPct, в процентах
}

const EMPTY_STATS: SessionStats = {
  total: 0,
  empty: true,
  wins: 0,
  losses: 0,
  winRate: 0,
  totalPnlSol: 0,
  totalInSol: 0,
  roi: 0,
  avgPnlPercent: 0,
  avgWinPercent: 0,
  avgLossPercent: 0,
  avgPeakPercent: 0,
  avgDurationMs: 0,
  byReason: [],
  byProtocol: [],
  byHour: [],
  urgentCount: 0,
  urgentPnlSol: 0,
  maxLossStreak: 0,
  maxWinStreak: 0,
  currentStreak: 0,
  peakToCloseRatio: 0,
};

export function computeSessionStats(closes: TradeClose[]): SessionStats {
  if (closes.length === 0) return EMPTY_STATS;

  const wins   = closes.filter(t => t.pnlSol > 0);
  const losses = closes.filter(t => t.pnlSol <= 0);
  const total  = closes.length;

  const totalPnlSol = closes.reduce((s, t) => s + t.pnlSol, 0);
  const totalInSol  = closes.reduce((s, t) => s + t.entryAmountSol, 0);
  const avgPnlPercent   = closes.reduce((s, t) => s + t.pnlPercent, 0) / total;
  const avgDurationMs   = closes.reduce((s, t) => s + t.durationMs, 0) / total;
  const avgWinPercent   = wins.length   ? wins.reduce((s, t) => s + t.pnlPercent, 0) / wins.length : 0;
  const avgLossPercent  = losses.length ? losses.reduce((s, t) => s + t.pnlPercent, 0) / losses.length : 0;
  const avgPeakPercent  = closes.reduce((s, t) => s + t.peakPnlPercent, 0) / total;

  const best  = closes.reduce((b, t) => t.pnlPercent > b.pnlPercent ? t : b, closes[0]);
  const worst = closes.reduce((w, t) => t.pnlPercent < w.pnlPercent ? t : w, closes[0]);

  // By reason
  const reasonMap = new Map<string, { count: number; pnl: number }>();
  for (const t of closes) {
    const cur = reasonMap.get(t.reason) ?? { count: 0, pnl: 0 };
    cur.count++;
    cur.pnl += t.pnlSol;
    reasonMap.set(t.reason, cur);
  }
  const byReason: ReasonBreakdown[] = [...reasonMap.entries()]
    .map(([reason, { count, pnl }]) => ({ reason, count, pnlSol: pnl, share: count / total }))
    .sort((a, b) => b.count - a.count);

  // By protocol
  const protoMap = new Map<string, { count: number; pnl: number; wins: number }>();
  for (const t of closes) {
    const cur = protoMap.get(t.protocol) ?? { count: 0, pnl: 0, wins: 0 };
    cur.count++;
    cur.pnl += t.pnlSol;
    if (t.pnlSol > 0) cur.wins++;
    protoMap.set(t.protocol, cur);
  }
  const byProtocol: ProtocolBreakdown[] = [...protoMap.entries()]
    .map(([protocol, { count, pnl, wins: w }]) => ({
      protocol, count, wins: w, pnlSol: pnl, winRate: w / count,
    }))
    .sort((a, b) => b.count - a.count);

  // By hour (UTC). Обход только часов, где что-то есть.
  const hourMap = new Map<number, { count: number; pnl: number; wins: number }>();
  for (const t of closes) {
    const h = new Date(t.openedAt).getUTCHours();
    const cur = hourMap.get(h) ?? { count: 0, pnl: 0, wins: 0 };
    cur.count++;
    cur.pnl += t.pnlSol;
    if (t.pnlSol > 0) cur.wins++;
    hourMap.set(h, cur);
  }
  const byHour: HourBreakdown[] = [...hourMap.entries()]
    .map(([hour, { count, pnl, wins: w }]) => ({
      hour, count, pnlSol: pnl, winRate: w / count,
    }))
    .sort((a, b) => a.hour - b.hour);

  // Urgent
  const urgents = closes.filter(t => t.urgent);
  const urgentCount  = urgents.length;
  const urgentPnlSol = urgents.reduce((s, t) => s + t.pnlSol, 0);

  // Streaks — пересчитываем по порядку закрытия (closedAt)
  const chron = [...closes].sort((a, b) => a.closedAt - b.closedAt);
  let maxWin = 0, maxLoss = 0, curW = 0, curL = 0;
  for (const t of chron) {
    if (t.pnlSol > 0) {
      curW++;
      curL = 0;
      if (curW > maxWin) maxWin = curW;
    } else {
      curL++;
      curW = 0;
      if (curL > maxLoss) maxLoss = curL;
    }
  }
  const last = chron[chron.length - 1];
  const currentStreak = last.pnlSol > 0 ? curW : -curL;

  return {
    total,
    empty: false,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length / total,
    totalPnlSol,
    totalInSol,
    roi: totalInSol > 0 ? totalPnlSol / totalInSol : 0,
    avgPnlPercent,
    avgWinPercent,
    avgLossPercent,
    avgPeakPercent,
    avgDurationMs,
    best,
    worst,
    byReason,
    byProtocol,
    byHour,
    urgentCount,
    urgentPnlSol,
    maxWinStreak: maxWin,
    maxLossStreak: maxLoss,
    currentStreak,
    peakToCloseRatio: avgPeakPercent - avgPnlPercent,
  };
}
