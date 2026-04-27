#!/usr/bin/env ts-node

/**
 * scripts/ev-simulation.ts
 *
 * Monte Carlo симуляция EV бота при разных конфигурациях.
 * Моделирует 10,000 сделок с реалистичным распределением peak price
 * для pump.fun/PumpSwap токенов. Применяет полную exit-логику:
 * SL, trailing, TP ladder, BE stop, runner tail.
 *
 * Запуск: npx ts-node scripts/ev-simulation.ts
 */

const TRADES = 50_000;

interface TpLevel { level: number; portion: number }

interface SimConfig {
  name: string;
  entryAmountSol: number;
  stopLossPercent: number;
  trailingActivation: number;
  trailingDrawdown: number;
  runnerActivation: number;
  runnerTrailingDrawdown: number;
  takeProfit: TpLevel[];
  overheadPerTrade: number;
  tradesPerDay: number;
  dumpRate: number; // probability of immediate dump (score quality proxy)
}

// Peak price distribution (% above entry).
// dumpRate controls quality filtering — higher score = lower dumpRate.
function randomPeak(dumpRate: number): number {
  const r = Math.random();
  let cum = 0;

  // Immediate dumps (SL territory)
  cum += dumpRate * 0.65;  // deep dumps
  if (r < cum) return -25 + Math.random() * 15; // -25% to -10%

  cum += dumpRate * 0.35;  // moderate dumps
  if (r < cum) return -10 + Math.random() * 10; // -10% to 0%

  // Normalize remaining probability
  const remaining = 1 - dumpRate;
  const rNorm = (r - dumpRate) / remaining;

  if (rNorm < 0.30) return Math.random() * 15;              // 0% to +15% (stagnation)
  if (rNorm < 0.50) return 15 + Math.random() * 15;         // +15% to +30% (small pump)
  if (rNorm < 0.68) return 30 + Math.random() * 50;         // +30% to +80% (good pump)
  if (rNorm < 0.80) return 80 + Math.random() * 120;        // +80% to +200% (strong pump)
  if (rNorm < 0.90) return 200 + Math.random() * 300;       // +200% to +500% (runner)
  if (rNorm < 0.96) return 500 + Math.random() * 500;       // +500% to +1000% (big runner)
  return 1000 + Math.random() * 4000;                       // +1000% to +5000% (monster)
}

function simulateTrade(peak: number, cfg: SimConfig): { pnl: number; type: string } {
  const entry = cfg.entryAmountSol;

  // Case 1: Peak below stop-loss → full loss
  if (peak <= -cfg.stopLossPercent) {
    return { pnl: -entry * cfg.stopLossPercent / 100, type: 'stop_loss' };
  }

  // Case 2: Peak below 0% (slow bleed, never pumped) → exit near peak or SL
  if (peak <= 0) {
    // Time stop or stagnation catches near 0% or at SL
    const exitPct = Math.max(-cfg.stopLossPercent, peak * 0.7);
    return { pnl: entry * exitPct / 100, type: 'time_stop' };
  }

  // Case 3: Peak > 0% but below trailing activation → stagnation/early exit
  if (peak < cfg.trailingActivation) {
    // Price peaked low, drifted back → exit near 0% or slight gain/loss
    // Model: exit at ~30-50% of peak (partial retracement) or SL
    const exitPct = peak * (0.2 + Math.random() * 0.3); // 20-50% of peak retained
    if (exitPct < -cfg.stopLossPercent) {
      return { pnl: -entry * cfg.stopLossPercent / 100, type: 'stop_loss' };
    }
    return { pnl: entry * exitPct / 100, type: 'stagnation' };
  }

  // Case 4: Peak >= trailing activation → TPs + trailing logic
  let remaining = 1.0;
  let totalPnl = 0;
  let tpsTaken = 0;

  // Fire TPs sequentially (price crosses each level on the way up)
  for (const tp of cfg.takeProfit) {
    if (peak >= tp.level) {
      totalPnl += entry * tp.portion * tp.level / 100;
      remaining -= tp.portion;
      tpsTaken++;
    }
  }

  // Determine exit price for remaining position
  let isRunner = peak >= cfg.runnerActivation;
  let drawdown = isRunner ? cfg.runnerTrailingDrawdown : cfg.trailingDrawdown;
  let trailingExit = peak - drawdown;

  // BE stop: if any TP was taken, floor is 0%
  if (tpsTaken > 0) {
    trailingExit = Math.max(0, trailingExit);
  }

  // Remaining position exits at trailing price
  totalPnl += entry * remaining * trailingExit / 100;

  const exitType = isRunner ? 'runner' : (tpsTaken >= 2 ? 'tp_multi' : 'tp_trailing');
  return { pnl: totalPnl, type: exitType };
}

