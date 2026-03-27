import { Sniper } from './core/sniper';
import { TelegramBot } from './bot/bot';
import { logger } from './utils/logger';

console.log('🚀 index.ts started');

const sniper = new Sniper();
const bot = new TelegramBot(sniper);

try {
  bot.launch();
  console.log('✅ bot.launch() executed');
} catch (err) {
  console.error('❌ bot.launch() error:', err);
}

// ── Graceful shutdown ──────────────────────────────────────────────────────
//
// ИСПРАВЛЕНО: process.exit(0) вызывался синхронно, прерывая async closeAllPositions()
// внутри sniper.stop(). Это означало что sell-транзакции не успевали отправиться.
//
// Новый порядок:
//  1. bot.stop() — синхронный, отключает Telegram polling
//  2. await sniper.stop() — async: закрывает все позиции, ждёт подтверждений
//  3. process.exit(0) — только после завершения всех продаж
//
// Таймаут 30 секунд: если closeAllPositions зависла (RPC недоступен),
// принудительно выходим чтобы не висеть вечно.

async function shutdown(signal: string): Promise<void> {
  logger.info(`Shutting down (${signal})...`);

  bot.stop();

  try {
    await Promise.race([
      sniper.stop(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('shutdown timeout')), 30_000)
      ),
    ]);
    logger.info('Graceful shutdown complete');
  } catch (err) {
    logger.error('Shutdown error or timeout:', err);
  }

  process.exit(0);
}

process.once('SIGINT',  () => { shutdown('SIGINT').catch(() => process.exit(1)); });
process.once('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
