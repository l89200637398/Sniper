import { Connection, PublicKey } from '@solana/web3.js';
import { withRpcLimit } from './rpc-limiter';

const holderCache = new Map<string, { topPct: number; ts: number }>();
const CACHE_TTL_MS = 60_000;

export async function getTopHolderPct(connection: Connection, mint: PublicKey): Promise<number | undefined> {
  const mintStr = mint.toBase58();
  const cached = holderCache.get(mintStr);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.topPct;

  try {
    const result = await withRpcLimit(() =>
      connection.getTokenLargestAccounts(mint)
    );
    if (!result?.value?.length) return undefined;

    const totalRaw = result.value.reduce((s, a) => s + BigInt(a.amount), 0n);
    if (totalRaw === 0n) return undefined;

    const topRaw = BigInt(result.value[0].amount);
    const topPct = Number(topRaw * 10000n / totalRaw) / 100;

    holderCache.set(mintStr, { topPct, ts: Date.now() });
    return topPct;
  } catch {
    return undefined;
  }
}
