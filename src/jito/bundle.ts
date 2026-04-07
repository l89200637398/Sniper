import { Connection, Keypair, PublicKey, VersionedTransaction, SystemProgram, TransactionMessage } from '@solana/web3.js';
import { config } from '../config';
import axios from 'axios';
import bs58 from 'bs58';
import { logger } from '../utils/logger';
import { logEvent } from '../utils/event-logger';
import { acquireJitoToken } from '../infra/jito-rate-limiter';

export let lastTipPaid = 0;

// ── bundleIdBySignature — Map для отслеживания bundleId по signature ───────────
//
// ИСПРАВЛЕНО: Map рос бесконечно. Каждый sendJitoBundle добавляет запись,
// но ничто её не удаляло. За 24 часа при 10 bundle/мин = 14400 записей.
//
// Решение: ограничить размер MAX_BUNDLE_MAP_SIZE. Когда Map переполняется,
// удаляем самую старую запись (FIFO через порядок вставки Map).
// Это safe: bundleIdBySignature используется только в getBundleId(),
// которая нужна только для активных confirm-циклов (~секунды).
// Записи старше нескольких минут никогда не нужны.
//
const MAX_BUNDLE_MAP_SIZE = 500; // хватает для 500 активных bundle (намного больше реальной нагрузки)
const bundleIdBySignature = new Map<string, string>();

function setBundleId(signature: string, bundleId: string): void {
  if (bundleIdBySignature.size >= MAX_BUNDLE_MAP_SIZE) {
    // Удаляем первую (самую старую) запись
    const firstKey = bundleIdBySignature.keys().next().value;
    if (firstKey !== undefined) bundleIdBySignature.delete(firstKey);
  }
  bundleIdBySignature.set(signature, bundleId);
}

let totalBundlesSent = 0;
let landedBundles = 0;
let lastStatsLog = Date.now();

function getBundleEndpoint(): string {
  return config.jito.bundleUrl || config.rpc.url;
}

function getStatusEndpoint(): string {
  return config.jito.statusUrl || config.rpc.url;
}

async function rpcRequest<T>(url: string, method: string, params: any[]): Promise<T> {
  const response = await axios.post(url, {
    jsonrpc: '2.0',
    id: 1,
    method,
    params,
  }, { timeout: 5000, headers: { 'Content-Type': 'application/json' } });

  if (response.data.error) {
    throw new Error(`RPC error (${method}): ${JSON.stringify(response.data.error)}`);
  }
  return response.data.result;
}

const STATIC_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
].map(addr => new PublicKey(addr));

export async function getTipAccounts(): Promise<PublicKey[]> {
  try {
    const accounts = await rpcRequest<string[]>(getStatusEndpoint(), 'getTipAccounts', []);
    if (accounts && accounts.length > 0) {
      logger.debug(`Tip accounts fetched: ${accounts.length}`);
      return accounts.map(acc => new PublicKey(acc));
    }
    throw new Error('Empty tip accounts response');
  } catch (err) {
    logger.warn('Failed to fetch tip accounts, using static fallback:', err);
    return STATIC_TIP_ACCOUNTS;
  }
}

interface TipCache {
  p50: number;
  p75: number;
  p95: number;
  timestamp: number;
}
let tipCache: TipCache | null = null;
const TIP_CACHE_TTL = 10_000;

async function getTipFloor(): Promise<{ p50: number; p75: number; p95: number }> {
  if (tipCache && Date.now() - tipCache.timestamp < TIP_CACHE_TTL) {
    return { p50: tipCache.p50, p75: tipCache.p75, p95: tipCache.p95 };
  }

  try {
    const results = await rpcRequest<any[]>(getStatusEndpoint(), 'getTipFloor', []);
    const result = Array.isArray(results) ? results[0] : results;
    if (!result) throw new Error('Empty getTipFloor response');

    const p50 = Math.round((result.landed_tips_50th_percentile ?? 0) * 1e9);
    const p75 = Math.round((result.landed_tips_75th_percentile ?? 0) * 1e9);
    const p95 = Math.round((result.landed_tips_95th_percentile ?? 0) * 1e9);

    if (p75 === 0 && p95 === 0) {
      throw new Error('getTipFloor returned all-zero values — Lil JIT addon may not be active on QuickNode');
    }

    tipCache = { p50, p75, p95, timestamp: Date.now() };
    logger.debug(`TipFloor updated: p50=${(p50/1e9).toFixed(6)} p75=${(p75/1e9).toFixed(6)} p95=${(p95/1e9).toFixed(6)} SOL`);
    return { p50, p75, p95 };
  } catch (err) {
    logger.warn('Failed to fetch tip floor, using static fallback:', err);
    const baseTip = Math.floor(config.jito.tipAmountSol * 1e9);
    return { p50: baseTip, p75: Math.floor(baseTip * 1.5), p95: baseTip * 2 };
  }
}

