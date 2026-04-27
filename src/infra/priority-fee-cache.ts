import { Connection } from '@solana/web3.js';
import { config } from '../config';
import { logger } from '../utils/logger';

interface PriorityFeeInstance {
  fee: number;
  intervalId: NodeJS.Timeout | null;
  isRunning: boolean;
}

const instances = new Map<string, PriorityFeeInstance>();

export function startPriorityFeeCache(connection: Connection, namespaceOrInterval?: string | number, intervalMs = config.priorityFee.updateIntervalMs): void {
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

  const instance: PriorityFeeInstance = {
    fee: config.priorityFee.defaultMicroLamports,
    intervalId: null,
    isRunning: true,
  };
  instances.set(namespace, instance);

  const update = async () => {
    if (!instance.isRunning) return;

    try {
      const fees = await connection.getRecentPrioritizationFees();
      if (fees.length) {
        const sorted = fees.map(f => f.prioritizationFee).sort((a, b) => a - b);
        const index = Math.floor(sorted.length * (config.priorityFee.percentile / 100));
        instance.fee = sorted[index] || config.priorityFee.defaultMicroLamports;
        logger.debug(`[priority-fee-cache:${namespace}] updated:`, instance.fee);
      }
    } catch (err) {
      logger.error(`[priority-fee-cache:${namespace}] failed to update:`, err);
    }

    if (instance.isRunning) {
      instance.intervalId = setTimeout(update, interval);
    }
  };

  update();
}

export function stopPriorityFeeCache(namespace = 'default'): void {
  const instance = instances.get(namespace);
  if (!instance) return;

  instance.isRunning = false;
  if (instance.intervalId) {
    clearTimeout(instance.intervalId);
    instance.intervalId = null;
    logger.debug(`[priority-fee-cache:${namespace}] stopped`);
  }
  instances.delete(namespace);
}

export function getCachedPriorityFee(namespace = 'default'): number {
  const instance = instances.get(namespace);
  if (!instance) return config.priorityFee.defaultMicroLamports;
  return instance.fee;
}
