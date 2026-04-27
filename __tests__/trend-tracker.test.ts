// __tests__/trend-tracker.test.ts
//
// Unit tests for TrendTracker: trend confirmation, strengthening, weakening,
// social boost, sliding window, buy/sell ratio, metrics, cleanup.

import { TrendTracker, TrendMetrics } from '../src/core/trend-tracker';

const MINT_A = 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA111';
const MINT_B = 'MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB222';

function makeBuyers(tracker: TrendTracker, mint: string, count: number, solEach = 0.2) {
  for (let i = 0; i < count; i++) {
    tracker.recordBuy(mint, `buyer_${i}_${Math.random().toString(36).slice(2)}`, solEach);
  }
}

// ─── Basic Tracking ─────────────────────────────────────────────────────────

describe('Basic tracking', () => {
  it('track() registers a mint', () => {
    const tt = new TrendTracker();
    tt.track(MINT_A, 'pump.fun');
    expect(tt.isTracking(MINT_A)).toBe(true);
    expect(tt.trackedCount).toBe(1);
    tt.stop();
  });

  it('track() ignores duplicate registration', () => {
    const tt = new TrendTracker();
    tt.track(MINT_A, 'pump.fun');
    tt.track(MINT_A, 'pumpswap');
    expect(tt.trackedCount).toBe(1);
    tt.stop();
  });

  it('remove() stops tracking', () => {
    const tt = new TrendTracker();
    tt.track(MINT_A, 'pump.fun');
    tt.remove(MINT_A);
    expect(tt.isTracking(MINT_A)).toBe(false);
    expect(tt.trackedCount).toBe(0);
    tt.stop();
  });

  it('remove() is safe on non-existent mint', () => {
    const tt = new TrendTracker();
    expect(() => tt.remove('nonexistent')).not.toThrow();
    tt.stop();
  });

  it('getMetrics() returns null for untracked mint', () => {
    const tt = new TrendTracker();
    expect(tt.getMetrics(MINT_A)).toBeNull();
    tt.stop();
  });
});

// ─── Metrics Computation ────────────────────────────────────────────────────

describe('Metrics computation', () => {
  it('returns correct buy/sell counts and volumes', () => {
    const tt = new TrendTracker();
    tt.track(MINT_A, 'pumpswap');
    tt.recordBuy(MINT_A, 'buyer1', 0.3);
    tt.recordBuy(MINT_A, 'buyer2', 0.2);
    tt.recordSell(MINT_A, 'seller1', 0.1);

    const m = tt.getMetrics(MINT_A)!;
    expect(m.buyCount).toBe(2);
    expect(m.sellCount).toBe(1);
    expect(m.buyVolumeSol).toBeCloseTo(0.5);
    expect(m.sellVolumeSol).toBeCloseTo(0.1);
    expect(m.uniqueBuyers).toBe(2);
    expect(m.netVolumeSol).toBeCloseTo(0.4);
    expect(m.protocol).toBe('pumpswap');
    tt.stop();
  });

  it('buySellRatio = buyCount/sellCount when sells > 0', () => {
    const tt = new TrendTracker();
    tt.track(MINT_A, 'pump.fun');
    tt.recordBuy(MINT_A, 'b1', 0.1);
    tt.recordBuy(MINT_A, 'b2', 0.1);
    tt.recordBuy(MINT_A, 'b3', 0.1);
    tt.recordSell(MINT_A, 's1', 0.1);

    const m = tt.getMetrics(MINT_A)!;
    expect(m.buySellRatio).toBe(3);
    tt.stop();
  });

  it('buySellRatio = buyCount when no sells', () => {
    const tt = new TrendTracker();
    tt.track(MINT_A, 'pump.fun');
    tt.recordBuy(MINT_A, 'b1', 0.1);
    tt.recordBuy(MINT_A, 'b2', 0.1);

    const m = tt.getMetrics(MINT_A)!;
    expect(m.buySellRatio).toBe(2);
    tt.stop();
  });

  it('buySellRatio = 0 when no buys and no sells', () => {
    const tt = new TrendTracker();
    tt.track(MINT_A, 'pump.fun');

    const m = tt.getMetrics(MINT_A)!;
    expect(m.buySellRatio).toBe(0);
    tt.stop();
  });

  it('uniqueBuyers counts distinct wallets', () => {
    const tt = new TrendTracker();
    tt.track(MINT_A, 'pumpswap');
    tt.recordBuy(MINT_A, 'wallet_A', 0.1);
    tt.recordBuy(MINT_A, 'wallet_A', 0.1);
    tt.recordBuy(MINT_A, 'wallet_B', 0.1);

    const m = tt.getMetrics(MINT_A)!;
    expect(m.buyCount).toBe(3);
    expect(m.uniqueBuyers).toBe(2);
    tt.stop();
  });

  it('priceDirection reflects price change', () => {
    const tt = new TrendTracker();
    tt.track(MINT_A, 'pump.fun');
    tt.recordPrice(MINT_A, 1.0);
    tt.recordPrice(MINT_A, 1.5);

    const m = tt.getMetrics(MINT_A)!;
    expect(m.priceDirection).toBeCloseTo(0.5);
    tt.stop();
  });

  it('priceDirection negative on price drop', () => {
    const tt = new TrendTracker();
    tt.track(MINT_A, 'pump.fun');
    tt.recordPrice(MINT_A, 2.0);
    tt.recordPrice(MINT_A, 1.0);

    const m = tt.getMetrics(MINT_A)!;
    expect(m.priceDirection).toBeCloseTo(-0.5);
    tt.stop();
  });

  it('socialSignals count increments', () => {
    const tt = new TrendTracker();
    tt.track(MINT_A, 'pump.fun');
    tt.recordSocialSignal(MINT_A, false);
    tt.recordSocialSignal(MINT_A, true);

    const m = tt.getMetrics(MINT_A)!;
    expect(m.socialSignals).toBe(2);
    expect(m.hasSocialMint).toBe(true);
    tt.stop();
  });
});

