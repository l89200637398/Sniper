import { VersionedTransaction, Keypair } from '@solana/web3.js';
import { sendJitoBundle, resolveTipLamports } from '../jito/bundle';
import { logger } from '../utils/logger';
import { config } from '../config';
import pLimit from 'p-limit';

// ── Token-bucket rate limiter для Jito RPS ──────────────────────────
// Jito лимит: 10 RPS. Мы целимся в 10 RPS, допуская редкие burst до 11.
// Token bucket: 10 токенов/сек, burst capacity 10 (1 секунда буфера).
const JITO_MAX_RPS     = 10;
const BUCKET_CAPACITY  = 10;  // макс. накопленных токенов (burst size)
const REFILL_INTERVAL  = 1000 / JITO_MAX_RPS; // 100мс — интервал между токенами

let tokens       = BUCKET_CAPACITY;
let lastRefill   = Date.now();

function refillTokens(): void {
  const now = Date.now();
  const elapsed = now - lastRefill;
  const newTokens = elapsed / REFILL_INTERVAL;
  if (newTokens >= 1) {
    tokens = Math.min(BUCKET_CAPACITY, tokens + newTokens);
    lastRefill = now;
  }
}

function acquireToken(): Promise<void> {
  refillTokens();
  if (tokens >= 1) {
    tokens -= 1;
    return Promise.resolve();
  }
  // Ждём до следующего токена
  const waitMs = Math.ceil(REFILL_INTERVAL * (1 - tokens));
  return new Promise(resolve => setTimeout(() => {
    refillTokens();
    tokens = Math.max(0, tokens - 1);
    resolve();
  }, waitMs));
}

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
  await acquireToken(); // rate-limit: wait for Jito RPS slot
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