export async function resolveTipLamports(tipMultiplier = 1.0, urgent = false): Promise<number> {
  const staticTip = Math.floor(config.jito.tipAmountSol * 1e9);
  const maxTip    = Math.floor(config.jito.maxTipAmountSol * 1e9);
  const minTip    = Math.floor(config.jito.minTipAmountSol * 1e9);

  // urgent-dump: не тратим раунды на ramp, сразу идём с maxTip.
  if (urgent && (config.jito as any).urgentMaxTipImmediate) {
    logger.debug(`Jito tip [urgent-immediate]: ${(maxTip / 1e9).toFixed(6)} SOL`);
    return maxTip;
  }

  const floor = await getTipFloor();
  const dynamicTip = urgent ? floor.p95 : floor.p75;
  const baseTip = Math.max(dynamicTip, staticTip, minTip);
  const finalTip = Math.min(Math.floor(baseTip * tipMultiplier), maxTip);

  logger.debug(`Jito tip: ${(finalTip / 1e9).toFixed(6)} SOL (dynamic=${(dynamicTip / 1e9).toFixed(6)}, static=${(staticTip / 1e9).toFixed(6)}, urgent=${urgent}, multiplier=${tipMultiplier.toFixed(2)})`);
  return finalTip;
}

export function getBundleId(signature: string): string | undefined {
  return bundleIdBySignature.get(signature);
}

export interface InflightBundleStatus {
  bundle_id: string;
  status: 'Invalid' | 'Pending' | 'Landed' | 'Failed' | 'Dropped';
  landed_slot: number | null;
}

export interface BundleStatus {
  bundleId: string;
  status: 'Landed' | 'Failed' | 'Dropped' | 'Invalid';
}

export async function getInflightBundleStatuses(bundleIds: string[]): Promise<InflightBundleStatus[]> {
  try {
    const result = await rpcRequest<{ value: InflightBundleStatus[] }>(
      getStatusEndpoint(),
      'getInflightBundleStatuses',
      [bundleIds]
    );
    const statuses = result?.value ?? [];
    logger.debug(`getInflightBundleStatuses raw: ${JSON.stringify(statuses)}`);
    return statuses;
  } catch (err) {
    logger.warn('Failed to fetch inflight bundle statuses:', err);
    return [];
  }
}

export async function getBundleStatuses(bundleIds: string[]): Promise<BundleStatus[]> {
  try {
    const result = await rpcRequest<{ value: BundleStatus[] }>(
      getStatusEndpoint(),
      'getBundleStatuses',
      [bundleIds]
    );
    return result?.value ?? [];
  } catch (err) {
    logger.warn('Failed to fetch bundle statuses:', err);
    return [];
  }
}

