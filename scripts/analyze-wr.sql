-- scripts/analyze-wr.sql — SQL запросы для анализа Win Rate
-- Использование: sqlite3 data/sniper.db < scripts/analyze-wr.sql
-- Или отдельные запросы: sqlite3 data/sniper.db "SELECT ..."

.mode column
.headers on

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. ОБЩАЯ СТАТИСТИКА
-- ═══════════════════════════════════════════════════════════════════════════

SELECT '══ ОБЩАЯ СТАТИСТИКА ══' AS section;

SELECT
  COUNT(*) AS total_trades,
  SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) AS wins,
  SUM(CASE WHEN pnl_percent <= 0 THEN 1 ELSE 0 END) AS losses,
  ROUND(100.0 * SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) / MAX(COUNT(*), 1), 1) AS win_rate_pct,
  ROUND(SUM(COALESCE(exit_amount_sol, 0) - COALESCE(entry_amount_sol, 0)), 4) AS total_pnl_sol,
  ROUND(AVG(pnl_percent), 2) AS avg_pnl_pct,
  ROUND(AVG(CASE WHEN pnl_percent > 0 THEN pnl_percent END), 2) AS avg_win_pct,
  ROUND(AVG(CASE WHEN pnl_percent <= 0 THEN pnl_percent END), 2) AS avg_loss_pct
FROM trades;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. WR ПО ПРОТОКОЛАМ
-- ═══════════════════════════════════════════════════════════════════════════

SELECT '══ WR ПО ПРОТОКОЛАМ ══' AS section;

SELECT
  protocol,
  COUNT(*) AS trades,
  SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) AS wins,
  ROUND(100.0 * SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) / MAX(COUNT(*), 1), 1) AS wr_pct,
  ROUND(SUM(COALESCE(exit_amount_sol, 0) - COALESCE(entry_amount_sol, 0)), 4) AS pnl_sol,
  ROUND(AVG(pnl_percent), 2) AS avg_pnl_pct,
  ROUND(AVG(CASE WHEN pnl_percent > 0 THEN pnl_percent END), 2) AS avg_win_pct,
  ROUND(AVG(CASE WHEN pnl_percent <= 0 THEN pnl_percent END), 2) AS avg_loss_pct
FROM trades
GROUP BY protocol
ORDER BY trades DESC;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. РАСПРЕДЕЛЕНИЕ EXIT REASONS
-- ═══════════════════════════════════════════════════════════════════════════

SELECT '══ EXIT REASONS ══' AS section;

SELECT
  exit_reason,
  COUNT(*) AS count,
  ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM trades), 1) AS pct,
  ROUND(AVG(pnl_percent), 2) AS avg_pnl_pct,
  SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) AS wins
FROM trades
GROUP BY exit_reason
ORDER BY count DESC;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. TREND_SKIP DISTRIBUTION (какой guard блокирует больше всего)
-- ═══════════════════════════════════════════════════════════════════════════

SELECT '══ TREND_SKIP REASONS ══' AS section;

SELECT
  json_extract(data, '$.reason') AS reason,
  json_extract(data, '$.protocol') AS protocol,
  COUNT(*) AS count
FROM events
WHERE type = 'TREND_SKIP'
GROUP BY reason
ORDER BY count DESC
LIMIT 30;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. КОНВЕРСИЯ ВОРОНКИ: events → buy → trade
-- ═══════════════════════════════════════════════════════════════════════════

SELECT '══ ВОРОНКА КОНВЕРСИИ ══' AS section;

SELECT 'TREND_TRACKED' AS stage, COUNT(*) AS count FROM events WHERE type = 'TREND_TRACKED'
UNION ALL
SELECT 'TREND_CONFIRMED', COUNT(*) FROM events WHERE type = 'TREND_ENTRY' OR type = 'TREND_SOCIAL_ENTRY'
UNION ALL
SELECT 'TREND_SKIP', COUNT(*) FROM events WHERE type = 'TREND_SKIP'
UNION ALL
SELECT 'BUY_SENT', COUNT(*) FROM events WHERE type LIKE '%BUY_SENT%'
UNION ALL
SELECT 'TRADE_OPEN', COUNT(*) FROM events WHERE type = 'TRADE_OPEN'
UNION ALL
SELECT 'TRADE_CLOSE', COUNT(*) FROM events WHERE type = 'TRADE_CLOSE'
ORDER BY count DESC;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. SOCIAL SIGNAL → TRADE КОРРЕЛЯЦИЯ
-- ═══════════════════════════════════════════════════════════════════════════

