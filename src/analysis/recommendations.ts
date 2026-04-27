// src/analysis/recommendations.ts
//
// Эвристики на основе SessionStats — возвращают типизированные
// рекомендации по конфигу. НИЧЕГО не применяют автоматически.
//
// Правила сознательно консервативны: редкая выборка (< MIN_SAMPLE)
// → ничего не рекомендуем, чтобы не дёргать оператора шумом.

import type { SessionStats, TradeClose } from './session';

/** Минимальный размер выборки для большинства правил. */
export const MIN_SAMPLE = 5;
/** Окно для правила «высокая доля stop_loss». */
export const FAST_STOP_LOSS_MS = 10_000;

export type Severity = 'info' | 'suggest' | 'warn';

export interface Recommendation {
  /** Стабильный ID — для cron-friendly логирования. */
  id: string;
  severity: Severity;
  /** Короткий заголовок для TG/CLI. */
  title: string;
  /** Объяснение: какие данные привели к этому совету. */
  rationale: string;
  /** Конкретный совет — какой параметр в config.ts трогать и куда. */
  suggestion: string;
}

interface RuleContext {
  stats: SessionStats;
  closes: TradeClose[];
}

type Rule = (ctx: RuleContext) => Recommendation | null;

// ── Правила ──────────────────────────────────────────────────────────────

const fastStopLoss: Rule = ({ stats, closes }) => {
  const stops = closes.filter(t => t.reason === 'stop_loss');
  if (stops.length === 0) return null;
  const avgDur = stops.reduce((s, t) => s + t.durationMs, 0) / stops.length;
  if (stops.length / stats.total > 0.4 && avgDur < FAST_STOP_LOSS_MS) {
    return {
      id: 'fast_stop_loss_rate',
      severity: 'warn',
      title: 'Много быстрых stop_loss',
      rationale:
        `${stops.length}/${stats.total} (${(stops.length / stats.total * 100).toFixed(0)}%) ` +
        `закрытий — stop_loss, средняя длительность ${(avgDur / 1000).toFixed(1)}s (< 10s). ` +
        `Похоже что SL срабатывает на первом тике, ещё до формирования тренда.`,
      suggestion:
        'Ослабить stop-loss: config.strategy.pumpFun.exit.entryStopLossPercent ' +
        '15 → 18 (или +3pp от текущего). Также проверить trailingActivationPercent ' +
        '— возможно слишком рано активируется.',
    };
  }
  return null;
};

const velocityTooAggressive: Rule = ({ stats, closes }) => {
  const vel = closes.filter(t => t.reason === 'velocity_drop');
  if (vel.length === 0) return null;
  if (vel.length / stats.total > 0.3) {
    const avgPnl = vel.reduce((s, t) => s + t.pnlPercent, 0) / vel.length;
    if (avgPnl > -5) {
      return {
        id: 'velocity_too_aggressive',
        severity: 'suggest',
        title: 'velocity_drop часто срабатывает в профите',
        rationale:
          `${vel.length}/${stats.total} закрытий — velocity_drop, средний PnL ${avgPnl.toFixed(1)}%. ` +
          'Правило ловит "дыхание", а не настоящий разворот.',
        suggestion:
          'Смягчить: velocityDropPercent с текущих ~14% поднять до 18–20%, ' +
          'или увеличить velocityWindowMs с 500ms до 700–800ms.',
      };
    }
  }
  return null;
};

const trailingTooEarly: Rule = ({ stats }) => {
  // Avg peak >> avg close при небольшой выборке — классический признак:
  // trailing drawdown слишком узкий, руинит большие winner'ы.
  if (stats.avgPeakPercent > 60 && stats.avgPnlPercent < 20) {
    return {
      id: 'trailing_too_tight',
      severity: 'warn',
      title: 'Trailing stop режет runners',
      rationale:
        `Средний пик сделки: +${stats.avgPeakPercent.toFixed(0)}%, средний итог: ` +
        `${stats.avgPnlPercent >= 0 ? '+' : ''}${stats.avgPnlPercent.toFixed(0)}%. ` +
        `Отдаём ${stats.peakToCloseRatio.toFixed(0)}pp прибыли по trailing.`,
      suggestion:
        'Расширить trailingDrawdownPercent на +3…5pp (например 9 → 13). ' +
        'Или поднять trailingActivationPercent, чтобы trailing включался позже.',
    };
  }
  return null;
};

