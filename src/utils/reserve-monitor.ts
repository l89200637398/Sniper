import { logger } from './logger';

interface ReserveSnapshot {
  solReserve: number;
  ts: number;
}

const reserveHistory = new Map<string, ReserveSnapshot[]>();
const MAX_SNAPSHOTS = 30;

export function recordReserveSnapshot(mint: string, solReserve: number): void {
  let history = reserveHistory.get(mint);
  if (!history) {
    history = [];
    reserveHistory.set(mint, history);
  }
  history.push({ solReserve, ts: Date.now() });
  if (history.length > MAX_SNAPSHOTS) history.shift();
}

export interface ReserveImbalance {
  shouldExit: boolean;
  dropPct: number;
  windowMs: number;
  peakReserve: number;
  currentReserve: number;
}

export function checkReserveImbalance(
  mint: string,
  windowMs: number = 30_000,
  dropThresholdPct: number = 20,
): ReserveImbalance {
  const history = reserveHistory.get(mint);
  if (!history || history.length < 2) {
    return { shouldExit: false, dropPct: 0, windowMs, peakReserve: 0, currentReserve: 0 };
  }

  const now = Date.now();
  const cutoff = now - windowMs;
  const recent = history.filter(s => s.ts >= cutoff);
  if (recent.length < 2) {
    return { shouldExit: false, dropPct: 0, windowMs, peakReserve: 0, currentReserve: 0 };
  }

  let peak = 0;
  for (const s of recent) {
    if (s.solReserve > peak) peak = s.solReserve;
  }

  const current = recent[recent.length - 1].solReserve;
  const dropPct = peak > 0 ? ((peak - current) / peak) * 100 : 0;

  const shouldExit = dropPct > dropThresholdPct;
  if (shouldExit) {
    logger.info(`[reserve-monitor] ${mint.slice(0, 8)} reserve drop ${dropPct.toFixed(1)}% in ${windowMs}ms (${peak.toFixed(2)} → ${current.toFixed(2)} SOL)`);
  }

  return { shouldExit, dropPct, windowMs, peakReserve: peak, currentReserve: current };
}

export function clearReserveHistory(mint: string): void {
  reserveHistory.delete(mint);
}
