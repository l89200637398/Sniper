// src/core/detector.ts
import { Connection, PublicKey } from '@solana/web3.js';
import { getBondingCurvePDA } from '../trading/buy';
import { getPoolPDAByMint as getPoolPDA } from '../trading/pumpSwap';
import { logger } from '../utils/logger';

export type ProtocolType = 'pumpfun' | 'pumpswap' | 'unknown';

export interface ProtocolInfo {
  protocol: ProtocolType;
  bondingCurve?: PublicKey;
  pool?: PublicKey;
  isComplete?: boolean;      // для pump.fun — завершена ли кривая
  exists?: boolean;           // существует ли соответствующий аккаунт
}

/**
 * Определяет, по какому протоколу сейчас торгуется токен.
 * Приоритет:
 * 1. Если есть bonding curve и она не complete → pump.fun
 * 2. Если есть bonding curve complete → pumpSwap (ликвидность ушла в AMM)
 * 3. Если нет bonding curve, но есть pool → pumpSwap
 * 4. Иначе unknown
 */
export async function detectProtocol(
  connection: Connection,
  mint: PublicKey
): Promise<ProtocolInfo> {
  // Проверяем pump.fun bonding curve
  const bondingCurve = getBondingCurvePDA(mint);
  const bondingAcc = await connection.getAccountInfo(bondingCurve);

  if (bondingAcc) {
    // complete находится по offset 48 (см. документацию)
    const COMPLETE_OFFSET = 48;
    let complete = false;
    if (bondingAcc.data.length > COMPLETE_OFFSET) {
      complete = bondingAcc.data[COMPLETE_OFFSET] === 1;
    }
    return {
      protocol: complete ? 'pumpswap' : 'pumpfun',
      bondingCurve,
      isComplete: complete,
      exists: true,
    };
  }

  // Если bonding curve нет, проверяем pumpSwap pool
  const pool = getPoolPDA(mint);
  const poolAcc = await connection.getAccountInfo(pool);
  if (poolAcc) {
    return {
      protocol: 'pumpswap',
      pool,
      exists: true,
    };
  }

  return { protocol: 'unknown', exists: false };
}

/**
 * Быстрая проверка, является ли токен pump.fun (без complete).
 */
export async function isPumpFun(connection: Connection, mint: PublicKey): Promise<boolean> {
  const info = await detectProtocol(connection, mint);
  return info.protocol === 'pumpfun';
}

/**
 * Быстрая проверка, является ли токен pumpSwap.
 */
export async function isPumpSwap(connection: Connection, mint: PublicKey): Promise<boolean> {
  const info = await detectProtocol(connection, mint);
  return info.protocol === 'pumpswap';
}