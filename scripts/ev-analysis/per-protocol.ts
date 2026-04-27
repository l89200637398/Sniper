#!/usr/bin/env ts-node
/**
 * scripts/ev-analysis/per-protocol.ts
 *
 * Per-protocol EV simulation with protocol-specific cost structures.
 * Honest note: ONLY pump.fun has real data (18 trades); others are theoretical.
 */

const N = 50_000;

interface ProtocolSpec {
  name: string;
  entry: number;
  protocolFee: number;       // roundtrip fee (buy + sell)
  slPct: number;
  trailAct: number;
  trailDrawdown: number;
  runnerAct: number;
  runnerDrawdown: number;
  tps: { level: number; portion: number }[];
  // Market dynamics (protocol-specific)
  rugRate: number;           // rug probability
  dumpRate: number;          // immediate dump rate
  flatRate: number;          // flat/dead rate
  hasCreatorSell: boolean;   // does bot detect creator_sell for this protocol?
  creatorSellFreq: number;   // how often creator sells trigger exit (real data pump.fun: 50%)
  creatorSellMinDrop: number;  // applied only if hasCreatorSell=true
}

function sample(rug: number, dump: number, flat: number) {
  const r = Math.random();
  let c = rug;
  if (r < c) return { peak: Math.random() * 2, rug: true };
  c += dump * 0.5;
  if (r < c) return { peak: Math.random() * 5, rug: false };
  c += flat + dump * 0.5;
  if (r < c) return { peak: Math.random() * 10, rug: false };
  const n = (r - c) / (1 - c);
  if (n < 0.50) return { peak: 10 + Math.random() * 20, rug: false };
  if (n < 0.75) return { peak: 30 + Math.random() * 70, rug: false };
  if (n < 0.90) return { peak: 100 + Math.random() * 200, rug: false };
  if (n < 0.97) return { peak: 300 + Math.random() * 700, rug: false };
  return { peak: 1000 + Math.random() * 4000, rug: false };
}

function simTrade(o: { peak: number; rug: boolean }, p: ProtocolSpec): number {
  const overhead = p.entry * p.protocolFee + 0.0001 * 2 + 0.00001 * 2;
  if (o.rug) {
    const roll = Math.random();
    const pct = roll < 0.5 ? 1.0 : roll < 0.8 ? 0.7 : 0.4;
    return -p.entry * pct - overhead * 0.5;
  }
  if (p.hasCreatorSell && Math.random() < p.creatorSellFreq) {
    const price = Math.random() * Math.min(o.peak, 10);
    if (Math.abs(price) >= p.creatorSellMinDrop || price <= -p.creatorSellMinDrop) {
      return p.entry * price / 100 - overhead;
    }
  }
  const peak = o.peak;
  if (peak < p.slPct / 2) {
    return -p.entry * p.slPct * (1 + Math.random() * 0.5) / 100 - overhead;
  }
  if (peak < p.trailAct) {
    const ex = peak * (0.3 + Math.random() * 0.4);
    if (ex < -p.slPct) return -p.entry * p.slPct / 100 - overhead;
    return p.entry * ex / 100 - overhead;
  }
  let rem = 1.0, pct = 0, tps = 0;
  for (const tp of p.tps) {
    if (peak >= tp.level) { pct += tp.portion * tp.level; rem -= tp.portion; tps++; }
  }
  const isRun = peak >= p.runnerAct;
  const dd = isRun ? p.runnerDrawdown : p.trailDrawdown;
  let ex = peak - dd;
  if (tps > 0) ex = Math.max(0, ex);
  pct += rem * ex;
  return p.entry * pct / 100 - overhead;
}

function simulate(p: ProtocolSpec): { ev: number; wr: number; pf: number } {
  let w = 0, ws = 0, ls = 0, t = 0;
  for (let i = 0; i < N; i++) {
    const pnl = simTrade(sample(p.rugRate, p.dumpRate, p.flatRate), p);
    t += pnl;
    if (pnl > 0) { w++; ws += pnl; } else { ls -= pnl; }
  }
  return { ev: t / N, wr: w / N, pf: ls ? ws / ls : Infinity };
}

// ═══════════════════════════════════════════════════════════════════════════
// Per-protocol configs — mirror src/config.ts with realistic market params
// ═══════════════════════════════════════════════════════════════════════════

