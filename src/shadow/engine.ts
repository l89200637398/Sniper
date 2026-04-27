import { EventEmitter } from 'events';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { GeyserClient } from '../geyser/client';
import { TrendTracker, TrendMetrics } from '../core/trend-tracker';
import { WalletTracker } from '../core/wallet-tracker';
import { Position } from '../core/position';
import { config } from '../config';
import { logger } from '../utils/logger';
import { logEvent } from '../utils/event-logger';
import { tradeLog } from '../utils/trade-logger';
import { db } from '../db/sqlite';
import { startBlockhashCache, stopBlockhashCache } from '../infra/blockhash-cache';
import { startPriorityFeeCache, stopPriorityFeeCache } from '../infra/priority-fee-cache';
import { SocialManager } from '../social/manager';
import { fetchDexscreenerBoosts } from '../social/parsers/dexscreener';
import { createTelegramFetcher } from '../social/parsers/telegram';
import { runEntryPipeline, type PipelineResult } from './pipeline';
import { getPoolPDAByMint } from '../trading/pumpSwap';
import { getBondingCurvePDA } from '../trading/buy';
import { buildBuyTransaction, buildSellTransaction, simulateTx, type TxBuildResult, type SimulationResult } from './tx-builder';
import { resolveCpmmPool } from '../trading/raydiumCpmm';
import { parseAmmV4Pool, resolveAmmV4Pool } from '../trading/raydiumAmmV4';
import { KNOWN_SKIP_MINTS } from '../constants';
import type { ShadowProfile } from './profiles';

const BUY_FEE_SOL = 0.001;
const SELL_FEE_SOL = 0.001;
const DEFAULT_SLIPPAGE_BPS = 500;

function estimateSlippageBps(solReserve: number, tradeSizeSol: number): number {
  if (solReserve <= 0) return DEFAULT_SLIPPAGE_BPS;
  // Constant-product price impact: tradeSizeSol / (solReserve + tradeSizeSol)
  // Plus protocol fee ~25-50 bps
  const priceImpactBps = (tradeSizeSol / (solReserve + tradeSizeSol)) * 10000;
  const protocolFeeBps = 50;
  const totalBps = Math.ceil(priceImpactBps + protocolFeeBps);
  return Math.max(10, Math.min(totalBps, DEFAULT_SLIPPAGE_BPS));
}
const POLL_INTERVAL_MS = 3000;
const MAX_DETECTED_TOKENS = 2000;
const MAX_TRADE_LOG = 2000;
const MAX_RAYDIUM_POOL_MAP = 5000;
const MAX_COPY_TRADE_MINTS = 3000;
const SOCIAL_POLL_MAX_UNKNOWN = 10;
const SNAPSHOT_INTERVAL_MS = 300_000;
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

interface MonitoredMint {
  mint: string;
  protocol: string;
  accounts: string[];
  readMode: 'bonding-curve' | 'pool-vaults' | 'launch-pool';
  decimals: number;
  isMemeBase: boolean;
  lastSolReserve: number;
  lastTokenReserve: number;
  detectedAt: number;
}

interface PendingBuy {
  mint: string;
  bondingCurve: string;
  creator: string;
  detectedAt: number;
  timer: NodeJS.Timeout;
  independentBuyers: Set<string>;
}

interface PortfolioState {
  profile: ShadowProfile;
  balance: number;
  positions: Map<string, Position>;
  closedTrades: number;
  wins: number;
  totalPnlSol: number;
}

export interface TradeLogEntry {
  profile: string;
  mint: string;
  protocol: string;
  entrySol: number;
  exitSol: number;
  entryPrice: number;
  exitPrice: number;
  pnlPct: number;
  pnlSol: number;
  maxPnlPct?: number;
  exitReason: string;
  durationMs: number;
  openedAt: number;
  closedAt: number;
  feesSol: number;
}

export interface ShadowStatus {
  running: boolean;
  startedAt: number;
  uptimeMs: number;
  profiles: Array<{
    name: string;
    label: string;
    balance: number;
    startBalance: number;
    openPositions: number;
    closedTrades: number;
    wins: number;
    winRate: number;
    totalPnlSol: number;
    exposure: number;
    positions: Array<{
      mint: string;
      protocol: string;
      entryPrice: number;
      currentPrice: number;
      pnlPercent: number;
      entrySol: number;
      durationMs: number;
    }>;
  }>;
  eventCounts: { detected: number; entered: number; exited: number; skipped: number };
  trendSkipReasons: Record<string, number>;
}

export interface DetectedToken {
  mint: string;
  protocol: string;
  outcome: 'entered' | 'skipped';
  skipReason?: string;
  tokenScore: number;
  socialScore: number;
  rugcheckRisk: string;
  safetySafe: boolean;
  detectedAt: number;
}

export interface ShadowReport extends ShadowStatus {
  trades: TradeLogEntry[];
  bestTrade: TradeLogEntry | null;
  worstTrade: TradeLogEntry | null;
  avgDurationMs: number;
  protocolBreakdown: Record<string, { count: number; wins: number; pnlSol: number }>;
  detectedTokens: DetectedToken[];
  detectedByProtocol: Record<string, number>;
  skippedByReason: Record<string, Array<{ mint: string; protocol: string; tokenScore: number; socialScore: number }>>;
}

interface TrendMintContext {
  mint: string;
  protocol: string;
  pipelineResult: PipelineResult;
  accountAddr?: string;
  readMode?: 'bonding-curve' | 'pool-vaults' | 'launch-pool';
  pool?: string;
  vaultAOffset?: number;
  vaultBOffset?: number;
  isScalp?: boolean;
}

export class ShadowEngine extends EventEmitter {
  private geyser: GeyserClient;
  private connection: Connection;
  private trendTracker: TrendTracker;
  private walletTracker: WalletTracker;
  private socialManager: SocialManager;
  private portfolios = new Map<string, PortfolioState>();
  private monitored = new Map<string, MonitoredMint>();
  private seenMints = new Map<string, number>();
  private pendingBuys = new Map<string, PendingBuy>();
  private trendMintCtx = new Map<string, TrendMintContext>();
  private raydiumPoolToMint = new Map<string, { mint: string; protocol: string }>();
  private mintScalpFlag = new Map<string, boolean>();
  private mintFirstSeenPrice = new Map<string, { price: number; ts: number }>();
  private creatorMintHistory = new Map<string, number[]>();
  private protocolCounts = { pumpfun: 0, pumpswap: 0, 'raydium-launch': 0, 'raydium-cpmm': 0, 'raydium-ammv4': 0 };
  private copyTradeMints = new Set<string>();
  private mintCreatorMap = new Map<string, string>();
  private raydiumSwapRecoveryAttempted = new Set<string>();
  private raydiumSwapRecoveryTs = new Map<string, number>();
  private reEntryEligible = new Map<string, { closedAt: number; count: number; lastEntryPrice: number }>();
  private recentTradeWins: boolean[] = [];
  private defensiveMode = false;
  private skipReasons = new Map<string, number>();
  private shadowTradeLog: TradeLogEntry[] = [];
  private detectedTokens: DetectedToken[] = [];
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private updateEmitTimer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private eventCounts = { detected: 0, entered: 0, exited: 0, skipped: 0 };
  private payer: Keypair;
  private totalEntriesAllProfiles = 0;
  private simulationInterval = 1;

  constructor(profiles: ShadowProfile[]) {
    super();
    this.connection = new Connection(config.rpc.url, 'confirmed');
    this.geyser = new GeyserClient();
    this.trendTracker = new TrendTracker();
    this.walletTracker = new WalletTracker();
    this.socialManager = new SocialManager();
    this.payer = Keypair.fromSecretKey(bs58.decode(config.wallet.privateKey));

    for (const p of profiles) {
      this.portfolios.set(p.name, {
        profile: p,
        balance: p.startBalanceSol,
        positions: new Map(),
        closedTrades: 0,
        wins: 0,
        totalPnlSol: 0,
      });
    }
  }

  async start() {
    this.running = true;
    this.startedAt = Date.now();

    // TrendTracker — confirms trends before entry (same as real bot)
    this.trendTracker.start();
    this.trendTracker.on('trend:confirmed', (mint: string, metrics: TrendMetrics) =>
      this.onTrendConfirmed(mint, metrics).catch(err =>
        logger.error(`[shadow] onTrendConfirmed error: ${err}`)
      )
    );
    this.trendTracker.on('trend:strengthening', (mint: string, _metrics: TrendMetrics) => {
      logger.debug(`[shadow] trend:strengthening ${mint.slice(0, 8)}`);
      logEvent('SHADOW_TREND_STRENGTHENING', { mint });
    });
    this.trendTracker.on('trend:weakening', (mint: string, _metrics: TrendMetrics) => {
      logger.debug(`[shadow] trend:weakening ${mint.slice(0, 8)}`);
      logEvent('SHADOW_TREND_WEAKENING', { mint });
      // Same as real bot: exit positions on trend weakening
      for (const [profileName] of this.portfolios) {
        if (this.portfolios.get(profileName)!.positions.has(mint)) {
          this.virtualFullSell(profileName, mint, 'trend_weakening');
        }
      }
    });

    // WalletTracker — copy-trade signal detection (same as real bot)
    await this.walletTracker.start();

    // SocialManager — social signal discovery (Mode C, same as real bot)
    this.socialManager.registerSource('dexscreener', fetchDexscreenerBoosts, 60_000);
    try {
      const tgFetcher = createTelegramFetcher();
      if (tgFetcher) this.socialManager.registerSource('telegram', tgFetcher, 30_000);
    } catch {}
    if (process.env.RAPIDAPI_KEY) {
      try {
        const { createTwitterFetcher } = require('../social/parsers/twitter');
        const twFetcher = createTwitterFetcher();
        this.socialManager.registerSource('twitter', twFetcher, Number(process.env.TWITTER_POLL_INTERVAL_MS ?? '600000'));
      } catch {}
    }
    this.socialManager.start();

    if (config.trend.socialDiscoveryEnabled) {
      this.socialManager.on('signal', (sig: any) => this.onSocialDiscovery(sig));
      logger.info('[shadow] Social discovery enabled');
    }

    // Token create events → pipeline check → register in TrendTracker
    this.geyser.on('newToken', (e: any) => this.onPumpFunCreate(e));
    this.geyser.on('newPumpSwapToken', (e: any) => this.onPumpSwapCreate(e));
    this.geyser.on('raydiumLaunchCreate', (e: any) => this.onRaydiumLaunchCreate(e));
    this.geyser.on('raydiumCpmmNewPool', (e: any) => this.onRaydiumCpmmCreate(e));
    this.geyser.on('raydiumAmmV4NewPool', (e: any) => this.onRaydiumAmmV4Create(e));

    // Buy/sell events → feed TrendTracker + WalletTracker + copy-trade
    this.geyser.on('buyDetected', (e: any) => this.onPumpFunBuy(e));
    this.geyser.on('pumpFunSellDetected', (e: any) => this.onPumpFunSell(e));
    this.geyser.on('pumpSwapBuyDetected', (e: any) => this.onPumpSwapBuy(e));
    this.geyser.on('pumpSwapSellDetected', (e: any) => this.onPumpSwapSell(e));
    this.geyser.on('raydiumLaunchBuyDetected', (e: any) => this.onRaydiumLaunchBuy(e));
    this.geyser.on('raydiumLaunchSellDetected', (e: any) => this.onRaydiumLaunchSell(e));
    this.geyser.on('raydiumCpmmSwapDetected', (e: any) => this.onRaydiumCpmmSwap(e));
    this.geyser.on('raydiumAmmV4SwapDetected', (e: any) => this.onRaydiumAmmV4Swap(e));

    await this.geyser.subscribe();

    startBlockhashCache(this.connection, 'shadow');
    startPriorityFeeCache(this.connection, 'shadow');

    this.pollTimer = setInterval(() => this.pollPrices().catch(err =>
      logger.error('[shadow] poll error:', err)
    ), POLL_INTERVAL_MS);

    this.snapshotTimer = setInterval(() => this.takeSnapshot(), SNAPSHOT_INTERVAL_MS);

    // seenMints TTL cleanup every 10 min (same as real bot)
    setInterval(() => this.cleanSeenMints(), 10 * 60 * 1000);

    // Memory trim every 5 min — prevent OOM on long runs
    setInterval(() => this.trimMemory(), 5 * 60 * 1000);

    this.updateEmitTimer = setInterval(() => {
      if (this.running) this.emit('shadow:update', this.getStatus());
    }, 3000);

    logger.info(`[shadow] Engine started with ${this.portfolios.size} profiles (TrendTracker + WalletTracker + SocialManager active)`);
    logEvent('SHADOW_STARTED', { profiles: Array.from(this.portfolios.keys()), trendTracker: true, walletTracker: true, socialManager: true });
    this.emit('shadow:started');
  }

