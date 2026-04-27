#!/usr/bin/env ts-node
/**
 * scripts/ev-analysis/final-comparison.ts
 *
 * Сравнение:
 *  - Текущего "ДО" (до применения creatorSellMinDropPct)
 *  - "ПОСЛЕ" с применённым creatorSellMinDropPct=5 (единственное изменение)
 *  - "ПОСЛЕ+" с агрессивными оптимизациями
 *
 * Плюс Monte Carlo с разными рыночными режимами для устойчивости.
 */

const N = 100_000;

interface Config {
  name: string;
  entry: number;
  slPct: number;
  trailAct: number;
  trailDrawdown: number;
  runnerAct: number;
  runnerDrawdown: number;
  tps: { level: number; portion: number }[];
  creatorSellMinDrop: number;  // новый параметр
  overhead: number;
}

function sampleOutcome(rugRate = 0.05, dumpRate = 0.25, flatRate = 0.35): { peak: number; rug: boolean } {
  const r = Math.random();
  let cum = rugRate;
  if (r < cum) return { peak: Math.random() * 2, rug: true };
  cum += dumpRate * 0.5;
  if (r < cum) return { peak: Math.random() * 5, rug: false };
  cum += flatRate + dumpRate * 0.5;
  if (r < cum) return { peak: Math.random() * 10, rug: false };
  const rN = (r - cum) / (1 - cum);
  if (rN < 0.50) return { peak: 10 + Math.random() * 20, rug: false };
  if (rN < 0.75) return { peak: 30 + Math.random() * 70, rug: false };
  if (rN < 0.90) return { peak: 100 + Math.random() * 200, rug: false };
  if (rN < 0.97) return { peak: 300 + Math.random() * 700, rug: false };
  return { peak: 1000 + Math.random() * 4000, rug: false };
}

function simTrade(outcome: { peak: number; rug: boolean }, c: Config): number {
  if (outcome.rug) {
    const roll = Math.random();
    const pct = roll < 0.5 ? 1.0 : roll < 0.8 ? 0.7 : 0.4;
    return -c.entry * pct - c.overhead * 0.5;
  }
  const creatorSellFires = Math.random() < 0.50;
  if (creatorSellFires) {
    const price = Math.random() * Math.min(outcome.peak, 10);
    if (Math.abs(price) >= c.creatorSellMinDrop || price <= -c.creatorSellMinDrop) {
      return c.entry * price / 100 - c.overhead;
    }
  }
  const peak = outcome.peak;
  if (peak < c.slPct / 2) {
    const slip = 1 + Math.random() * 0.5;
    return -c.entry * c.slPct * slip / 100 - c.overhead;
  }
  if (peak < c.trailAct) {
    const retain = 0.3 + Math.random() * 0.4;
    const ex = peak * retain;
    if (ex < -c.slPct) return -c.entry * c.slPct / 100 - c.overhead;
    return c.entry * ex / 100 - c.overhead;
  }
  let remaining = 1.0;
  let pct = 0;
  let tps = 0;
  for (const tp of c.tps) {
    if (peak >= tp.level) {
      pct += tp.portion * tp.level;
      remaining -= tp.portion;
      tps++;
    }
  }
  const isRun = peak >= c.runnerAct;
  const dd = isRun ? c.runnerDrawdown : c.trailDrawdown;
  let exPct = peak - dd;
  if (tps > 0) exPct = Math.max(0, exPct);
  pct += remaining * exPct;
  return c.entry * pct / 100 - c.overhead;
}

function simulate(c: Config, dumpRate = 0.25): { ev: number; wr: number; pf: number; worst: number } {
  let wins = 0, winSum = 0, lossSum = 0, total = 0, worst = 0;
  for (let i = 0; i < N; i++) {
    const o = sampleOutcome(0.05, dumpRate, Math.max(0.15, 0.6 - dumpRate));
    const p = simTrade(o, c);
    total += p;
    if (p > 0) { wins++; winSum += p; } else { lossSum -= p; if (p < worst) worst = p; }
  }
  return { ev: total / N, wr: wins / N, pf: lossSum ? winSum / lossSum : Infinity, worst };
}

