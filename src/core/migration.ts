import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config';
import { getMintState, updateMintState } from './state-cache';
import { getPoolPDAByMint } from '../trading/pumpSwap';

const PUMPSWAP_POOL_MIN_SIZE = 301;

export async function isMigrated(connection: Connection, mint: PublicKey): Promise<boolean> {
  const state = getMintState(mint);
  if (state.migrated !== undefined) return state.migrated;

  const pool = getPoolPDAByMint(mint);

  // CRITICAL: НЕ кэшируем migrated: false — если RPC сбой дал null, это навсегда запрёт
  // токен на pump.fun пути и все последующие sell будут падать с "Bonding curve not found".
  // Retry 3 раза при null account (различаем real=not_migrated от RPC transient).
  let account = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      account = await connection.getAccountInfo(pool, 'processed');
      if (account) break;
    } catch {}
    if (attempt < 2) await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
  }
  if (!account) {
    // Не кэшируем — next call пересчитает (может быть transient RPC error)
    return false;
  }
  if (account.data.length < PUMPSWAP_POOL_MIN_SIZE) {
    // Account exists but data not fully initialized — migration in progress.
    // Don't cache so next call re-checks.
    return false;
  }
  updateMintState(mint, { migrated: true });
  return true;
}