#!/usr/bin/env ts-node
/**
 * scripts/analyze-trades.ts
 *
 * CLI-анализ логов сделок. Читает logs/trades-*.jsonl и выводит
 * сводку + социальную корреляцию + pre-buy anticipation.
 *
 * Общие метрики (WR, PnL, reasons, protocols, hours, streaks) и
 * форматирование для CLI живут в `src/analysis/`. Этот скрипт —
 * тонкая обёртка + специализированные отчёты (mint detail, replay,
 * social correlation, anticipation), которые не нужны TG-боту.
 *
 * Использование:
 *   npx ts-node scripts/analyze-trades.ts
 *   npx ts-node scripts/analyze-trades.ts --date 2026-04-15
 *   npx ts-node scripts/analyze-trades.ts --full
 *   npx ts-node scripts/analyze-trades.ts --mint 7xKXtg...
 *   npx ts-node scripts/analyze-trades.ts --replay 7xKXtg...
 *   npx ts-node scripts/analyze-trades.ts --no-social
 *   npx ts-node scripts/analyze-trades.ts --no-hints
 */

import * as path from 'path';
import {
  loadTradeEvents,
  filterCloses,
  computeSessionStats,
  type LogEvent,
  type TradeClose,
} from '../src/analysis/session';
import { generateRecommendations } from '../src/analysis/recommendations';
import {
  formatStatsForCLI,
  formatRecommendationsForCLI,
} from '../src/analysis/format';

// ─── Helpers (оставлены локально — нужны только специализированным отчётам) ─