SELECT '══ SOCIAL SIGNALS ══' AS section;

SELECT
  source,
  COUNT(*) AS signals,
  COUNT(DISTINCT mint) AS unique_mints,
  SUM(CASE WHEN alpha = 1 THEN 1 ELSE 0 END) AS alpha_signals
FROM social_signals
GROUP BY source
ORDER BY signals DESC;

-- Токены с social signal, которые стали трейдами
SELECT '══ SOCIAL → TRADE MATCH ══' AS section;

SELECT
  ss.source,
  COUNT(DISTINCT t.mint) AS traded_with_signal,
  ROUND(AVG(t.pnl_percent), 2) AS avg_pnl_pct,
  SUM(CASE WHEN t.pnl_percent > 0 THEN 1 ELSE 0 END) AS wins,
  COUNT(DISTINCT t.mint) - SUM(CASE WHEN t.pnl_percent > 0 THEN 1 ELSE 0 END) AS losses
FROM trades t
INNER JOIN social_signals ss ON t.mint = ss.mint AND ss.timestamp <= t.opened_at
GROUP BY ss.source;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. TOKEN SCORE → PNL КОРРЕЛЯЦИЯ
-- ═══════════════════════════════════════════════════════════════════════════

SELECT '══ SCORE → PNL ══' AS section;

SELECT
  CASE
    WHEN token_score IS NULL THEN 'null'
    WHEN token_score < 30 THEN '0-29'
    WHEN token_score < 45 THEN '30-44'
    WHEN token_score < 55 THEN '45-54'
    WHEN token_score < 65 THEN '55-64'
    ELSE '65+'
  END AS score_band,
  COUNT(*) AS trades,
  ROUND(100.0 * SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) / MAX(COUNT(*), 1), 1) AS wr_pct,
  ROUND(AVG(pnl_percent), 2) AS avg_pnl_pct
FROM trades
GROUP BY score_band
ORDER BY score_band;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. COPY-TRADE PERFORMANCE
-- ═══════════════════════════════════════════════════════════════════════════

SELECT '══ COPY-TRADE ══' AS section;

SELECT
  CASE WHEN is_copy_trade = 1 THEN 'copy-trade' ELSE 'organic' END AS type,
  COUNT(*) AS trades,
  ROUND(100.0 * SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) / MAX(COUNT(*), 1), 1) AS wr_pct,
  ROUND(AVG(pnl_percent), 2) AS avg_pnl_pct,
  ROUND(SUM(COALESCE(exit_amount_sol, 0) - COALESCE(entry_amount_sol, 0)), 4) AS pnl_sol
FROM trades
GROUP BY is_copy_trade;

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. SERIAL CREATORS (кандидаты на blacklist)
-- ═══════════════════════════════════════════════════════════════════════════

SELECT '══ SERIAL CREATORS (top rug rate) ══' AS section;

SELECT
  creator,
  COUNT(*) AS total_tokens,
  SUM(CASE WHEN trade_pnl_pct < -50 THEN 1 ELSE 0 END) AS rugs,
  ROUND(100.0 * SUM(CASE WHEN trade_pnl_pct < -50 THEN 1 ELSE 0 END) / MAX(COUNT(*), 1), 1) AS rug_rate_pct,
  ROUND(AVG(trade_pnl_pct), 2) AS avg_pnl_pct
FROM token_metadata
WHERE creator IS NOT NULL AND status = 'traded'
GROUP BY creator
HAVING total_tokens >= 3
ORDER BY rug_rate_pct DESC
LIMIT 20;

-- ═══════════════════════════════════════════════════════════════════════════
-- 10. SELL PATH PERFORMANCE
-- ═══════════════════════════════════════════════════════════════════════════

SELECT '══ SELL PATH ══' AS section;

SELECT
  sell_path,
  COUNT(*) AS count,
  ROUND(AVG(pnl_percent), 2) AS avg_pnl_pct
FROM trades
WHERE sell_path IS NOT NULL
GROUP BY sell_path
ORDER BY count DESC;

-- ═══════════════════════════════════════════════════════════════════════════
-- 11. ВРЕМЯ ЖИЗНИ ПОЗИЦИЙ
-- ═══════════════════════════════════════════════════════════════════════════

SELECT '══ POSITION DURATION ══' AS section;

