import * as fs from 'fs';
import * as path from 'path';
import { Sniper } from './core/sniper';
import { TelegramBot } from './bot/bot';
import { logger } from './utils/logger';
import { createWebServer } from './web/server';
import { stopSocketHandlers } from './web/ws/events';
import { startMetricsServer, stopMetricsServer } from './utils/metrics';
import { startCleanupWorker, stopCleanupWorker } from './maintenance/cleanup';
import { startDiskMonitor, stopDiskMonitor } from './maintenance/disk-monitor';
import { config } from './config';

console.log('🚀 index.ts started');

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — shutting down:', err);
  process.exit(1);
});

const PID_FILE = path.join(process.cwd(), '.sniper.pid');
try {
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  logger.info(`[pid] wrote ${process.pid} -> ${PID_FILE}`);
} catch (e) {
  logger.warn(`[pid] failed to write ${PID_FILE}: ${(e as Error).message}`);
}

if (config.metrics.enabled) {
  startMetricsServer(config.metrics.port);
}

const sniper = new Sniper();

const { io, httpServer } = createWebServer(sniper);

const bot = new TelegramBot(sniper);

try {
  bot.launch();
  console.log('✅ bot.launch() executed');
} catch (err) {
  console.error('❌ bot.launch() error:', err);
}

const tgNotify = (msg: string) => { bot.sendNotification(msg).catch(() => {}); };

// Cleanup worker: hourly TTL eviction + report generation.
startCleanupWorker(tgNotify);

// Disk space monitor: alerts at 10, 8, 6, 4, 3, 2, 1 GB free.
startDiskMonitor(tgNotify);

// ── Graceful shutdown ──────────────────────────────────────────────────────
async function shutdown(signal: string): Promise<void> {
  logger.info(`Shutting down (${signal})...`);

  stopCleanupWorker();
  stopDiskMonitor();

  try {
    await Promise.race([
      sniper.stop(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('shutdown timeout')), 60_000)
      ),
    ]);
    logger.info('Graceful shutdown complete');
  } catch (err) {
    logger.error('Shutdown error or timeout:', err);
  }

  bot.stop();
  stopSocketHandlers();
  io.close();
  httpServer.close();
  stopMetricsServer();

  try {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  } catch { /* best-effort */ }

  process.exit(0);
}

process.once('SIGINT',  () => { shutdown('SIGINT').catch(() => process.exit(1)); });
process.once('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });