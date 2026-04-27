// src/social/watchlist.ts
//
// Ручной alpha-whitelist. Позволяет пометить сигналы как "alpha" по
// совпадению mint / ticker / author со списками из env. SocialManager
// применяет флаг перед сохранением и emit'ом; UI и аналитика могут
// фильтровать/подсвечивать такие сигналы отдельно.
//
// ENV:
//   ALPHA_TICKERS    — CSV, case-insensitive, с/без $. Пример: "SOL,$BONK,wif"
//   ALPHA_MINTS      — CSV, base58 Solana mints (точное совпадение)
//   ALPHA_AUTHORS    — CSV, case-insensitive, c/без @. Пример: "@pumpfun_newpairs,mooncarl_"
//
// Пустые списки → isAlpha() вернёт false для всех. Никакая переменная
// не обязательна — функция работает даже без env вообще.

import type { SocialSignal } from './models/signal';

function parseCsvLower(raw: string | undefined, strip?: RegExp): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map(s => s.trim())
      .map(s => strip ? s.replace(strip, '') : s)
      .map(s => s.toLowerCase())
      .filter(Boolean),
  );
}

function parseCsvCaseSensitive(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
}

// Лениво читаем env при первом вызове и кэшируем — чтобы не парсить
// строки на каждый сигнал. Перезагрузка требует рестарта процесса
// (это и есть смысл "ручного" whitelist'а).
let cache: {
  tickers: Set<string>;
  mints: Set<string>;
  authors: Set<string>;
} | null = null;

function getWatchlist() {
  if (cache) return cache;
  cache = {
    // Тикеры: убираем ведущий $, сравниваем lowercase.
    tickers: parseCsvLower(process.env.ALPHA_TICKERS, /^\$/),
    // Mints: base58 case-sensitive.
    mints:   parseCsvCaseSensitive(process.env.ALPHA_MINTS),
    // Authors: убираем ведущий @, сравниваем lowercase.
    authors: parseCsvLower(process.env.ALPHA_AUTHORS, /^@/),
  };
  return cache;
}

/**
 * Возвращает true, если сигнал попадает хотя бы под один whitelist.
 * Используется в SocialManager перед emit'ом 'signal'.
 */
export function isAlpha(sig: SocialSignal): boolean {
  const wl = getWatchlist();

  if (sig.mint && wl.mints.has(sig.mint)) return true;

  if (sig.ticker) {
    const t = sig.ticker.toLowerCase().replace(/^\$/, '');
    if (wl.tickers.has(t)) return true;
  }

  if (sig.author) {
    const a = sig.author.toLowerCase().replace(/^@/, '');
    if (wl.authors.has(a)) return true;
  }

  return false;
}

/**
 * Диагностика: размеры и содержимое watchlist'а. Логируется на старте
 * SocialManager, чтобы было видно что именно мониторим.
 */
export function describeWatchlist(): string {
  const wl = getWatchlist();
  return `tickers=${wl.tickers.size} mints=${wl.mints.size} authors=${wl.authors.size}`;
}

/** Test helper — сбрасывает кэш. В prod не используется. */
export function _resetWatchlistCache(): void {
  cache = null;
}
