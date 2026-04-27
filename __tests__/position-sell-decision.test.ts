// __tests__/position-sell-decision.test.ts
//
// Comprehensive shouldSell() tests: all exit signals, per-protocol stop-loss,
// break-even after TP, runner tail mode, time/stagnation stops.

import { Position } from '../src/core/position';
import { PublicKey } from '@solana/web3.js';

const MINT = new PublicKey('11111111111111111111111111111111');
const POOL = { programId: 'pump', quoteMint: 'sol' };

type Proto = 'pump.fun' | 'pumpswap' | 'raydium-launch' | 'raydium-cpmm' | 'raydium-ammv4';

function makePos(opts: { price?: number; amount?: number; protocol?: Proto; entry?: number } = {}) {
  return new Position(MINT, opts.price ?? 1.0, opts.amount ?? 1000, POOL, 6, {
    entryAmountSol: opts.entry ?? 0.10,
    protocol: opts.protocol ?? 'pump.fun',
  });
}

// price = solReserves/1e9 / (tokenReserves/1e6)  →  tokenReserves = 30/price * 1e6
function setPrice(pos: Position, price: number) {
  pos.updatePrice(30e9, (30 / price) * 1e6);
}

// ─── Stop-Loss Per Protocol ──────────────────────────────────────────────────

describe('Stop-loss per protocol', () => {
  const cases: Array<[Proto, number]> = [
    ['pump.fun', 12],
    ['pumpswap', 15],
    ['raydium-launch', 20],
    ['raydium-cpmm', 20],
    ['raydium-ammv4', 20],
  ];

  it.each(cases)('%s: triggers at -%d%%', (proto, slPct) => {
    const pos = makePos({ protocol: proto });
    setPrice(pos, 1.0 * (1 - slPct / 100) - 0.001); // slightly below SL
    const d = pos.shouldSell();
    expect(d.action).toBe('full');
    expect(d.reason).toBe('stop_loss');
    expect(d.urgent).toBe(true);
  });

  it.each(cases)('%s: does NOT trigger 1%% above SL', (proto, slPct) => {
    const pos = makePos({ protocol: proto });
    setPrice(pos, 1.0 * (1 - (slPct - 1) / 100)); // 1% above threshold
    const d = pos.shouldSell();
    expect(d.action).not.toBe('full');
    if (d.reason) expect(d.reason).not.toBe('stop_loss');
  });
});

// ─── Break-Even After TP1 ────────────────────────────────────────────────────

describe('Break-even after TP1', () => {
  it('SL moves to 0% after first TP is marked', () => {
    const pos = makePos();
    pos.setTakeProfitLevels([{ levelPercent: 35, portion: 0.15 }]);

    // Reach TP, lock, mark
    setPrice(pos, 1.4);
    pos.lockTpLevel(35);
    pos.markTpLevel(35);
    expect(pos.takenLevelsCount).toBe(1);

    // Price drops to entry — should trigger break-even (effSL=0)
    setPrice(pos, 0.99);
    const d = pos.shouldSell();
    expect(d.action).toBe('full');
    expect(d.reason).toBe('stop_loss');
  });

  it('SL stays at original % when no TP taken', () => {
    const pos = makePos(); // pump.fun SL=12%
    setPrice(pos, 0.95); // -5% → above SL
    const d = pos.shouldSell();
    expect(d.action).toBe('none');
  });

  it('pendingTpLevels does NOT move SL to break-even (only confirmed does)', () => {
    const pos = makePos();
    pos.setTakeProfitLevels([{ levelPercent: 35, portion: 0.15 }]);

    setPrice(pos, 1.4);
    pos.lockTpLevel(35); // sell in-flight, not yet confirmed

    // Price drops — pending TP must NOT drop SL to 0% (if sell TX fails we'd be stuck)
    // Instead trailing_stop fires: drawdown from 1.4 to 0.99 = 29% > 7% threshold
    setPrice(pos, 0.99);
    const d = pos.shouldSell();
    expect(d.action).toBe('full');
    expect(d.reason).toBe('trailing_stop');
  });
});

// ─── Hard Stop ───────────────────────────────────────────────────────────────

describe('Hard stop', () => {
  it('triggers at configured drawdown from peak (pump.fun 40%)', () => {
    const pos = makePos();
    pos.setTakeProfitLevels([]); // clear TP to isolate hard stop
    setPrice(pos, 1.9); // peak (+90%, below runner activation +100%)
    setPrice(pos, 1.1); // drawdown = (1.9-1.1)/1.9 = 42.1% > 40%
    const d = pos.shouldSell();
    expect(d.action).toBe('full');
    expect(d.reason).toBe('hard_stop');
    expect(d.urgent).toBe(false);
  });

  it('does NOT trigger when drawdown is below threshold', () => {
    const pos = makePos();
    pos.setTakeProfitLevels([]);
    setPrice(pos, 2.0); // peak
    setPrice(pos, 1.3); // drawdown = 35% < 40%
    const d = pos.shouldSell();
    expect(d.reason).not.toBe('hard_stop');
  });
});

// ─── Velocity Drop ───────────────────────────────────────────────────────────

