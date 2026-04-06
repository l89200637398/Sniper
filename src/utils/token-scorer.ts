// src/utils/token-scorer.ts
//
// v3: Rule-based scoring токенов перед входом (0-100 баллов).
// Порог: config.strategy.minTokenScore (по умолчанию 25).
//
// Scoring работает как дополнительный gate — если score < порог, токен
// пропускается. Не заменяет существующие проверки (ликвидность, safety и т.д.).
//
// ВАЖНО: на момент входа social и rugcheck данные могут быть не готовы
// (они async fire-and-forget). Scoring использует то что доступно синхронно.

import { logger } from './logger';

export interface TokenFeatures {
  socialScore: number;           // 0-3 из checkSocialSignals
  independentBuyers: number;     // кол-во independent buyers на момент scoring
  firstBuySol: number;           // SOL первого independent buy
  creatorRecentTokens: number;   // сколько токенов creator создал за 60 сек
  metadataJsonSize: number;      // размер metadata JSON (0 = не доступен)
  rugcheckRisk: 'low' | 'medium' | 'high' | 'unknown';
  hasMintAuthority: boolean;
  hasFreezeAuthority: boolean;
  isMayhem: boolean;
  topHolderPct?: number;         // % от supply у top holder (0-100), undefined = не доступен
}

export interface ScoringResult {
  score: number;
  shouldEnter: boolean;
  reasons: string[];
  entryMultiplier: number;       // множитель entry на основе score
}

export function scoreToken(features: TokenFeatures, minScore: number = 25): ScoringResult {
  let score = 0;
  const reasons: string[] = [];

  // ── Social (max 30 баллов) ──
  // Токен с twitter/telegram = реальный проект, не instant rug.
  if (features.socialScore >= 2) { score += 25; reasons.push(`social=${features.socialScore}(+25)`); }
  else if (features.socialScore >= 1) { score += 15; reasons.push(`social=1(+15)`); }

  // ── Market validation (max 25 баллов) ──
  // Independent buyers = кто-то кроме creator и ботов покупает.
  if (features.independentBuyers >= 1) { score += 10; reasons.push(`buyers=${features.independentBuyers}(+10)`); }
  if (features.independentBuyers >= 3) { score += 8; reasons.push(`buyers≥3(+8)`); }
  if (features.firstBuySol >= 0.1) { score += 7; reasons.push(`1stBuy=${features.firstBuySol.toFixed(2)}(+7)`); }

  // ── Creator quality (max 15 / penalty -20) ──
  // Creator создал 3+ токенов за минуту = спамер/rugger.
  if (features.creatorRecentTokens < 3) { score += 10; reasons.push(`creator_ok(+10)`); }
  if (features.creatorRecentTokens <= 1) { score += 5; reasons.push(`creator_clean(+5)`); }
  if (features.creatorRecentTokens >= 3) { score -= 20; reasons.push(`SPAM_CREATOR(-20)`); }

  // ── Metadata (max 5 баллов) ──
  if (features.metadataJsonSize >= 500) { score += 5; reasons.push(`rich_meta(+5)`); }
  else if (features.metadataJsonSize > 0 && features.metadataJsonSize < 200) { score -= 10; reasons.push(`tiny_meta(-10)`); }

  // ── Safety (penalties) ──
  if (features.rugcheckRisk === 'low') { score += 10; reasons.push(`rug_safe(+10)`); }
  else if (features.rugcheckRisk === 'high') { score -= 50; reasons.push(`RUG_HIGH(-50)`); }
  if (features.hasMintAuthority) { score -= 40; reasons.push(`MINT_AUTH(-40)`); }
  if (features.hasFreezeAuthority) { score -= 30; reasons.push(`FREEZE(-30)`); }

  // ── Holder concentration (brainstorm v4) ──
  // High concentration = rug risk. Top holder >50% = dump imminent.
  if (features.topHolderPct !== undefined) {
    if (features.topHolderPct > 50) { score -= 25; reasons.push(`TOP_HOLDER_${features.topHolderPct.toFixed(0)}%(-25)`); }
    else if (features.topHolderPct > 30) { score -= 10; reasons.push(`holder_conc_${features.topHolderPct.toFixed(0)}%(-10)`); }
    else if (features.topHolderPct < 15) { score += 5; reasons.push(`holder_distributed(+5)`); }
  }

  // ── Mayhem bypass ──
  // Mayhem токены обходят scoring — у них своя exit логика.
  if (features.isMayhem) { score = Math.max(score, minScore); reasons.push('mayhem_pass'); }

  // Clamp 0-100
  score = Math.max(0, Math.min(100, score));

  // Entry multiplier на основе score
  let entryMultiplier = 1.0;
  if (score >= 70) entryMultiplier = 2.0;       // high confidence
  else if (score >= 50) entryMultiplier = 1.0;   // normal
  else if (score >= minScore) entryMultiplier = 0.5; // low confidence → half entry

  logger.debug(`[scorer] ${score}pts enter=${score >= minScore} mul=${entryMultiplier} | ${reasons.join(' ')}`);

  return { score, shouldEnter: score >= minScore, reasons, entryMultiplier };
}