  async stop(): Promise<ShadowReport> {
    this.running = false;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.snapshotTimer) { clearInterval(this.snapshotTimer); this.snapshotTimer = null; }
    if (this.updateEmitTimer) { clearInterval(this.updateEmitTimer); this.updateEmitTimer = null; }

    for (const [, pending] of this.pendingBuys) clearTimeout(pending.timer);
    this.pendingBuys.clear();

    this.trendTracker.stop();
    this.socialManager.stop();

    try {
      (this.geyser as any).running = false;
      if (typeof (this.geyser as any).destroyStream === 'function') {
        (this.geyser as any).destroyStream();
      }
    } catch {}

    stopBlockhashCache('shadow');
    stopPriorityFeeCache('shadow');

    this.takeSnapshot();
    const report = this.getReport();
    logEvent('SHADOW_STOPPED', { trades: report.trades.length, profiles: report.profiles.map(p => ({ name: p.name, pnl: p.totalPnlSol, wr: p.winRate })) });
    this.emit('shadow:stopped', report);
    return report;
  }

  isRunning() { return this.running; }

  // ── Token create events → pipeline → TrendTracker ──────────────────────

  private onPumpFunCreate(event: any) {
    if (!this.running) return;
    const mint = event.mint as string;
    if (this.seenMints.has(mint)) return;
    this.seenMints.set(mint, Date.now());
    this.eventCounts.detected++;
    if (event.creator) this.mintCreatorMap.set(mint, event.creator);

    this.tryEliteEntry(mint, 'pump.fun', {
      accountAddr: event.bondingCurve,
      readMode: 'bonding-curve' as const,
      creator: event.creator,
    }).catch(err => logger.warn(`[shadow] pump.fun register error: ${err}`));
  }

  private onPumpFunBuy(event: any) {
    if (!this.running) return;
    const mint = event.mint as string;
    const buyer = event.creator as string;
    const solLamports = Number(event.solLamports ?? 0);
    const solAmount = solLamports / 1e9;

    this.walletTracker.recordBuy(buyer, mint, solLamports);
    this.refreshBuyActivity(mint);

    if (this.trendTracker.isTracking(mint)) {
      this.trendTracker.recordBuy(mint, buyer, solAmount);
    } else if (!this.seenMints.has(mint)) {
      this.seenMints.set(mint, Date.now());
      this.eventCounts.detected++;
      const bondingCurve = event.bondingCurve as string | undefined;
      if (bondingCurve) {
        this.trendTracker.track(mint, 'pump.fun');
        this.trendTracker.recordBuy(mint, buyer, solAmount);
        this.trendMintCtx.set(mint, {
          mint, protocol: 'pump.fun', accountAddr: bondingCurve, readMode: 'bonding-curve' as const,
          pipelineResult: { shouldEnter: true, socialScore: 0, tokenScore: 0, rugcheckRisk: 'unknown', safetySafe: true, diagnostics: {} },
        });
        this.runPipelineDeferred(mint, 'pump.fun');
      }
    }

    this.tryCopyTrade(mint, buyer, solLamports, 'pump.fun');
  }

  private onPumpFunSell(event: any) {
    if (!this.running) return;
    const mint = event.mint as string;
    const seller = event.creator as string;
    const solLamports = Number(event.solLamports ?? 0);
    const solAmount = solLamports / 1e9;

    this.walletTracker.recordSell(seller, mint, solLamports);

    if (this.trendTracker.isTracking(mint)) {
      this.trendTracker.recordSell(mint, seller, solAmount);
    }

    // Creator sell exit (same as real bot sniper.ts:3385-3422)
    this.checkCreatorSellExit(mint, seller);
  }

  private onPumpSwapCreate(event: any) {
    if (!this.running) return;
    const mint = event.mint as string;
    if (this.seenMints.has(mint)) return;
    this.seenMints.set(mint, Date.now());
    this.eventCounts.detected++;
    if (event.creator) this.mintCreatorMap.set(mint, event.creator);

    if ((config.strategy as any).pumpSwapInstantEntry) {
      this.tryPumpSwapInstantEntry(mint, event.pool, event.creator)
        .catch(err => logger.warn(`[shadow] pumpswap instant entry error: ${err}`));
    } else {
      this.registerForTrend(mint, 'pumpswap', {
        pool: event.pool,
        creator: event.creator,
      }).catch(err => logger.warn(`[shadow] pumpswap register error: ${err}`));
    }
  }

  private async tryPumpSwapInstantEntry(mint: string, pool: string, creator?: string) {
    if (creator) {
      this.recordCreatorMint(creator);
      if (this.countCreatorRecentTokens(creator) >= 3) {
        this.recordSkip('creator_spam', mint, 'pumpswap');
        return;
      }
    }

    const pipelineResult = await this.runPipeline(mint, 'pumpswap', 0, 0);
    if (!pipelineResult.shouldEnter) {
      this.logTrendSkip(mint, 'pumpswap', pipelineResult);
      return;
    }

    // Rugcheck is already handled in pipeline with protocol-aware logic (PumpSwap relaxed)

    logger.info(`[shadow] ⚡ PUMPSWAP INSTANT: ${mint.slice(0, 8)} (rug=${pipelineResult.rugcheckRisk}, score=${pipelineResult.tokenScore})`);
    logEvent('SHADOW_PUMPSWAP_INSTANT', { mint, rugRisk: pipelineResult.rugcheckRisk, tokenScore: pipelineResult.tokenScore });

    await this.enterFromPumpSwapPool(mint, pool, pipelineResult);

    this.trendMintCtx.set(mint, { mint, protocol: 'pumpswap', pipelineResult, pool });
    this.trendTracker.track(mint, 'pumpswap');
  }

  private onPumpSwapBuy(event: any) {
    if (!this.running) return;
    const mint = event.mint as string;
    const buyer = event.creator as string;
    const solLamports = Number(event.solLamports ?? 0);
    const solAmount = solLamports / 1e9;

    this.walletTracker.recordBuy(buyer, mint, solLamports);
    this.refreshBuyActivity(mint);
    this.tryCopyTrade(mint, buyer, solLamports, 'pumpswap');

    if (this.trendTracker.isTracking(mint)) {
      this.trendTracker.recordBuy(mint, buyer, solAmount);
    } else if (!this.seenMints.has(mint)) {
      this.seenMints.set(mint, Date.now());
      this.eventCounts.detected++;
      const pool = (event.pool as string) || getPoolPDAByMint(new PublicKey(mint)).toBase58();
      this.trendTracker.track(mint, 'pumpswap');
      this.trendTracker.recordBuy(mint, buyer, solAmount);
      this.trendMintCtx.set(mint, {
        mint, protocol: 'pumpswap', pool,
        pipelineResult: { shouldEnter: true, socialScore: 0, tokenScore: 0, rugcheckRisk: 'unknown', safetySafe: true, diagnostics: {} },
      });
      this.runPipelineDeferred(mint, 'pumpswap');
    }
  }

  private onPumpSwapSell(event: any) {
    if (!this.running) return;
    const mint = event.mint as string;
    const seller = event.creator as string;
    const solLamports = Number(event.solLamports ?? 0);
    const solAmount = solLamports / 1e9;

    this.walletTracker.recordSell(seller, mint, solLamports);

    if (this.trendTracker.isTracking(mint)) {
      this.trendTracker.recordSell(mint, seller, solAmount);
    }

    this.checkCreatorSellExit(mint, seller);
  }

  private onRaydiumLaunchCreate(event: any) {
    if (!this.running) return;
    const mint = event.mint as string;
    if (this.seenMints.has(mint)) return;
    this.seenMints.set(mint, Date.now());
    this.eventCounts.detected++;

    this.registerForTrend(mint, 'raydium-launch', {
      accountAddr: event.pool,
      readMode: 'launch-pool',
      creator: event.creator,
    }).catch(err => logger.warn(`[shadow] raydium-launch register error: ${err}`));
  }

  private onRaydiumLaunchBuy(event: any) {
    if (!this.running) return;
    const mint = event.mint as string;
    const buyer = event.buyer as string;
    const solAmount = Number(event.amountSol ?? 0) / 1e9;

    this.refreshBuyActivity(mint);

    if (this.trendTracker.isTracking(mint)) {
      this.trendTracker.recordBuy(mint, buyer, solAmount);
    } else if (!this.seenMints.has(mint)) {
      this.seenMints.set(mint, Date.now());
      this.eventCounts.detected++;
      this.trendTracker.track(mint, 'raydium-launch');
      this.trendTracker.recordBuy(mint, buyer, solAmount);
      if (event.pool) {
        this.trendMintCtx.set(mint, {
          mint, protocol: 'raydium-launch', accountAddr: event.pool, readMode: 'launch-pool',
          pipelineResult: { shouldEnter: true, socialScore: 0, tokenScore: 0, rugcheckRisk: 'unknown', safetySafe: true, diagnostics: {} },
        });
        this.runPipelineDeferred(mint, 'raydium-launch');
      }
    }
  }

  private onRaydiumLaunchSell(event: any) {
    if (!this.running) return;
    const mint = event.mint as string;
    const seller = event.seller ?? event.buyer ?? '';
    if (this.trendTracker.isTracking(mint)) {
      this.trendTracker.recordSell(mint, seller, 0);
    }
  }

  private onRaydiumCpmmCreate(event: any) {
    if (!this.running) return;
    const mint = event.mint as string;
    if (this.seenMints.has(mint)) return;
    this.seenMints.set(mint, Date.now());
    this.eventCounts.detected++;

    this.raydiumPoolToMint.set(event.pool, { mint, protocol: 'raydium-cpmm' });
    this.registerForTrend(mint, 'raydium-cpmm', {
      pool: event.pool,
      vaultAOffset: 72,
      vaultBOffset: 104,
    }).catch(err => logger.warn(`[shadow] raydium-cpmm register error: ${err}`));
  }

  private onRaydiumCpmmSwap(event: any) {
    if (!this.running) return;
    const mapped = this.raydiumPoolToMint.get(event.pool);
    if (mapped) {
      const user = event.user as string;
      const isBuy = event.inputMint === WSOL_MINT;
      const solAmount = isBuy ? Number(event.amountIn ?? 0) / 1e9 : 0;

      if (isBuy) this.refreshBuyActivity(mapped.mint);

      if (this.trendTracker.isTracking(mapped.mint)) {
        if (isBuy) this.trendTracker.recordBuy(mapped.mint, user, solAmount);
        else this.trendTracker.recordSell(mapped.mint, user, 0);
      }
      return;
    }

    if (!config.trend.enabled) return;

    const memeMint = event.inputMint === WSOL_MINT ? event.outputMint : event.inputMint;
    if (KNOWN_SKIP_MINTS.has(memeMint)) return;
    if (this.raydiumSwapRecoveryAttempted.has(memeMint)) return;

    const now = Date.now();
    const lastTry = this.raydiumSwapRecoveryTs.get(memeMint) ?? 0;
    if (now - lastTry < 10_000) return;

    this.raydiumSwapRecoveryAttempted.add(memeMint);
    this.raydiumSwapRecoveryTs.set(memeMint, now);
    this.recoverRaydiumCpmmMint(memeMint, event.pool).catch(() => {});
  }

  private onRaydiumAmmV4Create(event: any) {
    if (!this.running) return;
    const baseMint = event.baseMint as string;
    const quoteMint = event.quoteMint as string;
    const mint = quoteMint === WSOL_MINT ? baseMint : quoteMint;
    if (this.seenMints.has(mint)) return;
    this.seenMints.set(mint, Date.now());
    this.eventCounts.detected++;

    this.raydiumPoolToMint.set(event.pool, { mint, protocol: 'raydium-ammv4' });
    this.registerForTrend(mint, 'raydium-ammv4', {
      pool: event.pool,
      vaultAOffset: 336,
      vaultBOffset: 368,
    }).catch(err => logger.warn(`[shadow] raydium-ammv4 register error: ${err}`));
  }

  private onRaydiumAmmV4Swap(event: any) {
    if (!this.running) return;
    const mapped = this.raydiumPoolToMint.get(event.pool);
    if (mapped) {
      const user = event.user as string;
      const solAmount = Number(event.amountIn ?? 0) / 1e9;

      let isBuy = true;
      if (event.userInputAta && user) {
        try {
          const userPk = new PublicKey(user);
          const wsolPk = new PublicKey(WSOL_MINT);
          const expectedWsolAta = getAssociatedTokenAddressSync(wsolPk, userPk, false).toBase58();
          if (event.userInputAta !== expectedWsolAta) isBuy = false;
        } catch { /* conservative: treat as buy */ }
      }

      if (isBuy) {
        this.refreshBuyActivity(mapped.mint);
        if (this.trendTracker.isTracking(mapped.mint)) {
          this.trendTracker.recordBuy(mapped.mint, user, solAmount);
        }
      } else {
        if (this.trendTracker.isTracking(mapped.mint)) {
          this.trendTracker.recordSell(mapped.mint, user, 0);
        }
      }
      return;
    }

    if (!config.trend.enabled) return;

    if (this.raydiumSwapRecoveryAttempted.has(event.pool)) return;
    const now = Date.now();
    const lastTry = this.raydiumSwapRecoveryTs.get(event.pool) ?? 0;
    if (now - lastTry < 10_000) return;

    this.raydiumSwapRecoveryAttempted.add(event.pool);
    this.raydiumSwapRecoveryTs.set(event.pool, now);
    this.recoverRaydiumAmmV4Pool(event.pool).catch(() => {});
  }

  // ── Social discovery (Mode C, same as real bot sniper.ts:4758-4815) ─────

  private onSocialDiscovery(sig: any) {
    if (!config.trend.socialDiscoveryEnabled) return;
    if (!sig.mint) return;

    const mint = sig.mint as string;
    if (this.hasAnyPosition(mint)) return;

    if (this.seenMints.has(mint)) {
      if (this.trendTracker.isTracking(mint)) {
        this.trendTracker.recordSocialSignal(mint, true);
      }
      return;
    }

    if (this.trendTracker.trackedCount >= (config.trend as any).socialMaxTrackedMints) return;

    this.seenMints.set(mint, Date.now());
    this.trendTracker.track(mint, 'unknown');
    this.trendTracker.recordSocialSignal(mint, true);

    logger.info(`[shadow] SOCIAL DISCOVERY: ${mint.slice(0, 8)} from ${sig.source} — tracking`);
    logEvent('SHADOW_SOCIAL_DISCOVERY', { mint, source: sig.source, author: sig.author, sentiment: sig.sentiment });

    // RPC polling for protocol detection (same as real bot sniper.ts:4790-4815)
    this.pollSocialDiscoveryMint(mint).catch(err =>
      logger.debug(`[shadow] Social discovery polling failed for ${mint}: ${err}`)
    );
  }

  // ── Copy-trade signal (same as real bot sniper.ts:1220-1310) ──────────

  private tryCopyTrade(mint: string, buyer: string, solLamports: number, protocol: string) {
    if (!config.strategy.copyTrade.enabled) return;
    if (this.hasAnyPosition(mint)) return;
    if (this.copyTradeMints.has(mint)) return;
    if (this.seenMints.has(mint) && !this.trendTracker.isTracking(mint)) return;

    const ct = this.walletTracker.isCopySignal(buyer, solLamports);
    if (!ct.signal) return;

    const ctEntry = ct.tier === 1
      ? config.strategy.copyTrade.entryAmountSol
      : ((config.strategy.copyTrade as any).tier2EntryAmountSol ?? config.strategy.copyTrade.entryAmountSol * 0.5);

    this.copyTradeMints.add(mint);
    this.eventCounts.detected++;

    logger.info(`[shadow] COPY-TRADE T${ct.tier}: ${buyer.slice(0, 8)} bought ${mint.slice(0, 8)} (${protocol}) — entry=${ctEntry}`);
    logEvent('SHADOW_COPY_TRADE', { mint, buyer: buyer.slice(0, 8), tier: ct.tier, entryAmount: ctEntry, protocol });

    const monitored = this.monitored.get(mint);
    if (monitored) {
      this.executeCopyTradeEntry(mint, protocol, ctEntry, monitored.lastSolReserve, monitored.lastTokenReserve);
    } else {
      this.fetchReservesForCopyTrade(mint, protocol, ctEntry).catch(err =>
        logger.debug(`[shadow] copy-trade reserves fetch failed for ${mint.slice(0, 8)}: ${err}`)
      );
    }
  }

  private executeCopyTradeEntry(mint: string, protocol: string, ctEntry: number, solReserve: number, tokenReserve: number) {
    const price = (solReserve / 1e9) / (tokenReserve / 1e6);
    if (price <= 0 || !isFinite(price)) return;

    for (const [name, portfolio] of this.portfolios) {
      if (portfolio.positions.has(mint)) continue;
      if (portfolio.positions.size >= portfolio.profile.maxPositions) continue;
      const exposure = this.getExposure(portfolio);
      if (exposure + ctEntry > portfolio.profile.maxExposureSol) continue;
      if (portfolio.balance < ctEntry + BUY_FEE_SOL) continue;

      this.tryVirtualBuy(name, mint, protocol, price, solReserve, tokenReserve, undefined, ctEntry);
    }
  }

  private async fetchReservesForCopyTrade(mint: string, protocol: string, ctEntry: number) {
    if (protocol === 'pump.fun') {
      const bc = getBondingCurvePDA(new PublicKey(mint));
      const reserves = await this.readSingleAccountReserves(bc.toBase58(), 'bonding-curve');
      if (reserves) this.executeCopyTradeEntry(mint, protocol, ctEntry, reserves.solReserve, reserves.tokenReserve);
    } else if (protocol === 'pumpswap') {
      const pool = getPoolPDAByMint(new PublicKey(mint));
      const info = await this.connection.getAccountInfo(pool);
      if (!info || info.data.length < 301) return;
      const baseVault = new PublicKey(info.data.subarray(139, 171));
      const quoteVault = new PublicKey(info.data.subarray(171, 203));
      const baseMint = new PublicKey(info.data.subarray(43, 75)).toBase58();
      const vaultInfos = await this.connection.getMultipleAccountsInfo([baseVault, quoteVault]);
      if (!vaultInfos[0] || !vaultInfos[1]) return;
      const baseBalance = Number(vaultInfos[0].data.readBigUInt64LE(64));
      const quoteBalance = Number(vaultInfos[1].data.readBigUInt64LE(64));
      const isMemeBase = baseMint === mint;
      const solReserve = isMemeBase ? quoteBalance : baseBalance;
      const tokenReserve = isMemeBase ? baseBalance : quoteBalance;
      this.executeCopyTradeEntry(mint, protocol, ctEntry, solReserve, tokenReserve);
    }
  }

  // ── Re-entry registration (same as real bot sniper.ts:6498-6530) ──────

  private registerReEntryEligible(mint: string, protocol: string, pnlPercent: number, reason: string) {
    const reCfg: any = (config.strategy as any).trendReEntry;
    if (!reCfg?.enabled) return;
    if (!reCfg.allowedProtocols?.includes(protocol)) return;
    if (reCfg.requiresTpProfit && pnlPercent <= 0) return;

    const badReasons = ['stop_loss', 'hard_stop', 'score_gate', 'ata_empty', 'rpc_error', 'token_lost', 'sell_failed'];
    if (badReasons.includes(reason)) return;

    const prev = this.reEntryEligible.get(mint);
    const count = prev ? prev.count : 0;
    if (count >= (reCfg.maxReEntries ?? 2)) return;

    this.reEntryEligible.set(mint, { closedAt: Date.now(), count: count + 1, lastEntryPrice: 0 });

    if (!this.trendTracker.isTracking(mint)) {
      this.trendTracker.track(mint, protocol);
      logger.info(`[shadow] RE-ENTRY ELIGIBLE: ${mint.slice(0, 8)} (count=${count + 1}) — re-tracking`);
      logEvent('SHADOW_RE_ENTRY_ELIGIBLE', { mint, count: count + 1, protocol });
    }
  }

  // ── Defensive mode (same as real bot sniper.ts:6859-6905) ─────────────

  private recalcDefensiveMode() {
    const dCfg = (config.strategy as any).defensive;
    if (!dCfg?.enabled) return;
    if (this.recentTradeWins.length < (dCfg.window ?? 10)) return;

    const wins = this.recentTradeWins.filter(v => v).length;
    const winRate = wins / this.recentTradeWins.length;

    const wasDefensive = this.defensiveMode;
    if (!wasDefensive && winRate < (dCfg.entryThreshold ?? 0.50)) {
      this.defensiveMode = true;
      logger.warn(`[shadow] DEFENSIVE MODE ON: WR=${(winRate * 100).toFixed(0)}%`);
      logEvent('SHADOW_DEFENSIVE_ON', { winRate, window: this.recentTradeWins.length });
    } else if (wasDefensive && winRate > (dCfg.exitThreshold ?? 0.60)) {
      this.defensiveMode = false;
      logger.info(`[shadow] DEFENSIVE MODE OFF: WR=${(winRate * 100).toFixed(0)}%`);
      logEvent('SHADOW_DEFENSIVE_OFF', { winRate, window: this.recentTradeWins.length });
    }
  }

  private getEffectiveEntry(baseEntry: number): number {
    const dCfg = (config.strategy as any).defensive;
    return this.defensiveMode && dCfg?.enabled ? baseEntry * (dCfg.entryMultiplier ?? 0.70) : baseEntry;
  }

  private hasAnyPosition(mint: string): boolean {
    for (const [, p] of this.portfolios) {
      if (p.positions.has(mint)) return true;
    }
    return false;
  }

  private refreshBuyActivity(mint: string): void {
    for (const [, portfolio] of this.portfolios) {
      const pos = portfolio.positions.get(mint);
      if (pos) pos.lastBuyActivityTs = Date.now();
    }
  }

  // ── Creator sell exit (same as real bot sniper.ts:3385-3422) ──────────

  private checkCreatorSellExit(mint: string, seller: string) {
    if (!config.strategy.creatorSellExit) return;
    const creator = this.mintCreatorMap.get(mint);
    if (!creator || seller !== creator) return;

    for (const [profileName, portfolio] of this.portfolios) {
      const pos = portfolio.positions.get(mint);
      if (!pos) continue;
      const pnl = pos.pnlPercent;
      const minDrop = (config.strategy as any).creatorSellMinDropPct ?? 0;
      if (minDrop > 0 && pnl > -minDrop) {
        logger.debug(`[shadow] Creator sell IGNORED: ${mint.slice(0, 8)} PnL ${pnl.toFixed(1)}% > -${minDrop}%`);
        continue;
      }
      logger.warn(`[shadow] ${profileName} CREATOR SELL: ${mint.slice(0, 8)} — urgent exit`);
      logEvent('SHADOW_CREATOR_SELL', { profile: profileName, mint, seller: seller.slice(0, 8), pnl });
      this.virtualFullSell(profileName, mint, 'creator_sell');
    }
  }

  // ── Adaptive scoring (same as real bot sniper.ts:6886-6900) ────────────

  private getAdaptiveScoreBump(): number {
    const aCfg: any = (config.strategy as any).adaptiveScoring;
    if (!aCfg?.enabled) return 0;
    if (this.recentTradeWins.length < (aCfg.window ?? 20)) return 0;
    const wins = this.recentTradeWins.slice(-(aCfg.window ?? 20)).filter(v => v).length;
    const winRate = wins / (aCfg.window ?? 20);
    const target = aCfg.targetWinRate ?? 0.50;
    if (winRate >= target) return 0;
    const gapPp = (target - winRate) * 100;
    const raw = Math.ceil(gapPp / 5) * (aCfg.bumpPerMiss ?? 3);
    return Math.min(raw, aCfg.maxBump ?? 15);
  }

  private getEffectiveMinScore(): number {
    const dCfg = (config.strategy as any).defensive;
    const base = config.strategy.minTokenScore;
    const defensiveBump = this.defensiveMode && dCfg?.enabled ? (dCfg.scoreDelta ?? 0) : 0;
    const adaptiveBump = this.getAdaptiveScoreBump();
    const combinedBump = Math.min(defensiveBump + adaptiveBump, 12);
    return base + combinedBump;
  }

  // ── seenMints cleanup (same as real bot — 60 min TTL) ─────────────────

  private cleanSeenMints() {
    const now = Date.now();
    const TTL = 60 * 60 * 1000;
    let removed = 0;
    for (const [mint, ts] of this.seenMints) {
      if (now - ts > TTL && !this.hasAnyPosition(mint) && !this.trendTracker.isTracking(mint)) {
        this.seenMints.delete(mint);
        this.mintCreatorMap.delete(mint);
        this.mintFirstSeenPrice.delete(mint);
        this.mintScalpFlag.delete(mint);
        removed++;
      }
    }
    if (removed > 0) {
      logger.debug(`[shadow] cleanSeenMints: removed ${removed} expired, remaining=${this.seenMints.size}`);
    }
  }

  // ── Raydium swap recovery (mirrors real bot sniper.ts:4254-4340) ────────

  private async recoverRaydiumCpmmMint(mint: string, poolHint: string): Promise<void> {
    try {
      const maxPos = Math.max(...Array.from(this.portfolios.values()).map(p => p.profile.maxPositions));
      const totalPos = Math.max(...Array.from(this.portfolios.values()).map(p => p.positions.size));
      if (totalPos >= maxPos) return;
      if (this.protocolCounts['raydium-cpmm'] >= config.strategy.maxRaydiumCpmmPositions) return;
      if (this.seenMints.has(mint)) return;

      const mintPk = new PublicKey(mint);
      const { poolId, solReserve, tokenReserve } = await resolveCpmmPool(this.connection, mintPk, new PublicKey(poolHint));

      const solReserveSol = Number(solReserve) / 1e9;
      if (solReserveSol < config.strategy.raydiumCpmm.minLiquiditySol) {
        logger.debug(`[shadow] raydium-cpmm-recovery ${mint.slice(0,8)} low liq ${solReserveSol.toFixed(3)} SOL, skip`);
        return;
      }
      const isScalp = solReserveSol >= config.strategy.scalpLiquidityThresholdSol;
      if (isScalp) {
        logger.info(`[shadow] raydium-cpmm-recovery ${mint.slice(0,8)} SCALP mode liq=${solReserveSol.toFixed(0)} SOL`);
      }

      this.raydiumPoolToMint.set(poolId.toBase58(), { mint, protocol: 'raydium-cpmm' });
      this.mintScalpFlag.set(mint, isScalp);
      this.seenMints.set(mint, Date.now());
      this.eventCounts.detected++;

      this.trendTracker.track(mint, 'raydium-cpmm');
      logger.info(`[shadow] 🔄 Raydium CPMM RECOVERY: ${mint.slice(0, 8)} liq=${solReserveSol.toFixed(2)} SOL`);
      logEvent('SHADOW_RAYDIUM_CPMM_RECOVERY', { mint, pool: poolId.toBase58(), liquiditySol: solReserveSol });

      if (tokenReserve > 0n) {
        this.mintFirstSeenPrice.set(mint, {
          price: Number(solReserve) / Number(tokenReserve),
          ts: Date.now(),
        });
      }

      this.registerForTrend(mint, 'raydium-cpmm', {
        pool: poolId.toBase58(),
        vaultAOffset: 72,
        vaultBOffset: 104,
      }).catch(err => logger.warn(`[shadow] raydium-cpmm-recovery register error: ${err}`));
    } catch (err) {
      logger.debug(`[shadow] raydium-cpmm-recovery ${mint.slice(0, 8)}: ${err}`);
    }
  }

  private async recoverRaydiumAmmV4Pool(poolStr: string): Promise<void> {
    try {
      const maxPos = Math.max(...Array.from(this.portfolios.values()).map(p => p.profile.maxPositions));
      const totalPos = Math.max(...Array.from(this.portfolios.values()).map(p => p.positions.size));
      if (totalPos >= maxPos) return;
      if (this.protocolCounts['raydium-ammv4'] >= config.strategy.maxRaydiumAmmV4Positions) return;

      const poolPk = new PublicKey(poolStr);
      const poolAcc = await this.connection.getAccountInfo(poolPk);
      if (!poolAcc) return;

      const pool = parseAmmV4Pool(poolAcc.data);
      const wsol = new PublicKey(WSOL_MINT);
      let mint: PublicKey | null = null;
      if (pool.baseMint.equals(wsol))      mint = pool.quoteMint;
      else if (pool.quoteMint.equals(wsol)) mint = pool.baseMint;
      else return;

      const mintStr = mint.toBase58();
      if (KNOWN_SKIP_MINTS.has(mintStr)) return;
      if (this.seenMints.has(mintStr)) return;

      const resolved = await resolveAmmV4Pool(this.connection, mint, poolPk);
      const solReserveSol = Number(resolved.solReserve) / 1e9;
      if (solReserveSol < config.strategy.raydiumAmmV4.minLiquiditySol) {
        logger.debug(`[shadow] raydium-ammv4-recovery ${mintStr.slice(0,8)} low liq ${solReserveSol.toFixed(3)} SOL, skip`);
        return;
      }
      const isScalp = solReserveSol >= config.strategy.scalpLiquidityThresholdSol;
      if (isScalp) {
        logger.info(`[shadow] raydium-ammv4-recovery ${mintStr.slice(0,8)} SCALP mode liq=${solReserveSol.toFixed(0)} SOL`);
      }

      this.raydiumPoolToMint.set(poolStr, { mint: mintStr, protocol: 'raydium-ammv4' });
      this.mintScalpFlag.set(mintStr, isScalp);
      this.seenMints.set(mintStr, Date.now());
      this.eventCounts.detected++;

      this.trendTracker.track(mintStr, 'raydium-ammv4');
      logger.info(`[shadow] 🔄 Raydium AMM v4 RECOVERY: ${mintStr.slice(0, 8)} liq=${solReserveSol.toFixed(2)} SOL`);
      logEvent('SHADOW_RAYDIUM_AMMV4_RECOVERY', { mint: mintStr, pool: poolStr, liquiditySol: solReserveSol });

      if (resolved.tokenReserve > 0n) {
        this.mintFirstSeenPrice.set(mintStr, {
          price: Number(resolved.solReserve) / Number(resolved.tokenReserve),
          ts: Date.now(),
        });
      }

      this.registerForTrend(mintStr, 'raydium-ammv4', {
        pool: poolStr,
        vaultAOffset: 336,
        vaultBOffset: 368,
      }).catch(err => logger.warn(`[shadow] raydium-ammv4-recovery register error: ${err}`));
    } catch (err) {
      logger.debug(`[shadow] raydium-ammv4-recovery ${poolStr.slice(0, 8)}: ${err}`);
    }
  }

  private trimMemory() {
    const before = {
      detected: this.detectedTokens.length,
      trades: this.shadowTradeLog.length,
      pools: this.raydiumPoolToMint.size,
      copyMints: this.copyTradeMints.size,
      creators: this.creatorMintHistory.size,
    };

    if (this.detectedTokens.length > MAX_DETECTED_TOKENS) {
      this.detectedTokens = this.detectedTokens.slice(-MAX_DETECTED_TOKENS);
    }
    if (this.shadowTradeLog.length > MAX_TRADE_LOG) {
      this.shadowTradeLog = this.shadowTradeLog.slice(-MAX_TRADE_LOG);
    }

    if (this.raydiumPoolToMint.size > MAX_RAYDIUM_POOL_MAP) {
      const entries = [...this.raydiumPoolToMint.entries()];
      this.raydiumPoolToMint = new Map(entries.slice(-MAX_RAYDIUM_POOL_MAP));
    }

    if (this.copyTradeMints.size > MAX_COPY_TRADE_MINTS) {
      const arr = [...this.copyTradeMints];
      this.copyTradeMints = new Set(arr.slice(-MAX_COPY_TRADE_MINTS));
    }

    const now = Date.now();
    const CREATOR_TTL = 30 * 60 * 1000;
    for (const [creator, times] of this.creatorMintHistory) {
      const recent = times.filter(t => now - t < CREATOR_TTL);
      if (recent.length === 0) this.creatorMintHistory.delete(creator);
      else this.creatorMintHistory.set(creator, recent);
    }

    const RECOVERY_TTL = 10 * 60 * 1000;
    for (const [key, ts] of this.raydiumSwapRecoveryTs) {
      if (now - ts > RECOVERY_TTL) {
        this.raydiumSwapRecoveryTs.delete(key);
        this.raydiumSwapRecoveryAttempted.delete(key);
      }
    }

    const mem = process.memoryUsage();
    logger.info(
      `[shadow] trimMemory: detected=${before.detected}→${this.detectedTokens.length} ` +
      `trades=${before.trades}→${this.shadowTradeLog.length} ` +
      `pools=${before.pools}→${this.raydiumPoolToMint.size} ` +
      `heap=${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB/${(mem.heapTotal / 1024 / 1024).toFixed(0)}MB ` +
      `rss=${(mem.rss / 1024 / 1024).toFixed(0)}MB`
    );
  }

  // ── Social discovery protocol polling (same as real bot sniper.ts:4790-4815) ──

  private async pollSocialDiscoveryMint(mint: string) {
    const intervalMs = (config.trend as any).socialPollIntervalMs ?? 5_000;
    const maxPolls = Math.ceil(((config.trend as any).raydiumTimeoutMs ?? 600_000) / intervalMs);
    const mintPk = new PublicKey(mint);
    let unknownCount = 0;

    for (let i = 0; i < maxPolls; i++) {
      if (!this.trendTracker.isTracking(mint)) return;
      if (this.hasAnyPosition(mint)) return;

      try {
        const { detectProtocol } = require('../core/detector');
        const detected = await detectProtocol(this.connection, mintPk);
        if (detected.protocol !== 'unknown') {
          const proto = detected.protocol === 'pumpfun' ? 'pump.fun' : detected.protocol;
          this.trendTracker.remove(mint);
          this.trendTracker.track(mint, proto);
          this.trendTracker.recordSocialSignal(mint, true);

          const ctx: TrendMintContext = {
            mint, protocol: proto,
            pipelineResult: { shouldEnter: true, socialScore: 1, tokenScore: 0, rugcheckRisk: 'unknown', safetySafe: true, diagnostics: {} },
          };

          if (detected.protocol === 'pumpfun' && detected.bondingCurve) {
            ctx.accountAddr = detected.bondingCurve.toBase58();
            ctx.readMode = 'bonding-curve';
          } else if (detected.protocol === 'pumpswap') {
            ctx.pool = getPoolPDAByMint(mintPk).toBase58();
          } else if (detected.protocol === 'raydium-launch' && detected.pool) {
            ctx.accountAddr = detected.pool.toBase58();
            ctx.readMode = 'launch-pool';
          } else if ((detected.protocol === 'raydium-cpmm' || detected.protocol === 'raydium-ammv4') && detected.pool) {
            ctx.pool = detected.pool.toBase58();
            ctx.vaultAOffset = detected.protocol === 'raydium-cpmm' ? 72 : 336;
            ctx.vaultBOffset = detected.protocol === 'raydium-cpmm' ? 104 : 368;
          }

          this.trendMintCtx.set(mint, ctx);
          this.runPipelineDeferred(mint, proto);
          logger.info(`[shadow] Social discovery ${mint.slice(0, 8)}: detected protocol=${proto}`);
          unknownCount = 0;
          return;
        }
        unknownCount++;
        if (unknownCount >= SOCIAL_POLL_MAX_UNKNOWN) {
          logger.debug(`[shadow] Social poll ${mint.slice(0, 8)}: ${SOCIAL_POLL_MAX_UNKNOWN} unknown results, giving up`);
          this.trendTracker.remove(mint);
          this.trendMintCtx.delete(mint);
          return;
        }
      } catch {
        unknownCount++;
        if (unknownCount >= SOCIAL_POLL_MAX_UNKNOWN) {
          this.trendTracker.remove(mint);
          this.trendMintCtx.delete(mint);
          return;
        }
      }

      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  // ── Elite entry (Mode A): instant entry if prelimScore >= eliteScoreThreshold ─

  private async tryEliteEntry(mint: string, protocol: string, opts: {
    accountAddr?: string; readMode?: 'bonding-curve' | 'launch-pool';
    pool?: string; vaultAOffset?: number; vaultBOffset?: number;
    creator?: string;
  }) {
    if (!config.trend.enabled) return;

    if (opts.creator) {
      this.recordCreatorMint(opts.creator);
      if (this.countCreatorRecentTokens(opts.creator) >= 3) {
        this.recordSkip('creator_spam', mint, protocol);
        return;
      }
    }

    const pipelineResult = await this.runPipeline(mint, protocol, 0, 0);
    if (!pipelineResult.shouldEnter) {
      this.logTrendSkip(mint, protocol, pipelineResult);
      return;
    }

    const socialScore = pipelineResult.socialScore;
    const rugRisk = pipelineResult.rugcheckRisk ?? 'unknown';
    const creatorTokens = opts.creator ? this.countCreatorRecentTokens(opts.creator) : 0;

    let prelimScore = 0;
    prelimScore += Math.min(socialScore * 15, 40);
    if (rugRisk === 'low') prelimScore += 20;
    else if (rugRisk === 'medium') prelimScore += 5;
    if (creatorTokens <= 1) prelimScore += 15;
    else if (creatorTokens < 3) prelimScore += 10;

    if (prelimScore >= (config.trend as any).eliteScoreThreshold) {
      logger.info(`[shadow] ⭐ ELITE ENTRY: ${mint.slice(0, 8)} prelimScore=${prelimScore} (social=${socialScore} rug=${rugRisk})`);
      logEvent('SHADOW_ELITE_ENTRY', { mint, protocol, prelimScore, socialScore, rugRisk });

      if (opts.accountAddr && opts.readMode) {
        await this.enterFromAccount(mint, protocol, opts.accountAddr, opts.readMode, pipelineResult);
      } else if (opts.pool && protocol === 'pumpswap') {
        await this.enterFromPumpSwapPool(mint, opts.pool, pipelineResult);
      }
      return;
    }

    // Mode B: register in TrendTracker, wait for confirmation (reuse pipeline result)
    await this.registerForTrend(mint, protocol, opts, pipelineResult);
  }

  // ── Register detected tokens in TrendTracker (pipeline + track) ─────────

  private async registerForTrend(mint: string, protocol: string, opts: {
    accountAddr?: string; readMode?: 'bonding-curve' | 'launch-pool';
    pool?: string; vaultAOffset?: number; vaultBOffset?: number;
    creator?: string;
  }, precomputedPipeline?: PipelineResult) {
    if (opts.creator && !precomputedPipeline) {
      this.recordCreatorMint(opts.creator);
      if (this.countCreatorRecentTokens(opts.creator) >= 3) {
        this.recordSkip('creator_spam', mint, protocol);
        return;
      }
    }

    const pipelineResult = precomputedPipeline ?? await this.runPipeline(mint, protocol, 0, 0);
    if (!pipelineResult.shouldEnter) {
      this.logTrendSkip(mint, protocol, pipelineResult);
      return;
    }

    const { creator: _creator, ...ctxOpts } = opts;
    const isScalp = this.mintScalpFlag.get(mint) ?? false;
    this.trendMintCtx.set(mint, { mint, protocol, pipelineResult, ...ctxOpts, isScalp });
    this.trendTracker.track(mint, protocol);
    logger.debug(`[shadow] TRACKING ${protocol}${isScalp ? ' SCALP' : ''} ${mint.slice(0, 8)} (score: ${pipelineResult.tokenScore}, social: ${pipelineResult.socialScore})`);
  }

  private runPipelineDeferred(mint: string, protocol: string) {
    this.runPipeline(mint, protocol, 0, 0).then(result => {
      if (!result.shouldEnter) {
        this.logTrendSkip(mint, protocol, result);
        this.trendTracker.remove(mint);
        this.trendMintCtx.delete(mint);
      } else {
        const ctx = this.trendMintCtx.get(mint);
        if (ctx) ctx.pipelineResult = result;
      }
    }).catch(() => {});
  }

  // ── Entry momentum filter (same as real bot sniper.ts:4349-4370) ────────

  private trackFirstSeenPrice(mint: string, solReserve: number, tokenReserve: number) {
    if (this.mintFirstSeenPrice.has(mint)) return;
    if (tokenReserve <= 0) return;
    const price = (solReserve / 1e9) / (tokenReserve / 1e6);
    this.mintFirstSeenPrice.set(mint, { price, ts: Date.now() });
  }

  private checkEntryMomentum(mint: string, currentPrice: number): boolean {
    const cfg: any = (config.strategy as any).entryMomentum;
    if (!cfg?.enabled) return true;
    const first = this.mintFirstSeenPrice.get(mint);
    if (!first || first.price <= 0) return true;
    const ratio = currentPrice / first.price;
    const maxRatio = cfg.maxPumpRatio ?? 3.0;
    if (ratio > maxRatio) {
      logger.info(`[shadow] ENTRY MOMENTUM BLOCKED: ${mint.slice(0, 8)} pumped ${ratio.toFixed(1)}x > ${maxRatio}x`);
      logEvent('SHADOW_ENTRY_MOMENTUM_BLOCKED', { mint, ratio, firstPrice: first.price, currentPrice });
      return false;
    }
    return true;
  }

  // ── Creator spam filter (same as real bot sniper.ts:1718-1726) ─────────

  private countCreatorRecentTokens(creator: string): number {
    const now = Date.now();
    const cutoff = now - 60_000;
    const history = this.creatorMintHistory.get(creator);
    if (!history) return 0;
    return history.filter(ts => ts >= cutoff).length;
  }

  private recordCreatorMint(creator: string) {
    if (!creator) return;
    const history = this.creatorMintHistory.get(creator) ?? [];
    history.push(Date.now());
    if (history.length > 20) history.shift();
    this.creatorMintHistory.set(creator, history);
  }

  // ── Per-protocol slot limits (same as real bot) ────────────────────────

  private getProtocolSlotKey(protocol: string): keyof typeof this.protocolCounts {
    if (protocol === 'pump.fun' || protocol === 'pumpfun') return 'pumpfun';
    if (protocol === 'pumpswap') return 'pumpswap';
    if (protocol === 'raydium-launch') return 'raydium-launch';
    if (protocol === 'raydium-cpmm') return 'raydium-cpmm';
    if (protocol === 'raydium-ammv4') return 'raydium-ammv4';
    return 'pumpfun';
  }

  private getProtocolMaxSlots(protocol: string): number {
    if (protocol === 'pump.fun' || protocol === 'pumpfun') return config.strategy.maxPumpFunPositions;
    if (protocol === 'pumpswap') return config.strategy.maxPumpSwapPositions;
    if (protocol === 'raydium-launch') return config.strategy.maxRaydiumLaunchPositions;
    if (protocol === 'raydium-cpmm') return config.strategy.maxRaydiumCpmmPositions;
    if (protocol === 'raydium-ammv4') return config.strategy.maxRaydiumAmmV4Positions;
    return 8;
  }

  private recalcProtocolCounts() {
    this.protocolCounts = { pumpfun: 0, pumpswap: 0, 'raydium-launch': 0, 'raydium-cpmm': 0, 'raydium-ammv4': 0 };
    for (const [, portfolio] of this.portfolios) {
      for (const [, pos] of portfolio.positions) {
        const key = this.getProtocolSlotKey(pos.protocol);
        this.protocolCounts[key]++;
      }
    }
  }

  // ── TrendTracker confirmed → slot checks → entry momentum → enter ─────

  private async onTrendConfirmed(mint: string, metrics: TrendMetrics) {
    if (!this.running) return;
    if (this.hasAnyPosition(mint)) { this.recordSkip('position_exists', mint, metrics.protocol); return; }

    const ctx = this.trendMintCtx.get(mint);

    // Re-entry gate (same as real bot sniper.ts:4440-4463)
    const reCfg: any = (config.strategy as any).trendReEntry;
    const reInfo = this.reEntryEligible.get(mint);
    let entryMultiplier = 1.0;
    if (reInfo) {
      if (!reCfg?.enabled) {
        this.reEntryEligible.delete(mint);
      } else if (reInfo.count >= (reCfg.maxReEntries ?? 2)) {
        this.recordSkip('reentry_max_reached', mint, metrics.protocol);
        this.trendTracker.remove(mint);
        this.trendMintCtx.delete(mint);
        this.reEntryEligible.delete(mint);
        return;
      } else if (Date.now() - reInfo.closedAt < (reCfg.cooldownMs ?? 30_000)) {
        this.recordSkip('reentry_cooldown', mint, metrics.protocol);
        return;
      } else {
        entryMultiplier = reCfg.entryMultiplier ?? 0.5;
        logger.info(`[shadow] RE-ENTRY #${reInfo.count}: ${mint.slice(0, 8)} multiplier=${entryMultiplier}`);
        logEvent('SHADOW_RE_ENTRY', { mint, count: reInfo.count, multiplier: entryMultiplier });
      }
    } else if (this.seenMints.has(mint) && !this.trendTracker.isTracking(mint)) {
      this.recordSkip('recently_seen', mint, metrics.protocol);
      this.trendTracker.remove(mint);
      this.trendMintCtx.delete(mint);
      return;
    }

    logger.info(
      `[shadow] TREND CONFIRMED: ${mint.slice(0, 8)} protocol=${metrics.protocol} ` +
      `buyers=${metrics.uniqueBuyers} vol=${metrics.buyVolumeSol.toFixed(3)} ratio=${metrics.buySellRatio.toFixed(1)}`
    );
    logEvent('SHADOW_TREND_CONFIRMED', { ...metrics, mint });

    this.trendTracker.remove(mint);

    const protocol = ctx?.protocol ?? metrics.protocol;

    // Re-score with actual buyer count from trend confirmation (was independentBuyers=1 at detection)
    let pipelineResult = ctx?.pipelineResult;
    if (pipelineResult && metrics.uniqueBuyers > 1) {
      try {
        pipelineResult = await this.runPipeline(mint, protocol, 0, 0, metrics.uniqueBuyers);
        if (!pipelineResult.shouldEnter) {
          this.logTrendSkip(mint, protocol, pipelineResult);
          this.trendMintCtx.delete(mint);
          return;
        }
      } catch {}
    }

    this.trendMintCtx.delete(mint);

    // Per-protocol slot limit (same as real bot sniper.ts:4510-4602)
    this.recalcProtocolCounts();
    const slotKey = this.getProtocolSlotKey(protocol);
    const maxSlots = this.getProtocolMaxSlots(protocol);
    if (this.protocolCounts[slotKey] >= maxSlots) {
      this.recordSkip(`${slotKey}_slots_full`, mint, protocol);
      return;
    }

    const isScalp = ctx?.isScalp ?? this.mintScalpFlag.get(mint) ?? false;

    try {
      if (ctx?.accountAddr && ctx.readMode && ctx.readMode !== 'pool-vaults') {
        await this.enterFromAccount(mint, protocol, ctx.accountAddr, ctx.readMode, pipelineResult, entryMultiplier, isScalp);
      } else if (ctx?.pool && ctx.vaultAOffset !== undefined && ctx.vaultBOffset !== undefined) {
        await this.enterFromRaydiumPool(mint, protocol, ctx.pool, ctx.vaultAOffset, ctx.vaultBOffset, pipelineResult, entryMultiplier, isScalp);
      } else if (ctx?.pool || protocol === 'pumpswap') {
        await this.enterFromPumpSwapPool(mint, ctx?.pool, pipelineResult, entryMultiplier);
      } else {
        this.recordSkip('no_entry_context', mint, protocol);
      }
    } catch (err) {
      logger.warn(`[shadow] onTrendConfirmed entry error for ${mint.slice(0, 8)}: ${err}`);
      this.recordSkip('entry_error', mint, protocol);
    }
  }

  // ── Entry from on-chain data (after trend confirmed) ──────────────────

  private async enterFromAccount(mint: string, protocol: string, accountAddr: string, readMode: 'bonding-curve' | 'launch-pool', pipelineResult?: PipelineResult, entryMultiplier = 1.0, isScalp = false) {
    const reserves = await this.readSingleAccountReserves(accountAddr, readMode);
    if (!reserves) { this.recordSkip('reserves_unreadable', mint, protocol); return; }

    const { solReserve, tokenReserve } = reserves;
    const price = (solReserve / 1e9) / (tokenReserve / 1e6);
    if (price <= 0 || !isFinite(price)) { this.recordSkip('invalid_price', mint, protocol); return; }

    if (!this.checkEntryMomentum(mint, price)) { this.recordSkip('entry_momentum_failed', mint, protocol); return; }
    this.trackFirstSeenPrice(mint, solReserve, tokenReserve);

    this.detectedTokens.push({
      mint, protocol, outcome: 'entered',
      tokenScore: pipelineResult?.tokenScore ?? 0, socialScore: pipelineResult?.socialScore ?? 0,
      rugcheckRisk: pipelineResult?.rugcheckRisk ?? 'unknown', safetySafe: pipelineResult?.safetySafe ?? true,
      detectedAt: Date.now(),
    });

    this.monitored.set(mint, {
      mint, protocol, accounts: [accountAddr], readMode,
      decimals: 6, isMemeBase: true,
      lastSolReserve: solReserve, lastTokenReserve: tokenReserve, detectedAt: Date.now(),
    });

    for (const [name] of this.portfolios) {
      this.tryVirtualBuy(name, mint, protocol, price, solReserve, tokenReserve, pipelineResult, undefined, entryMultiplier, isScalp);
    }
  }

  private async enterFromPumpSwapPool(mint: string, pool?: string, pipelineResult?: PipelineResult, entryMultiplier = 1.0) {
    if (!pool) { this.recordSkip('no_pool_address', mint, 'pumpswap'); return; }

    const info = await this.connection.getAccountInfo(new PublicKey(pool));
    if (!info || info.data.length < 301) { this.recordSkip('pool_unreadable', mint, 'pumpswap'); return; }

    const baseMint = new PublicKey(info.data.subarray(43, 75)).toBase58();
    const baseVault = new PublicKey(info.data.subarray(139, 171)).toBase58();
    const quoteVault = new PublicKey(info.data.subarray(171, 203)).toBase58();
    const isMemeBase = baseMint === mint;

    let vaultInfos = await this.connection.getMultipleAccountsInfo([
      new PublicKey(baseVault), new PublicKey(quoteVault),
    ]);
    if (!vaultInfos[0] || !vaultInfos[1]) {
      // RPC lags behind gRPC — retry after 300ms, then 700ms
      for (const delayMs of [300, 700]) {
        await new Promise(r => setTimeout(r, delayMs));
        vaultInfos = await this.connection.getMultipleAccountsInfo([
          new PublicKey(baseVault), new PublicKey(quoteVault),
        ]);
        if (vaultInfos[0] && vaultInfos[1]) break;
      }
      if (!vaultInfos[0] || !vaultInfos[1]) { this.recordSkip('vault_unreadable', mint, 'pumpswap'); return; }
      logger.debug(`[shadow] vault retry succeeded for ${mint.slice(0, 8)}`);
    }

    const baseBalance = Number(vaultInfos[0].data.readBigUInt64LE(64));
    const quoteBalance = Number(vaultInfos[1].data.readBigUInt64LE(64));
    const tokenReserve = isMemeBase ? baseBalance : quoteBalance;
    const solReserve = isMemeBase ? quoteBalance : baseBalance;
    const price = (solReserve / 1e9) / (tokenReserve / 1e6);

    if (price <= 0 || !isFinite(price)) { this.recordSkip('invalid_price', mint, 'pumpswap'); return; }

    if (!this.checkEntryMomentum(mint, price)) { this.recordSkip('entry_momentum_failed', mint, 'pumpswap'); return; }
    this.trackFirstSeenPrice(mint, solReserve, tokenReserve);

    this.detectedTokens.push({
      mint, protocol: 'pumpswap', outcome: 'entered',
      tokenScore: pipelineResult?.tokenScore ?? 0, socialScore: pipelineResult?.socialScore ?? 0,
      rugcheckRisk: pipelineResult?.rugcheckRisk ?? 'unknown', safetySafe: pipelineResult?.safetySafe ?? true,
      detectedAt: Date.now(),
    });

    this.monitored.set(mint, {
      mint, protocol: 'pumpswap', accounts: [baseVault, quoteVault], readMode: 'pool-vaults',
      decimals: 6, isMemeBase,
      lastSolReserve: solReserve, lastTokenReserve: tokenReserve, detectedAt: Date.now(),
    });

    for (const [name] of this.portfolios) {
      this.tryVirtualBuy(name, mint, 'pumpswap', price, solReserve, tokenReserve, pipelineResult, undefined, entryMultiplier);
    }
  }

  private async enterFromRaydiumPool(mint: string, protocol: string, pool: string, vaultAOffset: number, vaultBOffset: number, pipelineResult?: PipelineResult, entryMultiplier = 1.0, isScalp = false) {
    const info = await this.connection.getAccountInfo(new PublicKey(pool));
    if (!info || info.data.length < vaultBOffset + 32) { this.recordSkip('pool_unreadable', mint, protocol); return; }

    const vaultA = new PublicKey(info.data.subarray(vaultAOffset, vaultAOffset + 32)).toBase58();
    const vaultB = new PublicKey(info.data.subarray(vaultBOffset, vaultBOffset + 32)).toBase58();

    let vaultInfos = await this.connection.getMultipleAccountsInfo([
      new PublicKey(vaultA), new PublicKey(vaultB),
    ]);
    if (!vaultInfos[0] || !vaultInfos[1]) {
      for (const delayMs of [300, 700]) {
        await new Promise(r => setTimeout(r, delayMs));
        vaultInfos = await this.connection.getMultipleAccountsInfo([
          new PublicKey(vaultA), new PublicKey(vaultB),
        ]);
        if (vaultInfos[0] && vaultInfos[1]) break;
      }
      if (!vaultInfos[0] || !vaultInfos[1]) { this.recordSkip('vault_unreadable', mint, protocol); return; }
      logger.debug(`[shadow] vault retry succeeded for ${mint.slice(0, 8)} (${protocol})`);
    }

    const balA = Number(vaultInfos[0].data.readBigUInt64LE(64));
    const balB = Number(vaultInfos[1].data.readBigUInt64LE(64));

    let tokenReserve: number, solReserve: number, isMemeBase: boolean;
    if (balA > 1e12 && balB < 1e12) { tokenReserve = balA; solReserve = balB; isMemeBase = true; }
    else if (balB > 1e12 && balA < 1e12) { tokenReserve = balB; solReserve = balA; isMemeBase = false; }
    else {
      // Both vaults have similar magnitude — try using owner/mint to determine base/quote.
      // For deep-liquidity pools (>1000 SOL), both balances can be > 1e12.
      // Heuristic: the vault with MORE tokens is likely the meme (higher supply).
      if (balA > 0 && balB > 0) {
        if (balA >= balB) { tokenReserve = balA; solReserve = balB; isMemeBase = true; }
        else { tokenReserve = balB; solReserve = balA; isMemeBase = false; }
        logger.debug(`[shadow] ${mint.slice(0, 8)}: base/quote ambiguous (${balA}/${balB}), using heuristic`);
      } else {
        this.recordSkip('cant_determine_base_quote', mint, protocol); return;
      }
    }

    const price = (solReserve / 1e9) / (tokenReserve / 1e6);
    if (price <= 0 || !isFinite(price)) { this.recordSkip('invalid_price', mint, protocol); return; }

    if (!this.checkEntryMomentum(mint, price)) { this.recordSkip('entry_momentum_failed', mint, protocol); return; }
    this.trackFirstSeenPrice(mint, solReserve, tokenReserve);

    this.detectedTokens.push({
      mint, protocol, outcome: 'entered',
      tokenScore: pipelineResult?.tokenScore ?? 0, socialScore: pipelineResult?.socialScore ?? 0,
      rugcheckRisk: pipelineResult?.rugcheckRisk ?? 'unknown', safetySafe: pipelineResult?.safetySafe ?? true,
      detectedAt: Date.now(),
    });

    this.monitored.set(mint, {
      mint, protocol, accounts: [vaultA, vaultB], readMode: 'pool-vaults',
      decimals: 6, isMemeBase,
      lastSolReserve: solReserve, lastTokenReserve: tokenReserve, detectedAt: Date.now(),
    });

    for (const [name] of this.portfolios) {
      this.tryVirtualBuy(name, mint, protocol, price, solReserve, tokenReserve, pipelineResult, undefined, entryMultiplier, isScalp);
    }
  }

  // ── Virtual buy ─────────────────────────────────────────────────────────

  private tryVirtualBuy(profileName: string, mint: string, protocol: string, entryPrice: number, solReserve: number, tokenReserve: number, pipelineResult?: PipelineResult, overrideEntrySol?: number, entryMultiplier = 1.0, isScalp = false) {
    const portfolio = this.portfolios.get(profileName)!;
    const profile = portfolio.profile;

    if (portfolio.positions.has(mint)) {
      this.recordSkip('already_in_position');
      return;
    }
    if (portfolio.positions.size >= profile.maxPositions) {
      this.recordSkip('max_positions');
      return;
    }
    const exposure = this.getExposure(portfolio);
    if (exposure >= profile.maxExposureSol) {
      this.recordSkip('max_exposure');
      return;
    }

    const scalpEntry = isScalp ? config.strategy.scalping.entryAmountSol : undefined;
    const baseEntry = overrideEntrySol ?? scalpEntry ?? profile.entryAmountSol;
    const entrySol = this.getEffectiveEntry(baseEntry) * entryMultiplier;
    if (portfolio.balance < entrySol + BUY_FEE_SOL) {
      this.recordSkip('insufficient_balance');
      return;
    }

    const buySlippageBps = estimateSlippageBps(solReserve, entrySol);
    const slippageFactor = 1 - buySlippageBps / 10000;
    const tokenAmount = (entrySol / entryPrice) * slippageFactor;
    const tokenScore = pipelineResult?.tokenScore ?? 0;

    const monitored = this.monitored.get(mint);
    const pos = new Position(
      new PublicKey(mint),
      entryPrice,
      tokenAmount,
      { programId: protocol, quoteMint: WSOL_MINT },
      monitored?.decimals ?? 6,
      { entryAmountSol: entrySol, protocol: protocol as any, openedAt: Date.now(), isScalp },
    );
    pos.tokenScore = tokenScore;
    pos.updatePrice(solReserve, tokenReserve);

    portfolio.positions.set(mint, pos);
    portfolio.balance -= entrySol + BUY_FEE_SOL;
    this.eventCounts.entered++;
    this.totalEntriesAllProfiles++;

    const now = Date.now();
    try {
      db.prepare(
        `INSERT INTO shadow_trades (profile, mint, protocol, entry_price, entry_sol, opened_at, fees_sol, token_score, social_score, scoring_result, rugcheck_risk, safety_safe)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        profileName, mint, protocol, entryPrice, entrySol, now, BUY_FEE_SOL,
        tokenScore,
        pipelineResult?.socialScore ?? 0,
        pipelineResult?.scoringResult ? JSON.stringify(pipelineResult.scoringResult) : '',
        pipelineResult?.rugcheckRisk ?? 'unknown',
        pipelineResult?.safetySafe ? 1 : 0,
      );
    } catch {}

    tradeLog.open({
      mint, protocol: protocol as any, entryPrice,
      amountSol: entrySol, tokensReceived: tokenAmount,
      slippageBps: buySlippageBps, jitoTipSol: 0,
      txId: `shadow_${profileName}_${now}`,
      openedAt: now, tokenScore,
    });

    const entry: Partial<TradeLogEntry> = {
      profile: profileName, mint, protocol,
      entrySol, entryPrice, openedAt: now,
    };
    this.emit('shadow:trade', { type: 'open', ...entry });

    logger.info(`[shadow] ${profileName} BUY ${protocol}${isScalp ? ' SCALP' : ''} ${mint.slice(0, 8)} @ ${entryPrice.toExponential(3)} — ${entrySol} SOL (score: ${tokenScore}, social: ${pipelineResult?.socialScore ?? 0}, slip=${buySlippageBps}bps)`);
    logEvent('SHADOW_BUY', { profile: profileName, mint, protocol, entryPrice, entrySol, tokenScore, socialScore: pipelineResult?.socialScore ?? 0, rugcheckRisk: pipelineResult?.rugcheckRisk, isScalp, buySlippageBps });

    if (this.totalEntriesAllProfiles % this.simulationInterval === 0) {
      this.buildAndSimulateTrade(mint, protocol, entrySol, tokenAmount).catch(err =>
        logger.warn(`[shadow] simulation trade failed: ${err}`)
      );
    }
  }

  // ── Price polling ───────────────────────────────────────────────────────

  private async pollPrices() {
    if (!this.running || this.monitored.size === 0) return;

    const allAccounts: string[] = [];
    const accountMap: Array<{ mint: string; idx: number; count: number }> = [];

    for (const [mint, info] of this.monitored) {
      const startIdx = allAccounts.length;
      for (const acc of info.accounts) allAccounts.push(acc);
      accountMap.push({ mint, idx: startIdx, count: info.accounts.length });
    }

    if (allAccounts.length === 0) return;

    let results: (any | null)[];
    try {
      const pubkeys = allAccounts.map(a => new PublicKey(a));
      const BATCH = 100;
      results = [];
      for (let i = 0; i < pubkeys.length; i += BATCH) {
        const batch = pubkeys.slice(i, i + BATCH);
        const batchResults = await this.connection.getMultipleAccountsInfo(batch);
        results.push(...batchResults);
      }
    } catch (err) {
      logger.warn(`[shadow] getMultipleAccountsInfo failed: ${err}`);
      return;
    }

    for (const { mint, idx, count } of accountMap) {
      const info = this.monitored.get(mint);
      if (!info) continue;

      let solReserve: number, tokenReserve: number;

      try {
        if (info.readMode === 'bonding-curve') {
          const data = results[idx]?.data;
          if (!data || data.length < 48) continue;
          tokenReserve = Number(data.readBigUInt64LE(8));
          solReserve = Number(data.readBigUInt64LE(16));
        } else if (info.readMode === 'launch-pool') {
          const data = results[idx]?.data;
          if (!data || data.length < 51) continue;
          tokenReserve = Number(data.readBigUInt64LE(35));
          solReserve = Number(data.readBigUInt64LE(43));
        } else {
          if (count < 2) continue;
          const dataA = results[idx]?.data;
          const dataB = results[idx + 1]?.data;
          if (!dataA || !dataB || dataA.length < 72 || dataB.length < 72) continue;
          const balA = Number(dataA.readBigUInt64LE(64));
          const balB = Number(dataB.readBigUInt64LE(64));
          if (info.isMemeBase) {
            tokenReserve = balA; solReserve = balB;
          } else {
            tokenReserve = balB; solReserve = balA;
          }
        }
      } catch {
        continue;
      }

      if (solReserve === 0 || tokenReserve === 0) {
        this.handleTokenLost(mint);
        continue;
      }

      info.lastSolReserve = solReserve;
      info.lastTokenReserve = tokenReserve;

      for (const [profileName, portfolio] of this.portfolios) {
        const pos = portfolio.positions.get(mint);
        if (!pos) continue;

        pos.updatePrice(solReserve, tokenReserve);
        const decision = pos.shouldSell(logger);

        if (decision.action === 'partial' && decision.portion) {
          if (decision.tpLevelPercent) pos.markTpLevel(decision.tpLevelPercent);
          this.virtualPartialSell(profileName, mint, decision.reason ?? 'tp_partial', decision.portion);
        } else if (decision.action === 'full') {
          this.virtualFullSell(profileName, mint, decision.reason ?? 'unknown');
        }
      }
    }

    this.cleanupUnmonitoredMints();
  }

  // ── Virtual sells ───────────────────────────────────────────────────────

  private virtualPartialSell(profileName: string, mint: string, reason: string, portion: number) {
    const portfolio = this.portfolios.get(profileName)!;
    const pos = portfolio.positions.get(mint);
    if (!pos) return;

    const sellTokens = pos.amount * portion;
    const sellSolValue = sellTokens * pos.currentPrice;
    const monitored = this.monitored.get(mint);
    const solRes = monitored?.lastSolReserve ?? 0;
    const sellSlippageBps = estimateSlippageBps(solRes, sellSolValue);
    const exitSol = sellSolValue * (1 - sellSlippageBps / 10000);
    const netSol = Math.max(0, exitSol - SELL_FEE_SOL);

    portfolio.balance += netSol;
    pos.reduceAmount(portion);

    logger.info(`[shadow] ${profileName} PARTIAL SELL ${mint.slice(0, 8)} ${(portion * 100).toFixed(0)}% — ${reason} — +${netSol.toFixed(4)} SOL (slip=${sellSlippageBps}bps)`);
    logEvent('SHADOW_PARTIAL_SELL', { profile: profileName, mint, reason, portion, solReceived: netSol, slippageBps: sellSlippageBps });
  }

  private virtualFullSell(profileName: string, mint: string, reason: string) {
    const portfolio = this.portfolios.get(profileName)!;
    const pos = portfolio.positions.get(mint);
    if (!pos) return;

    const exitPrice = pos.currentPrice;
    const grossExitSol = pos.amount * exitPrice;
    const monitored = this.monitored.get(mint);
    const solRes = monitored?.lastSolReserve ?? 0;
    const sellSlippageBps = estimateSlippageBps(solRes, grossExitSol);
    const exitSol = grossExitSol * (1 - sellSlippageBps / 10000);
    const totalFees = BUY_FEE_SOL + SELL_FEE_SOL;
    const netExitSol = Math.max(0, exitSol - SELL_FEE_SOL);
    const pnlSol = netExitSol - pos.entryAmountSol;
    let pnlPct = pos.entryAmountSol > 0 ? (pnlSol / pos.entryAmountSol) * 100 : 0;
    const now = Date.now();
    const durationMs = now - pos.openedAt;

    if (Math.abs(pnlPct) > 100_000) {
      logger.warn(`[shadow] PnL sanity fail: ${mint.slice(0, 8)} pnl=${pnlPct.toFixed(0)}% — likely decimal mismatch, clamping`);
      pnlPct = pnlPct > 0 ? 100_000 : -100;
    }

    portfolio.balance += netExitSol;
    portfolio.positions.delete(mint);
    portfolio.closedTrades++;
    portfolio.totalPnlSol += pnlSol;
    if (pnlSol > 0) portfolio.wins++;

    this.eventCounts.exited++;

    const maxPnlPct = pos.entryPrice > 0 ? ((pos.maxPrice - pos.entryPrice) / pos.entryPrice) * 100 : 0;
    const entry: TradeLogEntry = {
      profile: profileName, mint, protocol: pos.protocol,
      entrySol: pos.entryAmountSol, exitSol: netExitSol,
      entryPrice: pos.entryPrice, exitPrice,
      pnlPct, pnlSol, maxPnlPct,
      exitReason: reason, durationMs,
      openedAt: pos.openedAt, closedAt: now,
      feesSol: totalFees,
    };
    this.shadowTradeLog.push(entry);

    try {
      db.prepare(
        `UPDATE shadow_trades SET exit_price=?, exit_sol=?, pnl_percent=?, exit_reason=?,
         duration_ms=?, closed_at=?, virtual_balance_after=?, fees_sol=?
         WHERE profile=? AND mint=? AND closed_at=0`
      ).run(exitPrice, netExitSol, pnlPct, reason, durationMs, now, portfolio.balance, totalFees, profileName, mint);
    } catch {}

    tradeLog.close({
      mint, protocol: pos.protocol,
      reason: reason as any, urgent: false,
      entryPrice: pos.entryPrice, exitPrice,
      peakPrice: pos.maxPrice ?? exitPrice,
      peakPnlPercent: pos.entryPrice > 0 ? ((( pos.maxPrice ?? exitPrice) - pos.entryPrice) / pos.entryPrice) * 100 : 0,
      entryAmountSol: pos.entryAmountSol,
      finalSolReceived: netExitSol,
      partialSolReceived: pos.partialSolReceived ?? 0,
      totalSolReceived: netExitSol + (pos.partialSolReceived ?? 0),
      pnlSol, pnlPercent: pnlPct,
      openedAt: pos.openedAt, closedAt: now,
      durationMs, durationSec: Math.floor(durationMs / 1000),
      txId: `shadow_${profileName}_${now}`,
      sellPath: 'shadow' as any,
      partialSells: pos.partialSellsCount ?? 0,
      priceHistory: pos.priceHistory ?? [],
      tokenScore: pos.tokenScore ?? 0,
      configSnapshot: (() => {
        const exitCfg = pos.protocol === 'pumpswap' ? (config.strategy as any).pumpSwap?.exit
          : pos.protocol === 'raydium-launch' ? (config.strategy as any).raydiumLaunch?.exit
          : pos.protocol === 'raydium-cpmm' ? (config.strategy as any).raydiumCpmm?.exit
          : pos.protocol === 'raydium-ammv4' ? (config.strategy as any).raydiumAmmV4?.exit
          : (config.strategy as any).pumpFun?.exit;
        return {
          entryStopLossPercent: exitCfg?.entryStopLossPercent ?? 12,
          trailingActivationPercent: exitCfg?.trailingActivationPercent ?? 25,
          trailingDrawdownPercent: exitCfg?.trailingDrawdownPercent ?? 7,
          slowDrawdownPercent: exitCfg?.slowDrawdownPercent ?? 30,
          hardStopPercent: exitCfg?.hardStopPercent ?? 40,
          velocityDropPercent: exitCfg?.velocityDropPercent ?? 15,
          velocityWindowMs: exitCfg?.velocityWindowMs ?? 500,
          stagnationWindowMs: exitCfg?.stagnationWindowMs ?? 60000,
          stagnationMinMove: exitCfg?.stagnationMinMove ?? 0.08,
          timeStopAfterMs: exitCfg?.timeStopAfterMs ?? 90000,
          timeStopMinPnl: exitCfg?.timeStopMinPnl ?? -0.03,
          breakEvenAfterTrailingPercent: exitCfg?.breakEvenAfterTrailingPercent ?? -1.5,
        };
      })(),
    });

    this.emit('shadow:trade', { type: 'close', ...entry });

    const pnlColor = pnlSol >= 0 ? '+' : '';
    logger.info(`[shadow] ${profileName} SELL ${mint.slice(0, 8)} — ${reason} — ${pnlColor}${pnlSol.toFixed(4)} SOL (${pnlColor}${pnlPct.toFixed(1)}%) — ${(durationMs / 1000).toFixed(0)}s — peak=${maxPnlPct.toFixed(1)}% slip=${sellSlippageBps}bps`);
    logEvent('SHADOW_SELL', { profile: profileName, mint, reason, pnlSol, pnlPct, maxPnlPct, durationMs, exitPrice, balance: portfolio.balance, tokenScore: pos.tokenScore, sellSlippageBps });

    // Track win/loss for defensive mode (same as real bot)
    const dCfg = (config.strategy as any).defensive;
    this.recentTradeWins.push(pnlSol > 0);
    if (this.recentTradeWins.length > (dCfg?.window ?? 10) * 2) {
      this.recentTradeWins = this.recentTradeWins.slice(-(dCfg?.window ?? 10));
    }
    this.recalcDefensiveMode();

    // Re-entry eligibility (same as real bot)
    this.registerReEntryEligible(mint, pos.protocol, pnlPct, reason);

    // Refresh seenMints TTL (anti-rebuy, same as real bot)
    this.seenMints.set(mint, Date.now());
  }

  private handleTokenLost(mint: string) {
    for (const [profileName, portfolio] of this.portfolios) {
      const pos = portfolio.positions.get(mint);
      if (!pos) continue;

      const now = Date.now();
      const durationMs = now - pos.openedAt;
      const pnlSol = -pos.entryAmountSol;

      portfolio.positions.delete(mint);
      portfolio.closedTrades++;
      portfolio.totalPnlSol += pnlSol;
      this.eventCounts.exited++;

      const entry: TradeLogEntry = {
        profile: profileName, mint, protocol: pos.protocol,
        entrySol: pos.entryAmountSol, exitSol: 0,
        entryPrice: pos.entryPrice, exitPrice: 0,
        pnlPct: -100, pnlSol,
        exitReason: 'token_lost', durationMs,
        openedAt: pos.openedAt, closedAt: now,
        feesSol: BUY_FEE_SOL,
      };
      this.shadowTradeLog.push(entry);
      this.emit('shadow:trade', { type: 'close', ...entry });

      logger.warn(`[shadow] ${profileName} TOKEN LOST ${mint.slice(0, 8)} — -${pos.entryAmountSol.toFixed(4)} SOL`);
      logEvent('SHADOW_TOKEN_LOST', { profile: profileName, mint, entrySol: pos.entryAmountSol });
    }
    this.monitored.delete(mint);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  // ── Pipeline & Simulation ──────────────────────────────────────────────────

  private async runPipeline(mint: string, protocol: string, solReserve: number, tokenReserve: number, independentBuyers?: number): Promise<PipelineResult> {
    const maxPos = Math.max(...Array.from(this.portfolios.values()).map(p => p.profile.maxPositions));
    const maxExp = Math.max(...Array.from(this.portfolios.values()).map(p => p.profile.maxExposureSol));
    const minEntry = Math.min(...Array.from(this.portfolios.values()).map(p => p.profile.entryAmountSol));
    const currentPos = Math.min(...Array.from(this.portfolios.values()).map(p => p.positions.size));
    const currentExp = Math.min(...Array.from(this.portfolios.values()).map(p => this.getExposure(p)));

    return runEntryPipeline({
      mint, protocol, solReserve, tokenReserve,
      connection: this.connection,
      currentPositions: currentPos,
      maxPositions: maxPos,
      currentExposure: currentExp,
      maxExposure: maxExp,
      entryAmountSol: minEntry,
      independentBuyers,
    });
  }

  private logTrendSkip(mint: string, protocol: string, result: PipelineResult) {
    const reason = result.skipReason ?? 'unknown';
    this.recordSkip(reason);

    this.detectedTokens.push({
      mint, protocol, outcome: 'skipped', skipReason: reason,
      tokenScore: result.tokenScore, socialScore: result.socialScore,
      rugcheckRisk: result.rugcheckRisk, safetySafe: result.safetySafe,
      detectedAt: Date.now(),
    });

    logEvent('TREND_SKIP', {
      mint, protocol, reason,
      tokenScore: result.tokenScore,
      socialScore: result.socialScore,
      rugcheckRisk: result.rugcheckRisk,
      safetySafe: result.safetySafe,
      shadow: true,
    });

    try {
      db.prepare(
        `INSERT INTO shadow_trend_skips (mint, protocol, reason, token_score, social_score, rugcheck_risk, safety_safe, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(mint, protocol, reason, result.tokenScore, result.socialScore, result.rugcheckRisk, result.safetySafe ? 1 : 0, Date.now());
    } catch {}

    logger.debug(`[shadow] SKIP ${protocol} ${mint.slice(0, 8)} — ${reason} (score: ${result.tokenScore}, social: ${result.socialScore})`);
  }

  private async buildAndSimulateTrade(mint: string, protocol: string, entrySol: number, tokenAmount: number) {
    const mintPub = new PublicKey(mint);
    logger.info(`[shadow] SIMULATION #${this.totalEntriesAllProfiles} — building TX for ${protocol} ${mint.slice(0, 8)}`);

    const buyResult = await buildBuyTransaction(
      this.connection, mintPub, this.payer, protocol, entrySol, DEFAULT_SLIPPAGE_BPS,
    );

    logEvent('TX_DIAGNOSTIC', {
      ...buyResult.diagnostics, shadow: true, action: 'buy',
    }, { mint, protocol });

    let buySimResult: SimulationResult | undefined;
    if (buyResult.success && buyResult.tx) {
      buySimResult = await simulateTx(this.connection, buyResult.tx);
      logEvent('SHADOW_SIMULATION', {
        mint, protocol, action: 'buy',
        success: buySimResult.success,
        error: buySimResult.error,
        unitsConsumed: buySimResult.unitsConsumed,
      });
      logger.info(`[shadow] BUY simulation: ${buySimResult.success ? 'OK' : 'FAIL'} ${buySimResult.error ?? ''} (${buySimResult.unitsConsumed ?? 0} CU)`);
    } else {
      logEvent('SHADOW_TX_BUILD_FAILED', { mint, protocol, action: 'buy', error: buyResult.error });
      logger.warn(`[shadow] BUY TX build failed: ${buyResult.error}`);
    }

    const tokenAmountRaw = BigInt(Math.floor(tokenAmount * 1e6));
    let sellResult: TxBuildResult | undefined;
    let sellSimResult: SimulationResult | undefined;

    try {
      sellResult = await buildSellTransaction(
        this.connection, mintPub, this.payer, protocol, tokenAmountRaw, DEFAULT_SLIPPAGE_BPS,
      );

      logEvent('TX_DIAGNOSTIC', {
        ...sellResult.diagnostics, shadow: true, action: 'sell',
      }, { mint, protocol });

      if (sellResult.success && sellResult.tx) {
        sellSimResult = await simulateTx(this.connection, sellResult.tx);
        logEvent('SHADOW_SIMULATION', {
          mint, protocol, action: 'sell',
          success: sellSimResult.success,
          error: sellSimResult.error,
          unitsConsumed: sellSimResult.unitsConsumed,
        });
        logger.info(`[shadow] SELL simulation: ${sellSimResult.success ? 'OK' : 'FAIL'} ${sellSimResult.error ?? ''}`);
      } else {
        logEvent('SHADOW_TX_BUILD_FAILED', { mint, protocol, action: 'sell', error: sellResult.error });
      }
    } catch (err) {
      logEvent('SHADOW_SELL_BUILD_FAILED', { mint, protocol, error: String(err) });
      logger.warn(`[shadow] SELL TX build error: ${err}`);
    }

    try {
      db.prepare(
        `UPDATE shadow_trades SET is_simulation_trade=1, tx_diagnostic=?, simulation_result=?
         WHERE mint=? AND closed_at=0 LIMIT 1`
      ).run(
        JSON.stringify({ buy: buyResult.diagnostics, sell: sellResult?.diagnostics }),
        JSON.stringify({ buy: buySimResult, sell: sellSimResult }),
        mint,
      );
    } catch {}
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private async readSingleAccountReserves(address: string, mode: 'bonding-curve' | 'launch-pool'): Promise<{ solReserve: number; tokenReserve: number } | null> {
    try {
      const info = await this.connection.getAccountInfo(new PublicKey(address));
      if (!info) return null;

      if (mode === 'bonding-curve') {
        if (info.data.length < 48) return null;
        return {
          tokenReserve: Number(info.data.readBigUInt64LE(8)),
          solReserve: Number(info.data.readBigUInt64LE(16)),
        };
      } else {
        if (info.data.length < 51) return null;
        return {
          tokenReserve: Number(info.data.readBigUInt64LE(35)),
          solReserve: Number(info.data.readBigUInt64LE(43)),
        };
      }
    } catch {
      return null;
    }
  }

  private getExposure(portfolio: PortfolioState): number {
    let total = 0;
    for (const [, pos] of portfolio.positions) total += pos.entryAmountSol;
    return total;
  }

  private recordSkip(reason: string, mint?: string, protocol?: string) {
    this.eventCounts.skipped++;
    this.skipReasons.set(reason, (this.skipReasons.get(reason) ?? 0) + 1);
    logger.debug(`[shadow] SKIP ${mint?.slice(0, 8) ?? '?'} reason=${reason} protocol=${protocol ?? '?'}`);
    if (mint) {
      this.detectedTokens.push({
        mint, protocol: protocol ?? 'unknown', outcome: 'skipped', skipReason: reason,
        tokenScore: 0, socialScore: 0, rugcheckRisk: 'unknown', safetySafe: true,
        detectedAt: Date.now(),
      });
    }
  }

  private cleanupUnmonitoredMints() {
    for (const [mint] of this.monitored) {
      let hasPosition = false;
      for (const [, portfolio] of this.portfolios) {
        if (portfolio.positions.has(mint)) { hasPosition = true; break; }
      }
      if (!hasPosition) this.monitored.delete(mint);
    }
  }

  private takeSnapshot() {
    try {
      const now = Date.now();
      const stmt = db.prepare(
        `INSERT INTO shadow_snapshots (profile, ts, balance_sol, open_positions, exposure_sol, total_pnl_sol, win_rate, total_trades)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const [name, portfolio] of this.portfolios) {
        const wr = portfolio.closedTrades > 0 ? (portfolio.wins / portfolio.closedTrades) * 100 : 0;
        stmt.run(name, now, portfolio.balance, portfolio.positions.size, this.getExposure(portfolio), portfolio.totalPnlSol, wr, portfolio.closedTrades);
      }
    } catch (err) {
      logger.warn(`[shadow] snapshot error: ${err}`);
    }
  }

  // ── Public getters ──────────────────────────────────────────────────────

  getStatus(): ShadowStatus {
    const now = Date.now();
    const profiles = Array.from(this.portfolios.entries()).map(([name, p]) => {
      const positions = Array.from(p.positions.entries()).map(([mint, pos]) => ({
        mint,
        protocol: pos.protocol,
        entryPrice: pos.entryPrice,
        currentPrice: pos.currentPrice,
        pnlPercent: pos.pnlPercent,
        entrySol: pos.entryAmountSol,
        durationMs: now - pos.openedAt,
      }));
      return {
        name,
        label: p.profile.label,
        balance: p.balance,
        startBalance: p.profile.startBalanceSol,
        openPositions: p.positions.size,
        closedTrades: p.closedTrades,
        wins: p.wins,
        winRate: p.closedTrades > 0 ? (p.wins / p.closedTrades) * 100 : 0,
        totalPnlSol: p.totalPnlSol,
        exposure: this.getExposure(p),
        positions,
      };
    });

    const trendSkipReasons: Record<string, number> = {};
    for (const [reason, count] of this.skipReasons) trendSkipReasons[reason] = count;

    return {
      running: this.running,
      startedAt: this.startedAt,
      uptimeMs: now - this.startedAt,
      profiles,
      eventCounts: { ...this.eventCounts },
      trendSkipReasons,
    };
  }

  getTrades(limit = 50): TradeLogEntry[] {
    return this.shadowTradeLog.slice(-limit).reverse();
  }

  getReport(): ShadowReport {
    const status = this.getStatus();
    const trades = [...this.shadowTradeLog];

    let bestTrade: TradeLogEntry | null = null;
    let worstTrade: TradeLogEntry | null = null;
    let totalDuration = 0;
    const protocolBreakdown: Record<string, { count: number; wins: number; pnlSol: number }> = {};

    for (const t of trades) {
      if (!bestTrade || t.pnlSol > bestTrade.pnlSol) bestTrade = t;
      if (!worstTrade || t.pnlSol < worstTrade.pnlSol) worstTrade = t;
      totalDuration += t.durationMs;

      if (!protocolBreakdown[t.protocol]) {
        protocolBreakdown[t.protocol] = { count: 0, wins: 0, pnlSol: 0 };
      }
      protocolBreakdown[t.protocol].count++;
      if (t.pnlSol > 0) protocolBreakdown[t.protocol].wins++;
      protocolBreakdown[t.protocol].pnlSol += t.pnlSol;
    }

    const detectedByProtocol: Record<string, number> = {};
    const skippedByReason: Record<string, Array<{ mint: string; protocol: string; tokenScore: number; socialScore: number }>> = {};

    for (const dt of this.detectedTokens) {
      detectedByProtocol[dt.protocol] = (detectedByProtocol[dt.protocol] ?? 0) + 1;
      if (dt.outcome === 'skipped' && dt.skipReason) {
        if (!skippedByReason[dt.skipReason]) skippedByReason[dt.skipReason] = [];
        skippedByReason[dt.skipReason].push({
          mint: dt.mint, protocol: dt.protocol,
          tokenScore: dt.tokenScore, socialScore: dt.socialScore,
        });
      }
    }

    return {
      ...status,
      trades,
      bestTrade,
      worstTrade,
      avgDurationMs: trades.length > 0 ? totalDuration / trades.length : 0,
      protocolBreakdown,
      detectedTokens: this.detectedTokens,
      detectedByProtocol,
      skippedByReason,
    };
  }
}