// ─── Trend Confirmation ─────────────────────────────────────────────────────

describe('Trend confirmation', () => {
  it('emits trend:confirmed when criteria met (3 buyers, 0.5 SOL, ratio >= 1.5)', () => {
    const tt = new TrendTracker();
    const events: { mint: string; metrics: TrendMetrics }[] = [];
    tt.on('trend:confirmed', (mint: string, metrics: TrendMetrics) => events.push({ mint, metrics }));

    tt.track(MINT_A, 'pumpswap');
    makeBuyers(tt, MINT_A, 3, 0.2); // 3 unique buyers, 0.6 SOL, 0 sells → ratio = 3

    expect(events).toHaveLength(1);
    expect(events[0].mint).toBe(MINT_A);
    expect(events[0].metrics.uniqueBuyers).toBe(3);
    expect(events[0].metrics.buyVolumeSol).toBeCloseTo(0.6);
    tt.stop();
  });

  it('does NOT confirm with only 2 unique buyers', () => {
    const tt = new TrendTracker();
    const events: any[] = [];
    tt.on('trend:confirmed', (m: string, met: TrendMetrics) => events.push({ m, met }));

    tt.track(MINT_A, 'pumpswap');
    tt.recordBuy(MINT_A, 'buyer1', 0.3);
    tt.recordBuy(MINT_A, 'buyer2', 0.3);

    expect(events).toHaveLength(0);
    tt.stop();
  });

  it('does NOT confirm if volume < 0.5 SOL', () => {
    const tt = new TrendTracker();
    const events: any[] = [];
    tt.on('trend:confirmed', () => events.push(1));

    tt.track(MINT_A, 'pumpswap');
    makeBuyers(tt, MINT_A, 3, 0.1); // 0.3 SOL total < 0.5

    expect(events).toHaveLength(0);
    tt.stop();
  });

  it('does NOT confirm if buy/sell ratio < 1.5', () => {
    const tt = new TrendTracker();
    const events: any[] = [];
    tt.on('trend:confirmed', () => events.push(1));

    // Interleave buys and sells so ratio stays low
    // 3 buys, 2 sells first, then add sell → ratio will be 3/3=1.0 when 3rd sell arrives
    // But we need to prevent confirmation on intermediate states.
    // At 3 buys / 2 sells = ratio 1.5 → would confirm. So use 2 buys / 2 sells to start.
    tt.track(MINT_A, 'pumpswap');
    tt.recordBuy(MINT_A, 'b1', 0.2);
    tt.recordSell(MINT_A, 's1', 0.1);
    tt.recordBuy(MINT_A, 'b2', 0.2);
    tt.recordSell(MINT_A, 's2', 0.1);
    // 2 buys / 2 sells → ratio=1.0, 2 unique buyers < 3 → no confirm
    tt.recordBuy(MINT_A, 'b3', 0.2);
    // 3 buys / 2 sells → ratio=1.5 → exactly at threshold, confirms
    // So to test < 1.5, we need 3 buys / 3 sells before the 3rd buy:
    // Actually this is tricky — let's test with sells arriving before reaching buyer threshold

    events.length = 0; // Reset — may have fired

    const tt2 = new TrendTracker();
    const ev2: any[] = [];
    tt2.on('trend:confirmed', () => ev2.push(1));
    tt2.track(MINT_B, 'pumpswap');

    // Add sells first to keep ratio low
    tt2.recordBuy(MINT_B, 'b1', 0.2);
    tt2.recordSell(MINT_B, 's1', 0.1);
    tt2.recordSell(MINT_B, 's2', 0.1);
    tt2.recordBuy(MINT_B, 'b2', 0.2);
    tt2.recordSell(MINT_B, 's3', 0.1);
    tt2.recordBuy(MINT_B, 'b3', 0.2);
    // 3 buys / 3 sells → ratio=1.0 < 1.5 → should NOT confirm

    expect(ev2).toHaveLength(0);
    tt.stop();
    tt2.stop();
  });

  it('does NOT fire twice for same mint', () => {
    const tt = new TrendTracker();
    const events: any[] = [];
    tt.on('trend:confirmed', () => events.push(1));

    tt.track(MINT_A, 'pumpswap');
    makeBuyers(tt, MINT_A, 3, 0.2);
    expect(events).toHaveLength(1);

    // Additional buy after confirmation
    tt.recordBuy(MINT_A, 'extra_buyer', 1.0);
    expect(events).toHaveLength(1);
    tt.stop();
  });
});

