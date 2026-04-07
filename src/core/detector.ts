// src/core/detector.ts
import { Connection, PublicKey } from '@solana/web3.js';
import { getBondingCurvePDA } from '../trading/buy';
import { getPoolPDAByMint as getPoolPDA } from '../trading/pumpSwap';
import { resolveLaunchLabPool } from '../trading/raydiumLaunchLab';
import { resolveCpmmPool } from '../trading/raydiumCpmm';
import { resolveAmmV4Pool } from '../trading/raydiumAmmV4';
import { logger } from '../utils/logger';

export type ProtocolType = 'pumpfun' | 'pumpswap' | 'raydium-launch' | 'raydium-cpmm' | 'raydium-ammv4' | 'unknown';

export interface ProtocolInfo {
  protocol: ProtocolType;
  bondingCurve?: PublicKey;
  pool?: PublicKey;
  isComplete?: boolean;      // для pump.fun — завершена ли кривая
  exists?: boolean;           // существует ли соответствующий аккаунт
}

// C1: Protocol detection cache — terminal states (pumpswap, raydium-*) are cached permanently,
// pumpfun is cached with short TTL (may migrate to pumpswap)
const protocolCache = new Map<string, { info: ProtocolInfo; ts: number }>();
const PUMPFUN_CACHE_TTL_MS = 5_000; // 5s for pump.fun (may migrate)
const TERMINAL_PROTOCOLS = new Set<ProtocolType>(['pumpswap', 'raydium-launch', 'raydium-cpmm', 'raydium-ammv4']);

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
  // C1: Check cache first
  const mintStr = mint.toBase58();
  const cached = protocolCache.get(mintStr);
  if (cached) {
    if (TERMINAL_PROTOCOLS.has(cached.info.protocol)) return cached.info;
    if (Date.now() - cached.ts < PUMPFUN_CACHE_TTL_MS) return cached.info;
  }

  // Batch: проверяем pump.fun bonding curve + pumpSwap pool за 1 RPC вызов
  const bondingCurve = getBondingCurvePDA(mint);
  const pool = getPoolPDA(mint);
  const [bondingAcc, poolAcc] = await connection.getMultipleAccountsInfo([bondingCurve, pool]);

  const cacheAndReturn = (info: ProtocolInfo): ProtocolInfo => {
    protocolCache.set(mintStr, { info, ts: Date.now() });
    return info;
  };

  if (bondingAcc) {
    const COMPLETE_OFFSET = 48;
    let complete = false;
    if (bondingAcc.data.length > COMPLETE_OFFSET) {
      complete = bondingAcc.data[COMPLETE_OFFSET] === 1;
    }
    return cacheAndReturn({
      protocol: complete ? 'pumpswap' : 'pumpfun',
      bondingCurve,
      isComplete: complete,
      exists: true,
    });
  }

  if (poolAcc) {
    return cacheAndReturn({
      protocol: 'pumpswap',
      pool,
      exists: true,
    });
  }

  // Проверяем Raydium LaunchLab (bonding curve)
  try {
    const launchResult = await resolveLaunchLabPool(connection, mint);
    if (launchResult) {
      return cacheAndReturn({
        protocol: 'raydium-launch',
        pool: launchResult.poolId,
        exists: true,
      });
    }
  } catch (e) {
    logger.debug(`detectProtocol: raydium-launch check failed for ${mint.toBase58()}: ${e}`);
  }

  // Проверяем Raydium CPMM
  try {
    const cpmmResult = await resolveCpmmPool(connection, mint);
    if (cpmmResult) {
      return cacheAndReturn({
        protocol: 'raydium-cpmm',
        pool: cpmmResult.poolId,
        exists: true,
      });
    }
  } catch (e) {
    logger.debug(`detectProtocol: raydium-cpmm check failed for ${mint.toBase58()}: ${e}`);
  }

  // Проверяем Raydium AMM v4
  try {
    const ammV4Result = await resolveAmmV4Pool(connection, mint);
    if (ammV4Result) {
      return cacheAndReturn({
        protocol: 'raydium-ammv4',
        pool: ammV4Result.poolId,
        exists: true,
      });
    }
  } catch (e) {
    logger.debug(`detectProtocol: raydium-ammv4 check failed for ${mint.toBase58()}: ${e}`);
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