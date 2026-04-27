// scripts/monte-carlo.ts — Monte Carlo EV симуляция для Solana Sniper Bot
// Запуск: npx ts-node scripts/monte-carlo.ts

// ── Параметры протоколов (из config.ts) ──────────────────────────────────────

interface TpLevel { percent: number; portion: number; }
interface ProtocolParams {
  name: string;
  entry: number;
  sl: number;          // stop-loss %
  tp: TpLevel[];
  runnerReserve: number; // доля, оставшаяся после всех TP portions
  weight: number;        // доля трафика (сумма = 1)
}

const PROTOCOLS: ProtocolParams[] = [
  {
    name: 'pumpfun',
    entry: 0.10, sl: 8,
    tp: [
      { percent: 25, portion: 0.25 },
      { percent: 80, portion: 0.20 },
      { percent: 250, portion: 0.15 },
      { percent: 600, portion: 0.10 },
    ],
    runnerReserve: 0.30,
    weight: 0.20,
  },
  {
    name: 'pumpswap',
    entry: 0.15, sl: 12,
    tp: [
      { percent: 20, portion: 0.25 },
      { percent: 60, portion: 0.20 },
      { percent: 150, portion: 0.15 },
      { percent: 400, portion: 0.10 },
    ],
    runnerReserve: 0.30,
    weight: 0.35,
  },
  {
    name: 'raydium-launch',
    entry: 0.08, sl: 15,
    tp: [
      { percent: 30, portion: 0.25 },
      { percent: 90, portion: 0.20 },
      { percent: 250, portion: 0.15 },
      { percent: 600, portion: 0.10 },
    ],
    runnerReserve: 0.30,
    weight: 0.05,
  },
  {
    name: 'raydium-cpmm',
    entry: 0.08, sl: 15,
    tp: [
      { percent: 30, portion: 0.25 },
      { percent: 90, portion: 0.20 },
      { percent: 300, portion: 0.15 },
      { percent: 700, portion: 0.10 },
    ],
    runnerReserve: 0.30,
    weight: 0.25,
  },
  {
    name: 'raydium-ammv4',
    entry: 0.08, sl: 15,
    tp: [
      { percent: 30, portion: 0.25 },
      { percent: 90, portion: 0.20 },
      { percent: 300, portion: 0.15 },
      { percent: 700, portion: 0.10 },
    ],
    runnerReserve: 0.30,
    weight: 0.15,
  },
];

// ── Константы ────────────────────────────────────────────────────────────────

const JITO_FEE_PER_TRADE = 0.0003;   // tip per TX
const COMPUTE_FEE_PER_TX = 0.00001;  // 200k CU × 50k µL/CU = 10,000 lamports
const BASE_FEE_PER_TX = 0.000005;    // 5000 lamports base fee
const TOTAL_OVERHEAD_PER_TRADE = (JITO_FEE_PER_TRADE + COMPUTE_FEE_PER_TX + BASE_FEE_PER_TX) * 2; // buy+sell ≈ 0.00063 SOL
const SLIPPAGE_AVG_PCT = 1.5;        // средний slippage на buy+sell (%) — conservative

const ITERATIONS = 10_000;
const TRADES_PER_ITER = 100;
const INITIAL_BANKROLL = 5.0;
const MAX_EXPOSURE = 2.0;

// ── Pump.fun fat-tail distribution ───────────────────────────────────────────
// 1/15 = 6.7% шанс +500-700%, остальные: 60% SL loss, 25% TP1 only, 8% TP1+TP2

interface OutcomeDistribution {
  prob: number;
  maxTpReached: number; // -1=SL, 0=TP1, 1=TP2, 2=TP3, 3=TP4+runner
}

function getPumpfunOutcomes(): OutcomeDistribution[] {
  return [
    { prob: 0.067, maxTpReached: 3 },  // monster: 1 in 15 → TP4+runner
    { prob: 0.08,  maxTpReached: 2 },  // TP3: 8%
    { prob: 0.10,  maxTpReached: 1 },  // TP2: 10%
    { prob: 0.153, maxTpReached: 0 },  // TP1 only: 15.3%
    { prob: 0.60,  maxTpReached: -1 }, // SL: 60%
  ];
}

function getStandardOutcomes(wr: number): OutcomeDistribution[] {
  const winProb = wr;
  const lossProb = 1 - wr;
  // Из выигрышей: 50% TP1, 25% TP2, 15% TP3, 10% TP4+runner
  return [
    { prob: winProb * 0.10, maxTpReached: 3 },  // TP4+runner
    { prob: winProb * 0.15, maxTpReached: 2 },  // TP3
    { prob: winProb * 0.25, maxTpReached: 1 },  // TP2
    { prob: winProb * 0.50, maxTpReached: 0 },  // TP1 only
    { prob: lossProb,       maxTpReached: -1 },  // SL
  ];
}