function runSimulation(cfg: SimConfig): void {
  let totalPnl = 0;
  let wins = 0;
  let losses = 0;
  let totalWinPnl = 0;
  let totalLossPnl = 0;
  const types: Record<string, number> = {};

  for (let i = 0; i < TRADES; i++) {
    const peak = randomPeak(cfg.dumpRate);
    const result = simulateTrade(peak, cfg);
    const netPnl = result.pnl - cfg.overheadPerTrade;

    totalPnl += netPnl;
    types[result.type] = (types[result.type] || 0) + 1;

    if (netPnl > 0) {
      wins++;
      totalWinPnl += netPnl;
    } else {
      losses++;
      totalLossPnl += netPnl;
    }
  }

  const wr = wins / TRADES;
  const avgWin = wins > 0 ? totalWinPnl / wins : 0;
  const avgLoss = losses > 0 ? totalLossPnl / losses : 0;
  const evPerTrade = totalPnl / TRADES;
  const dailyEv = evPerTrade * cfg.tradesPerDay;
  const weeklyEv = dailyEv * 7;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${cfg.name}`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Entry:            ${cfg.entryAmountSol} SOL`);
  console.log(`  Stop-loss:        -${cfg.stopLossPercent}%`);
  console.log(`  TP levels:        ${cfg.takeProfit.map(t => `+${t.level}%/${(t.portion*100).toFixed(0)}%`).join(', ')}`);
  console.log(`  Runner reserve:   ${((1 - cfg.takeProfit.reduce((a, t) => a + t.portion, 0)) * 100).toFixed(0)}%`);
  console.log(`  Overhead/trade:   ${cfg.overheadPerTrade.toFixed(5)} SOL`);
  console.log(`  Trades/day:       ${cfg.tradesPerDay}`);
  console.log(`  Dump rate:        ${(cfg.dumpRate * 100).toFixed(0)}%`);
  console.log();
  console.log(`  Win rate:         ${(wr * 100).toFixed(1)}%`);
  console.log(`  Avg win:          +${avgWin.toFixed(5)} SOL (+${(avgWin / cfg.entryAmountSol * 100).toFixed(1)}%)`);
  console.log(`  Avg loss:         ${avgLoss.toFixed(5)} SOL (${(avgLoss / cfg.entryAmountSol * 100).toFixed(1)}%)`);
  console.log(`  Win/Loss ratio:   ${(avgWin / Math.abs(avgLoss)).toFixed(2)}:1`);
  console.log(`  EV/trade:         ${evPerTrade >= 0 ? '+' : ''}${evPerTrade.toFixed(5)} SOL`);
  console.log(`  Daily EV:         ${dailyEv >= 0 ? '+' : ''}${dailyEv.toFixed(4)} SOL (${cfg.tradesPerDay} trades)`);
  console.log(`  Weekly EV:        ${weeklyEv >= 0 ? '+' : ''}${weeklyEv.toFixed(3)} SOL`);
  console.log();
  console.log(`  Exit breakdown:`);
  for (const [type, count] of Object.entries(types).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${type.padEnd(16)} ${count.toString().padStart(6)} (${(count / TRADES * 100).toFixed(1)}%)`);
  }

  // Breakeven WR calculation
  const beWr = (Math.abs(avgLoss) + cfg.overheadPerTrade) / (avgWin + Math.abs(avgLoss));
  console.log(`\n  Breakeven WR:     ${(beWr * 100).toFixed(1)}%`);
  console.log(`  Current surplus:  ${((wr - beWr) * 100).toFixed(1)} pp ${wr > beWr ? '✅' : '❌'}`);
}

// ── Config variants ─────────────────────────────────────────────

const OVERHEAD = 0.00037; // corrected: priority 0.0000624 + tips 0.0002 + base 0.00001 + failed 0.0001

const CURRENT: SimConfig = {
  name: 'ТЕКУЩИЙ конфиг (baseline)',
  entryAmountSol: 0.07,
  stopLossPercent: 15,
  trailingActivation: 25,
  trailingDrawdown: 9,
  runnerActivation: 100,
  runnerTrailingDrawdown: 25,
  takeProfit: [
    { level: 25, portion: 0.20 },
    { level: 80, portion: 0.20 },
    { level: 250, portion: 0.15 },
    { level: 600, portion: 0.10 },
  ],
  overheadPerTrade: OVERHEAD,
  tradesPerDay: 17,
  dumpRate: 0.55, // minTokenScore 50 → 55% dump rate
};

const PROPOSED_A: SimConfig = {
  name: 'Вариант A: SL 15→12% + scoring 60',
  entryAmountSol: 0.07,
  stopLossPercent: 12,
  trailingActivation: 25,
  trailingDrawdown: 9,
  runnerActivation: 100,
  runnerTrailingDrawdown: 25,
  takeProfit: [
    { level: 25, portion: 0.20 },
    { level: 80, portion: 0.20 },
    { level: 250, portion: 0.15 },
    { level: 600, portion: 0.10 },
  ],
  overheadPerTrade: OVERHEAD,
  tradesPerDay: 12,
  dumpRate: 0.45, // minTokenScore 60 → 45% dump rate
};

const PROPOSED_B: SimConfig = {
  name: 'Вариант B: SL 12% + scoring 60 + TP1 40%/15%',
  entryAmountSol: 0.07,
  stopLossPercent: 12,
  trailingActivation: 25,
  trailingDrawdown: 9,
  runnerActivation: 100,
  runnerTrailingDrawdown: 25,
  takeProfit: [
    { level: 40, portion: 0.15 },
    { level: 100, portion: 0.20 },
    { level: 300, portion: 0.15 },
    { level: 600, portion: 0.10 },
  ],
  overheadPerTrade: OVERHEAD,
  tradesPerDay: 12,
  dumpRate: 0.45,
};

const PROPOSED_C: SimConfig = {
  name: 'Вариант C: SL 12% + scoring 60 + TP1 35%/15% + trailing 7%',
  entryAmountSol: 0.07,
  stopLossPercent: 12,
  trailingActivation: 25,
  trailingDrawdown: 7,
  runnerActivation: 100,
  runnerTrailingDrawdown: 20,
  takeProfit: [
    { level: 35, portion: 0.15 },
    { level: 100, portion: 0.20 },
    { level: 300, portion: 0.15 },
    { level: 700, portion: 0.10 },
  ],
  overheadPerTrade: OVERHEAD,
  tradesPerDay: 12,
  dumpRate: 0.45,
};

const PROPOSED_D: SimConfig = {
  name: 'Вариант D: entry 0.05 + SL 12% + scoring 60 + aggressive TP',
  entryAmountSol: 0.05,
  stopLossPercent: 12,
  trailingActivation: 25,
  trailingDrawdown: 8,
  runnerActivation: 100,
  runnerTrailingDrawdown: 22,
  takeProfit: [
    { level: 35, portion: 0.15 },
    { level: 100, portion: 0.20 },
    { level: 300, portion: 0.15 },
    { level: 700, portion: 0.10 },
  ],
  overheadPerTrade: OVERHEAD,
  tradesPerDay: 12,
  dumpRate: 0.45,
};

// ── CT simulation ──────────────────────────────────────────────

const CT_T1: SimConfig = {
  name: 'Copy-Trade T1 (WR~60%, entry 0.06)',
  entryAmountSol: 0.06,
  stopLossPercent: 15,
  trailingActivation: 25,
  trailingDrawdown: 9,
  runnerActivation: 100,
  runnerTrailingDrawdown: 25,
  takeProfit: [
    { level: 25, portion: 0.20 },
    { level: 80, portion: 0.20 },
    { level: 250, portion: 0.15 },
    { level: 600, portion: 0.10 },
  ],
  overheadPerTrade: OVERHEAD,
  tradesPerDay: 3,
  dumpRate: 0.25, // pre-filtered by wallet tracker → much lower dump rate
};

// ── Run all ────────────────────────────────────────────────────

console.log('\n╔══════════════════════════════════════════════════════════╗');
console.log('  EV Monte Carlo Simulation — Sniper Bot v3');
console.log(`  ${TRADES.toLocaleString()} trades per config`);
console.log('╚══════════════════════════════════════════════════════════╝');

runSimulation(CURRENT);
runSimulation(PROPOSED_A);
runSimulation(PROPOSED_B);
runSimulation(PROPOSED_C);
runSimulation(PROPOSED_D);
runSimulation(CT_T1);

// ── Summary table ─────────────────────────────────────────────

console.log('\n\n' + '═'.repeat(80));
console.log('  СВОДНАЯ ТАБЛИЦА (sniper + CT T1 3 trades/day)');
console.log('═'.repeat(80));
console.log('  Конфиг                                    │ EV/trade │ Daily   │ Weekly');
console.log('  ──────────────────────────────────────────┼──────────┼─────────┼────────');

for (const cfg of [CURRENT, PROPOSED_A, PROPOSED_B, PROPOSED_C, PROPOSED_D]) {
  let tot = 0; let w = 0;
  for (let i = 0; i < TRADES; i++) {
    const p = randomPeak(cfg.dumpRate);
    const r = simulateTrade(p, cfg);
    tot += r.pnl - cfg.overheadPerTrade;
    if (r.pnl - cfg.overheadPerTrade > 0) w++;
  }
  // CT contribution (fixed estimate)
  const ctDaily = 3 * 0.005; // T1 only
  const evT = tot / TRADES;
  const daily = evT * cfg.tradesPerDay + ctDaily;
  const weekly = daily * 7;
  const label = cfg.name.slice(0, 42).padEnd(42);
  console.log(`  ${label}│ ${evT >= 0 ? '+' : ''}${evT.toFixed(5)} │ ${daily >= 0 ? '+' : ''}${daily.toFixed(4)} │ ${weekly >= 0 ? '+' : ''}${weekly.toFixed(3)}`);
}
console.log();
