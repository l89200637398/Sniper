CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  protocol TEXT,
  entry_price REAL,
  exit_price REAL,
  entry_amount_sol REAL,
  exit_amount_sol REAL,
  pnl_percent REAL,
  token_score INTEGER,
  exit_reason TEXT,
  sell_path TEXT,
  opened_at INTEGER,
  closed_at INTEGER,
  is_copy_trade INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS social_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT,
  ticker TEXT,
  source TEXT,
  mention_count INTEGER DEFAULT 1,
  sentiment REAL,
  raw_text TEXT,
  author TEXT,
  followers INTEGER,
  timestamp INTEGER,
  url TEXT,
  created_at INTEGER,
  alpha INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS config_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  changed_at INTEGER,
  path TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT
);

CREATE TABLE IF NOT EXISTS pnl_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER,
  balance_sol REAL,
  total_pnl_sol REAL,
  open_positions INTEGER,
  win_rate REAL
);

CREATE INDEX IF NOT EXISTS idx_trades_closed ON trades(closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON social_signals(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_config_history_ts ON config_history(changed_at DESC);
