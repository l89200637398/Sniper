import { Connection, PublicKey } from '@solana/web3.js';
import { withRpcLimit } from './rpc-limiter';
import { logger } from './logger';

const balanceCache = new Map<string, { sol: number; ts: number }>();
const CACHE_TTL_MS = 120_000;

export async function getCreatorBalance(connection: Connection, creator: string): Promise<number | undefined> {
  const cached = balanceCache.get(creator);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.sol;

  try {
    const lamports = await withRpcLimit(() =>
      connection.getBalance(new PublicKey(creator), 'processed')
    );
    const sol = lamports / 1e9;
    balanceCache.set(creator, { sol, ts: Date.now() });
    return sol;
  } catch (err) {
    logger.debug(`[creator-balance] Failed for ${creator.slice(0, 8)}: ${err}`);
    return undefined;
  }
}
