/**
 * scripts/control.ts
 *
 * Запуск и остановка снайпера без Telegram-бота.
 *
 * Использование:
 *   npx ts-node scripts/control.ts start    — запустить бота
 *   npx ts-node scripts/control.ts stop     — остановить (Ctrl+C)
 *
 * Бот работает в foreground. Для фоновой работы: screen, tmux или nohup.
 */

import dotenv from 'dotenv';
dotenv.config();

import { Sniper } from '../src/core/sniper';
import { logger } from '../src/utils/logger';

const command = process.argv[2];

if (!command || !['start', 'stop'].includes(command)) {
  console.log('Использование:');
  console.log('  npx ts-node scripts/control.ts start   — запустить снайпер');
  console.log('  npx ts-node scripts/control.ts stop    — (Ctrl+C для остановки)');
  process.exit(0);
}

const sniper = new Sniper();

async function main() {
  if (command === 'start') {
    console.log('🚀 Запуск снайпера (без Telegram)...');
    const result = await sniper.start();
    console.log(`✅ ${result}`);

    if (!result.includes('запущен')) {
      // start failed
      process.exit(1);
    }

    console.log('📡 Снайпер работает. Ctrl+C для остановки.');

    // Keep process alive
    await new Promise<void>(() => {});
  }
}

// Graceful shutdown on Ctrl+C / kill
async function shutdown(signal: string): Promise<void> {
  logger.info(`Shutting down (${signal})...`);
  console.log(`\n🛑 Остановка снайпера (${signal})...`);

  try {
    await Promise.race([
      sniper.stop(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('shutdown timeout 30s')), 30_000)
      ),
    ]);
    console.log('✅ Снайпер остановлен');
  } catch (err) {
    console.error('⚠️  Таймаут остановки:', err);
  }

  process.exit(0);
}

process.once('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });
process.once('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });

main().catch(err => {
  console.error('❌ Ошибка:', err);
  process.exit(1);
});