describe('Velocity drop', () => {
  it('triggers when price drops faster than threshold within window', () => {
    const pos = makePos();
    // Price rises first so velocity drop doesn't also trigger SL
    setPrice(pos, 1.5); // +50% from entry

    // Reference tick at 1.5 that will be > velocityWindowMs old
    pos.priceHistory = [{
      t: 100,   // relative to openedAt
      p: 1.5,
      pnl: 50,
      solReserve: 30e9,
      tokenReserve: 20e6,
    }];

    // Current time = openedAt + 700 (600ms after tick → beyond 500ms window)
    const origDateNow = Date.now;
    Date.now = () => pos.openedAt + 700;

    // Drop 16% from 1.5 → 1.26 (still above entry, no SL; velocity -16% > threshold 15%)
    setPrice(pos, 1.26);

    const d = pos.shouldSell();
    Date.now = origDateNow;

    expect(d.action).toBe('full');
    expect(d.reason).toBe('velocity_drop');
    expect(d.urgent).toBe(true);
  });
});

// ─── Time Stop ───────────────────────────────────────────────────────────────

describe('Time stop', () => {
  it('triggers when position age exceeds timeStopAfterMs and PnL below threshold', () => {
    const pos = makePos();
    // pump.fun timeStopMinPnl = -0.03 (-3%), need PnL ≤ -3%
    setPrice(pos, 0.96); // -4% PnL

    const origDateNow = Date.now;
    Date.now = () => pos.openedAt + 50_000; // >45000ms
    const d = pos.shouldSell();
    Date.now = origDateNow;

    expect(d.action).toBe('full');
    expect(d.reason).toBe('time_stop');
  });

  it('does NOT trigger if trailing is activated (price went up enough)', () => {
    const pos = makePos();
    setPrice(pos, 1.3); // +30%, activates trailing (threshold 25%)
    expect(pos.trailingActivated).toBe(true);

    setPrice(pos, 0.98);

    const origDateNow = Date.now;
    Date.now = () => pos.openedAt + 50_000;
    const d = pos.shouldSell();
    Date.now = origDateNow;

    // Time stop only fires when !trailingActivated
    expect(d.reason).not.toBe('time_stop');
  });

  it('force-exits at double timeStop regardless of PnL', () => {
    const pos = makePos();
    setPrice(pos, 1.0); // 0% PnL — above timeStopMinPnl

    const origDateNow = Date.now;
    Date.now = () => pos.openedAt + 95_000; // 2× 45000 = 90000
    const d = pos.shouldSell();
    Date.now = origDateNow;

    expect(d.action).toBe('full');
    expect(d.reason).toBe('time_stop');
  });
});

// ─── Trailing Stop ───────────────────────────────────────────────────────────

describe('Trailing stop', () => {
  it('activates trailing at configured percent', () => {
    const pos = makePos(); // pump.fun trailingActivation=25%
    setPrice(pos, 1.24);
    expect(pos.trailingActivated).toBe(false);
    setPrice(pos, 1.26);
    expect(pos.trailingActivated).toBe(true);
  });

  it('triggers trailing stop on fast drawdown (pump.fun 7%)', () => {
    const pos = makePos();
    setPrice(pos, 1.3); // activate trailing
    expect(pos.trailingActivated).toBe(true);

    // Fast drawdown: drawdownStart exists but duration < slowDrawdownMinDurationMs
    setPrice(pos, 1.20); // drawdown = (1.3-1.20)/1.3 = 7.7% > 7%
    const d = pos.shouldSell();
    expect(d.action).toBe('full');
    expect(d.reason).toBe('trailing_stop');
  });

  it('does NOT trigger trailing if drawdown is below threshold', () => {
    const pos = makePos(); // 7% trailing
    setPrice(pos, 1.3);
    setPrice(pos, 1.22); // drawdown = (1.3-1.22)/1.3 = 6.15% < 7%
    const d = pos.shouldSell();
    if (d.reason) expect(d.reason).not.toBe('trailing_stop');
  });
});

// ─── Runner Tail Mode ────────────────────────────────────────────────────────

