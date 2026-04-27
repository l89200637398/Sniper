// src/maintenance/cleanup.ts
//
// Фоновый worker: раз в час проверяет возраст данных, генерирует отчёт
// по тому, что собирается удалить, сохраняет отчёт в analysis_reports
// (permanent), затем удаляет из БД и ФС.
//
// Никогда не удаляются:
//   - analysis_reports (permanent)
//   - cleanup_log
//   - config_history
//   - пользовательские данные (positions.json, runtime-config.json, wallet-tracker.json)
//
// Удаляются при age > TTL (default 24h):
//   - events старше TTL
//   - token_metadata старше TTL (first_seen_at)
//   - logs/bot-*.log.N с mtime > TTL
//   - logs/events-*.log.N с mtime > TTL
//   - social_signals (уже есть свой 7-day prune, не трогаем)

import { db } from '../db/sqlite';
import { getDossierSummary } from '../db/dossier';
import { logger } from '../utils/logger';
import { logEvent } from '../utils/event-logger';
import * as fs from 'fs';
import * as path from 'path';
import {
  loadTradeEvents,
  filterCloses,
  computeSessionStats,
} from '../analysis/session';
import { generateRecommendations } from '../analysis/recommendations';

const TTL_MS = Number(process.env.CLEANUP_TTL_MS ?? 24 * 60 * 60 * 1000);
const INTERVAL_MS = Number(process.env.CLEANUP_INTERVAL_MS ?? 60 * 60 * 1000);

