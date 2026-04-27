import { Connection, PublicKey } from '@solana/web3.js';
import { withRpcLimit } from './rpc-limiter';
import { logger } from './logger';

const ageCache = new Map<string, { firstTxSlot: number | null; ts: number }>();
const CACHE_TTL_MS = 600_000;

export async function getCreatorWalletAge(
  connection: Connection,
  creator: string,
): Promise<{ ageMs: number | undefined; isNew: boolean }> {
  const cached = ageCache.get(creator);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    if (cached.firstTxSlot === null) return { ageMs: undefined, isNew: false };
    const ageMs = estimateAgeFromSlot(cached.firstTxSlot);
    return { ageMs, isNew: ageMs < 86_400_000 };
  }

  try {
    const sigs = await withRpcLimit(() =>
      connection.getSignaturesForAddress(
        new PublicKey(creator),
        { limit: 1 },
        'confirmed',
      )
    );

    if (!sigs || sigs.length === 0) {
      ageCache.set(creator, { firstTxSlot: null, ts: Date.now() });
      return { ageMs: undefined, isNew: true };
    }

    const slot = sigs[0].slot;
    ageCache.set(creator, { firstTxSlot: slot, ts: Date.now() });
    const ageMs = estimateAgeFromSlot(slot);
    return { ageMs, isNew: ageMs < 86_400_000 };
  } catch (err) {
    logger.debug(`[wallet-age] Failed for ${creator.slice(0, 8)}: ${err}`);
    return { ageMs: undefined, isNew: false };
  }
}

function estimateAgeFromSlot(slot: number): number {
  const currentSlotEstimate = Math.floor(Date.now() / 400);
  const slotDiff = currentSlotEstimate - slot;
  return Math.max(0, slotDiff * 400);
}
