-- 006: shadow diagnostics
-- ALTER TABLE columns handled via addColumnIfMissing() in sqlite.ts
-- This file only creates new tables/indexes (idempotent via IF NOT EXISTS)

CREATE TABLE IF NOT EXISTS shadow_trend_skips (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  profile     TEXT    NOT NULL DEFAULT '',
  mint        TEXT    NOT NULL,
  protocol    TEXT    NOT NULL,
  reason      TEXT    NOT NULL,
  token_score INTEGER DEFAULT 0,
  rugcheck_risk TEXT  DEFAULT 'unknown',
  safety_safe INTEGER DEFAULT 1,
  ts          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shadow_skips_ts ON shadow_trend_skips(ts);
CREATE INDEX IF NOT EXISTS idx_shadow_skips_reason ON shadow_trend_skips(reason);
