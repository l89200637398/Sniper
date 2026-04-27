// src/core/blacklist-store.ts
//
// JSON-персистентность для F7 blacklist (`data/blacklist.json`).
//
// Архитектура: один файл, который читают и Sniper, и CLI. Sniper
// держит in-memory копию и перечитывает файл с интервалом (см. polling
// в sniper.ts), чтобы изменения из CLI применялись без рестарта бота.
//
// Формат файла:
//   {
//     "tokens":   ["mint1", "mint2", ...],
//     "creators": ["creator1", ...],
//     "updatedAt": 1712345678901
//   }
//
// Атомарность записи: пишем в .tmp, потом rename — POSIX atomic.
// При повреждённом / отсутствующем файле возвращается пустой набор.

import * as fs from 'fs';
import * as path from 'path';

export const BLACKLIST_FILE = path.join(process.cwd(), 'data', 'blacklist.json');

export interface BlacklistData {
  tokens: Set<string>;
  creators: Set<string>;
  /** mtime файла на момент чтения (epoch ms). Используется для polling-reload. */
  loadedAt: number;
}

interface BlacklistJson {
  tokens?: string[];
  creators?: string[];
  updatedAt?: number;
}

function ensureDataDir(): void {
  const dir = path.dirname(BLACKLIST_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Читает blacklist из файла. Если файла нет или он повреждён —
 * возвращает пустые наборы (не бросает).
 */
export function loadBlacklist(): BlacklistData {
  try {
    if (!fs.existsSync(BLACKLIST_FILE)) {
      return { tokens: new Set(), creators: new Set(), loadedAt: 0 };
    }
    const raw = fs.readFileSync(BLACKLIST_FILE, 'utf8');
    const parsed = JSON.parse(raw) as BlacklistJson;
    const stat = fs.statSync(BLACKLIST_FILE);
    return {
      tokens: new Set(Array.isArray(parsed.tokens) ? parsed.tokens : []),
      creators: new Set(Array.isArray(parsed.creators) ? parsed.creators : []),
      loadedAt: stat.mtimeMs,
    };
  } catch {
    // Битый JSON — лучше пустой список, чем падение бота на старте.
    return { tokens: new Set(), creators: new Set(), loadedAt: 0 };
  }
}

/**
 * Атомарная запись. Пишем .tmp в той же директории, потом rename.
 */
export function saveBlacklist(tokens: Set<string>, creators: Set<string>): void {
  ensureDataDir();
  const payload: BlacklistJson = {
    tokens: [...tokens].sort(),
    creators: [...creators].sort(),
    updatedAt: Date.now(),
  };
  const tmp = `${BLACKLIST_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, BLACKLIST_FILE);
}

/**
 * Возвращает mtime файла или 0 если файла нет. Дешёвая операция —
 * Sniper использует её для polling-reload (если mtime изменился —
 * перечитываем).
 */
export function getBlacklistMtime(): number {
  try {
    return fs.statSync(BLACKLIST_FILE).mtimeMs;
  } catch {
    return 0;
  }
}
