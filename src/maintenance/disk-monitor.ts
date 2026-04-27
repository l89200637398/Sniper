// src/maintenance/disk-monitor.ts
//
// Периодическая проверка свободного места на диске.
// Уведомляет в Telegram при пересечении порогов: 10, 8, 6, 4, 3, 2, 1 GB.
// Каждый порог срабатывает ОДИН раз (до тех пор, пока место не вернётся выше).

import { execSync } from 'child_process';
import { logger } from '../utils/logger';
import { logEvent } from '../utils/event-logger';

const THRESHOLDS_GB = [10, 8, 6, 4, 3, 2, 1];
const CHECK_INTERVAL_MS = Number(process.env.DISK_CHECK_INTERVAL_MS ?? 5 * 60 * 1000);
const MOUNT_POINT = process.env.DISK_MOUNT_POINT ?? '/';

export type NotifyFn = (msg: string) => void;

const alertedThresholds = new Set<number>();
let timer: NodeJS.Timeout | null = null;

function getAvailableGB(): number | null {
  try {
    const out = execSync(`df --output=avail -B1 ${MOUNT_POINT} 2>/dev/null | tail -1`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    const bytes = parseInt(out, 10);
    if (isNaN(bytes)) return null;
    return bytes / (1024 * 1024 * 1024);
  } catch {
    return null;
  }
}

function checkDisk(notify?: NotifyFn): void {
  const availGB = getAvailableGB();
  if (availGB === null) {
    logger.debug('[disk-monitor] failed to read disk space');
    return;
  }

  for (const threshold of THRESHOLDS_GB) {
    if (availGB < threshold && !alertedThresholds.has(threshold)) {
      alertedThresholds.add(threshold);

      const severity = threshold <= 2 ? 'error' : threshold <= 4 ? 'warn' : 'info';
      const emoji = threshold <= 2 ? '🔴' : threshold <= 4 ? '🟠' : '🟡';

      logger.warn(`[disk-monitor] ${emoji} Free space: ${availGB.toFixed(2)} GB (< ${threshold} GB threshold)`);
      logEvent('DISK_SPACE_LOW', { availGB: +availGB.toFixed(2), threshold, mountPoint: MOUNT_POINT }, { severity });

      if (notify) {
        const msg = [
          `${emoji} <b>Disk space alert</b>`,
          ``,
          `Free: <b>${availGB.toFixed(2)} GB</b> (threshold: ${threshold} GB)`,
          `Mount: <code>${MOUNT_POINT}</code>`,
          ``,
          threshold <= 2
            ? `🚨 Критически мало места! Бот может перестать работать.`
            : threshold <= 4
              ? `⚠️ Мало свободного места. Рекомендуется очистка.`
              : `ℹ️ Свободное место заканчивается.`,
        ].join('\n');
        try { notify(msg); } catch { /* swallow */ }
      }
    }
  }

  // Сброс алертов при восстановлении: если место вернулось выше порога
  for (const threshold of [...alertedThresholds]) {
    if (availGB >= threshold + 1) {
      alertedThresholds.delete(threshold);
    }
  }
}

export function startDiskMonitor(notify?: NotifyFn): void {
  if (timer) return;
  checkDisk(notify);
  timer = setInterval(() => checkDisk(notify), CHECK_INTERVAL_MS);
  logger.info(`💾 Disk monitor started: check every ${CHECK_INTERVAL_MS / 1000}s, mount=${MOUNT_POINT}`);
}

export function stopDiskMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
