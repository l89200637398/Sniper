import { Connection, PublicKey } from '@solana/web3.js';
import { isTokenSafeCached } from '../utils/safety';
import { checkRugcheck, type RiskLevel, type RugcheckResult } from '../utils/rugcheck';
import { scoreToken, type TokenFeatures, type ScoringResult } from '../utils/token-scorer';
import { checkSocialSignals } from '../utils/social';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface PipelineInput {
  mint: string;
  protocol: string;
  solReserve: number;
  tokenReserve: number;
  connection: Connection;
  currentPositions: number;
  maxPositions: number;
  currentExposure: number;
  maxExposure: number;
  entryAmountSol: number;
  independentBuyers?: number;
  creator?: string;
}

export interface PipelineResult {
  shouldEnter: boolean;
  skipReason?: string;
  scoringResult?: ScoringResult;
  rugcheckResult?: RugcheckResult;
  safetyResult?: { safe: boolean; reason?: string };
  socialScore: number;
  tokenScore: number;
  rugcheckRisk: RiskLevel;
  safetySafe: boolean;
  diagnostics: Record<string, any>;
}

/**
 * Mirrors the real bot's entry pipeline:
 *  1. Position/exposure limits (blocking)
 *  2. Rugcheck + social + safety in parallel
 *  3. Rugcheck HIGH → block (like real onNewToken)
 *  4. Safety failed → block
 *  5. scoreToken → INFORMATIONAL ONLY (real bot scores AFTER buy, not as a gate)
 *
 * The real sniper's onTrendConfirmed does NOT call scoreToken() — it only
 * checks position limits, protocol slots, and entry momentum. Scoring
 * happens post-confirmation at line 2658 for analytics/sizing.
 */
export async function runEntryPipeline(input: PipelineInput): Promise<PipelineResult> {
  const {
    mint, protocol, solReserve, tokenReserve, connection,
    currentPositions, maxPositions, currentExposure, maxExposure,
    entryAmountSol, independentBuyers, creator,
  } = input;

  const diagnostics: Record<string, any> = { mint, protocol };
  let scoringResult: ScoringResult | undefined;
  let rugcheckResult: RugcheckResult | undefined;
  let safetyResult: { safe: boolean; reason?: string } | undefined;
  let socialScore = 0;

  if (currentPositions >= maxPositions) {
    return makeSkip('max_positions', { currentPositions, maxPositions }, diagnostics);
  }

  if (currentExposure + entryAmountSol > maxExposure) {
    return makeSkip('max_exposure', { currentExposure, maxExposure }, diagnostics);
  }

  try {
    const [safetyRes, rugcheckRes, socialRes] = await Promise.allSettled([
      isTokenSafeCached(connection, new PublicKey(mint)),
      checkRugcheck(mint),
      checkSocialSignals(connection, new PublicKey(mint)),
    ]);

    safetyResult = safetyRes.status === 'fulfilled' ? safetyRes.value : { safe: true };
    rugcheckResult = rugcheckRes.status === 'fulfilled' ? rugcheckRes.value : undefined;
    socialScore = socialRes.status === 'fulfilled' ? socialRes.value.score : 0;

    diagnostics.safetyResult = safetyResult;
    diagnostics.socialScore = socialScore;
    diagnostics.rugcheckResult = rugcheckResult ? {
      risk: rugcheckResult.risk,
      score: rugcheckResult.score,
      topHolderPercent: rugcheckResult.topHolderPercent,
      fetchTimeMs: rugcheckResult.fetchTimeMs,
    } : null;

    if (rugcheckResult && rugcheckResult.risk === 'high') {
      // PumpSwap tokens already survived bonding curve (85 SOL liquidity proven).
      // Only block on critical risks (honeypot, freeze); allow the rest.
      const isMigrated = protocol === 'pumpswap';
      const hasCriticalRisk = rugcheckResult.risks.some(r =>
        r.includes('HONEYPOT') || r.includes('freeze_authority'),
      );

      if (!isMigrated || hasCriticalRisk) {
        return makeSkip('rugcheck_high_risk', {
          risk: rugcheckResult.risk,
          score: rugcheckResult.score,
          risks: rugcheckResult.risks,
        }, diagnostics, { safetyResult, rugcheckResult, socialScore });
      }
      logger.debug(`[pipeline] PumpSwap ${mint.slice(0, 8)}: rugcheck=high but no critical risks, allowing`);
    }

    if (!safetyResult.safe) {
      // AMM tokens (PumpSwap/CPMM/AMM v4) already have proven liquidity.
      // Only block on freeze_authority for AMM protocols; skip mintAuthority check.
      const isAmmProtocol = ['pumpswap', 'raydium-cpmm', 'raydium-ammv4'].includes(protocol);
      const isFreezeIssue = safetyResult.reason?.includes('Freeze authority');
      if (!isAmmProtocol || isFreezeIssue) {
        return makeSkip('safety_failed', { reason: safetyResult.reason }, diagnostics, {
          safetyResult, rugcheckResult, socialScore,
        });
      }
      logger.debug(`[pipeline] ${protocol} ${mint.slice(0, 8)}: safety=${safetyResult.reason}, allowing AMM token`);
    }

    // Score token for diagnostics — NOT as a blocking gate.
    // The real bot calls scoreToken AFTER buy confirmation (sniper.ts:2658),
    // not before entry. We collect it here for shadow analytics.
    const features: TokenFeatures = {
      socialScore,
      independentBuyers: independentBuyers ?? 1,
      firstBuySol: entryAmountSol,
      creatorRecentTokens: 0,
      metadataJsonSize: 0,
      rugcheckRisk: rugcheckResult?.risk ?? 'unknown',
      hasMintAuthority: rugcheckResult?.hasMintAuthority ?? false,
      hasFreezeAuthority: rugcheckResult?.hasFreezeAuthority ?? false,
      isMayhem: false,
      topHolderPct: rugcheckResult?.topHolderPercent,
    };

    scoringResult = scoreToken(features, config.strategy.minTokenScore);
    diagnostics.scoringResult = scoringResult;

  } catch (err) {
    logger.warn(`[shadow-pipeline] error for ${mint.slice(0, 8)}: ${err}`);
    diagnostics.pipelineError = String(err);
  }

  return {
    shouldEnter: true,
    socialScore,
    tokenScore: scoringResult?.score ?? 0,
    rugcheckRisk: rugcheckResult?.risk ?? 'unknown',
    safetySafe: safetyResult?.safe ?? true,
    scoringResult,
    rugcheckResult,
    safetyResult,
    diagnostics,
  };
}

function makeSkip(
  reason: string,
  extra: Record<string, any>,
  diagnostics: Record<string, any>,
  results?: {
    safetyResult?: { safe: boolean; reason?: string };
    rugcheckResult?: RugcheckResult;
    scoringResult?: ScoringResult;
    socialScore?: number;
  },
): PipelineResult {
  return {
    shouldEnter: false,
    skipReason: reason,
    socialScore: results?.socialScore ?? 0,
    tokenScore: results?.scoringResult?.score ?? 0,
    rugcheckRisk: results?.rugcheckResult?.risk ?? 'unknown',
    safetySafe: results?.safetyResult?.safe ?? true,
    scoringResult: results?.scoringResult,
    rugcheckResult: results?.rugcheckResult,
    safetyResult: results?.safetyResult,
    diagnostics: { ...diagnostics, skipReason: reason, ...extra },
  };
}
