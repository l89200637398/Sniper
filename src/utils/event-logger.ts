// src/utils/event-logger.ts
//
// Structured event logger: записывает значимые события в SQLite `events`
// таблицу + (опционально) зеркалит в файл для live-tail отладки.
//
// Зачем БД: быстрые индексированные query по mint/type/ts, TTL-cleanup,
// корреляция с token_metadata / trades / social_signals.
//
// Зачем файл: `tail -f`, sharing, backward-compat с analyze-trades.ts.
// Файл ротируется по размеру (49 MB per EVENT_LOG_MAX_BYTES).

import { createWriteStream, mkdirSync, statSync, renameSync, existsSync, readdirSync, unlinkSync, WriteStream } from 'fs';
import { resolve, join } from 'path';

const LOG_DIR = resolve(process.env.LOG_DIR ?? './logs');
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

const MAX_BYTES = Number(process.env.EVENT_LOG_MAX_BYTES ?? 49 * 1024 * 1024);
const MAX_FILES = Number(process.env.EVENT_LOG_MAX_FILES ?? 20);

function currentLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(LOG_DIR, `events-${date}.log`);
}

let stream: WriteStream | null = null;
let currentPath: string = currentLogPath();
let currentBytes: number = 0;

function openStream(p: string): WriteStream {
  const s = createWriteStream(p, { flags: 'a' });
  s.on('error', (err) => console.error('event-logger error:', err));
  try {
    currentBytes = statSync(p).size;
  } catch { currentBytes = 0; }
  return s;
}

stream = openStream(currentPath);

function rotateIfNeeded(nextLineBytes: number): void {
  // Date change → open new daily file
  const nowPath = currentLogPath();
  if (nowPath !== currentPath) {
    try { stream?.end(); } catch {}
    currentPath = nowPath;
    stream = openStream(currentPath);
    return;
  }
  // Size limit → rotate suffix .1, .2, ...
  if (currentBytes + nextLineBytes < MAX_BYTES) return;

  try { stream?.end(); } catch {}

  // find next available suffix
  let suffix = 1;
  while (existsSync(`${currentPath}.${suffix}`) && suffix < 1000) suffix++;
  try { renameSync(currentPath, `${currentPath}.${suffix}`); } catch {}

  // prune oldest if > MAX_FILES
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

  stream = openStream(currentPath);
}

let lastEventTs = Date.now();
const SILENCE_THRESHOLD_MS = 5 * 60 * 1000;
let silenceAlerted = false;

// ── Lazy DB: позволяет event-logger работать без БД в unit-тестах ─────────
type DbInsertFn = (ts: number, type: string, mint: string | null, protocol: string | null, severity: string, data: string) => void;
let dbInsert: DbInsertFn | null = null;
let dbInsertTried = false;

function getDbInsert(): DbInsertFn | null {
  if (dbInsertTried) return dbInsert;
  dbInsertTried = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { db } = require('../db/sqlite');
    const stmt = db.prepare(`INSERT INTO events (ts, type, mint, protocol, severity, data) VALUES (?, ?, ?, ?, ?, ?)`);
    dbInsert = (ts, type, mint, proto, sev, data) => {
      try { stmt.run(ts, type, mint, proto, sev, data); } catch { /* swallow */ }
    };
  } catch {
    dbInsert = null;
  }
  return dbInsert;
}

export interface EventOptions {
  severity?: 'debug' | 'info' | 'warn' | 'error';
  mint?: string;
  protocol?: string;
}

export function logEvent(event: string, data: any, opts: EventOptions = {}): void {
  lastEventTs = Date.now();
  silenceAlerted = false;

  const ts = Date.now();
  const mint = opts.mint ?? (data && typeof data === 'object' ? data.mint : undefined) ?? null;
  const protocol = opts.protocol ?? (data && typeof data === 'object' ? data.protocol : undefined) ?? null;
  const severity = opts.severity ?? 'info';

  const jsonData = safeStringify(data);

  // 1. DB insert (async-safe via better-sqlite3 sync stmts; it's fast, never blocks event loop noticeably)
  const ins = getDbInsert();
  if (ins) ins(ts, event, mint, protocol, severity, jsonData);

  // 2. File mirror (backward compat + live tail)
  const line = `${new Date(ts).toISOString()} ${event} ${jsonData}\n`;
  const bytes = Buffer.byteLength(line);
  rotateIfNeeded(bytes);
  try {
    stream?.write(line);
    currentBytes += bytes;
  } catch { /* swallow */ }
}

function safeStringify(obj: any): string {
  try {
    return JSON.stringify(obj, (_, v) => typeof v === 'bigint' ? v.toString() : v);
  } catch {
    return '{}';
  }
}

export function getLastEventTs(): number { return lastEventTs; }

export function checkSilence(): boolean {
  if (Date.now() - lastEventTs > SILENCE_THRESHOLD_MS && !silenceAlerted) {
    silenceAlerted = true;
    logEvent('SENTINEL_SILENCE', { silenceMs: Date.now() - lastEventTs }, { severity: 'warn' });
    return true;
  }
  return false;
}