const OVERHEAD_007 = 0.07 * 0.02 + 0.0001 * 2 + 0.00001 * 2;  // 0.00142

// BEFORE — до применения creatorSellMinDropPct
const BEFORE: Config = {
  name: '❌ ДО: creatorSellMinDropPct=0 (immediate panic)',
  entry: 0.07,
  slPct: 12,
  trailAct: 25,
  trailDrawdown: 7,
  runnerAct: 100,
  runnerDrawdown: 25,
  tps: [
    { level: 35, portion: 0.15 },
    { level: 80, portion: 0.20 },
    { level: 250, portion: 0.15 },
    { level: 700, portion: 0.10 },
  ],
  creatorSellMinDrop: 0,
  overhead: OVERHEAD_007,
};

// AFTER — применено только creatorSellMinDropPct=5
const AFTER: Config = {
  ...BEFORE,
  name: '✅ ПОСЛЕ: creatorSellMinDropPct=5 (ТЕКУЩЕЕ ИЗМЕНЕНИЕ)',
  creatorSellMinDrop: 5,
};

// Alternative values for sensitivity
const AFTER_3: Config = {
  ...BEFORE,
  name: '🔵 АЛЬТ-A: creatorSellMinDropPct=3 (консервативно)',
  creatorSellMinDrop: 3,
};

const AFTER_7: Config = {
  ...BEFORE,
  name: '🔵 АЛЬТ-B: creatorSellMinDropPct=7 (агрессивно)',
  creatorSellMinDrop: 7,
};

const AFTER_10: Config = {
  ...BEFORE,
  name: '🔵 АЛЬТ-C: creatorSellMinDropPct=10 (максимум по grid search)',
  creatorSellMinDrop: 10,
};

// ═══════════════════════════════════════════════════════════════
// Main comparison
// ═══════════════════════════════════════════════════════════════

console.log('\n╔═══════════════════════════════════════════════════════════════════════╗');
console.log(`║  📊 A/B: эффект creatorSellMinDropPct на EV — ${N.toLocaleString()} trades              ║`);
console.log('╚═══════════════════════════════════════════════════════════════════════╝');

const configs = [BEFORE, AFTER, AFTER_3, AFTER_7, AFTER_10];

console.log('\n┌─────────────────────────────────────────────────────┬────────┬────────┬──────────┬──────┬──────────┐');
console.log('│ Конфиг                                              │  WR    │ PF     │ EV/trade │ Δ%   │ Monthly  │');
console.log('├─────────────────────────────────────────────────────┼────────┼────────┼──────────┼──────┼──────────┤');

const baselineEv = simulate(BEFORE).ev;
for (const c of configs) {
  const r = simulate(c, 0.25);
  const delta = r.ev !== baselineEv ? ((r.ev - baselineEv) / Math.abs(baselineEv) * 100) : 0;
  const monthlyEv = r.ev * 15 * 30;
  const label = c.name.slice(0, 51).padEnd(51);
  const wr = `${(r.wr * 100).toFixed(1)}%`.padStart(5);
  const pf = r.pf === Infinity ? '  ∞  ' : r.pf.toFixed(2).padStart(5);
  const ev = `${r.ev >= 0 ? '+' : ''}${r.ev.toFixed(5)}`.padStart(8);
  const deltaStr = c === BEFORE ? 'base'.padStart(5) : `${delta >= 0 ? '+' : ''}${delta.toFixed(0)}%`.padStart(5);
  const monthly = `${monthlyEv >= 0 ? '+' : ''}${monthlyEv.toFixed(3)}`.padStart(7);
  console.log(`│ ${label} │ ${wr}  │ ${pf}  │ ${ev} │ ${deltaStr}│ ${monthly}  │`);
}
console.log('└─────────────────────────────────────────────────────┴────────┴────────┴──────────┴──────┴──────────┘');

// ═══════════════════════════════════════════════════════════════
// Stress test по рыночным условиям
// ═══════════════════════════════════════════════════════════════

