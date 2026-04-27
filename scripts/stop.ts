// scripts/stop.ts
//
// Аккуратно останавливает работающий снайпер через SIGTERM по PID-файлу.
// PID пишется в .sniper.pid при старте src/index.ts.
//
// Использование:
//   npm run stop                 — graceful shutdown (SIGTERM + ждать до 35с)
//   npm run stop -- --force      — после таймаута убить через SIGKILL
//
// Без npm:
//   npx ts-node scripts/stop.ts [--force]
//
// Что делает:
//   1. Читает PID из .sniper.pid (если файла нет — exit 0 без ошибки).
//   2. Проверяет что процесс жив (kill -0).
//   3. Шлёт SIGTERM → src/index.ts:shutdown() закрывает позиции (до 30с).
//   4. Polls пока процесс жив, до 35 секунд.
//   5. Если --force и процесс ещё жив — шлёт SIGKILL.
//   6. Удаляет stale PID-файл если процесс уже мёртв.

import * as fs from 'fs';
import * as path from 'path';

const PID_FILE = path.join(process.cwd(), '.sniper.pid');
const POLL_INTERVAL_MS = 500;
const SHUTDOWN_TIMEOUT_MS = 35_000;

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM'; // exists but no permission
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const force = process.argv.includes('--force');

  if (!fs.existsSync(PID_FILE)) {
    console.log(`Нет PID-файла (${PID_FILE}) — снайпер, похоже, не запущен.`);
    process.exit(0);
  }

  const pidStr = fs.readFileSync(PID_FILE, 'utf8').trim();
  const pid = parseInt(pidStr, 10);

  if (!Number.isFinite(pid) || pid <= 0) {
    console.error(`Битый PID-файл: "${pidStr}". Удаляю.`);
    fs.unlinkSync(PID_FILE);
    process.exit(1);
  }

  if (!isRunning(pid)) {
    console.log(`Процесс PID=${pid} уже не работает. Удаляю stale PID-файл.`);
    try { fs.unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  }

  console.log(`Отправляю SIGTERM процессу PID=${pid}...`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e: any) {
    console.error(`Не удалось послать SIGTERM: ${e.message}`);
    process.exit(1);
  }

  // Wait up to SHUTDOWN_TIMEOUT_MS for graceful exit.
  console.log(`Жду graceful shutdown (до ${SHUTDOWN_TIMEOUT_MS / 1000}с)...`);
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (!isRunning(pid)) {
      console.log('✅ Снайпер остановлен.');
      // PID-файл должен был удалиться сам в shutdown(), но на всякий случай:
      if (fs.existsSync(PID_FILE)) {
        try { fs.unlinkSync(PID_FILE); } catch {}
      }
      process.exit(0);
    }
  }

  // Timed out.
  if (force) {
    console.warn('⚠ Таймаут — посылаю SIGKILL.');
    try { process.kill(pid, 'SIGKILL'); } catch {}
    await sleep(500);
    if (fs.existsSync(PID_FILE)) {
      try { fs.unlinkSync(PID_FILE); } catch {}
    }
    if (isRunning(pid)) {
      console.error(`Не удалось убить PID=${pid}. Проверь вручную: ps -p ${pid}`);
      process.exit(1);
    }
    console.log('✅ Процесс убит через SIGKILL.');
    process.exit(0);
  } else {
    console.error(
      `❌ Таймаут (${SHUTDOWN_TIMEOUT_MS / 1000}с). Процесс PID=${pid} ещё живой.\n` +
      `   Запусти повторно с --force чтобы убить через SIGKILL:\n` +
      `       npm run stop -- --force`
    );
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('❌ stop.ts failed:', err);
  process.exit(1);
});
