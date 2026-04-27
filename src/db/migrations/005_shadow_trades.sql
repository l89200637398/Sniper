CREATE TABLE IF NOT EXISTS shadow_trades (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  profile     TEXT    NOT NULL,
  mint        TEXT    NOT NULL,
  protocol    TEXT    NOT NULL,
  entry_price REAL    NOT NULL,
  exit_price  REAL    DEFAULT 0,
  entry_sol   REAL    NOT NULL,
  exit_sol    REAL    DEFAULT 0,
  pnl_percent REAL    DEFAULT 0,
  exit_reason TEXT    DEFAULT '',
  token_score INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  opened_at   INTEGER NOT NULL,
  closed_at   INTEGER DEFAULT 0,
  virtual_balance_after REAL DEFAULT 0,
  fees_sol    REAL    DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_shadow_trades_profile ON shadow_trades(profile);
CREATE INDEX IF NOT EXISTS idx_shadow_trades_opened  ON shadow_trades(opened_at);

CREATE TABLE IF NOT EXISTS shadow_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  profile     TEXT    NOT NULL,
  ts          INTEGER NOT NULL,
  balance_sol REAL    NOT NULL,
  open_positions INTEGER NOT NULL,
  exposure_sol   REAL    NOT NULL,
  total_pnl_sol  REAL    NOT NULL,
  win_rate       REAL    NOT NULL,
  total_trades   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shadow_snap_ts ON shadow_snapshots(ts);
