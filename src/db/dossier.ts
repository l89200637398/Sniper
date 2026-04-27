// src/db/dossier.ts
//
// TokenDossier — единая точка записи метаданных по каждому mint'у.
//
// Сохраняет всё, что возможно извлечь из gRPC-потока + on-chain чтения,
// чтобы в любой момент можно было построить полную картину без solscan.
//
// API:
//   - recordSeen(mint, source, meta?)   — первое касание
//   - recordProtocol(mint, protoInfo)   — detected протокол + PDA/layouts
//   - recordScoring(mint, features, result) — snapshot scoring
//   - recordMarketState(mint, reserves) — reserves at entry decision
//   - recordTradeOpen(mint, pnlOpt)     — статус traded
//   - recordTradeClose(mint, pnl)       — final pnl
//   - recordRejection(mint, reason)     — отклонён на каком-то этапе
//   - getDossier(mint) — для TG/CLI view
//
// Все операции идемпотентны (UPSERT). Запись async-safe через prepared stmts.

import { db } from './sqlite';

type Status = 'seen' | 'scored' | 'rejected' | 'traded' | 'unknown';

export interface SeenMeta {
  creator?: string;
  slot?: number;
  signature?: string;
}

export interface ProtocolMeta {
  protocol?: string;
  bondingCurvePda?: string;
  poolPda?: string;
  poolQuoteMint?: string;
  tokenProgramId?: string;
  tokenDecimals?: number;
  bondingCurveRawHex?: string;      // first 256 bytes hex
  poolRawHex?: string;
  isMayhem?: boolean;
  cashbackEnabled?: boolean;
  buyDiscriminatorHex?: string;
  sellDiscriminatorHex?: string;
}

export interface ScoringSnapshot {
  score: number;
  reasons: string[];
  entryMultiplier: number;
  hasMintAuthority?: boolean;
  hasFreezeAuthority?: boolean;
  metadataJsonSize?: number;
  metadataUri?: string;
  metadataName?: string;
  metadataSymbol?: string;
  socialScore?: number;
  socialMentions5min?: number;
  alphaMatch?: boolean;
  creatorRecentTokens?: number;
  rugcheckRisk?: string;
  topHolderPct?: number;
  uniqueBuyersAtEntry?: number;
  firstBuySol?: number;
}

