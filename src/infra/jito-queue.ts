import { VersionedTransaction, Keypair } from '@solana/web3.js';
import { sendJitoBundle, resolveTipLamports } from '../jito/bundle';
import { logger } from '../utils/logger';
import { config } from '../config';
import pLimit from 'p-limit';
import { acquireJitoToken } from './jito-rate-limiter';

// ── Queue ───────────────────────────────────────────────────────────

type QueueItem = {
  buildTx: () => Promise<VersionedTransaction>;
  payer: Keypair;
  resolve: (value: string) => void;
  reject: (reason?: any) => void;
  retries: number;
  tipMultiplier: number;
  urgent: boolean;
};

const queue: QueueItem[] = [];
const limiter = pLimit(10); // concurrency cap = 10 (= RPS target)

async function processItem(item: QueueItem): Promise<void> {
  await acquireJitoToken(); // rate-limit: wait for Jito RPS slot
  try {
    const tx = await item.buildTx();
    const signature = await sendJitoBundle(tx, item.payer, item.tipMultiplier, item.urgent);
    logger.info(`Queue processed: signature=${signature}, tipMultiplier=${item.tipMultiplier}, retries left=${item.retries}`);
    item.resolve(signature);
  } catch (err) {
    logger.error(`Jito send failed (retries left: ${item.retries}, urgent: ${item.urgent}):`, err);

    if (item.retries > 0) {
      item.retries--;

      const currentTip = await resolveTipLamports(1, item.urgent);
      const maxTipLamports = Math.floor(config.jito.maxTipAmountSol * 1e9);
      const maxPossible = currentTip * config.jito.tipIncreaseFactor;

      if (maxPossible > maxTipLamports) {
        logger.warn('Tip multiplier would exceed maxTipAmountSol, using maximum allowed');
        item.tipMultiplier = maxTipLamports / currentTip;
      } else {
        item.tipMultiplier *= config.jito.tipIncreaseFactor;
      }

      queue.unshift(item);
      setImmediate(() => processQueue());
    } else {
      item.reject(err);
    }
  }
}

async function processQueue() {
  while (queue.length > 0) {
    const item = queue.shift()!;
    limiter(() => processItem(item)).catch(err => logger.error('Unhandled error in processItem:', err));
  }
}

export function queueJitoSend(
  buildTx: () => Promise<VersionedTransaction>,
  payer: Keypair,
  retries: number = config.jito.maxRetries,
  urgent: boolean = false,
  tipMultiplier: number = 1.0  // добавлен параметр
): Promise<string> {
  return new Promise((resolve, reject) => {
    const item: QueueItem = {
      buildTx,
      payer,
      resolve,
      reject,
      retries,
      tipMultiplier,
      urgent,
    };
    if (urgent) queue.unshift(item); else queue.push(item);
    // Для urgent — вызываем немедленно без setImmediate чтобы не терять лишний тик event loop
    if (urgent) {
      processQueue();
    } else {
      setImmediate(processQueue);
    }
  });
}