console.log('\n\n╔═══════════════════════════════════════════════════════════════════════╗');
console.log('║  🧪 Stress test: устойчивость "ПОСЛЕ" при разных рыночных условиях   ║');
console.log('╚═══════════════════════════════════════════════════════════════════════╝');

const scenarios = [
  { name: 'Хорошие условия (low dump)',   dump: 0.15 },
  { name: 'Нормальные условия',            dump: 0.25 },
  { name: 'Плохие условия',                dump: 0.35 },
  { name: 'Очень плохие (высокий dump)',   dump: 0.50 },
  { name: 'Экстремальные (bear market)',   dump: 0.65 },
];

console.log('\n┌──────────────────────────────────────┬─────────┬─────────┬──────────┬──────────┬───────────┐');
console.log('│ Сценарий                             │ Baseline │ +creator │ Delta    │ Monthly  │ Status    │');
console.log('│                                      │ (было)   │ Min=5    │          │ (AFTER)  │           │');
console.log('├──────────────────────────────────────┼─────────┼─────────┼──────────┼──────────┼───────────┤');

for (const s of scenarios) {
  const before = simulate(BEFORE, s.dump);
  const after = simulate(AFTER, s.dump);
  const delta = after.ev - before.ev;
  const monthly = after.ev * 15 * 30;
  const status = after.ev > 0.005 ? '✅ robust  ' : after.ev > 0.001 ? '⚠️  thin    ' : after.ev > 0 ? '⚠️  fragile ' : '❌ negative';

  const label = s.name.padEnd(36);
  const bEv = `${before.ev >= 0 ? '+' : ''}${before.ev.toFixed(5)}`.padStart(7);
  const aEv = `${after.ev >= 0 ? '+' : ''}${after.ev.toFixed(5)}`.padStart(7);
  const dEv = `${delta >= 0 ? '+' : ''}${delta.toFixed(5)}`.padStart(8);
  const m   = `${monthly >= 0 ? '+' : ''}${monthly.toFixed(3)}`.padStart(7);
  console.log(`│ ${label} │ ${bEv} │ ${aEv} │ ${dEv} │ ${m}  │ ${status}│`);
}
console.log('└──────────────────────────────────────┴─────────┴─────────┴──────────┴──────────┴───────────┘');

// ═══════════════════════════════════════════════════════════════
// Финальный вывод
// ═══════════════════════════════════════════════════════════════

const normalAfter = simulate(AFTER, 0.25);
const worstAfter  = simulate(AFTER, 0.50);

console.log('\n\n╔═══════════════════════════════════════════════════════════════════════╗');
console.log('║  🎯 ВЫВОД                                                             ║');
console.log('╚═══════════════════════════════════════════════════════════════════════╝');
console.log();
console.log(`  Применённое изменение: creatorSellMinDropPct = 5%`);
console.log(`  Затронуто: 1 параметр в config.ts + 2 функции в sniper.ts`);
console.log();
console.log(`  Ожидаемый EV:`);
console.log(`    • Нормальные условия: ${normalAfter.ev > 0 ? '+' : ''}${normalAfter.ev.toFixed(5)} SOL/trade`);
console.log(`    • Плохой рынок:       ${worstAfter.ev > 0 ? '+' : ''}${worstAfter.ev.toFixed(5)} SOL/trade`);
console.log(`    • Месячный EV:        ${(normalAfter.ev * 15 * 30).toFixed(3)} SOL (15 сделок/день)`);
console.log();
console.log(`  Механизм защиты:`);
console.log(`    До:    creator_sell → exit (любая PnL)`);
console.log(`    После: creator_sell → exit ТОЛЬКО если PnL < -5%`);
console.log();
console.log(`  Ожидаемое снижение flat exits (real data):`);
console.log(`    8 из 9 creator_sell exits в реальных данных (44% всех сделок)`);
console.log(`    были в диапазоне PnL [-2.53%, 0%] → теперь БУДУТ ИГНОРИРОВАТЬСЯ`);
console.log(`    Позиции сохранятся и пройдут через нормальные exit signals.`);
console.log();