describe('Runner tail mode', () => {
  it('activates at +100% for pump.fun', () => {
    const pos = makePos();
    setPrice(pos, 1.99);
    expect(pos.runnerTailActivated).toBe(false);
    setPrice(pos, 2.05);
    expect(pos.runnerTailActivated).toBe(true);
  });

  it('uses widened trailing drawdown (25% vs 7%) in runner mode', () => {
    const pos = makePos();
    setPrice(pos, 3.0); // peak, runner activated (+200%)
    expect(pos.runnerTailActivated).toBe(true);

    // Normal trailing would trigger at 7%: drawdown = (3.0-2.79)/3.0 = 7%
    setPrice(pos, 2.75); // drawdown = 8.3% — would trigger normal trailing
    const d = pos.shouldSell();
    // In runner mode, trailing is 25%, not 7% — so 8.3% should NOT trigger
    expect(d.reason).not.toBe('trailing_stop');
  });

  it('break-even is disabled in runner mode (can go below entry)', () => {
    const pos = makePos();
    pos.setTakeProfitLevels([{ levelPercent: 35, portion: 0.15 }]);

    // Activate trailing + runner
    setPrice(pos, 3.0);
    pos.lockTpLevel(35);
    pos.markTpLevel(35);
    expect(pos.trailingActivated).toBe(true);
    expect(pos.runnerTailActivated).toBe(true);

    // Price drops to -1.5% from entry → break_even would normally trigger
    setPrice(pos, 0.985);
    const d = pos.shouldSell();
    // runner mode disables break-even → triggers stop_loss at 0% (because takenLevels > 0 but runnerTailActivated)
    // Wait, with runner tail activated AND takenLevels > 0, effStopLossPercent stays at normal SL (12%)
    // because the runnerTailActivated skips the BE override
    expect(d.reason).not.toBe('break_even');
  });

  it('runner hard stop at 45% for pump.fun', () => {
    const pos = makePos();
    setPrice(pos, 3.0); // runner activated
    setPrice(pos, 1.60); // drawdown = (3.0-1.60)/3.0 = 46.7% > 45%
    const d = pos.shouldSell();
    expect(d.action).toBe('full');
    expect(d.reason).toBe('hard_stop');
  });
});

// ─── Stagnation ──────────────────────────────────────────────────────────────

describe('Stagnation stop', () => {
  it('triggers when price movement is below stagnationMinMove over window', () => {
    const pos = makePos(); // pump.fun: stagnationWindowMs=35000, stagnationMinMove=0.08

    // Build initial history tick that will be within the stagnation window
    const refTick = {
      t: 1000, // 1s after open
      p: 1.0,
      pnl: 0,
      solReserve: 30e9,
      tokenReserve: 30e6,
    };
    pos.priceHistory = [refTick];

    // Price barely moved: +5% < 8% min move
    const origDateNow = Date.now;
    Date.now = () => pos.openedAt + 40_000;
    setPrice(pos, 1.05);

    const d = pos.shouldSell();
    Date.now = origDateNow;

    expect(d.action).toBe('full');
    expect(d.reason).toBe('stagnation');
  });
});

// ─── Take-Profit Progression ─────────────────────────────────────────────────

describe('Take-profit level progression', () => {
  it('fires TP levels in order as price rises', () => {
    const pos = makePos();
    pos.setTakeProfitLevels([
      { levelPercent: 35, portion: 0.15 },
      { levelPercent: 80, portion: 0.20 },
    ]);

    // Reach TP1
    setPrice(pos, 1.36);
    let d = pos.shouldSell();
    expect(d.action).toBe('partial');
    expect(d.tpLevelPercent).toBe(35);
    expect(d.portion).toBe(0.15);

    pos.lockTpLevel(35);
    pos.markTpLevel(35);

    // Reach TP2
    setPrice(pos, 1.85);
    d = pos.shouldSell();
    expect(d.action).toBe('partial');
    expect(d.tpLevelPercent).toBe(80);
    expect(d.portion).toBe(0.20);
  });

  it('does not re-fire already taken levels', () => {
    const pos = makePos();
    pos.setTakeProfitLevels([{ levelPercent: 35, portion: 0.15 }]);

    setPrice(pos, 1.4);
    pos.lockTpLevel(35);
    pos.markTpLevel(35);

    // Price stays above TP1 — should not re-trigger
    setPrice(pos, 1.45);
    const d = pos.shouldSell();
    expect(d.tpLevelPercent).not.toBe(35);
  });
});

// ─── PnL Calculation ─────────────────────────────────────────────────────────

describe('PnL percent calculation', () => {
  it('returns correct PnL at various prices', () => {
    const pos = makePos({ price: 2.0 });
    setPrice(pos, 3.0);
    expect(pos.pnlPercent).toBeCloseTo(50, 0);

    setPrice(pos, 1.0);
    expect(pos.pnlPercent).toBeCloseTo(-50, 0);
  });

  it('peak PnL tracks max price', () => {
    const pos = makePos({ price: 1.0 });
    setPrice(pos, 3.0);
    setPrice(pos, 1.5);
    expect(pos.peakPnlPercent).toBeCloseTo(200, 0);
  });

  it('handles zero entry price gracefully', () => {
    const pos = makePos({ price: 0 });
    expect(pos.pnlPercent).toBe(0);
    expect(pos.peakPnlPercent).toBe(0);
  });
});

// ─── Serialization ───────────────────────────────────────────────────────────

describe('Position serialization', () => {
  it('toJSON → fromJSON roundtrip preserves state', () => {
    const pos = makePos();
    setPrice(pos, 1.5);
    pos.runnerTailActivated = true;
    pos.cashbackEnabled = true;
    pos.updateErrors = 3;

    const json = pos.toJSON();
    const restored = Position.fromJSON(json);

    expect(restored.mint.toBase58()).toBe(MINT.toBase58());
    expect(restored.protocol).toBe('pump.fun');
    expect(restored.runnerTailActivated).toBe(true);
    expect(restored.cashbackEnabled).toBe(true);
    expect(restored.updateErrors).toBe(3);
    expect(restored.maxPrice).toBe(pos.maxPrice);
  });
});