const partialsNotEnough: Rule = ({ closes }) => {
  const withPartials = closes.filter(t => t.partialSells > 0);
  if (withPartials.length < 3) return null;
  const losers = withPartials.filter(t => t.pnlSol < 0);
  if (losers.length / withPartials.length > 0.5) {
    return {
      id: 'partials_too_small',
      severity: 'suggest',
      title: 'TP-уровни берут слишком мало',
      rationale:
        `${losers.length}/${withPartials.length} сделок с частичной фиксацией всё равно ` +
        'закрылись в минус. TP-уровни снимают недостаточно, остаток тонет.',
      suggestion:
        'Увеличить portion на первых TP-уровнях (например 1-й TP: 0.20 → 0.30, ' +
        '2-й TP: 0.20 → 0.25). Сейчас runner reserve 35% — можно уменьшить до 25–30%.',
    };
  }
  return null;
};

const lossStreakWarning: Rule = ({ stats }) => {
  if (stats.currentStreak <= -3) {
    return {
      id: 'loss_streak',
      severity: 'warn',
      title: `Серия убытков: ${-stats.currentStreak} подряд`,
      rationale:
        `Последние ${-stats.currentStreak} сделок закрыты в минус подряд. ` +
        `В коде уже есть defensive mode (loss pause 15 min), но если серия продолжается — ` +
        'фильтры слишком мягкие.',
      suggestion:
        'Активировать defensive mode вручную на сутки: ' +
        'понизить config.strategy.pumpFun.entryAmountSol с 0.07 до 0.05, ' +
        'и temporarily повысить minTokenScore. После 2-3 winner\'ов — откатить.',
    };
  }
  return null;
};

const worstHourOfDay: Rule = ({ stats }) => {
  if (stats.byHour.length < 6) return null; // мало данных по часам
  // Находим час с наихудшим WR среди тех где count >= 3
  const candidates = stats.byHour.filter(h => h.count >= 3);
  if (candidates.length < 3) return null;
  const worst = candidates.reduce((w, h) => h.winRate < w.winRate ? h : w, candidates[0]);
  if (worst.winRate < 0.2 && worst.count >= 4) {
    return {
      id: 'worst_hour_of_day',
      severity: 'info',
      title: `Плохой час: ${worst.hour}:00 UTC`,
      rationale:
        `В ${worst.hour}:00 UTC: ${worst.count} сделок, WR ${(worst.winRate * 100).toFixed(0)}%, ` +
        `PnL ${worst.pnlSol.toFixed(3)} SOL. Возможно это время низкой ликвидности.`,
      suggestion:
        'Рассмотреть временной фильтр в конфиге — либо пропускать этот час, ' +
        'либо понижать entryAmountSol в это время.',
    };
  }
  return null;
};

const protocolImbalance: Rule = ({ stats }) => {
  if (stats.byProtocol.length < 2) return null;
  const loosers = stats.byProtocol.filter(p => p.count >= 4 && p.winRate < 0.3);
  if (loosers.length === 0) return null;
  const p = loosers[0];
  return {
    id: `weak_protocol_${p.protocol}`,
    severity: 'suggest',
    title: `${p.protocol}: слабый WR`,
    rationale:
      `${p.protocol}: ${p.count} сделок, WR ${(p.winRate * 100).toFixed(0)}%, ` +
      `PnL ${p.pnlSol.toFixed(3)} SOL. Статистически хуже остальных.`,
    suggestion:
      `Временно уменьшить max${p.protocol}Positions или entryAmountSol ` +
      'по этому протоколу. Параметры в config.strategy.*.',
  };
};