const PROTOCOLS = {
  pumpfun_before: {
    name: 'pump.fun (ДО fix)',
    entry: 0.07, protocolFee: 0.02,
    slPct: 12, trailAct: 25, trailDrawdown: 7, runnerAct: 100, runnerDrawdown: 25,
    tps: [{level:35,portion:0.15},{level:80,portion:0.20},{level:250,portion:0.15},{level:700,portion:0.10}],
    rugRate: 0.05, dumpRate: 0.25, flatRate: 0.35,
    hasCreatorSell: true, creatorSellFreq: 0.50, creatorSellMinDrop: 0,
  } as ProtocolSpec,

  pumpfun_after: {
    name: 'pump.fun (ПОСЛЕ fix=5%)',
    entry: 0.07, protocolFee: 0.02,
    slPct: 12, trailAct: 25, trailDrawdown: 7, runnerAct: 100, runnerDrawdown: 25,
    tps: [{level:35,portion:0.15},{level:80,portion:0.20},{level:250,portion:0.15},{level:700,portion:0.10}],
    rugRate: 0.05, dumpRate: 0.25, flatRate: 0.35,
    hasCreatorSell: true, creatorSellFreq: 0.50, creatorSellMinDrop: 5,
  } as ProtocolSpec,

  pumpswap_before: {
    name: 'PumpSwap (ДО fix)',
    entry: 0.07, protocolFee: 0.025,  // ~1.25% each side
    slPct: 15, trailAct: 30, trailDrawdown: 10, runnerAct: 200, runnerDrawdown: 25,
    tps: [{level:40,portion:0.15},{level:100,portion:0.20},{level:300,portion:0.15},{level:900,portion:0.10}],
    // PumpSwap = migrated tokens → established, less rug, less panic creator_sell
    rugRate: 0.02, dumpRate: 0.18, flatRate: 0.30,
    hasCreatorSell: true, creatorSellFreq: 0.25, creatorSellMinDrop: 0,
  } as ProtocolSpec,

  pumpswap_after: {
    name: 'PumpSwap (ПОСЛЕ fix=5%)',
    entry: 0.07, protocolFee: 0.025,
    slPct: 15, trailAct: 30, trailDrawdown: 10, runnerAct: 200, runnerDrawdown: 25,
    tps: [{level:40,portion:0.15},{level:100,portion:0.20},{level:300,portion:0.15},{level:900,portion:0.10}],
    rugRate: 0.02, dumpRate: 0.18, flatRate: 0.30,
    hasCreatorSell: true, creatorSellFreq: 0.25, creatorSellMinDrop: 5,
  } as ProtocolSpec,

  raydium_launch: {
    name: 'Raydium Launch (no creator_sell)',
    entry: 0.05, protocolFee: 0.02,  // similar to pump.fun
    slPct: 20, trailAct: 25, trailDrawdown: 12, runnerAct: 150, runnerDrawdown: 30,
    tps: [{level:30,portion:0.20},{level:100,portion:0.20},{level:300,portion:0.15},{level:700,portion:0.10}],
    // LaunchLab = graduating tokens, lower rug, typically longer life
    rugRate: 0.03, dumpRate: 0.22, flatRate: 0.30,
    hasCreatorSell: false, creatorSellFreq: 0, creatorSellMinDrop: 0,
  } as ProtocolSpec,

  raydium_cpmm: {
    name: 'Raydium CPMM (no creator_sell)',
    entry: 0.05, protocolFee: 0.005,  // 0.25% buy + 0.25% sell = 0.5%
    slPct: 20, trailAct: 35, trailDrawdown: 18, runnerAct: 200, runnerDrawdown: 30,
    tps: [{level:30,portion:0.20},{level:100,portion:0.20},{level:350,portion:0.15},{level:800,portion:0.10}],
    // Established tokens, very low rug
    rugRate: 0.01, dumpRate: 0.15, flatRate: 0.35,
    hasCreatorSell: false, creatorSellFreq: 0, creatorSellMinDrop: 0,
  } as ProtocolSpec,

  raydium_ammv4: {
    name: 'Raydium AMM v4 (no creator_sell)',
    entry: 0.05, protocolFee: 0.005,
    slPct: 20, trailAct: 35, trailDrawdown: 18, runnerAct: 200, runnerDrawdown: 30,
    tps: [{level:30,portion:0.20},{level:100,portion:0.20},{level:350,portion:0.15},{level:800,portion:0.10}],
    rugRate: 0.01, dumpRate: 0.15, flatRate: 0.35,
    hasCreatorSell: false, creatorSellFreq: 0, creatorSellMinDrop: 0,
  } as ProtocolSpec,

  mayhem: {
    name: 'Mayhem (no creator_sell, small entry)',
    entry: 0.02, protocolFee: 0.02,
    slPct: 20, trailAct: 22, trailDrawdown: 12, runnerAct: 100, runnerDrawdown: 25,
    tps: [{level:25,portion:0.40},{level:80,portion:0.35},{level:200,portion:0.25}],
    // Mayhem mode = extreme variant, high rug probability
    rugRate: 0.08, dumpRate: 0.30, flatRate: 0.35,
    hasCreatorSell: false, creatorSellFreq: 0, creatorSellMinDrop: 0,
  } as ProtocolSpec,
};