SELECT
  CASE
    WHEN (closed_at - opened_at) < 10000 THEN '<10s'
    WHEN (closed_at - opened_at) < 30000 THEN '10-30s'
    WHEN (closed_at - opened_at) < 60000 THEN '30s-1m'
    WHEN (closed_at - opened_at) < 300000 THEN '1-5m'
    ELSE '5m+'
  END AS duration,
  COUNT(*) AS trades,
  ROUND(100.0 * SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) / MAX(COUNT(*), 1), 1) AS wr_pct,
  ROUND(AVG(pnl_percent), 2) AS avg_pnl_pct
FROM trades
WHERE closed_at IS NOT NULL AND opened_at IS NOT NULL
GROUP BY duration
ORDER BY MIN(closed_at - opened_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- 12. EVENT TYPES DISTRIBUTION
-- ═══════════════════════════════════════════════════════════════════════════

SELECT '══ EVENT TYPES ══' AS section;

SELECT type, COUNT(*) AS count
FROM events
GROUP BY type
ORDER BY count DESC
LIMIT 30;

-- ═══════════════════════════════════════════════════════════════════════════
-- 13. SHADOW vs REAL PERFORMANCE
-- ═══════════════════════════════════════════════════════════════════════════

SELECT '══ SHADOW TRADES ══' AS section;

SELECT
  profile,
  COUNT(*) AS trades,
  ROUND(100.0 * SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) / MAX(COUNT(*), 1), 1) AS wr_pct,
  ROUND(AVG(pnl_percent), 2) AS avg_pnl_pct,
  ROUND(SUM(COALESCE(exit_sol, 0) - entry_sol), 4) AS pnl_sol
FROM shadow_trades
GROUP BY profile;

-- ═══════════════════════════════════════════════════════════════════════════
-- 14. AUTO-ALPHA EVENTS
-- ═══════════════════════════════════════════════════════════════════════════

SELECT '══ AUTO-ALPHA ══' AS section;

SELECT type, COUNT(*) AS count,
  json_extract(data, '$.reason') AS reason
FROM events
WHERE type LIKE '%ALPHA%' OR type LIKE '%PRELAUNCH%'
GROUP BY type, reason
ORDER BY count DESC;

-- ═══════════════════════════════════════════════════════════════════════════
-- 15. RUGCHECK RISK vs OUTCOME
-- ═══════════════════════════════════════════════════════════════════════════

SELECT '══ RUGCHECK RISK → OUTCOME ══' AS section;

SELECT
  rugcheck_risk,
  COUNT(*) AS tokens,
  SUM(CASE WHEN status = 'traded' THEN 1 ELSE 0 END) AS traded,
  ROUND(AVG(CASE WHEN status = 'traded' THEN trade_pnl_pct END), 2) AS avg_trade_pnl_pct
FROM token_metadata
WHERE rugcheck_risk IS NOT NULL
GROUP BY rugcheck_risk
ORDER BY tokens DESC;

-- ═══════════════════════════════════════════════════════════════════════════
-- 16. FALSE NEGATIVES: rejected tokens that would have been profitable
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- 17. NEW FILTER IMPACT (v2 improvements)
-- ═══════════════════════════════════════════════════════════════════════════

SELECT '══ NEW FILTER IMPACT ══' AS section;

SELECT
  json_extract(data, '$.reason') AS filter,
  COUNT(*) AS blocked
FROM events
WHERE type IN ('TREND_SKIP', 'BUY_SKIPPED_CURVE_PROGRESS', 'POOL_AGE_GATE', 'RESERVE_IMBALANCE_EXIT')
  AND json_extract(data, '$.reason') IN (
    'creator_low_balance', 'token2022_dangerous', 'bundled_buy_detected',
    'wash_trading', 'price_unstable', 'creator_serial_rugger',
    'curve_too_early', 'curve_too_late'
  )
GROUP BY filter
ORDER BY blocked DESC;

SELECT '══ RESERVE IMBALANCE EXITS ══' AS section;

SELECT
  COUNT(*) AS reserve_exits,
  ROUND(AVG(json_extract(data, '$.dropPct')), 1) AS avg_drop_pct
FROM events
WHERE type = 'RESERVE_IMBALANCE_EXIT';

SELECT '══ FALSE NEGATIVES (rejected but profitable) ══' AS section;

SELECT
  rejected_reason,
  COUNT(*) AS rejected,
  SUM(CASE WHEN trade_pnl_pct > 0 THEN 1 ELSE 0 END) AS would_be_wins,
  ROUND(AVG(trade_pnl_pct), 2) AS avg_hypothetical_pnl
FROM token_metadata
WHERE status = 'rejected' AND trade_pnl_pct IS NOT NULL
GROUP BY rejected_reason
ORDER BY would_be_wins DESC
LIMIT 15;