export interface MarketState {
  virtualSolReserves?: bigint | number;
  virtualTokenReserves?: bigint | number;
  realSolReserves?: bigint | number;
  realTokenReserves?: bigint | number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Prepared statements
// ═══════════════════════════════════════════════════════════════════════════

const insertSeenStmt = db.prepare(`
  INSERT INTO token_metadata (
    mint, creator, first_seen_at, first_seen_slot, first_seen_signature,
    first_seen_source, status, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, 'seen', ?)
  ON CONFLICT(mint) DO NOTHING
`);

const updateProtocolStmt = db.prepare(`
  UPDATE token_metadata SET
    protocol = COALESCE(?, protocol),
    bonding_curve_pda = COALESCE(?, bonding_curve_pda),
    pool_pda = COALESCE(?, pool_pda),
    pool_quote_mint = COALESCE(?, pool_quote_mint),
    token_program_id = COALESCE(?, token_program_id),
    token_decimals = COALESCE(?, token_decimals),
    bonding_curve_raw_hex = COALESCE(?, bonding_curve_raw_hex),
    pool_raw_hex = COALESCE(?, pool_raw_hex),
    is_mayhem = COALESCE(?, is_mayhem),
    cashback_enabled = COALESCE(?, cashback_enabled),
    buy_discriminator_hex = COALESCE(?, buy_discriminator_hex),
    sell_discriminator_hex = COALESCE(?, sell_discriminator_hex),
    detected_at = COALESCE(detected_at, ?),
    updated_at = ?
  WHERE mint = ?
`);

const updateScoringStmt = db.prepare(`
  UPDATE token_metadata SET
    score = ?,
    score_reasons = ?,
    entry_multiplier = ?,
    has_mint_authority = ?,
    has_freeze_authority = ?,
    metadata_json_size = ?,
    metadata_uri = COALESCE(?, metadata_uri),
    metadata_name = COALESCE(?, metadata_name),
    metadata_symbol = COALESCE(?, metadata_symbol),
    social_score = ?,
    social_mentions_5min = ?,
    alpha_match = ?,
    creator_recent_tokens = ?,
    rugcheck_risk = ?,
    top_holder_pct = ?,
    unique_buyers_at_entry = ?,
    first_buy_sol = ?,
    status = 'scored',
    updated_at = ?
  WHERE mint = ?
`);

const updateMarketStateStmt = db.prepare(`
  UPDATE token_metadata SET
    virtual_sol_reserves = ?,
    virtual_token_reserves = ?,
    real_sol_reserves = ?,
    real_token_reserves = ?,
    updated_at = ?
  WHERE mint = ?
`);

const updateStatusStmt = db.prepare(`
  UPDATE token_metadata SET status = ?, rejected_reason = ?, updated_at = ? WHERE mint = ?
`);

const updateTradeOpenStmt = db.prepare(`
  UPDATE token_metadata SET
    status = 'traded',
    trade_opened_at = ?,
    updated_at = ?
  WHERE mint = ?
`);

const updateTradeCloseStmt = db.prepare(`
  UPDATE token_metadata SET
    trade_closed_at = ?,
    trade_pnl_sol = ?,
    trade_pnl_pct = ?,
    updated_at = ?
  WHERE mint = ?
`);

const getByMintStmt = db.prepare(`SELECT * FROM token_metadata WHERE mint = ?`);

// ═══════════════════════════════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════════════════════════════

function now(): number { return Date.now(); }

function bigIntToInt(v: bigint | number | undefined | null): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'bigint') {
    // SQLite INTEGER max is 2^63-1; Solana reserves fit
    return Number(v);
  }
  return v;
}

export function recordSeen(mint: string, source: string, meta: SeenMeta = {}): void {
  try {
    const ts = now();
    insertSeenStmt.run(
      mint,
      meta.creator ?? null,
      ts,
      meta.slot ?? null,
      meta.signature ?? null,
      source,
      ts,
    );
  } catch (err) {
    // dossier errors MUST NOT affect hot path
    /* swallow */
  }
}

export function recordProtocol(mint: string, meta: ProtocolMeta): void {
  try {
    // ensure row exists
    insertSeenStmt.run(mint, null, now(), null, null, 'protocol_detection', now());
    updateProtocolStmt.run(
      meta.protocol ?? null,
      meta.bondingCurvePda ?? null,
      meta.poolPda ?? null,
      meta.poolQuoteMint ?? null,
      meta.tokenProgramId ?? null,
      meta.tokenDecimals ?? null,
      meta.bondingCurveRawHex ?? null,
      meta.poolRawHex ?? null,
      meta.isMayhem === undefined ? null : (meta.isMayhem ? 1 : 0),
      meta.cashbackEnabled === undefined ? null : (meta.cashbackEnabled ? 1 : 0),
      meta.buyDiscriminatorHex ?? null,
      meta.sellDiscriminatorHex ?? null,
      now(),
      now(),
      mint,
    );
  } catch { /* swallow */ }
}

