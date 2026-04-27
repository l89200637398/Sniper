// src/core/sell-engine.ts
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { sellToken } from '../trading/sell';
import { sellTokenPumpSwap } from '../trading/pumpSwap';
import { sellTokenLaunchLab } from '../trading/raydiumLaunchLab';
import { sellTokenCpmm } from '../trading/raydiumCpmm';
import { sellTokenAmmV4 } from '../trading/raydiumAmmV4';
import { isMigrated } from './migration';
import { getMintState } from './state-cache';
import {
  getBondingCurvePDA,
  getEffectiveFeeRecipient,
  getFeeRecipient,
  getCreatorFromCurveData,
  isCashbackEnabled,
  PUMP_PROGRAM_ID,
} from '../trading/buy';
import { BONDING_CURVE_LAYOUT, PUMP_FUN_PROGRAM_ID, MAYHEM_FEE_RECIPIENTS } from '../constants';
import { config } from '../config';
import { logger } from '../utils/logger';

const [EVENT_AUTHORITY] = PublicKey.findProgramAddressSync(
  [Buffer.from('__event_authority')],
  new PublicKey(PUMP_FUN_PROGRAM_ID)
);

export async function sellTokenAuto(
  connection: Connection,
  mint: PublicKey,
  payer: Keypair,
  amountRaw: bigint,
  slippageBps: number = config.strategy.slippageBps,
  urgent: boolean = false,
  cachedFeeRecipient?: PublicKey,  // из position.feeRecipientUsed
  isMayhem?: boolean,
  cachedCreator?: PublicKey,       // из position.creator
  _cachedCashback?: boolean,       // из position.cashbackEnabled (hint)
  directRpc: boolean = false,      // ← НОВОЕ: bypass Jito, send via sendRawTransaction
  useBloXroute: boolean = false,   // ← NEW: разрешить fire-and-forget bloXroute (+0.001 SOL tip)
  priorityFeeOverride?: number,    // brainstorm v4: escalated priority fee for retries
): Promise<string> {
  const state = getMintState(mint);

  // ── Raydium LaunchLab path ────────────────────────────────────────────────
  // FIX: Check if LaunchLab pool has migrated → route to correct AMM
  if (state.isRaydiumLaunch) {
    try {
      return await sellTokenLaunchLab(connection, mint, payer, amountRaw, slippageBps, directRpc);
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      if (msg.includes('migrated') || msg.includes('status=1') || msg.includes('status=250')) {
        logger.warn(`sellTokenAuto: LaunchLab pool migrated for ${mint.toBase58().slice(0, 8)}, falling back to CPMM/AMMv4`);
        try {
          return await sellTokenCpmm(connection, mint, payer, amountRaw, slippageBps, directRpc);
        } catch (cpmmErr: any) {
          logger.warn(`sellTokenAuto: CPMM fallback failed for ${mint.toBase58().slice(0, 8)}: ${cpmmErr?.message ?? cpmmErr}`);
          return sellTokenAmmV4(connection, mint, payer, amountRaw, slippageBps, directRpc);
        }
      }
      throw e; // non-migration error — rethrow
    }
  }

  // ── Raydium CPMM path ────────────────────────────────────────────────────
  if (state.isRaydiumCpmm) {
    logger.debug(`sellTokenAuto: ${mint.toBase58().slice(0, 8)}... → Raydium CPMM`);
    return sellTokenCpmm(connection, mint, payer, amountRaw, slippageBps, directRpc);
  }

  // ── Raydium AMM v4 path ──────────────────────────────────────────────────
  if (state.isRaydiumAmmV4) {
    logger.debug(`sellTokenAuto: ${mint.toBase58().slice(0, 8)}... → Raydium AMM v4`);
    return sellTokenAmmV4(connection, mint, payer, amountRaw, slippageBps, directRpc);
  }

  // ── PumpSwap path ─────────────────────────────────────────────────────────
  if (state.isPumpSwap) {
    logger.debug(`sellTokenAuto: ${mint.toBase58().slice(0, 8)}... → PumpSwap (native)${directRpc ? ' [direct RPC]' : ''}${useBloXroute ? ' +bx' : ''}`);
    return sellTokenPumpSwap(connection, mint, payer, amountRaw, slippageBps, urgent, directRpc, useBloXroute, priorityFeeOverride);
  }

  const migrated = await isMigrated(connection, mint);
  if (migrated) {
    logger.debug(`sellTokenAuto: ${mint.toBase58().slice(0, 8)}... → PumpSwap (migrated)${directRpc ? ' [direct RPC]' : ''}${useBloXroute ? ' +bx' : ''}`);
    return sellTokenPumpSwap(connection, mint, payer, amountRaw, slippageBps, urgent, directRpc, useBloXroute, priorityFeeOverride);
  }

  // ── Pump.fun bonding curve path ───────────────────────────────────────────
  logger.debug(`sellTokenAuto: ${mint.toBase58().slice(0, 8)}... → Pump.fun`);

  const bondingCurve = getBondingCurvePDA(mint);
  const curveAcc = await connection.getAccountInfo(bondingCurve);
  // CRITICAL: если bonding curve исчезла → токен мигрировал, но isMigrated
  // не обнаружил пул (RPC lag / non-canonical pool PDA). Принудительно пробуем
  // PumpSwap sell — он сам разрешит реальный pool через getAccountInfo.
  if (!curveAcc) {
    logger.warn(`sellTokenAuto: bonding curve gone for ${mint.toBase58().slice(0,8)}, forcing PumpSwap fallback`);
    try {
      return await sellTokenPumpSwap(connection, mint, payer, amountRaw, slippageBps, urgent, directRpc, useBloXroute, priorityFeeOverride);
    } catch (psErr: any) {
      throw new Error(`Bonding curve not found for ${mint.toBase58()} (PumpSwap fallback failed: ${psErr?.message ?? psErr})`);
    }
  }

  const virtualTokenReserves = curveAcc.data.readBigUInt64LE(BONDING_CURVE_LAYOUT.VIRTUAL_TOKEN_RESERVES_OFFSET);
  const virtualSolReserves   = curveAcc.data.readBigUInt64LE(BONDING_CURVE_LAYOUT.VIRTUAL_SOL_RESERVES_OFFSET);

  if (virtualTokenReserves === 0n) {
    throw new Error('virtualTokenReserves is zero — bonding curve may be complete');
  }

  const expectedSol = (amountRaw * virtualSolReserves) / virtualTokenReserves;
  const minSolOut   = (expectedSol * BigInt(10000 - slippageBps)) / 10000n;

  // Mayhem must be resolved before feeRecipient so we can avoid using a cached
  // regular fee recipient for mayhem tokens (wrong recipient → TX fails every retry,
  // triggers circuit-breaker, loses position with 0 SOL received).
  const mayhem = isMayhem ?? (state.isMayhemMode ?? false);

  // ── feeRecipient ──────────────────────────────────────────────────────────
  let feeRecipient: PublicKey;
  if (cachedFeeRecipient && !mayhem) {
    // Non-mayhem: reuse cached recipient (saves one RPC call per retry)
    feeRecipient = cachedFeeRecipient;
  } else {
    // Mayhem or no cache: always derive from curve data so the correct
    // mayhem fee recipient is used on every sell attempt (not just attempt 0).
    const defaultFeeRecipient = await getFeeRecipient(connection);
    feeRecipient = getEffectiveFeeRecipient(curveAcc.data, defaultFeeRecipient);
  }

  // ── cashback flag — всегда читаем свежим из on-chain данных ──────────────
  // Это гарантирует правильную раскладку аккаунтов sell независимо от
  // того, что хранится в позиции (position.cashbackEnabled — лишь hint).
  const cashback = isCashbackEnabled(curveAcc.data);

  // ── creator ───────────────────────────────────────────────────────────────
  let creator: PublicKey;
  try {
    creator = getCreatorFromCurveData(curveAcc.data);
  } catch (e) {
    if (cachedCreator) {
      logger.warn(`sellTokenAuto: failed to read creator from curve, using cached`);
      creator = cachedCreator;
    } else {
      throw new Error(`Cannot determine creator for ${mint.toBase58()}: ${e}`);
    }
  }

  return sellToken(
    connection, mint, payer, creator, feeRecipient, EVENT_AUTHORITY,
    amountRaw, minSolOut, urgent, mayhem, cashback, directRpc, useBloXroute, priorityFeeOverride
  );
}
