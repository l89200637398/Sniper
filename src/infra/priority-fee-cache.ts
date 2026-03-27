import { Connection } from '@solana/web3.js';
import { config } from '../config';
import { logger } from '../utils/logger';

let cachedFee = config.priorityFee.defaultMicroLamports;
let updateTimer: NodeJS.Timeout | null = null;
let isRunning = false;

export function startPriorityFeeCache(connection: Connection, intervalMs = config.priorityFee.updateIntervalMs) {
  if (updateTimer) {
    clearTimeout(updateTimer);
    updateTimer = null;
  }
  isRunning = true;

  const update = async () => {
    if (!isRunning) return;

    try {
      const fees = await connection.getRecentPrioritizationFees();
      if (fees.length) {
        const sorted = fees.map(f => f.prioritizationFee).sort((a, b) => a - b);
        const index = Math.floor(sorted.length * (config.priorityFee.percentile / 100));
        cachedFee = sorted[index] || config.priorityFee.defaultMicroLamports;
        logger.debug('Priority fee cache updated:', cachedFee);
      }
    } catch (err) {
      logger.error('Failed to update priority fee cache:', err);
    }

    if (isRunning) {
      updateTimer = setTimeout(update, intervalMs);
    }
  };

  update();
}

export function stopPriorityFeeCache() {
  isRunning = false;
  if (updateTimer) {
    clearTimeout(updateTimer);
    updateTimer = null;
    logger.debug('Priority fee cache stopped');
  }
}

export function getCachedPriorityFee(): number {
  return cachedFee;
}