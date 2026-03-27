// src/core/sell-engine.ts
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { sellToken } from '../trading/sell';
import { sellTokenPumpSwap } from '../trading/pumpSwap';
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
  directRpc: boolean = false       // ← НОВОЕ: bypass Jito, send via sendRawTransaction
): Promise<string> {
  const state = getMintState(mint);

  // ── PumpSwap path ─────────────────────────────────────────────────────────
  if (state.isPumpSwap) {
    logger.debug(`sellTokenAuto: ${mint.toBase58().slice(0, 8)}... → PumpSwap (native)${directRpc ? ' [direct RPC]' : ''}`);
    return sellTokenPumpSwap(connection, mint, payer, amountRaw, slippageBps, urgent, directRpc);
  }

  const migrated = await isMigrated(connection, mint);
  if (migrated) {
    logger.debug(`sellTokenAuto: ${mint.toBase58().slice(0, 8)}... → PumpSwap (migrated)${directRpc ? ' [direct RPC]' : ''}`);
    return sellTokenPumpSwap(connection, mint, payer, amountRaw, slippageBps, urgent, directRpc);
  }

  // ── Pump.fun bonding curve path ───────────────────────────────────────────
  logger.debug(`sellTokenAuto: ${mint.toBase58().slice(0, 8)}... → Pump.fun`);

  const bondingCurve = getBondingCurvePDA(mint);
  const curveAcc = await connection.getAccountInfo(bondingCurve);
  if (!curveAcc) throw new Error(`Bonding curve not found for ${mint.toBase58()}`);

  const virtualTokenReserves = curveAcc.data.readBigUInt64LE(BONDING_CURVE_LAYOUT.VIRTUAL_TOKEN_RESERVES_OFFSET);
  const virtualSolReserves   = curveAcc.data.readBigUInt64LE(BONDING_CURVE_LAYOUT.VIRTUAL_SOL_RESERVES_OFFSET);

  if (virtualTokenReserves === 0n) {
    throw new Error('virtualTokenReserves is zero — bonding curve may be complete');
  }

  const expectedSol = (amountRaw * virtualSolReserves) / virtualTokenReserves;
  const minSolOut   = (expectedSol * BigInt(10000 - slippageBps)) / 10000n;

  // ── feeRecipient ──────────────────────────────────────────────────────────
  let feeRecipient: PublicKey;
  if (cachedFeeRecipient) {
    feeRecipient = cachedFeeRecipient;
  } else {
    const defaultFeeRecipient = await getFeeRecipient(connection);
    feeRecipient = getEffectiveFeeRecipient(curveAcc.data, defaultFeeRecipient);
  }

  const mayhem = isMayhem ?? (state.isMayhemMode ?? false);

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
    amountRaw, minSolOut, urgent, mayhem, cashback, directRpc
  );
}
