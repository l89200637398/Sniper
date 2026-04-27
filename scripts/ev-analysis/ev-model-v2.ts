#!/usr/bin/env ts-node
/**
 * scripts/ev-analysis/ev-model-v2.ts
 *
 * EV-модель v2 — калиброванная на реальных данных (18 сделок, 2026-04-22).
 *
 * Ключевые факты из реальной сессии:
 *  • WR = 33.3%, EV/trade = +0.000553 SOL, Profit Factor = 1.11 (хрупко)
 *  • 44% сделок = flat loss (-2.53% = чистые protocol fees pump.fun)
 *  • 0/18 сделок достигли TP1 на 35%
 *  • Средний peak = +8.33% (gg для TP1 35%)
 *  • 50% exits = creator_sell (из них 67% убыточны в flat-зоне)
 *  • Roundtrip cost at 0.05 SOL entry = 0.001264 SOL (2.53%)
 *    - pump.fun protocol fee: 1% buy + 1% sell = 2.0%
 *    - Jito tips: 0.4%
 *    - Priority fees: 0.04%
 *    - Slippage/other: 0.1%
 *
 * Цель: найти параметры, при которых EV устойчиво положительный при ЛЮБОМ
 * разумном WR (≥30%) и без зависимости от tail-event'ов (>3x runners).
 */

const N_TRADES = 100_000;

interface TpLevel { level: number; portion: number }

interface SimConfig {
  name: string;
  entryAmountSol: number;

  // Exit params
  stopLossPercent: number;
  trailingActivation: number;
  trailingDrawdown: number;
  runnerActivation: number;
  runnerDrawdown: number;
  takeProfit: TpLevel[];

  // Cost model (as fraction of entry)
  protocolFeePct: number;   // pump.fun: 2% roundtrip; pumpswap: ~2.5%
  jitoTipSol: number;       // absolute SOL per bundle (×2 for buy+sell)
  prioritySol: number;      // absolute SOL per tx (×2)

  // Behavior params (new — these solve real data issues)
  /** Immediate panic-exit on creator_sell regardless of price? Real data: yes (50% of exits). */
  creatorSellImmediate: boolean;
  /** Minimum PnL% before creator_sell triggers exit. E.g. -5% = wait for actual drop. */
  creatorSellMinDropPct: number;
  /** Stagnation timeout ms (pump.fun default 35000). */
  stagnationWindowMs: number;

  // Token universe params
  /** Rug probability (token goes to -100%). Real data: 5.6% (1/18). */
  rugRate: number;
  /** Dump rate: probability token never pumps and exits at flat loss or SL. */
  dumpRate: number;
  /** Flat rate: probability token stays within ±5% (no direction). */
  flatRate: number;

  tradesPerDay: number;
}

/**
 * Реалистичная модель peak price основанная на эмпирических данных:
 *
 * Категории токенов:
 *   1. Rug (~5%): peak 0-1%, exit at -100% (не успеваем продать)
 *   2. Immediate dump (~20%): peak 0-5%, цена падает ниже SL сразу
 *   3. Flat/dead (~40%): peak 0-10%, пампа нет, закрывается по stagnation/creator_sell
 *   4. Weak pump (~20%): peak 10-30%, закрывается trailing
 *   5. Moderate pump (~10%): peak 30-100%, закрывается TP2/trailing
 *   6. Strong pump (~3%): peak 100-300%
 *   7. Runner (~1.5%): peak 300-1000%
 *   8. Monster (~0.5%): peak >1000%
 *
 * Эти категории согласуются с рыночной статистикой pump.fun:
 *   - 1-3% graduate to AMM (roughly category 5+)
 *   - 30-50% die within minutes (categories 1-3)
 */
