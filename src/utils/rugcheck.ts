// src/utils/rugcheck.ts
//
// v3: RugCheck.xyz API — проверка безопасности токенов.
//
// Использование: sync gate из onNewToken (блокирует вход при HIGH RISK).
// Timeout 800мс — компромисс скорость/покрытие, при таймауте → risk:'unknown' (не блокирует).
// Кэш 5 мин — экономит API лимит (60 req/min free tier).
//
// Проверяет: mint authority, freeze authority, top holders,
// honeypot detection, known risks из базы RugCheck.

import axios from 'axios';
import { logger } from './logger';

export type RiskLevel = 'low' | 'medium' | 'high' | 'unknown';

export interface RugcheckResult {
  risk: RiskLevel;
  score: number;              // 0-100, higher = safer
  topHolderPercent: number;
  hasMintAuthority: boolean;
  hasFreezeAuthority: boolean;
  risks: string[];
  fetchTimeMs: number;
}

const EMPTY: RugcheckResult = {
  risk: 'unknown', score: 0, topHolderPercent: 0,
  hasMintAuthority: false, hasFreezeAuthority: false,
  risks: [], fetchTimeMs: 0,
};

const cache = new Map<string, { result: RugcheckResult; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 минут

// ── Quick Win 5: Verified mints cache ──
let verifiedMints = new Set<string>();
let verifiedCacheInterval: ReturnType<typeof setInterval> | null = null;

/** Fetch verified mints from RugCheck API and update the in-memory Set. */
export async function refreshVerifiedMints(): Promise<void> {
  try {
    const resp = await axios.get('https://api.rugcheck.xyz/v1/stats/verified', { timeout: 5000 });
    const data = resp.data;
    if (Array.isArray(data)) {
      const newSet = new Set<string>();
      for (const item of data) {
        // API может вернуть строку (mint) или объект { mint: string, ... }
        const mint = typeof item === 'string' ? item : item?.mint;
        if (typeof mint === 'string' && mint.length > 0) newSet.add(mint);
      }
      verifiedMints = newSet;
      logger.info(`[rugcheck] Verified cache refreshed: ${verifiedMints.size} mints`);
    } else {
      logger.debug('[rugcheck] Verified API returned non-array, skipping');
    }
  } catch (err) {
    logger.warn(`[rugcheck] refreshVerifiedMints failed: ${(err as Error).message}`);
  }
}

/** Start periodic refresh of verified mints cache (every 60s). */
export function startVerifiedCache(): void {
  if (verifiedCacheInterval) return;
  // Первый запрос сразу, далее каждые 60с
  refreshVerifiedMints();
  verifiedCacheInterval = setInterval(() => refreshVerifiedMints(), 60_000);
}

/** Check if a mint is in the RugCheck verified set. */
export function isVerifiedMint(mint: string): boolean {
  return verifiedMints.has(mint);
}

export async function checkRugcheck(mint: string): Promise<RugcheckResult> {
  // Проверяем кэш
  const cached = cache.get(mint);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.result;

  const t0 = Date.now();

  // Quick Win 4: retry helper — один повтор через 500ms при ошибке
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt === 1) {
        logger.debug(`[rugcheck] Retry for ${mint}...`);
        await new Promise(r => setTimeout(r, 500));
      }
      const resp = await axios.get(
        `https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`,
        { timeout: 1200 }
      );
      const data = resp.data;
      if (!data) return cacheAndReturn(mint, { ...EMPTY, fetchTimeMs: Date.now() - t0 });

      const risks: string[] = [];
      let riskScore = 100;

      // Парсим риски из API
      if (Array.isArray(data.risks)) {
        for (const r of data.risks) {
          const level = r.level || r.severity || '';
          const name = r.name || r.description || 'unknown_risk';
          risks.push(`${name}:${level}`);
          if (level === 'danger' || level === 'critical') riskScore -= 30;
          else if (level === 'warn' || level === 'warning') riskScore -= 15;
          else riskScore -= 5;
        }
      }

      // Top holder concentration
      let topHolderPercent = 0;
      if (data.topHolders?.[0]) {
        topHolderPercent = data.topHolders[0].pct ?? data.topHolders[0].percentage ?? 0;
        if (topHolderPercent > 50) {
          risks.push(`top_holder_${topHolderPercent.toFixed(0)}%`);
          riskScore -= 25;
        }
      }

      // Authority checks — pump.fun/LaunchLab programmatic mint authority is expected, not dangerous
      const SAFE_AUTHORITIES = new Set([
        '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  // pump.fun
        'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',  // Raydium LaunchLab
      ]);
      const hasMintAuthority = !!data.mintAuthority;
      const hasFreezeAuthority = !!data.freezeAuthority;
      if (hasMintAuthority) {
        if (SAFE_AUTHORITIES.has(data.mintAuthority)) {
          risks.push('mint_authority_program');
        } else {
          risks.push('mint_authority'); riskScore -= 20;
        }
      }
      if (hasFreezeAuthority) { risks.push('freeze_authority'); riskScore -= 15; }

      // Honeypot
      if (data.isHoneypot) { risks.push('HONEYPOT'); riskScore -= 50; }

      riskScore = Math.max(0, Math.min(100, riskScore));
      let risk: RiskLevel = riskScore >= 70 ? 'low' : riskScore >= 40 ? 'medium' : 'high';

      // Quick Win 5: verified mint override — boost score and force low risk
      if (isVerifiedMint(mint)) {
        riskScore = Math.min(100, riskScore + 20);
        risk = 'low';
        logger.debug(`[rugcheck] ${mint.slice(0, 8)}: verified mint, score boosted to ${riskScore}`);
      }

      const result: RugcheckResult = {
        risk, score: riskScore, topHolderPercent,
        hasMintAuthority, hasFreezeAuthority,
        risks, fetchTimeMs: Date.now() - t0,
      };

      logger.debug(`[rugcheck] ${mint.slice(0, 8)}: risk=${risk} score=${riskScore} risks=[${risks.join(',')}] (${result.fetchTimeMs}ms)`);
      return cacheAndReturn(mint, result);
    } catch (err) {
      lastErr = err;
      // Первая попытка провалилась — retry
    }
  }

  // Quick Win 4: оба вызова провалились — penalty -10 вместо нейтрального 0
  logger.debug(`[rugcheck] ${mint.slice(0, 8)}: both attempts failed, returning unknown with penalty -10`);
  return cacheAndReturn(mint, { ...EMPTY, score: -10, fetchTimeMs: Date.now() - t0 });
}

function cacheAndReturn(mint: string, result: RugcheckResult): RugcheckResult {
  cache.set(mint, { result, ts: Date.now() });
  // Очистка кэша при переполнении
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.ts > CACHE_TTL) cache.delete(k);
    }
  }
  return result;
}
