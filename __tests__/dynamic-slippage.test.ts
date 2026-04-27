// __tests__/dynamic-slippage.test.ts
//
// Tests for computeDynamicSlippage() and computeDynamicSellSlippage().
// Verifies: formula correctness, edge cases, urgency levels, caps.

import { computeDynamicSlippage, computeDynamicSellSlippage } from '../src/config';

// ─── computeDynamicSlippage (buy side) ───────────────────────────────────────

describe('computeDynamicSlippage', () => {
  it('small entry relative to liquidity → reduced slippage', () => {
    // 0.15 SOL entry / 2 SOL liquidity → sqrt(0.075) ≈ 0.274 → 2500 * 0.274 = 685
    const result = computeDynamicSlippage(0.15, 2, 2500);
    expect(result).toBeGreaterThan(300);   // above floor
    expect(result).toBeLessThan(2500);     // below max
    expect(result).toBeCloseTo(685, -1);   // ~685 bps
  });

  it('large entry relative to liquidity → max slippage', () => {
    // 2 SOL entry / 1 SOL liquidity → ratio >= 1 → max
    const result = computeDynamicSlippage(2, 1, 2500);
    expect(result).toBe(2500);
  });

  it('zero liquidity → fallback to max slippage', () => {
    expect(computeDynamicSlippage(0.1, 0, 2500)).toBe(2500);
  });

  it('zero entry → fallback to max slippage', () => {
    expect(computeDynamicSlippage(0, 2, 2500)).toBe(2500);
  });

  it('negative liquidity → fallback to max slippage', () => {
    expect(computeDynamicSlippage(0.1, -1, 2500)).toBe(2500);
  });

  it('respects minFloorBps parameter', () => {
    // Very small entry → dynamic would be very low
    const result = computeDynamicSlippage(0.001, 100, 2500, 500);
    expect(result).toBeGreaterThanOrEqual(500);
  });

  it('default minFloorBps is 300', () => {
    const result = computeDynamicSlippage(0.001, 100, 2500);
    expect(result).toBeGreaterThanOrEqual(300);
  });

  it('formula: max(floor, maxBps * sqrt(entry/liquidity))', () => {
    const entry = 0.07;
    const liq = 5;
    const maxBps = 2000;
    const floor = 300;
    const expected = Math.max(floor, Math.ceil(maxBps * Math.sqrt(entry / liq)));
    expect(computeDynamicSlippage(entry, liq, maxBps, floor)).toBe(expected);
  });

  it('equal entry and liquidity → max slippage', () => {
    expect(computeDynamicSlippage(1.0, 1.0, 2000)).toBe(2000);
  });
});

// ─── computeDynamicSellSlippage (sell side) ──────────────────────────────────

describe('computeDynamicSellSlippage', () => {
  const baseBps = 1500;

  it('urgent sell → ×2.0, cap 3500', () => {
    const result = computeDynamicSellSlippage(baseBps, -5, true);
    expect(result).toBe(Math.min(Math.ceil(baseBps * 2.0), 3500));
  });

  it('deep loss (PnL < -10%) → same as urgent', () => {
    const result = computeDynamicSellSlippage(baseBps, -15, false);
    expect(result).toBe(Math.min(Math.ceil(baseBps * 2.0), 3500));
  });

  it('velocity_drop → ×1.8, cap 3000', () => {
    const result = computeDynamicSellSlippage(baseBps, -5, false, 'velocity_drop');
    expect(result).toBe(Math.min(Math.ceil(baseBps * 1.8), 3000));
  });

  it('hard_stop → ×1.8, cap 3000', () => {
    const result = computeDynamicSellSlippage(baseBps, -5, false, 'hard_stop');
    expect(result).toBe(Math.min(Math.ceil(baseBps * 1.8), 3000));
  });

  it('trailing_stop → ×1.5, cap 2500', () => {
    const result = computeDynamicSellSlippage(baseBps, 10, false, 'trailing_stop');
    expect(result).toBe(Math.min(Math.ceil(baseBps * 1.5), 2500));
  });

  it('stop_loss → ×1.5, cap 2500', () => {
    const result = computeDynamicSellSlippage(baseBps, -8, false, 'stop_loss');
    expect(result).toBe(Math.min(Math.ceil(baseBps * 1.5), 2500));
  });

  it('take_profit → ×1.2, cap 2000', () => {
    const result = computeDynamicSellSlippage(baseBps, 50, false, 'take_profit_1');
    expect(result).toBe(Math.min(Math.ceil(baseBps * 1.2), 2000));
  });

  it('normal exit → base slippage unchanged', () => {
    const result = computeDynamicSellSlippage(baseBps, 5, false, 'stagnation');
    expect(result).toBe(baseBps);
  });

  it('no exit reason → base slippage', () => {
    const result = computeDynamicSellSlippage(baseBps, 0, false);
    expect(result).toBe(baseBps);
  });

  // Cap verification: urgent flag always prioritized over exit reason
  it('urgent=true overrides any exit reason', () => {
    const r1 = computeDynamicSellSlippage(baseBps, 5, true, 'take_profit_1');
    const r2 = computeDynamicSellSlippage(baseBps, 5, true);
    expect(r1).toBe(r2); // both use urgent path
  });

  // Cap verification: ensure caps actually limit the output
  it('caps prevent runaway slippage with high base', () => {
    const highBase = 3000;
    expect(computeDynamicSellSlippage(highBase, -15, false)).toBeLessThanOrEqual(3500);
    expect(computeDynamicSellSlippage(highBase, -5, false, 'velocity_drop')).toBeLessThanOrEqual(3000);
    expect(computeDynamicSellSlippage(highBase, 5, false, 'trailing_stop')).toBeLessThanOrEqual(2500);
    expect(computeDynamicSellSlippage(highBase, 50, false, 'take_profit_2')).toBeLessThanOrEqual(2000);
  });
});
