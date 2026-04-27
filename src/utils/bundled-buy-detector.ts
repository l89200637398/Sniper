import { logger } from './logger';

interface SlotBuys {
  slot: number;
  wallets: Set<string>;
  totalSol: number;
}

const mintSlotBuys = new Map<string, SlotBuys[]>();
const CLEANUP_INTERVAL_MS = 300_000;
const MAX_AGE_MS = 60_000;
let lastCleanup = Date.now();

export function recordBuyInSlot(mint: string, slot: number, wallet: string, solAmount: number): void {
  let slots = mintSlotBuys.get(mint);
  if (!slots) {
    slots = [];
    mintSlotBuys.set(mint, slots);
  }

  let entry = slots.find(s => s.slot === slot);
  if (!entry) {
    entry = { slot, wallets: new Set(), totalSol: 0 };
    slots.push(entry);
  }
  entry.wallets.add(wallet);
  entry.totalSol += solAmount;

  if (Date.now() - lastCleanup > CLEANUP_INTERVAL_MS) {
    cleanup();
    lastCleanup = Date.now();
  }
}

export interface BundledBuyResult {
  isBundled: boolean;
  maxWalletsInSlot: number;
  sameSlotSol: number;
  suspiciousSlots: number;
}

export function detectBundledBuys(mint: string, threshold: number = 5): BundledBuyResult {
  const slots = mintSlotBuys.get(mint);
  if (!slots || slots.length === 0) {
    return { isBundled: false, maxWalletsInSlot: 0, sameSlotSol: 0, suspiciousSlots: 0 };
  }

  let maxWallets = 0;
  let maxSol = 0;
  let suspicious = 0;

  for (const s of slots) {
    if (s.wallets.size > maxWallets) {
      maxWallets = s.wallets.size;
      maxSol = s.totalSol;
    }
    if (s.wallets.size >= threshold) {
      suspicious++;
    }
  }

  return {
    isBundled: maxWallets >= threshold,
    maxWalletsInSlot: maxWallets,
    sameSlotSol: maxSol,
    suspiciousSlots: suspicious,
  };
}

function cleanup(): void {
  if (mintSlotBuys.size > 5000) {
    const entries = [...mintSlotBuys.entries()];
    entries.slice(0, entries.length - 2000).forEach(([k]) => mintSlotBuys.delete(k));
  }
}
