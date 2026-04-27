import { logger } from './logger';

interface BuyerInfo {
  wallet: string;
  solAmount: number;
  ts: number;
}

const mintBuyers = new Map<string, BuyerInfo[]>();
const WINDOW_MS = 30_000;

export function recordBuyerForWash(mint: string, wallet: string, solAmount: number): void {
  let buyers = mintBuyers.get(mint);
  if (!buyers) {
    buyers = [];
    mintBuyers.set(mint, buyers);
  }
  buyers.push({ wallet, solAmount, ts: Date.now() });
  if (buyers.length > 100) buyers.shift();
}

export interface WashResult {
  isWashTrading: boolean;
  repeatBuyers: number;
  totalBuyers: number;
}

export function detectWashTrading(
  mint: string,
  creator?: string,
  threshold: number = 0.4,
): WashResult {
  const buyers = mintBuyers.get(mint);
  if (!buyers || buyers.length < 3) {
    return { isWashTrading: false, repeatBuyers: 0, totalBuyers: buyers?.length ?? 0 };
  }

  const cutoff = Date.now() - WINDOW_MS;
  const recent = buyers.filter(b => b.ts >= cutoff);
  if (recent.length < 3) {
    return { isWashTrading: false, repeatBuyers: 0, totalBuyers: recent.length };
  }

  const walletCounts = new Map<string, number>();
  for (const b of recent) {
    walletCounts.set(b.wallet, (walletCounts.get(b.wallet) ?? 0) + 1);
  }

  let repeatBuyers = 0;
  for (const [wallet, count] of walletCounts) {
    if (count >= 2) repeatBuyers++;
    if (creator && wallet === creator) repeatBuyers += 2;
  }

  const ratio = repeatBuyers / walletCounts.size;
  const isWash = ratio >= threshold;

  if (isWash) {
    logger.info(`[wash] ${mint.slice(0, 8)} wash trading detected: ${repeatBuyers}/${walletCounts.size} repeat buyers`);
  }

  return { isWashTrading: isWash, repeatBuyers, totalBuyers: walletCounts.size };
}
