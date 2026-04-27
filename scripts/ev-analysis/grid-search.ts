#!/usr/bin/env ts-node
/**
 * scripts/ev-analysis/grid-search.ts
 *
 * Grid search по ключевым параметрам для поиска оптимального EV.
 * Варьируем:
 *   - creatorSellMinDropPct: 0, 1, 2, 3, 5, 7, 10 (0 = current immediate behavior)
 *   - TP1 level: 15, 18, 22, 25, 30, 35
 *   - TP1 portion: 0.15, 0.20, 0.25, 0.30
 *   - stopLossPercent: 10, 12, 15
 *
 * Выводит топ-10 конфигов по EV + стабильность (stress test).
 */

const N = 30_000;

interface Result {
  creatorSellMinDrop: number;
  tp1Level: number;
  tp1Portion: number;
  slPct: number;
  evPerTrade: number;
  wr: number;
  profitFactor: number;
  worstDump: number;  // EV at 50% dump rate
  stress: number;     // min EV across all dump rates
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

function simTrade(
  outcome: { peak: number; rug: boolean },
  params: {
    entry: number;
    slPct: number;
    trailAct: number;
    trailDrawdown: number;
    runnerAct: number;
    runnerDrawdown: number;
    tps: { level: number; portion: number }[];
    overhead: number;
    creatorSellMinDrop: number;
  }
): number {
  if (outcome.rug) {
    const roll = Math.random();
    let pct: number;
    if (roll < 0.5) pct = 1.0;
    else if (roll < 0.8) pct = 0.7;
    else pct = 0.4;
    return -params.entry * pct - params.overhead * 0.5;
  }

  // Creator sell fires 50% of the time (real data match)
  const creatorSellFires = Math.random() < 0.50;
  if (creatorSellFires) {
    // Price at creator sell: typically 0% to min(peak, 10%)
    const price = Math.random() * Math.min(outcome.peak, 10);
    if (Math.abs(price) >= params.creatorSellMinDrop || price <= -params.creatorSellMinDrop) {
      return params.entry * price / 100 - params.overhead;
    }
    // Ignored creator_sell: continue with normal exit
  }

  const peak = outcome.peak;
  if (peak < params.slPct / 2) {
    const slip = 1 + Math.random() * 0.5;
    return -params.entry * params.slPct * slip / 100 - params.overhead;
  }
  if (peak < params.trailAct) {
    const retain = 0.3 + Math.random() * 0.4;
    const ex = peak * retain;
    if (ex < -params.slPct) return -params.entry * params.slPct / 100 - params.overhead;
    return params.entry * ex / 100 - params.overhead;
  }

  let remaining = 1.0;
  let totalPct = 0;
  let tps = 0;
  for (const tp of params.tps) {
    if (peak >= tp.level) {
      totalPct += tp.portion * tp.level;
      remaining -= tp.portion;
      tps++;
    }
  }
  const isRun = peak >= params.runnerAct;
  const dd = isRun ? params.runnerDrawdown : params.trailDrawdown;
  let exitPct = peak - dd;
  if (tps > 0) exitPct = Math.max(0, exitPct);
  totalPct += remaining * exitPct;
  return params.entry * totalPct / 100 - params.overhead;
}

function evalConfig(
  creatorSellMinDrop: number,
  tp1Level: number,
  tp1Portion: number,
  slPct: number,
  dumpRate = 0.25,
): { ev: number; wr: number; pf: number } {
  const params = {
    entry: 0.07,
    slPct,
    trailAct: 25,
    trailDrawdown: 7,
    runnerAct: 100,
    runnerDrawdown: 25,
    tps: [
      { level: tp1Level, portion: tp1Portion },
      { level: 80, portion: 0.20 },
      { level: 250, portion: 0.15 },
      { level: 700, portion: 0.10 },
    ],
    overhead: 0.07 * 0.02 + 0.0001 * 2 + 0.00001 * 2,  // ~0.00142
    creatorSellMinDrop,
  };

  let wins = 0, winSum = 0, lossSum = 0, total = 0;
  for (let i = 0; i < N; i++) {
    const o = sampleOutcome(0.05, dumpRate, Math.max(0.15, 0.6 - dumpRate));
    const pnl = simTrade(o, params);
    total += pnl;
    if (pnl > 0) { wins++; winSum += pnl; } else { lossSum += -pnl; }
  }
  return {
    ev: total / N,
    wr: wins / N,
    pf: lossSum > 0 ? winSum / lossSum : Infinity,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// GRID SEARCH
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n╔════════════════════════════════════════════════════════════════╗');
console.log(`║  Grid Search — EV Optimization ${N.toLocaleString()} trades per cell         ║`);
console.log('╚════════════════════════════════════════════════════════════════╝');

const results: Result[] = [];

for (const creatorDrop of [0, 1, 2, 3, 5, 7, 10]) {
  for (const tp1 of [15, 18, 22, 25, 30, 35]) {
    for (const portion of [0.15, 0.20, 0.25, 0.30]) {
      for (const sl of [10, 12, 15]) {
        // Validate portions sum ≤ 0.60
        const remainingPortions = 0.20 + 0.15 + 0.10;
        if (portion + remainingPortions > 0.70) continue;

        const baseRes = evalConfig(creatorDrop, tp1, portion, sl, 0.25);
        const stressRes = evalConfig(creatorDrop, tp1, portion, sl, 0.50);

        results.push({
          creatorSellMinDrop: creatorDrop,
          tp1Level: tp1,
          tp1Portion: portion,
          slPct: sl,
          evPerTrade: baseRes.ev,
          wr: baseRes.wr,
          profitFactor: baseRes.pf,
          worstDump: stressRes.ev,
          stress: Math.min(baseRes.ev, stressRes.ev),
        });
      }
    }
  }
}

// Sort by: stress (minimum EV under bad conditions) — хотим РОБАСТНО положительный EV
results.sort((a, b) => b.stress - a.stress);

console.log('\n📊 ТОП-20 КОНФИГУРАЦИЙ (sorted by worst-case EV — stress test)');
console.log('─'.repeat(110));
console.log(' # │ CreatorDrop │ TP1        │ Portion │ SL   │ EV (normal) │ EV (hard)   │ WR    │ PF   │ Signal');
console.log('───┼─────────────┼────────────┼─────────┼──────┼─────────────┼─────────────┼───────┼──────┼─────────');
for (let i = 0; i < Math.min(20, results.length); i++) {
  const r = results[i];
  const row = [
    String(i + 1).padStart(2),
    `${r.creatorSellMinDrop}%`.padStart(9),
    `+${r.tp1Level}%`.padStart(8),
    `${(r.tp1Portion * 100).toFixed(0)}%`.padStart(5),
    `-${r.slPct}%`.padStart(4),
    `${r.evPerTrade >= 0 ? '+' : ''}${r.evPerTrade.toFixed(5)}`.padStart(10),
    `${r.worstDump >= 0 ? '+' : ''}${r.worstDump.toFixed(5)}`.padStart(10),
    `${(r.wr * 100).toFixed(1)}%`.padStart(5),
    r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2).padStart(4),
    r.stress > 0.005 ? '✅ excellent' : r.stress > 0.003 ? '✅ robust' : r.stress > 0.001 ? '⚠️  thin' : '❌ fragile',
  ];
  console.log(` ${row[0]} │     ${row[1]} │   ${row[2]} │  ${row[3]}  │ ${row[4]} │  ${row[5]} │  ${row[6]} │ ${row[7]} │ ${row[8]} │ ${row[9]}`);
}

// Также показать ХУДШИЕ — что точно НЕ делать
console.log('\n📉 ХУДШИЕ 5 КОНФИГУРАЦИЙ (для сравнения — что ломает EV):');
console.log('─'.repeat(110));
const worst = [...results].sort((a, b) => a.stress - b.stress).slice(0, 5);
for (const r of worst) {
  console.log(` creatorDrop=${r.creatorSellMinDrop}% TP1=+${r.tp1Level}%×${(r.tp1Portion*100).toFixed(0)}% SL=-${r.slPct}%  EV=${r.evPerTrade>=0?'+':''}${r.evPerTrade.toFixed(5)}/${r.worstDump>=0?'+':''}${r.worstDump.toFixed(5)} SOL`);
}

// Анализ по группам — один параметр
console.log('\n\n📈 SENSITIVITY ANALYSIS');
console.log('─'.repeat(75));

console.log('\n1. Эффект creatorSellMinDropPct (avg EV across all other params):');
const byCD: Record<number, number[]> = {};
for (const r of results) {
  if (!byCD[r.creatorSellMinDrop]) byCD[r.creatorSellMinDrop] = [];
  byCD[r.creatorSellMinDrop].push(r.evPerTrade);
}
for (const cd of Object.keys(byCD).map(Number).sort((a, b) => a - b)) {
  const evs = byCD[cd];
  const avg = evs.reduce((s, x) => s + x, 0) / evs.length;
  const max = Math.max(...evs);
  const min = Math.min(...evs);
  console.log(`   creatorDrop=${String(cd).padStart(2)}%  avg=${avg>=0?'+':''}${avg.toFixed(5)}  range=[${min>=0?'+':''}${min.toFixed(5)} ... ${max>=0?'+':''}${max.toFixed(5)}]`);
}

console.log('\n2. Эффект TP1 level (avg EV across all other params):');
const byTP: Record<number, number[]> = {};
for (const r of results) {
  if (!byTP[r.tp1Level]) byTP[r.tp1Level] = [];
  byTP[r.tp1Level].push(r.evPerTrade);
}
for (const tp of Object.keys(byTP).map(Number).sort((a, b) => a - b)) {
  const evs = byTP[tp];
  const avg = evs.reduce((s, x) => s + x, 0) / evs.length;
  console.log(`   TP1=+${String(tp).padStart(2)}%  avg EV=${avg>=0?'+':''}${avg.toFixed(5)}`);
}

console.log('\n3. Эффект TP1 portion:');
const byPort: Record<number, number[]> = {};
for (const r of results) {
  if (!byPort[r.tp1Portion]) byPort[r.tp1Portion] = [];
  byPort[r.tp1Portion].push(r.evPerTrade);
}
for (const p of Object.keys(byPort).map(Number).sort((a, b) => a - b)) {
  const evs = byPort[p];
  const avg = evs.reduce((s, x) => s + x, 0) / evs.length;
  console.log(`   portion=${(p*100).toFixed(0)}%  avg EV=${avg>=0?'+':''}${avg.toFixed(5)}`);
}

console.log('\n4. Эффект stop-loss:');
const bySL: Record<number, number[]> = {};
for (const r of results) {
  if (!bySL[r.slPct]) bySL[r.slPct] = [];
  bySL[r.slPct].push(r.evPerTrade);
}
for (const sl of Object.keys(bySL).map(Number).sort((a, b) => a - b)) {
  const evs = bySL[sl];
  const avg = evs.reduce((s, x) => s + x, 0) / evs.length;
  console.log(`   SL=-${String(sl).padStart(2)}%  avg EV=${avg>=0?'+':''}${avg.toFixed(5)}`);
}

// Рекомендация
console.log('\n\n🎯 РЕКОМЕНДАЦИЯ');
console.log('─'.repeat(75));
const top = results[0];
console.log(`  Оптимальный конфиг (лучший по stress test):`);
console.log(`    creatorSellMinDropPct: ${top.creatorSellMinDrop}%`);
console.log(`    TP1 level:             +${top.tp1Level}%`);
console.log(`    TP1 portion:           ${(top.tp1Portion * 100).toFixed(0)}%`);
console.log(`    Stop-loss:             -${top.slPct}%`);
console.log(`    Expected EV:           ${top.evPerTrade >= 0 ? '+' : ''}${top.evPerTrade.toFixed(5)} SOL/trade (normal)`);
console.log(`    Worst-case EV:         ${top.worstDump >= 0 ? '+' : ''}${top.worstDump.toFixed(5)} SOL/trade (50% dump rate)`);
console.log(`    Monthly EV (15tr/day): ${top.evPerTrade >= 0 ? '+' : ''}${(top.evPerTrade * 15 * 30).toFixed(3)} SOL`);
console.log();