const urgentShare: Rule = ({ stats }) => {
  if (stats.total < 5) return null;
  const share = stats.urgentCount / stats.total;
  if (share > 0.4) {
    return {
      id: 'urgent_share_high',
      severity: 'info',
      title: `Доля urgent-выходов ${(share * 100).toFixed(0)}%`,
      rationale:
        `${stats.urgentCount}/${stats.total} выходов помечены как urgent ` +
        `(PnL ${stats.urgentPnlSol.toFixed(3)} SOL).`,
      suggestion:
        'Много паник-экзитов обычно означает слишком узкие stop-loss/velocity. ' +
        'Смотри рекомендации по velocity_drop / stop_loss выше.',
    };
  }
  return null;
};

const lowWinRate: Rule = ({ stats }) => {
  if (stats.total < MIN_SAMPLE) return null;
  if (stats.winRate < 0.35) {
    return {
      id: 'low_win_rate',
      severity: 'warn',
      title: `Низкий WR: ${(stats.winRate * 100).toFixed(0)}%`,
      rationale:
        `WR = ${stats.winRate * 100}% (${stats.wins}/${stats.total}). ` +
        'Фильтры пропускают слишком много мусора.',
      suggestion:
        'Повысить минимальный score (token-scorer), добавить социальные фильтры, ' +
        'или активировать defensive mode через config.strategy.defensive.',
    };
  }
  return null;
};

const goodSession: Rule = ({ stats }) => {
  if (stats.total < MIN_SAMPLE) return null;
  if (stats.winRate > 0.55 && stats.roi > 0.2) {
    return {
      id: 'positive_session',
      severity: 'info',
      title: 'Хорошая сессия — трогать конфиг не надо',
      rationale:
        `WR ${(stats.winRate * 100).toFixed(0)}%, ROI +${(stats.roi * 100).toFixed(0)}%. ` +
        'Статистика в норме.',
      suggestion:
        'Настройки работают как задумано. Изменения лучше тестировать на demo ' +
        'перед выкаткой в прод.',
    };
  }
  return null;
};

// ── Pipeline ─────────────────────────────────────────────────────────────

const RULES: Rule[] = [
  lossStreakWarning,
  fastStopLoss,
  velocityTooAggressive,
  trailingTooEarly,
  partialsNotEnough,
  urgentShare,
  worstHourOfDay,
  protocolImbalance,
  lowWinRate,
  goodSession,
];

/**
 * Генерирует рекомендации по закрытым сделкам. При выборке < MIN_SAMPLE
 * возвращает одну info-запись с предупреждением о малой статистике.
 */
export function generateRecommendations(
  stats: SessionStats,
  closes: TradeClose[],
): Recommendation[] {
  if (stats.empty) {
    return [{
      id: 'no_data',
      severity: 'info',
      title: 'Нет данных',
      rationale: 'В выбранном периоде нет закрытых сделок.',
      suggestion: 'Дождись завершения торгового цикла или расширь период.',
    }];
  }
  if (stats.total < MIN_SAMPLE) {
    return [{
      id: 'small_sample',
      severity: 'info',
      title: `Маленькая выборка: ${stats.total}`,
      rationale:
        `Для точечных советов нужно минимум ${MIN_SAMPLE} закрытых сделок. ` +
        `Сейчас ${stats.total}.`,
      suggestion: 'Запусти снова через пару часов или используй --full для всех дней.',
    }];
  }

  const ctx: RuleContext = { stats, closes };
  const out: Recommendation[] = [];
  for (const rule of RULES) {
    try {
      const r = rule(ctx);
      if (r) out.push(r);
    } catch {
      /* одно правило не должно ронять весь отчёт */
    }
  }

  // Если ни одно правило не сработало — значит всё штатно.
  if (out.length === 0) {
    out.push({
      id: 'nothing_to_change',
      severity: 'info',
      title: 'Ничего менять не надо',
      rationale: 'Все эвристики в зелёной зоне.',
      suggestion: 'Продолжай наблюдение.',
    });
  }
  return out;
}
