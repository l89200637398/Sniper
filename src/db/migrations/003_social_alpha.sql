-- 003_social_alpha.sql
-- Alpha-флаг для social_signals (Phase 3 / C1 follow-up).
-- Колонка `alpha` добавляется идемпотентно через addColumnIfMissing
-- в src/db/sqlite.ts (SQLite не поддерживает ADD COLUMN IF NOT EXISTS).
-- Здесь — только индекс для ускорения запросов с WHERE alpha = 1.

CREATE INDEX IF NOT EXISTS idx_social_alpha ON social_signals(alpha);
