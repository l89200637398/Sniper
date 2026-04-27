interface PricePoint {
  price: number;
  ts: number;
}

const mintPriceHistory = new Map<string, PricePoint[]>();
const MAX_HISTORY = 60;
const CLEANUP_INTERVAL = 300_000;
let lastCleanup = Date.now();

export function recordPrice(mint: string, price: number): void {
  let history = mintPriceHistory.get(mint);
  if (!history) {
    history = [];
    mintPriceHistory.set(mint, history);
  }
  history.push({ price, ts: Date.now() });
  if (history.length > MAX_HISTORY) history.shift();

  if (Date.now() - lastCleanup > CLEANUP_INTERVAL) {
    cleanupOld();
    lastCleanup = Date.now();
  }
}

export interface StabilityResult {
  isUnstable: boolean;
  dropFromPeakPct: number;
  peakPrice: number;
  currentPrice: number;
}

export function checkPriceStability(
  mint: string,
  windowMs: number = 10_000,
  maxDropPct: number = 30,
): StabilityResult {
  const history = mintPriceHistory.get(mint);
  if (!history || history.length < 2) {
    return { isUnstable: false, dropFromPeakPct: 0, peakPrice: 0, currentPrice: 0 };
  }

  const now = Date.now();
  const cutoff = now - windowMs;
  const recent = history.filter(p => p.ts >= cutoff);
  if (recent.length < 2) {
    return { isUnstable: false, dropFromPeakPct: 0, peakPrice: 0, currentPrice: 0 };
  }

  let peak = 0;
  for (const p of recent) {
    if (p.price > peak) peak = p.price;
  }

  const current = recent[recent.length - 1].price;
  const dropPct = peak > 0 ? ((peak - current) / peak) * 100 : 0;

  return {
    isUnstable: dropPct > maxDropPct,
    dropFromPeakPct: dropPct,
    peakPrice: peak,
    currentPrice: current,
  };
}

export function getReserveHistory(mint: string): PricePoint[] {
  return mintPriceHistory.get(mint) ?? [];
}

export function clearMintHistory(mint: string): void {
  mintPriceHistory.delete(mint);
}

function cleanupOld(): void {
  const now = Date.now();
  for (const [mint, history] of mintPriceHistory) {
    if (history.length === 0 || now - history[history.length - 1].ts > 600_000) {
      mintPriceHistory.delete(mint);
    }
  }
}
