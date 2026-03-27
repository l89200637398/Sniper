// src/utils/event-logger.ts
import { createWriteStream, mkdirSync } from 'fs';
import { resolve } from 'path';

const LOG_DIR = resolve(process.env.LOG_DIR ?? './logs');
try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {}

const date = new Date().toISOString().slice(0, 10);
const stream = createWriteStream(`${LOG_DIR}/events-${date}.log`, { flags: 'a' });
stream.on('error', (err) => console.error('event-logger error:', err));

export function logEvent(event: string, data: any) {
  const line = `${new Date().toISOString()} ${event} ${JSON.stringify(data)}\n`;
  stream.write(line);
}