export function recordScoring(mint: string, s: ScoringSnapshot): void {
  try {
    insertSeenStmt.run(mint, null, now(), null, null, 'scoring', now());
    updateScoringStmt.run(
      s.score,
      JSON.stringify(s.reasons ?? []),
      s.entryMultiplier,
      s.hasMintAuthority === undefined ? null : (s.hasMintAuthority ? 1 : 0),
      s.hasFreezeAuthority === undefined ? null : (s.hasFreezeAuthority ? 1 : 0),
      s.metadataJsonSize ?? null,
      s.metadataUri ?? null,
      s.metadataName ?? null,
      s.metadataSymbol ?? null,
      s.socialScore ?? null,
      s.socialMentions5min ?? null,
      s.alphaMatch ? 1 : 0,
      s.creatorRecentTokens ?? null,
      s.rugcheckRisk ?? null,
      s.topHolderPct ?? null,
      s.uniqueBuyersAtEntry ?? null,
      s.firstBuySol ?? null,
      now(),
      mint,
    );
  } catch { /* swallow */ }
}

export function recordMarketState(mint: string, m: MarketState): void {
  try {
    insertSeenStmt.run(mint, null, now(), null, null, 'market_snapshot', now());
    updateMarketStateStmt.run(
      bigIntToInt(m.virtualSolReserves),
      bigIntToInt(m.virtualTokenReserves),
      bigIntToInt(m.realSolReserves),
      bigIntToInt(m.realTokenReserves),
      now(),
      mint,
    );
  } catch { /* swallow */ }
}

export function recordTradeOpen(mint: string): void {
  try {
    insertSeenStmt.run(mint, null, now(), null, null, 'trade_open', now());
    updateTradeOpenStmt.run(now(), now(), mint);
  } catch { /* swallow */ }
}

export function recordTradeClose(mint: string, pnlSol: number, pnlPct: number): void {
  try {
    updateTradeCloseStmt.run(now(), pnlSol, pnlPct, now(), mint);
  } catch { /* swallow */ }
}

export function recordRejection(mint: string, reason: string): void {
  try {
    insertSeenStmt.run(mint, null, now(), null, null, 'rejection', now());
    updateStatusStmt.run('rejected', reason, now(), mint);
  } catch { /* swallow */ }
}

export function markUnknown(mint: string): void {
  try {
    insertSeenStmt.run(mint, null, now(), null, null, 'unknown_protocol', now());
    updateStatusStmt.run('unknown', null, now(), mint);
  } catch { /* swallow */ }
}

export interface DossierRow {
  mint: string;
  [key: string]: any;
}

export function getDossier(mint: string): DossierRow | null {
  try {
    const row = getByMintStmt.get(mint) as DossierRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

// Aggregations for the cleanup report
export function getDossierSummary(fromMs: number, toMs: number): {
  totalMints: number;
  byStatus: Record<string, number>;
  byProtocol: Record<string, number>;
  topCreators: Array<{ creator: string; count: number }>;
  topRejections: Array<{ reason: string; count: number }>;
} {
  const rows = db.prepare(
    `SELECT status, protocol, creator, rejected_reason FROM token_metadata WHERE first_seen_at BETWEEN ? AND ?`
  ).all(fromMs, toMs) as Array<{ status: string; protocol: string; creator: string; rejected_reason: string }>;

  const byStatus: Record<string, number> = {};
  const byProtocol: Record<string, number> = {};
  const creatorCount: Record<string, number> = {};
  const rejectCount: Record<string, number> = {};

  for (const r of rows) {
    byStatus[r.status ?? 'unknown'] = (byStatus[r.status ?? 'unknown'] ?? 0) + 1;
    if (r.protocol) byProtocol[r.protocol] = (byProtocol[r.protocol] ?? 0) + 1;
    if (r.creator) creatorCount[r.creator] = (creatorCount[r.creator] ?? 0) + 1;
    if (r.rejected_reason) rejectCount[r.rejected_reason] = (rejectCount[r.rejected_reason] ?? 0) + 1;
  }

  const topCreators = Object.entries(creatorCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([creator, count]) => ({ creator, count }));
  const topRejections = Object.entries(rejectCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([reason, count]) => ({ reason, count }));

  return {
    totalMints: rows.length,
    byStatus,
    byProtocol,
    topCreators,
    topRejections,
  };
}
