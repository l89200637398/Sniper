// src/utils/rugcheck.ts
//
// v3: RugCheck.xyz API — проверка безопасности токенов.
//
// Использование: sync gate из onNewToken (блокирует вход при HIGH RISK).
// Timeout 500мс — минимальная задержка, при таймауте → risk:'unknown' (не блокирует).
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

export async function checkRugcheck(mint: string): Promise<RugcheckResult> {
  // Проверяем кэш
  const cached = cache.get(mint);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.result;

  const t0 = Date.now();
  try {
    const resp = await axios.get(
      `https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`,
      { timeout: 500 }
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

    // Authority checks
    const hasMintAuthority = !!data.mintAuthority;
    const hasFreezeAuthority = !!data.freezeAuthority;
    if (hasMintAuthority) { risks.push('mint_authority'); riskScore -= 20; }
    if (hasFreezeAuthority) { risks.push('freeze_authority'); riskScore -= 15; }

    // Honeypot
    if (data.isHoneypot) { risks.push('HONEYPOT'); riskScore -= 50; }

    riskScore = Math.max(0, Math.min(100, riskScore));
    const risk: RiskLevel = riskScore >= 70 ? 'low' : riskScore >= 40 ? 'medium' : 'high';

    const result: RugcheckResult = {
      risk, score: riskScore, topHolderPercent,
      hasMintAuthority, hasFreezeAuthority,
      risks, fetchTimeMs: Date.now() - t0,
    };

    logger.debug(`[rugcheck] ${mint.slice(0, 8)}: risk=${risk} score=${riskScore} (${result.fetchTimeMs}ms)`);
    return cacheAndReturn(mint, result);
  } catch {
    // Timeout или ошибка API — не блокируем
    return cacheAndReturn(mint, { ...EMPTY, fetchTimeMs: Date.now() - t0 });
  }
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