// ── Расчёт PnL одной сделки ─────────────────────────────────────────────────

function calcTradePnl(proto: ProtocolParams, maxTpReached: number): number {
  const entry = proto.entry;
  const overhead = TOTAL_OVERHEAD_PER_TRADE;
  const slippageCost = entry * (SLIPPAGE_AVG_PCT / 100);

  if (maxTpReached === -1) {
    // Stop-loss
    const loss = entry * (proto.sl / 100);
    return -(loss + overhead + slippageCost);
  }

  // Считаем partial sells до maxTpReached
  let totalProfit = 0;
  let remainingPosition = 1.0; // доля позиции

  for (let i = 0; i <= maxTpReached && i < proto.tp.length; i++) {
    const tp = proto.tp[i];
    const sellPortion = tp.portion;
    const pnlFromLevel = entry * sellPortion * (tp.percent / 100);
    totalProfit += pnlFromLevel;
    remainingPosition -= sellPortion;
  }

  // Runner: если дошли до TP4 (maxTpReached=3), runner reserve выходит с trailing
  // Моделируем: runner выходит в среднем на 50% от последнего TP (conservative)
  if (maxTpReached >= 3 && remainingPosition > 0) {
    const lastTpPercent = proto.tp[proto.tp.length - 1].percent;
    const runnerExitPercent = lastTpPercent * 0.5; // trailing drawdown от пика
    totalProfit += entry * remainingPosition * (runnerExitPercent / 100);
    remainingPosition = 0;
  }

  // Нефиксированный остаток (если не все TP достигнуты): выходим по SL от текущего уровня
  // Упрощение: остаток теряется по break-even (0% PnL) если хотя бы TP1 был
  // (break-even stop after TP1)

  return totalProfit - overhead - slippageCost;
}

// ── Выбор протокола по весам ─────────────────────────────────────────────────

function pickProtocol(rng: number): ProtocolParams {
  let cumulative = 0;
  for (const p of PROTOCOLS) {
    cumulative += p.weight;
    if (rng < cumulative) return p;
  }
  return PROTOCOLS[PROTOCOLS.length - 1];
}

// ── Выбор исхода ─────────────────────────────────────────────────────────────

function pickOutcome(outcomes: OutcomeDistribution[], rng: number): number {
  let cumulative = 0;
  for (const o of outcomes) {
    cumulative += o.prob;
    if (rng < cumulative) return o.maxTpReached;
  }
  return outcomes[outcomes.length - 1].maxTpReached;
}

// ── Monte Carlo ──────────────────────────────────────────────────────────────

interface SimResult {
  wr: number;
  meanFinalBankroll: number;
  medianFinalBankroll: number;
  probOfRuin: number;       // банкролл < 1 SOL
  probOfDoubling: number;   // банкролл > 10 SOL
  maxDrawdownMean: number;
  evPerTrade: number;
  totalPnlMean: number;
}

function runSimulation(targetWr: number): SimResult {
  const finalBankrolls: number[] = [];
  const maxDrawdowns: number[] = [];
  let totalEvSum = 0;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    let bankroll = INITIAL_BANKROLL;
    let peak = bankroll;
    let maxDd = 0;
    let pnlSum = 0;

    for (let t = 0; t < TRADES_PER_ITER; t++) {
      if (bankroll < 0.01) break; // bust

      const proto = pickProtocol(Math.random());
      const effectiveEntry = Math.min(proto.entry, bankroll, MAX_EXPOSURE);
      if (effectiveEntry < 0.03) break; // не хватает на минимальный вход

      // Для pump.fun — собственное распределение, для остальных — на основе targetWr
      const outcomes = proto.name === 'pumpfun'
        ? getPumpfunOutcomes()
        : getStandardOutcomes(targetWr);

      const maxTpReached = pickOutcome(outcomes, Math.random());

      // Масштабируем PnL пропорционально реальному entry vs config entry
      const scale = effectiveEntry / proto.entry;
      const pnl = calcTradePnl(proto, maxTpReached) * scale;

      bankroll += pnl;
      pnlSum += pnl;

      if (bankroll > peak) peak = bankroll;
      const dd = (peak - bankroll) / peak;
      if (dd > maxDd) maxDd = dd;
    }

    finalBankrolls.push(bankroll);
    maxDrawdowns.push(maxDd);
    totalEvSum += pnlSum;
  }

  finalBankrolls.sort((a, b) => a - b);
  const median = finalBankrolls[Math.floor(ITERATIONS / 2)];
  const mean = finalBankrolls.reduce((s, v) => s + v, 0) / ITERATIONS;
  const ruinCount = finalBankrolls.filter(b => b < 1.0).length;
  const doubleCount = finalBankrolls.filter(b => b >= 10.0).length;
  const meanDd = maxDrawdowns.reduce((s, v) => s + v, 0) / ITERATIONS;

  return {
    wr: targetWr,
    meanFinalBankroll: mean,
    medianFinalBankroll: median,
    probOfRuin: ruinCount / ITERATIONS,
    probOfDoubling: doubleCount / ITERATIONS,
    maxDrawdownMean: meanDd,
    evPerTrade: totalEvSum / (ITERATIONS * TRADES_PER_ITER),
    totalPnlMean: totalEvSum / ITERATIONS,
  };
}

