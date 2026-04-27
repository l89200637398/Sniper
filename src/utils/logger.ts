import pino from 'pino';
import { mkdirSync, createWriteStream, statSync, existsSync, renameSync, readdirSync, unlinkSync, WriteStream } from 'fs';
import { resolve, join } from 'path';

const LOG_DIR = resolve(process.env.LOG_DIR ?? './logs');
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

const CONSOLE_LEVEL = (process.env.LOG_LEVEL ?? 'info') as pino.Level;
const FILE_LEVEL    = (process.env.LOG_LEVEL ?? 'info') as pino.Level;

const MAX_BYTES = Number(process.env.BOT_LOG_MAX_BYTES ?? 49 * 1024 * 1024);
const MAX_FILES = Number(process.env.BOT_LOG_MAX_FILES ?? 20);

// ── Size-based rotation ──────────────────────────────────────────────────────
// Keep daily grouping (bot-YYYY-MM-DD.log) + roll over to .1/.2/... when
// a single day's file crosses MAX_BYTES.

const LOG_PREFIX = process.env.BOT_LOG_PREFIX ?? 'bot';

function currentLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(LOG_DIR, `${LOG_PREFIX}-${date}.log`);
}

let currentPath = currentLogPath();
let logFile: WriteStream = createWriteStream(currentPath, { flags: 'a' });
let currentBytes = 0;
try { currentBytes = statSync(currentPath).size; } catch {}

function openNewStream(p: string): WriteStream {
  const s = createWriteStream(p, { flags: 'a' });
  s.on('error', (err) => console.error('logger stream error:', err));
  try { currentBytes = statSync(p).size; } catch { currentBytes = 0; }
  return s;
}

function rotateIfNeeded(nextBytes: number): void {
  const nowPath = currentLogPath();
  if (nowPath !== currentPath) {
    try { logFile.end(); } catch {}
    currentPath = nowPath;
    logFile = openNewStream(currentPath);
    return;
  }
  if (currentBytes + nextBytes < MAX_BYTES) return;

  try { logFile.end(); } catch {}

  let suffix = 1;
  while (existsSync(`${currentPath}.${suffix}`) && suffix < 1000) suffix++;
  try { renameSync(currentPath, `${currentPath}.${suffix}`); } catch {}

  // prune oldest when > MAX_FILES
  try {
    const base = currentPath.split('/').pop() ?? '';
    const dir = currentPath.slice(0, currentPath.length - base.length);
    const siblings = readdirSync(dir)
      .filter(f => f.startsWith(base + '.'))
      .map(f => ({ f, ts: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.ts - a.ts);
    for (let i = MAX_FILES; i < siblings.length; i++) {
      try { unlinkSync(join(dir, siblings[i].f)); } catch {}
    }
  } catch {}

  logFile = openNewStream(currentPath);
}

// ── Noise filter (unchanged) ─────────────────────────────────────────────────
const NOISY_PATTERNS = [
  'Transaction received:',
  'Blockhash cache updated',
  'Priority fee cache updated',
  '[gRPC] Position ',
  '[gRPC] PumpSwap ',
  'getInflightBundleStatuses raw:',
  'Bundle statuses raw ',
  '[scorer]',
];

const filteredFileStream = {
  write(msg: string) {
    for (const pat of NOISY_PATTERNS) {
      if (msg.includes(pat)) return;
    }
    const bytes = Buffer.byteLength(msg);
    rotateIfNeeded(bytes);
    try {
      logFile.write(msg);
      currentBytes += bytes;
    } catch { /* swallow */ }
  }
};

const streams: pino.StreamEntry[] = [
  { stream: filteredFileStream as any, level: FILE_LEVEL },
  { stream: process.stdout,            level: CONSOLE_LEVEL },
];

const pinoLogger = pino(
  {
    level: 'debug',
    timestamp: pino.stdTimeFunctions.isoTime,
    base: undefined,
    formatters: { level: (label) => ({ level: label.toUpperCase() }) },
  },
  pino.multistream(streams)
);

export const logger = {
  info:  (msg: string, ...args: any[]) => pinoLogger.info(msg, ...args),
  error: (msg: string, ...args: any[]) => pinoLogger.error(msg, ...args),
  warn:  (msg: string, ...args: any[]) => pinoLogger.warn(msg, ...args),
  debug: (msg: string, ...args: any[]) => pinoLogger.debug(msg, ...args),
};
