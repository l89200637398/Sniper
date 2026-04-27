// src/utils/token-scorer.ts
//
// v4: Rule-based scoring токенов перед входом (0-100 баллов).
// Порог: config.strategy.minTokenScore (по умолчанию 60).
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
  socialMentions?: number;       // кол-во mentions в social_signals за lookback window
  creatorBalanceSol?: number;    // #6: creator SOL balance
  hasDexBoost?: boolean;         // #17: active DexScreener boost
  metadataQualityScore?: number; // #12: metadata name quality score
  metadataQualityFlags?: string[]; // #12: quality flags for logging
  isBundledBuy?: boolean;        // #18: concurrent buy synchronization detected
  bundledWallets?: number;       // #18: max wallets in single slot
  hasToken2022Danger?: boolean;  // #8: dangerous Token-2022 extensions
  token2022Extensions?: string[];
  creatorWalletAgeMs?: number;   // research: creator wallet age
  curveProgressPct?: number;     // #11: bonding curve progress
  priceUnstable?: boolean;       // #19: price stability after spike
  buyAcceleration?: number;      // #15: buy velocity acceleration (buys/sec trend)
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

  // ── Social (max 35 баллов) ──
  if (features.socialScore >= 3) { score += 35; reasons.push(`social=${features.socialScore}(+35)`); }
  else if (features.socialScore >= 2) { score += 25; reasons.push(`social=${features.socialScore}(+25)`); }
  else if (features.socialScore >= 1) { score += 15; reasons.push(`social=1(+15)`); }

  // ── Market validation (max 30 баллов) ──
  if (features.independentBuyers >= 5) { score += 20; reasons.push(`buyers=${features.independentBuyers}(+20)`); }
  else if (features.independentBuyers >= 3) { score += 15; reasons.push(`buyers=${features.independentBuyers}(+15)`); }
  else if (features.independentBuyers >= 1) { score += 10; reasons.push(`buyers=${features.independentBuyers}(+10)`); }
  if (features.firstBuySol >= 0.5) { score += 10; reasons.push(`1stBuy=${features.firstBuySol.toFixed(2)}(+10)`); }
  else if (features.firstBuySol >= 0.1) { score += 5; reasons.push(`1stBuy=${features.firstBuySol.toFixed(2)}(+5)`); }

  // ── Creator quality (max 15 / penalty -25) ──
  if (features.creatorRecentTokens < 3) { score += 10; reasons.push(`creator_ok(+10)`); }
  if (features.creatorRecentTokens <= 1) { score += 5; reasons.push(`creator_clean(+5)`); }
  if (features.creatorRecentTokens >= 3) { score -= 25; reasons.push(`SPAM_CREATOR(-25)`); }

  // ── Metadata (max 5 / penalty -10) ──
  if (features.metadataJsonSize >= 500) { score += 5; reasons.push(`rich_meta(+5)`); }
  else if (features.metadataJsonSize > 0 && features.metadataJsonSize < 200) { score -= 10; reasons.push(`tiny_meta(-10)`); }
  else if (features.metadataJsonSize === 0) { score -= 5; reasons.push(`no_meta(-5)`); }

  // ── Safety (penalties) ──
  if (features.rugcheckRisk === 'low') { score += 15; reasons.push(`rug_safe(+15)`); }
  else if (features.rugcheckRisk === 'medium') { score -= 10; reasons.push(`rug_medium(-10)`); }
  else if (features.rugcheckRisk === 'high') { score -= 50; reasons.push(`RUG_HIGH(-50)`); }
  if (features.hasMintAuthority) { score -= 40; reasons.push(`MINT_AUTH(-40)`); }
  if (features.hasFreezeAuthority) { score -= 30; reasons.push(`FREEZE(-30)`); }
  if (features.hasMintAuthority && features.hasFreezeAuthority) { score -= 20; reasons.push(`BOTH_AUTH(-20)`); }

  // ── Zero signals gate: no social, no buyers, no rugcheck = scam/unverified ──
  // Softened: without Twitter parser most tokens lack social signals, so only
  // penalize when there are also no buyers AND unknown rugcheck (true zero-info).
  if (features.socialScore === 0 && features.independentBuyers === 0 && features.rugcheckRisk === 'unknown') {
    score -= 8; reasons.push('ZERO_SIGNALS(-8)');
  }

  // ── Holder concentration ──
  if (features.topHolderPct !== undefined) {
    if (features.topHolderPct > 50) { score -= 25; reasons.push(`TOP_HOLDER_${features.topHolderPct.toFixed(0)}%(-25)`); }
    else if (features.topHolderPct > 30) { score -= 10; reasons.push(`holder_conc_${features.topHolderPct.toFixed(0)}%(-10)`); }
    else if (features.topHolderPct < 15) { score += 5; reasons.push(`holder_distributed(+5)`); }
  }

  // ── Social gate (Phase 3 signal-store data) ──
  if (features.socialMentions !== undefined) {
    if (features.socialMentions === 0) { score -= 5; reasons.push('NO_SOCIAL_MENTIONS(-5)'); }
    else if (features.socialMentions >= 2) { score += 5; reasons.push(`social_mentions=${features.socialMentions}(+5)`); }
  }

  // ── #6: Creator SOL balance ──
  if (features.creatorBalanceSol !== undefined) {
    if (features.creatorBalanceSol < 0.5) { score -= 15; reasons.push(`LOW_CREATOR_BAL_${features.creatorBalanceSol.toFixed(2)}(-15)`); }
    else if (features.creatorBalanceSol < 2) { score -= 5; reasons.push(`creator_bal_low(-5)`); }
    else if (features.creatorBalanceSol >= 10) { score += 5; reasons.push(`creator_bal_ok(+5)`); }
  }

  // ── #17: DexScreener boost at entry ──
  if (features.hasDexBoost) { score += 15; reasons.push('DEX_BOOST(+15)'); }

  // ── #12: Metadata name quality ──
  if (features.metadataQualityScore !== undefined && features.metadataQualityScore !== 0) {
    score += features.metadataQualityScore;
    const flag = features.metadataQualityFlags?.[0] ?? 'meta_quality';
    reasons.push(`${flag}(${features.metadataQualityScore > 0 ? '+' : ''}${features.metadataQualityScore})`);
  }

  // ── #18: Bundled buy detection ──
  if (features.isBundledBuy) {
    score -= 20;
    reasons.push(`BUNDLED_BUY_${features.bundledWallets ?? 0}(-20)`);
  }

  // ── #8: Token-2022 dangerous extensions ──
  if (features.hasToken2022Danger) {
    score -= 40;
    reasons.push(`TOKEN2022_DANGER(${features.token2022Extensions?.join(',') ?? ''})(-40)`);
  }

  // ── Research: Creator wallet age ──
  if (features.creatorWalletAgeMs !== undefined) {
    if (features.creatorWalletAgeMs < 3_600_000) { score -= 15; reasons.push('NEW_WALLET_<1H(-15)'); }
    else if (features.creatorWalletAgeMs < 86_400_000) { score -= 5; reasons.push('NEW_WALLET_<1D(-5)'); }
  }

  // ── #11: Bonding curve progress ──
  if (features.curveProgressPct !== undefined) {
    if (features.curveProgressPct < 2) { score -= 10; reasons.push(`CURVE_EARLY_${features.curveProgressPct.toFixed(1)}%(-10)`); }
    else if (features.curveProgressPct > 85) { score -= 10; reasons.push(`CURVE_LATE_${features.curveProgressPct.toFixed(1)}%(-10)`); }
  }

  // ── #19: Price instability ──
  if (features.priceUnstable) { score -= 15; reasons.push('PRICE_UNSTABLE(-15)'); }

  // ── #15: Buy velocity acceleration ──
  if (features.buyAcceleration !== undefined) {
    if (features.buyAcceleration > 1.5) { score += 10; reasons.push(`BUY_ACCEL_${features.buyAcceleration.toFixed(1)}(+10)`); }
    else if (features.buyAcceleration < 0.3) { score -= 5; reasons.push(`BUY_DECEL(-5)`); }
  }

  // ── Mayhem bypass ──
  if (features.isMayhem) { score = Math.max(score, minScore); reasons.push('mayhem_pass'); }

  // Clamp 0-100
  score = Math.max(0, Math.min(100, score));

  // Entry multiplier на основе score: хорошие токены получают больше, плохие — меньше
  let entryMultiplier = 1.0;
  if (score >= 80) entryMultiplier = 1.5;        // high confidence → 1.5x entry
  else if (score >= 60) entryMultiplier = 1.0;    // normal
  else if (score >= minScore) entryMultiplier = 0.5; // low confidence → half entry

  logger.debug(`[scorer] ${score}pts enter=${score >= minScore} mul=${entryMultiplier} | ${reasons.join(' ')}`);

  return { score, shouldEnter: score >= minScore, reasons, entryMultiplier };
}