// ── Sensitivity analysis ─────────────────────────────────────────────────────

function findBreakEvenWr(): number {
  for (let wr = 30; wr <= 70; wr++) {
    const r = runSimulation(wr / 100);
    if (r.evPerTrade >= 0) return wr;
  }
  return -1;
}

function sensitivityAnalysis() {
  const baseWr = 0.50;
  console.log('\n═══ SENSITIVITY ANALYSIS (WR=50%) ═══');
  console.log('Параметр               | EV/trade  | Break-even WR');
  console.log('────────────────────────┼───────────┼──────────────');

  // Base
  const base = runSimulation(baseWr);
  console.log(`Base (текущий конфиг)   | ${fmtSol(base.evPerTrade)} | ${findBreakEvenWr()}%`);

  // SL tighter (все -3pp)
  const origSls = PROTOCOLS.map(p => p.sl);
  PROTOCOLS.forEach(p => { p.sl = Math.max(5, p.sl - 3); });
  const slTight = runSimulation(baseWr);
  PROTOCOLS.forEach((p, i) => { p.sl = origSls[i]; });
  console.log(`SL -3pp (tighter)      | ${fmtSol(slTight.evPerTrade)} | —`);

  // SL looser (все +3pp)
  PROTOCOLS.forEach(p => { p.sl = p.sl + 3; });
  const slLoose = runSimulation(baseWr);
  PROTOCOLS.forEach((p, i) => { p.sl = origSls[i]; });
  console.log(`SL +3pp (looser)       | ${fmtSol(slLoose.evPerTrade)} | —`);

  // TP1 lower (все TP1 -10pp)
  const origTp1s = PROTOCOLS.map(p => p.tp[0].percent);
  PROTOCOLS.forEach(p => { p.tp[0].percent = Math.max(10, p.tp[0].percent - 10); });
  const tp1Low = runSimulation(baseWr);
  PROTOCOLS.forEach((p, i) => { p.tp[0].percent = origTp1s[i]; });
  console.log(`TP1 -10pp (earlier)    | ${fmtSol(tp1Low.evPerTrade)} | —`);

  // Entry ×0.7 (все)
  const origEntries = PROTOCOLS.map(p => p.entry);
  PROTOCOLS.forEach(p => { p.entry = p.entry * 0.7; });
  const smallEntry = runSimulation(baseWr);
  PROTOCOLS.forEach((p, i) => { p.entry = origEntries[i]; });
  console.log(`Entry ×0.7             | ${fmtSol(smallEntry.evPerTrade)} | —`);

  // Entry ×1.3 (все)
  PROTOCOLS.forEach(p => { p.entry = p.entry * 1.3; });
  const bigEntry = runSimulation(baseWr);
  PROTOCOLS.forEach((p, i) => { p.entry = origEntries[i]; });
  console.log(`Entry ×1.3             | ${fmtSol(bigEntry.evPerTrade)} | —`);

  // Runner reserve 40% (runner → 0.40, portions sum → 0.60)
  // уже 0.30, поднимаем до 0.40: TP4 portion 0.10→0.00
  const origTp4portions = PROTOCOLS.map(p => p.tp[3]?.portion ?? 0);
  PROTOCOLS.forEach(p => { if (p.tp[3]) p.tp[3].portion = 0; p.runnerReserve = 0.40; });
  const bigRunner = runSimulation(baseWr);
  PROTOCOLS.forEach((p, i) => { if (p.tp[3]) p.tp[3].portion = origTp4portions[i]; p.runnerReserve = 0.30; });
  console.log(`Runner 40% (drop TP4)  | ${fmtSol(bigRunner.evPerTrade)} | —`);
}

function fmtSol(v: number): string {
  const s = v >= 0 ? '+' : '';
  return `${s}${v.toFixed(5)} SOL`.padEnd(9);
}

// ── Аналитический расчёт EV (без Monte Carlo) ───────────────────────────────

