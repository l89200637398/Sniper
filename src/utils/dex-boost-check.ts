import { logger } from './logger';

const boostCache = new Map<string, { boosted: boolean; ts: number }>();
const CACHE_TTL_MS = 60_000;
let activeBoosts = new Set<string>();
let lastFetchTs = 0;

export function updateActiveBoosts(boosts: Array<{ tokenAddress?: string; chainId?: string }>): void {
  const solBoosts = new Set<string>();
  for (const b of boosts) {
    if (b.tokenAddress && (b.chainId === 'solana' || !b.chainId)) {
      solBoosts.add(b.tokenAddress);
    }
  }
  activeBoosts = solBoosts;
  lastFetchTs = Date.now();
  logger.debug(`[dex-boost] Updated: ${solBoosts.size} active Solana boosts`);
}

export function hasDexBoost(mint: string): boolean {
  const cached = boostCache.get(mint);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.boosted;

  const boosted = activeBoosts.has(mint);
  boostCache.set(mint, { boosted, ts: Date.now() });
  return boosted;
}

export function getBoostCacheAge(): number {
  return lastFetchTs > 0 ? Date.now() - lastFetchTs : Infinity;
}
