// __tests__/position-race-condition.test.ts
//
// Block 2: Take Profit Race Condition
// Verifies that the bot does not generate duplicate sell orders for the same
// TP level while a transaction is in-flight (pendingTpLevels guard).

import { Position } from '../src/core/position';
import { PublicKey } from '@solana/web3.js';

const DUMMY_MINT = new PublicKey('11111111111111111111111111111111');
const POOL = { programId: 'pump', quoteMint: 'sol' };

function createPosition(entryPrice: number, amount: number, protocol: 'pump.fun' | 'pumpswap' = 'pump.fun') {
  return new Position(DUMMY_MINT, entryPrice, amount, POOL, 6, {
    entryAmountSol: 0.10,
    protocol,
  });
}

// Helper: simulate price by manipulating reserves.
// updatePrice calculates: newPrice = (solReserves / 1e9) / (tokenReserves / 10^decimals)
// With decimals=6: newPrice = (solReserves / 1e9) / (tokenReserves / 1e6)
// Using 30 SOL as base: price = 30 / (tokenReserves / 1e6)
// So tokenReserves = (30 / price) * 1e6
function setPrice(pos: Position, price: number) {
  const solReserves = 30e9; // 30 SOL in lamports
  const tokenReserves = (30 / price) * 1e6; // raw units (6 decimals)
  pos.updatePrice(solReserves, tokenReserves);
}

describe('TP Race Condition Guard', () => {
  it('should not trigger same TP level twice when pendingTpLevels is used', () => {
    const pos = createPosition(1.0, 1000);
    pos.setTakeProfitLevels([{ levelPercent: 50, portion: 0.40 }]);

    // Price reaches +50% → TP1 triggers
    setPrice(pos, 1.5);
    const decision1 = pos.shouldSell();
    expect(decision1.action).toBe('partial');
    expect(decision1.tpLevelPercent).toBe(50);

    // Simulate: lock the level (as sniper.ts does before sending tx)
    pos.lockTpLevel(50);

    // New price tick at 1.55 — level still reached but locked
    setPrice(pos, 1.55);
    const decision2 = pos.shouldSell();
    // Must NOT trigger TP again while locked
    expect(decision2.action).toBe('none');
  });

  it('should allow retry after unlockTpLevel (tx failure)', () => {
    const pos = createPosition(1.0, 1000);
    pos.setTakeProfitLevels([{ levelPercent: 50, portion: 0.40 }]);

    setPrice(pos, 1.5);
    const d1 = pos.shouldSell();
    expect(d1.action).toBe('partial');

    pos.lockTpLevel(50);

    // Tx failed → unlock
    pos.unlockTpLevel(50);

    // Should trigger again
    const d2 = pos.shouldSell();
    expect(d2.action).toBe('partial');
    expect(d2.tpLevelPercent).toBe(50);
  });

  it('should permanently mark level after markTpLevel (tx success)', () => {
    const pos = createPosition(1.0, 1000);
    pos.setTakeProfitLevels([
      { levelPercent: 50, portion: 0.40 },
      { levelPercent: 200, portion: 0.20 },
    ]);

    setPrice(pos, 1.5);
    pos.shouldSell(); // triggers TP1
    pos.lockTpLevel(50);
    pos.markTpLevel(50); // tx succeeded

    // Even with high price, TP1 should never trigger again
    setPrice(pos, 1.6);
    const d = pos.shouldSell();
    // Should be 'none' (TP2 not reached yet)
    expect(d.tpLevelPercent).not.toBe(50);
  });

  it('should fire 5 rapid shouldSell calls but only generate 1 TP signal', () => {
    const pos = createPosition(1.0, 1000);
    pos.setTakeProfitLevels([{ levelPercent: 50, portion: 0.40 }]);

    setPrice(pos, 1.5);

    // First call triggers
    const results = [];
    const d1 = pos.shouldSell();
    results.push(d1);
    if (d1.tpLevelPercent) pos.lockTpLevel(d1.tpLevelPercent);

    // 4 more rapid calls
    for (let i = 0; i < 4; i++) {
      setPrice(pos, 1.5 + i * 0.01);
      results.push(pos.shouldSell());
    }

    const tpSignals = results.filter(r => r.action === 'partial' && r.tpLevelPercent === 50);
    expect(tpSignals).toHaveLength(1);
  });
});

describe('Micro-Position Binary Exit', () => {
  it('positions < 0.05 SOL should sell 100% at first TP (binary exit)', () => {
    const pos = new Position(DUMMY_MINT, 1.0, 1000, POOL, 6, {
      entryAmountSol: 0.03, // copy-trade T2
      protocol: 'pump.fun',
    });
    pos.setTakeProfitLevels([{ levelPercent: 50, portion: 0.40 }]);

    setPrice(pos, 1.5);
    const decision = pos.shouldSell();

    // Micro-position: should be full sell, not partial
    expect(decision.action).toBe('full');
    expect(decision.reason).toBe('tp_all');
    expect(decision.portion).toBe(1.0);
  });

  it('positions >= 0.05 SOL should use normal partial TP', () => {
    const pos = new Position(DUMMY_MINT, 1.0, 1000, POOL, 6, {
      entryAmountSol: 0.10,
      protocol: 'pump.fun',
    });
    pos.setTakeProfitLevels([{ levelPercent: 50, portion: 0.40 }]);

    setPrice(pos, 1.5);
    const decision = pos.shouldSell();

    expect(decision.action).toBe('partial');
    expect(decision.portion).toBe(0.40);
  });
});

describe('Position Exit Signals', () => {
  it('stop-loss triggers at configured percent', () => {
    const pos = createPosition(1.0, 1000);
    // Stop-loss is 15% (EV-fix)
    setPrice(pos, 0.84); // -16% → should trigger
    const d = pos.shouldSell();
    expect(d.action).toBe('full');
    expect(d.reason).toBe('stop_loss');
    expect(d.urgent).toBe(true);
  });

  it('stop-loss does NOT trigger at -10% (above 12% threshold)', () => {
    const pos = createPosition(1.0, 1000);
    setPrice(pos, 0.90); // -10%, above 12% threshold
    const d = pos.shouldSell();
    expect(d.action).toBe('none');
  });

  it('runner tail activates at configured percent and widens trailing', () => {
    const pos = createPosition(1.0, 1000);
    // runner activation at +100% for pump.fun
    setPrice(pos, 2.1); // +110%
    expect(pos.runnerTailActivated).toBe(true);
  });

  it('break-even stop is disabled in runner tail mode', () => {
    const pos = createPosition(1.0, 1000);
    pos.setTakeProfitLevels([{ levelPercent: 50, portion: 0.40 }]);

    // Activate trailing
    setPrice(pos, 1.3); // +30%, above trailingActivation 25%
    expect(pos.trailingActivated).toBe(true);

    // Activate runner tail
    setPrice(pos, 2.1); // +110%
    expect(pos.runnerTailActivated).toBe(true);

    // Drop to -1% from entry → break-even would trigger without runner
    setPrice(pos, 0.99);
    const d = pos.shouldSell();
    // With runner tail, break-even is disabled → should trigger other exits (hard_stop/stop_loss)
    // but NOT break_even
    expect(d.reason).not.toBe('break_even');
  });
});