export async function sendJitoBundle(
  tx: VersionedTransaction,
  payer: Keypair,
  tipMultiplier = 1.0,
  urgent = false
): Promise<string> {
  const tipAccounts = await getTipAccounts();
  const tipAccount  = tipAccounts[Math.floor(Math.random() * tipAccounts.length)];
  const tipLamports = await resolveTipLamports(tipMultiplier, urgent);
  lastTipPaid = tipLamports / 1e9;

  const blockhash = tx.message.recentBlockhash;

  const tipIx = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey:   tipAccount,
    lamports:   tipLamports,
  });

  const tipMessage = new TransactionMessage({
    payerKey:        payer.publicKey,
    recentBlockhash: blockhash,
    instructions:    [tipIx],
  }).compileToV0Message();

  const tipTx = new VersionedTransaction(tipMessage);
  tipTx.sign([payer]);

  const bundle = [tx, tipTx].map(t => bs58.encode(t.serialize()));
  if (bundle.length > 5) throw new Error(`Bundle too large: ${bundle.length} transactions (max 5)`);

  try {
    const bundleId = await rpcRequest<string>(getBundleEndpoint(), 'sendBundle', [bundle]);
    logger.debug(`Raw bundle response: ${bundleId}`);

    const signature = bs58.encode(tx.signatures[0]);
    setBundleId(signature, bundleId); // ← ИСПРАВЛЕНО: setBundleId вместо .set() напрямую

    totalBundlesSent++;
    logger.info(`✅ Jito bundle accepted | tip=${(tipLamports / 1e9).toFixed(6)} SOL | bundleId=${bundleId} | signature=${signature}`);
    logEvent('BUNDLE_SENT', { bundleId, signature, tip: tipLamports / 1e9, urgent });

    if (Date.now() - lastStatsLog > 60000) {
      const landedRate = totalBundlesSent > 0 ? (landedBundles / totalBundlesSent * 100).toFixed(1) : 'N/A';
      logger.info(`Jito stats: sent=${totalBundlesSent}, landed=${landedBundles}, rate=${landedRate}% | bundleMap size=${bundleIdBySignature.size}`);
      lastStatsLog = Date.now();
    }

    return signature;
  } catch (err) {
    let errorMsg = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && 'response' in (err as any)) {
      const response = (err as any).response;
      if (response?.data?.error) {
        const code    = response.data.error.code;
        const message = response.data.error.message;
        errorMsg = `Jito error ${code}: ${message}`;
        if (code === -32015) logger.warn('Jito bundle rejected (tip too low or other), will retry with increased tip');
      }
    }
    logger.error('sendBundle failed:', errorMsg);
    logEvent('BUNDLE_FAILED', { error: errorMsg });
    throw new Error(`Bundle rejected: ${errorMsg}`);
  }
}

export function updateLandedStat(success: boolean) {
  if (success) landedBundles++;
}

export interface BurstResult {
  signature: string;
  bundleId: string;
  tipMultiplier: number;
  tip: number;
}

export async function sendJitoBurst(
  buildTx: (burstIndex?: number) => Promise<VersionedTransaction>,
  payer: Keypair,
  tipMultipliers: number[] = config.jito.burstTipMultipliers ?? [1.0, 1.8, 2.8],  // обновлено по умолчанию
  urgent = true
): Promise<BurstResult[]> {
  const results: BurstResult[] = [];

  // B5 FIX: Build TXs with unique compute budget per burst index for distinct signatures
  const txs: VersionedTransaction[] = [];
  for (let i = 0; i < tipMultipliers.length; i++) {
    txs.push(await buildTx(i));
  }

  // Диагностика уникальности
  const sigs = txs.map(tx => bs58.encode(tx.signatures[0]));
  const uniqueSigs = new Set(sigs);
  if (uniqueSigs.size < txs.length) {
    logger.warn(`Burst: ${txs.length - uniqueSigs.size} duplicate signatures — задержка 50мс недостаточна?`);
  } else {
    logger.debug(`Burst: ${txs.length} уникальных signatures ✓`);
  }

  // Отправляем бандлы с rate limiting (каждый ждёт свой Jito RPS-токен)
  await Promise.all(txs.map(async (tx, i) => {
    const multiplier = tipMultipliers[i];
    try {
      await acquireJitoToken();
      const tipLamports = await resolveTipLamports(multiplier, urgent);
      const tipSol = tipLamports / 1e9;
      const signature = await sendJitoBundle(tx, payer, multiplier, urgent);
      const bundleId  = bundleIdBySignature.get(signature) ?? '';
      results.push({ signature, bundleId, tipMultiplier: multiplier, tip: tipSol });
      logger.debug(`Burst bundle sent: multiplier=${multiplier.toFixed(2)} sig=${signature.slice(0,8)} tip=${tipSol.toFixed(6)}`);
    } catch (err) {
      logger.warn(`Burst bundle failed for multiplier=${multiplier}:`, err);
    }
  }));

  if (results.length === 0) {
    throw new Error('All burst bundles failed to send');
  }

  logger.info(`🚀 Burst sent ${results.length}/${tipMultipliers.length} bundles`);
  logEvent('BURST_SENT', { count: results.length, signatures: results.map(r => r.signature.slice(0,8)) });
  return results;
}

export async function warmupJitoCache(): Promise<void> {
  logger.info('Warming up Jito caches (tip floor + tip accounts)...');
  const t0 = Date.now();
  await Promise.all([
    getTipFloor(),
    getTipAccounts(),
  ]);
  logger.info(`Jito cache warmed up in ${Date.now() - t0}ms`);
}