function sampleTokenOutcome(cfg: SimConfig): { peak: number; category: string; rug: boolean } {
  const r = Math.random();
  let cum = 0;

  // 1. Rug
  cum += cfg.rugRate;
  if (r < cum) return { peak: Math.random() * 2, category: 'rug', rug: true };

  // 2. Immediate dump
  cum += cfg.dumpRate * 0.5;
  if (r < cum) return { peak: Math.random() * 5, category: 'dump', rug: false };

  // 3. Flat/dead
  cum += cfg.flatRate + cfg.dumpRate * 0.5;
  if (r < cum) return { peak: Math.random() * 10, category: 'flat', rug: false };

  // Remaining = winners, normalized
  const rNorm = (r - cum) / (1 - cum);
  if (rNorm < 0.50) return { peak: 10 + Math.random() * 20, category: 'weak_pump', rug: false };   // +10% to +30%
  if (rNorm < 0.75) return { peak: 30 + Math.random() * 70, category: 'mod_pump', rug: false };    // +30% to +100%
  if (rNorm < 0.90) return { peak: 100 + Math.random() * 200, category: 'strong', rug: false };    // +100% to +300%
  if (rNorm < 0.97) return { peak: 300 + Math.random() * 700, category: 'runner', rug: false };    // +300% to +1000%
  return { peak: 1000 + Math.random() * 4000, category: 'monster', rug: false };                    // +1000%+
}

interface TradeResult {
  pnlSol: number;
  exitReason: string;
  peak: number;
  category: string;
  tpsTriggered: number;
}

function simulateTrade(outcome: { peak: number; category: string; rug: boolean }, cfg: SimConfig): TradeResult {
  const entry = cfg.entryAmountSol;
  const peak = outcome.peak;

  // Roundtrip cost in SOL (fixed per trade, regardless of P&L).
  const feeCost = entry * cfg.protocolFeePct;
  const tipCost = cfg.jitoTipSol * 2;
  const priCost = cfg.prioritySol * 2;
  const overhead = feeCost + tipCost + priCost;

  // Rug: loss depends on how fast we react. Assume 30% of entry lost on average
  // (may get partial exit via Jupiter fallback, or may land at ~-50% with luck).
  // Real data showed -100% on one rug (worst case).
  if (outcome.rug) {
    // Probabilistic: 50% total loss, 30% -70%, 20% -40% (partial rescue)
    const rugRoll = Math.random();
    let lossPct: number;
    if (rugRoll < 0.5) lossPct = 1.0;      // total rug
    else if (rugRoll < 0.8) lossPct = 0.7; // late detection
    else lossPct = 0.4;                    // quick exit via Jupiter
    return { pnlSol: -entry * lossPct - overhead * 0.5, exitReason: 'rug', peak, category: outcome.category, tpsTriggered: 0 };
    // overhead * 0.5: only buy-side costs (sell may fail)
  }

  // Creator sell: fires randomly during the hold period.
  // Real data: 50% of trades exit via creator_sell.
  // If creatorSellImmediate=true, exits at current price when creator sells.
  // Most creator_sells in real data happened at flat PnL (price hadn't moved).
  const creatorSellFires = Math.random() < 0.50;
  if (creatorSellFires && cfg.creatorSellImmediate) {
    // Price when creator sells: uniform 0% to min(peak, 10%) — creator usually sells before pump
    const priceAtCreatorSell = Math.random() * Math.min(peak, 10);
    // If price hasn't moved enough (< creatorSellMinDropPct), we'd skip exit with smarter logic
    if (Math.abs(priceAtCreatorSell) >= cfg.creatorSellMinDropPct) {
      const pnl = entry * priceAtCreatorSell / 100 - overhead;
      return { pnlSol: pnl, exitReason: 'creator_sell', peak, category: outcome.category, tpsTriggered: 0 };
    }
    // If we have smart exit (creatorSellMinDropPct>0), we IGNORE this creator sell and continue
  }

  // Immediate deep drop → stop loss
  if (peak < cfg.stopLossPercent / 2) {
    // Token barely moved up then dumped through SL
    // Actual exit: around -stopLoss% but with slippage → typically -15% to -20% for 12% SL
    const slSlippage = 1 + Math.random() * 0.5; // 1.0-1.5x
    const exitPct = -cfg.stopLossPercent * slSlippage;
    return { pnlSol: entry * exitPct / 100 - overhead, exitReason: 'stop_loss', peak, category: outcome.category, tpsTriggered: 0 };
  }

  // Peak below trailing activation → stagnation/time_stop
  if (peak < cfg.trailingActivation) {
    // Price went up, drifted, then closed by stagnation window.
    // Exit price: roughly 30-70% of peak retained (price drifts back toward entry)
    const retainFactor = 0.3 + Math.random() * 0.4;
    const exitPct = peak * retainFactor;
    // If drifted below SL during stagnation
    if (exitPct < -cfg.stopLossPercent) {
      return { pnlSol: -entry * cfg.stopLossPercent / 100 - overhead, exitReason: 'stop_loss', peak, category: outcome.category, tpsTriggered: 0 };
    }
    return { pnlSol: entry * exitPct / 100 - overhead, exitReason: 'stagnation', peak, category: outcome.category, tpsTriggered: 0 };
  }

  // Peak ≥ trailingActivation → TP ladder + trailing
  let remaining = 1.0;
  let totalProfitPct = 0;  // weighted by portion
  let tpsHit = 0;

  for (const tp of cfg.takeProfit) {
    if (peak >= tp.level) {
      totalProfitPct += tp.portion * tp.level;
      remaining -= tp.portion;
      tpsHit++;
    }
  }

  // Runner or regular trailing
  const isRunner = peak >= cfg.runnerActivation;
  const drawdown = isRunner ? cfg.runnerDrawdown : cfg.trailingDrawdown;
  let trailingExitPct = peak - drawdown;

  // Break-even floor after TP1 hit
  if (tpsHit > 0) trailingExitPct = Math.max(0, trailingExitPct);

  totalProfitPct += remaining * trailingExitPct;

  const exitReason = isRunner ? 'runner' : tpsHit > 0 ? `tp${tpsHit}+trail` : 'trailing';
  return {
    pnlSol: entry * totalProfitPct / 100 - overhead,
    exitReason,
    peak,
    category: outcome.category,
    tpsTriggered: tpsHit,
  };
}