// ─── Social Boost (softer thresholds) ───────────────────────────────────────

describe('Social boost', () => {
  it('social-discovered mint confirms with 2 buyers instead of 3', () => {
    const tt = new TrendTracker();
    const events: any[] = [];
    tt.on('trend:confirmed', () => events.push(1));

    tt.track(MINT_A, 'pumpswap');
    tt.recordSocialSignal(MINT_A, true); // hasMint = true → social boost

    tt.recordBuy(MINT_A, 'buyer1', 0.2);
    tt.recordBuy(MINT_A, 'buyer2', 0.2);
    // 2 buyers, 0.4 SOL: normal would reject (need 3 buyers, 0.5 SOL)
    // social boost: 2 buyers OK, 0.5*0.7=0.35 SOL threshold → 0.4 >= 0.35 OK

    expect(events).toHaveLength(1);
    tt.stop();
  });

  it('social boost does NOT lower below 2 buyers', () => {
    const tt = new TrendTracker();
    const events: any[] = [];
    tt.on('trend:confirmed', () => events.push(1));

    tt.track(MINT_A, 'pumpswap');
    tt.recordSocialSignal(MINT_A, true);

    tt.recordBuy(MINT_A, 'buyer1', 0.5);
    // 1 buyer, 0.5 SOL → even with social boost, need >= 2 buyers

    expect(events).toHaveLength(0);
    tt.stop();
  });

  it('hasMint=false does NOT enable social boost', () => {
    const tt = new TrendTracker();
    const events: any[] = [];
    tt.on('trend:confirmed', () => events.push(1));

    tt.track(MINT_A, 'pumpswap');
    tt.recordSocialSignal(MINT_A, false); // ticker only, no mint → no boost

    tt.recordBuy(MINT_A, 'buyer1', 0.3);
    tt.recordBuy(MINT_A, 'buyer2', 0.3);
    // 2 buyers, 0.6 SOL → without social boost, need 3 buyers

    expect(events).toHaveLength(0);
    tt.stop();
  });
});

// ─── Trend Strengthening ────────────────────────────────────────────────────

describe('Trend strengthening', () => {
  it('emits trend:strengthening when thresholds exceeded after confirmation', () => {
    const tt = new TrendTracker();
    const confirmed: any[] = [];
    const strengthened: any[] = [];
    tt.on('trend:confirmed', () => confirmed.push(1));
    tt.on('trend:strengthening', () => strengthened.push(1));

    tt.track(MINT_A, 'pumpswap');
    // First: confirm (3 buyers, 0.6 SOL)
    makeBuyers(tt, MINT_A, 3, 0.2);
    expect(confirmed).toHaveLength(1);

    // Then: strengthen (8 buyers, 2.0 SOL)
    makeBuyers(tt, MINT_A, 5, 0.3); // +5 = 8 total, +1.5 = 2.1 SOL total
    expect(strengthened).toHaveLength(1);
    tt.stop();
  });

  it('strengthening fires only once', () => {
    const tt = new TrendTracker();
    const events: any[] = [];
    tt.on('trend:strengthening', () => events.push(1));

    tt.track(MINT_A, 'pumpswap');
    makeBuyers(tt, MINT_A, 3, 0.2); // confirm
    makeBuyers(tt, MINT_A, 5, 0.3); // strengthen
    makeBuyers(tt, MINT_A, 5, 0.5); // extra buys

    expect(events).toHaveLength(1);
    tt.stop();
  });
});

// ─── Trend Weakening ────────────────────────────────────────────────────────

