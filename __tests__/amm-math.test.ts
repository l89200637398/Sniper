// __tests__/amm-math.test.ts
//
// Block 1: AMM Math & Fee-Adjusted Buy
// Verifies that buildBuyInstructionFromCreate correctly calculates minTokensOut
// with the 1% pump.fun protocol fee deducted BEFORE slippage is applied.

import { buildBuyInstructionFromCreate } from '../src/trading/buy';
import { PublicKey } from '@solana/web3.js';
import { computeDynamicSlippage, computeDynamicSellSlippage } from '../src/config';

const DUMMY_PUBKEY = new PublicKey('11111111111111111111111111111111');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

describe('AMM Math & Slippage (Pump.fun)', () => {
  it('minTokensOut must include 1% protocol fee deduction', () => {
    const virtualSolReserves = BigInt(30e9);       // 30 SOL
    const virtualTokenReserves = BigInt(1_073_000_000e6); // ~1B tokens (6 decimals)
    const amountSol = 0.1;
    const slippageBps = 1000; // 10%

    const ix = buildBuyInstructionFromCreate({
      mint: DUMMY_PUBKEY,
      creator: DUMMY_PUBKEY,
      userAta: DUMMY_PUBKEY,
      user: DUMMY_PUBKEY,
      amountSol,
      slippageBps,
      virtualSolReserves,
      virtualTokenReserves,
      feeRecipient: DUMMY_PUBKEY,
      eventAuthority: DUMMY_PUBKEY,
      tokenProgramId: TOKEN_PROGRAM,
    });

    // Extract minTokensOut from instruction data (bytes 16-23, after 8-byte disc + 8-byte solAmount)
    const minTokensOut = ix.data.readBigUInt64LE(16);

    // Manual calculation matching the fix:
    const solLamports = BigInt(Math.floor(amountSol * 1e9));
    const rawExpected = (solLamports * virtualTokenReserves) / (virtualSolReserves + solLamports);
    const postFee = rawExpected * 99n / 100n;  // 1% pump.fun fee
    const expected = (postFee * (10000n - BigInt(slippageBps))) / 10000n;

    expect(minTokensOut).toEqual(expected);
  });

  it('minTokensOut WITHOUT fee deduction would be higher (proving the fix matters)', () => {
    const vSol = BigInt(30e9);
    const vToken = BigInt(1_073_000_000e6);
    const amountSol = 0.1;
    const slippageBps = 1500; // 15%

    const ix = buildBuyInstructionFromCreate({
      mint: DUMMY_PUBKEY,
      creator: DUMMY_PUBKEY,
      userAta: DUMMY_PUBKEY,
      user: DUMMY_PUBKEY,
      amountSol,
      slippageBps,
      virtualSolReserves: vSol,
      virtualTokenReserves: vToken,
      feeRecipient: DUMMY_PUBKEY,
      eventAuthority: DUMMY_PUBKEY,
      tokenProgramId: TOKEN_PROGRAM,
    });
    const actual = ix.data.readBigUInt64LE(16);

    // What OLD code (without fee) would produce:
    const solLamports = BigInt(Math.floor(amountSol * 1e9));
    const rawExpected = (solLamports * vToken) / (vSol + solLamports);
    const oldMinTokens = (rawExpected * (10000n - BigInt(slippageBps))) / 10000n;

    // New value must be LOWER (fee-adjusted gives more room for the protocol fee)
    expect(actual).toBeLessThan(oldMinTokens);
    // The difference should be ~1% of the old value
    const diff = oldMinTokens - actual;
    const pctDiff = Number(diff * 10000n / oldMinTokens);
    expect(pctDiff).toBeGreaterThanOrEqual(90);  // ~0.9-1.0%
    expect(pctDiff).toBeLessThanOrEqual(110);
  });

  it('should throw on zero reserves', () => {
    expect(() =>
      buildBuyInstructionFromCreate({
        mint: DUMMY_PUBKEY,
        creator: DUMMY_PUBKEY,
        userAta: DUMMY_PUBKEY,
        user: DUMMY_PUBKEY,
        amountSol: 0.1,
        slippageBps: 1000,
        virtualSolReserves: 0n,
        virtualTokenReserves: BigInt(1e12),
        feeRecipient: DUMMY_PUBKEY,
        eventAuthority: DUMMY_PUBKEY,
        tokenProgramId: TOKEN_PROGRAM,
      })
    ).toThrow('reserves must be non-zero');
  });

  it('should throw on tiny amountSol that produces zero tokens', () => {
    // Huge SOL reserves, tiny token reserves → expectedTokens = 0
    expect(() =>
      buildBuyInstructionFromCreate({
        mint: DUMMY_PUBKEY,
        creator: DUMMY_PUBKEY,
        userAta: DUMMY_PUBKEY,
        user: DUMMY_PUBKEY,
        amountSol: 0.000000001,
        slippageBps: 1000,
        virtualSolReserves: BigInt(1000e9),
        virtualTokenReserves: BigInt(1),
        feeRecipient: DUMMY_PUBKEY,
        eventAuthority: DUMMY_PUBKEY,
        tokenProgramId: TOKEN_PROGRAM,
      })
    ).toThrow('expectedTokens is 0');
  });
});

describe('Dynamic Slippage Calculations', () => {
  it('computeDynamicSlippage: reduces slippage when entry is small vs liquidity', () => {
    // 0.10 SOL into 10 SOL pool → ratio=0.01 → sqrt(0.01)=0.1 → 2000*0.1=200
    // But minFloor=300, so result=300
    const result = computeDynamicSlippage(0.10, 10, 2000, 300);
    expect(result).toBe(300);
  });

  it('computeDynamicSlippage: returns max when entry >= liquidity', () => {
    const result = computeDynamicSlippage(5.0, 2.0, 2000, 300);
    expect(result).toBe(2000);
  });

  it('computeDynamicSlippage: returns max on zero liquidity', () => {
    const result = computeDynamicSlippage(0.1, 0, 2000, 300);
    expect(result).toBe(2000);
  });

  it('computeDynamicSellSlippage: urgent capped at 3500', () => {
    const result = computeDynamicSellSlippage(2000, -15, true);
    expect(result).toBeLessThanOrEqual(3500);
    expect(result).toBeGreaterThan(2000);
  });

  it('computeDynamicSellSlippage: take_profit uses modest multiplier', () => {
    const result = computeDynamicSellSlippage(1500, 50, false, 'take_profit_50');
    expect(result).toBeLessThanOrEqual(2000);
    expect(result).toBeGreaterThanOrEqual(1500);
  });

  it('computeDynamicSellSlippage: base returned when no special condition', () => {
    const result = computeDynamicSellSlippage(1500, 5, false);
    expect(result).toBe(1500);
  });
});