function dur(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function fmt(n: number, dec = 4): string {
  return n.toFixed(dec);
}

function pct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function coloured(text: string, n: number): string {
  if (process.stdout.isTTY) {
    const green = '\x1b[32m', red = '\x1b[31m', reset = '\x1b[0m';
    return `${n >= 0 ? green : red}${text}${reset}`;
  }
  return text;
}

// ─── Детали конкретного минта ────────────────────────────────────────────────

function printMintDetail(mint: string, events: LogEvent[]): void {
  const mintEvents = events.filter(e => e.mint === mint || e.mint.startsWith(mint));
  if (mintEvents.length === 0) {
    console.log(`Нет событий для минта ${mint}`);
    return;
  }

  console.log(`\n  ДЕТАЛИ: ${mint}`);
  console.log('─'.repeat(70));
  for (const e of mintEvents) {
    if (e.event === 'TRADE_OPEN') {
      console.log(`  [OPEN]    ${e.time}  entryPrice=${e.entryPrice.toExponential(4)}  amount=${e.amountSol} SOL`);
    } else if (e.event === 'PARTIAL_SELL') {
      console.log(`  [PARTIAL] ${e.time}  tp=${e.tpLevelPercent}%  sol=${fmt(e.solReceived)}  pnl=${pct(e.pnlPercent)}`);
    } else if (e.event === 'TRADE_CLOSE') {
      const t = e as TradeClose;
      console.log(`  [CLOSE]   ${e.time}  reason=${t.reason}  pnl=${coloured(pct(t.pnlPercent), t.pnlPercent)}  dur=${dur(t.durationMs)}`);
      console.log(`             entry=${t.entryPrice.toExponential(4)}  exit=${t.exitPrice.toExponential(4)}  peak=${t.peakPrice.toExponential(4)}`);
    }
  }
}

// ─── Воспроизведение истории цены ───────────────────────────────────────────

function printReplay(mint: string, closes: TradeClose[]): void {
  const trade = closes.find(t => t.mint === mint || t.mint.startsWith(mint));
  if (!trade) {
    console.log(`Нет закрытой сделки для ${mint}`);
    return;
  }

  const ticks = trade.priceHistory;
  console.log(`\n  ИСТОРИЯ ЦЕНЫ: ${trade.mint.slice(0, 16)}...`);
  console.log(`  Протокол: ${trade.protocol}  Причина: ${trade.reason}  Длительность: ${dur(trade.durationMs)}`);
  console.log(`  PnL: ${coloured(pct(trade.pnlPercent), trade.pnlPercent)}  Peak: ${pct(trade.peakPnlPercent)}`);
  console.log('─'.repeat(70));
  console.log('  t(s)   price              pnl%    ▓');
  console.log('─'.repeat(70));

  const maxPnl = Math.max(...ticks.map(t => Math.abs(t.pnl)));
  const step = Math.max(1, Math.floor(ticks.length / 40)); // ~40 строк

  for (let i = 0; i < ticks.length; i += step) {
    const tick = ticks[i];
    const sec = (tick.t / 1000).toFixed(1).padStart(6);
    const price = tick.p.toExponential(4).padEnd(18);
    const pnlStr = pct(tick.pnl).padStart(8);
    const barLen = maxPnl > 0 ? Math.round(Math.abs(tick.pnl) / maxPnl * 30) : 0;
    const bar = tick.pnl >= 0
      ? '\x1b[32m' + '█'.repeat(barLen) + '\x1b[0m'
      : '\x1b[31m' + '▓'.repeat(barLen) + '\x1b[0m';
    console.log(`  ${sec}s  ${price}  ${coloured(pnlStr, tick.pnl)}  ${bar}`);
  }
  console.log('─'.repeat(70));
  console.log(`  Тиков в истории: ${ticks.length}  (интервал ~500 мс)\n`);
}

// ─── Социальная корреляция (Phase 3 / D1) ──────────────────────────────────
//
// Для каждой закрытой сделки ищем social_signals в окне
// [openedAt - BEFORE_MS .. openedAt + AFTER_MS] по mint.
// Разбиваем сделки на две группы — "с шумом" и "без шума" — и сравниваем
// агрегаты. Плюс breakdown по источникам.
//
// Источник данных — SQLite (data/sniper.db). JSONL логи старше, чем БД,
// могут не иметь соответствующих сигналов — это нормально, скрипт просто
// покажет 0% coverage.

const SOCIAL_WINDOW_BEFORE_MS = 10 * 60 * 1000; // 10 min до входа (D1)
const SOCIAL_WINDOW_AFTER_MS  = 5  * 60 * 1000; // 5 min после входа (D1)
const PREBUY_LEAD_MS          = 30 * 60 * 1000; // 30 min до входа (D2)
const DB_LOAD_BEFORE_MS = Math.max(SOCIAL_WINDOW_BEFORE_MS, PREBUY_LEAD_MS);
const DB_LOAD_AFTER_MS  = SOCIAL_WINDOW_AFTER_MS;

// Ленивый импорт: если БД недоступна (нет data/sniper.db, нет better-sqlite3)
// — весь блок мягко пропускается.
type StoredSignalLite = {
  source: string;
  mint?: string;
  sentiment: number;
  timestamp: number;
};

function loadSignalsForTrades(closes: TradeClose[]): Map<string, StoredSignalLite[]> | null {
  if (closes.length === 0) return new Map();
  try {
    // Lazy require — чтобы script не падал, если SQLite/DB отсутствует.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getSignalsForMint } = require('../src/social/storage/signal-store');

    const out = new Map<string, StoredSignalLite[]>();
    const uniqueMints = new Set(closes.map(c => c.mint));

    for (const mint of uniqueMints) {
      const tradesForMint = closes.filter(c => c.mint === mint);
      const fromTs = Math.min(...tradesForMint.map(c => c.openedAt)) - DB_LOAD_BEFORE_MS;
      const toTs   = Math.max(...tradesForMint.map(c => c.openedAt)) + DB_LOAD_AFTER_MS;
      const rows = getSignalsForMint(mint, fromTs, toTs) as StoredSignalLite[];
      if (rows.length > 0) out.set(mint, rows);
    }
    return out;
  } catch (err) {
    console.log(`\n  ⚠  Социальная корреляция пропущена: ${(err as Error).message}`);
    return null;
  }
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function printSocialCorrelation(
  closes: TradeClose[],
  signalsByMint: Map<string, StoredSignalLite[]>,
): void {
  const SEP = '─'.repeat(70);
  console.log(`\n  📡 СОЦИАЛЬНАЯ КОРРЕЛЯЦИЯ  (окно: -${SOCIAL_WINDOW_BEFORE_MS/60000}m / +${SOCIAL_WINDOW_AFTER_MS/60000}m)`);
  console.log(SEP);

  if (closes.length === 0) {
    console.log('  Нет закрытых сделок.');
    return;
  }

  const withBuzz:    TradeClose[] = [];
  const withoutBuzz: TradeClose[] = [];
  const bySourceCount: Record<string, { trades: Set<number>; pnlSum: number }> = {};

  for (let i = 0; i < closes.length; i++) {
    const t = closes[i];
    const all = signalsByMint.get(t.mint) ?? [];
    const inWindow = all.filter(
      s => s.timestamp >= t.openedAt - SOCIAL_WINDOW_BEFORE_MS
        && s.timestamp <= t.openedAt + SOCIAL_WINDOW_AFTER_MS,
    );
    if (inWindow.length > 0) {
      withBuzz.push(t);
      const srcs = new Set(inWindow.map(s => s.source));
      for (const src of srcs) {
        if (!bySourceCount[src]) bySourceCount[src] = { trades: new Set(), pnlSum: 0 };
        if (!bySourceCount[src].trades.has(i)) {
          bySourceCount[src].trades.add(i);
          bySourceCount[src].pnlSum += t.pnlPercent;
        }
      }
    } else {
      withoutBuzz.push(t);
    }
  }

  const totalSignals = Array.from(signalsByMint.values()).reduce((s, arr) => s + arr.length, 0);
  if (totalSignals === 0) {
    console.log('  В БД нет сигналов по mint\'ам из этих сделок.');
    console.log('  Возможные причины: бот ещё не собирал сигналы, или сделки старее чем data/sniper.db.');
    return;
  }

  const cover = ((withBuzz.length / closes.length) * 100).toFixed(1);
  console.log(`  Сделок с социальным buzz : ${withBuzz.length} / ${closes.length}  (${cover}%)`);
  console.log(`  Всего сигналов в БД       : ${totalSignals} (для ${signalsByMint.size} уникальных mint'ов)`);

  const describe = (label: string, group: TradeClose[]): void => {
    if (group.length === 0) {
      console.log(`  ${label.padEnd(12)} : —  (нет сделок)`);
      return;
    }
    const pnls      = group.map(t => t.pnlPercent);
    const avgPnl    = pnls.reduce((s, x) => s + x, 0) / group.length;
    const medPnl    = median(pnls);
    const winRate   = (group.filter(t => t.pnlSol > 0).length / group.length) * 100;
    const avgDur    = group.reduce((s, t) => s + t.durationMs, 0) / group.length;
    console.log(
      `  ${label.padEnd(12)} : n=${String(group.length).padStart(3)}  ` +
      `avg=${coloured(pct(avgPnl), avgPnl).padEnd(18)}  ` +
      `med=${coloured(pct(medPnl), medPnl).padEnd(18)}  ` +
      `WR=${winRate.toFixed(0).padStart(3)}%  dur=${dur(avgDur)}`,
    );
  };

  describe('С buzz',    withBuzz);
  describe('Без buzz',  withoutBuzz);

  if (withBuzz.length > 0 && withoutBuzz.length > 0) {
    const deltaAvg = (withBuzz.reduce((s, t) => s + t.pnlPercent, 0) / withBuzz.length)
                   - (withoutBuzz.reduce((s, t) => s + t.pnlPercent, 0) / withoutBuzz.length);
    console.log(`  Δ avg PnL     : ${coloured(pct(deltaAvg), deltaAvg)}  (buzz − no-buzz)`);
  }

  const sourceEntries = Object.entries(bySourceCount).sort((a, b) => b[1].trades.size - a[1].trades.size);
  if (sourceEntries.length > 0) {
    console.log(`\n  По источникам (сделок с сигналом от данного источника):`);
    for (const [src, { trades, pnlSum }] of sourceEntries) {
      const n = trades.size;
      const avg = n > 0 ? pnlSum / n : 0;
      console.log(`    ${src.padEnd(12)} ${String(n).padStart(3)} сделок  avg PnL=${coloured(pct(avg), avg)}`);
    }
  }
}

// ─── Pre-buy anticipation (Phase 3 / D2) ───────────────────────────────────

const LEAD_BUCKETS: Array<{ label: string; maxMs: number }> = [
  { label: '<1m',    maxMs:      60_000 },
  { label: '1-5m',   maxMs:  5 * 60_000 },
  { label: '5-15m',  maxMs: 15 * 60_000 },
  { label: '15-30m', maxMs: 30 * 60_000 },
];

function bucketFor(leadMs: number): string {
  for (const b of LEAD_BUCKETS) if (leadMs <= b.maxMs) return b.label;
  return '>30m';
}

function printAnticipationReport(
  closes: TradeClose[],
  signalsByMint: Map<string, StoredSignalLite[]>,
): void {
  const SEP = '─'.repeat(70);
  console.log(`\n  📅 PRE-BUY ANTICIPATION  (окно: ${PREBUY_LEAD_MS / 60_000}m до openedAt)`);
  console.log(SEP);

  if (closes.length === 0) {
    console.log('  Нет закрытых сделок.');
    return;
  }

  const totalSignals = Array.from(signalsByMint.values()).reduce((s, arr) => s + arr.length, 0);
  if (totalSignals === 0) {
    console.log('  В БД нет сигналов по mint\'ам из этих сделок.');
    return;
  }

  type Anticipated = {
    trade: TradeClose;
    leadMs: number;
    signalCount: number;
    sources: Set<string>;
  };
  const anticipated: Anticipated[] = [];
  const cold: TradeClose[] = [];

  for (const t of closes) {
    const all = signalsByMint.get(t.mint) ?? [];
    const before = all.filter(
      s => s.timestamp >= t.openedAt - PREBUY_LEAD_MS && s.timestamp < t.openedAt,
    );
    if (before.length === 0) {
      cold.push(t);
      continue;
    }
    const first = before.reduce((min, s) => s.timestamp < min.timestamp ? s : min, before[0]);
    anticipated.push({
      trade: t,
      leadMs: t.openedAt - first.timestamp,
      signalCount: before.length,
      sources: new Set(before.map(s => s.source)),
    });
  }

  const cover = ((anticipated.length / closes.length) * 100).toFixed(1);
  console.log(`  Anticipated сделки : ${anticipated.length} / ${closes.length}  (${cover}%)`);
  console.log(`  Cold entry         : ${cold.length}`);

  if (anticipated.length > 0 && cold.length > 0) {
    const antAvg = anticipated.reduce((s, a) => s + a.trade.pnlPercent, 0) / anticipated.length;
    const coldAvg = cold.reduce((s, t) => s + t.pnlPercent, 0) / cold.length;
    console.log(
      `  Avg PnL anticipated: ${coloured(pct(antAvg), antAvg)}  ·  ` +
      `cold: ${coloured(pct(coldAvg), coldAvg)}  ·  ` +
      `Δ = ${coloured(pct(antAvg - coldAvg), antAvg - coldAvg)}`,
    );
  }

  if (anticipated.length > 0) {
    const buckets: Record<string, { count: number; pnlSum: number }> = {};
    for (const b of LEAD_BUCKETS) buckets[b.label] = { count: 0, pnlSum: 0 };
    buckets['>30m'] = { count: 0, pnlSum: 0 };

    for (const a of anticipated) {
      const key = bucketFor(a.leadMs);
      buckets[key].count++;
      buckets[key].pnlSum += a.trade.pnlPercent;
    }

    console.log(`\n  Распределение lead-time (signal → entry):`);
    const order = [...LEAD_BUCKETS.map(b => b.label), '>30m'];
    const maxCount = Math.max(...order.map(k => buckets[k].count), 1);
    for (const label of order) {
      const { count, pnlSum } = buckets[label];
      if (count === 0) continue;
      const avg = pnlSum / count;
      const bar = '█'.repeat(Math.round((count / maxCount) * 20));
      console.log(
        `    ${label.padEnd(6)} ${String(count).padStart(3)}  ${bar.padEnd(20)}  ` +
        `avg PnL=${coloured(pct(avg), avg)}`,
      );
    }
  }

  const byMint: Record<string, { trades: TradeClose[]; preSignalCount: number }> = {};
  for (const t of closes) {
    if (!byMint[t.mint]) byMint[t.mint] = { trades: [], preSignalCount: 0 };
    byMint[t.mint].trades.push(t);
    const ant = anticipated.find(a => a.trade === t);
    if (ant) byMint[t.mint].preSignalCount += ant.signalCount;
  }
  const topMints = Object.entries(byMint)
    .sort((a, b) => b[1].trades.length - a[1].trades.length)
    .slice(0, 5);

  if (topMints.length > 0 && topMints[0][1].trades.length > 1) {
    console.log(`\n  Топ-5 наиболее торгуемых mint'ов:`);
    for (const [mint, { trades, preSignalCount }] of topMints) {
      const avg = trades.reduce((s, t) => s + t.pnlPercent, 0) / trades.length;
      console.log(
        `    ${mint.slice(0, 10)}…  n=${String(trades.length).padStart(2)}  ` +
        `avg=${coloured(pct(avg), avg).padEnd(18)}  ` +
        `pre-signals=${preSignalCount}`,
      );
    }
  }

  if (anticipated.length > 0) {
    const bySrc: Record<string, { trades: number; pnlSum: number }> = {};
    for (const a of anticipated) {
      for (const src of a.sources) {
        if (!bySrc[src]) bySrc[src] = { trades: 0, pnlSum: 0 };
        bySrc[src].trades++;
        bySrc[src].pnlSum += a.trade.pnlPercent;
      }
    }
    const entries = Object.entries(bySrc).sort((a, b) => b[1].trades - a[1].trades);
    if (entries.length > 0) {
      console.log(`\n  Источники-"предсказатели" (≥1 сигнал ДО входа):`);
      for (const [src, { trades, pnlSum }] of entries) {
        const avg = pnlSum / trades;
        console.log(
          `    ${src.padEnd(12)} ${String(trades).padStart(3)} сделок  ` +
          `avg PnL=${coloured(pct(avg), avg)}`,
        );
      }
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const logDir = process.env.LOG_DIR ?? path.resolve('./logs');

  const dateFlag   = args[args.indexOf('--date')   + 1];
  const mintFlag   = args[args.indexOf('--mint')   + 1];
  const replayFlag = args[args.indexOf('--replay') + 1];
  const full       = args.includes('--full');
  const noSocial   = args.includes('--no-social');
  const noHints    = args.includes('--no-hints');

  // По умолчанию — сегодняшний день
  const today = new Date().toISOString().slice(0, 10);
  const dateFilter = full ? undefined : (dateFlag ?? today);

  const events = await loadTradeEvents(logDir, { dateFilter });
  const closes = filterCloses(events);

  // Специализированные режимы: --replay / --mint без агрегированной сводки.
  if (replayFlag) {
    printReplay(replayFlag, closes);
    return;
  }
  if (mintFlag) {
    printMintDetail(mintFlag, events);
    return;
  }

  const label = dateFilter ? `Период: ${dateFilter}` : 'Все периоды';
  console.log(`\n  ${label}  |  Логи: ${logDir}`);

  // Общая сводка — через shared модуль.
  const stats = computeSessionStats(closes);
  console.log(formatStatsForCLI(stats));

  // Соц-корреляция (SQLite) — только если --no-social не задан и есть сделки.
  if (!noSocial && closes.length > 0) {
    const signalsByMint = loadSignalsForTrades(closes);
    if (signalsByMint) {
      printSocialCorrelation(closes, signalsByMint);
      printAnticipationReport(closes, signalsByMint);
    }
  }

  // Рекомендации по стратегии (из shared модуля). --no-hints чтобы скрыть.
  if (!noHints) {
    const recs = generateRecommendations(stats, closes);
    console.log(formatRecommendationsForCLI(recs));
  }
}

main().catch(err => {
  console.error('Ошибка:', (err as Error).message);
  process.exit(1);
});
