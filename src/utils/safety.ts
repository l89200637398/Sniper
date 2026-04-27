// src/utils/safety.ts
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { config } from '../config';
import { logger } from './logger';

const safetyCache = new Map<string, { safe: boolean; reason?: string; ts: number }>();
const CACHE_TTL = 60_000; // 60 секунд

export async function isTokenSafeCached(connection: Connection, mint: PublicKey): Promise<{ safe: boolean; reason?: string }> {
  const key = mint.toBase58();
  const cached = safetyCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return { safe: cached.safe, reason: cached.reason };
  }
  const result = await isTokenSafe(connection, mint);
  safetyCache.set(key, { ...result, ts: Date.now() });
  return result;
}

export async function isTokenSafe(connection: Connection, mint: PublicKey): Promise<{ safe: boolean; reason?: string }> {
  logger.debug(`🔍 [safety] Checking token ${mint.toBase58()}`);
  try {
    const accountInfo = await connection.getAccountInfo(mint);
    // D5 FIX: null account = mint doesn't exist = NOT safe (was incorrectly returning safe: true)
    if (!accountInfo) return { safe: false, reason: 'Mint account not found' };

    const programId = accountInfo.owner.toString();
    if (programId === '11111111111111111111111111111111') return { safe: true };

    if (programId === TOKEN_2022_PROGRAM_ID.toString()) {
      if (config.strategy.disallowToken2022) return { safe: false, reason: 'Token-2022 is disallowed' };
    } else if (programId !== TOKEN_PROGRAM_ID.toString()) {
      return { safe: false, reason: `Unknown token program: ${programId}` };
    }

    const mintInfo = await connection.getParsedAccountInfo(mint);
    const parsed = (mintInfo.value?.data as any)?.parsed?.info;
    if (parsed) {
      if (parsed.mintAuthority) return { safe: false, reason: 'Mint authority present' };
      if (parsed.freezeAuthority) return { safe: false, reason: 'Freeze authority present' };
    }
    return { safe: true };
  } catch (error) {
    logger.error(`❌ [safety] Error:`, error);
    return { safe: false, reason: 'Check error or timeout' };
  }
}
