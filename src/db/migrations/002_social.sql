-- 002_social.sql
-- Расширение таблицы social_signals, созданной в 001_init.sql.
-- Колонки добавляются через ALTER TABLE, но ALTER TABLE ADD COLUMN не
-- поддерживает IF NOT EXISTS в SQLite, поэтому подстраивочные ALTER-ы
-- выполняются JS-мигратором в src/db/sqlite.ts (runIdempotentAlters).
-- Здесь — только идемпотентные CREATE INDEX.

CREATE INDEX IF NOT EXISTS idx_social_mint     ON social_signals(mint);
CREATE INDEX IF NOT EXISTS idx_social_ticker   ON social_signals(ticker);
CREATE INDEX IF NOT EXISTS idx_social_source   ON social_signals(source);