interface SimStats {
  wr: number;
  evPerTrade: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  worstLoss: number;
  winsPctOfEntry: number;
  lossesPctOfEntry: number;
  breakevenWr: number;
  exitBreakdown: Record<string, { count: number; pnl: number }>;
  tpHitRate: number;
  categoryBreakdown: Record<string, number>;
  dailyEv: number;
  weeklyEv: number;
  monthlyEv: number;
  sharpeRatio: number;
  maxDrawdown: number;
}

function runSim(cfg: SimConfig, verbose: boolean = true): SimStats {
  let wins = 0, losses = 0;
  let totalPnl = 0, totalWinPnl = 0, totalLossPnl = 0, worstLoss = 0;
  const exitBreak: Record<string, { count: number; pnl: number }> = {};
  const catBreak: Record<string, number> = {};
  let tpsHit = 0;
  const pnls: number[] = [];

  for (let i = 0; i < N_TRADES; i++) {
    const outcome = sampleTokenOutcome(cfg);
    const res = simulateTrade(outcome, cfg);
    totalPnl += res.pnlSol;
    pnls.push(res.pnlSol);

    if (res.pnlSol > 0) {
      wins++;
      totalWinPnl += res.pnlSol;
    } else {
      losses++;
      totalLossPnl += -res.pnlSol;
      if (res.pnlSol < worstLoss) worstLoss = res.pnlSol;
    }
    if (!exitBreak[res.exitReason]) exitBreak[res.exitReason] = { count: 0, pnl: 0 };
    exitBreak[res.exitReason].count++;
    exitBreak[res.exitReason].pnl += res.pnlSol;
    catBreak[res.category] = (catBreak[res.category] ?? 0) + 1;
    if (res.tpsTriggered > 0) tpsHit++;
  }

  const wr = wins / N_TRADES;
  const evPerTrade = totalPnl / N_TRADES;
  const avgWin = wins ? totalWinPnl / wins : 0;
  const avgLoss = losses ? -totalLossPnl / losses : 0;
  const pf = totalLossPnl > 0 ? totalWinPnl / totalLossPnl : Infinity;
  const beWr = (Math.abs(avgLoss)) / (avgWin + Math.abs(avgLoss));

  // Sharpe ratio (daily): mean / stdev × sqrt(tradesPerDay)
  const mean = totalPnl / N_TRADES;
  const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / N_TRADES;
  const stdev = Math.sqrt(variance);
  const sharpe = stdev > 0 ? (mean / stdev) * Math.sqrt(cfg.tradesPerDay) : 0;

  // Max drawdown via random-order cumulative sum
  let cum = 0, peak = 0, mdd = 0;
  for (const p of pnls) {
    cum += p;
    if (cum > peak) peak = cum;
    if (peak - cum > mdd) mdd = peak - cum;
  }

  const dailyEv = evPerTrade * cfg.tradesPerDay;
  const stats: SimStats = {
    wr,
    evPerTrade,
    profitFactor: pf,
    avgWin,
    avgLoss,
    worstLoss,
    winsPctOfEntry: avgWin / cfg.entryAmountSol * 100,
    lossesPctOfEntry: avgLoss / cfg.entryAmountSol * 100,
    breakevenWr: beWr,
    exitBreakdown: exitBreak,
    tpHitRate: tpsHit / N_TRADES,
    categoryBreakdown: catBreak,
    dailyEv,
    weeklyEv: dailyEv * 7,
    monthlyEv: dailyEv * 30,
    sharpeRatio: sharpe,
    maxDrawdown: mdd,
  };

  if (verbose) printStats(cfg.name, cfg, stats);
  return stats;
}

