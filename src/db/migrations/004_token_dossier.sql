-- 004_token_dossier.sql
-- Полное досье по каждому токену + structured event log + analysis reports.
--
-- Заменяет зависимость от solscan для post-factum анализа: вся информация
-- собирается из gRPC-потока и RPC-запросов при первом касании mint'а.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. token_metadata — полный dossier по каждому mint'у
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS token_metadata (
  mint                      TEXT    PRIMARY KEY,
  -- Identity
  creator                   TEXT,
  first_seen_at             INTEGER NOT NULL,     -- ms
  first_seen_slot           INTEGER,
  first_seen_signature      TEXT,
  first_seen_source         TEXT,                  -- 'pumpfun_create', 'pumpswap_new_pool', 'raydium_launch_create', 'raydium_cpmm_new_pool', 'raydium_ammv4_new_pool', 'swap_recovery', 'copy_trade'

  -- Protocol
  protocol                  TEXT,                  -- 'pump.fun', 'pumpswap', 'raydium-launch', 'raydium-cpmm', 'raydium-ammv4', 'unknown'
  bonding_curve_pda         TEXT,
  pool_pda                  TEXT,
  pool_quote_mint           TEXT,
  token_program_id          TEXT,
  token_decimals            INTEGER,
  detected_at               INTEGER,               -- ms, когда protocol стал известен

  -- Raw on-chain snapshots (hex первые 256 байт — достаточно для layouts)
  bonding_curve_raw_hex     TEXT,
  pool_raw_hex              TEXT,
  is_mayhem                 INTEGER DEFAULT 0,
  cashback_enabled          INTEGER DEFAULT 0,

  -- Discriminators (для post-factum декодирования нестандартных events)
  buy_discriminator_hex     TEXT,
  sell_discriminator_hex    TEXT,

  -- Scoring snapshot (at entry decision)
  score                     INTEGER,
  score_reasons             TEXT,                  -- JSON array
  entry_multiplier          REAL,
  has_mint_authority        INTEGER,
  has_freeze_authority      INTEGER,
  metadata_json_size        INTEGER,
  metadata_uri              TEXT,
  metadata_name             TEXT,
  metadata_symbol           TEXT,

  -- Market state at entry decision
  virtual_sol_reserves      INTEGER,
  virtual_token_reserves    INTEGER,
  real_sol_reserves         INTEGER,
  real_token_reserves       INTEGER,
  top_holder_pct            REAL,
  unique_buyers_at_entry    INTEGER,
  first_buy_sol             REAL,
  creator_recent_tokens     INTEGER,
  rugcheck_risk             TEXT,                  -- 'low' | 'medium' | 'high' | 'unknown'

  -- Social at entry
  social_score              INTEGER,
  social_mentions_5min      INTEGER,
  alpha_match               INTEGER DEFAULT 0,

  -- Classification + outcome
  status                    TEXT    NOT NULL,      -- 'seen' | 'scored' | 'rejected' | 'traded' | 'unknown'
  rejected_reason           TEXT,
  trade_opened_at           INTEGER,
  trade_closed_at           INTEGER,
  trade_pnl_sol             REAL,
  trade_pnl_pct             REAL,

  -- Bookkeeping
  updated_at                INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_token_metadata_first_seen ON token_metadata(first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_metadata_status     ON token_metadata(status);
CREATE INDEX IF NOT EXISTS idx_token_metadata_protocol   ON token_metadata(protocol);
CREATE INDEX IF NOT EXISTS idx_token_metadata_creator    ON token_metadata(creator);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. events — structured event log (замена/дополнение event-logger.ts)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  type       TEXT    NOT NULL,        -- CREATOR_SELL, CREATOR_SELL_IGNORED, TRADE_OPEN, TRADE_CLOSE, RE_ENTRY_ALLOWED, ...
  mint       TEXT,
  protocol   TEXT,
  severity   TEXT    DEFAULT 'info',  -- 'debug' | 'info' | 'warn' | 'error'
  data       TEXT                     -- JSON blob
);

CREATE INDEX IF NOT EXISTS idx_events_ts    ON events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_mint  ON events(mint, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_type  ON events(type, ts DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. analysis_reports — permanent (не удаляются при TTL cleanup)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS analysis_reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at INTEGER NOT NULL,
  period_from  INTEGER NOT NULL,     -- ms
  period_to    INTEGER NOT NULL,     -- ms
  trades_total INTEGER,
  wins         INTEGER,
  losses       INTEGER,
  win_rate     REAL,
  roi          REAL,
  total_pnl    REAL,
  total_in     REAL,
  unique_mints INTEGER,
  stats_json   TEXT NOT NULL,         -- full SessionStats JSON
  recs_json    TEXT NOT NULL,         -- Recommendation[] JSON
  dossier_summary_json TEXT           -- top creators, reject reasons, etc.
);

CREATE INDEX IF NOT EXISTS idx_analysis_reports_ts ON analysis_reports(generated_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. cleanup_log — аудит операций чистки
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS cleanup_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at            INTEGER NOT NULL,
  tokens_deleted    INTEGER,
  events_deleted    INTEGER,
  log_files_deleted INTEGER,
  bytes_freed       INTEGER,
  report_id         INTEGER,
  FOREIGN KEY (report_id) REFERENCES analysis_reports(id)
);

CREATE INDEX IF NOT EXISTS idx_cleanup_log_ts ON cleanup_log(ran_at DESC);