export interface CleanupReport {
  reportId: number;
  generatedAt: number;
  periodFrom: number;
  periodTo: number;
  tradesTotal: number;
  winRate: number;
  roi: number;
  totalPnl: number;
  recommendations: Array<{ severity: string; title: string; suggestion: string }>;
  dossierSummary: ReturnType<typeof getDossierSummary>;
  bytesFreed: number;
  tokensDeleted: number;
  eventsDeleted: number;
  logFilesDeleted: number;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export type NotifyFn = (msg: string) => void;

export function startCleanupWorker(notify?: NotifyFn): void {
  if (timer) return;
  // First run after 5 min (give the bot a chance to settle)
  timer = setTimeout(() => {
    runCleanup(notify).catch(err => logger.error('cleanup worker failed:', err));
    timer = setInterval(() => {
      runCleanup(notify).catch(err => logger.error('cleanup worker failed:', err));
    }, INTERVAL_MS);
  }, 5 * 60 * 1000);
  logger.info(`🧹 Cleanup worker started: TTL=${TTL_MS / 3600000}h, interval=${INTERVAL_MS / 60000}min`);
}

export function stopCleanupWorker(): void {
  if (timer) {
    clearTimeout(timer);
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Основной цикл: отчёт → удаление. Отчёт создаётся ВСЕГДА,
 * даже если удалять нечего — так мы фиксируем периодические статы.
 */
export async function runCleanup(notify?: NotifyFn): Promise<CleanupReport | null> {
  if (running) {
    logger.warn('cleanup: previous run still in progress, skipping');
    return null;
  }
  running = true;
  const t0 = Date.now();

  try {
    const cutoffTs = Date.now() - TTL_MS;
    const periodFrom = cutoffTs - TTL_MS;  // the 24h window being purged
    const periodTo = cutoffTs;

    // 1. Собираем статы ДО удаления ───────────────────────────────────────
    const logDir = process.env.LOG_DIR ?? path.resolve('./logs');
    let tradesTotal = 0, winRate = 0, roi = 0, totalPnl = 0;
    let recs: Array<{ severity: string; title: string; suggestion: string }> = [];
    let statsJson = '{}';
    try {
      const events = await loadTradeEvents(logDir, { quiet: true });
      const relevant = events.filter((e: any) => e.openedAt === undefined || (e.openedAt >= periodFrom && e.openedAt <= periodTo));
      const closes = filterCloses(relevant);
      const stats = computeSessionStats(closes);
      tradesTotal = stats.total;
      winRate = stats.winRate;
      roi = stats.roi;
      totalPnl = stats.totalPnlSol;
      const recsRaw = generateRecommendations(stats, closes);
      recs = recsRaw.map(r => ({ severity: r.severity, title: r.title, suggestion: r.suggestion }));
      statsJson = JSON.stringify(stats);
    } catch (err) {
      logger.warn('cleanup: session stats failed', err);
    }

    const dossier = getDossierSummary(periodFrom, periodTo);

    // 2. Подсчитываем ресурсы, которые будут освобождены ──────────────────
    const eventsCountRow = db.prepare('SELECT COUNT(*) as n FROM events WHERE ts < ?').get(cutoffTs) as { n: number };
    const eventsCount = eventsCountRow?.n ?? 0;

    const tokensCountRow = db.prepare(
      `SELECT COUNT(*) as n FROM token_metadata WHERE first_seen_at < ?`
    ).get(cutoffTs) as { n: number };
    const tokensCount = tokensCountRow?.n ?? 0;

    // Log files to delete (rotated siblings older than TTL)
    let logFilesToDelete: string[] = [];
    let bytesToFree = 0;
    try {
      if (fs.existsSync(logDir)) {
        const files = fs.readdirSync(logDir);
        for (const f of files) {
          // Only rotated log archives: bot-*.log.N or events-*.log.N
          if (!/\.log\.\d+$/.test(f)) continue;
          const full = path.join(logDir, f);
          const st = fs.statSync(full);
          if (st.mtimeMs < cutoffTs) {
            logFilesToDelete.push(full);
            bytesToFree += st.size;
          }
        }
      }
    } catch (err) {
      logger.warn('cleanup: log file scan failed', err);
    }

    // 3. Сохраняем отчёт ──────────────────────────────────────────────────
    const insertReport = db.prepare(`
      INSERT INTO analysis_reports
        (generated_at, period_from, period_to, trades_total, wins, losses,
         win_rate, roi, total_pnl, total_in, unique_mints, stats_json, recs_json, dossier_summary_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const wins = Math.round(tradesTotal * winRate);
    const losses = tradesTotal - wins;
    const info = insertReport.run(
      Date.now(),
      periodFrom,
      periodTo,
      tradesTotal,
      wins,
      losses,
      winRate,
      roi,
      totalPnl,
      0,
      dossier.totalMints,
      statsJson,
      JSON.stringify(recs),
      JSON.stringify(dossier),
    );
    const reportId = Number(info.lastInsertRowid);

    logEvent('CLEANUP_REPORT_GENERATED', {
      reportId,
      periodFrom,
      periodTo,
      tradesTotal,
      eventsToDelete: eventsCount,
      tokensToDelete: tokensCount,
      logFilesToDelete: logFilesToDelete.length,
      bytesToFree,
    }, { severity: 'info' });

    // 4. Уведомляем (если есть notify) при warning/warn recommendations
    if (notify) {
      const warnings = recs.filter(r => r.severity === 'warn');
      if (warnings.length > 0 || tradesTotal === 0) {
        const lines = [
          `🧹 <b>Cleanup report #${reportId}</b>`,
          `Period: ${new Date(periodFrom).toISOString().slice(0, 16)} — ${new Date(periodTo).toISOString().slice(0, 16)}`,
          `Trades: ${tradesTotal}  WR: ${(winRate * 100).toFixed(1)}%  PnL: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} SOL`,
          `Unique mints: ${dossier.totalMints}`,
          `To free: ${(bytesToFree / 1024 / 1024).toFixed(1)} MB (${logFilesToDelete.length} files) + ${eventsCount} events + ${tokensCount} dossiers`,
        ];
        if (warnings.length > 0) {
          lines.push(``, `⚠️  Warnings:`);
          for (const w of warnings) lines.push(`• ${w.title}: ${w.suggestion}`);
        }
        try { notify(lines.join('\n')); } catch { /* swallow */ }
      }
    }

    // 5. Удаляем ──────────────────────────────────────────────────────────
    const deleteEvents = db.prepare('DELETE FROM events WHERE ts < ?').run(cutoffTs);
    const deleteTokens = db.prepare(
      `DELETE FROM token_metadata WHERE first_seen_at < ? AND status != 'traded'`
    ).run(cutoffTs);
    // Keep 'traded' dossiers longer (they map to trades table) — separate TTL
    const tradedCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const deleteTradedOld = db.prepare(
      `DELETE FROM token_metadata WHERE first_seen_at < ? AND status = 'traded'`
    ).run(tradedCutoff);

    let filesDeleted = 0;
    for (const f of logFilesToDelete) {
      try { fs.unlinkSync(f); filesDeleted++; } catch { /* swallow */ }
    }

    // 6. Audit ────────────────────────────────────────────────────────────
    db.prepare(`
      INSERT INTO cleanup_log (ran_at, tokens_deleted, events_deleted, log_files_deleted, bytes_freed, report_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      Date.now(),
      (deleteTokens.changes ?? 0) + (deleteTradedOld.changes ?? 0),
      deleteEvents.changes ?? 0,
      filesDeleted,
      bytesToFree,
      reportId,
    );

    // Periodic VACUUM to reclaim free pages (weekly)
    try {
      const lastVacuumRow = db.prepare(`SELECT ran_at FROM cleanup_log WHERE bytes_freed > 0 ORDER BY ran_at DESC LIMIT 100`).all() as Array<{ ran_at: number }>;
      if (lastVacuumRow.length === 100 && Date.now() - (lastVacuumRow[99]?.ran_at ?? 0) > 6 * 24 * 60 * 60 * 1000) {
        db.exec('VACUUM');
      }
    } catch { /* swallow */ }

    const report: CleanupReport = {
      reportId,
      generatedAt: Date.now(),
      periodFrom,
      periodTo,
      tradesTotal,
      winRate,
      roi,
      totalPnl,
      recommendations: recs,
      dossierSummary: dossier,
      bytesFreed: bytesToFree,
      tokensDeleted: (deleteTokens.changes ?? 0) + (deleteTradedOld.changes ?? 0),
      eventsDeleted: deleteEvents.changes ?? 0,
      logFilesDeleted: filesDeleted,
    };

    logger.info(
      `🧹 cleanup done in ${Date.now() - t0}ms: report #${reportId}, ` +
      `tokens=-${report.tokensDeleted}, events=-${report.eventsDeleted}, ` +
      `files=-${report.logFilesDeleted}, freed=${(report.bytesFreed / 1024 / 1024).toFixed(1)} MB`
    );

    return report;
  } finally {
    running = false;
  }
}