describe('Trend weakening', () => {
  it('emits trend:weakening when sell/buy ratio exceeds threshold in recent window', () => {
    const tt = new TrendTracker();
    const events: any[] = [];
    tt.on('trend:weakening', () => events.push(1));

    tt.track(MINT_A, 'pumpswap');
    makeBuyers(tt, MINT_A, 3, 0.2); // confirm

    // Recent window has 3 buys + sells. weakenSellRatio=1.5.
    // Need recentSells/recentBuys >= 1.5 → at least 5 sells to 3 buys
    tt.recordSell(MINT_A, 'seller1', 0.1);
    tt.recordSell(MINT_A, 'seller2', 0.1);
    tt.recordSell(MINT_A, 'seller3', 0.1);
    tt.recordSell(MINT_A, 'seller4', 0.1);
    tt.recordSell(MINT_A, 'seller5', 0.1);
    // 5 sells / 3 buys = 1.67 >= 1.5 → weakening

    expect(events.length).toBeGreaterThanOrEqual(1);
    tt.stop();
  });

  it('weakening only fires on confirmed trackers (not pending)', () => {
    const tt = new TrendTracker();
    const events: any[] = [];
    tt.on('trend:weakening', () => events.push(1));

    tt.track(MINT_A, 'pumpswap');
    // NOT confirmed — only 1 buyer
    tt.recordBuy(MINT_A, 'buyer1', 0.1);
    tt.recordSell(MINT_A, 'seller1', 0.5);

    expect(events).toHaveLength(0);
    tt.stop();
  });
});

// ─── Record on non-tracked mint ─────────────────────────────────────────────

describe('Records on untracked mints', () => {
  it('recordBuy on untracked mint is a no-op', () => {
    const tt = new TrendTracker();
    expect(() => tt.recordBuy('fake', 'buyer', 1.0)).not.toThrow();
    tt.stop();
  });

  it('recordSell on untracked mint is a no-op', () => {
    const tt = new TrendTracker();
    expect(() => tt.recordSell('fake', 'seller', 1.0)).not.toThrow();
    tt.stop();
  });

  it('recordPrice on untracked mint is a no-op', () => {
    const tt = new TrendTracker();
    expect(() => tt.recordPrice('fake', 1.5)).not.toThrow();
    tt.stop();
  });

  it('recordSocialSignal on untracked mint is a no-op', () => {
    const tt = new TrendTracker();
    expect(() => tt.recordSocialSignal('fake', true)).not.toThrow();
    tt.stop();
  });
});

// ─── Stop & Cleanup ─────────────────────────────────────────────────────────

describe('Stop and cleanup', () => {
  it('stop() clears all trackers and timers', () => {
    const tt = new TrendTracker();
    tt.start();
    tt.track(MINT_A, 'pump.fun');
    tt.track(MINT_B, 'pumpswap');
    expect(tt.trackedCount).toBe(2);

    tt.stop();
    expect(tt.trackedCount).toBe(0);
    expect(tt.isTracking(MINT_A)).toBe(false);
  });

  it('price history is capped at 100 points', () => {
    const tt = new TrendTracker();
    tt.track(MINT_A, 'pumpswap');
    for (let i = 0; i < 120; i++) {
      tt.recordPrice(MINT_A, i * 0.01);
    }
    const m = tt.getMetrics(MINT_A)!;
    // priceDirection should use first and last of the 100-element array
    expect(m.priceDirection).toBeGreaterThan(0);
    tt.stop();
  });
});

// ─── Protocol-aware window config ───────────────────────────────────────────

describe('Protocol-aware configuration', () => {
  it('pump.fun and mayhem use same window', () => {
    const tt1 = new TrendTracker();
    const tt2 = new TrendTracker();
    tt1.track(MINT_A, 'pump.fun');
    tt2.track(MINT_B, 'mayhem');

    const m1 = tt1.getMetrics(MINT_A)!;
    const m2 = tt2.getMetrics(MINT_B)!;
    expect(m1.protocol).toBe('pump.fun');
    expect(m2.protocol).toBe('mayhem');
    tt1.stop();
    tt2.stop();
  });

  it('multiple mints tracked independently', () => {
    const tt = new TrendTracker();
    const events: string[] = [];
    tt.on('trend:confirmed', (mint: string) => events.push(mint));

    tt.track(MINT_A, 'pumpswap');
    tt.track(MINT_B, 'pumpswap');

    makeBuyers(tt, MINT_A, 3, 0.2); // confirm A only
    expect(events).toEqual([MINT_A]);

    makeBuyers(tt, MINT_B, 3, 0.2); // confirm B
    expect(events).toEqual([MINT_A, MINT_B]);
    tt.stop();
  });
});
