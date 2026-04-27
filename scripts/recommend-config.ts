#!/usr/bin/env ts-node
/**
 * scripts/recommend-config.ts
 *
 * CLI-обёртка над `src/analysis/recommendations.ts`.
 * Выводит короткую сводку + список рекомендаций по конфигу.
 * Ничего не меняет в config.ts — только советует.
 *
 * Использование:
 *   npx ts-node scripts/recommend-config.ts             # сегодняшний день (UTC)
 *   npx ts-node scripts/recommend-config.ts --full      # все имеющиеся логи
 *   npx ts-node scripts/recommend-config.ts --date 2026-04-15
 *   npx ts-node scripts/recommend-config.ts --json      # машинно-читаемый вывод (cron)
 *
 * Коды возврата:
 *   0 — успех (даже если рекомендаций много, это не ошибка)
 *   1 — ошибка чтения логов / неожиданная ошибка
 *
 * Рассчитан на запуск по cron-у до рестарта бота (каждые 4 часа):
 *   0 star/4 star star star  cd /opt/sniper && npm run recommend >> logs/recommend.log
 *   (замени "star" на астериск в реальной crontab)
 */

import * as path from 'path';
import {
  loadTradeEvents,
  filterCloses,
  computeSessionStats,
} from '../src/analysis/session';
import { generateRecommendations } from '../src/analysis/recommendations';
import {
  formatStatsForCLI,
  formatRecommendationsForCLI,
} from '../src/analysis/format';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const full     = args.includes('--full');
  const asJson   = args.includes('--json');
  const quiet    = args.includes('--quiet'); // только рекомендации, без stats
  const dateFlag = args[args.indexOf('--date') + 1];

  const logDir = process.env.LOG_DIR ?? path.resolve('./logs');
  const today  = new Date().toISOString().slice(0, 10);
  const dateFilter =
    full ? undefined
    : (dateFlag && dateFlag.startsWith('20') ? dateFlag : today);

  const events = await loadTradeEvents(logDir, { dateFilter, quiet: true });
  const closes = filterCloses(events);
  const stats  = computeSessionStats(closes);
  const recs   = generateRecommendations(stats, closes);

  if (asJson) {
    // Минимальный payload для машинных консюмеров (cron / webhook).
    process.stdout.write(JSON.stringify({
      period: dateFilter ?? 'all',
      stats: {
        total: stats.total,
        winRate: stats.winRate,
        totalPnlSol: stats.totalPnlSol,
        roi: stats.roi,
        avgPnlPercent: stats.avgPnlPercent,
        currentStreak: stats.currentStreak,
      },
      recommendations: recs,
    }, null, 2) + '\n');
    return;
  }

  const label = dateFilter ? `Период: ${dateFilter}` : 'Все периоды';
  console.log(`\n  ${label}  |  Логи: ${logDir}`);

  if (!quiet) {
    console.log(formatStatsForCLI(stats));
  }
  console.log(formatRecommendationsForCLI(recs));
}

main().catch(err => {
  console.error('Ошибка:', (err as Error).message);
  process.exit(1);
});
