// src/analysis/format.ts
//
// Форматирование SessionStats + Recommendation[] для двух surface'ов:
//   * Telegram  — HTML (parse_mode: 'HTML'), должно укладываться в 4096 chars.
//   * CLI       — ANSI-цвета + box-drawing, выравнивание по padEnd/padStart.
//
// Логика тут ДОЛЖНА быть чисто форматной: никаких вычислений поверх stats
// и никаких побочных эффектов. Это позволяет unit-тестировать формат
// отдельно от эвристик.

import type { SessionStats } from './session';
import type { Recommendation, Severity } from './recommendations';

// ── ANSI helpers (CLI) ────────────────────────────────────────────────────

const ANSI = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
};

function useColor(): boolean {
  return !!process.stdout.isTTY && !process.env.NO_COLOR;
}

function c(color: keyof typeof ANSI, text: string): string {
  return useColor() ? `${ANSI[color]}${text}${ANSI.reset}` : text;
}

function signColor(n: number, text: string): string {
  if (!useColor()) return text;
  if (n > 0) return `${ANSI.green}${text}${ANSI.reset}`;
  if (n < 0) return `${ANSI.red}${text}${ANSI.reset}`;
  return text;
}

// ── Общие helpers ─────────────────────────────────────────────────────────

function pct(n: number, decimals = 1): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`;
}

function sol(n: number, decimals = 4): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}`;
}

