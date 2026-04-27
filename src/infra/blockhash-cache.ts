import { Connection } from '@solana/web3.js';
import { logger } from '../utils/logger';
import { config } from '../config';

interface BlockhashInstance {
  connection: Connection;
  blockhash: string;
  lastValidBlockHeight: number;
  timestamp: number;
  intervalId: NodeJS.Timeout | null;
  isRunning: boolean;
}

const instances = new Map<string, BlockhashInstance>();

export function startBlockhashCache(connection: Connection, namespaceOrInterval?: string | number, intervalMs = config.blockhashCache.refreshIntervalMs): void {
  // Resolve overloaded signature: (connection, namespace?, intervalMs?)
  let namespace = 'default';
  let interval = intervalMs;
  if (typeof namespaceOrInterval === 'string') {
    namespace = namespaceOrInterval;
  } else if (typeof namespaceOrInterval === 'number') {
    interval = namespaceOrInterval;
  }

  const existing = instances.get(namespace);
  if (existing) {
    existing.isRunning = false;
    if (existing.intervalId) {
      clearTimeout(existing.intervalId);
    }
  }

  const instance: BlockhashInstance = {
    connection,
    blockhash: '',
    lastValidBlockHeight: 0,
    timestamp: 0,
    intervalId: null,
    isRunning: true,
  };
  instances.set(namespace, instance);

  const refresh = async () => {
    if (!instance.isRunning) return;

    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('processed');
      instance.blockhash = blockhash;
      instance.lastValidBlockHeight = lastValidBlockHeight;
      instance.timestamp = Date.now();
      logger.debug(`[blockhash-cache:${namespace}] updated`);
    } catch (err) {
      logger.error(`[blockhash-cache:${namespace}] refresh error:`, err);
    }

    if (instance.isRunning) {
      instance.intervalId = setTimeout(refresh, interval);
    }
  };

  refresh();
}

export function stopBlockhashCache(namespace = 'default'): void {
  const instance = instances.get(namespace);
  if (!instance) return;

  instance.isRunning = false;
  if (instance.intervalId) {
    clearTimeout(instance.intervalId);
    instance.intervalId = null;
    logger.debug(`[blockhash-cache:${namespace}] stopped`);
  }
  instances.delete(namespace);
}

/**
 * Возвращает актуальный blockhash.
 *
 * EV-FIX: Non-blocking stale blockhash handling.
 * OLD: If cache >5s stale, await RPC call (blocks sell path 1-3s during network congestion).
 * NEW: Return last known blockhash immediately (valid for ~60-90s on Solana),
 *      kick off background refresh. Trading path is never blocked by blockhash fetch.
 *      Only throw if cache is VERY old (>30s) or never initialized.
 */
export async function getCachedBlockhash(namespace = 'default'): Promise<string> {
  const instance = instances.get(namespace);
  if (!instance) throw new Error(`Blockhash cache not started (namespace: ${namespace})`);
  if (!instance.blockhash) throw new Error(`Blockhash cache not ready (namespace: ${namespace})`);

  const age = Date.now() - instance.timestamp;
  if (age > 30000) {
    // Blockhash older than 30s — likely expired (max validity ~90s but risky).
    // Must refresh synchronously as a last resort.
    logger.warn(`[blockhash-cache:${namespace}] critically stale (>30s), synchronous refresh...`);
    try {
      const { blockhash, lastValidBlockHeight } = await instance.connection.getLatestBlockhash('processed');
      instance.blockhash = blockhash;
      instance.lastValidBlockHeight = lastValidBlockHeight;
      instance.timestamp = Date.now();
    } catch (err) {
      logger.error(`[blockhash-cache:${namespace}] failed to refresh on demand:`, err);
      // Still return the old one — it might work (Solana allows ~150 blocks ≈ 60-90s)
      logger.warn(`[blockhash-cache:${namespace}] using stale blockhash (age=${age}ms) as last resort`);
    }
  } else if (age > 2000) {
    // Stale but usable — return immediately, refresh in background.
    // Threshold matches refreshIntervalMs (2s). Blockhash valid ~60-90s on Solana.
    logger.debug(`[blockhash-cache:${namespace}] stale (${age}ms), using cached + background refresh`);
    instance.connection.getLatestBlockhash('processed').then(({ blockhash, lastValidBlockHeight }) => {
      instance.blockhash = blockhash;
      instance.lastValidBlockHeight = lastValidBlockHeight;
      instance.timestamp = Date.now();
    }).catch(err => {
      logger.error(`[blockhash-cache:${namespace}] background refresh failed:`, err);
    });
  }
  return instance.blockhash;
}

export async function getCachedBlockhashWithHeight(namespace = 'default') {
  const instance = instances.get(namespace);
  const blockhash = await getCachedBlockhash(namespace);
  return { blockhash, lastValidBlockHeight: instance!.lastValidBlockHeight };
}
