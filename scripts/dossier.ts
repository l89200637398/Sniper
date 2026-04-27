#!/usr/bin/env ts-node
/**
 * scripts/dossier.ts
 *
 * CLI для просмотра token dossier из БД.
 * Заменяет необходимость гуглить solscan.
 *
 * Usage:
 *   npx ts-node scripts/dossier.ts <mint>          — full record for one mint
 *   npx ts-node scripts/dossier.ts --recent 20     — last N seen mints
 *   npx ts-node scripts/dossier.ts --creator <pk>  — all mints for creator
 *   npx ts-node scripts/dossier.ts --events <mint> — all events for mint
 *   npx ts-node scripts/dossier.ts --reports       — list analysis reports
 *   npx ts-node scripts/dossier.ts --cleanup       — cleanup audit log
 */

import { db } from '../src/db/sqlite';
import { getDossier } from '../src/db/dossier';

function fmt(v: any, truncate = 0): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number' && !Number.isInteger(v)) return v.toFixed(6);
  const s = String(v);
  if (truncate > 0 && s.length > truncate) return s.slice(0, truncate) + '…';
  return s;
}

function date(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function printDossier(mint: string): void {
  const d = getDossier(mint);
  if (!d) {
    console.log(`Нет данных по ${mint}`);
    return;
  }

  const line = '─'.repeat(80);
  console.log(`\n${line}`);
  console.log(`  TOKEN DOSSIER: ${d.mint}`);
  console.log(line);

  console.log(`\n  🪪 Identity`);
  console.log(`    creator:              ${fmt(d.creator)}`);
  console.log(`    first_seen_at:        ${date(d.first_seen_at)}`);
  console.log(`    first_seen_source:    ${fmt(d.first_seen_source)}`);
  console.log(`    first_seen_slot:      ${fmt(d.first_seen_slot)}`);
  console.log(`    first_seen_signature: ${fmt(d.first_seen_signature, 60)}`);

  console.log(`\n  🔗 Protocol`);
  console.log(`    protocol:             ${fmt(d.protocol)}`);
  console.log(`    bonding_curve_pda:    ${fmt(d.bonding_curve_pda)}`);
  console.log(`    pool_pda:             ${fmt(d.pool_pda)}`);
  console.log(`    pool_quote_mint:      ${fmt(d.pool_quote_mint)}`);
  console.log(`    token_program_id:     ${fmt(d.token_program_id)}`);
  console.log(`    decimals:             ${fmt(d.token_decimals)}`);
  console.log(`    is_mayhem:            ${d.is_mayhem ? 'YES ⚠️' : 'no'}`);
  console.log(`    cashback_enabled:     ${d.cashback_enabled ? 'yes' : 'no'}`);
  if (d.bonding_curve_raw_hex) console.log(`    bonding_curve_raw:    ${fmt(d.bonding_curve_raw_hex, 64)}`);
  if (d.pool_raw_hex)          console.log(`    pool_raw:             ${fmt(d.pool_raw_hex, 64)}`);

  console.log(`\n  📊 Scoring`);
  console.log(`    score:                ${fmt(d.score)}  (multiplier: ${fmt(d.entry_multiplier)})`);
  if (d.score_reasons) {
    try { console.log(`    reasons:              ${JSON.parse(d.score_reasons).join(' ')}`); }
    catch { console.log(`    reasons:              ${d.score_reasons}`); }
  }
  console.log(`    mint_authority:       ${d.has_mint_authority ? '❌ PRESENT' : '✅ null'}`);
  console.log(`    freeze_authority:     ${d.has_freeze_authority ? '❌ PRESENT' : '✅ null'}`);
  console.log(`    metadata_size:        ${fmt(d.metadata_json_size)} bytes`);
  console.log(`    metadata_name:        ${fmt(d.metadata_name)}`);
  console.log(`    metadata_symbol:      ${fmt(d.metadata_symbol)}`);
  console.log(`    rugcheck_risk:        ${fmt(d.rugcheck_risk)}`);

  console.log(`\n  💧 Market snapshot`);
  console.log(`    virtual_sol_reserves: ${fmt(d.virtual_sol_reserves)}`);
  console.log(`    virtual_tok_reserves: ${fmt(d.virtual_token_reserves)}`);
  console.log(`    real_sol_reserves:    ${fmt(d.real_sol_reserves)}`);
  console.log(`    real_tok_reserves:    ${fmt(d.real_token_reserves)}`);
  console.log(`    top_holder_pct:       ${fmt(d.top_holder_pct)}`);
  console.log(`    unique_buyers:        ${fmt(d.unique_buyers_at_entry)}`);
  console.log(`    first_buy_sol:        ${fmt(d.first_buy_sol)}`);
  console.log(`    creator_recent_tok:   ${fmt(d.creator_recent_tokens)}`);
  console.log(`    social_score:         ${fmt(d.social_score)}  mentions5m=${fmt(d.social_mentions_5min)} alpha=${d.alpha_match ? '★' : '—'}`);

  console.log(`\n  🎯 Outcome`);
  console.log(`    status:               ${fmt(d.status)}  ${d.rejected_reason ? `(reason: ${d.rejected_reason})` : ''}`);
  console.log(`    trade_opened_at:      ${date(d.trade_opened_at)}`);
  console.log(`    trade_closed_at:      ${date(d.trade_closed_at)}`);
  if (d.trade_pnl_sol !== null) {
    const pnlStr = d.trade_pnl_sol >= 0 ? `+${d.trade_pnl_sol.toFixed(6)}` : d.trade_pnl_sol.toFixed(6);
    console.log(`    pnl:                  ${pnlStr} SOL (${d.trade_pnl_pct >= 0 ? '+' : ''}${d.trade_pnl_pct.toFixed(2)}%)`);
  }
  console.log();
}

function printRecent(n: number): void {
  const rows = db.prepare(
    `SELECT mint, protocol, status, score, first_seen_at, trade_pnl_pct
     FROM token_metadata ORDER BY first_seen_at DESC LIMIT ?`
  ).all(n) as any[];
  console.log(`\n  Last ${n} seen mints`);
  console.log('─'.repeat(100));
  for (const r of rows) {
    const pnl = r.trade_pnl_pct === null ? '        —' :
      (r.trade_pnl_pct >= 0 ? '+' : '') + r.trade_pnl_pct.toFixed(2).padStart(7) + '%';
    console.log(
      `  ${date(r.first_seen_at)}  ${r.mint.slice(0, 10)}…  ` +
      `${(r.protocol ?? '?').padEnd(14)} ${(r.status ?? '?').padEnd(10)} ` +
      `score=${String(r.score ?? '?').padStart(3)}  pnl=${pnl}`
    );
  }
  console.log();
}

function printByCreator(creator: string): void {
  const rows = db.prepare(
    `SELECT mint, protocol, status, score, first_seen_at, trade_pnl_pct
     FROM token_metadata WHERE creator = ? ORDER BY first_seen_at DESC`
  ).all(creator) as any[];
  console.log(`\n  Mints by creator: ${creator}  (${rows.length})`);
  console.log('─'.repeat(100));
  for (const r of rows) {
    const pnl = r.trade_pnl_pct === null ? '—' :
      (r.trade_pnl_pct >= 0 ? '+' : '') + r.trade_pnl_pct.toFixed(2) + '%';
    console.log(
      `  ${date(r.first_seen_at)}  ${r.mint.slice(0, 12)}…  ${(r.protocol ?? '?').padEnd(14)} ` +
      `${(r.status ?? '?').padEnd(10)} score=${r.score ?? '?'} pnl=${pnl}`
    );
  }
  console.log();
}

function printEvents(mint: string): void {
  const rows = db.prepare(
    `SELECT ts, type, severity, data FROM events WHERE mint = ? ORDER BY ts ASC LIMIT 500`
  ).all(mint) as any[];
  console.log(`\n  Events for ${mint}  (${rows.length})`);
  console.log('─'.repeat(100));
  for (const r of rows) {
    console.log(`  ${date(r.ts)}  [${r.severity}] ${r.type.padEnd(28)} ${fmt(r.data, 120)}`);
  }
  console.log();
}

function printReports(): void {
  const rows = db.prepare(
    `SELECT id, generated_at, period_from, period_to, trades_total, win_rate, roi, total_pnl, unique_mints
     FROM analysis_reports ORDER BY generated_at DESC LIMIT 30`
  ).all() as any[];
  console.log(`\n  Analysis reports`);
  console.log('─'.repeat(100));
  console.log('   id │ generated          │ period                              │ trades │  WR   │  ROI   │ PnL     │ mints');
  console.log('─'.repeat(100));
  for (const r of rows) {
    console.log(
      `  ${String(r.id).padStart(3)} │ ${date(r.generated_at)} │ ` +
      `${date(r.period_from)}…${date(r.period_to).slice(11)} │ ` +
      `${String(r.trades_total).padStart(5)}  │ ${(r.win_rate * 100).toFixed(1).padStart(4)}% │ ` +
      `${(r.roi * 100).toFixed(1).padStart(5)}% │ ` +
      `${r.total_pnl >= 0 ? '+' : ''}${r.total_pnl.toFixed(3).padStart(7)} │ ${r.unique_mints}`
    );
  }
  console.log();
}

function printCleanupLog(): void {
  const rows = db.prepare(
    `SELECT ran_at, tokens_deleted, events_deleted, log_files_deleted, bytes_freed, report_id
     FROM cleanup_log ORDER BY ran_at DESC LIMIT 30`
  ).all() as any[];
  console.log(`\n  Cleanup log`);
  console.log('─'.repeat(85));
  for (const r of rows) {
    console.log(
      `  ${date(r.ran_at)}  report=#${r.report_id}  tokens=-${r.tokens_deleted}  ` +
      `events=-${r.events_deleted}  files=-${r.log_files_deleted}  ` +
      `freed=${(r.bytes_freed / 1024 / 1024).toFixed(2)} MB`
    );
  }
  console.log();
}

// ─── Main ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length === 0) {
  console.log('Usage:');
  console.log('  npx ts-node scripts/dossier.ts <mint>');
  console.log('  npx ts-node scripts/dossier.ts --recent [N]');
  console.log('  npx ts-node scripts/dossier.ts --creator <pk>');
  console.log('  npx ts-node scripts/dossier.ts --events <mint>');
  console.log('  npx ts-node scripts/dossier.ts --reports');
  console.log('  npx ts-node scripts/dossier.ts --cleanup');
  process.exit(1);
}

if (args[0] === '--recent') {
  printRecent(Number(args[1] ?? 20));
} else if (args[0] === '--creator' && args[1]) {
  printByCreator(args[1]);
} else if (args[0] === '--events' && args[1]) {
  printEvents(args[1]);
} else if (args[0] === '--reports') {
  printReports();
} else if (args[0] === '--cleanup') {
  printCleanupLog();
} else {
  printDossier(args[0]);
}