function dur(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const SEV_EMOJI: Record<Severity, string> = {
  info:    'ℹ️',
  suggest: '💡',
  warn:    '⚠️',
};

// ══ Stats → Telegram HTML ═════════════════════════════════════════════════

/**
 * Компактный отчёт для Telegram. HTML-safe (parse_mode: 'HTML').
 * Не делает никаких escape'ов — sessionStats содержит только числа
 * и известные строки (reason / protocol), поэтому XSS не грозит.
 */
export function formatStatsForTG(stats: SessionStats): string {
  if (stats.empty) {
    return '📈 <b>Анализ сессии</b>\n\nНет закрытых сделок в выбранном периоде.';
  }

  const lines: string[] = [];
  lines.push(`📈 <b>Анализ сессии</b>  (${stats.total} сделок)`);
  lines.push('');

  // ── Основное ───────────────────────────────────────────────────────────
  const wrEmoji = stats.winRate >= 0.5 ? '✅' : stats.winRate >= 0.35 ? '🟡' : '🔴';
  const pnlEmoji = stats.totalPnlSol >= 0 ? '📈' : '📉';

  lines.push(`${wrEmoji} WR: <b>${(stats.winRate * 100).toFixed(0)}%</b>  (${stats.wins}/${stats.total})`);
  lines.push(`${pnlEmoji} PnL: <b>${sol(stats.totalPnlSol)} SOL</b>  ROI ${pct(stats.roi * 100, 0)}`);
  lines.push(`💵 Вложено: ${stats.totalInSol.toFixed(3)} SOL`);
  lines.push(`📊 Avg: ${pct(stats.avgPnlPercent, 0)}  ·  пик ${pct(stats.avgPeakPercent, 0)}`);
  lines.push(`⏱ Avg длит-ть: ${dur(stats.avgDurationMs)}`);

  // Streaks
  if (Math.abs(stats.currentStreak) >= 2) {
    const streakEmoji = stats.currentStreak > 0 ? '🔥' : '❄️';
    const sign = stats.currentStreak > 0 ? 'побед' : 'убытков';
    lines.push(`${streakEmoji} Серия: ${Math.abs(stats.currentStreak)} ${sign} подряд`);
  }

  // ── Best/worst ─────────────────────────────────────────────────────────
  if (stats.best && stats.worst && stats.best !== stats.worst) {
    lines.push('');
    lines.push(`🏆 Лучшая: <code>${stats.best.mint.slice(0, 8)}…</code> ` +
               `${pct(stats.best.pnlPercent, 0)} [${stats.best.reason}]`);
    lines.push(`💀 Худшая: <code>${stats.worst.mint.slice(0, 8)}…</code> ` +
               `${pct(stats.worst.pnlPercent, 0)} [${stats.worst.reason}]`);
  }

  // ── Причины закрытия (топ-4) ───────────────────────────────────────────
  if (stats.byReason.length > 0) {
    lines.push('');
    lines.push('<b>Причины exit:</b>');
    for (const r of stats.byReason.slice(0, 4)) {
      const share = (r.share * 100).toFixed(0);
      lines.push(`  ${r.reason} — ${r.count} (${share}%) ${sol(r.pnlSol, 3)}`);
    }
  }

  // ── Протоколы ──────────────────────────────────────────────────────────
  if (stats.byProtocol.length > 1) {
    lines.push('');
    lines.push('<b>По протоколам:</b>');
    for (const p of stats.byProtocol) {
      lines.push(
        `  ${p.protocol}: ${p.count} · WR ${(p.winRate * 100).toFixed(0)}% ` +
        `· PnL ${sol(p.pnlSol, 3)}`,
      );
    }
  }

  // ── Urgent ─────────────────────────────────────────────────────────────
  if (stats.urgentCount > 0) {
    const share = (stats.urgentCount / stats.total * 100).toFixed(0);
    lines.push('');
    lines.push(
      `⚡ Urgent: ${stats.urgentCount}/${stats.total} (${share}%)  ` +
      `PnL ${sol(stats.urgentPnlSol, 3)} SOL`,
    );
  }

  return lines.join('\n');
}

// ══ Stats → CLI (wide, colored) ═══════════════════════════════════════════

const SEP = '─'.repeat(70);
const DSEP = '═'.repeat(70);

export function formatStatsForCLI(stats: SessionStats): string {
  if (stats.empty) {
    return '\nНет закрытых сделок в выбранном периоде.\n';
  }

  const out: string[] = [];

  out.push('');
  out.push(DSEP);
  out.push(`  SOLANA SNIPER BOT — АНАЛИЗ СЕССИИ (${stats.total} сделок)`);
  out.push(DSEP);

  // ── Основное ───────────────────────────────────────────────────────────
  out.push('');
  out.push(`  ${c('bold', '📊 ОБЩАЯ СТАТИСТИКА')}`);
  out.push(SEP);
  out.push(`  Сделок всего : ${stats.total}  (${c('green', `✅ ${stats.wins}`)} / ${c('red', `❌ ${stats.losses}`)})`);
  out.push(`  Win rate     : ${(stats.winRate * 100).toFixed(1)}%`);
  out.push(`  Итого PnL    : ${signColor(stats.totalPnlSol, sol(stats.totalPnlSol) + ' SOL')}  (avg ${signColor(stats.avgPnlPercent, pct(stats.avgPnlPercent))})`);
  out.push(`  Вложено SOL  : ${stats.totalInSol.toFixed(4)} SOL`);
  out.push(`  ROI          : ${signColor(stats.roi, pct(stats.roi * 100))}`);
  out.push(`  Avg выигрыш  : ${c('green', pct(stats.avgWinPercent))}`);
  out.push(`  Avg проигрыш : ${c('red', pct(stats.avgLossPercent))}`);
  out.push(`  Avg пиковый  : ${pct(stats.avgPeakPercent)}`);
  out.push(`  Peak→Close   : ${pct(stats.peakToCloseRatio)} потери от пика`);
  out.push(`  Avg длит-ть  : ${dur(stats.avgDurationMs)}`);

  // ── Streaks ────────────────────────────────────────────────────────────
  out.push('');
  out.push(`  ${c('bold', '🔥 СЕРИИ')}`);
  out.push(SEP);
  out.push(`  Макс. побед подряд  : ${c('green', String(stats.maxWinStreak))}`);
  out.push(`  Макс. убытков подряд: ${c('red', String(stats.maxLossStreak))}`);
  const curStreakStr = stats.currentStreak > 0
    ? c('green', `${stats.currentStreak} побед`)
    : stats.currentStreak < 0
      ? c('red', `${-stats.currentStreak} убытков`)
      : '—';
  out.push(`  Текущая серия       : ${curStreakStr}`);

  // ── Best/worst ─────────────────────────────────────────────────────────
  if (stats.best && stats.worst) {
    out.push('');
    out.push(`  ${c('bold', '🏆 ЛУЧШИЕ / ХУДШИЕ')}`);
    out.push(SEP);
    out.push(
      `  Лучшая  : ${stats.best.mint.slice(0, 8)}…  ` +
      `${signColor(stats.best.pnlPercent, pct(stats.best.pnlPercent))}  ` +
      `${dur(stats.best.durationMs)}  [${stats.best.reason}]`,
    );
    out.push(
      `  Худшая  : ${stats.worst.mint.slice(0, 8)}…  ` +
      `${signColor(stats.worst.pnlPercent, pct(stats.worst.pnlPercent))}  ` +
      `${dur(stats.worst.durationMs)}  [${stats.worst.reason}]`,
    );
  }

  // ── Причины ────────────────────────────────────────────────────────────
  if (stats.byReason.length > 0) {
    out.push('');
    out.push(`  ${c('bold', '🔍 ПРИЧИНЫ ЗАКРЫТИЯ')}`);
    out.push(SEP);
    for (const r of stats.byReason) {
      const bar = '█'.repeat(Math.min(Math.round(r.share * 30), 30));
      out.push(
        `  ${r.reason.padEnd(18)} ${String(r.count).padStart(3)} ` +
        `${bar.padEnd(30)} ${signColor(r.pnlSol, sol(r.pnlSol, 4) + ' SOL')}`,
      );
    }
  }

  // ── Протоколы ──────────────────────────────────────────────────────────
  if (stats.byProtocol.length > 0) {
    out.push('');
    out.push(`  ${c('bold', '🌐 ПО ПРОТОКОЛУ')}`);
    out.push(SEP);
    for (const p of stats.byProtocol) {
      out.push(
        `  ${p.protocol.padEnd(14)} ${String(p.count).padStart(3)} сделок  ` +
        `WR=${(p.winRate * 100).toFixed(0).padStart(3)}%  ` +
        `PnL=${signColor(p.pnlSol, sol(p.pnlSol, 4) + ' SOL')}`,
      );
    }
  }

  // ── По часам (UTC) ─────────────────────────────────────────────────────
  if (stats.byHour.length > 0) {
    out.push('');
    out.push(`  ${c('bold', '🕐 ПО ЧАСАМ (UTC)')}`);
    out.push(SEP);
    const maxCount = Math.max(...stats.byHour.map(h => h.count), 1);
    for (const h of stats.byHour) {
      const bar = '█'.repeat(Math.round((h.count / maxCount) * 20));
      out.push(
        `  ${String(h.hour).padStart(2, '0')}:00  ` +
        `${String(h.count).padStart(3)}  ${bar.padEnd(20)}  ` +
        `WR=${(h.winRate * 100).toFixed(0).padStart(3)}%  ` +
        `PnL=${signColor(h.pnlSol, sol(h.pnlSol, 4))}`,
      );
    }
  }

  // ── Urgent ─────────────────────────────────────────────────────────────
  out.push('');
  out.push(`  ${c('bold', '⚡ URGENT ПРОДАЖИ')}`);
  out.push(SEP);
  const urgShare = stats.total > 0
    ? ((stats.urgentCount / stats.total) * 100).toFixed(0)
    : '0';
  out.push(`  Всего urgent: ${stats.urgentCount}  (${urgShare}% от всех)`);
  if (stats.urgentCount > 0) {
    out.push(`  Их суммарный PnL: ${signColor(stats.urgentPnlSol, sol(stats.urgentPnlSol, 4) + ' SOL')}`);
  }

  out.push('');
  out.push(DSEP);
  out.push('');

  return out.join('\n');
}

// ══ Recommendations → Telegram HTML ═══════════════════════════════════════

export function formatRecommendationsForTG(recs: Recommendation[]): string {
  if (recs.length === 0) {
    return '⚙️ <b>Рекомендации</b>\n\nНет данных для анализа.';
  }

  const lines: string[] = [];
  lines.push('⚙️ <b>Рекомендации по конфигу</b>');
  lines.push('');

  for (const r of recs) {
    lines.push(`${SEV_EMOJI[r.severity]} <b>${r.title}</b>`);
    lines.push(`<i>${r.rationale}</i>`);
    lines.push(`→ ${r.suggestion}`);
    lines.push('');
  }

  // Напоминание: TG read-only
  lines.push('<i>⚠ Изменения применяй вручную в config.ts на сервере.</i>');

  // Telegram HTML parse-limit: 4096 chars. Если вылезаем — режем посередине.
  const joined = lines.join('\n');
  if (joined.length > 4000) {
    return joined.slice(0, 3900) + '\n\n<i>... (сокращено, запусти CLI для полного отчёта)</i>';
  }
  return joined;
}

// ══ Recommendations → CLI ═════════════════════════════════════════════════

const SEV_CLI: Record<Severity, { icon: string; color: keyof typeof ANSI }> = {
  info:    { icon: 'ℹ️ ', color: 'cyan' },
  suggest: { icon: '💡', color: 'yellow' },
  warn:    { icon: '⚠️ ', color: 'red' },
};

export function formatRecommendationsForCLI(recs: Recommendation[]): string {
  const out: string[] = [];

  out.push('');
  out.push(DSEP);
  out.push(`  РЕКОМЕНДАЦИИ ПО КОНФИГУ  (${recs.length})`);
  out.push(DSEP);
  out.push('');

  if (recs.length === 0) {
    out.push('  Нет данных для анализа.');
    out.push('');
    return out.join('\n');
  }

  for (const r of recs) {
    const sev = SEV_CLI[r.severity];
    out.push(`  ${sev.icon} ${c(sev.color, c('bold', r.title))}`);
    out.push(`     ${c('dim', r.rationale)}`);
    out.push(`     → ${r.suggestion}`);
    out.push('');
  }

  out.push(`  ${c('dim', 'Применение — вручную в config.ts. Бот конфиг сам не трогает.')}`);
  out.push('');
  out.push(DSEP);
  out.push('');

  return out.join('\n');
}