function printStats(name: string, cfg: SimConfig, s: SimStats): void {
  const SEP = '━'.repeat(72);
  console.log(`\n${SEP}`);
  console.log(`  ${name}`);
  console.log(SEP);
  console.log(`  Entry: ${cfg.entryAmountSol} SOL  SL: -${cfg.stopLossPercent}%  Trail: ${cfg.trailingActivation}%→${cfg.trailingDrawdown}%`);
  console.log(`  TPs: ${cfg.takeProfit.map(t => `+${t.level}%×${(t.portion*100).toFixed(0)}%`).join(' ')}  Runner@${cfg.runnerActivation}%`);
  console.log(`  Creator-sell: ${cfg.creatorSellImmediate ? `immediate (min drop ${cfg.creatorSellMinDropPct}%)` : 'DISABLED'}`);
  console.log();
  console.log(`  ━━ Performance ━━`);
  console.log(`    WR:             ${(s.wr*100).toFixed(1)}%  (breakeven WR: ${(s.breakevenWr*100).toFixed(1)}%)`);
  console.log(`    EV/trade:       ${s.evPerTrade>=0?'+':''}${s.evPerTrade.toFixed(6)} SOL  (${(s.evPerTrade/cfg.entryAmountSol*100).toFixed(2)}% of entry)  ${s.evPerTrade>0?'✅':'❌'}`);
  console.log(`    Profit Factor:  ${s.profitFactor.toFixed(2)}  ${s.profitFactor>=1.3?'✅':s.profitFactor>=1.1?'⚠️':'❌'}`);
  console.log(`    Sharpe (daily): ${s.sharpeRatio.toFixed(2)}`);
  console.log(`    Avg win:        +${s.avgWin.toFixed(6)} SOL  (+${s.winsPctOfEntry.toFixed(1)}% of entry)`);
  console.log(`    Avg loss:       ${s.avgLoss.toFixed(6)} SOL  (${s.lossesPctOfEntry.toFixed(1)}% of entry)`);
  console.log(`    Win/Loss:       ${(s.avgWin/Math.abs(s.avgLoss)).toFixed(2)}:1`);
  console.log(`    Worst loss:     ${s.worstLoss.toFixed(6)} SOL`);
  console.log(`    TP hit rate:    ${(s.tpHitRate*100).toFixed(1)}%`);
  console.log(`    Max drawdown:   ${s.maxDrawdown.toFixed(4)} SOL (over ${N_TRADES} trades)`);
  console.log();
  console.log(`  ━━ Daily projection (${cfg.tradesPerDay} trades/day) ━━`);
  console.log(`    Daily EV:       ${s.dailyEv>=0?'+':''}${s.dailyEv.toFixed(4)} SOL`);
  console.log(`    Weekly EV:      ${s.weeklyEv>=0?'+':''}${s.weeklyEv.toFixed(3)} SOL`);
  console.log(`    Monthly EV:     ${s.monthlyEv>=0?'+':''}${s.monthlyEv.toFixed(3)} SOL`);
  console.log();
  console.log(`  ━━ Exit breakdown ━━`);
  const sortedExits = Object.entries(s.exitBreakdown).sort((a,b) => b[1].count - a[1].count);
  for (const [reason, d] of sortedExits) {
    const pct = (d.count / N_TRADES * 100).toFixed(1);
    const avgPnl = d.pnl / d.count;
    console.log(`    ${reason.padEnd(16)} ${String(d.count).padStart(6)} (${pct}%)  avg=${avgPnl>=0?'+':''}${avgPnl.toFixed(6)} SOL`);
  }
  console.log();
  console.log(`  ━━ Token category distribution ━━`);
  const sortedCats = Object.entries(s.categoryBreakdown).sort((a,b) => b[1] - a[1]);
  for (const [cat, count] of sortedCats) {
    console.log(`    ${cat.padEnd(16)} ${String(count).padStart(6)} (${(count/N_TRADES*100).toFixed(1)}%)`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Базовая модель — реалистичное распределение pump.fun
// ═══════════════════════════════════════════════════════════════════════════

const BASE_UNIVERSE = {
  rugRate: 0.05,        // 5% rug (real data: 1/18 = 5.6%)
  dumpRate: 0.25,       // 25% immediate dump (half flat, half SL)
  flatRate: 0.35,       // 35% flat (real data: 8/18 flat losses = 44% with creator_sell panic)
};

const REAL_COSTS = {
  protocolFeePct: 0.02,      // pump.fun 1% buy + 1% sell = 2%
  jitoTipSol: 0.0001,        // minTipAmountSol
  prioritySol: 0.00001,      // 200k CU × 50k microLamports = 0.00001 SOL
};

// ═══════════════════════════════════════════════════════════════════════════
// Конфиги
// ═══════════════════════════════════════════════════════════════════════════

const CURRENT: SimConfig = {
  name: '🔴 ТЕКУЩИЙ конфиг (baseline — real data: WR 33%, EV +0.0006 SOL)',
  entryAmountSol: 0.07,
  stopLossPercent: 12,
  trailingActivation: 25,
  trailingDrawdown: 7,
  runnerActivation: 100,
  runnerDrawdown: 25,
  takeProfit: [
    { level: 35, portion: 0.15 },
    { level: 80, portion: 0.20 },
    { level: 250, portion: 0.15 },
    { level: 700, portion: 0.10 },
  ],
  ...REAL_COSTS,
  creatorSellImmediate: true,
  creatorSellMinDropPct: 0,
  stagnationWindowMs: 35_000,
  ...BASE_UNIVERSE,
  tradesPerDay: 15,
};

// Вариант 1: Снизить TP1 с 35% до 18% — TP1 станет достижимым
const V1_LOWER_TP1: SimConfig = {
  ...CURRENT,
  name: '🟡 V1: TP1 35→18% (TP1 становится достижимым)',
  takeProfit: [
    { level: 18, portion: 0.20 },
    { level: 60, portion: 0.20 },
    { level: 200, portion: 0.15 },
    { level: 600, portion: 0.10 },
  ],
};

// Вариант 2: Creator_sell требует реального падения
const V2_SMART_CREATOR: SimConfig = {
  ...CURRENT,
  name: '🟡 V2: Creator-sell only if price drops >3% (устраняет flat panic-exits)',
  creatorSellImmediate: true,
  creatorSellMinDropPct: 3,
};

// Вариант 3: Объединённый — TP1 18% + smart creator_sell
const V3_COMBINED: SimConfig = {
  ...CURRENT,
  name: '🟢 V3: TP1 18% + smart creator_sell (>3%)',
  takeProfit: [
    { level: 18, portion: 0.20 },
    { level: 60, portion: 0.20 },
    { level: 200, portion: 0.15 },
    { level: 600, portion: 0.10 },
  ],
  creatorSellImmediate: true,
  creatorSellMinDropPct: 3,
};

// Вариант 4: Агрессивный TP1 — больше портион в первом TP
const V4_AGGRESSIVE_TP1: SimConfig = {
  ...V3_COMBINED,
  name: '🟢 V4: V3 + агрессивный TP1 portion 0.20→0.30 (secure profit early)',
  takeProfit: [
    { level: 18, portion: 0.30 },
    { level: 60, portion: 0.20 },
    { level: 200, portion: 0.15 },
    { level: 600, portion: 0.10 },
  ],
};

// Вариант 5: Кумулятивно — всё + увеличение entry до 0.10 SOL
const V5_LARGER_ENTRY: SimConfig = {
  ...V4_AGGRESSIVE_TP1,
  name: '🟢 V5: V4 + entry 0.07→0.10 SOL (меньше % overhead)',
  entryAmountSol: 0.10,
};

// Вариант 6: Консервативный — TP1 15% portion 0.40
const V6_CONSERVATIVE: SimConfig = {
  ...CURRENT,
  name: '🟢 V6: Консервативный — TP1 15%×40% + smart creator + SL 10%',
  stopLossPercent: 10,
  creatorSellImmediate: true,
  creatorSellMinDropPct: 3,
  takeProfit: [
    { level: 15, portion: 0.40 },
    { level: 60, portion: 0.20 },
    { level: 200, portion: 0.10 },
    { level: 600, portion: 0.10 },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// Запуск
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n╔═══════════════════════════════════════════════════════════════════════╗');
console.log('║  EV Monte Carlo Simulation v2 — Sniper Bot (real-data calibrated)    ║');
console.log(`║  ${N_TRADES.toLocaleString().padEnd(69)} ║`);
console.log(`║  trades/config                                                        ║`);
console.log('╚═══════════════════════════════════════════════════════════════════════╝');

const configs = [CURRENT, V1_LOWER_TP1, V2_SMART_CREATOR, V3_COMBINED, V4_AGGRESSIVE_TP1, V5_LARGER_ENTRY, V6_CONSERVATIVE];
const allStats: { cfg: SimConfig; stats: SimStats }[] = [];

for (const cfg of configs) {
  const stats = runSim(cfg);
  allStats.push({ cfg, stats });
}

// Сводная таблица
console.log('\n\n' + '═'.repeat(115));
console.log('  📊 СВОДНАЯ ТАБЛИЦА');
console.log('═'.repeat(115));
console.log('  Вариант                                                      │  WR  │ BE-WR │ EV/trade   │ PF  │ Daily EV │ Monthly EV');
console.log('  ─────────────────────────────────────────────────────────────┼──────┼───────┼────────────┼─────┼──────────┼──────────');
for (const { cfg, stats: s } of allStats) {
  const label = cfg.name.slice(0, 62).padEnd(62);
  const wr    = `${(s.wr*100).toFixed(1)}%`.padStart(5);
  const bewr  = `${(s.breakevenWr*100).toFixed(1)}%`.padStart(6);
  const ev    = `${s.evPerTrade>=0?'+':''}${s.evPerTrade.toFixed(5)}`.padStart(10);
  const pf    = s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2);
  const daily = `${s.dailyEv>=0?'+':''}${s.dailyEv.toFixed(4)}`.padStart(9);
  const month = `${s.monthlyEv>=0?'+':''}${s.monthlyEv.toFixed(3)}`.padStart(9);
  const flag  = s.evPerTrade > 0 && s.profitFactor > 1.3 ? '✅' : s.evPerTrade > 0 ? '⚠️ ' : '❌';
  console.log(`  ${label} │ ${wr} │ ${bewr} │ ${ev} │ ${pf.padStart(3)} │ ${daily} │ ${month}  ${flag}`);
}
console.log();

// Stress test: что если WR упадёт?
console.log('\n' + '═'.repeat(90));
console.log('  🧪 STRESS TEST: устойчивость при разных dumpRate (hard days)');
console.log('═'.repeat(90));
const bestCfg = allStats.sort((a,b) => b.stats.evPerTrade - a.stats.evPerTrade)[0];
console.log(`  Best config: ${bestCfg.cfg.name}`);
console.log();
console.log('  Dump rate   │ WR     │ EV/trade    │ Monthly EV │ Status');
console.log('  ────────────┼────────┼─────────────┼────────────┼────────');
for (const dumpRate of [0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.50]) {
  const stressCfg = { ...bestCfg.cfg, dumpRate, flatRate: Math.max(0.15, 0.6 - dumpRate) };
  const s = runSim(stressCfg, false);
  const status = s.evPerTrade > 0.0005 ? '✅ robust' : s.evPerTrade > 0 ? '⚠️  marginal' : '❌ negative';
  console.log(`  ${(dumpRate*100).toFixed(0).padStart(2)}%         │ ${(s.wr*100).toFixed(1).padStart(5)}% │ ${s.evPerTrade>=0?'+':''}${s.evPerTrade.toFixed(5)} SOL │ ${s.monthlyEv>=0?'+':''}${s.monthlyEv.toFixed(3).padStart(7)} SOL │ ${status}`);
}
console.log();
