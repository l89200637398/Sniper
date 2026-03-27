import { Connection } from '@solana/web3.js';
import { logger } from '../utils/logger';
import { config } from '../config';

let cachedBlockhash = '';
let cachedLastValidBlockHeight = 0;
let cachedTimestamp = 0;
let refreshTimer: NodeJS.Timeout | null = null;
let isRunning = false;
// Храним глобальное соединение для обновлений
let globalConnection: Connection | null = null;

export function startBlockhashCache(connection: Connection, intervalMs = config.blockhashCache.refreshIntervalMs) {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  isRunning = true;
  globalConnection = connection;

  const refresh = async () => {
    if (!isRunning) return;

    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('processed');
      cachedBlockhash = blockhash;
      cachedLastValidBlockHeight = lastValidBlockHeight;
      cachedTimestamp = Date.now();
      logger.debug('Blockhash cache updated');
    } catch (err) {
      logger.error('Blockhash cache refresh error:', err);
    }

    if (isRunning) {
      refreshTimer = setTimeout(refresh, intervalMs);
    }
  };

  refresh();
}

export function stopBlockhashCache() {
  isRunning = false;
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
    logger.debug('Blockhash cache stopped');
  }
  globalConnection = null;
}

/**
 * Возвращает актуальный blockhash.
 * Если кэш старше 500 мс, выполняет синхронное обновление (с ожиданием).
 * При ошибке обновления выбрасывает исключение.
 */
export async function getCachedBlockhash(): Promise<string> {
  if (!globalConnection) throw new Error('Blockhash cache not started');
  if (!cachedBlockhash) throw new Error('Blockhash cache not ready');

  const age = Date.now() - cachedTimestamp;
  if (age > 5000) {
    logger.debug('Blockhash cache stale (>5s), refreshing...');
    try {
      const { blockhash, lastValidBlockHeight } = await globalConnection.getLatestBlockhash('processed');
      cachedBlockhash = blockhash;
      cachedLastValidBlockHeight = lastValidBlockHeight;
      cachedTimestamp = Date.now();
    } catch (err) {
      logger.error('Failed to refresh blockhash on demand:', err);
      throw new Error('Unable to obtain fresh blockhash');
    }
  }
  return cachedBlockhash;
}

export async function getCachedBlockhashWithHeight() {
  const blockhash = await getCachedBlockhash();
  return { blockhash, lastValidBlockHeight: cachedLastValidBlockHeight };
}