console.log('\n╔════════════════════════════════════════════════════════════════════════════════╗');
console.log(`║  Per-Protocol EV Simulation — ${N.toLocaleString()} trades/protocol                       ║`);
console.log('╚════════════════════════════════════════════════════════════════════════════════╝');

console.log('\n┌─────────────────────────────────────────┬────────┬────────┬────────────┬────────┬───────────┐');
console.log('│ Protocol                                │  WR    │  PF    │ EV/trade   │ % ent  │ Monthly*  │');
console.log('├─────────────────────────────────────────┼────────┼────────┼────────────┼────────┼───────────┤');

for (const [key, p] of Object.entries(PROTOCOLS)) {
  const r = simulate(p);
  const label = p.name.slice(0, 39).padEnd(39);
  const wr = `${(r.wr * 100).toFixed(1)}%`.padStart(5);
  const pf = r.pf === Infinity ? '  ∞  ' : r.pf.toFixed(2).padStart(5);
  const ev = `${r.ev >= 0 ? '+' : ''}${r.ev.toFixed(5)}`.padStart(10);
  const pct = `${r.ev >= 0 ? '+' : ''}${(r.ev / p.entry * 100).toFixed(2)}%`.padStart(6);
  const monthly = r.ev * 15 * 30;
  const m = `${monthly >= 0 ? '+' : ''}${monthly.toFixed(3)}`.padStart(8);
  console.log(`│ ${label} │ ${wr}  │ ${pf}  │ ${ev} │ ${pct} │  ${m}  │`);
}
console.log('└─────────────────────────────────────────┴────────┴────────┴────────────┴────────┴───────────┘');
console.log('* Monthly projection: 15 trades/day × 30 days on THIS protocol alone');

console.log('\n📝 Ключевые наблюдения:');
console.log();

// Compare pump.fun before/after
const pf_b = simulate(PROTOCOLS.pumpfun_before);
const pf_a = simulate(PROTOCOLS.pumpfun_after);
console.log(`1. pump.fun: creator_sell fix даёт +${((pf_a.ev - pf_b.ev) / pf_b.ev * 100).toFixed(0)}% к EV (+${(pf_a.ev - pf_b.ev).toFixed(5)} SOL/trade)`);

// Compare pumpswap before/after
const ps_b = simulate(PROTOCOLS.pumpswap_before);
const ps_a = simulate(PROTOCOLS.pumpswap_after);
console.log(`2. PumpSwap: creator_sell fix даёт +${((ps_a.ev - ps_b.ev) / ps_b.ev * 100).toFixed(0)}% (меньший эффект, т.к. creatorSellFreq=25% vs 50% у pump.fun)`);

console.log(`3. Raydium/Mayhem: НЕТ детекции creator_sell в коде → fix не применим, EV зависит только от SL/TP/trailing`);
console.log(`4. Raydium CPMM/AMMv4: низкие fees (0.5%) → EV +% от entry выше чем у pump.fun при тех же peak values`);

console.log('\n⚠️  ЛИМИТЫ ДОСТОВЕРНОСТИ:');
console.log('   • pump.fun: откалибровано на 18 реальных сделках ✅');
console.log('   • PumpSwap: параметры рынка (rugRate/dumpRate) — оценка по domain knowledge ⚠️');
console.log('   • Raydium Launch/CPMM/AMMv4/Mayhem: нет реальных данных, ЧИСТО ТЕОРЕТИЧЕСКИ ❌');
console.log();
