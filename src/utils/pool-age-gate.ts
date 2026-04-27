const poolFirstSeen = new Map<string, number>();

export function recordPoolSeen(pool: string): void {
  if (!poolFirstSeen.has(pool)) {
    poolFirstSeen.set(pool, Date.now());
  }
}

export function getPoolAgeMs(pool: string): number {
  const ts = poolFirstSeen.get(pool);
  if (!ts) return 0;
  return Date.now() - ts;
}

export function shouldWaitForPool(pool: string, minAgeMs: number, minVolumeSol: number, currentVolumeSol: number): boolean {
  const age = getPoolAgeMs(pool);
  if (age === 0) return true;
  return age < minAgeMs && currentVolumeSol < minVolumeSol;
}
