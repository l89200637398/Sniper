import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.resolve(process.env.DB_PATH ?? 'data/sniper.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Автоматическая загрузка миграций ─────────────────────────────────────────
// tsc не копирует .sql — проверяем dist/db/migrations, потом src/db/migrations
let MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');
if (!fs.existsSync(MIGRATIONS_DIR)) {
  MIGRATIONS_DIR = path.resolve(__dirname, '../../src/db/migrations');
}
if (fs.existsSync(MIGRATIONS_DIR)) {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8'));
  }
}

/** Безопасный ADD COLUMN: проверяет существование таблицы и PRAGMA table_info. */
function addColumnIfMissing(table: string, column: string, definition: string) {
  const tableExists = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`
  ).get(table);
  if (!tableExists) return;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// ── Pre-existing social_signals (из 001_init.sql) → расширяем ────────────────
addColumnIfMissing('social_signals', 'url',        'TEXT');
addColumnIfMissing('social_signals', 'created_at', 'INTEGER');
addColumnIfMissing('social_signals', 'alpha',      'INTEGER DEFAULT 0');

// ── Shadow diagnostics columns (006) ────────────────────────────────────────
addColumnIfMissing('shadow_trades', 'scoring_result',      'TEXT DEFAULT \'\'');
addColumnIfMissing('shadow_trades', 'rugcheck_risk',       'TEXT DEFAULT \'unknown\'');
addColumnIfMissing('shadow_trades', 'safety_safe',         'INTEGER DEFAULT 1');
addColumnIfMissing('shadow_trades', 'social_mentions',     'INTEGER DEFAULT 0');
addColumnIfMissing('shadow_trades', 'skip_reason',         'TEXT DEFAULT \'\'');
addColumnIfMissing('shadow_trades', 'tx_diagnostic',       'TEXT DEFAULT \'\'');
addColumnIfMissing('shadow_trades', 'simulation_result',   'TEXT DEFAULT \'\'');
addColumnIfMissing('shadow_trades', 'is_simulation_trade', 'INTEGER DEFAULT 0');
addColumnIfMissing('shadow_trades', 'token_score',         'INTEGER DEFAULT 0');
addColumnIfMissing('shadow_trades', 'social_score',        'INTEGER DEFAULT 0');
addColumnIfMissing('shadow_trend_skips', 'social_score',   'INTEGER DEFAULT 0');

export function insertTrade(trade: {
  mint: string; protocol: string; entryPrice: number; exitPrice: number;
  entryAmountSol: number; exitAmountSol: number; pnlPercent: number;
  tokenScore: number; exitReason: string; sellPath: string;
  openedAt: number; closedAt: number; isCopyTrade: boolean;
}) {
  const stmt = db.prepare(`INSERT INTO trades
    (mint, protocol, entry_price, exit_price, entry_amount_sol, exit_amount_sol,
     pnl_percent, token_score, exit_reason, sell_path, opened_at, closed_at, is_copy_trade)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  stmt.run(
    trade.mint, trade.protocol, trade.entryPrice, trade.exitPrice,
    trade.entryAmountSol, trade.exitAmountSol, trade.pnlPercent,
    trade.tokenScore, trade.exitReason, trade.sellPath,
    trade.openedAt, trade.closedAt, trade.isCopyTrade ? 1 : 0
  );
}

export function recordConfigChange(pathStr: string, oldVal: any, newVal: any) {
  db.prepare(`INSERT INTO config_history (changed_at, path, old_value, new_value) VALUES (?,?,?,?)`)
    .run(Date.now(), pathStr, JSON.stringify(oldVal), JSON.stringify(newVal));
}
