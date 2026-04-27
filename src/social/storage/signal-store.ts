// src/social/storage/signal-store.ts
//
// SQLite-бэкенд для social_signals. Использует общий db из src/db/sqlite.ts.
// Миграция/расширение колонок выполняется там же при старте.

import { db } from '../../db/sqlite';
import type { SocialSignal } from '../models/signal';

const INSERT_STMT = db.prepare(`
  INSERT INTO social_signals
    (source, mint, ticker, sentiment, raw_text, author, followers, url, timestamp, created_at, alpha)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
`);

/** Записать один сигнал. rawText обрезается до 500 символов. */
export function saveSignal(s: SocialSignal): void {
  INSERT_STMT.run(
    s.source,
    s.mint ?? null,
    s.ticker ?? null,
    s.sentiment,
    (s.rawText ?? '').slice(0, 500),
    s.author ?? null,
    s.followers ?? null,
    s.url ?? null,
    s.timestamp,
    Date.now(),
    s.alpha ? 1 : 0,
  );
}

export interface StoredSignal extends SocialSignal {
  id: number;
  createdAt: number;
}

/** Последние N сигналов (по timestamp DESC). */
export function getRecentSignals(limit = 50): StoredSignal[] {
  const rows = db.prepare(`
    SELECT id, source, mint, ticker, sentiment, raw_text, author, followers,
           url, timestamp, created_at, alpha
    FROM social_signals
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(limit) as any[];
  return rows.map(rowToSignal);
}

/** Получить сигналы по конкретному mint в временном окне. Используется
 *  аналитикой (корреляция social ↔ trade). */
export function getSignalsForMint(mint: string, fromTs: number, toTs: number): StoredSignal[] {
  const rows = db.prepare(`
    SELECT id, source, mint, ticker, sentiment, raw_text, author, followers,
           url, timestamp, created_at, alpha
    FROM social_signals
    WHERE mint = ? AND timestamp BETWEEN ? AND ?
    ORDER BY timestamp ASC
  `).all(mint, fromTs, toTs) as any[];
  return rows.map(rowToSignal);
}

export interface MentionCount {
  key: string;         // mint или ticker (что было заполнено)
  keyType: 'mint' | 'ticker';
  count: number;
  avgSentiment: number;
  sources: string[];   // уникальные источники
  lastTimestamp: number;
}

/** Агрегат упоминаний в последнем окне (ms). Группирует по mint, если он
 *  известен, иначе по ticker. */
export function getMentionCounts(windowMs: number, limit = 20): MentionCount[] {
  const since = Date.now() - windowMs;

  // Mint-based counts (точнее — если бот достал mint)
  const byMint = db.prepare(`
    SELECT mint AS key, COUNT(*) AS count, AVG(sentiment) AS avg_sent,
           GROUP_CONCAT(DISTINCT source) AS sources, MAX(timestamp) AS last_ts
    FROM social_signals
    WHERE mint IS NOT NULL AND timestamp >= ?
    GROUP BY mint
  `).all(since) as any[];

  // Ticker-based counts (когда нет mint)
  const byTicker = db.prepare(`
    SELECT ticker AS key, COUNT(*) AS count, AVG(sentiment) AS avg_sent,
           GROUP_CONCAT(DISTINCT source) AS sources, MAX(timestamp) AS last_ts
    FROM social_signals
    WHERE mint IS NULL AND ticker IS NOT NULL AND timestamp >= ?
    GROUP BY ticker
  `).all(since) as any[];

  const merged: MentionCount[] = [
    ...byMint.map(r => ({
      key: r.key as string,
      keyType: 'mint' as const,
      count: r.count as number,
      avgSentiment: (r.avg_sent ?? 0) as number,
      sources: (r.sources ?? '').split(',').filter(Boolean),
      lastTimestamp: r.last_ts as number,
    })),
    ...byTicker.map(r => ({
      key: r.key as string,
      keyType: 'ticker' as const,
      count: r.count as number,
      avgSentiment: (r.avg_sent ?? 0) as number,
      sources: (r.sources ?? '').split(',').filter(Boolean),
      lastTimestamp: r.last_ts as number,
    })),
  ];

  merged.sort((a, b) => b.count - a.count || b.lastTimestamp - a.lastTimestamp);
  return merged.slice(0, limit);
}

/** Удалить сигналы старше N ms. Вызывается периодически для контроля размера. */
export function pruneOlderThan(ms: number): number {
  const cutoff = Date.now() - ms;
  const info = db.prepare(`DELETE FROM social_signals WHERE timestamp < ?`).run(cutoff);
  return info.changes;
}

// ── internals ────────────────────────────────────────────────────────────────

function rowToSignal(r: any): StoredSignal {
  return {
    id: r.id,
    source: r.source,
    mint: r.mint ?? undefined,
    ticker: r.ticker ?? undefined,
    sentiment: r.sentiment ?? 0,
    rawText: r.raw_text ?? '',
    author: r.author ?? undefined,
    followers: r.followers ?? undefined,
    url: r.url ?? undefined,
    timestamp: r.timestamp,
    createdAt: r.created_at ?? r.timestamp,
    alpha: r.alpha === 1 || r.alpha === true,
  };
}
