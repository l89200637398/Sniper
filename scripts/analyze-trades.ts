#!/usr/bin/env ts-node
/**
 * scripts/analyze-trades.ts
 *
 * CLI-анализ логов сделок.
 * Читает logs/trades-*.jsonl и выводит сводку по стратегии.
 *
 * Использование:
 *   npx ts-node scripts/analyze-trades.ts
 *   npx ts-node scripts/analyze-trades.ts --date 2024-01-15
 *   npx ts-node scripts/analyze-trades.ts --mint 7xKXtg...
 *   npx ts-node scripts/analyze-trades.ts --full          # все торговые дни
 *   npx ts-node scripts/analyze-trades.ts --replay 7xKXtg...  # история цены
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// ─── Типы (дублируют trade-logger.ts, не зависят от TS-конфига бота) ───────

interface PriceTick {
  t: number;
  p: number;
  pnl: number;
  solReserve?: number;
  tokenReserve?: number;
}

interface TradeClose {
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

interface TradeOpen {
  event: 'TRADE_OPEN';
  time: string;
  mint: string;
  protocol: string;
  entryPrice: number;
  amountSol: number;
  tokensReceived: number;
  txId: string;
}

interface PartialSell {
  event: 'PARTIAL_SELL';
  time: string;
  mint: string;
  protocol: string;
  tpLevelPercent: number;
  solReceived: number;
  pnlPercent: number;
}

type LogEvent = TradeClose | TradeOpen | PartialSell;

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── Чтение всех JSONL-файлов из logs/ ─────────────────────────────────────

async function readLogFiles(logDir: string, dateFilter?: string): Promise<LogEvent[]> {
  const files = fs.readdirSync(logDir)
    .filter(f => f.startsWith('trades') && f.endsWith('.jsonl'))
    .filter(f => !dateFilter || f.includes(dateFilter))
    .map(f => path.join(logDir, f))
    .sort();

  if (files.length === 0) {
    console.error(`Нет файлов trades*.jsonl в ${logDir}`);
    process.exit(1);
  }

  const events: LogEvent[] = [];

  for (const file of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(file) });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as LogEvent);
      } catch {
        // пропускаем битые строки
      }
    }
  }

  return events;
}

// ─── Сводка по всем сделкам ─────────────────────────────────────────────────

function printSummary(closes: TradeClose[]) {
  if (closes.length === 0) {
    console.log('Нет закрытых сделок в выбранном периоде.');
    return;
  }

  const wins   = closes.filter(t => t.pnlSol > 0);
  const losses = closes.filter(t => t.pnlSol <= 0);

  const totalPnlSol  = closes.reduce((s, t) => s + t.pnlSol, 0);
  const totalIn      = closes.reduce((s, t) => s + t.entryAmountSol, 0);
  const avgPnlPct    = closes.reduce((s, t) => s + t.pnlPercent, 0) / closes.length;
  const avgDuration  = closes.reduce((s, t) => s + t.durationMs, 0) / closes.length;
  const avgWin       = wins.length   ? wins.reduce((s, t) => s + t.pnlPercent, 0) / wins.length : 0;
  const avgLoss      = losses.length ? losses.reduce((s, t) => s + t.pnlPercent, 0) / losses.length : 0;
  const bestTrade    = closes.reduce((best, t) => t.pnlPercent > best.pnlPercent ? t : best, closes[0]);
  const worstTrade   = closes.reduce((worst, t) => t.pnlPercent < worst.pnlPercent ? t : worst, closes[0]);
  const avgPeak      = closes.reduce((s, t) => s + t.peakPnlPercent, 0) / closes.length;

  // Разбивка по причинам закрытия
  const byReason: Record<string, { count: number; pnl: number }> = {};
  for (const t of closes) {
    if (!byReason[t.reason]) byReason[t.reason] = { count: 0, pnl: 0 };
    byReason[t.reason].count++;
    byReason[t.reason].pnl += t.pnlSol;
  }

  // Разбивка по протоколу
  const byProtocol: Record<string, { count: number; pnl: number; wins: number }> = {};
  for (const t of closes) {
    if (!byProtocol[t.protocol]) byProtocol[t.protocol] = { count: 0, pnl: 0, wins: 0 };
    byProtocol[t.protocol].count++;
    byProtocol[t.protocol].pnl += t.pnlSol;
    if (t.pnlSol > 0) byProtocol[t.protocol].wins++;
  }

  const SEP = '─'.repeat(70);

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  SOLANA SNIPER BOT — АНАЛИЗ СДЕЛОК (${closes.length} закрытых)`);
  console.log(`${'═'.repeat(70)}`);

  console.log(`\n  📊 ОБЩАЯ СТАТИСТИКА`);
  console.log(SEP);
  console.log(`  Сделок всего : ${closes.length}  (✅ ${wins.length} прибыльных / ❌ ${losses.length} убыточных)`);
  console.log(`  Win rate     : ${((wins.length / closes.length) * 100).toFixed(1)}%`);
  console.log(`  Итого PnL    : ${coloured(fmt(totalPnlSol, 4) + ' SOL', totalPnlSol)}  (${pct(avgPnlPct)} avg)`);
  console.log(`  Вложено SOL  : ${fmt(totalIn, 4)} SOL`);
  console.log(`  ROI          : ${coloured(pct((totalPnlSol / totalIn) * 100), totalPnlSol)}`);
  console.log(`  Avg выигрыш  : ${coloured(pct(avgWin), 1)}`);
  console.log(`  Avg проигрыш : ${coloured(pct(avgLoss), -1)}`);
  console.log(`  Avg пиковый  : ${pct(avgPeak)}`);
  console.log(`  Avg длит-ть  : ${dur(avgDuration)}`);

  console.log(`\n  📈 ЛУЧШИЕ / ХУДШИЕ`);
  console.log(SEP);
  console.log(`  Лучшая  : ${bestTrade.mint.slice(0, 8)}...  ${coloured(pct(bestTrade.pnlPercent), 1)}  ${dur(bestTrade.durationMs)}  [${bestTrade.reason}]`);
  console.log(`  Худшая  : ${worstTrade.mint.slice(0, 8)}...  ${coloured(pct(worstTrade.pnlPercent), -1)}  ${dur(worstTrade.durationMs)}  [${worstTrade.reason}]`);

  console.log(`\n  🔍 ПРИЧИНЫ ЗАКРЫТИЯ`);
  console.log(SEP);
  const reasonSorted = Object.entries(byReason).sort((a, b) => b[1].count - a[1].count);
  for (const [reason, { count, pnl }] of reasonSorted) {
    const bar = '█'.repeat(Math.min(Math.round(count / closes.length * 30), 30));
    console.log(`  ${reason.padEnd(18)} ${String(count).padStart(3)} ${bar.padEnd(30)} ${coloured(fmt(pnl, 4) + ' SOL', pnl)}`);
  }

  console.log(`\n  🌐 ПО ПРОТОКОЛУ`);
  console.log(SEP);
  for (const [proto, { count, pnl, wins: w }] of Object.entries(byProtocol)) {
    const wr = ((w / count) * 100).toFixed(0);
    console.log(`  ${proto.padEnd(12)} ${count} сделок  WR=${wr}%  PnL=${coloured(fmt(pnl, 4) + ' SOL', pnl)}`);
  }

  console.log(`\n  ⚡ URGENT ПРОДАЖИ`);
  console.log(SEP);
  const urgents = closes.filter(t => t.urgent);
  console.log(`  Всего urgent: ${urgents.length}  (${((urgents.length / closes.length) * 100).toFixed(0)}% от всех)`);
  if (urgents.length > 0) {
    const urgentPnl = urgents.reduce((s, t) => s + t.pnlSol, 0);
    console.log(`  Их суммарный PnL: ${coloured(fmt(urgentPnl, 4) + ' SOL', urgentPnl)}`);
  }

  console.log(`\n${'═'.repeat(70)}\n`);
}

// ─── Детали конкретного минта ────────────────────────────────────────────────

function printMintDetail(mint: string, events: LogEvent[]) {
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

function printReplay(mint: string, closes: TradeClose[]) {
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

// ─── Совет по настройке стратегии ───────────────────────────────────────────

function printStrategyHints(closes: TradeClose[]) {
  if (closes.length < 5) return;

  const hints: string[] = [];

  // Много stop_loss в начале → entryStopLossPercent слишком тесный
  const stopLosses = closes.filter(t => t.reason === 'stop_loss');
  const avgStopDur = stopLosses.length
    ? stopLosses.reduce((s, t) => s + t.durationMs, 0) / stopLosses.length
    : 0;
  if (stopLosses.length > closes.length * 0.4 && avgStopDur < 10_000) {
    hints.push('🔧 Много быстрых stop_loss (<10 с) — возможно entryStopLossPercent слишком тесный');
  }

  // Много velocity_drop → возможно окно слишком широкое
  const velocities = closes.filter(t => t.reason === 'velocity_drop');
  if (velocities.length > closes.length * 0.3) {
    const avgVelPnl = velocities.reduce((s, t) => s + t.pnlPercent, 0) / velocities.length;
    if (avgVelPnl > -5) {
      hints.push('🔧 velocity_drop часто срабатывает при небольших потерях — возможно velocityDropPercent слишком маленький');
    }
  }

  // Высокий avgPeak при плохом avgPnl → trailing слишком рано
  const avgPeak = closes.reduce((s, t) => s + t.peakPnlPercent, 0) / closes.length;
  const avgPnl  = closes.reduce((s, t) => s + t.pnlPercent, 0) / closes.length;
  if (avgPeak > 60 && avgPnl < 20) {
    hints.push(`🔧 Avg peak ${pct(avgPeak)} но avg итог ${pct(avgPnl)} — trailing stop слишком рано закрывает прибыльные позиции`);
  }

  // Много TP partial без close-win
  const withPartials = closes.filter(t => t.partialSells > 0);
  const withPartialsLoss = withPartials.filter(t => t.pnlSol < 0);
  if (withPartials.length > 3 && withPartialsLoss.length > withPartials.length * 0.5) {
    hints.push('🔧 Многие сделки с частичной фиксацией всё равно закрываются в минус — TP-уровни берут слишком мало');
  }

  if (hints.length > 0) {
    console.log(`\n  💡 РЕКОМЕНДАЦИИ ПО СТРАТЕГИИ`);
    console.log('─'.repeat(70));
    for (const h of hints) console.log(`  ${h}`);
    console.log('');
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const logDir = process.env.LOG_DIR ?? path.resolve('./logs');

  const dateFlag   = args[args.indexOf('--date')   + 1];
  const mintFlag   = args[args.indexOf('--mint')   + 1];
  const replayFlag = args[args.indexOf('--replay') + 1];
  const full       = args.includes('--full');

  // По умолчанию — сегодняшний день
  const today = new Date().toISOString().slice(0, 10);
  const dateFilter = full ? undefined : (dateFlag ?? today);

  const events = await readLogFiles(logDir, dateFilter);
  const closes = events.filter((e): e is TradeClose => e.event === 'TRADE_CLOSE');

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
  printSummary(closes);
  printStrategyHints(closes);
}

main().catch(err => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});
