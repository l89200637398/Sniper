import pino from 'pino';
import { mkdirSync, createWriteStream } from 'fs';
import { resolve } from 'path';

const LOG_DIR = resolve(process.env.LOG_DIR ?? './logs');
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

const CONSOLE_LEVEL = (process.env.LOG_LEVEL ?? 'info') as pino.Level;
const FILE_LEVEL    = (process.env.LOG_LEVEL ?? 'info') as pino.Level;

const logFile = createWriteStream(
  `${LOG_DIR}/bot-${new Date().toISOString().slice(0,10)}.log`,
  { flags: 'a' }
);

// Кастомный фильтр для файла: пропускаем шумные DEBUG-сообщения даже если уровень debug
const NOISY_PATTERNS = [
  'Transaction received:',
  'Blockhash cache updated',
  'Priority fee cache updated',
];

const filteredFileStream = {
  write(msg: string) {
    for (const pat of NOISY_PATTERNS) {
      if (msg.includes(pat)) return;
    }
    logFile.write(msg);
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
