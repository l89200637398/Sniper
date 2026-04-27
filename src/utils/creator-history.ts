// src/utils/creator-history.ts
//
// Quick Win 1 — Creator History: auto-block serial ruggers based on
// historical trade_pnl_pct from token_metadata (SQLite).
//
// Usage:
//   import { checkCreatorHistory } from '../utils/creator-history';
//   const result = checkCreatorHistory(creator);
//   if (result.shouldBlock) { /* skip entry */ }

import Database from 'better-sqlite3';
import { db } from '../db/sqlite';
import { logger } from './logger';

export interface CreatorHistoryResult {
  rugRate: number;
  totalTokens: number;
  shouldBlock: boolean;
}

// ── In-memory cache with 5-minute TTL ──────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  result: CreatorHistoryResult;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

// Periodic cleanup to prevent unbounded growth (every 10 min)
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
let cleanupTimer: NodeJS.Timeout | null = null;

function ensureCleanupTimer() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (now >= entry.expiresAt) cache.delete(key);
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

// ── Prepared statement (lazy init) ─────────────────────────────────────────
let stmt: Database.Statement | null = null;

function getStmt(): Database.Statement {
  if (!stmt) {
    // Проверяем, существует ли таблица token_metadata
    const tableExists = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='token_metadata'`
    ).get();
    if (!tableExists) {
      throw new Error('token_metadata table not found');
    }
    stmt = db.prepare(`
      SELECT
        COUNT(*)                                              AS total,
        SUM(CASE WHEN trade_pnl_pct < -50 THEN 1 ELSE 0 END) AS rugs
      FROM token_metadata
      WHERE creator = ? AND trade_pnl_pct IS NOT NULL
    `);
  }
  return stmt;
}

// ── Main function ──────────────────────────────────────────────────────────

/**
 * Check creator's historical rug rate from token_metadata.
 *
 * shouldBlock = true when:
 *   - rugRate > 0.7 AND totalTokens >= 3
 *   - OR totalTokens >= 5 AND rugRate > 0.5
 */
export function checkCreatorHistory(creator: string): CreatorHistoryResult {
  if (!creator) {
    return { rugRate: 0, totalTokens: 0, shouldBlock: false };
  }

  // ── Check cache ──
  const now = Date.now();
  const cached = cache.get(creator);
  if (cached && now < cached.expiresAt) {
    return cached.result;
  }

  ensureCleanupTimer();

  // ── Query SQLite ──
  let total = 0;
  let rugs = 0;
  try {
    const row = getStmt().get(creator) as { total: number; rugs: number } | undefined;
    if (row) {
      total = row.total ?? 0;
      rugs = row.rugs ?? 0;
    }
  } catch (err) {
    // If token_metadata table doesn't exist or query fails — graceful fallback
    logger.debug(`[creator-history] SQL error for ${creator.slice(0, 8)}: ${(err as Error).message}`);
    const result: CreatorHistoryResult = { rugRate: 0, totalTokens: 0, shouldBlock: false };
    cache.set(creator, { result, expiresAt: now + CACHE_TTL_MS });
    return result;
  }

  const rugRate = total > 0 ? rugs / total : 0;
  const shouldBlock =
    (rugRate > 0.7 && total >= 3) ||
    (total >= 5 && rugRate > 0.5);

  const result: CreatorHistoryResult = { rugRate, totalTokens: total, shouldBlock };

  if (shouldBlock) {
    logger.warn(
      `🚫 [creator-history] Serial rugger blocked: ${creator.slice(0, 8)} ` +
      `rugRate=${(rugRate * 100).toFixed(0)}% tokens=${total} rugs=${rugs}`
    );
  }

  // ── Store in cache ──
  cache.set(creator, { result, expiresAt: now + CACHE_TTL_MS });

  return result;
}