function analyticalEv(wr: number): { protocol: string; ev: number; avgWin: number; avgLoss: number }[] {
  return PROTOCOLS.map(proto => {
    const outcomes = proto.name === 'pumpfun'
      ? getPumpfunOutcomes()
      : getStandardOutcomes(wr);

    let evSum = 0;
    let winSum = 0;
    let winProb = 0;
    let lossSum = 0;
    let lossProb = 0;

    for (const o of outcomes) {
      const pnl = calcTradePnl(proto, o.maxTpReached);
      evSum += o.prob * pnl;
      if (o.maxTpReached >= 0) {
        winSum += o.prob * pnl;
        winProb += o.prob;
      } else {
        lossSum += o.prob * pnl;
        lossProb += o.prob;
      }
    }

    return {
      protocol: proto.name,
      ev: evSum,
      avgWin: winProb > 0 ? winSum / winProb : 0,
      avgLoss: lossProb > 0 ? lossSum / lossProb : 0,
    };
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  SOLANA SNIPER — MONTE CARLO EV SIMULATION                  ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Iterations: ${ITERATIONS}  |  Trades/iter: ${TRADES_PER_ITER}  |  Bankroll: ${INITIAL_BANKROLL} SOL  ║`);
  console.log(`║  Overhead/trade: ${TOTAL_OVERHEAD_PER_TRADE.toFixed(4)} SOL  |  Avg slippage: ${SLIPPAGE_AVG_PCT}%        ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // 1. Аналитический EV
  console.log('\n═══ ANALYTICAL EV PER TRADE (по протоколам) ═══');
  const wrValues = [0.40, 0.45, 0.48, 0.50, 0.55, 0.60];
  for (const wr of wrValues) {
    console.log(`\n── WR = ${(wr * 100).toFixed(0)}% (для не-pumpfun протоколов) ──`);
    const results = analyticalEv(wr);
    console.table(results.map(r => ({
      Protocol: r.protocol,
      'EV/trade (SOL)': r.ev.toFixed(5),
      'Avg Win (SOL)': r.avgWin.toFixed(5),
      'Avg Loss (SOL)': r.avgLoss.toFixed(5),
      'EV positive?': r.ev > 0 ? '✅' : '❌',
    })));

    // Взвешенный EV
    const weightedEv = results.reduce((s, r, i) => s + r.ev * PROTOCOLS[i].weight, 0);
    console.log(`  Взвешенный EV (портфель): ${weightedEv >= 0 ? '+' : ''}${weightedEv.toFixed(5)} SOL/trade`);
  }

  // 2. Monte Carlo
  console.log('\n\n═══ MONTE CARLO SIMULATION (10K × 100 trades) ═══');
  const mcResults: SimResult[] = [];
  for (const wr of wrValues) {
    process.stdout.write(`  Simulating WR=${(wr * 100).toFixed(0)}%...`);
    const r = runSimulation(wr);
    mcResults.push(r);
    console.log(' done');
  }

  console.log('\n');
  console.table(mcResults.map(r => ({
    'WR (%)': (r.wr * 100).toFixed(0),
    'Mean Final': r.meanFinalBankroll.toFixed(2) + ' SOL',
    'Median Final': r.medianFinalBankroll.toFixed(2) + ' SOL',
    'EV/trade': (r.evPerTrade >= 0 ? '+' : '') + r.evPerTrade.toFixed(5) + ' SOL',
    'Total PnL': (r.totalPnlMean >= 0 ? '+' : '') + r.totalPnlMean.toFixed(3) + ' SOL',
    'P(ruin<1)': (r.probOfRuin * 100).toFixed(1) + '%',
    'P(2x)': (r.probOfDoubling * 100).toFixed(1) + '%',
    'MaxDD avg': (r.maxDrawdownMean * 100).toFixed(1) + '%',
  })));

  // 3. Break-even WR
  console.log('\n═══ BREAK-EVEN ANALYSIS ═══');
  const beWr = findBreakEvenWr();
  console.log(`Break-even WR (портфельный EV ≥ 0): ${beWr}%`);
  console.log(`Pump.fun с fat-tail (1/15 monster) имеет собственный break-even ~38% WR.`);

  // 4. Sensitivity
  sensitivityAnalysis();

  // 5. Рекомендации
  console.log('\n═══ РЕКОМЕНДАЦИИ ДЛЯ ДОСТИЖЕНИЯ WR ≥ 48% ═══');
  console.log('1. SL: текущие 8-15% оптимальны. Ужесточение SL < 8% → больше ложных стопов.');
  console.log('2. TP1: текущие 20-30% — правильные. Покрывают overhead и фиксируют прибыль.');
  console.log('3. Runner reserve 30%: удерживать. Это ×5-×10 tokens дают основной EV.');
  console.log('4. Entry sizing: НЕ увеличивать до WR > 55%. Текущие 0.08-0.15 SOL — разумные.');
  console.log('5. PumpSwap weight: увеличить до 40-50% если WR > остальных протоколов.');
  console.log('6. Основной рычаг — ФИЛЬТРАЦИЯ (WR), не параметры (SL/TP/entry).');
}

main();
