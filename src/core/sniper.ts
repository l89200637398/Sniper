// src/core/sniper.ts
import { EventEmitter } from 'events';
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction, TransactionMessage, TokenBalance, ComputeBudgetProgram } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Mutex } from 'async-mutex';
import bs58 from 'bs58';
import fs from 'fs/promises';
import path from 'path';
import { config, computeDynamicSlippage, computeDynamicSellSlippage } from '../config';
import {
  buildBuyInstructionFromCreate,
  getFeeRecipient,
  getEffectiveFeeRecipient,
  getBondingCurvePDA,
  getGlobalPDA,
  getVaultPDA,
  getGlobalVolumeAccumulatorPDA,
  getCreatorFromCurveData,
  isCashbackEnabled,
} from '../trading/buy';
import {
  buyTokenPumpSwap,
  sellTokenPumpSwap,
  getPoolPDA,
  parsePoolAccount,
  getPoolAuthorityPDA,
} from '../trading/pumpSwap';
import { sellTokenAuto } from './sell-engine';
import * as dossier from '../db/dossier';
import { Position, SellDecision } from './position';
import {
  GeyserClient,
  PumpToken,
  PumpBuy,
  PumpFunSell,
  PumpSwapNewPool,
  PumpSwapBuy,
  PumpSwapSell,
  RaydiumLaunchCreate,
  RaydiumLaunchBuy,
  RaydiumLaunchSell,
  RaydiumCpmmNewPool,
  RaydiumAmmV4NewPool,
  RaydiumCpmmSwap,
  RaydiumAmmV4Swap,
} from '../geyser/client';
import { buyTokenLaunchLab, parseLaunchLabPool, PoolMigratedError } from '../trading/raydiumLaunchLab';
import { buyTokenCpmm, parseCpmmPool, resolveCpmmPool } from '../trading/raydiumCpmm';
import { buyTokenAmmV4, parseAmmV4Pool, resolveAmmV4Pool } from '../trading/raydiumAmmV4';
import { RAYDIUM_LAUNCHLAB_PROGRAM_ID, RAYDIUM_CPMM_PROGRAM_ID, RAYDIUM_AMM_V4_PROGRAM_ID } from '../constants';
import { updateMintState, getMintState, ensureAta } from './state-cache';
import { logger } from '../utils/logger';
import { isTokenSafeCached } from '../utils/safety';
import { checkSocialSignals, SocialSignal } from '../utils/social';
import { tradeLog, CloseReason } from '../utils/trade-logger';
import { insertTrade } from '../db/sqlite';
import { lastTipPaid, resolveTipLamports, getBundleId, getInflightBundleStatuses, updateLandedStat, warmupJitoCache, sendJitoBurst, BurstResult } from '../jito/bundle';
import { PUMP_FUN_PROGRAM_ID, PUMP_SWAP_PROGRAM_ID, BONDING_CURVE_LAYOUT, PUMP_FUN_ROUTER_PROGRAM_ID, MAYHEM_FEE_RECIPIENTS, KNOWN_SKIP_MINTS } from '../constants';
import { startBlockhashCache, stopBlockhashCache, getCachedBlockhashWithHeight } from '../infra/blockhash-cache';
import { startPriorityFeeCache, stopPriorityFeeCache, getCachedPriorityFee } from '../infra/priority-fee-cache';
import { logEvent, checkSilence } from '../utils/event-logger';
import { metrics } from '../utils/metrics';
import { queueJitoSend } from '../infra/jito-queue';
import { withRetry } from '../utils/retry';
import { withRpcLimit } from '../utils/rpc-limiter';
import { getActiveRpc } from '../infra/rpc';
import { getRuntimeLayout } from '../runtime-layout';
import { sellTokenJupiter, getJupiterQuote, sellTokenJupiterWithQuote } from '../trading/jupiter-sell';
import { buyTokenJupiter } from '../trading/jupiter-buy';
import { detectProtocol } from './detector';
import { WalletTracker } from './wallet-tracker';
import { SocialManager } from '../social/manager';
import type { SocialSignal as PhaseSocialSignal } from '../social/models/signal';
import { getRecentSignals, getMentionCounts, getSignalsForMint } from '../social/storage/signal-store';
import { fetchDexscreenerBoosts } from '../social/parsers/dexscreener';
import { createTelegramFetcher } from '../social/parsers/telegram';
import { createTwitterFetcher } from '../social/parsers/twitter';
import { scoreToken, TokenFeatures } from '../utils/token-scorer';
import { checkRugcheck, startVerifiedCache } from '../utils/rugcheck';
import { getTopHolderPct } from '../utils/holder-check';
import { checkCreatorHistory } from '../utils/creator-history';
import { getCreatorBalance } from '../utils/creator-balance';
import { recordPoolSeen, shouldWaitForPool } from '../utils/pool-age-gate';
import { checkToken2022Extensions } from '../utils/token2022-check';
import { analyzeMetadataQuality } from '../utils/metadata-quality';
import { hasDexBoost, updateActiveBoosts } from '../utils/dex-boost-check';
import { recordBuyInSlot, detectBundledBuys } from '../utils/bundled-buy-detector';
import { getCreatorWalletAge } from '../utils/creator-wallet-age';
import { analyzeBondingCurveProgress } from '../utils/bonding-curve-progress';
import { recordPrice, checkPriceStability } from '../utils/price-stability';
import { recordReserveSnapshot, checkReserveImbalance, clearReserveHistory } from '../utils/reserve-monitor';
import { recordBuyerForWash, detectWashTrading } from '../utils/wash-trade-detector';
import { loadBlacklist, saveBlacklist, getBlacklistMtime } from './blacklist-store';
import { TrendTracker, TrendMetrics } from './trend-tracker';
import { PreLaunchWatcher } from './prelaunch-watcher';

const PUMP_PROGRAM_ID = new PublicKey(PUMP_FUN_PROGRAM_ID);
const PUMP_ROUTER = new PublicKey(PUMP_FUN_ROUTER_PROGRAM_ID);
const POSITIONS_FILE    = path.join(process.cwd(), 'data', 'positions.json');
const CREATE_SLOTS_FILE = path.join(process.cwd(), 'data', 'create-slots.json');

function getStrategyForProtocol(protocol: string) {
  if (protocol === 'pumpswap')       return config.strategy.pumpSwap;
  if (protocol === 'mayhem')         return config.strategy.mayhem;
  if (protocol === 'raydium-launch') return config.strategy.raydiumLaunch;
  if (protocol === 'raydium-cpmm')   return config.strategy.raydiumCpmm;
  if (protocol === 'raydium-ammv4')  return config.strategy.raydiumAmmV4;
  return config.strategy.pumpFun;
}

const MIN_REAL_SOL_RESERVES = 0.1; // 0.1 SOL
const CURVE_ALMOST_COMPLETE_THRESHOLD = 300_000_000_000_000n; // 300 млрд virtualTokenReserves

/** B4 FIX: Safe BigInt→Number conversion — warns on precision loss (value > 2^53-1) */
function safeNumber(val: bigint, label = ''): number {
  if (val > BigInt(Number.MAX_SAFE_INTEGER)) {
    logger.warn(`BigInt overflow → Number: ${label} = ${val.toString()} exceeds MAX_SAFE_INTEGER`);
  }
  return Number(val);
}

interface PendingBuy {
  tokenData: PumpToken;
  timer: NodeJS.Timeout;
  waitingForFirstBuy: boolean;
  waitingForIndependentBuy: boolean;
  tokenCreator?: string;
  adjustedEntryAmountSol?: number;
  independentBuyersSeen: Set<string>;
  independentBuyersNeeded: number;
  aggregatedBuyVolumeSol: number;  // brainstorm v4: total SOL from independent buyers
}

export class Sniper extends EventEmitter {
  private get connection(): Connection { return getActiveRpc(); }
  private payer: Keypair;
  private geyser: GeyserClient;
  private running = false;
  private positions: Map<string, Position> = new Map();
  private seenMints: Map<string, number> = new Map();
  private pendingBuys: Map<string, PendingBuy> = new Map();

  private sellingMints: Set<string> = new Set();
  private partialSellingMints: Set<string> = new Set();
  private startBalance: number = 0;
  private cachedBalance: number = 0;
  private cachedBalanceTs: number = 0;
  private static readonly BALANCE_CACHE_TTL = 5_000; // 5 сек
  private startedAt: number = 0;
  private totalTrades: number = 0;
  private winTrades: number = 0;
  private eventsDetected: number = 0;
  private eventsEntered: number = 0;
  private eventsExited: number = 0;
  private eventsSkipped: number = 0;
  private skipReasons = new Map<string, number>();
  private isCheckingPositions = false;
  private monitoringInterval: NodeJS.Timeout | null = null;
  private feeRecipient: PublicKey | null = null;
  private cachedFeeRecipient: PublicKey | null = null;
  private cachedFeeRecipientTs: number = 0;
  private static readonly FEE_RECIPIENT_CACHE_TTL = 5_000; // 5 sec
  private eventAuthority: PublicKey;
  private global: PublicKey;

  private consecutiveLosses = 0;
  private pauseUntil: number = 0;
  // Soft throttle (15 SOL/нед P2): промежуточный режим между нормой и kill-switch.
  // Включается при rolling WR < defensive.entryThreshold и усиливает фильтры,
  // но не паузит бот. Выключается при WR > defensive.exitThreshold.
  private defensiveMode: boolean = false;

  // ── Execution quality kill-switch (per Доп_к_ТЗ_и_рекомендациям) ────────────
  // Если растёт доля Invalid или падает fill-rate → снижаем активность / паузируем.
  private recentBundleResults: boolean[] = []; // true=landed, false=invalid
  private recentTradeWins: boolean[] = [];     // true=win, false=loss
  private readonly BUNDLE_QUALITY_WINDOW = 20; // последние N bundle
  private readonly TRADE_QUALITY_WINDOW   = 10; // последние N сделок

  private mayhemPending: Map<string, { token: PumpToken; timer: NodeJS.Timeout }> = new Map();
  // Jupiter pre-warm cache (brainstorm v4): quote cached per mint
  private jupiterQuoteCache: Map<string, { quote: any; fetchedAt: number }> = new Map();
  private static readonly JUP_CACHE_MAX = 50;
  private static readonly JUP_QUOTE_TTL = 5_000; // 5s TTL for pre-warmed quotes

  private createdATAs: Set<string> = new Set();
  // F7: Token blacklist — mints the bot should never buy.
  // Persisted to data/blacklist.json via blacklist-store.ts; reloaded
  // every 60s in case the CLI (scripts/blacklist.ts) updates the file.
  private tokenBlacklist: Set<string> = new Set();
  // F7: Creator blacklist — creators whose tokens should be skipped.
  private creatorBlacklist: Set<string> = new Set();
  private blacklistMtime: number = 0;
  private blacklistReloadInterval: NodeJS.Timeout | null = null;
  private sentinelInterval: NodeJS.Timeout | null = null;

  private pendingBuysMutex = new Mutex();
  private seenMutex = new Mutex();
  private partialSellingMutex = new Mutex();
  private sellingMutex = new Mutex();
  private resendMutex = new Mutex();

  private reservesCache: Map<string, { reserves: any; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 300;

  private optimisticTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private confirmedPositions: Set<string> = new Set();

  private seenCleanupInterval: NodeJS.Timeout | null = null;

  private accountToMint: Map<string, string> = new Map();

  private pumpSwapTokenAccounts: Map<string, { mint: string; type: 'sol' | 'token' }> = new Map();
  private pumpSwapReserveCache: Map<string, { solReserve: bigint; tokenReserve: bigint }> = new Map();
  private pumpSwapBuyBlockedMints: Map<string, number> = new Map();
  private raydiumMigrateBlockedMints: Set<string> = new Set();
  private pumpSwapRecoveryAttempted: Set<string> = new Set();
  private pendingRaydiumBuys: Set<string> = new Set();

  // Anti-rebuy: mints с failed sell (exit=0 при buy>0) — токены остались в кошельке
  // как dust, позиция ушла из state. Блокируем любые повторные покупки на 24ч
  // чтобы не гнать SOL в ту же яму. TTL очищается в cleanSeenMints.
  private failedSellMints: Map<string, number> = new Map();

  // Raydium swap tracking (Variant B+C): резолвим pool → mint ленивым путём
  // через CREATE-события и recovery. Используется swap-хендлерами.
  private raydiumPoolToMint: Map<string, { mint: string; protocol: 'raydium-cpmm' | 'raydium-ammv4' | 'raydium-launch' }> = new Map();
  private raydiumSwapRecoveryAttempted: Set<string> = new Set();
  private raydiumSwapRecoveryTs: Map<string, number> = new Map(); // rate limit

  // Entry momentum filter: цена при первом обнаружении mint (CREATE/first buy)
  private mintFirstSeenPrice: Map<string, { price: number; ts: number }> = new Map();
  // Scalp flag: high-liquidity pools detected during recovery (>scalpLiquidityThresholdSol)
  private mintScalpFlag = new Map<string, boolean>();

  // Re-entry support: позиции, которые закрылись через trend-tracker (TP или exit по тренду)
  // и могут быть повторно открыты при возобновлении тренда.
  private reEntryEligible: Map<string, { closedAt: number; count: number; lastEntryPrice: number }> = new Map();

  private firstBuyDetected: Set<string> = new Set();

  private recentBuysForMint: Map<string, PumpBuy[]> = new Map();
  private createSlotForMint: Map<string, { slot: number; ts: number }> = new Map();
  private walletBuyHistory: Map<string, { mints: Set<string>; lastSeen: number }> = new Map();
  private confirmedRealBuyers: Map<string, Set<string>> = new Map();
  private addOnBuyDone: Set<string> = new Set();
  private mintSocialScore: Map<string, number> = new Map();
  private creatorSellSeen: Set<string> = new Set();
  private sellFailureCount: Map<string, number> = new Map();

  // Fix 5a: mint → actual token creator (populated from onNewToken create events)
  private mintCreatorMap: Map<string, string> = new Map();

  private socialRetryTimers: Map<string, NodeJS.Timeout> = new Map();
  private earlyExitTimers: Map<string, NodeJS.Timeout> = new Map();

  // v3: Wallet Tracker для copy-trading (Stage 2)
  private walletTracker: WalletTracker;

  // Phase 3: Social signals manager (DexScreener / Twitter / Telegram)
  // Starts empty — sources are registered elsewhere (B1+). Running it with
  // zero sources is a no-op apart from the hourly prune timer.
  private socialManager: SocialManager;

  // Trend-confirmed entry: агрегирует buy/sell поток и social сигналы
  private trendTracker: TrendTracker;
  private trendTokenData: Map<string, PumpToken> = new Map();

  // Pre-launch watchlist: токены, ожидаемые по инсайту до появления on-chain
  private preLaunchWatcher: PreLaunchWatcher;

  // Token Quality: ring-buffer of recently scored tokens for web UI
  private recentScoredTokens: Array<{
    mint: string; protocol: string; score: number; shouldEnter: boolean;
    entryMultiplier: number; reasons: string[]; rugcheckRisk: string;
    socialScore: number; timestamp: number;
  }> = [];

  // HISTORY_DEV_SNIPER: множество mint-ов, открытых через copy-trade
  // (для лимита copyTrade.maxPositions)
  private copyTradeMints: Set<string> = new Set();

  private get copyTradeCount(): number {
    return [...this.copyTradeMints].filter(m => this.positions.has(m)).length;
  }

  private get pumpFunCount(): number {
    return [...this.positions.values()].filter(p => p.protocol === 'pump.fun' || p.protocol === 'mayhem').length;
  }

  private get pumpSwapCount(): number {
    return [...this.positions.values()].filter(p => p.protocol === 'pumpswap').length;
  }

  private get raydiumLaunchCount(): number {
    return [...this.positions.values()].filter(p => p.protocol === 'raydium-launch').length;
  }

  private get raydiumCpmmCount(): number {
    return [...this.positions.values()].filter(p => p.protocol === 'raydium-cpmm').length;
  }

  private get raydiumAmmV4Count(): number {
    return [...this.positions.values()].filter(p => p.protocol === 'raydium-ammv4').length;
  }

  // v3: подсчёт токенов одного creator за последние 60 сек (для scoring)
  private countCreatorRecentTokens(creator: string): number {
    if (!creator) return 0;
    const now60 = Date.now() - 60_000;
    let count = 0;
    for (const [, pos] of this.positions) {
      if (pos.creator === creator && pos.openedAt > now60) count++;
    }
    for (const [, pending] of this.pendingBuys) {
      if (pending.tokenCreator === creator) count++;
    }
    return count;
  }

  private isLikelyBot(buy: PumpBuy, createSlot?: number): boolean {
    const buyer = buy.creator;
    if (buy.solLamports === 0n) return true;
    if (buy.solLamports < 30_000_000n) return true;
    // Wallet buying 3+ different tokens in 60s = bot
    const history = this.walletBuyHistory.get(buyer);
    if (history && history.mints.size >= 3) return true;

    // ── HISTORY_DEV_SNIPER — Правило 1: Bundled buy = dev wallet ───────────
    // Buy в том же слоте (±1) что и CREATE — это bundled dev транзакция,
    // которая создаёт фейковый спрос с разных кошельков одновременно.
    const mintCreateEntry = this.createSlotForMint.get(buy.mint);
    const buySlot = (buy as any).slot as number | undefined;
    if (buySlot && mintCreateEntry && Math.abs(buySlot - mintCreateEntry.slot) <= 1) {
      logger.debug(`🚫 Bundled dev wallet: ${buyer.slice(0,8)} bought in create slot ±1 for ${buy.mint.slice(0,8)}`);
      return true;
    }

    // ── HISTORY_DEV_SNIPER — Правило 3: Fresh wallet покупающий сразу ─────
    // Нет истории (≤1 mint) и покупает в первые 3 сек после создания — dev wallet.
    if (!history || history.mints.size <= 1) {
      const tokenSeenAt = this.seenMints.get(buy.mint);
      if (tokenSeenAt && Date.now() - tokenSeenAt < 3000) {
        logger.debug(`🚫 Fresh wallet ${buyer.slice(0,8)} buying very early (<3s) for ${buy.mint.slice(0,8)}`);
        return true;
      }
    }

    return false;
  }

  private trackWalletBuy(wallet: string, mint: string) {
    const now = Date.now();
    let history = this.walletBuyHistory.get(wallet);
    if (!history || now - history.lastSeen > 60_000) {
      history = { mints: new Set(), lastSeen: now };
      this.walletBuyHistory.set(wallet, history);
    }
    history.mints.add(mint);
    history.lastSeen = now;
    if (this.walletBuyHistory.size > 500) {
      for (const [w, h] of this.walletBuyHistory) {
        if (now - h.lastSeen > 60_000) this.walletBuyHistory.delete(w);
      }
    }
  }

  constructor() {
    super();
    this.setMaxListeners(50); // bot + future analytics subscribers
    this.payer = Keypair.fromSecretKey(bs58.decode(config.wallet.privateKey));
    this.geyser = new GeyserClient();

    const [eventAuth] = PublicKey.findProgramAddressSync(
      [Buffer.from('__event_authority')],
      PUMP_PROGRAM_ID
    );
    this.eventAuthority = eventAuth;
    this.global = getGlobalPDA();
    this.walletTracker = new WalletTracker();
    this.socialManager = new SocialManager();
    this.trendTracker = new TrendTracker();
    this.preLaunchWatcher = new PreLaunchWatcher();

    // Blacklist must be loaded before start() so the Web UI shows persisted
    // entries even when the bot is stopped (the page is reachable any time).
    // Fire-and-forget — constructors can't be async, and the file read is fast.
    this.loadBlacklist().catch(e => logger.error('loadBlacklist on boot failed:', e));

    this.setupListeners();
  }

  async start(): Promise<string> {
    if (this.running) return 'Снайпер уже запущен';
    logger.info('Starting sniper...');

    const derivedPubkey = this.payer.publicKey.toBase58();
    if (derivedPubkey !== config.wallet.publicKey) {
      const msg = `CRITICAL: Wallet key mismatch! Derived=${derivedPubkey}, config=${config.wallet.publicKey}.`;
      logger.error(msg);
      return `Ошибка: несовпадение ключей кошелька. Проверь PRIVATE_KEY и PUBLIC_KEY в .env`;
    }
    logger.info(`Wallet key OK: ${derivedPubkey}`);

    await this.loadPositions();
    await this.loadCreateSlots();

    // F7: polling reloader — picks up external CLI edits to data/blacklist.json
    // (via scripts/blacklist.ts) without requiring a Sniper restart. Initial
    // load is done in the constructor; here we only arm the poller.
    this.blacklistMtime = getBlacklistMtime();
    this.blacklistReloadInterval = setInterval(() => this.checkBlacklistReload(), 60_000);
    this.sentinelInterval = setInterval(() => this.checkSentinels(), 60_000);

    stopBlockhashCache();
    stopPriorityFeeCache();
    startBlockhashCache(this.connection);
    startPriorityFeeCache(this.connection);

    this.seenCleanupInterval = setInterval(() => this.cleanSeenMints(), 10 * 60 * 1000);

    // Quick Win 5: запуск кэша verified мintов из RugCheck (обновление каждые 60с)
    startVerifiedCache();

    // v3: запуск wallet tracker (фоновый сбор данных для copy-trading)
    await this.walletTracker.start();

    // Phase 3: регистрация социальных источников (free tier).
    // DexScreener boosts API — бесплатный, ключ не нужен. 60s интервал
    // (API обновляется раз в несколько минут; чаще опрашивать не имеет смысла).
    this.socialManager.registerSource('dexscreener', async () => {
      const boosts = await fetchDexscreenerBoosts();
      updateActiveBoosts(boosts.map(s => ({ tokenAddress: s.mint, chainId: 'solana' })));
      return boosts;
    }, 60_000);

    // Telegram public-channel scraper (Phase 3). Читает t.me/s/{channel}
    // по HTTP без api_id/session. Активен всегда: каналы либо из
    // TG_ALPHA_CHANNELS (env), либо из DEFAULT_CHANNELS в parser'е.
    // Factory возвращает null только если после нормализации не осталось
    // ни одного валидного публичного канала.
    try {
      const tgFetcher = createTelegramFetcher();
      if (tgFetcher) {
        this.socialManager.registerSource('telegram', tgFetcher, 30_000);
        logger.info('[social] Telegram scraper registered (30s interval)');
      } else {
        logger.info('[social] Telegram scraper disabled (no valid channels)');
      }
    } catch (err) {
      logger.warn('[social] Telegram parser init threw:', (err as Error).message);
    }

    // Twitter via RapidAPI — DISABLED: не даёт стабильных сигналов,
    // free-tier слишком ограничен. DexScreener + Telegram покрывают потребности.
    // Для включения: раскомментировать блок ниже + задать RAPIDAPI_KEY.
    // if (process.env.RAPIDAPI_KEY) {
    //   try {
    //     const twFetcher = createTwitterFetcher();
    //     const pollMs = Number(process.env.TWITTER_POLL_INTERVAL_MS ?? '600000');
    //     this.socialManager.registerSource('twitter', twFetcher, pollMs);
    //     logger.info(`[social] Twitter source registered (${Math.round(pollMs / 1000)}s interval)`);
    //   } catch (err) {
    //     logger.warn('[social] Twitter parser init failed:', (err as Error).message);
    //   }
    // }
    logger.info('[social] Twitter parser DISABLED (unstable, low value)');

    this.socialManager.start();
    this.preLaunchWatcher.start();

    // Auto-populate pre-launch watchlist from alpha social signals (manual whitelist)
    this.socialManager.on('alpha', (sig: PhaseSocialSignal) => {
      this.tryAddToPreLaunch(sig, 'alpha');
    });

    // Auto-alpha: automatically discover high-quality signals and add to PreLaunchWatcher
    const autoAlphaCfg = (config.trend as any).autoAlpha;
    if (autoAlphaCfg?.enabled) {
      this.socialManager.on('signal', (sig: PhaseSocialSignal) => {
        if (sig.alpha) return; // already handled by 'alpha' listener above
        this.evaluateAutoAlpha(sig);
      });
      logger.info(`[prelaunch] Auto-alpha enabled: max=${autoAlphaCfg.maxCandidates} minFollowers=${autoAlphaCfg.minFollowers} minMentions=${autoAlphaCfg.minMentions}`);
    }

    // Trend-confirmed entry system
    if (config.trend.enabled) {
      this.trendTracker.start();
      this.trendTracker.on('trend:confirmed', this.onTrendConfirmed.bind(this));
      this.trendTracker.on('trend:strengthening', this.onTrendStrengthening.bind(this));
      this.trendTracker.on('trend:weakening', this.onTrendWeakening.bind(this));
      logger.info(`[trend] Trend-confirmed entry enabled (elite≥${config.trend.eliteScoreThreshold}, tracking≥${config.trend.trackingScoreThreshold})`);

      // Social discovery: social signal с mint → начинаем трекинг
      if (config.trend.socialDiscoveryEnabled) {
        this.socialManager.on('signal', (sig: PhaseSocialSignal) => this.onSocialDiscovery(sig));
        logger.info('[trend] Social discovery enabled');
      }
    }

    try {
      this.feeRecipient = await getFeeRecipient(this.connection);
      if (this.feeRecipient) {
        logger.info(`feeRecipient: ${this.feeRecipient.toBase58()}`);
      } else {
        logger.error('feeRecipient is null');
        return 'Ошибка: feeRecipient не получен';
      }
    } catch (err) {
      stopBlockhashCache();
      stopPriorityFeeCache();
      logger.error('Failed to fetch feeRecipient:', err);
      return 'Ошибка: не удалось получить feeRecipient. Проверь RPC.';
    }

    this.running = true;
    this.startBalance = await this.connection.getBalance(this.payer.publicKey);
    this.startedAt = Date.now();

    warmupJitoCache().catch(err => logger.warn('Jito cache warmup failed (non-critical):', err));

    await this.geyser.subscribe();
    this.startMonitoring();
    this.emit('system:status', { isRunning: true, defensiveMode: this.isDefensiveMode() });
    return 'Снайпер запущен';
  }

  async stop(): Promise<string> {
    if (!this.running) return 'Снайпер уже остановлен';
    logger.info('Stopping sniper...');

    this.running = false;

    await this.closeAllPositions();
    this.stopMonitoring();
    this.geyser.stop();
    this.geyser.removeAllListeners();

    for (const { timer } of this.pendingBuys.values()) clearTimeout(timer);
    for (const timeout of this.optimisticTimeouts.values()) clearTimeout(timeout);
    for (const { timer } of this.mayhemPending.values()) clearTimeout(timer);
    for (const timer of this.socialRetryTimers.values()) clearTimeout(timer);
    for (const timer of this.earlyExitTimers.values()) clearTimeout(timer);
    this.socialRetryTimers.clear();
    this.earlyExitTimers.clear();

    // Trend tracker + pre-launch watcher
    this.trendTracker.stop();
    this.trendTracker.removeAllListeners();
    this.preLaunchWatcher.stop();

    // v3: остановка wallet tracker (сохранение на диск)
    await this.walletTracker.stop();

    // Phase 3: остановка social manager.
    this.socialManager.stop();
    this.socialManager.removeAllListeners();

    this.pendingBuys.clear();
    this.pendingRaydiumBuys.clear();
    this.optimisticTimeouts.clear();
    this.mayhemPending.clear();
    await this.savePositions();
    this.positions.clear();
    this.seenMints.clear();
    this.confirmedPositions.clear();
    this.reservesCache.clear();
    this.createdATAs.clear();
    this.pumpSwapRecoveryAttempted.clear();
    this.raydiumMigrateBlockedMints.clear();
    this.jupiterQuoteCache.clear();
    this.pumpSwapBuyBlockedMints.clear();

    for (const account of this.accountToMint.keys()) {
      this.geyser.removeAccount(new PublicKey(account));
    }
    this.accountToMint.clear();
    for (const account of this.pumpSwapTokenAccounts.keys()) {
      this.geyser.removeAccount(new PublicKey(account));
    }
    this.pumpSwapTokenAccounts.clear();
    this.pumpSwapReserveCache.clear();

    if (this.createSlotsSaveTimer) {
      clearTimeout(this.createSlotsSaveTimer);
      this.createSlotsSaveTimer = null;
    }
    if (this.seenCleanupInterval) {
      clearInterval(this.seenCleanupInterval);
      this.seenCleanupInterval = null;
    }
    if (this.sentinelInterval) {
      clearInterval(this.sentinelInterval);
      this.sentinelInterval = null;
    }
    if (this.blacklistReloadInterval) {
      clearInterval(this.blacklistReloadInterval);
      this.blacklistReloadInterval = null;
    }

    stopBlockhashCache();
    stopPriorityFeeCache();

    this.emit('system:status', { isRunning: false, defensiveMode: false });
    return 'Снайпер остановлен. Все позиции закрыты.';
  }

  public async closeAllPositions(): Promise<void> {
    if (this.positions.size === 0) {
      logger.info('Нет открытых позиций для закрытия.');
      return;
    }

    logger.info(`Закрытие ${this.positions.size} позиций...`);
    const promises: Promise<void>[] = [];
    const positionKeys = Array.from(this.positions.keys());

    for (const mintStr of positionKeys) {
      const position = this.positions.get(mintStr);
      if (!position) continue;

      const acquired = await this.sellingMutex.runExclusive(() => {
        if (this.sellingMints.has(mintStr)) return false;
        this.sellingMints.add(mintStr);
        return true;
      });
      if (!acquired) {
        logger.debug(`Skip duplicate sell ${mintStr}`);
        continue;
      }

      const promise = (async () => {
        try {
          const amountRaw = BigInt(Math.floor(position.amount * 10 ** position.tokenDecimals));
          const closedAt = Date.now();

          const txId = await sellTokenAuto(
            this.connection,
            position.mint,
            this.payer,
            amountRaw,
            getStrategyForProtocol(position.protocol).slippageBps,
            false,
            position.feeRecipientUsed ? new PublicKey(position.feeRecipientUsed) : this.feeRecipient ?? undefined,
            position.protocol === 'mayhem',
            position.creator ? new PublicKey(position.creator) : undefined,
            position.cashbackEnabled
          );

          // B8 FIX: Use getSignatureStatuses polling instead of confirmTransaction
          // (confirmTransaction requires matching blockhash which may differ from TX's actual blockhash)
          let confirmed = false;
          const pollStart = Date.now();
          const maxWaitMs = config.timeouts.confirmTransactionTimeoutMs;
          while (Date.now() - pollStart < maxWaitMs) {
            await new Promise(r => setTimeout(r, 200));
            const statuses = await this.connection.getSignatureStatuses([txId]);
            const status = statuses.value[0];
            if (status?.confirmationStatus && !status.err) {
              confirmed = true;
              break;
            }
            if (status?.err) {
              logger.error(`Manual close tx failed:`, status.err);
              return;
            }
          }
          if (!confirmed) {
            logger.error(`Manual close tx ${txId} не подтверждена после ${maxWaitMs}ms`);
            return;
          }

          const txInfo = await this.connection.getTransaction(txId, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          });
          if (!txInfo?.meta) {
            logger.error(`No meta for manual close tx ${txId}`);
            return;
          }

          if (txInfo.meta.err) {
            logger.error(`Manual close tx ${txId.slice(0,8)} reverted: ${JSON.stringify(txInfo.meta.err)}`);
            return;
          }

          const preBalance = txInfo.meta.preBalances[0] ?? 0;
          const postBalance = txInfo.meta.postBalances[0] ?? 0;
          const solReceived = (postBalance - preBalance) / 1e9;

          if (solReceived < 0.001) {
            logger.warn(`Manual close for ${mintStr} returned ${solReceived.toFixed(6)} SOL (empty curve). Removing position anyway.`);
          }

          logger.info(`✅ Позиция ${mintStr} закрыта (manual), tx: ${txId}, получено ${solReceived.toFixed(6)} SOL`);
          logEvent('MANUAL_CLOSE', { mint: mintStr, solReceived, txId });

          this.emitTradeClose(position, mintStr, txId, 'manual', false, solReceived, closedAt, 'jito');
        } catch (err) {
          logger.error(`❌ Ошибка при закрытии позиции ${mintStr}:`, err);
        } finally {
          this.sellingMints.delete(mintStr);
        }
      })();
      promises.push(promise);
    }

    await Promise.allSettled(promises);
    logger.info('Все позиции обработаны.');
  }

  async getStatus() {
    const currentBalance = await this.getCachedBalance();
    const pnl = (currentBalance - this.startBalance) / 1e9;

    const positionDetails = [...this.positions.entries()].map(([mintStr, pos]) => ({
      mint: mintStr,
      protocol: pos.protocol,
      pnlPercent: pos.pnlPercent,
      peakPnlPercent: pos.peakPnlPercent,
      trailingActivated: pos.trailingActivated,
      msOpen: Date.now() - pos.openedAt,
    }));

    return {
      running: this.running,
      uptimeMs: this.running ? Date.now() - this.startedAt : 0,
      positionsCount: this.positions.size,
      pendingCount: this.pendingBuys.size,
      pumpFunCount: this.pumpFunCount,
      pumpSwapCount: this.pumpSwapCount,
      balance: currentBalance / 1e9,
      pnl,
      totalTrades: this.totalTrades,
      winTrades: this.winTrades,
      positions: positionDetails,
    };
  }

  getPayerPublicKey(): PublicKey {
    return this.payer.publicKey;
  }

  getOpenPositionMints(): string[] {
    return [...this.positions.keys()];
  }

  async getCachedBalance(): Promise<number> {
    const now = Date.now();
    if (now - this.cachedBalanceTs < Sniper.BALANCE_CACHE_TTL && this.cachedBalance > 0) {
      return this.cachedBalance;
    }
    this.cachedBalance = await withRpcLimit(() => this.connection.getBalance(this.payer.publicKey)).catch(() => this.cachedBalance);
    this.cachedBalanceTs = now;
    return this.cachedBalance;
  }

  async signTransaction(tx: Transaction): Promise<Transaction> {
    tx.sign(this.payer);
    return tx;
  }

  private async savePositions(): Promise<void> {
    try {
      const data = JSON.stringify([...this.positions.entries()].map(([_, pos]) => pos.toJSON()), null, 2);
      await fs.mkdir(path.dirname(POSITIONS_FILE), { recursive: true });
      const tmpFile = POSITIONS_FILE + '.tmp';
      await fs.writeFile(tmpFile, data, 'utf8');
      await fs.rename(tmpFile, POSITIONS_FILE);
      logger.debug('Positions saved to disk');
    } catch (err) {
      logger.error('Failed to save positions:', err);
    }
  }

  private createSlotsSaveTimer: NodeJS.Timeout | null = null;

  private scheduleCreateSlotsSave(): void {
    if (this.createSlotsSaveTimer) return;
    this.createSlotsSaveTimer = setTimeout(() => {
      this.createSlotsSaveTimer = null;
      this.saveCreateSlots().catch(e => logger.debug('saveCreateSlots failed', e));
    }, 5000);
  }

  private async saveCreateSlots(): Promise<void> {
    try {
      const arr = Array.from(this.createSlotForMint.entries());
      await fs.mkdir(path.dirname(CREATE_SLOTS_FILE), { recursive: true });
      await fs.writeFile(CREATE_SLOTS_FILE, JSON.stringify(arr), 'utf8');
    } catch (err) {
      logger.debug('saveCreateSlots error:', err);
    }
  }

  private async loadCreateSlots(): Promise<void> {
    try {
      const raw = await fs.readFile(CREATE_SLOTS_FILE, 'utf8');
      const arr = JSON.parse(raw) as Array<[string, { slot: number; ts: number } | number]>;
      for (const [mint, val] of arr) {
        const entry = typeof val === 'number' ? { slot: val, ts: Date.now() } : val;
        this.createSlotForMint.set(mint, entry);
      }
      logger.info(`[sniper] loaded ${arr.length} create-slots from disk`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.debug('loadCreateSlots error:', err);
      }
    }
  }

  private async loadPositions(): Promise<void> {
    try {
      const data = await fs.readFile(POSITIONS_FILE, 'utf8');
      const arr = JSON.parse(data);
      const now = Date.now();
      const maxStaleAge = config.strategy.exit.timeStopAfterMs * 2;

      for (const item of arr) {
        try {
          const pos = Position.fromJSON(item);
          const age = now - pos.openedAt;
          if (age > maxStaleAge) {
            logger.warn(`Position ${pos.mint.toBase58()} is too old (${Math.round(age/1000)}s), closing immediately`);
            this.closeStalePosition(pos).catch(err =>
              logger.error(`Failed to close stale position ${pos.mint.toBase58()}:`, err)
            );
            continue;
          }
          this.positions.set(pos.mint.toBase58(), pos);

          // C2 fix: restore MintState from position protocol to ensure correct sell routing
          const mintState: any = {};
          if (pos.protocol === 'raydium-launch') mintState.isRaydiumLaunch = true;
          else if (pos.protocol === 'raydium-cpmm') mintState.isRaydiumCpmm = true;
          else if (pos.protocol === 'raydium-ammv4') mintState.isRaydiumAmmV4 = true;
          else if (pos.protocol === 'pumpswap') mintState.isPumpSwap = true;
          if (Object.keys(mintState).length > 0) updateMintState(pos.mint, mintState);

          this.subscribeToPositionAccount(pos);
        } catch (e) {
          logger.warn('Failed to restore position:', e);
        }
      }
      logger.info(`Loaded ${this.positions.size} positions from disk, closed ${arr.length - this.positions.size} stale ones`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Failed to load positions:', err);
      }
    }
  }

  private async closeStalePosition(position: Position): Promise<void> {
    const mintStr = position.mint.toBase58();
    const acquired = await this.sellingMutex.runExclusive(() => {
      if (this.sellingMints.has(mintStr)) return false;
      this.sellingMints.add(mintStr);
      return true;
    });
    if (!acquired) return;
    try {
      const amountRaw = BigInt(Math.floor(position.amount * 10 ** position.tokenDecimals));
      const txId = await sellTokenAuto(
        this.connection,
        position.mint,
        this.payer,
        amountRaw,
        getStrategyForProtocol(position.protocol).slippageBps,
        false,
        position.feeRecipientUsed ? new PublicKey(position.feeRecipientUsed) : this.feeRecipient ?? undefined,
        position.protocol === 'mayhem',
        position.creator ? new PublicKey(position.creator) : undefined,
        position.cashbackEnabled
      );
      logger.info(`Stale position ${mintStr} closed, tx: ${txId}`);
      logEvent('STALE_CLOSE', { mint: mintStr, txId });
    } catch (err) {
      logger.error(`Failed to close stale position ${mintStr}:`, err);
    } finally {
      this.sellingMints.delete(mintStr);
    }
  }

  private assignTokenScore(position: Position, mintStr: string): void {
    try {
      const features: TokenFeatures = {
        socialScore: 0,
        independentBuyers: 0,
        firstBuySol: 0,
        creatorRecentTokens: 0,
        metadataJsonSize: 0,
        rugcheckRisk: 'unknown',
        hasMintAuthority: false,
        hasFreezeAuthority: false,
        isMayhem: false,
      };
      const result = scoreToken(features, 0);
      position.tokenScore = result.score;
    } catch { /* non-critical */ }
  }

  private ensureMintStateForSell(mint: PublicKey, position: Position): void {
    const state = getMintState(mint);
    const updates: any = {};
    if (position.protocol === 'pumpswap' && !state.isPumpSwap) updates.isPumpSwap = true;
    else if (position.protocol === 'raydium-cpmm' && !state.isRaydiumCpmm) updates.isRaydiumCpmm = true;
    else if (position.protocol === 'raydium-ammv4' && !state.isRaydiumAmmV4) updates.isRaydiumAmmV4 = true;
    else if (position.protocol === 'raydium-launch' && !state.isRaydiumLaunch) updates.isRaydiumLaunch = true;
    if (Object.keys(updates).length > 0) {
      updateMintState(mint, updates);
      logger.warn(`[sell-routing] Restored MintState for ${mint.toBase58().slice(0,8)} protocol=${position.protocol}`);
    }
  }

  private subscribeToPositionAccount(position: Position): void {
    if (position.protocol === 'pump.fun' || position.protocol === 'mayhem') {
      const account = getBondingCurvePDA(position.mint);
      const accountStr = account.toBase58();
      if (!this.accountToMint.has(accountStr)) {
        this.accountToMint.set(accountStr, position.mint.toBase58());
        this.geyser.addAccount(account);
      }
    } else {
      const mintStr = position.mint.toBase58();
      const state = getMintState(position.mint);
      if (state.poolBaseTokenAccount && state.poolQuoteTokenAccount) {
        const baseStr = state.poolBaseTokenAccount.toBase58();
        const quoteStr = state.poolQuoteTokenAccount.toBase58();
        const isMemeBase = state.isMemeBase !== false;
        if (!this.pumpSwapTokenAccounts.has(baseStr)) {
          this.pumpSwapTokenAccounts.set(baseStr, { mint: mintStr, type: isMemeBase ? 'token' : 'sol' });
          this.geyser.addAccount(state.poolBaseTokenAccount);
        }
        if (!this.pumpSwapTokenAccounts.has(quoteStr)) {
          this.pumpSwapTokenAccounts.set(quoteStr, { mint: mintStr, type: isMemeBase ? 'sol' : 'token' });
          this.geyser.addAccount(state.poolQuoteTokenAccount);
        }
      } else {
        const account = getPoolPDA(position.mint);
        const accountStr = account.toBase58();
        if (!this.accountToMint.has(accountStr)) {
          this.accountToMint.set(accountStr, mintStr);
          this.geyser.addAccount(account);
        }
      }
    }
  }

  private unsubscribeFromPositionAccount(position: Position): void {
    if (position.protocol === 'pump.fun' || position.protocol === 'mayhem') {
      const account = getBondingCurvePDA(position.mint);
      const accountStr = account.toBase58();
      if (this.accountToMint.delete(accountStr)) {
        this.geyser.removeAccount(account);
      }
    } else {
      const mintStr = position.mint.toBase58();
      for (const [accStr, info] of this.pumpSwapTokenAccounts) {
        if (info.mint === mintStr) {
          this.pumpSwapTokenAccounts.delete(accStr);
          this.geyser.removeAccount(new PublicKey(accStr));
        }
      }
      this.pumpSwapReserveCache.delete(mintStr);
      const account = getPoolPDA(position.mint);
      const accountStr = account.toBase58();
      if (this.accountToMint.delete(accountStr)) {
        this.geyser.removeAccount(account);
      }
    }
  }

  private cleanSeenMints(): void {
    const now = Date.now();
    const expiry = 60 * 60 * 1000;
    const shortExpiry = 5 * 60 * 1000;

    for (const [mint, ts] of this.seenMints.entries()) {
      if (now - ts > expiry) this.seenMints.delete(mint);
    }

    for (const [mint, entry] of this.createSlotForMint.entries()) {
      if (now - entry.ts > shortExpiry) this.createSlotForMint.delete(mint);
    }

    for (const mint of Array.from(this.recentBuysForMint.keys())) {
      if (!this.positions.has(mint) && !this.pendingBuys.has(mint)) {
        this.recentBuysForMint.delete(mint);
      }
    }

    for (const mint of Array.from(this.confirmedRealBuyers.keys())) {
      if (!this.positions.has(mint)) this.confirmedRealBuyers.delete(mint);
    }

    for (const mint of Array.from(this.mintSocialScore.keys())) {
      if (!this.positions.has(mint) && !this.pendingBuys.has(mint)) {
        this.mintSocialScore.delete(mint);
      }
    }

    for (const mint of Array.from(this.addOnBuyDone)) {
      if (!this.positions.has(mint)) this.addOnBuyDone.delete(mint);
    }

    for (const mint of Array.from(this.firstBuyDetected)) {
      if (!this.positions.has(mint) && !this.pendingBuys.has(mint)) {
        this.firstBuyDetected.delete(mint);
      }
    }

    const blockedTtl = 5 * 60 * 1000;
    for (const [mint, ts] of this.pumpSwapBuyBlockedMints.entries()) {
      if (now - ts > blockedTtl) this.pumpSwapBuyBlockedMints.delete(mint);
    }

    // failedSellMints TTL 24h — не забыть навсегда, освобождает память
    const failedSellTtl = 24 * 60 * 60 * 1000;
    for (const [mint, ts] of this.failedSellMints.entries()) {
      if (now - ts > failedSellTtl) this.failedSellMints.delete(mint);
    }

    for (const mint of Array.from(this.mintCreatorMap.keys())) {
      if (!this.positions.has(mint) && !this.pendingBuys.has(mint)) {
        this.mintCreatorMap.delete(mint);
      }
    }

    // Entry momentum baseline: чистим по TTL 1h (baseline устаревает)
    for (const [mint, entry] of Array.from(this.mintFirstSeenPrice.entries())) {
      if (now - entry.ts > 60 * 60 * 1000) {
        this.mintFirstSeenPrice.delete(mint);
        this.mintScalpFlag.delete(mint);
      }
    }

    // Re-entry eligibility: чистим по TTL 30 min (после истечения cooldown+grace)
    for (const [mint, entry] of Array.from(this.reEntryEligible.entries())) {
      if (now - entry.closedAt > 30 * 60 * 1000) this.reEntryEligible.delete(mint);
    }

    // Raydium swap recovery attempts: чистим через 10 мин
    for (const [key, ts] of Array.from(this.raydiumSwapRecoveryTs.entries())) {
      if (now - ts > 10 * 60 * 1000) {
        this.raydiumSwapRecoveryTs.delete(key);
        this.raydiumSwapRecoveryAttempted.delete(key);
      }
    }

    // Raydium pool→mint map: чистим для пулов где mint не в активных структурах
    for (const [pool, info] of Array.from(this.raydiumPoolToMint.entries())) {
      if (!this.positions.has(info.mint) && !this.trendTracker.isTracking(info.mint)
          && !this.pendingBuys.has(info.mint) && !this.reEntryEligible.has(info.mint)) {
        const seenTs = this.seenMints.get(info.mint);
        if (!seenTs || now - seenTs > 60 * 60 * 1000) {
          this.raydiumPoolToMint.delete(pool);
        }
      }
    }

    for (const mint of Array.from(this.sellFailureCount.keys())) {
      if (!this.positions.has(mint)) this.sellFailureCount.delete(mint);
    }

    for (const mint of Array.from(this.creatorSellSeen)) {
      if (!this.positions.has(mint) && !this.pendingBuys.has(mint)) {
        const ts = this.seenMints.get(mint);
        if (ts && now - ts > shortExpiry) this.creatorSellSeen.delete(mint);
      }
    }

    const now60 = now - 60_000;
    for (const [wallet, history] of this.walletBuyHistory) {
      if (history.lastSeen < now60) this.walletBuyHistory.delete(wallet);
    }

    // Trend token data cleanup
    for (const mint of Array.from(this.trendTokenData.keys())) {
      if (!this.trendTracker.isTracking(mint)) this.trendTokenData.delete(mint);
    }

    // Jupiter quote cache: evict stale + enforce size limit
    for (const [mint, entry] of this.jupiterQuoteCache) {
      if (now - entry.fetchedAt > 30_000 || !this.positions.has(mint)) {
        this.jupiterQuoteCache.delete(mint);
      }
    }

    // v3: очистка wallet tracker
    this.walletTracker.cleanup();

    logger.debug(
      `cleanSeenMints: seenMints=${this.seenMints.size} recentBuys=${this.recentBuysForMint.size} ` +
      `confirmedBuyers=${this.confirmedRealBuyers.size} socialScore=${this.mintSocialScore.size} ` +
      `creatorSell=${this.creatorSellSeen.size} sellFails=${this.sellFailureCount.size} ` +
      `walletHistory=${this.walletBuyHistory.size} trendTracked=${this.trendTracker.trackedCount}`
    );
  }

  private setupListeners() {
    this.geyser.on('newToken',            this.onNewToken.bind(this));
    this.geyser.on('newPumpSwapToken',    this.onNewPumpSwapToken.bind(this));
    this.geyser.on('pumpSwapBuyDetected', this.onPumpSwapBuyDetected.bind(this));
    this.geyser.on('pumpSwapSellDetected',this.onPumpSwapSellDetected.bind(this));
    this.geyser.on('accountUpdate',        this.onAccountUpdate.bind(this));
    this.geyser.on('buyDetected',          this.onBuyDetected.bind(this));
    this.geyser.on('pumpFunSellDetected',  this.onPumpFunSellDetected.bind(this));

    // Raydium events
    this.geyser.on('raydiumLaunchCreate',     this.onRaydiumLaunchCreate.bind(this));
    this.geyser.on('raydiumLaunchBuyDetected', this.onRaydiumLaunchBuy.bind(this));
    this.geyser.on('raydiumLaunchSellDetected', this.onRaydiumLaunchSell.bind(this));
    this.geyser.on('raydiumCpmmNewPool',      this.onRaydiumCpmmNewPool.bind(this));
    this.geyser.on('raydiumAmmV4NewPool',     this.onRaydiumAmmV4NewPool.bind(this));
    this.geyser.on('raydiumCpmmSwapDetected',  this.onRaydiumCpmmSwap.bind(this));
    this.geyser.on('raydiumAmmV4SwapDetected', this.onRaydiumAmmV4Swap.bind(this));
  }

  private async onAccountUpdate(update: { pubkey: PublicKey; data: Buffer; slot: number }) {
    if (!this.running) return;

    const mintStr = this.accountToMint.get(update.pubkey.toBase58());
    if (mintStr) {
      const position = this.positions.get(mintStr);
      if (!position) return;
      try {
        if (position.protocol === 'pump.fun' || position.protocol === 'mayhem') {
          const layout = getRuntimeLayout();
          const tokenOffset = layout.bondingCurve?.tokenReserveOffset ?? 8;
          const solOffset = layout.bondingCurve?.solReserveOffset ?? 16;
          const virtualSolReserves = update.data.readBigUInt64LE(solOffset);
          const virtualTokenReserves = update.data.readBigUInt64LE(tokenOffset);
          position.updatePrice(safeNumber(virtualSolReserves, 'vSol'), safeNumber(virtualTokenReserves, 'vToken'));
          position.updateErrors = 0;
          if (this.trendTracker.isTracking(mintStr)) {
            this.trendTracker.recordPrice(mintStr, position.currentPrice);
          }
          logger.debug(`[gRPC] Position ${mintStr} updated: price=${position.currentPrice.toFixed(12)} pnl=${position.pnlPercent.toFixed(1)}%`);
          recordPrice(mintStr, position.currentPrice);

          const decision = position.shouldSell(logger);
          if (decision.action !== 'none') {
            await this.evaluateAndActOnDecision(position, mintStr, decision);
          }
        }
      } catch (err) {
        logger.error(`Error processing account update for ${mintStr}:`, err);
        position.updateErrors++;
        if (position.updateErrors > 5) {
          logger.warn(`Position ${mintStr} has too many update errors, forcing close`);
          await this.executeFullSell(position, mintStr, { action: 'full', reason: 'rpc_error', urgent: false });
        }
      }
      return;
    }

    const swapInfo = this.pumpSwapTokenAccounts.get(update.pubkey.toBase58());
    if (swapInfo && update.data.length >= 72) {
      try {
        const amount = update.data.readBigUInt64LE(64);
        const cached = this.pumpSwapReserveCache.get(swapInfo.mint) ?? { solReserve: 0n, tokenReserve: 0n };

        if (swapInfo.type === 'sol') {
          cached.solReserve = amount;
        } else {
          cached.tokenReserve = amount;
        }
        this.pumpSwapReserveCache.set(swapInfo.mint, cached);

        if (cached.solReserve > 0n && cached.tokenReserve > 0n) {
          const position = this.positions.get(swapInfo.mint);
          if (position) {
            position.updatePrice(safeNumber(cached.solReserve, 'solRes'), safeNumber(cached.tokenReserve, 'tokenRes'));
            position.updateErrors = 0;
            if (this.trendTracker.isTracking(swapInfo.mint)) {
              this.trendTracker.recordPrice(swapInfo.mint, position.currentPrice);
            }
            logger.debug(`[gRPC] PumpSwap ${swapInfo.mint.slice(0,8)} updated: price=${position.currentPrice.toFixed(12)} pnl=${position.pnlPercent.toFixed(1)}%`);

            // #22: Track SOL reserve for imbalance detection
            const solResSol = safeNumber(cached.solReserve, 'solRes') / 1e9;
            recordReserveSnapshot(swapInfo.mint, solResSol);
            recordPrice(swapInfo.mint, position.currentPrice);

            // #22: Check reserve imbalance exit signal
            const riCfg = (config.strategy as any).reserveImbalance;
            if (riCfg?.enabled && (Date.now() - position.openedAt) > 10_000) {
              const ri = checkReserveImbalance(swapInfo.mint, riCfg.windowMs ?? 30_000, riCfg.dropThresholdPct ?? 20);
              if (ri.shouldExit) {
                logEvent('RESERVE_IMBALANCE_EXIT', { mint: swapInfo.mint, dropPct: ri.dropPct, peak: ri.peakReserve, current: ri.currentReserve });
                const riDecision: SellDecision = { action: 'full', reason: 'reserve_imbalance' as any, urgent: true };
                await this.evaluateAndActOnDecision(position, swapInfo.mint, riDecision);
                return;
              }
            }

            const decision = position.shouldSell(logger);
            if (decision.action !== 'none') {
              await this.evaluateAndActOnDecision(position, swapInfo.mint, decision);
            }
          }
        }
      } catch (err) {
        logger.error(`Error processing PumpSwap token account update for ${swapInfo.mint}:`, err);
      }
    }
  }

  private async evaluateAndActOnDecision(position: Position, mintStr: string, decision: SellDecision) {
    if (decision.action === 'full') {
      const acquired = await this.sellingMutex.runExclusive(() => {
        if (this.sellingMints.has(mintStr)) return false;
        this.sellingMints.add(mintStr);
        return true;
      });
      if (!acquired) {
        logger.debug(`Skip duplicate sell ${mintStr}`);
        return;
      }
      this.executeFullSell(position, mintStr, decision).catch(err =>
        logger.error(`Full sell error for ${mintStr}:`, err)
      );
    } else if (decision.action === 'partial' && decision.portion) {

      const key = `${mintStr}:${decision.tpLevelPercent}`;
      let shouldSell = true;
      await this.partialSellingMutex.runExclusive(() => {
        if (this.partialSellingMints.has(key)) {
          shouldSell = false;
        } else {
          this.partialSellingMints.add(key);
          // Lock TP level in position to block shouldSell() re-triggering before tx confirms
          if (decision.tpLevelPercent) position.lockTpLevel(decision.tpLevelPercent);
        }
      });
      if (!shouldSell) {
        logger.debug(`Duplicate partial sell blocked: ${key}`);
        return;
      }
      this.executePartialSell(position, mintStr, decision)
        .catch(err => {
          // Unlock on failure so retry is possible
          if (decision.tpLevelPercent) position.unlockTpLevel(decision.tpLevelPercent);
          logger.error(`Partial sell error for ${mintStr}:`, err);
        })
        .finally(() => {
          this.partialSellingMutex.runExclusive(() => {
            this.partialSellingMints.delete(key);
          });
        });
    }
  }

  private async onBuyDetected(buy: PumpBuy) {
    if (!this.running) return;
    const mint = buy.mint;
    const buyer = buy.creator;

    if (!this.recentBuysForMint.has(mint)) this.recentBuysForMint.set(mint, []);
    const buyList = this.recentBuysForMint.get(mint)!;
    if (buyList.length < 50) buyList.push(buy);
    this.trackWalletBuy(buyer, mint);

    // Dead volume: обновляем lastBuyActivityTs для открытых позиций
    const dvPos = this.positions.get(mint);
    if (dvPos && buyer !== this.payer.publicKey.toBase58()) {
      dvPos.lastBuyActivityTs = Date.now();
    }

    // Trend tracker: forward buy events for tracked mints
    if (config.trend.enabled && buyer !== this.payer.publicKey.toBase58() && !this.isLikelyBot(buy)) {
      const buySol = Number(buy.solLamports) / 1e9;
      this.trendTracker.recordBuy(mint, buyer, buySol);
      if ((buy as any).slot) recordBuyInSlot(mint, (buy as any).slot, buyer, buySol);
      recordBuyerForWash(mint, buyer, buySol);
    }

    // ── v3: Wallet Tracker — записываем buy для статистики ──
    const isSelfWallet = buyer === this.payer.publicKey.toBase58();
    if (!isSelfWallet) {
      this.walletTracker.recordBuy(buyer, mint, Number(buy.solLamports));

      // ── v3: Copy-trade signal → EXEC (2-tier, brainstorm v4) ──
      // !copyTradeMints check prevents 4x duplicate buy when multiple tracked wallets
      // buy the same token simultaneously — copyTradeMints is set synchronously before
      // executePendingBuy, so the second handler sees it before any position is created.
      // seenMints check re-added: prevents re-buying same mint after loss close.
      const ctSignal = config.strategy.copyTrade.enabled &&
          !this.positions.has(mint) && !this.pendingBuys.has(mint) &&
          !this.copyTradeMints.has(mint) &&
          !this.seenMints.has(mint) &&
          !this.sellingMints.has(mint) &&
          !this.failedSellMints.has(mint) &&
          !this.isBlacklisted(mint) &&
          this.positions.size < config.strategy.maxPositions
          ? this.walletTracker.isCopySignal(buyer, Number(buy.solLamports))
          : { signal: false as const };

      if (ctSignal.signal) {
        // Fix 5a: Skip if buyer is the token creator (self-deal)
        const tokenCreator = this.mintCreatorMap.get(mint);
        if (tokenCreator && buyer === tokenCreator) {
          logger.debug(`[copy-trade] Skip self-buy: ${buyer.slice(0,8)} is creator of ${mint.slice(0,8)}`);
          logEvent('CT_SELF_BUY_BLOCKED', { mint, buyer: buyer.slice(0,8) });
        } else if (this.copyTradeCount >= config.strategy.copyTrade.maxPositions) {
          logger.debug(`CT skip: already ${this.copyTradeCount} CT position(s)`);
        } else {
          // Tier-based entry amount
          const ctEntryAmount = ctSignal.tier === 1
            ? config.strategy.copyTrade.entryAmountSol
            : ((config.strategy.copyTrade as any).tier2EntryAmountSol ?? config.strategy.copyTrade.entryAmountSol * 0.5);

          if (ctEntryAmount <= 0) {
            logger.debug(`CT skip: tier ${ctSignal.tier} entry amount is 0 (disabled)`);
          } else {
          const totalExposure = [...this.positions.values()].reduce((s, p) => s + p.entryAmountSol, 0);
          if (totalExposure + ctEntryAmount <= config.strategy.maxTotalExposureSol) {

            // Fix 4: Pre-buy quality check for copy-trade entries
            const ctMintPk = new PublicKey(mint);

            // Quick rugcheck + holder check (parallel, 1s timeout)
            const [rugResult, topHolderPct] = await Promise.all([
              config.strategy.enableRugcheck
                ? Promise.race([
                    checkRugcheck(mint).catch(() => null),
                    new Promise<null>(r => setTimeout(() => r(null), 1000)),
                  ])
                : Promise.resolve(null),
              getTopHolderPct(this.connection, ctMintPk).catch(() => undefined),
            ]);

            if (rugResult?.risk === 'high') {
              logger.info(`[copy-trade] Rugcheck HIGH RISK → skip ${mint.slice(0,8)}`);
              logEvent('CT_RUGCHECK_BLOCKED', { mint, buyer: buyer.slice(0,8), score: rugResult.score });
            } else {
              // Pre-score check with available features
              const preFeatures: TokenFeatures = {
                socialScore: this.mintSocialScore.get(mint) ?? 0,
                independentBuyers: 0,
                firstBuySol: Number(buy.solLamports) / 1e9,
                creatorRecentTokens: this.countCreatorRecentTokens(tokenCreator ?? buyer),
                metadataJsonSize: 0,
                rugcheckRisk: rugResult?.risk ?? 'unknown',
                hasMintAuthority: rugResult?.hasMintAuthority ?? false,
                hasFreezeAuthority: rugResult?.hasFreezeAuthority ?? false,
                isMayhem: getMintState(ctMintPk).isMayhemMode ?? false,
                topHolderPct,
                socialMentions: this.getSocialMentionCount(mint),
                hasDexBoost: hasDexBoost(mint),
              };
              const ctMinScore = (config.strategy as any).minCopyTradeScore ?? config.strategy.minTokenScore;
              const preScore = scoreToken(preFeatures, ctMinScore);

              if (!preScore.shouldEnter) {
                logger.info(`[copy-trade] Pre-score gate: ${mint.slice(0,8)} score=${preScore.score} < min=${ctMinScore} — skip [${preScore.reasons.join(', ')}]`);
                logEvent('CT_PRESCORE_BLOCKED', { mint, score: preScore.score, reasons: preScore.reasons });
              } else {
                logger.info(`🎯 COPY-TRADE T${ctSignal.tier} EXEC: ${buyer.slice(0,8)} bought ${mint.slice(0,8)} for ${(Number(buy.solLamports)/1e9).toFixed(4)} SOL, entry=${ctEntryAmount}, preScore=${preScore.score}`);
                logEvent('COPY_TRADE_EXEC', { mint, buyer: buyer.slice(0,8), solLamports: Number(buy.solLamports), tier: ctSignal.tier, entryAmount: ctEntryAmount, preScore: preScore.score });

                const ctBondingCurve = getBondingCurvePDA(ctMintPk);

                const ctToken: PumpToken = {
                  mint,
                  creator: buy.creator,
                  bondingCurve: ctBondingCurve.toBase58(),
                  bondingCurveTokenAccount: '',
                  signature: buy.signature,
                  receivedAt: Date.now(),
                };

                (ctToken as any)._socialEntryMultiplier =
                  ctEntryAmount / config.strategy.pumpFun.entryAmountSol;

                this.copyTradeMints.add(mint);

                this.executePendingBuy(ctToken).catch(err => {
                  logger.error(`Copy-trade buy failed for ${mint}:`, err);
                  this.copyTradeMints.delete(mint);
                });
              }
            }
          }
          }
        }
      }
    }

    const isFirstBuy = !this.firstBuyDetected.has(mint);
    if (isFirstBuy) {
      this.firstBuyDetected.add(mint);
      logger.info(`📢 First buy detected for ${mint}`);
    }

    const position = this.positions.get(mint);
    if (position && !this.addOnBuyDone.has(mint) && !this.sellingMints.has(mint) && !this.creatorSellSeen.has(mint)) {
      const isSelf = buyer === this.payer.publicKey.toBase58();
      if (!isSelf && !this.isLikelyBot(buy) && buyer !== position.creator) {
        if (!this.confirmedRealBuyers.has(mint)) this.confirmedRealBuyers.set(mint, new Set());
        const realBuyers = this.confirmedRealBuyers.get(mint)!;
        realBuyers.add(buyer);

        const socialScore = this.mintSocialScore.get(mint) ?? 0;
        const addOnThreshold = socialScore >= 1 ? 5 : 3;

        if (realBuyers.size >= addOnThreshold && position.pnlPercent > 0) {
          this.addOnBuyDone.add(mint);
          logger.info(`🔥 ADD-ON BUY: ${mint.slice(0,8)} — ${realBuyers.size}/${addOnThreshold} real buyers (score=${socialScore}), pnl=${position.pnlPercent.toFixed(1)}%`);
          logEvent('ADD_ON_BUY_TRIGGERED', { mint, realBuyers: realBuyers.size, threshold: addOnThreshold, socialScore, pnl: position.pnlPercent });

          this.executeAddOnBuy(position, mint).catch(err =>
            logger.error(`Add-on buy failed for ${mint}:`, err)
          );
        }
      }
    }

    const timer = this.earlyExitTimers.get(mint);
    if (timer && !this.sellingMints.has(mint) && !this.creatorSellSeen.has(mint)) {
      const isSelf = buyer === this.payer.publicKey.toBase58();
      const isCreator = buyer === (this.positions.get(mint)?.creator);
      if (!isSelf && !this.isLikelyBot(buy) && !isCreator) {
        clearTimeout(timer);
        this.earlyExitTimers.delete(mint);

        // v3 ОПТИМИЗАЦИЯ: add-on buy ТОЛЬКО при social score ≥ 1.
        // При score=0 один buyer — слабый сигнал. Держим 0.01 SOL.
        // Это снижает avg stop_loss с 0.0076 до 0.0026 SOL (-66%).
        const socialScore = this.mintSocialScore.get(mint) ?? 0;
        if (socialScore >= 1) {
          logger.info(`👤 Independent buyer + social=${socialScore} for ${mint.slice(0,8)} — upgrading to 0.03 SOL`);
          logEvent('EARLY_ENTRY_UPGRADE', { mint, buyer: buyer.slice(0,8), socialScore });
          const pos = this.positions.get(mint);
          if (pos && !this.addOnBuyDone.has(mint)) {
            const currentEntry = pos.entryAmountSol;
            const targetEntry = 0.03;
            if (currentEntry < targetEntry) {
              const additional = targetEntry - currentEntry;
              await this.executeAddOnBuy(pos, mint, additional);
            }
          }
        } else {
          logger.info(`👤 Independent buyer for ${mint.slice(0,8)} — keeping 0.01 SOL (score=0, no add-on)`);
          logEvent('EARLY_EXIT_CANCELLED', { mint, buyer: buyer.slice(0,8), socialScore, reason: 'buyer_no_addon' });
        }
      }
    }

    const pending = await this.pendingBuysMutex.runExclusive(() => {
      const p = this.pendingBuys.get(mint);
      if (!p) return null;

      if (p.waitingForIndependentBuy) {
        const isIndependent = buyer !== p.tokenCreator;
        const isSelf = buyer === this.payer.publicKey.toBase58();

        if (isSelf || this.isLikelyBot(buy)) {
          if (isSelf) logger.debug(`Self-buy ignored for ${mint.slice(0,8)}`);
          else logger.debug(`Bot detected for ${mint.slice(0,8)}: ${buyer.slice(0,8)} (solLamports=${buy.solLamports})`);
          return null;
        }

        if (isIndependent) {
          p.independentBuyersSeen.add(buyer);
          p.aggregatedBuyVolumeSol += Number(buy.solLamports) / 1e9;
          const seen = p.independentBuyersSeen.size;
          const needed = p.independentBuyersNeeded;
          logger.info(`👤 Real buyer ${seen}/${needed} for ${mint.slice(0,8)}: ${buyer.slice(0,8)} spent ${(Number(buy.solLamports)/1e9).toFixed(4)} SOL (total=${p.aggregatedBuyVolumeSol.toFixed(4)})`);
          logEvent('INDEPENDENT_BUYER', { mint, buyer: buyer.slice(0,8), solLamports: Number(buy.solLamports), seen, needed, aggVolume: p.aggregatedBuyVolumeSol });

          // ── Fast entry: large single buyer OR strong aggregated volume ──
          // Single buyer ≥0.3 SOL = strong demand signal.
          // Aggregated ≥0.5 SOL from 2+ wallets = organic demand (brainstorm v4).
          const isLargeBuy = buy.solLamports >= 300_000_000n; // 0.3 SOL
          const isStrongVolume = seen >= 2 && p.aggregatedBuyVolumeSol >= 0.5;
          if ((isLargeBuy || isStrongVolume) && seen < needed) {
            logger.info(`⚡ FAST ENTRY: ${isLargeBuy ? 'Large buyer' : 'Strong volume'} ${buyer.slice(0,8)} → skipping wait (vol=${p.aggregatedBuyVolumeSol.toFixed(4)}, buyers=${seen})`);
            logEvent('FAST_ENTRY', { mint, buyer: buyer.slice(0,8), solLamports: Number(buy.solLamports), reason: isLargeBuy ? 'large_buyer' : 'agg_volume', aggVolume: p.aggregatedBuyVolumeSol });
          }

          if (seen >= needed || isLargeBuy || isStrongVolume) {
            clearTimeout(p.timer);
            this.pendingBuys.delete(mint);
            return p;
          }
        }
        return null;
      }

      if (p.waitingForFirstBuy && isFirstBuy) {
        clearTimeout(p.timer);
        this.pendingBuys.delete(mint);
        return p;
      }

      return null;
    });

    if (!pending) return;

    if (await this.isTipTooExpensive()) {
      logger.warn(`onBuyDetected: tip too expensive, skipping buy for ${mint}`);
      logEvent('BUY_SKIPPED_TIP', { mint, reason: 'tip_too_expensive' });
      return;
    }

    if (pending.adjustedEntryAmountSol) {
      (pending.tokenData as any)._socialEntryMultiplier = pending.adjustedEntryAmountSol / getStrategyForProtocol('pump.fun').entryAmountSol;
      (pending.tokenData as any)._socialScore = 0;
    }

    this.executePendingBuy(pending.tokenData).catch(err =>
      logger.error(`Failed to execute pending buy after ${pending.waitingForIndependentBuy ? 'independent' : 'first'} buy for ${mint}:`, err)
    );
  }

  private async fetchFreshReserves(mint: PublicKey): Promise<{ virtualSolReserves: bigint; virtualTokenReserves: bigint; data: Buffer }> {
    const bondingCurve = getBondingCurvePDA(mint);
    const accountInfo = await withRpcLimit(() => this.connection.getAccountInfo(bondingCurve, { commitment: 'processed' }));
    if (!accountInfo) throw new Error('Bonding curve not found for fresh reserves');
    const layout = getRuntimeLayout();
    const tokenOffset = layout.bondingCurve?.tokenReserveOffset ?? 8;
    const solOffset = layout.bondingCurve?.solReserveOffset ?? 16;
    return {
      virtualSolReserves: accountInfo.data.readBigUInt64LE(solOffset),
      virtualTokenReserves: accountInfo.data.readBigUInt64LE(tokenOffset),
      data: accountInfo.data,
    };
  }

  private isMayhemMode(curveData: Buffer): boolean {
    const offset = BONDING_CURVE_LAYOUT.IS_MAYHEM_MODE_OFFSET;
    if (curveData.length <= offset) return false;
    return curveData[offset] === 1;
  }

  private isCurveAlmostComplete(virtualTokenReserves: bigint): boolean {
    return virtualTokenReserves < CURVE_ALMOST_COMPLETE_THRESHOLD;
  }

  private async onNewToken(token: PumpToken) {
    if (!this.running) return;
    if (this.positions.has(token.mint)) return;
    if (this.failedSellMints.has(token.mint)) return;

    const alreadySeen = await this.seenMutex.runExclusive(() => {
      if (this.seenMints.has(token.mint)) return true;
      this.seenMints.set(token.mint, Date.now());
      return false;
    });
    if (alreadySeen) return;

    // Token dossier: record first sighting
    dossier.recordSeen(token.mint, 'pumpfun_create', {
      creator: token.creator,
      slot: (token as any).slot,
      signature: (token as any).signature,
    });

    // HISTORY_DEV_SNIPER: запоминаем slot CREATE для детекции bundled buys
    if ((token as any).slot) {
      this.createSlotForMint.set(token.mint, { slot: (token as any).slot, ts: Date.now() });
      this.scheduleCreateSlotsSave();
    }

    // Fix 5a: запоминаем creator токена для детекции self-buy в copy-trade
    if (token.creator) {
      this.mintCreatorMap.set(token.mint, token.creator);
    }

    // Loss-min #6: резервируем слот(ы) под copy-trade T1 (WR ≥60% vs ~30-40% у regular).
    // Пока резерв не занят — regular видит effectiveMax = maxPositions - freeReserved.
    const reservedT1 = (config.strategy.copyTrade as any).reservedT1Slots ?? 0;
    const freeReserved = Math.max(0, reservedT1 - this.copyTradeCount);
    const effectiveMaxPositions = Math.max(1, config.strategy.maxPositions - freeReserved);
    if (this.positions.size >= effectiveMaxPositions) {
      logger.debug(`Max positions reached (${this.positions.size}/${effectiveMaxPositions}, CT-reserved=${freeReserved}), skip ${token.mint}`);
      return;
    }

    const totalExposure = [...this.positions.values()].reduce((s, p) => s + p.entryAmountSol, 0);
    if (totalExposure >= config.strategy.maxTotalExposureSol) {
      logger.warn(`Total exposure ${totalExposure.toFixed(3)} SOL >= limit ${config.strategy.maxTotalExposureSol}, skip ${token.mint.slice(0,8)}`);
      logEvent('BUY_SKIPPED_EXPOSURE', { mint: token.mint, totalExposure });
      return;
    }

    const now60 = Date.now() - 60_000;
    let creatorRecentCount = 0;
    for (const [, pos] of this.positions) {
      if (pos.creator && pos.creator === token.creator && pos.openedAt > now60) creatorRecentCount++;
    }
    for (const [, pending] of this.pendingBuys) {
      if (pending.tokenData.creator === token.creator) creatorRecentCount++;
    }
    if (creatorRecentCount >= 2) {
      logger.warn(`Spam creator ${token.creator.slice(0,8)} — already ${creatorRecentCount} tokens, skip ${token.mint.slice(0,8)}`);
      logEvent('BUY_SKIPPED_SPAM_CREATOR', { mint: token.mint, creator: token.creator, count: creatorRecentCount });
      return;
    }

    // ── Pre-launch watchlist check ────────────────────────────────────────────
    // Если mint или creator совпадает с ожидаемым кандидатом — входим немедленно,
    // минуя trend-фильтр и прочие задержки (инсайт уже подтвердил качество).
    const plMint    = this.preLaunchWatcher.matchMint(token.mint);
    const plCreator = !plMint ? this.preLaunchWatcher.matchCreator(token.creator) : null;
    const plMatch   = plMint ?? plCreator;

    if (plMatch) {
      logger.info(
        `🎯 PRE-LAUNCH HIT: ${token.mint.slice(0, 8)} ` +
        `ticker=${plMatch.ticker ?? '-'} matched_by=${plMint ? 'mint' : 'creator'} ` +
        `source=${plMatch.source}`
      );
      logEvent('PRELAUNCH_HIT', { mint: token.mint, creator: token.creator, id: plMatch.id, ticker: plMatch.ticker, matchedBy: plMint ? 'mint' : 'creator' });
      this.preLaunchWatcher.markFired(plMatch.id, token.mint);

      // Базовые фильтры: blacklist + exposure + balance + rugcheck
      if (this.isBlacklisted(token.mint, token.creator)) {
        logger.warn(`[prelaunch] Blacklisted token/creator — skip ${token.mint.slice(0, 8)}`);
        logEvent('PRELAUNCH_SKIP_BLACKLIST', { mint: token.mint });
        return;
      }

      const plExposure = [...this.positions.values()].reduce((s, p) => s + p.entryAmountSol, 0);
      if (plExposure >= config.strategy.maxTotalExposureSol) {
        logger.warn(`[prelaunch] Exposure ${plExposure.toFixed(3)} >= limit — skip ${token.mint.slice(0, 8)}`);
        logEvent('PRELAUNCH_SKIP_EXPOSURE', { mint: token.mint, exposure: plExposure });
        return;
      }

      const plBal = (await this.getCachedBalance()) / 1e9;
      const plMinBal = (config.strategy as any).minBalanceToTradeSol ?? 0.5;
      if (plBal < plMinBal) {
        logger.warn(`[prelaunch] Balance ${plBal.toFixed(3)} < ${plMinBal} — skip ${token.mint.slice(0, 8)}`);
        logEvent('PRELAUNCH_SKIP_BALANCE', { mint: token.mint, balance: plBal });
        return;
      }

      if (config.strategy.enableRugcheck) {
        const plRug = await checkRugcheck(token.mint).catch(() => null);
        if (plRug?.risk === 'high') {
          logger.warn(`[prelaunch] Rugcheck HIGH RISK — skip ${token.mint.slice(0, 8)} score=${plRug.score}`);
          logEvent('PRELAUNCH_SKIP_RUGCHECK', { mint: token.mint, score: plRug.score, risks: plRug.risks });
          return;
        }
      }

      this.executePendingBuy(token).catch(err =>
        logger.error(`[prelaunch] Buy failed for ${token.mint.slice(0, 8)}:`, err)
      );
      return;
    }

    logger.info(`🔥 NEW PUMP TOKEN DETECTED: ${token.mint}`);
    logEvent('CREATE', { mint: token.mint, creator: token.creator, bondingCurve: token.bondingCurve, tx: token.signature });

    // F7: Blacklist check
    if (this.isBlacklisted(token.mint, token.creator)) {
      logger.debug(`Blacklisted token/creator, skip ${token.mint.slice(0,8)}`);
      return;
    }

    const mintPubkey = new PublicKey(token.mint);

    // Loss-min #6: применяем тот же резерв к pump.fun слотам
    const effectiveMaxPumpFun = Math.max(1, config.strategy.maxPumpFunPositions - freeReserved);
    if (this.pumpFunCount >= effectiveMaxPumpFun) {
      logger.debug(`Pump.fun slots full (${this.pumpFunCount}/${effectiveMaxPumpFun}, CT-reserved=${freeReserved}), skip ${token.mint}`);
      return;
    }

    const pumpFunCheck = getStrategyForProtocol('pump.fun');
    if (pumpFunCheck.entryAmountSol < config.strategy.minEntryAmountSol) {
      logger.warn(`pumpFun entryAmountSol < minEntryAmountSol, cannot buy`);
      return;
    }

    const bondingCurvePubkey = new PublicKey(token.bondingCurve);
    const t0 = Date.now();

    const tokenAge = token.receivedAt ? (Date.now() - token.receivedAt) : 0;
    const isTrendEntry = config.trend.enabled && this.trendTracker.isTracking(token.mint);
    if (!isTrendEntry && tokenAge > config.strategy.maxTokenAgeMs) {
      logger.debug(`Token ${token.mint.slice(0,8)} too old (${tokenAge}ms > ${config.strategy.maxTokenAgeMs}ms), skip`);
      logEvent('BUY_SKIPPED_TOO_OLD', { mint: token.mint, ageMs: tokenAge });
      return;
    }

    // Parallel: detectProtocol + tip check + bonding curve account fetch
    const [protocolInfo, tipTooExpensive, accountInfo] = await Promise.all([
      detectProtocol(this.connection, mintPubkey),
      this.isTipTooExpensive(),
      withRetry(() => withRpcLimit(() => this.connection.getAccountInfo(bondingCurvePubkey, {
        commitment: 'processed'
      })), 3, 200).catch(() => null),
    ]);

    if (protocolInfo.protocol === 'pumpswap') {
      logger.info(`Token ${token.mint} is already on PumpSwap, treating as new PumpSwap token`);
      this.onNewPumpSwapToken({
        mint: token.mint,
        pool: '',
        creator: token.creator,
        quoteMint: config.wsolMint,
        signature: token.signature,
      }).catch(err => logger.error(`Failed to handle PumpSwap token from CREATE:`, err));
      return;
    }

    if (tipTooExpensive) return;

    let curveReady = false;
    let reserves: { virtualSolReserves: bigint; virtualTokenReserves: bigint } | null = null;

    if (accountInfo) {
      const layout = getRuntimeLayout();
      const tokenOffset = layout.bondingCurve?.tokenReserveOffset ?? 8;
      const solOffset = layout.bondingCurve?.solReserveOffset ?? 16;
      const virtualTokenReserves = accountInfo.data.readBigUInt64LE(tokenOffset);

      const mintState = getMintState(mintPubkey);
      if (mintState.isMayhemMode === undefined) {
        mintState.isMayhemMode = this.isMayhemMode(accountInfo.data);
        if (mintState.isMayhemMode) {
          logger.info(`🌪️ Mayhem Mode token detected at CREATE: ${token.mint}`);
          logEvent('MAYHEM_DETECTED', { mint: token.mint });
        }
      }

      if (virtualTokenReserves > 0n) {
        const realSolReserves = accountInfo.data.readBigUInt64LE(32);
        if (realSolReserves > 0n) {
          const realSol = safeNumber(realSolReserves, 'realSol') / 1e9;
          if (realSol >= MIN_REAL_SOL_RESERVES) {
            // #11: Bonding curve progress gate
            const curveCfg = (config.strategy as any).curveProgress;
            if (curveCfg?.enabled) {
              const virtualSol = accountInfo.data.readBigUInt64LE(solOffset);
              const progress = analyzeBondingCurveProgress(virtualTokenReserves, virtualSol, realSolReserves, {
                minProgressPct: curveCfg.minProgressPct,
                maxProgressPct: curveCfg.maxProgressPct,
              });
              if (progress.isTooEarly || progress.isTooLate) {
                logger.debug(`[curve] ${token.mint.slice(0, 8)} ${progress.reason} — skip`);
                logEvent('BUY_SKIPPED_CURVE_PROGRESS', { mint: token.mint, progressPct: progress.progressPct, reason: progress.reason });
                return;
              }
            }

            logger.info(`✅ Bonding curve ready (${realSol.toFixed(3)} SOL real), executing buy immediately`);
            curveReady = true;
            reserves = {
              virtualSolReserves: accountInfo.data.readBigUInt64LE(solOffset),
              virtualTokenReserves,
            };
          }
        }
      }
    }

    // C2+C5: Run rugcheck + social IN PARALLEL (both are network calls, 200-500ms each)
    // Social is fire-and-forget; rugcheck blocks entry only if HIGH risk.
    {
      // Start both checks concurrently
      const socialPromise = checkSocialSignals(this.connection, mintPubkey)
        .then(social => {
          this.mintSocialScore.set(token.mint, social.score);
          (token as any)._socialScore = social.score;
          const m = social.score >= 1 ? config.strategy.socialHighMultiplier : config.strategy.socialLowMultiplier;
          (token as any)._socialEntryMultiplier = m;
          logger.debug(`[social] ${token.mint.slice(0,8)} score=${social.score}, multiplier=${m}`);
        })
        .catch(() => {
          (token as any)._socialScore = 0;
          (token as any)._socialEntryMultiplier = config.strategy.socialLowMultiplier;
        });

      const rugPromise = config.strategy.enableRugcheck
        ? checkRugcheck(token.mint).catch(() => null)
        : Promise.resolve(null);

      // Await rugcheck (blocks entry for HIGH risk), social may still be running
      const rugResult = await rugPromise;
      if (rugResult) {
        (token as any)._rugcheckResult = rugResult;
        if (rugResult.risk === 'high') {
          logger.warn(`🛑 Rugcheck HIGH RISK — BLOCKING ENTRY: ${token.mint.slice(0,8)} score=${rugResult.score} — ${rugResult.risks.join(', ')}`);
          logEvent('RUGCHECK_BLOCKED', { mint: token.mint, score: rugResult.score, risks: rugResult.risks, fetchTimeMs: rugResult.fetchTimeMs });
          return;
        }
        logger.debug(`[rugcheck] ${token.mint.slice(0,8)}: risk=${rugResult.risk} score=${rugResult.score} (${rugResult.fetchTimeMs}ms)`);
      }

      // Social ещё может не вернуться — используем дефолт
      if ((token as any)._socialEntryMultiplier === undefined) {
        (token as any)._socialScore = 0;
        (token as any)._socialEntryMultiplier = config.strategy.socialLowMultiplier;
      }
    }

    // ── v3: Entry gate (sync creator check) ──
    // Social и rugcheck уже завершены (параллельный await выше).
    // creatorRecentTokens — дополнительный sync-фильтр спам-креаторов.
    if (config.strategy.enableScoring) {
      const creatorTokens = this.countCreatorRecentTokens(token.creator);
      const isMayhem = getMintState(mintPubkey).isMayhemMode ?? false;
      if (creatorTokens >= 3 && !isMayhem) {
        logger.info(`📊 SPAM CREATOR: ${token.creator.slice(0,8)} created ${creatorTokens} tokens in 60s — skip ${token.mint.slice(0,8)}`);
        logEvent('CREATOR_SPAM_SKIP', { mint: token.mint, creator: token.creator, recentTokens: creatorTokens });
        return;
      }
      logEvent('TOKEN_ENTRY_CHECK', { mint: token.mint, creatorTokens, isMayhem, pass: true });

      // ── Creator history: block serial ruggers from SQLite token_metadata ──
      const creatorHist = checkCreatorHistory(token.creator);
      if (creatorHist.shouldBlock) {
        logger.info(
          `🚫 SERIAL RUGGER: ${token.creator.slice(0, 8)} — ` +
          `rugRate=${(creatorHist.rugRate * 100).toFixed(0)}% tokens=${creatorHist.totalTokens} — skip ${token.mint.slice(0, 8)}`
        );
        logEvent('CREATOR_SERIAL_RUGGER', {
          mint: token.mint,
          creator: token.creator,
          rugRate: creatorHist.rugRate,
          totalTokens: creatorHist.totalTokens,
        });
        return;
      }
    }

    // ── Trend-confirmed entry: Режим A / B split ──
    // Режим A (elite): strong social + safety → instant entry (existing flow)
    // Режим B (trend): register in TrendTracker, wait for trend confirmation
    if (config.trend.enabled) {
      const socialScore = (token as any)._socialScore ?? 0;
      const rugRisk = ((token as any)._rugcheckResult?.risk ?? 'unknown') as string;

      let prelimScore = 0;
      prelimScore += Math.min(socialScore * 15, 40);
      if (rugRisk === 'low') prelimScore += 20;
      else if (rugRisk === 'medium') prelimScore += 5;
      const creatorTokensForTrend = this.countCreatorRecentTokens(token.creator);
      if (creatorTokensForTrend <= 1) prelimScore += 15;
      else if (creatorTokensForTrend < 3) prelimScore += 10;
      if (getMintState(mintPubkey).isMayhemMode) prelimScore += 20;

      // Все прошедшие токены регистрируем в TrendTracker
      this.trendTracker.track(token.mint, getMintState(mintPubkey).isMayhemMode ? 'mayhem' : 'pump.fun');
      this.trendTokenData.set(token.mint, token);

      this.pushScoredToken({
        mint: token.mint,
        protocol: getMintState(mintPubkey).isMayhemMode ? 'mayhem' : 'pump.fun',
        score: prelimScore, shouldEnter: prelimScore >= config.trend.eliteScoreThreshold,
        entryMultiplier: 1, reasons: [],
        rugcheckRisk: rugRisk, socialScore,
      });

      if (prelimScore < config.trend.eliteScoreThreshold) {
        logger.info(
          `📊 TREND TRACKING: ${token.mint.slice(0, 8)} prelimScore=${prelimScore} ` +
          `(social=${socialScore} rug=${rugRisk}) — waiting for trend confirmation`
        );
        logEvent('TREND_TRACKING', { mint: token.mint, prelimScore, socialScore, rugRisk, mode: 'B' });
        return;
      }

      logger.info(
        `⭐ ELITE TOKEN: ${token.mint.slice(0, 8)} prelimScore=${prelimScore} ` +
        `(social=${socialScore} rug=${rugRisk}) — instant entry path`
      );
      logEvent('ELITE_ENTRY', { mint: token.mint, prelimScore, socialScore, rugRisk, mode: 'A' });
      // Elite tokens продолжают по существующему flow...
    }

    if (curveReady && reserves) {
      // Проверяем минимальную ликвидность перед входом
      if (!this.checkMinLiquidityFromReserves(reserves.virtualSolReserves, 'pump.fun')) {
        logger.warn(`Skipping ${token.mint.slice(0,8)} due to low liquidity (real=${(safeNumber(reserves.virtualSolReserves, 'vSolRes')/1e9 - 30).toFixed(3)} SOL < ${config.strategy.pumpFun.minLiquiditySol})`);
        logEvent('BUY_SKIPPED_LOW_LIQUIDITY', { mint: token.mint });
        return;
      }

      const mintState = getMintState(mintPubkey);
      if (mintState.isMayhemMode) {
        // EV-OPT: Mayhem disabled by default (negative EV in simulation).
        if (!(config.strategy.mayhem as any).enabled) {
          logger.info(`🚫 Mayhem token skipped (mayhem.enabled=false): ${token.mint.slice(0,8)}`);
          logEvent('MAYHEM_SKIPPED_DISABLED', { mint: token.mint });
          dossier.recordRejection(token.mint, 'mayhem_disabled');
          dossier.recordProtocol(token.mint, { isMayhem: true });
          return;
        }
        const multiplier = (token as any)._socialEntryMultiplier ?? config.strategy.socialLowMultiplier;
        logger.info(`🌪️ Mayhem + curveReady → scheduling delayed entry for ${token.mint.slice(0,8)} (social multiplier: ${multiplier})`);
        this.scheduleMayhemDelayedEntry(token, reserves.virtualSolReserves, reserves.virtualTokenReserves, multiplier);
        // ADDED LOG: ENTRY_DECISION for delayed mayhem
        logEvent('ENTRY_DECISION', {
          mint: token.mint,
          creator: token.creator,
          socialMultiplier: multiplier,
          adjustedEntry: this.getEffectiveEntry(Math.max(pumpFunCheck.entryAmountSol * multiplier, config.strategy.minEntryAmountSol)),
          reason: 'curve_ready_mayhem_delayed'
        });
        return;
      }

      // Обычный вход с учётом социального множителя
      const multiplier = (token as any)._socialEntryMultiplier ?? config.strategy.socialLowMultiplier;
      const adjustedEntry = this.getEffectiveEntry(Math.max(pumpFunCheck.entryAmountSol * multiplier, config.strategy.minEntryAmountSol));
      (token as any)._socialEntryMultiplier = multiplier;
      (token as any)._socialScore = this.mintSocialScore.get(token.mint) ?? 0;

      logger.info(`⚡ Entry with ${adjustedEntry.toFixed(4)} SOL (social multiplier: ${multiplier})`);
      // ADDED LOG: ENTRY_DECISION for immediate entry
      logEvent('ENTRY_DECISION', {
        mint: token.mint,
        creator: token.creator,
        socialMultiplier: multiplier,
        adjustedEntry,
        reason: 'curve_ready_immediate'
      });
      await this.executePendingBuy(token, reserves, accountInfo?.data);
      return;
    }

    // Curve not ready — ожидание (этот блок для случая, когда кривая ещё не инициализирована)
    const timer = setTimeout(() => {
      this.pendingBuysMutex.runExclusive(() => {
        const pending = this.pendingBuys.get(token.mint);
        if (pending) {
          this.pendingBuys.delete(token.mint);
          this.seenMints.delete(token.mint);
          logger.warn(`⏰ Pending buy for ${token.mint} timed out — seenMints cleared for re-entry`);
          logEvent('BUY_PENDING_TIMEOUT', { mint: token.mint, seenMintsCleared: true });
        }
      });
    }, config.timeouts.pendingBuyTimeoutMs * 2);

    const isWaitingForIndependent = !getMintState(mintPubkey).isMayhemMode;

    await this.pendingBuysMutex.runExclusive(async () => {
      this.pendingBuys.set(token.mint, {
        tokenData: token,
        timer,
        waitingForFirstBuy: !isWaitingForIndependent,
        waitingForIndependentBuy: isWaitingForIndependent,
        tokenCreator: isWaitingForIndependent ? token.creator : undefined,
        adjustedEntryAmountSol: isWaitingForIndependent ? undefined : undefined,
        independentBuyersSeen: new Set(),
        independentBuyersNeeded: isWaitingForIndependent ? 1 : 0,
        aggregatedBuyVolumeSol: 0,
      });
    });

    if (isWaitingForIndependent) {
      logger.info(`🔍 Awaiting independent buyer for ${token.mint}...`);
      logEvent('ENTRY_DECISION', {
        mint: token.mint,
        creator: token.creator,
        reason: 'await_buyer',
        independentBuyersNeeded: 1
      });
    } else {
      logger.info(`⏳ Awaiting first buy for ${token.mint}...`);
      logEvent('ENTRY_DECISION', {
        mint: token.mint,
        creator: token.creator,
        reason: 'await_first_buy'
      });
    }

    if (!isWaitingForIndependent && this.firstBuyDetected.has(token.mint)) {
      logger.info(`⚡ BUY_SIGNAL already received for ${token.mint}, executing immediately`);
      const pending = await this.pendingBuysMutex.runExclusive(() => {
        const p = this.pendingBuys.get(token.mint);
        if (p) {
          clearTimeout(p.timer);
          this.pendingBuys.delete(token.mint);
          return p;
        }
        return null;
      });
      if (pending) {
        if (!(await this.isTipTooExpensive())) {
          this.executePendingBuy(pending.tokenData).catch(err =>
            logger.error(`Failed late-signal buy for ${token.mint}:`, err)
          );
        }
      }
      return;
    }

    this.pollBondingCurve(token, bondingCurvePubkey, 10, 300).catch(err => {
      logger.debug(`Polling error for ${token.mint}: ${err}`);
    });
  }

  private async pollBondingCurve(token: PumpToken, curvePubkey: PublicKey, maxAttempts: number, intervalMs: number) {
    for (let i = 0; i < maxAttempts; i++) {
      const stillPending = await this.pendingBuysMutex.runExclusive(() =>
        this.pendingBuys.has(token.mint)
      );
      if (!stillPending) return;

      await new Promise(resolve => setTimeout(resolve, intervalMs));

      try {
        const accountInfo = await withRpcLimit(() => this.connection.getAccountInfo(curvePubkey, {
          commitment: 'processed'
        }));
        if (accountInfo) {
          const layout = getRuntimeLayout();
          const tokenOffset = layout.bondingCurve?.tokenReserveOffset ?? 8;
          const virtualTokenReserves = accountInfo.data.readBigUInt64LE(tokenOffset);
          if (virtualTokenReserves > 0n) {
            const realSolReserves = accountInfo.data.readBigUInt64LE(32);
            const realSol = safeNumber(realSolReserves, 'realSol') / 1e9;
            if (realSol >= MIN_REAL_SOL_RESERVES) {
              const pending = await this.pendingBuysMutex.runExclusive(() => {
                const p = this.pendingBuys.get(token.mint);
                if (p) this.pendingBuys.delete(token.mint);
                return p;
              });
              if (pending) {
                clearTimeout(pending.timer);
              }
              const solOffset = layout.bondingCurve?.solReserveOffset ?? 16;
              const virtualSolReserves = accountInfo.data.readBigUInt64LE(solOffset);
              if (!this.checkMinLiquidityFromReserves(virtualSolReserves, 'pump.fun')) {
                logEvent('BUY_SKIPPED_LOW_LIQUIDITY', { mint: token.mint });
                return;
              }
              // Применяем социальный множитель, если есть
              const multiplier = (token as any)._socialEntryMultiplier ?? config.strategy.socialLowMultiplier;
              const adjustedEntry = this.getEffectiveEntry(Math.max(getStrategyForProtocol('pump.fun').entryAmountSol * multiplier, config.strategy.minEntryAmountSol));
              (token as any)._socialEntryMultiplier = multiplier;
              await this.executePendingBuy(token, { virtualSolReserves, virtualTokenReserves });
              return;
            }
          }
        }
      } catch (err) {
        logger.debug(`Polling attempt ${i+1} failed for ${token.mint}: ${err}`);
      }
    }
  }

  private async ensureATACreated(mint: PublicKey, tokenProgramId: PublicKey): Promise<PublicKey> {
    const ata = await getAssociatedTokenAddress(mint, this.payer.publicKey, false, tokenProgramId);
    const mintKey = mint.toBase58();

    if (this.createdATAs.has(mintKey)) return ata;

    const ataInfo = await withRpcLimit(() => this.connection.getAccountInfo(ata)).catch(() => null);
    if (ataInfo) {
      this.createdATAs.add(mintKey);
      return ata;
    }

    try {
      const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        this.payer.publicKey, ata, this.payer.publicKey, mint, tokenProgramId
      );
      const { blockhash, lastValidBlockHeight } = await getCachedBlockhashWithHeight();
      const message = new TransactionMessage({
        payerKey:        this.payer.publicKey,
        recentBlockhash: blockhash,
        instructions:    [createAtaIx],
      }).compileToV0Message();
      const tx = new VersionedTransaction(message);
      tx.sign([this.payer]);
      await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
      logger.debug(`ATA pre-created for ${mintKey.slice(0,8)}`);
      this.createdATAs.add(mintKey);
    } catch (err) {
      logger.debug(`ATA pre-create failed for ${mintKey.slice(0,8)}, will include in bundle:`, err);
    }

    return ata;
  }

  private async simulateFailedTx(txId: string, mint: string) {
    try {
      const txInfo = await withRpcLimit(() => this.connection.getTransaction(txId, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      }));
      if (txInfo?.meta?.err) {
        logger.warn(`Failed tx simulation result for ${mint}: ${JSON.stringify(txInfo.meta.err)}`);
        logEvent('TX_FAILED_ERR', { mint, txId, err: JSON.stringify(txInfo.meta.err) });
      } else if (txInfo) {
        logger.warn(`Tx ${txId.slice(0,8)} confirmed without error — bundle Failed was Jito-level rejection`);
        logEvent('TX_FAILED_ERR', { mint, txId, err: 'jito_level_rejection' });
      } else {
        logger.info(`Tx ${txId.slice(0,8)} not found on-chain (block engine rejection)`);
        logEvent('TX_FAILED_ERR', { mint, txId, err: 'not_on_chain' });
      }
    } catch (err) {
      logger.debug(`simulateFailedTx error for ${mint}:`, err);
    }
  }

  private checkMinLiquidityFromReserves(virtualSolReserves: bigint, protocol: 'pump.fun' | 'pumpswap'): boolean {
    const virtualLiquidity = safeNumber(virtualSolReserves, 'virtualLiq') / 1e9;
    const minLiquidity = protocol === 'pump.fun'
      ? config.strategy.pumpFun.minLiquiditySol
      : config.strategy.pumpSwap.minLiquiditySol;

    const realLiquidity = protocol === 'pump.fun'
      ? Math.max(0, virtualLiquidity - 30)
      : virtualLiquidity;

    if (realLiquidity < minLiquidity) {
      logger.warn(`Liquidity too low for ${protocol}: real=${realLiquidity.toFixed(3)} SOL < ${minLiquidity} (virtual=${virtualLiquidity.toFixed(3)})`);
      return false;
    }
    return true;
  }

  private scheduleMayhemDelayedEntry(token: PumpToken, virtualSolReserves: bigint, virtualTokenReserves: bigint, socialMultiplier: number = 1.0) {
    if (this.mayhemPending.has(token.mint)) return;
    if (this.positions.has(token.mint)) return;

    logger.info(`⏳ Mayhem Mode — scheduling delayed entry for ${token.mint} (social multiplier: ${socialMultiplier})`);
    logEvent('MAYHEM_DELAYED', { mint: token.mint, socialMultiplier });

    const mayhemCfg = config.strategy.mayhem;
    const delayMs   = mayhemCfg.delayMs;

    const timer = setTimeout(async () => {
      this.mayhemPending.delete(token.mint);
      if (!this.running) return;
      if (this.positions.has(token.mint)) return;
      if (this.positions.size >= config.strategy.maxPositions) return;
      if (this.pumpFunCount >= config.strategy.maxPumpFunPositions) return;
      const totalExposureMayhem = [...this.positions.values()].reduce((s, p) => s + p.entryAmountSol, 0);
      if (totalExposureMayhem >= config.strategy.maxTotalExposureSol) {
        logger.warn(`Mayhem: exposure ${totalExposureMayhem.toFixed(3)} SOL >= limit, skip ${token.mint.slice(0,8)}`);
        return;
      }

      try {
        logger.info(`🎯 Mayhem delayed entry executing for ${token.mint}`);
        await this.executeMayhemBuy(token, socialMultiplier);
      } catch (err) {
        logger.error(`Mayhem delayed entry failed for ${token.mint}:`, err);
      }
    }, delayMs);

    this.mayhemPending.set(token.mint, { token, timer });
  }

  private async executeMayhemBuy(token: PumpToken, socialMultiplier: number = 1.0) {
    const mintPubkey   = new PublicKey(token.mint);
    const bondingCurve = new PublicKey(token.bondingCurve);
    const mintState    = getMintState(mintPubkey);
    const mayhemCfg    = config.strategy.mayhem;

    if (await this.isTipTooExpensive()) {
      logger.warn(`Mayhem entry skipped — tip too expensive for ${token.mint}`);
      logEvent('MAYHEM_SKIP', { mint: token.mint, reason: 'tip_too_expensive' });
      return;
    }

    let freshData;
    try {
      freshData = await this.fetchFreshReserves(mintPubkey);
    } catch (err) {
      logger.warn(`Mayhem entry: failed to fetch fresh reserves for ${token.mint}`, err);
      return;
    }

    const vSol    = freshData.virtualSolReserves;
    const vToken  = freshData.virtualTokenReserves;
    const realSol = safeNumber(vSol, 'vSol') / 1e9 - 30;

    if (realSol > mayhemCfg.maxRealSolAtEntry) {
      logger.info(`Mayhem entry skipped — too much bought already (${realSol.toFixed(2)} SOL)`);
      logEvent('MAYHEM_SKIP', { mint: token.mint, realSol, reason: 'too_high' });
      return;
    }
    if (realSol < 0.05) {
      logger.info(`Mayhem entry skipped — curve emptied (${realSol.toFixed(3)} SOL)`);
      return;
    }

    if (!mintState.tokenProgramId) {
      const mintInfo = await withRpcLimit(() => this.connection.getAccountInfo(mintPubkey));
      if (!mintInfo) return;
      mintState.tokenProgramId = mintInfo.owner;
    }

    const isMayhem = true;
    const creatorPubkey = freshData.data.length >= BONDING_CURVE_LAYOUT.CREATOR_OFFSET + 32
      ? getCreatorFromCurveData(freshData.data)
      : new PublicKey(token.creator);

    const baseEntry = mayhemCfg.entryAmountSol;
    const adjustedEntry = Math.min(
      this.getEffectiveEntry(Math.max(baseEntry * socialMultiplier, config.strategy.minEntryAmountSol)),
      0.10 // макс для mayhem
    );

    const ata = await getAssociatedTokenAddress(mintPubkey, this.payer.publicKey, false, mintState.tokenProgramId);
    const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      this.payer.publicKey, ata, this.payer.publicKey, mintPubkey, mintState.tokenProgramId
    );

    const buyIx = buildBuyInstructionFromCreate({
      mint:                 mintPubkey,
      bondingCurve,
      creator:              creatorPubkey,
      userAta:              ata,
      user:                 this.payer.publicKey,
      amountSol:            adjustedEntry,
      slippageBps:          mayhemCfg.slippageBps,
      virtualSolReserves:   vSol,
      virtualTokenReserves: vToken,
      feeRecipient:         getEffectiveFeeRecipient(freshData.data, this.feeRecipient!),
      eventAuthority:       this.eventAuthority,
      tokenProgramId:       mintState.tokenProgramId!,
      isMayhem,
    });

    const buildTx = async (burstIndex?: number): Promise<VersionedTransaction> => {
      const { blockhash } = await getCachedBlockhashWithHeight();
      const priorityFee   = getCachedPriorityFee();
      const message = new TransactionMessage({
        payerKey:        this.payer.publicKey,
        recentBlockhash: blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: config.compute.unitLimit + (burstIndex ?? 0) }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
          createAtaIx,
          buyIx,
        ],
      }).compileToV0Message();
      const tx = new VersionedTransaction(message);
      tx.sign([this.payer]);
      return tx;
    };

    const burstResults = await sendJitoBurst(buildTx, this.payer, config.jito.burstTipMultipliers, true);
    const primary = burstResults[0];

    logger.info(`🚀 Mayhem burst buy sent (${burstResults.length} bundles), primary: ${primary.signature.slice(0,8)}, mint: ${token.mint}, amount: ${adjustedEntry} SOL`);
    logEvent('MAYHEM_BUY_SENT', { mint: token.mint, txId: primary.signature, amountSol: adjustedEntry });

    await this.createOptimisticPosition(token, vSol, vToken, primary.signature, true, freshData.data, adjustedEntry);
    this.confirmAndUpdatePositionBurst(token, burstResults)
      .catch(err => logger.error(`Mayhem confirm error for ${token.mint}:`, err));
  }

  private async executePendingBuy(token: PumpToken, reserves?: { virtualSolReserves: bigint; virtualTokenReserves: bigint }, curveData?: Buffer) {
    const t0 = Date.now();
    try {
      const mintPubkey   = new PublicKey(token.mint);
      const bondingCurve = new PublicKey(token.bondingCurve);

      const safeCheck = await isTokenSafeCached(this.connection, mintPubkey);
      if (!safeCheck) {
        logger.warn(`🛑 Token ${token.mint.slice(0, 8)} unsafe (freeze/mint authority) — skipping buy`);
        logEvent('SAFETY_BLOCKED', { mint: token.mint, path: 'pump_fun' });
        return;
      }

      const protocolInfo = await detectProtocol(this.connection, mintPubkey);
      if (protocolInfo.protocol === 'pumpswap') {
        logger.info(`Token ${token.mint} is now on PumpSwap, buying via AMM`);
        const pumpSwapCfg = getStrategyForProtocol('pumpswap');
        const txId = await buyTokenPumpSwap(
          this.connection,
          mintPubkey,
          this.payer,
          pumpSwapCfg.entryAmountSol,
          pumpSwapCfg.slippageBps
        );
        logger.info(`🟢 PumpSwap buy via fallback: ${txId}`);
        logEvent('PUMP_SWAP_BUY_SENT', { mint: token.mint, txId });
        await this.createOptimisticPumpSwapPosition(mintPubkey, txId);
        this.confirmAndUpdatePumpSwapPosition(mintPubkey, txId)
          .catch(err => logger.error(`PumpSwap confirm error for ${token.mint}:`, err));
        return;
      }

      // Jupiter fallback: протокол не распознан, но Jupiter может найти маршрут.
      if (protocolInfo.protocol === 'unknown' && (config.strategy as any).jupiterFallback?.enabled) {
        logger.info(`🪐 Unknown protocol for ${token.mint.slice(0, 8)}, trying Jupiter fallback buy`);
        dossier.markUnknown(token.mint);
        this.tryJupiterFallbackBuy(token.mint, mintPubkey).catch(err =>
          logger.error(`Jupiter fallback buy error for ${token.mint.slice(0, 8)}:`, err)
        );
        return;
      }
      if (protocolInfo.protocol === 'unknown') {
        dossier.markUnknown(token.mint);
        dossier.recordRejection(token.mint, 'unknown_protocol_fallback_disabled');
      }

      if (!this.feeRecipient) {
        logger.error('feeRecipient not initialized');
        return;
      }

      const totalExposurePre = [...this.positions.values()].reduce((s, p) => s + p.entryAmountSol, 0);
      if (totalExposurePre >= config.strategy.maxTotalExposureSol) {
        logger.warn(`executePendingBuy: exposure ${totalExposurePre.toFixed(3)} SOL >= limit, abort buy ${token.mint.slice(0,8)}`);
        logEvent('BUY_SKIPPED_EXPOSURE', { mint: token.mint, totalExposure: totalExposurePre });
        return;
      }

      // ── Pre-entry rugcheck gate ──
      if (config.strategy.enableRugcheck) {
        const rugResult = await checkRugcheck(token.mint).catch(() => null);
        if (rugResult && rugResult.risk === 'high') {
          logger.warn(`🛑 Rugcheck HIGH RISK in executePendingBuy — skipping: ${token.mint.slice(0,8)}`);
          logEvent('RUGCHECK_BLOCKED', { mint: token.mint, score: rugResult.score, risks: rugResult.risks, path: 'pending_buy' });
          return;
        }
      }

      // F6: Hard balance floor — stop trading entirely below threshold
      {
        const minBal = (config.strategy as any).minBalanceToTradeSol ?? 0.5;
        const bal = (await this.getCachedBalance()) / 1e9;
        if (bal < minBal) {
          logger.warn(`⛔ Balance ${bal.toFixed(3)} SOL below minimum ${minBal} — not trading`);
          logEvent('BALANCE_FLOOR_HIT', { mint: token.mint, balance: bal, minRequired: minBal });
          return;
        }
      }

      // ── Проверка баланса кошелька перед отправкой buy ──────────────────────
      // Без этого: buy TX ревертится (insufficient funds), но optimistic position
      // уже создана → sell пытается продать пустую ATA → Custom:3012.
      const socialMultiplierEarly = (token as any)._socialEntryMultiplier ?? config.strategy.socialLowMultiplier;
      const pumpFunCfgEarly = getStrategyForProtocol('pump.fun');
      const estimatedEntry = Math.max(
        pumpFunCfgEarly.entryAmountSol * socialMultiplierEarly,
        config.strategy.minEntryAmountSol
      );
      const minRequiredBalance = estimatedEntry + config.jito.tipAmountSol * 2 + 0.002; // entry + 2 tips + gas buffer
      const walletBalanceLamports = await this.getCachedBalance();
      const walletBalanceSol = walletBalanceLamports / 1e9;
      if (walletBalanceSol < minRequiredBalance) {
        logger.warn(`🚫 Insufficient balance for buy: ${walletBalanceSol.toFixed(4)} SOL < ${minRequiredBalance.toFixed(4)} required (entry=${estimatedEntry.toFixed(4)})`);
        logEvent('BUY_SKIPPED_BALANCE', { mint: token.mint, balance: walletBalanceSol, required: minRequiredBalance, estimatedEntry });
        return;
      }

      let virtualSolReserves: bigint, virtualTokenReserves: bigint;
      const mintState = getMintState(mintPubkey);

      if (reserves && mintState.tokenProgramId) {
        virtualSolReserves = reserves.virtualSolReserves;
        virtualTokenReserves = reserves.virtualTokenReserves;
      } else if (reserves && !mintState.tokenProgramId) {
        virtualSolReserves = reserves.virtualSolReserves;
        virtualTokenReserves = reserves.virtualTokenReserves;
        const mintInfo = await withRpcLimit(() => this.connection.getAccountInfo(mintPubkey));
        if (!mintInfo) throw new Error('Mint account not found');
        mintState.tokenProgramId = mintInfo.owner;
      } else if (!reserves && mintState.tokenProgramId) {
        const curveAcc = await withRpcLimit(() => this.connection.getAccountInfo(bondingCurve));
        if (!curveAcc) throw new Error('Bonding curve not found');
        const layout = getRuntimeLayout();
        virtualSolReserves   = curveAcc.data.readBigUInt64LE(layout.bondingCurve?.solReserveOffset   ?? 16);
        virtualTokenReserves = curveAcc.data.readBigUInt64LE(layout.bondingCurve?.tokenReserveOffset ?? 8);
        if (mintState.isMayhemMode === undefined) {
          mintState.isMayhemMode = this.isMayhemMode(curveAcc.data);
        }
      } else {
        const [curveAcc, mintInfo] = await Promise.all([
          withRpcLimit(() => this.connection.getAccountInfo(bondingCurve)),
          withRpcLimit(() => this.connection.getAccountInfo(mintPubkey)),
        ]);
        if (!curveAcc) throw new Error('Bonding curve not found');
        if (!mintInfo)  throw new Error('Mint account not found');
        mintState.tokenProgramId = mintInfo.owner;
        const layout = getRuntimeLayout();
        virtualSolReserves   = curveAcc.data.readBigUInt64LE(layout.bondingCurve?.solReserveOffset   ?? 16);
        virtualTokenReserves = curveAcc.data.readBigUInt64LE(layout.bondingCurve?.tokenReserveOffset ?? 8);
        if (mintState.isMayhemMode === undefined) {
          mintState.isMayhemMode = this.isMayhemMode(curveAcc.data);
        }
      }

      logger.debug(`executePendingBuy: RPC fetch took ${Date.now() - t0}ms for ${token.mint}`);

      const isMayhem = mintState.isMayhemMode ?? false;
      const isAlmostComplete = this.isCurveAlmostComplete(virtualTokenReserves);
      const socialMultiplier = (token as any)._socialEntryMultiplier ?? config.strategy.socialLowMultiplier;
      const pumpFunCfg = getStrategyForProtocol('pump.fun');
      const adjustedEntryAmountSol = this.getEffectiveEntry(Math.max(
        pumpFunCfg.entryAmountSol * socialMultiplier,
        config.strategy.minEntryAmountSol
      ));

      if (isMayhem) {
        if (!(config.strategy.mayhem as any).enabled) {
          logger.info(`🚫 Mayhem token skipped (mayhem.enabled=false): ${token.mint.slice(0,8)}`);
          logEvent('MAYHEM_SKIPPED_DISABLED', { mint: token.mint });
          dossier.recordRejection(token.mint, 'mayhem_disabled');
          dossier.recordProtocol(token.mint, { isMayhem: true });
          return;
        }
        logger.info(`🌪️ Mayhem token confirmed for ${token.mint}, scheduling delayed entry (social multiplier: ${socialMultiplier})`);
        this.scheduleMayhemDelayedEntry(token, virtualSolReserves, virtualTokenReserves, socialMultiplier);
        return;
      }

      if (isAlmostComplete) {
        logger.info(`⚠️ Curve almost complete for ${token.mint}, entering with high slippage (social multiplier: ${socialMultiplier})`);
        const lateSlippageBps = pumpFunCfg.slippageBps * 2;

        let freshData;
        try {
          freshData = await this.fetchFreshReserves(mintPubkey);
        } catch (err) {
          logger.error(`Failed to fetch fresh reserves for late entry ${token.mint}, skipping`, err);
          return;
        }

        const creatorPubkey = freshData.data.length >= BONDING_CURVE_LAYOUT.CREATOR_OFFSET + 32
          ? getCreatorFromCurveData(freshData.data)
          : new PublicKey(token.creator);

        const ata = await getAssociatedTokenAddress(mintPubkey, this.payer.publicKey, false, mintState.tokenProgramId);
        const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
          this.payer.publicKey, ata, this.payer.publicKey, mintPubkey, mintState.tokenProgramId
        );

        const buyIx = buildBuyInstructionFromCreate({
          mint:                 mintPubkey,
          bondingCurve,
          creator:              creatorPubkey,
          userAta:              ata,
          user:                 this.payer.publicKey,
          amountSol:            adjustedEntryAmountSol,
          slippageBps:          lateSlippageBps,
          virtualSolReserves:   freshData.virtualSolReserves,
          virtualTokenReserves: freshData.virtualTokenReserves,
          feeRecipient:         getEffectiveFeeRecipient(freshData.data, this.feeRecipient!),
          eventAuthority:       this.eventAuthority,
          tokenProgramId:       mintState.tokenProgramId!,
          isMayhem,
        });

        const buildTx = async (burstIndex?: number): Promise<VersionedTransaction> => {
          const { blockhash } = await getCachedBlockhashWithHeight();
          const priorityFee   = getCachedPriorityFee();
          const message = new TransactionMessage({
            payerKey:        this.payer.publicKey,
            recentBlockhash: blockhash,
            instructions: [
              ComputeBudgetProgram.setComputeUnitLimit({ units: config.compute.unitLimit + (burstIndex ?? 0) }),
              ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
              createAtaIx,
              buyIx,
            ],
          }).compileToV0Message();
          const tx = new VersionedTransaction(message);
          tx.sign([this.payer]);
          return tx;
        };

        // ADDED LOG: EXECUTE_PENDING_BUY for late entry
        logEvent('EXECUTE_PENDING_BUY', {
          mint: token.mint,
          type: 'late',
          socialMultiplier,
          adjustedEntryAmountSol,
          slippageBps: lateSlippageBps,
          virtualSolReserves: freshData.virtualSolReserves.toString(),
          virtualTokenReserves: freshData.virtualTokenReserves.toString(),
        });

        const burstResults = await sendJitoBurst(buildTx, this.payer, config.jito.burstTipMultipliers, true);
        const primaryResult = burstResults[0];

        logger.info(`🚀 Late burst buy sent (${burstResults.length} bundles), primary: ${primaryResult.signature.slice(0,8)}, mint: ${token.mint}, amount: ${adjustedEntryAmountSol} SOL`);
        logEvent('BUY_SENT', { mint: token.mint, txId: primaryResult.signature, burst: burstResults.length, type: 'late' });

        await this.createOptimisticPosition(token, freshData.virtualSolReserves, freshData.virtualTokenReserves, primaryResult.signature, false, freshData.data, adjustedEntryAmountSol);
        this.confirmAndUpdatePositionBurst(token, burstResults)
          .catch(err => logger.error(`Background confirm error for ${token.mint}:`, err));
        return;
      }

      // Обычный вход
      if (socialMultiplier !== 1.0) {
        logger.info(`📱 Social-adjusted entry: ${adjustedEntryAmountSol.toFixed(4)} SOL (×${socialMultiplier}, score=${(token as any)._socialScore ?? 0})`);
      }

      let freshData;
      try {
        freshData = await this.fetchFreshReserves(mintPubkey);
      } catch (err) {
        logger.error(`Failed to fetch fresh reserves for ${token.mint}, using previous ones`, err);
        freshData = { virtualSolReserves, virtualTokenReserves, data: Buffer.alloc(0) };
      }

      const creatorPubkey = freshData.data.length >= BONDING_CURVE_LAYOUT.CREATOR_OFFSET + 32
        ? getCreatorFromCurveData(freshData.data)
        : new PublicKey(token.creator);

      const ata = await getAssociatedTokenAddress(mintPubkey, this.payer.publicKey, false, mintState.tokenProgramId);
      const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        this.payer.publicKey, ata, this.payer.publicKey, mintPubkey, mintState.tokenProgramId
      );

      const liquiditySol = safeNumber(freshData.virtualSolReserves, 'liquiditySol') / 1e9;
      const dynSlippage = computeDynamicSlippage(adjustedEntryAmountSol, liquiditySol, pumpFunCfg.slippageBps);

      const buyIx = buildBuyInstructionFromCreate({
        mint:                 mintPubkey,
        bondingCurve,
        creator:              creatorPubkey,
        userAta:              ata,
        user:                 this.payer.publicKey,
        amountSol:            adjustedEntryAmountSol,
        slippageBps:          dynSlippage,
        virtualSolReserves:   freshData.virtualSolReserves,
        virtualTokenReserves: freshData.virtualTokenReserves,
        feeRecipient:         getEffectiveFeeRecipient(freshData.data, this.feeRecipient!),
        eventAuthority:       this.eventAuthority,
        tokenProgramId:       mintState.tokenProgramId!,
        isMayhem,
      });

      const buildTx = async (burstIndex?: number): Promise<VersionedTransaction> => {
        const { blockhash } = await getCachedBlockhashWithHeight();
        const priorityFee   = getCachedPriorityFee();
        const message = new TransactionMessage({
          payerKey:        this.payer.publicKey,
          recentBlockhash: blockhash,
          instructions: [
            ComputeBudgetProgram.setComputeUnitLimit({ units: config.compute.unitLimit + (burstIndex ?? 0) }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
            createAtaIx,
            buyIx,
          ],
        }).compileToV0Message();
        const tx = new VersionedTransaction(message);
        tx.sign([this.payer]);
        return tx;
      };

      // ADDED LOG: EXECUTE_PENDING_BUY for normal entry
      logEvent('EXECUTE_PENDING_BUY', {
        mint: token.mint,
        type: 'normal',
        socialMultiplier,
        adjustedEntryAmountSol,
        slippageBps: dynSlippage,
        maxSlippageBps: pumpFunCfg.slippageBps,
        liquiditySol,
        virtualSolReserves: freshData.virtualSolReserves.toString(),
        virtualTokenReserves: freshData.virtualTokenReserves.toString(),
      });

      const burstResults = await sendJitoBurst(buildTx, this.payer, config.jito.burstTipMultipliers, true);
      const primaryResult = burstResults[0];

      logger.info(`🚀 Burst buy sent (${burstResults.length} bundles), primary: ${primaryResult.signature.slice(0,8)}, mint: ${token.mint}, amount: ${adjustedEntryAmountSol} SOL`);
      logEvent('BUY_SENT', { mint: token.mint, txId: primaryResult.signature, burst: burstResults.length, type: 'normal' });

      await this.createOptimisticPosition(token, freshData.virtualSolReserves, freshData.virtualTokenReserves, primaryResult.signature, false, freshData.data, adjustedEntryAmountSol);
      this.confirmAndUpdatePositionBurst(token, burstResults)
        .catch(err => logger.error(`Background confirm error for ${token.mint}:`, err));

    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(`❌ Failed to buy token ${token.mint}:`, error);
      logEvent('BUY_FAIL', { mint: token.mint, error: error.message });
    }
  }

  private async createOptimisticPosition(token: PumpToken, virtualSolReserves: bigint, virtualTokenReserves: bigint, txId: string, isMayhemPos = false, curveData?: Buffer, overrideEntryAmountSol?: number) {
    try {
      const mintPubkey       = new PublicKey(token.mint);
      const cfg              = isMayhemPos ? config.strategy.mayhem : getStrategyForProtocol('pump.fun');
      const effectiveEntry   = overrideEntryAmountSol ?? this.getEffectiveEntry(cfg.entryAmountSol);
      const decimals         = 6;
      const amountInLamports = BigInt(Math.floor(effectiveEntry * 1e9));
      const expectedTokens   = safeNumber((amountInLamports * virtualTokenReserves) / virtualSolReserves, 'expectedTokensRaw') / Math.pow(10, decimals);
      const entryPrice       = effectiveEntry / expectedTokens;

      const cashbackEnabled = curveData && curveData.length > 82 ? isCashbackEnabled(curveData) : false;

      const position = new Position(
        mintPubkey,
        entryPrice,
        expectedTokens,
        { programId: PUMP_PROGRAM_ID.toBase58(), quoteMint: token.mint },
        decimals,
        {
          entryAmountSol:   effectiveEntry,
          protocol:         isMayhemPos ? 'mayhem' : 'pump.fun',
          feeRecipientUsed: this.feeRecipient?.toBase58(),
          creator:          token.creator,
          cashbackEnabled,
        }
      );

      logger.info(`📈 Optimistic position opened: ${expectedTokens.toFixed(0)} tokens at ${entryPrice.toFixed(8)} SOL (tx: ${txId.slice(0,8)})`);
      logEvent(isMayhemPos ? 'MAYHEM_OPTIMISTIC_POSITION' : 'OPTIMISTIC_POSITION', { mint: token.mint, txId, expectedTokens, entryPrice });

      this.positions.set(token.mint, position);
      this.eventsEntered++;
      this.emit('position:open', {
        mint: position.mint.toBase58(),
        protocol: position.protocol,
        entryPrice: position.entryPrice,
        currentPrice: position.currentPrice,
        pnlPercent: position.pnlPercent,
        amount: position.amount,
        entryAmountSol: position.entryAmountSol,
        openedAt: position.openedAt,
        runnerTail: position.runnerTailActivated,
      });
      await this.savePositions();
      this.subscribeToPositionAccount(position);

      const timeout = setTimeout(async () => {
        if (this.positions.has(token.mint) && !this.confirmedPositions.has(token.mint)) {
          // FIX: Check ATA balance before deleting — tokens may exist despite confirm timeout
          try {
            const mintPk = new PublicKey(token.mint);
            const mintState = getMintState(mintPk);
            if (mintState.tokenProgramId) {
              const ata = await getAssociatedTokenAddress(mintPk, this.payer.publicKey, false, mintState.tokenProgramId);
              const bal = await withRpcLimit(() => this.connection.getTokenAccountBalance(ata));
              if (bal?.value && BigInt(bal.value.amount) > 0n) {
                logger.warn(`🔄 Optimistic timeout for ${token.mint.slice(0,8)} but ATA has ${bal.value.uiAmountString} tokens — restoring as confirmed`);
                logEvent('OPTIMISTIC_TIMEOUT_ATA_RESTORE', { mint: token.mint, balance: bal.value.uiAmountString });
                position.amount = Number(bal.value.uiAmount ?? 0);
                position.tokenDecimals = bal.value.decimals;
                this.confirmedPositions.add(token.mint);
                await this.savePositions();
                this.optimisticTimeouts.delete(token.mint);
                return;
              }
            }
          } catch (e) {
            logger.debug(`ATA check failed during optimistic timeout for ${token.mint.slice(0,8)}: ${e}`);
          }
          logger.warn(`Optimistic position for ${token.mint} timed out, removing`);
          this.unsubscribeFromPositionAccount(position);
          this.positions.delete(token.mint);
          this.copyTradeMints.delete(token.mint);
          this.savePositions().catch(e => logger.error('Failed to save after timeout:', e));
          logEvent('OPTIMISTIC_TIMEOUT', { mint: token.mint });
        }
        this.optimisticTimeouts.delete(token.mint);
      }, config.timeouts.optimisticPositionTtlMs);
      this.optimisticTimeouts.set(token.mint, timeout);

    } catch (err) {
      logger.error(`Failed to create optimistic position for ${token.mint}:`, err);
    }
  }

  /**
   * Robust on-chain fallback: retry getSignatureStatuses up to 5 times (500ms apart)
   * with 'processed' commitment to catch TXs that Jito falsely reports as Invalid.
   */
  private async checkTxLandedOnChain(txId: string, mintStr: string): Promise<boolean> {
    const MAX_RETRIES = 5;
    const RETRY_DELAY = 500;
    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        const sigStatus = await withRpcLimit(() => this.connection.getSignatureStatuses([txId]));
        const status = sigStatus?.value?.[0];
        if (status && status.confirmationStatus && !status.err) {
          logger.info(`🔄 Bundle "Invalid" but tx ${txId.slice(0,8)} LANDED on-chain (${status.confirmationStatus}) [retry ${i+1}]`);
          logEvent('BUNDLE_INVALID_BUT_LANDED', { mint: mintStr, txId, confirmationStatus: status.confirmationStatus, retry: i+1 });
          return true;
        }
      } catch (err) {
        logger.debug(`On-chain fallback retry ${i+1} failed for ${mintStr}: ${err}`);
      }
      if (i < MAX_RETRIES - 1) await new Promise(r => setTimeout(r, RETRY_DELAY));
    }

    // Last resort: check ATA balance directly
    try {
      const mintPubkey = new PublicKey(mintStr);
      const ata = getAssociatedTokenAddressSync(mintPubkey, this.payer.publicKey, false, TOKEN_PROGRAM_ID);
      const ataInfo = await withRpcLimit(() => this.connection.getTokenAccountBalance(ata));
      const balance = Number(ataInfo?.value?.uiAmount ?? 0);
      if (balance > 0) {
        logger.info(`🔄 ATA balance check: ${balance} tokens found for ${mintStr} — TX landed despite Invalid status`);
        logEvent('BUNDLE_INVALID_BUT_ATA_HAS_TOKENS', { mint: mintStr, txId, balance });
        return true;
      }
    } catch {
      // ATA may not exist
    }
    return false;
  }

  /**
   * Recover position after detecting a falsely-reported Invalid bundle.
   */
  private async recoverLandedPosition(
    mintStr: string, txId: string, protocol: Position['protocol'], entryAmountSol: number, lastTipPaid: number,
  ): Promise<boolean> {
    updateLandedStat(true);
    this.recordBundleResult(true);
    try {
      const txInfo = await withRpcLimit(() => this.connection.getTransaction(txId, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      }));
      const postBalance = txInfo?.meta?.postTokenBalances?.find(
        (b: TokenBalance) => b.owner === this.payer.publicKey.toBase58() && b.mint === mintStr
      );
      if (postBalance) {
        const actualAmount = Number(postBalance.uiTokenAmount.uiAmount ?? 0);
        const decimals = postBalance.uiTokenAmount.decimals;
        if (actualAmount > 0) {
          const position = this.positions.get(mintStr);
          if (position) {
            const actualEntryPrice = entryAmountSol / actualAmount;
            position.amount = actualAmount;
            position.entryPrice = actualEntryPrice;
            position.tokenDecimals = decimals;
            await this.savePositions();
            logger.info(`✅ Position confirmed (on-chain fallback) for ${mintStr}: ${actualAmount} tokens at ${actualEntryPrice}`);
            this.confirmedPositions.add(mintStr);
            const timeout = this.optimisticTimeouts.get(mintStr);
            if (timeout) { clearTimeout(timeout); this.optimisticTimeouts.delete(mintStr); }
            tradeLog.open({
              mint: mintStr, protocol, entryPrice: actualEntryPrice,
              amountSol: entryAmountSol, tokensReceived: actualAmount,
              slippageBps: getStrategyForProtocol(protocol).slippageBps,
              jitoTipSol: lastTipPaid, txId, openedAt: position.openedAt,
            });
            return true;
          }
        }
      }
    } catch (err) {
      logger.warn(`recoverLandedPosition failed for ${mintStr}: ${err}`);
    }
    return false;
  }

  private async confirmAndUpdatePosition(token: PumpToken, txId: string, sharedConfirmed?: { value: boolean }) {
    const maxAttempts = config.jito.maxRetries;
    const RESEND_FROM_ATTEMPT = 2;
    const confirmInterval = config.timeouts.confirmIntervalMs;
    let tipMultiplier = 1.0;
    let invalidCount = 0;
    const MAX_INVALID_BEFORE_REMOVE = 2;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, confirmInterval));
      logEvent('CONFIRM_ATTEMPT', { mint: token.mint, attempt: attempt+1, txId, bundleId: getBundleId(txId) });

      let bundleStatus: string | undefined;

      try {
        const bundleId = getBundleId(txId);
        if (bundleId) {
          const statuses = await getInflightBundleStatuses([bundleId]);
          logger.debug(`Bundle statuses raw [${token.mint.slice(0,8)}]: ${JSON.stringify(statuses)}`);
          bundleStatus = statuses[0]?.status;
          logEvent('BUNDLE_STATUS', { mint: token.mint, bundleId, status: bundleStatus ?? 'undefined', txId });

          if (bundleStatus === 'Landed') {
            if (sharedConfirmed?.value) return;

            updateLandedStat(true);
            this.recordBundleResult(true);

            const txInfo = await withRpcLimit(() => this.connection.getTransaction(txId, {
              commitment: 'confirmed',
              maxSupportedTransactionVersion: 0,
            }));

            if (txInfo?.meta) {
              const postBalance = txInfo.meta.postTokenBalances?.find(
                (b: TokenBalance) => b.owner === this.payer.publicKey.toBase58() && b.mint === token.mint
              );
              if (postBalance) {
                const actualAmount = Number(postBalance.uiTokenAmount.uiAmount ?? 0);
                const decimals = postBalance.uiTokenAmount.decimals;
                if (actualAmount > 0) {
                  const position = this.positions.get(token.mint);
                  const pumpFunCfg = getStrategyForProtocol('pump.fun');
                  if (position) {
                    const actualEntryPrice = position.entryAmountSol / actualAmount;
                    position.amount = actualAmount;
                    position.entryPrice = actualEntryPrice;
                    position.tokenDecimals = decimals;
                    await this.savePositions();
                    logger.info(`✅ Position confirmed for ${token.mint}: actual amount ${actualAmount}, entry ${actualEntryPrice}`);
                    logEvent('POSITION_CONFIRMED', { mint: token.mint, txId, actualAmount, entryPrice: actualEntryPrice });

                    const timeout = this.optimisticTimeouts.get(token.mint);
                    if (timeout) {
                      clearTimeout(timeout);
                      this.optimisticTimeouts.delete(token.mint);
                    }
                    this.confirmedPositions.add(token.mint);
                    metrics.observe('buy_confirm_ms', Date.now() - position.openedAt);
                    if (sharedConfirmed) sharedConfirmed.value = true;

                    tradeLog.open({
                      mint:           token.mint,
                      protocol:       'pump.fun',
                      entryPrice:     actualEntryPrice,
                      amountSol:      position.entryAmountSol,
                      tokensReceived: actualAmount,
                      slippageBps:    pumpFunCfg.slippageBps,
                      jitoTipSol:     lastTipPaid,
                      txId,
                      openedAt:       position.openedAt,
                    });

                    this.scheduleSocialRetry(token.mint, position);

                    // ─── Для токенов score=0 запускаем таймер раннего выхода ───
                    // Skip for copy-trade positions — wallet validation is sufficient
                    const socialScore = this.mintSocialScore.get(token.mint) ?? 0;
                    if (socialScore === 0 && !this.copyTradeMints.has(token.mint) && !this.earlyExitTimers.has(token.mint) && !this.sellingMints.has(token.mint)) {
                      const earlyTimeout = config.strategy.earlyExitTimeoutMs;
                      const exitTimer = setTimeout(async () => {
                        logger.warn(`⏰ No independent buyer for ${token.mint.slice(0,8)} within ${earlyTimeout}ms — exiting position`);
                        logEvent('EARLY_EXIT_TIMEOUT', { mint: token.mint, timeoutMs: earlyTimeout });
                        const pos = this.positions.get(token.mint);
                        if (pos && !this.sellingMints.has(token.mint)) {
                          await this.executeFullSell(pos, token.mint, { action: 'full', reason: 'early_exit', urgent: false });
                        }
                        this.earlyExitTimers.delete(token.mint);
                      }, earlyTimeout);
                      this.earlyExitTimers.set(token.mint, exitTimer);
                      logger.info(`⏱️ Early exit timer started (${earlyTimeout}ms) for ${token.mint.slice(0,8)}`);
                    }

                    // ADDED LOG: POSITION_CONFIRMED_SCORE
                    const rugResult = (token as any)._rugcheckResult;
                    const realBuyers = this.confirmedRealBuyers.get(token.mint);

                    // Holder concentration check (brainstorm v4): fetch top holders
                    let topHolderPct: number | undefined;
                    try {
                      const largest = await withRpcLimit(() =>
                        this.connection.getTokenLargestAccounts(new PublicKey(token.mint))
                      );
                      if (largest.value.length > 0) {
                        const totalKnown = largest.value.reduce((s, a) => s + Number(a.amount), 0);
                        if (totalKnown > 0) {
                          topHolderPct = (Number(largest.value[0].amount) / totalKnown) * 100;
                        }
                      }
                    } catch {
                      // non-critical, scoring works without it
                    }

                    const features: TokenFeatures = {
                      socialScore,
                      independentBuyers: realBuyers?.size ?? 0,
                      firstBuySol: 0,
                      creatorRecentTokens: this.countCreatorRecentTokens(position.creator ?? ''),
                      metadataJsonSize: 0,
                      rugcheckRisk: rugResult?.risk ?? 'unknown',
                      hasMintAuthority: rugResult?.hasMintAuthority ?? false,
                      hasFreezeAuthority: rugResult?.hasFreezeAuthority ?? false,
                      isMayhem: getMintState(position.mint).isMayhemMode ?? false,
                      topHolderPct,
                      socialMentions: this.getSocialMentionCount(token.mint),
                      hasDexBoost: hasDexBoost(token.mint),
                    };
                    const scoringResult = scoreToken(features, this.getEffectiveMinScore());
                    position.tokenScore = scoringResult.score;
                    dossier.recordScoring(token.mint, {
                      score: scoringResult.score,
                      reasons: scoringResult.reasons,
                      entryMultiplier: scoringResult.entryMultiplier,
                      hasMintAuthority: rugResult?.hasMintAuthority ?? false,
                      hasFreezeAuthority: rugResult?.hasFreezeAuthority ?? false,
                      metadataJsonSize: features.metadataJsonSize,
                      socialScore,
                      socialMentions5min: features.socialMentions,
                      creatorRecentTokens: features.creatorRecentTokens,
                      rugcheckRisk: rugResult?.risk ?? 'unknown',
                      topHolderPct,
                      uniqueBuyersAtEntry: features.independentBuyers,
                      firstBuySol: features.firstBuySol,
                    });
                    logEvent('POSITION_CONFIRMED_SCORE', {
                      mint: token.mint,
                      score: scoringResult.score,
                      shouldEnter: scoringResult.shouldEnter,
                      reasons: scoringResult.reasons,
                      entryMultiplier: scoringResult.entryMultiplier,
                      socialScore,
                      rugcheckRisk: rugResult?.risk,
                      realBuyersCount: realBuyers?.size ?? 0,
                    });
                    this.pushScoredToken({
                      mint: token.mint, protocol: position.protocol,
                      score: scoringResult.score, shouldEnter: scoringResult.shouldEnter,
                      entryMultiplier: scoringResult.entryMultiplier,
                      reasons: scoringResult.reasons,
                      rugcheckRisk: rugResult?.risk ?? 'unknown',
                      socialScore,
                    });

                    // D2: Post-entry scoring gate — if token scores below threshold, sell immediately
                    // Skip for copy-trade positions: wallet validation is the quality filter
                    if (!scoringResult.shouldEnter && !this.copyTradeMints.has(token.mint)) {
                      logger.warn(`📊 LOW SCORE → immediate exit: ${token.mint.slice(0,8)} score=${scoringResult.score} < min=${this.getEffectiveMinScore()} reasons=[${scoringResult.reasons.join(', ')}]`);
                      logEvent('SCORE_GATE_EXIT', { mint: token.mint, score: scoringResult.score, reasons: scoringResult.reasons });
                      this.executeFullSell(position, token.mint, { action: 'full', reason: 'score_gate' as any, urgent: false });
                    }

                  } else {
                    logger.warn(`Position for ${token.mint} not found, recreating from tx`);
                    await this.createPositionFromTxInfo(token, txInfo, txId);
                  }
                  return;
                }
              }
            }
          } else if (bundleStatus === 'Failed' || bundleStatus === 'Dropped') {
            logger.warn(`Bundle ${bundleStatus} for ${token.mint}, removing optimistic position.`);
            updateLandedStat(false);
            this.recordBundleResult(false);
            const position = this.positions.get(token.mint);
            if (position) {
              this.emitTradeClose(position, token.mint, txId, 'bundle_failed', false, 0, Date.now(), 'jito');
              this.positions.delete(token.mint);
              this.copyTradeMints.delete(token.mint);
              await this.savePositions();
            }
            logEvent('BUY_FAIL', { mint: token.mint, txId, reason: `bundle_${bundleStatus}` });
            this.simulateFailedTx(txId, token.mint).catch(() => {});
            return;
          } else if (bundleStatus === 'Invalid') {
            invalidCount++;
            logger.warn(`Bundle Invalid for ${token.mint} attempt=${attempt+1} invalidCount=${invalidCount}`);
            logEvent('BUNDLE_INVALID', { mint: token.mint, bundleId, attempt: attempt+1, txId, invalidCount });
            this.recordBundleResult(false);
            if (invalidCount >= MAX_INVALID_BEFORE_REMOVE) {
              const landed = await this.checkTxLandedOnChain(txId, token.mint);
              if (landed) {
                const position = this.positions.get(token.mint);
                const recovered = await this.recoverLandedPosition(
                  token.mint, txId, 'pump.fun', position?.entryAmountSol ?? getStrategyForProtocol('pump.fun').entryAmountSol, lastTipPaid,
                );
                if (recovered) return;
                return; // landed but couldn't parse — don't remove
              }

              logger.warn(`🗑️ ${invalidCount} Invalid bundles for ${token.mint} — removing optimistic position`);
              const position = this.positions.get(token.mint);
              if (position) {
                this.emitTradeClose(position, token.mint, txId, 'bundle_invalid_repeated', false, 0, Date.now(), 'jito');
                this.positions.delete(token.mint);
                this.copyTradeMints.delete(token.mint);
                await this.savePositions();
              }
              logEvent('BUY_FAIL', { mint: token.mint, txId, reason: `bundle_invalid_x${invalidCount}` });
              return;
            }
          }
        }

        if (attempt < RESEND_FROM_ATTEMPT && bundleStatus === 'Pending') continue;

        if (attempt < RESEND_FROM_ATTEMPT && bundleStatus === 'Invalid') {
          logger.info(`Bundle Invalid at early attempt=${attempt+1} for ${token.mint} — waiting before resend`);
          continue;
        }

        const shouldReturn = await this.resendMutex.runExclusive(async () => {
          if (sharedConfirmed?.value) return true;

          tipMultiplier *= config.jito.tipIncreaseFactor;
          logger.info(`Resending bundle for ${token.mint} attempt=${attempt+1} tipMultiplier=${tipMultiplier.toFixed(2)}`);

          const mintPubkey   = new PublicKey(token.mint);
          const bondingCurve = new PublicKey(token.bondingCurve);
          const resendCfg    = getStrategyForProtocol('pump.fun');
          const mintState = getMintState(mintPubkey);
          const isMayhem = mintState.isMayhemMode ?? false;

          if (mintState.tokenProgramId) {
            try {
              const ata = await getAssociatedTokenAddress(mintPubkey, this.payer.publicKey, false, mintState.tokenProgramId);
              const ataInfo = await withRpcLimit(() => this.connection.getTokenAccountBalance(ata));
              if (ataInfo && BigInt(ataInfo.value.amount) > 0n) {
                logger.warn(`ATA has tokens for ${token.mint.slice(0,8)} — buy already landed, cancelling resend`);
                logEvent('RESEND_CANCELLED_ATA', { mint: token.mint, balance: ataInfo.value.uiAmountString });
                const actualAmount = Number(ataInfo.value.uiAmount ?? 0);
                const position = this.positions.get(token.mint);
                if (position && actualAmount > 0) {
                  position.amount = actualAmount;
                  position.tokenDecimals = ataInfo.value.decimals;
                  this.confirmedPositions.add(token.mint);
                  if (sharedConfirmed) sharedConfirmed.value = true;
                  await this.savePositions();
                  logger.info(`✅ Position auto-confirmed from ATA for ${token.mint}: ${actualAmount} tokens (decimals=${ataInfo.value.decimals})`);
                  logEvent('POSITION_CONFIRMED_ATA', { mint: token.mint, actualAmount, decimals: ataInfo.value.decimals });

                  const pumpFunCfg = getStrategyForProtocol(position.protocol);
                  const actualEntryPrice = position.entryAmountSol / actualAmount;
                  position.entryPrice = actualEntryPrice;
                  tradeLog.open({
                    mint:           token.mint,
                    protocol:       position.protocol,
                    entryPrice:     actualEntryPrice,
                    amountSol:      position.entryAmountSol,
                    tokensReceived: actualAmount,
                    slippageBps:    pumpFunCfg.slippageBps,
                    jitoTipSol:     lastTipPaid,
                    txId,
                    openedAt:       position.openedAt,
                  });

                  this.scheduleSocialRetry(token.mint, position);

                  const socialScore = this.mintSocialScore.get(token.mint) ?? 0;
                  if (socialScore === 0 && !this.earlyExitTimers.has(token.mint) && !this.sellingMints.has(token.mint)) {
                    const earlyTimeout2 = config.strategy.earlyExitTimeoutMs;
                    const exitTimer = setTimeout(async () => {
                      logger.warn(`⏰ No independent buyer for ${token.mint.slice(0,8)} within ${earlyTimeout2}ms — exiting position`);
                      logEvent('EARLY_EXIT_TIMEOUT', { mint: token.mint, timeoutMs: earlyTimeout2 });
                      const pos = this.positions.get(token.mint);
                      if (pos && !this.sellingMints.has(token.mint)) {
                        await this.executeFullSell(pos, token.mint, { action: 'full', reason: 'early_exit', urgent: false });
                      }
                      this.earlyExitTimers.delete(token.mint);
                    }, earlyTimeout2);
                    this.earlyExitTimers.set(token.mint, exitTimer);
                    logger.info(`⏱️ Early exit timer started (${earlyTimeout2}ms) for ${token.mint.slice(0,8)}`);
                  }
                }
                return true;
              }
            } catch {
              // ATA не существует или ошибка RPC — продолжаем ресенд
            }
          }

          let creatorPubkey: PublicKey;
          let resendVSol = 0n, resendVToken = 0n;
          try {
            const curveInfo = await withRpcLimit(() => this.connection.getAccountInfo(bondingCurve, { commitment: 'processed' }));
            creatorPubkey = curveInfo && curveInfo.data.length >= BONDING_CURVE_LAYOUT.CREATOR_OFFSET + 32
              ? getCreatorFromCurveData(curveInfo.data)
              : new PublicKey(token.creator);
            if (curveInfo) {
              resendVSol   = curveInfo.data.readBigUInt64LE(BONDING_CURVE_LAYOUT.VIRTUAL_SOL_RESERVES_OFFSET);
              resendVToken = curveInfo.data.readBigUInt64LE(BONDING_CURVE_LAYOUT.VIRTUAL_TOKEN_RESERVES_OFFSET);
            }
          } catch {
            creatorPubkey = new PublicKey(token.creator);
          }

          const ata = await getAssociatedTokenAddress(mintPubkey, this.payer.publicKey, false, mintState.tokenProgramId);
          const buyIx = buildBuyInstructionFromCreate({
            mint:                 mintPubkey,
            bondingCurve,
            creator:              creatorPubkey,
            userAta:              ata,
            user:                 this.payer.publicKey,
            amountSol:            resendCfg.entryAmountSol,
            slippageBps:          resendCfg.slippageBps,
            virtualSolReserves:   resendVSol,
            virtualTokenReserves: resendVToken,
            feeRecipient:  isMayhem
              ? new PublicKey(MAYHEM_FEE_RECIPIENTS[Math.floor(Math.random() * MAYHEM_FEE_RECIPIENTS.length)])
              : this.feeRecipient!,
            eventAuthority:  this.eventAuthority,
            tokenProgramId:  mintState.tokenProgramId!,
            isMayhem,
          });
          const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
            this.payer.publicKey, ata, this.payer.publicKey, mintPubkey, mintState.tokenProgramId
          );
          const { blockhash } = await getCachedBlockhashWithHeight();
          const priorityFee = getCachedPriorityFee();
          const message = new TransactionMessage({
            payerKey: this.payer.publicKey,
            recentBlockhash: blockhash,
            instructions: [
              ComputeBudgetProgram.setComputeUnitLimit({ units: config.compute.unitLimit }),
              ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
              createAtaIx,
              buyIx,
            ],
          }).compileToV0Message();
          const tx = new VersionedTransaction(message);
          tx.sign([this.payer]);

          const newTxId = await queueJitoSend(
            async () => tx,
            this.payer,
            0,
            true,
            tipMultiplier
          );

          txId = newTxId;
          logEvent('BUNDLE_RESENT', { mint: token.mint, newTxId, tipMultiplier });
          return false;
        });

        if (shouldReturn) return;

      } catch (err) {
        logger.debug(`Attempt ${attempt+1} to confirm ${token.mint} failed:`, err);
      }
    }

    logger.warn(`Failed to confirm transaction for ${token.mint} after ${maxAttempts} attempts.`);
    logEvent('CONFIRM_FAILED', { mint: token.mint, txId, attempts: maxAttempts });
  }

  private async createPositionFromTxInfo(token: PumpToken, txInfo: any, txId: string) {
    const postBalance = txInfo.meta.postTokenBalances?.find(
      (b: TokenBalance) => b.owner === this.payer.publicKey.toBase58() && b.mint === token.mint
    );
    if (!postBalance) return;
    const actualAmount = Number(postBalance.uiTokenAmount.uiAmount ?? 0);
    const decimals = postBalance.uiTokenAmount.decimals;
    if (actualAmount === 0) return;

    const pumpFunCfg  = getStrategyForProtocol('pump.fun');
    const entryPrice  = pumpFunCfg.entryAmountSol / actualAmount;
    const position = new Position(
      new PublicKey(token.mint),
      entryPrice,
      actualAmount,
      { programId: PUMP_PROGRAM_ID.toBase58(), quoteMint: token.mint },
      decimals,
      {
        entryAmountSol:   pumpFunCfg.entryAmountSol,
        protocol:         'pump.fun',
        feeRecipientUsed: this.feeRecipient?.toBase58(),
      }
    );
    this.positions.set(token.mint, position);
    this.emitPositionOpen(position);
    await this.savePositions();
    logger.info(`📈 Position recreated from tx: ${actualAmount} tokens at ${entryPrice} SOL`);
    logEvent('POSITION_RECREATED', { mint: token.mint, txId, amount: actualAmount, price: entryPrice });

    tradeLog.open({
      mint:           token.mint,
      protocol:       'pump.fun',
      entryPrice,
      amountSol:      pumpFunCfg.entryAmountSol,
      tokensReceived: actualAmount,
      slippageBps:    pumpFunCfg.slippageBps,
      jitoTipSol:     lastTipPaid,
      txId,
      openedAt:       position.openedAt,
    });

    this.subscribeToPositionAccount(position);
  }

  private async confirmAndUpdatePositionBurst(token: PumpToken, burstResults: BurstResult[]) {
    const confirmed = { value: false };
    for (const result of burstResults) {
      if (confirmed.value) return;
      try {
        await this.confirmAndUpdatePosition(token, result.signature, confirmed);
      } catch (err) {
        logger.debug(`Burst confirm failed for sig ${result.signature.slice(0,8)}: ${err}`);
      }
    }

    if (!confirmed.value) {
      logger.warn(`All ${burstResults.length} burst bundles failed to confirm for ${token.mint}`);
      // Orphan cleanup: if position was created optimistically but ATA is still empty,
      // the buy never landed — remove the ghost position to avoid 0-SOL sell triggers.
      const orphanPosition = this.positions.get(token.mint);
      if (orphanPosition && !this.confirmedPositions.has(token.mint)) {
        try {
          const mintPk = new PublicKey(token.mint);
          const mintState = getMintState(mintPk);
          if (mintState.tokenProgramId) {
            const ata = await getAssociatedTokenAddress(mintPk, this.payer.publicKey, false, mintState.tokenProgramId);
            const bal = await withRpcLimit(() => this.connection.getTokenAccountBalance(ata));
            if (!bal?.value || BigInt(bal.value.amount) === 0n) {
              logger.warn(`Mayhem orphan cleanup: ${token.mint.slice(0,8)} — ATA empty, removing ghost position`);
              this.unsubscribeFromPositionAccount(orphanPosition);
              this.positions.delete(token.mint);
              this.copyTradeMints.delete(token.mint);
              logEvent('ORPHAN_POSITION_CLEANED', { mint: token.mint, reason: 'all_burst_failed_ata_empty' });
              await this.savePositions();
            } else {
              // Buy landed despite "Invalid" status — ATA restore will handle confirmation
              logger.info(`All burst bundles "Invalid" but ATA has tokens for ${token.mint.slice(0,8)} — buy landed (Jito false negative)`);
            }
          }
        } catch (e) {
          logger.debug(`Orphan ATA check failed for ${token.mint.slice(0,8)}: ${e}`);
        }
      }
    }
  }

  private async onNewPumpSwapToken(token: PumpSwapNewPool) {
    if (!this.running) return;

    // F7: Blacklist check
    if (this.isBlacklisted(token.mint, token.creator)) {
      logger.debug(`Blacklisted PumpSwap token/creator, skip ${token.mint.slice(0,8)}`);
      return;
    }

    const hasOpenPosition = this.positions.has(token.mint);

    const alreadySeenSwap = await this.seenMutex.runExclusive(() => {
      if (this.seenMints.has(token.mint) && !hasOpenPosition) return true;
      this.seenMints.set(token.mint, Date.now());
      return false;
    });
    if (alreadySeenSwap) return;

    dossier.recordSeen(token.mint, 'pumpswap_new_pool', { creator: token.creator });
    dossier.recordProtocol(token.mint, {
      protocol: 'pumpswap',
      poolPda: (token as any).pool,
      poolQuoteMint: token.quoteMint,
    });

    logger.info(`🔥 NEW PUMP SWAP TOKEN DETECTED: ${token.mint}`);
    logEvent('CREATE_POOL', { mint: token.mint, creator: token.creator, quoteMint: token.quoteMint });

    // #7: Record pool first seen time for age gate
    if (token.pool) recordPoolSeen(token.pool);

    const mintPubkey = new PublicKey(token.mint);
    // Используем реальный адрес пула из события create_pool (accounts[0])
    // вместо вычисленного PDA — PDA может не совпасть для нестандартных пулов
    const poolAddr = token.pool
      ? new PublicKey(token.pool)
      : getPoolPDA(mintPubkey);

    try {
      const poolAcc = await withRpcLimit(() => this.connection.getAccountInfo(poolAddr));
      if (poolAcc) {
        const poolState = parsePoolAccount(poolAcc.data);
        const isMemeBase = poolState.baseMint.equals(mintPubkey);
        updateMintState(mintPubkey, {
          creator: new PublicKey(token.creator),
          pool: poolAddr,
          isPumpSwap: true,
          poolBaseTokenAccount: poolState.poolBaseTokenAccount,
          poolQuoteTokenAccount: poolState.poolQuoteTokenAccount,
          isMemeBase,
        });
      } else {
        updateMintState(mintPubkey, {
          creator: new PublicKey(token.creator),
          pool: poolAddr,
          isPumpSwap: true,
        });
      }
    } catch (err) {
      logger.warn(`Failed to parse pool account for ${token.mint}`);
      updateMintState(mintPubkey, {
        creator: new PublicKey(token.creator),
        pool: poolAddr,
        isPumpSwap: true,
      });
    }

    if (hasOpenPosition) {
      logger.warn(`⚡ MIGRATION: ${token.mint}... pump.fun → PumpSwap`);
      logEvent('MIGRATION', { mint: token.mint });
      const openPos = this.positions.get(token.mint);
      if (openPos) {
        openPos.migrateToSwap();
        this.unsubscribeFromPositionAccount(openPos);
        this.subscribeToPositionAccount(openPos);
      }
      return;
    }

    // ── Watchlist check ──
    const plMintPs    = this.preLaunchWatcher.matchMint(token.mint);
    const plCreatorPs = !plMintPs ? this.preLaunchWatcher.matchCreator(token.creator) : null;
    const plMatchPs   = plMintPs ?? plCreatorPs;

    if (plMatchPs) {
      logger.info(`🎯 PRE-LAUNCH HIT (PumpSwap): ${token.mint.slice(0, 8)} ticker=${plMatchPs.ticker ?? '-'} matched_by=${plMintPs ? 'mint' : 'creator'}`);
      logEvent('PRELAUNCH_HIT', { mint: token.mint, creator: token.creator, id: plMatchPs.id, ticker: plMatchPs.ticker, matchedBy: plMintPs ? 'mint' : 'creator', protocol: 'pumpswap' });
      this.preLaunchWatcher.markFired(plMatchPs.id, token.mint);

      if (this.positions.size < config.strategy.maxPositions &&
          this.pumpSwapCount < config.strategy.maxPumpSwapPositions) {
        const plPsCfg = getStrategyForProtocol('pumpswap');
        const plPsExposure = [...this.positions.values()].reduce((s, p) => s + p.entryAmountSol, 0);
        if (plPsExposure < config.strategy.maxTotalExposureSol) {
          if (config.strategy.enableRugcheck) {
            const plPsRug = await checkRugcheck(token.mint).catch(() => null);
            if (plPsRug?.risk === 'high') {
              logEvent('PRELAUNCH_SKIP_RUGCHECK', { mint: token.mint, score: plPsRug.score, protocol: 'pumpswap' });
              return;
            }
          }
          try {
            const txId = await buyTokenPumpSwap(this.connection, mintPubkey, this.payer, plPsCfg.entryAmountSol, plPsCfg.slippageBps);
            logEvent('PRELAUNCH_BUY_SENT', { mint: token.mint, protocol: 'pumpswap', txId });
            await this.createOptimisticPumpSwapPosition(mintPubkey, txId, plPsCfg.entryAmountSol);
            this.confirmAndUpdatePumpSwapPosition(mintPubkey, txId).catch(() => {});
          } catch (err) {
            logger.error(`[prelaunch-pumpswap] Buy failed for ${token.mint.slice(0, 8)}:`, err);
          }
          return;
        }
      }
    }

    if (config.strategy.pumpSwapInstantEntry) {
      if (this.positions.size >= config.strategy.maxPositions) return;
      if (this.pumpSwapCount >= config.strategy.maxPumpSwapPositions) return;
      if (this.failedSellMints.has(token.mint)) return;
      if (await this.isTipTooExpensive()) return;
      const totalExposureSwap = [...this.positions.values()].reduce((s, p) => s + p.entryAmountSol, 0);
      if (totalExposureSwap >= config.strategy.maxTotalExposureSol) {
        logger.warn(`PumpSwap instant: exposure ${totalExposureSwap.toFixed(3)} SOL >= limit, skip ${token.mint.slice(0,8)}`);
        return;
      }

      const state = getMintState(mintPubkey);
      if (!state.poolBaseTokenAccount || !state.poolQuoteTokenAccount) {
        logger.debug(`PumpSwap instant entry: pool accounts not yet cached for ${token.mint}`);
        return;
      }

      // ── Параллельная проверка баланса + rugcheck ──
      const psCfg = getStrategyForProtocol('pumpswap');
      const psMinRequired = psCfg.entryAmountSol + config.jito.tipAmountSol * 2 + 0.002;

      const [psBalance, rugResult] = await Promise.all([
        this.getCachedBalance(),
        config.strategy.enableRugcheck
          ? checkRugcheck(token.mint).catch(() => null)
          : Promise.resolve(null),
      ]);

      if (psBalance / 1e9 < psMinRequired) {
        logger.warn(`🚫 PumpSwap instant: insufficient balance ${(psBalance/1e9).toFixed(4)} SOL < ${psMinRequired.toFixed(4)} required`);
        logEvent('BUY_SKIPPED_BALANCE', { mint: token.mint, balance: psBalance/1e9, required: psMinRequired, path: 'pumpswap_instant' });
        return;
      }
      if (rugResult && rugResult.risk === 'high') {
        logger.warn(`🛑 PumpSwap Rugcheck HIGH RISK — BLOCKING ENTRY: ${token.mint.slice(0,8)} score=${rugResult.score}`);
        logEvent('RUGCHECK_BLOCKED', { mint: token.mint, score: rugResult.score, risks: rugResult.risks, path: 'pumpswap_instant' });
        return;
      }

      // ── CRITICAL: Проверка ликвидности пула перед instant entry ──
      // Из логов: 12/13 PumpSwap trades ушли в -100% за 1.2 сек, entry_price=0.0000021
      // vs real price=1.07 → honeypot / имбаланс резервов. Блокируем если пул имеет
      // недостаточно quote (SOL) liquidity или token reserve:quote ratio > 1000:1.
      try {
        const [baseAcc, quoteAcc] = await Promise.all([
          withRpcLimit(() => this.connection.getTokenAccountBalance(state.poolBaseTokenAccount!)),
          withRpcLimit(() => this.connection.getTokenAccountBalance(state.poolQuoteTokenAccount!)),
        ]);
        const quoteReserveSol = Number(quoteAcc?.value?.uiAmount ?? 0);
        const baseReserve = Number(baseAcc?.value?.uiAmount ?? 0);
        const ratio = baseReserve > 0 && quoteReserveSol > 0 ? baseReserve / quoteReserveSol : Infinity;
        const psMinLiquidity = config.strategy.pumpSwap.minLiquiditySol;
        if (quoteReserveSol < psMinLiquidity) {
          logger.warn(`🚫 PumpSwap instant: pool SOL reserve ${quoteReserveSol.toFixed(3)} < ${psMinLiquidity} min`);
          logEvent('BUY_SKIPPED_LOW_LIQUIDITY', { mint: token.mint, quoteReserveSol, baseReserve, path: 'pumpswap_instant' });
          return;
        }
        if (ratio > 1_000_000) {
          logger.warn(`🚫 PumpSwap instant: imbalanced pool ratio ${ratio.toFixed(0)} — likely honeypot`);
          logEvent('BUY_SKIPPED_HONEYPOT', { mint: token.mint, quoteReserveSol, baseReserve, ratio, path: 'pumpswap_instant' });
          return;
        }
      } catch (e) {
        logger.warn(`PumpSwap instant: pool reserve check failed for ${token.mint.slice(0, 8)}: ${e}`);
        logEvent('BUY_SKIPPED_RESERVE_CHECK', { mint: token.mint, path: 'pumpswap_instant' });
        return;
      }

      // #7: Pool age gate
      const poolAgeGateCfg = (config.strategy as any).poolAgeGate;
      if (poolAgeGateCfg?.enabled && token.pool) {
        const quoteReserveSolForAge = 0; // will be re-checked below; use volume from trend if available
        const trendM = this.trendTracker.getMetrics(token.mint);
        const currentVol = trendM?.buyVolumeSol ?? 0;
        if (shouldWaitForPool(token.pool, poolAgeGateCfg.minAgeMs ?? 30_000, poolAgeGateCfg.minVolumeSol ?? 0.3, currentVol)) {
          logger.debug(`[pumpswap] Pool too young for ${token.mint.slice(0, 8)}, deferring to trend`);
          logEvent('POOL_AGE_GATE', { mint: token.mint, pool: token.pool });
          // Don't return — let it fall through to trend-confirmed path instead of instant entry
          if (config.trend.enabled) {
            this.trendTracker.track(token.mint, 'pumpswap');
            this.trendTokenData.set(token.mint, { mint: token.mint, creator: token.creator, bondingCurve: '', bondingCurveTokenAccount: '', signature: (token as any).signature ?? '' } as any);
            return;
          }
        }
      }

      logger.info(`⚡ PumpSwap INSTANT ENTRY: ${token.mint}`);
      logEvent('PUMP_SWAP_INSTANT_ENTRY', { mint: token.mint });

      const pumpSwapCfg = getStrategyForProtocol('pumpswap');
      try {
        const txId = await buyTokenPumpSwap(
          this.connection,
          mintPubkey,
          this.payer,
          pumpSwapCfg.entryAmountSol,
          pumpSwapCfg.slippageBps
        );
        logger.info(`🟢 PumpSwap instant buy sent: ${txId}`);
        logEvent('PUMP_SWAP_BUY_SENT', { mint: token.mint, txId });
        await this.createOptimisticPumpSwapPosition(mintPubkey, txId);
        this.confirmAndUpdatePumpSwapPosition(mintPubkey, txId)
          .catch(err => logger.error(`PumpSwap instant confirm error:`, err));
      } catch (err) {
        logger.error(`PumpSwap instant entry failed for ${token.mint}:`, err);
      }
    }
  }

  private async onPumpSwapBuyDetected(buy: PumpSwapBuy) {
    if (!this.running) return;

    // v3: записываем PumpSwap buy для wallet tracker
    const psBuyer = buy.creator;
    if (psBuyer !== this.payer.publicKey.toBase58()) {
      this.walletTracker.recordBuy(psBuyer, buy.mint, Number(buy.solLamports ?? 0));
      // Dead volume: обновляем lastBuyActivityTs
      const dvPsPos = this.positions.get(buy.mint);
      if (dvPsPos) dvPsPos.lastBuyActivityTs = Date.now();
      // Trend tracker: forward PumpSwap buy events
      if (config.trend.enabled) {
        this.trendTracker.recordBuy(buy.mint, psBuyer, Number(buy.solLamports ?? 0) / 1e9);
        if ((buy as any).slot) recordBuyInSlot(buy.mint, (buy as any).slot, psBuyer, Number(buy.solLamports ?? 0) / 1e9);
      }

      // ── Copy-trade for PumpSwap ──
      const psCt = config.strategy.copyTrade.enabled &&
          !this.positions.has(buy.mint) && !this.pendingBuys.has(buy.mint) &&
          !this.copyTradeMints.has(buy.mint) && !this.sellingMints.has(buy.mint) &&
          !this.seenMints.has(buy.mint) &&
          !this.pumpSwapBuyBlockedMints.has(buy.mint) &&
          !this.failedSellMints.has(buy.mint) &&
          this.positions.size < config.strategy.maxPositions &&
          this.pumpSwapCount < config.strategy.maxPumpSwapPositions
          ? this.walletTracker.isCopySignal(psBuyer, Number(buy.solLamports ?? 0))
          : { signal: false as const };

      if (psCt.signal) {
        const psCfg = getStrategyForProtocol('pumpswap');
        const psCtEntry = psCt.tier === 1
          ? config.strategy.copyTrade.entryAmountSol
          : ((config.strategy.copyTrade as any).tier2EntryAmountSol ?? config.strategy.copyTrade.entryAmountSol * 0.5);
        if (psCtEntry <= 0) {
          logger.debug(`CT PumpSwap skip: tier ${psCt.tier} entry amount is 0 (disabled)`);
        } else {
        const psCtExposure = [...this.positions.values()].reduce((s, p) => s + p.entryAmountSol, 0);
        if (psCtExposure + psCtEntry <= config.strategy.maxTotalExposureSol) {
          const psCtRug = config.strategy.enableRugcheck
            ? await checkRugcheck(buy.mint).catch(() => null)
            : null;
          if (!psCtRug || psCtRug.risk !== 'high') {
            logger.info(`🎯 COPY-TRADE PumpSwap T${psCt.tier}: ${psBuyer.slice(0,8)} bought ${buy.mint.slice(0,8)} — entry=${psCtEntry}`);
            logEvent('COPY_TRADE_EXEC', { mint: buy.mint, buyer: psBuyer.slice(0,8), tier: psCt.tier, entryAmount: psCtEntry, protocol: 'pumpswap' });
            this.copyTradeMints.add(buy.mint);
            try {
              const psCtMintPub = new PublicKey(buy.mint);
              const txId = await buyTokenPumpSwap(this.connection, psCtMintPub, this.payer, psCtEntry, psCfg.slippageBps);
              this.pumpSwapBuyBlockedMints.set(buy.mint, Date.now());
              await this.createOptimisticPumpSwapPosition(psCtMintPub, txId, psCtEntry);
              this.confirmAndUpdatePumpSwapPosition(psCtMintPub, txId).catch(err =>
                logger.error(`[CT-PumpSwap] Confirm error for ${buy.mint}:`, err)
              );
            } catch (err) {
              logger.error(`[CT-PumpSwap] Buy failed for ${buy.mint}:`, err);
              this.copyTradeMints.delete(buy.mint);
            }
            return;
          }
        }
        }
      }
    }

    if (this.positions.size >= config.strategy.maxPositions) return;
    if (this.pumpSwapCount >= config.strategy.maxPumpSwapPositions) return;
    if (this.positions.has(buy.mint)) return;
    if (this.pumpSwapBuyBlockedMints.has(buy.mint)) return;
    if (this.failedSellMints.has(buy.mint)) return;

    if (await this.isTipTooExpensive()) return;

    const totalExposurePswap = [...this.positions.values()].reduce((s, p) => s + p.entryAmountSol, 0);
    if (totalExposurePswap >= config.strategy.maxTotalExposureSol) {
      logger.warn(`PumpSwap buy: exposure ${totalExposurePswap.toFixed(3)} SOL >= limit, skip ${buy.mint.slice(0,8)}`);
      return;
    }

    if (!this.seenMints.has(buy.mint)) {
      // Recovery: fetch pool info for mints created before bot started
      if (!this.pumpSwapRecoveryAttempted.has(buy.mint)) {
        this.pumpSwapRecoveryAttempted.add(buy.mint);
        this.recoverPumpSwapMint(buy.mint).catch(() => {});
      }
      return;
    }

    const mintPubkey = new PublicKey(buy.mint);
    const state = getMintState(mintPubkey);

    if (!state.isPumpSwap) {
      logger.warn(`Mint ${buy.mint} is not a PumpSwap token, ignoring`);
      return;
    }

    // ── Параллельная проверка safety + rugcheck ──
    const [safetyResult, rugResult] = await Promise.all([
      Promise.race([
        isTokenSafeCached(this.connection, mintPubkey),
        new Promise<{ safe: false; reason: string }>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 2500)
        ),
      ]).catch(async () => {
        try {
          return await isTokenSafeCached(this.connection, mintPubkey);
        } catch {
          return { safe: false as const, reason: 'timeout after retry' };
        }
      }),
      config.strategy.enableRugcheck
        ? checkRugcheck(buy.mint).catch(() => null)
        : Promise.resolve(null),
    ]);

    if (!safetyResult.safe) {
      logger.warn(`❌ Skip ${buy.mint}: ${safetyResult.reason}`);
      return;
    }
    if (rugResult && rugResult.risk === 'high') {
      logger.warn(`🛑 PumpSwap Rugcheck HIGH RISK — BLOCKING: ${buy.mint.slice(0,8)} score=${rugResult.score}`);
      logEvent('RUGCHECK_BLOCKED', { mint: buy.mint, score: rugResult.score, risks: rugResult.risks, path: 'pumpswap_buy_detected' });
      this.pumpSwapBuyBlockedMints.set(buy.mint, Date.now());
      return;
    }

    // Trend mode: don't buy on first detected buy — let TrendTracker accumulate
    if (config.trend.enabled) {
      if (!this.trendTracker.isTracking(buy.mint)) {
        this.trendTracker.track(buy.mint, 'pumpswap');
        logger.info(`📊 TREND TRACKING (PumpSwap): ${buy.mint.slice(0, 8)} — waiting for trend confirmation`);
        logEvent('TREND_TRACKING', { mint: buy.mint, protocol: 'pumpswap', mode: 'B' });
      }
      return;
    }

    // Legacy path (trend disabled): immediate buy

    try {
      const pumpSwapCfg = getStrategyForProtocol('pumpswap');
      const txId = await buyTokenPumpSwap(
        this.connection,
        mintPubkey,
        this.payer,
        pumpSwapCfg.entryAmountSol,
        pumpSwapCfg.slippageBps
      );
      logger.info('🟢 PUMP SWAP BUY SUCCESS:', txId);
      logEvent('PUMP_SWAP_BUY_SENT', { mint: buy.mint, txId });

      // Prevent re-entry: once we've bought via detected event, block future buys
      // for this mint regardless of position state (guards against re-buying after close)
      this.pumpSwapBuyBlockedMints.set(buy.mint, Date.now());

      await this.createOptimisticPumpSwapPosition(mintPubkey, txId);

      this.confirmAndUpdatePumpSwapPosition(mintPubkey, txId).catch(err =>
        logger.error(`Background confirm error for PumpSwap ${buy.mint}:`, err)
      );

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('Trade too large')) {
        this.pumpSwapBuyBlockedMints.set(buy.mint, Date.now());
        logger.warn(`PumpSwap reserve-blocked ${buy.mint.slice(0,8)} — will not retry`);
      } else {
        logger.error('PumpSwap buy failed:', error);
      }
      logEvent('PUMP_SWAP_BUY_FAIL', { mint: buy.mint, error: msg });
    }
  }

  private async createOptimisticPumpSwapPosition(mint: PublicKey, txId: string, overrideEntryAmountSol?: number) {
    try {
      const state = getMintState(mint);
      if (!state.poolBaseTokenAccount || !state.poolQuoteTokenAccount) {
        logger.warn(`Cannot create optimistic PumpSwap position for ${mint.toBase58()}: pool accounts not cached`);
        return;
      }

      const [baseBalance, quoteBalance] = await Promise.all([
        withRpcLimit(() => this.connection.getTokenAccountBalance(state.poolBaseTokenAccount!)),
        withRpcLimit(() => this.connection.getTokenAccountBalance(state.poolQuoteTokenAccount!)),
      ]);
      let isMemeBase = state.isMemeBase !== false;
      // Validate isMemeBase: if base has 9 decimals (wSOL) and quote has 6, base is SOL not meme
      if (isMemeBase && baseBalance.value.decimals === 9 && quoteBalance.value.decimals === 6) {
        isMemeBase = false;
        updateMintState(mint, { isMemeBase: false });
        logger.warn(`[pumpswap] Corrected isMemeBase=false for ${mint.toBase58().slice(0,8)} (base=9dec, quote=6dec)`);
      } else if (!isMemeBase && quoteBalance.value.decimals === 9 && baseBalance.value.decimals === 6) {
        isMemeBase = true;
        updateMintState(mint, { isMemeBase: true });
        logger.warn(`[pumpswap] Corrected isMemeBase=true for ${mint.toBase58().slice(0,8)} (quote=9dec, base=6dec)`);
      }
      const tokenReserve = BigInt(isMemeBase ? baseBalance.value.amount : quoteBalance.value.amount);
      const solReserve   = BigInt(isMemeBase ? quoteBalance.value.amount : baseBalance.value.amount);
      const decimals     = isMemeBase ? baseBalance.value.decimals : quoteBalance.value.decimals;

      const pumpSwapCfg      = getStrategyForProtocol('pumpswap');
      const entryAmountSol   = overrideEntryAmountSol ?? pumpSwapCfg.entryAmountSol;
      const amountInLamports = BigInt(Math.floor(entryAmountSol * 1e9));
      const expectedTokens   = safeNumber((amountInLamports * tokenReserve) / solReserve, 'expectedTokensRaw') / Math.pow(10, decimals);
      const entryPrice       = entryAmountSol / expectedTokens;

      const position = new Position(
        mint,
        entryPrice,
        expectedTokens,
        { programId: PUMP_SWAP_PROGRAM_ID, quoteMint: config.wsolMint },
        decimals,
        {
          entryAmountSol:   entryAmountSol,
          protocol:         'pumpswap',
          feeRecipientUsed: undefined,
        }
      );

      this.positions.set(mint.toBase58(), position);
      this.emitPositionOpen(position);
      this.assignTokenScore(position, mint.toBase58());
      await this.savePositions();
      logger.info(`📈 Optimistic PumpSwap position opened: ${expectedTokens} tokens at ${entryPrice} SOL (tx: ${txId})`);
      logEvent('OPTIMISTIC_PUMP_SWAP_POSITION', { mint: mint.toBase58(), txId, expectedTokens, entryPrice });

      this.subscribeToPositionAccount(position);

      const timeout = setTimeout(async () => {
        const mintStr = mint.toBase58();
        if (this.positions.has(mintStr) && !this.confirmedPositions.has(mintStr)) {
          // FIX: Check ATA balance before deleting — tokens may exist despite confirm timeout
          try {
            const mintState = getMintState(mint);
            if (mintState.tokenProgramId) {
              const ata = await getAssociatedTokenAddress(mint, this.payer.publicKey, false, mintState.tokenProgramId);
              const bal = await withRpcLimit(() => this.connection.getTokenAccountBalance(ata));
              if (bal?.value && BigInt(bal.value.amount) > 0n) {
                logger.warn(`🔄 Optimistic PumpSwap timeout for ${mintStr.slice(0,8)} but ATA has ${bal.value.uiAmountString} tokens — restoring as confirmed`);
                logEvent('OPTIMISTIC_PUMP_SWAP_TIMEOUT_ATA_RESTORE', { mint: mintStr, balance: bal.value.uiAmountString });
                position.amount = Number(bal.value.uiAmount ?? 0);
                position.tokenDecimals = bal.value.decimals;
                this.confirmedPositions.add(mintStr);
                await this.savePositions();
                this.optimisticTimeouts.delete(mintStr);
                return;
              }
            }
          } catch (e) {
            logger.debug(`ATA check failed during optimistic PumpSwap timeout for ${mintStr.slice(0,8)}: ${e}`);
          }
          logger.warn(`Optimistic PumpSwap position for ${mintStr} timed out, removing`);
          this.unsubscribeFromPositionAccount(position);
          this.positions.delete(mintStr);
          this.seenMints.set(mintStr, Date.now());
          this.copyTradeMints.delete(mintStr);
          this.savePositions().catch(e => logger.error('Failed to save after timeout:', e));
          logEvent('OPTIMISTIC_PUMP_SWAP_TIMEOUT', { mint: mintStr });
        }
        this.optimisticTimeouts.delete(mint.toBase58());
      }, config.timeouts.optimisticPositionTtlMs);
      this.optimisticTimeouts.set(mint.toBase58(), timeout);

    } catch (err) {
      logger.error(`Failed to create optimistic PumpSwap position for ${mint.toBase58()}:`, err);
    }
  }

  // ── Raydium Buy Confirmation ────────────────────────────────────────────────
  // Ждёт подтверждения Jito-бандла, затем читает ATA-баланс и создаёт Position
  // с корректным entryPrice и количеством токенов. Без этого позиция создавалась
  // с entryPrice = entryAmountSol и amount = 0, что вызывало мгновенный stop_loss.
  private async confirmAndCreateRaydiumPosition(
    mint: PublicKey,
    txId: string,
    entryAmountSol: number,
    protocol: 'raydium-cpmm' | 'raydium-ammv4' | 'raydium-launch',
    isScalp = false,
  ): Promise<void> {
    const mintStr = mint.toBase58();
    const maxAttempts = 15;
    const pollInterval = 2000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(r => setTimeout(r, pollInterval));
      if (!this.running) {
        this.pendingRaydiumBuys.delete(mintStr);
        return;
      }

      try {
        const status = await withRpcLimit(() => this.connection.getSignatureStatus(txId));
        if (!status?.value) continue;

        if (status.value.err) {
          logger.warn(`[raydium-confirm] TX failed for ${mintStr.slice(0, 8)}: ${JSON.stringify(status.value.err)}`);
          this.pendingRaydiumBuys.delete(mintStr);
          this.seenMints.set(mintStr, Date.now());
          logEvent('RAYDIUM_BUY_TX_FAILED', { mint: mintStr, protocol, txId, err: JSON.stringify(status.value.err) });
          return;
        }

        const cs = status.value.confirmationStatus;
        if (cs !== 'confirmed' && cs !== 'finalized') continue;

        const tokenProgramId = getMintState(mint).tokenProgramId ?? TOKEN_PROGRAM_ID;
        const ata = getAssociatedTokenAddressSync(mint, this.payer.publicKey, false, tokenProgramId);
        const bal = await withRpcLimit(() => this.connection.getTokenAccountBalance(ata));

        if (!bal?.value || BigInt(bal.value.amount) === 0n) {
          logger.warn(`[raydium-confirm] ${mintStr.slice(0, 8)} confirmed but ATA empty`);
          this.pendingRaydiumBuys.delete(mintStr);
          this.seenMints.set(mintStr, Date.now());
          logEvent('RAYDIUM_BUY_CONFIRMED_NO_TOKENS', { mint: mintStr, protocol, txId });
          return;
        }

        const decimals = bal.value.decimals;
        const rawAmount = BigInt(bal.value.amount);
        // CRITICAL FIX: uiAmount может округлиться до 0 при большой decimals precision,
        // тогда как raw amount > 0 (есть токены). Считаем точно из raw / 10^decimals.
        let tokenAmount = Number(bal.value.uiAmount ?? 0);
        if (tokenAmount === 0 && rawAmount > 0n) {
          tokenAmount = Number(rawAmount) / Math.pow(10, decimals);
          logger.warn(`[raydium-confirm] uiAmount=0 but raw=${rawAmount} → using ${tokenAmount}`);
        }
        if (tokenAmount === 0) {
          this.pendingRaydiumBuys.delete(mintStr);
          this.seenMints.set(mintStr, Date.now());
          return;
        }
        const entryPrice = entryAmountSol / tokenAmount;

        const pos = new Position(
          mint, entryPrice, tokenAmount,
          { programId: protocol, quoteMint: config.wsolMint },
          decimals,
          { entryAmountSol, protocol, isScalp },
        );
        this.positions.set(mintStr, pos);
        this.confirmedPositions.add(mintStr);
        this.subscribeToPositionAccount(pos);
        this.emitPositionOpen(pos);
        this.assignTokenScore(pos, mintStr);
        await this.savePositions();

        this.pendingRaydiumBuys.delete(mintStr);
        logger.info(
          `📈 Raydium ${protocol}${isScalp ? ' SCALP' : ''} position confirmed: ` +
          `${tokenAmount.toFixed(0)} tokens at ${entryPrice.toExponential(4)} SOL/token ` +
          `(tx: ${txId.slice(0, 8)})`
        );
        logEvent('RAYDIUM_POSITION_CONFIRMED', { mint: mintStr, protocol, txId, tokenAmount, entryPrice, attempt: attempt + 1, isScalp });
        return;
      } catch (err) {
        logger.debug(`[raydium-confirm] Poll attempt ${attempt + 1} for ${mintStr.slice(0, 8)}: ${err}`);
      }
    }

    // Timeout — проверяем ATA как последний шанс
    try {
      const tokenProgramId = getMintState(mint).tokenProgramId ?? TOKEN_PROGRAM_ID;
      const ata = getAssociatedTokenAddressSync(mint, this.payer.publicKey, false, tokenProgramId);
      const bal = await withRpcLimit(() => this.connection.getTokenAccountBalance(ata));

      if (bal?.value && BigInt(bal.value.amount) > 0n) {
        const decimals = bal.value.decimals;
        const tokenAmount = Number(bal.value.uiAmount ?? 0);
        if (tokenAmount > 0) {
          const entryPrice = entryAmountSol / tokenAmount;
          const pos = new Position(
            mint, entryPrice, tokenAmount,
            { programId: protocol, quoteMint: config.wsolMint },
            decimals,
            { entryAmountSol, protocol, isScalp },
          );
          this.positions.set(mintStr, pos);
          this.confirmedPositions.add(mintStr);
          this.subscribeToPositionAccount(pos);
          this.emitPositionOpen(pos);
          await this.savePositions();

          logger.warn(
            `🔄 Raydium ${protocol}${isScalp ? ' SCALP' : ''} timeout but ATA has ${tokenAmount} tokens — position restored (tx: ${txId.slice(0, 8)})`
          );
          logEvent('RAYDIUM_POSITION_TIMEOUT_RESTORED', { mint: mintStr, protocol, tokenAmount, entryPrice, isScalp });
          this.pendingRaydiumBuys.delete(mintStr);
          return;
        }
      }
    } catch (err) {
      logger.error(`[raydium-confirm] Final ATA check failed for ${mintStr.slice(0, 8)}:`, err);
    }

    logger.warn(`[raydium-confirm] ${mintStr.slice(0, 8)} timed out, no tokens — buy likely failed`);
    logEvent('RAYDIUM_BUY_TIMEOUT_NO_TOKENS', { mint: mintStr, protocol, txId });
    this.pendingRaydiumBuys.delete(mintStr);
    this.seenMints.set(mintStr, Date.now());
  }

  // ── Jupiter Fallback Buy (unknown protocol) ────────────────────────────────
  // Вызывается из executePendingBuy когда detectProtocol вернул 'unknown'.
  // Покупает через Jupiter, создаёт позицию с протоколом 'pumpswap' (ближайший
  // generic тип). Продажа — через существующий 4-chain sell fallback (→ Jupiter).
  private async tryJupiterFallbackBuy(mintStr: string, mint: PublicKey): Promise<void> {
    const jfCfg = (config.strategy as any).jupiterFallback;
    if (!jfCfg?.enabled) return;

    if (this.positions.has(mintStr) || this.pendingBuys.has(mintStr)) return;
    if (this.positions.size >= config.strategy.maxPositions) {
      logger.debug(`[jupiter-buy] maxPositions reached, skip ${mintStr.slice(0, 8)}`);
      return;
    }
    const totalExp = [...this.positions.values()].reduce((s, p) => s + p.entryAmountSol, 0);
    if (totalExp + jfCfg.entryAmountSol > config.strategy.maxTotalExposureSol) {
      logger.debug(`[jupiter-buy] exposure limit, skip ${mintStr.slice(0, 8)}`);
      return;
    }
    const bal = (await this.getCachedBalance()) / 1e9;
    if (bal < jfCfg.entryAmountSol + config.jito.tipAmountSol * 2 + 0.002) {
      logger.warn(`[jupiter-buy] insufficient balance ${bal.toFixed(3)} SOL, skip ${mintStr.slice(0, 8)}`);
      return;
    }

    const solLamports = BigInt(Math.floor(jfCfg.entryAmountSol * 1e9));
    logEvent('JUPITER_FALLBACK_BUY_ATTEMPT', { mint: mintStr, entryAmountSol: jfCfg.entryAmountSol });

    let result: import('../trading/jupiter-buy').JupiterBuyResult;
    try {
      result = await buyTokenJupiter(this.connection, mintStr, this.payer, solLamports, jfCfg.slippageBps);
    } catch (err) {
      logger.warn(`[jupiter-buy] Failed for ${mintStr.slice(0, 8)}:`, err);
      logEvent('JUPITER_FALLBACK_BUY_FAILED', { mint: mintStr, error: String(err) });
      return;
    }

    // Оцениваем entryPrice из quote (decimals=6 — стандарт для мем-токенов).
    // При большом расхождении позиция всё равно закроется по timeStop.
    const ESTIMATED_DECIMALS = 6;
    const tokensHuman = Number(result.tokensOutRaw) / Math.pow(10, ESTIMATED_DECIMALS);
    const entryPrice  = jfCfg.entryAmountSol / tokensHuman;

    const position = new Position(
      mint,
      entryPrice,
      tokensHuman,
      { programId: PUMP_SWAP_PROGRAM_ID, quoteMint: config.wsolMint },
      ESTIMATED_DECIMALS,
      { entryAmountSol: jfCfg.entryAmountSol, protocol: 'pumpswap' }
    );

    this.positions.set(mintStr, position);
    this.emitPositionOpen(position);
    await this.savePositions();

    logger.info(
      `🪐 Jupiter fallback position: ${mintStr.slice(0, 8)} ` +
      `~${tokensHuman.toFixed(0)} tokens, entry ${jfCfg.entryAmountSol} SOL (tx: ${result.txId.slice(0, 8)})`
    );
    logEvent('JUPITER_FALLBACK_BUY_SUCCESS', {
      mint: mintStr, txId: result.txId,
      tokensHuman, entryPrice, entryAmountSol: jfCfg.entryAmountSol,
    });

    // Жёсткий time-stop: через timeStopMs продаём через sell chain (→ Jupiter).
    // Цена не мониторится — нет bonding curve / pool для этого токена.
    const exitTimer = setTimeout(async () => {
      this.earlyExitTimers.delete(mintStr);
      const pos = this.positions.get(mintStr);
      if (pos && !this.sellingMints.has(mintStr)) {
        logger.info(`⏰ Jupiter fallback time-stop: ${mintStr.slice(0, 8)} (${jfCfg.timeStopMs}ms elapsed)`);
        logEvent('JUPITER_FALLBACK_TIME_STOP', { mint: mintStr, timeStopMs: jfCfg.timeStopMs });
        await this.executeFullSell(pos, mintStr, { action: 'full', reason: 'time_stop', urgent: false });
      }
    }, jfCfg.timeStopMs);
    this.earlyExitTimers.set(mintStr, exitTimer);
  }

  private async confirmAndUpdatePumpSwapPosition(mint: PublicKey, txId: string) {
    const maxAttempts = config.jito.maxRetries;
    const RESEND_FROM_ATTEMPT = 2;
    const confirmInterval = config.timeouts.confirmIntervalMs;
    let tipMultiplier = 1.0;
    let invalidCount = 0;
    const MAX_INVALID_BEFORE_REMOVE = 2;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, confirmInterval));
      logEvent('CONFIRM_ATTEMPT', { mint: mint.toBase58(), attempt: attempt+1, txId, bundleId: getBundleId(txId) });

      let bundleStatus: string | undefined;

      try {
        const bundleId = getBundleId(txId);
        if (bundleId) {
          const statuses = await getInflightBundleStatuses([bundleId]);
          logger.debug(`Bundle statuses raw [PumpSwap ${mint.toBase58().slice(0,8)}]: ${JSON.stringify(statuses)}`);
          bundleStatus = statuses[0]?.status;
          logEvent('BUNDLE_STATUS', { mint: mint.toBase58(), bundleId, status: bundleStatus ?? 'undefined', txId });

          if (bundleStatus === 'Landed') {
            updateLandedStat(true);
            this.recordBundleResult(true);

            const txInfoSwap = await withRpcLimit(() => this.connection.getTransaction(txId, {
              commitment: 'confirmed',
              maxSupportedTransactionVersion: 0,
            }));

            const postBalance = txInfoSwap?.meta?.postTokenBalances?.find(
              (b: TokenBalance) => b.owner === this.payer.publicKey.toBase58() && b.mint === mint.toBase58()
            );

              if (postBalance) {
                const actualAmount = Number(postBalance.uiTokenAmount.uiAmount ?? 0);
                const decimals = postBalance.uiTokenAmount.decimals;
                if (actualAmount > 0) {
                  const position = this.positions.get(mint.toBase58());
                  const pumpSwapCfg = getStrategyForProtocol('pumpswap');
                  const entryPrice  = (position?.entryAmountSol ?? pumpSwapCfg.entryAmountSol) / actualAmount;
                  if (position) {
                    position.amount = actualAmount;
                    position.entryPrice = entryPrice;
                    position.tokenDecimals = decimals;
                    await this.savePositions();
                    logger.info(`📈 PumpSwap position confirmed: ${actualAmount} tokens at ${entryPrice} SOL, tx: ${txId}`);
                    logEvent('PUMP_SWAP_BUY_SUCCESS', { mint: mint.toBase58(), txId, amount: actualAmount, price: entryPrice });

                    const timeout = this.optimisticTimeouts.get(mint.toBase58());
                    if (timeout) {
                      clearTimeout(timeout);
                      this.optimisticTimeouts.delete(mint.toBase58());
                    }
                    this.confirmedPositions.add(mint.toBase58());
                    metrics.observe('buy_confirm_ms', Date.now() - position.openedAt);

                    tradeLog.open({
                      mint:           mint.toBase58(),
                      protocol:       'pumpswap',
                      entryPrice,
                      amountSol:      pumpSwapCfg.entryAmountSol,
                      tokensReceived: actualAmount,
                      slippageBps:    pumpSwapCfg.slippageBps,
                      jitoTipSol:     lastTipPaid,
                      txId,
                      openedAt:       position.openedAt,
                    });

                    this.scheduleSocialRetry(mint.toBase58(), position);
                  } else {
                    const newPosition = new Position(
                      mint,
                      entryPrice,
                      actualAmount,
                      { programId: PUMP_SWAP_PROGRAM_ID, quoteMint: config.wsolMint },
                      decimals,
                      {
                        entryAmountSol:   pumpSwapCfg.entryAmountSol,
                        protocol:         'pumpswap',
                        feeRecipientUsed: undefined,
                      }
                    );
                    this.positions.set(mint.toBase58(), newPosition);
                    this.emitPositionOpen(newPosition);
                    await this.savePositions();
                    logger.info(`📈 PumpSwap position created from confirmation: ${actualAmount} tokens at ${entryPrice} SOL`);
                    logEvent('PUMP_SWAP_BUY_SUCCESS', { mint: mint.toBase58(), txId, amount: actualAmount, price: entryPrice });
                    this.subscribeToPositionAccount(newPosition);
                  
                  return;
                }
              }
            }
          } else if (bundleStatus === 'Failed' || bundleStatus === 'Dropped') {
            logger.warn(`Bundle ${bundleStatus} for PumpSwap ${mint.toBase58()}, removing optimistic position.`);
            updateLandedStat(false);
            this.recordBundleResult(false);
            const position = this.positions.get(mint.toBase58());
            if (position) {
              this.emitTradeClose(position, mint.toBase58(), txId, 'bundle_failed', false, 0, Date.now(), 'jito');
              this.positions.delete(mint.toBase58());
              this.copyTradeMints.delete(mint.toBase58());
              await this.savePositions();
            }
            logEvent('PUMP_SWAP_BUY_FAIL', { mint: mint.toBase58(), txId, reason: `bundle_${bundleStatus}` });
            return;
          } else if (bundleStatus === 'Invalid') {
            invalidCount++;
            logger.warn(`Bundle Invalid for PumpSwap ${mint.toBase58()} attempt=${attempt+1} invalidCount=${invalidCount}`);
            logEvent('BUNDLE_INVALID', { mint: mint.toBase58(), bundleId, attempt: attempt+1, txId, invalidCount });
            this.recordBundleResult(false);
            if (invalidCount >= MAX_INVALID_BEFORE_REMOVE) {
              const mintStr = mint.toBase58();
              const landed = await this.checkTxLandedOnChain(txId, mintStr);
              if (landed) {
                const position = this.positions.get(mintStr);
                const recovered = await this.recoverLandedPosition(
                  mintStr, txId, 'pumpswap', position?.entryAmountSol ?? getStrategyForProtocol('pumpswap').entryAmountSol, lastTipPaid,
                );
                if (recovered) return;
                return; // landed but couldn't parse — don't remove
              }

              logger.warn(`🗑️ ${invalidCount} Invalid bundles for PumpSwap ${mintStr} — removing optimistic position`);
              const position = this.positions.get(mintStr);
              if (position) {
                this.emitTradeClose(position, mintStr, txId, 'bundle_invalid_repeated', false, 0, Date.now(), 'jito');
                this.positions.delete(mintStr);
                this.copyTradeMints.delete(mintStr);
                await this.savePositions();
              }
              logEvent('PUMP_SWAP_BUY_FAIL', { mint: mintStr, txId, reason: `bundle_invalid_x${invalidCount}` });
              return;
            }
          }
        }

        if (attempt < RESEND_FROM_ATTEMPT && bundleStatus === 'Pending') continue;

        if (attempt < RESEND_FROM_ATTEMPT && bundleStatus === 'Invalid') {
          logger.info(`PumpSwap Bundle Invalid at early attempt=${attempt+1} for ${mint.toBase58()} — waiting before resend`);
          continue;
        }

        const shouldReturnSwap = await this.resendMutex.runExclusive(async () => {
          tipMultiplier *= config.jito.tipIncreaseFactor;
          logger.info(`Resending PumpSwap bundle for ${mint.toBase58()} attempt=${attempt+1} tipMultiplier=${tipMultiplier.toFixed(2)}`);

          try {
            const mintState = getMintState(mint);
            if (mintState.tokenProgramId) {
              const ata = await getAssociatedTokenAddress(mint, this.payer.publicKey, false, mintState.tokenProgramId);
              const ataInfo = await withRpcLimit(() => this.connection.getTokenAccountBalance(ata));
              if (ataInfo && BigInt(ataInfo.value.amount) > 0n) {
                // Guard: another concurrent confirm flow may have already auto-confirmed this position
                if (this.confirmedPositions.has(mint.toBase58())) {
                  logger.warn(`PumpSwap ${mint.toBase58().slice(0,8)}: already confirmed by concurrent flow, skipping duplicate`);
                  logEvent('RESEND_CANCELLED_DUPLICATE', { mint: mint.toBase58() });
                  return true;
                }
                logger.warn(`PumpSwap ATA has tokens for ${mint.toBase58().slice(0,8)} — buy already landed, cancelling resend`);
                logEvent('RESEND_CANCELLED_ATA', { mint: mint.toBase58(), balance: ataInfo.value.uiAmountString });
                const actualAmount = Number(ataInfo.value.uiAmount ?? 0);
                const position = this.positions.get(mint.toBase58());
                if (position && actualAmount > 0) {
                  position.amount = actualAmount;
                  position.tokenDecimals = ataInfo.value.decimals;
                  this.confirmedPositions.add(mint.toBase58());
                  await this.savePositions();
                  logger.info(`✅ PumpSwap position auto-confirmed from ATA for ${mint.toBase58()}: ${actualAmount} tokens (decimals=${ataInfo.value.decimals})`);
                  logEvent('POSITION_CONFIRMED_ATA', { mint: mint.toBase58(), actualAmount, decimals: ataInfo.value.decimals });

                  const swapCfg = getStrategyForProtocol(position.protocol);
                  const actualEntryPrice = position.entryAmountSol / actualAmount;
                  position.entryPrice = actualEntryPrice;
                  tradeLog.open({
                    mint:           mint.toBase58(),
                    protocol:       position.protocol,
                    entryPrice:     actualEntryPrice,
                    amountSol:      position.entryAmountSol,
                    tokensReceived: actualAmount,
                    slippageBps:    swapCfg.slippageBps,
                    jitoTipSol:     lastTipPaid,
                    txId,
                    openedAt:       position.openedAt,
                  });

                  this.scheduleSocialRetry(mint.toBase58(), position);
                }
                return true;
              }
            }
          } catch {
            // ATA не существует или ошибка RPC
          }

          const pumpSwapResendCfg = getStrategyForProtocol('pumpswap');
          const newTxId = await buyTokenPumpSwap(
            this.connection,
            mint,
            this.payer,
            pumpSwapResendCfg.entryAmountSol,
            pumpSwapResendCfg.slippageBps
          );

          txId = newTxId;
          logEvent('BUNDLE_RESENT', { mint: mint.toBase58(), newTxId, tipMultiplier });
          return false;
        });

        if (shouldReturnSwap) return;

      } catch (err) {
        logger.debug(`Attempt ${attempt+1} to confirm PumpSwap ${mint.toBase58()} failed:`, err);
      }
    }

    logger.warn(`Failed to confirm PumpSwap transaction for ${mint.toBase58()} after ${maxAttempts} attempts.`);
    logEvent('CONFIRM_FAILED', { mint: mint.toBase58(), txId, attempts: maxAttempts });
  }

  private async onPumpFunSellDetected(sell: PumpFunSell) {
    if (!this.running) return;

    // Trend tracker: forward sell events
    if (config.trend.enabled) {
      this.trendTracker.recordSell(sell.mint, sell.seller, Number(sell.solLamports ?? 0) / 1e9);
    }

    // v3: записываем sell для wallet tracker (всегда, ��о других проверок)
    this.walletTracker.recordSell(sell.seller, sell.mint, Number(sell.solLamports ?? 0));

    if (!config.strategy.creatorSellExit) return;

    const position = this.positions.get(sell.mint);
    if (!position) return;
    if (!position.creator) return;

    if (sell.seller === position.creator) {
      // EV-OPT: ignore creator_sell if PnL hasn't dropped meaningfully. Real data shows
      // 8/9 creator_sell exits fired at flat PnL (-2.53% to 0%) = pure fee loss.
      // Threshold defaults to 5%: only panic-exit when position is already losing.
      const minDrop = (config.strategy as any).creatorSellMinDropPct ?? 0;
      const currentPnl = position.pnlPercent;
      if (minDrop > 0 && currentPnl > -minDrop) {
        logger.info(`🔕 Creator sell IGNORED [pump.fun]: ${sell.mint.slice(0,8)} — PnL ${currentPnl.toFixed(2)}% > -${minDrop}% threshold`);
        logEvent('CREATOR_SELL_IGNORED', { mint: sell.mint, pnlPct: currentPnl, threshold: minDrop, protocol: position.protocol });
        return;
      }

      logger.warn(`🚨 CREATOR SELL DETECTED [pump.fun]: ${sell.mint.slice(0,8)}, seller=${sell.seller.slice(0,8)}, amount=${sell.amount}, pnl=${currentPnl.toFixed(2)}%, tx=${sell.signature.slice(0,8)}`);
      logEvent('CREATOR_SELL', { mint: sell.mint, seller: sell.seller, amount: sell.amount.toString(), pnlPct: currentPnl, protocol: position.protocol, tx: sell.signature });

      this.creatorSellSeen.add(sell.mint);

      const acquired = await this.sellingMutex.runExclusive(() => {
        if (this.sellingMints.has(sell.mint)) return false;
        this.sellingMints.add(sell.mint);
        return true;
      });
      if (!acquired) {
        logger.debug(`Creator sell: already selling ${sell.mint.slice(0,8)}`);
        return;
      }

      // Non-blocking: не ждём завершения sell, gRPC events продолжают обрабатываться.
      this.executeFullSell(position, sell.mint, {
        action: 'full',
        reason: 'creator_sell',
        urgent: true,
      }).catch(err => logger.error(`Creator sell execution failed for ${sell.mint.slice(0,8)}:`, err));
    }
  }

  private async recoverPumpSwapMint(mint: string): Promise<void> {
    try {
      const mintPubkey = new PublicKey(mint);
      let poolAddr: PublicKey | undefined;
      let poolAcc: import('@solana/web3.js').AccountInfo<Buffer> | null = null;
      for (const idx of [0, 1, 2]) {
        const candidate = getPoolPDA(mintPubkey, idx);
        const acc = await withRpcLimit(() => this.connection.getAccountInfo(candidate)).catch(() => null);
        if (acc && acc.data.length >= 301) {
          poolAddr = candidate;
          poolAcc = acc;
          break;
        }
      }
      if (!poolAcc || !poolAddr) return;

      const poolState = parsePoolAccount(poolAcc.data);
      const isMemeBase = poolState.baseMint.equals(mintPubkey);
      updateMintState(mintPubkey, {
        creator: poolState.coinCreator ?? undefined,
        pool: poolAddr,
        isPumpSwap: true,
        poolBaseTokenAccount: poolState.poolBaseTokenAccount,
        poolQuoteTokenAccount: poolState.poolQuoteTokenAccount,
        isMemeBase,
      });
      this.seenMints.set(mint, Date.now());

      if (config.trend.enabled) {
        this.trendTracker.track(mint, 'pumpswap');
        logger.info(`🔄 PumpSwap RECOVERY: ${mint.slice(0, 8)} — pool fetched, trend tracking started`);
        logEvent('PUMPSWAP_RECOVERY', { mint, pool: poolAddr.toBase58() });
      }
    } catch (err) {
      logger.debug(`[pumpswap-recovery] Failed for ${mint.slice(0, 8)}: ${err}`);
    }
  }

  // ── Raydium CPMM/AMM v4 swap handlers (Variant B+C) ─────────────────────────
  //
  // B: если pool уже в raydiumPoolToMint → forward в TrendTracker как buy-сигнал
  // C: если pool неизвестен — запускаем recovery (1 RPC, rate-limit)

  private onRaydiumCpmmSwap(swap: RaydiumCpmmSwap): void {
    if (!this.running) return;

    const mapped = this.raydiumPoolToMint.get(swap.pool);
    if (mapped) {
      const isBuy = swap.inputMint === config.wsolMint;

      // ── SELL path: check creator_sell ──────────────────────────────────────
      if (!isBuy) {
        // Forward to trend tracker + wallet tracker
        if (config.trend.enabled) this.trendTracker.recordSell(mapped.mint, swap.user, 0);
        this.walletTracker.recordSell(swap.user, mapped.mint, Number(swap.amountIn ?? 0));

        if (!config.strategy.creatorSellExit) return;

        const position = this.positions.get(mapped.mint);
        if (!position || !position.creator) return;

        if (swap.user === position.creator) {
          const minDrop = (config.strategy as any).creatorSellMinDropPct ?? 0;
          const currentPnl = position.pnlPercent;
          if (minDrop > 0 && currentPnl > -minDrop) {
            logger.info(`🔕 Creator sell IGNORED [Raydium CPMM]: ${mapped.mint.slice(0,8)} — PnL ${currentPnl.toFixed(2)}% > -${minDrop}%`);
            logEvent('CREATOR_SELL_IGNORED', { mint: mapped.mint, pnlPct: currentPnl, threshold: minDrop, protocol: position.protocol });
            return;
          }
          logger.warn(`🚨 CREATOR SELL DETECTED [Raydium CPMM]: ${mapped.mint.slice(0,8)}, seller=${swap.user.slice(0,8)}, pnl=${currentPnl.toFixed(2)}%`);
          logEvent('CREATOR_SELL', { mint: mapped.mint, seller: swap.user, pnlPct: currentPnl, protocol: position.protocol, tx: swap.signature });
          this.creatorSellSeen.add(mapped.mint);
          this.sellingMutex.runExclusive(() => {
            if (this.sellingMints.has(mapped.mint)) return false;
            this.sellingMints.add(mapped.mint);
            return true;
          }).then(acquired => {
            if (!acquired) return;
            this.executeFullSell(position, mapped.mint, { action: 'full', reason: 'creator_sell', urgent: true })
              .catch(err => logger.error(`Raydium CPMM creator sell execution failed for ${mapped.mint.slice(0,8)}:`, err));
          });
        }
        return;
      }

      // ── BUY path: trend tracking + copy-trade ─────────────────────────────
      const dvRayPos = this.positions.get(mapped.mint);
      if (dvRayPos) dvRayPos.lastBuyActivityTs = Date.now();

      const solAmount = Number(swap.amountIn) / 1e9;
      if (solAmount < config.strategy.minIndependentBuySol) return;

      if (config.trend.enabled) this.trendTracker.recordBuy(mapped.mint, swap.user, solAmount);
      this.walletTracker.recordBuy(swap.user, mapped.mint, Number(swap.amountIn ?? 0));

      // ── Copy-trade for Raydium CPMM ──
      this.tryRaydiumCopyTrade(mapped.mint, swap.user, Number(swap.amountIn ?? 0), 'raydium-cpmm').catch(() => {});
      return;
    }

    if (!config.trend.enabled) return;

    // Recovery: новый wSOL-парный CPMM пул, не попавший в CREATE-поток
    const memeMint = swap.inputMint === config.wsolMint ? swap.outputMint : swap.inputMint;
    if (KNOWN_SKIP_MINTS.has(memeMint)) return;
    if (this.raydiumSwapRecoveryAttempted.has(memeMint)) return;

    const now = Date.now();
    const lastTry = this.raydiumSwapRecoveryTs.get(memeMint) ?? 0;
    if (now - lastTry < 10_000) return; // rate limit 10s per mint

    this.raydiumSwapRecoveryAttempted.add(memeMint);
    this.raydiumSwapRecoveryTs.set(memeMint, now);
    this.recoverRaydiumCpmmMint(memeMint, swap.pool).catch(() => {});
  }

  private onRaydiumAmmV4Swap(swap: RaydiumAmmV4Swap): void {
    if (!this.running) return;

    const mapped = this.raydiumPoolToMint.get(swap.pool);
    if (mapped) {
      // Determine direction: if userInputAta == wSOL ATA of user → buy, else sell.
      let isBuy = true;
      if (swap.userInputAta && swap.user) {
        try {
          const userPk = new PublicKey(swap.user);
          const wsolMint = new PublicKey(config.wsolMint);
          const expectedWsolAta = getAssociatedTokenAddressSync(wsolMint, userPk, false).toBase58();
          if (swap.userInputAta !== expectedWsolAta) isBuy = false;
        } catch {
          // fall through to buy-path (conservative)
        }
      }

      // ── SELL path ──────────────────────────────────────────────────────────
      if (!isBuy) {
        if (config.trend.enabled) this.trendTracker.recordSell(mapped.mint, swap.user, 0);
        this.walletTracker.recordSell(swap.user, mapped.mint, Number(swap.amountIn ?? 0));

        if (!config.strategy.creatorSellExit) return;
        const position = this.positions.get(mapped.mint);
        if (!position || !position.creator) return;

        if (swap.user === position.creator) {
          const minDrop = (config.strategy as any).creatorSellMinDropPct ?? 0;
          const currentPnl = position.pnlPercent;
          if (minDrop > 0 && currentPnl > -minDrop) {
            logger.info(`🔕 Creator sell IGNORED [Raydium AMMv4]: ${mapped.mint.slice(0,8)} — PnL ${currentPnl.toFixed(2)}% > -${minDrop}%`);
            logEvent('CREATOR_SELL_IGNORED', { mint: mapped.mint, pnlPct: currentPnl, threshold: minDrop, protocol: position.protocol });
            return;
          }
          logger.warn(`🚨 CREATOR SELL DETECTED [Raydium AMMv4]: ${mapped.mint.slice(0,8)}, pnl=${currentPnl.toFixed(2)}%`);
          logEvent('CREATOR_SELL', { mint: mapped.mint, seller: swap.user, pnlPct: currentPnl, protocol: position.protocol, tx: swap.signature });
          this.creatorSellSeen.add(mapped.mint);
          this.sellingMutex.runExclusive(() => {
            if (this.sellingMints.has(mapped.mint)) return false;
            this.sellingMints.add(mapped.mint);
            return true;
          }).then(acquired => {
            if (!acquired) return;
            this.executeFullSell(position, mapped.mint, { action: 'full', reason: 'creator_sell', urgent: true })
              .catch(err => logger.error(`Raydium AMMv4 creator sell execution failed for ${mapped.mint.slice(0,8)}:`, err));
          });
        }
        return;
      }

      // ── BUY path ───────────────────────────────────────────────────────────
      const dvV4Pos = this.positions.get(mapped.mint);
      if (dvV4Pos) dvV4Pos.lastBuyActivityTs = Date.now();

      const solAmount = Number(swap.amountIn) / 1e9;
      if (solAmount < config.strategy.minIndependentBuySol) return;
      if (config.trend.enabled) this.trendTracker.recordBuy(mapped.mint, swap.user, solAmount);
      this.walletTracker.recordBuy(swap.user, mapped.mint, Number(swap.amountIn ?? 0));

      // ── Copy-trade for Raydium AMM v4 ──
      this.tryRaydiumCopyTrade(mapped.mint, swap.user, Number(swap.amountIn ?? 0), 'raydium-ammv4').catch(() => {});
      return;
    }

    if (!config.trend.enabled) return;

    // Recovery для AMM v4: нужен poolId → fetch → извлечь baseMint
    if (this.raydiumSwapRecoveryAttempted.has(swap.pool)) return;
    const now = Date.now();
    const lastTry = this.raydiumSwapRecoveryTs.get(swap.pool) ?? 0;
    if (now - lastTry < 10_000) return;

    this.raydiumSwapRecoveryAttempted.add(swap.pool);
    this.raydiumSwapRecoveryTs.set(swap.pool, now);
    this.recoverRaydiumAmmV4Pool(swap.pool).catch(() => {});
  }

  private async tryRaydiumCopyTrade(mint: string, buyer: string, solLamports: number, protocol: 'raydium-cpmm' | 'raydium-ammv4'): Promise<void> {
    if (!config.strategy.copyTrade.enabled) return;
    if (this.positions.has(mint) || this.pendingBuys.has(mint)) return;
    if (this.copyTradeMints.has(mint) || this.sellingMints.has(mint)) return;
    if (this.seenMints.has(mint)) return;
    if (this.pendingRaydiumBuys.has(mint)) return;
    if (this.positions.size >= config.strategy.maxPositions) return;

    const maxSlots = protocol === 'raydium-cpmm'
      ? config.strategy.maxRaydiumCpmmPositions
      : config.strategy.maxRaydiumAmmV4Positions;
    const currentCount = protocol === 'raydium-cpmm' ? this.raydiumCpmmCount : this.raydiumAmmV4Count;
    if (currentCount >= maxSlots) return;

    const ct = this.walletTracker.isCopySignal(buyer, solLamports);
    if (!ct.signal) return;

    const rayCfg = protocol === 'raydium-cpmm' ? config.strategy.raydiumCpmm : config.strategy.raydiumAmmV4;
    const entryAmount = ct.tier === 1
      ? config.strategy.copyTrade.entryAmountSol
      : ((config.strategy.copyTrade as any).tier2EntryAmountSol ?? config.strategy.copyTrade.entryAmountSol * 0.5);
    if (entryAmount <= 0) {
      logger.debug(`CT ${protocol} skip: tier ${ct.tier} entry amount is 0 (disabled)`);
      return;
    }
    const entry = Math.max(entryAmount, rayCfg.minEntryAmountSol);

    const exposure = [...this.positions.values()].reduce((s, p) => s + p.entryAmountSol, 0);
    if (exposure + entry > config.strategy.maxTotalExposureSol) return;

    if (config.strategy.enableRugcheck) {
      const rug = await checkRugcheck(mint).catch(() => null);
      if (rug?.risk === 'high') return;
    }

    logger.info(`🎯 COPY-TRADE ${protocol} T${ct.tier}: ${buyer.slice(0,8)} bought ${mint.slice(0,8)} — entry=${entry}`);
    logEvent('COPY_TRADE_EXEC', { mint, buyer: buyer.slice(0,8), tier: ct.tier, entryAmount: entry, protocol });
    this.copyTradeMints.add(mint);
    this.pendingRaydiumBuys.add(mint);

    try {
      const mintPub = new PublicKey(mint);
      const buyFn = protocol === 'raydium-cpmm' ? buyTokenCpmm : buyTokenAmmV4;
      const txId = await buyFn(this.connection, mintPub, this.payer, entry, rayCfg.slippageBps);
      logger.info(`🟢 CT ${protocol} buy sent: ${txId} for ${mint.slice(0, 8)}`);
      this.confirmAndCreateRaydiumPosition(mintPub, txId, entry, protocol).catch(err =>
        logger.error(`[CT-${protocol}] Confirm error for ${mint}:`, err)
      );
    } catch (err) {
      logger.error(`[CT-${protocol}] Buy failed for ${mint}:`, err);
      this.copyTradeMints.delete(mint);
      this.pendingRaydiumBuys.delete(mint);
    }
  }

  private async recoverRaydiumCpmmMint(mint: string, poolHint: string): Promise<void> {
    try {
      if (this.positions.size >= config.strategy.maxPositions) return;
      if (this.raydiumCpmmCount >= config.strategy.maxRaydiumCpmmPositions) return;
      if (this.seenMints.has(mint)) return;

      const mintPk = new PublicKey(mint);
      const { poolId, solReserve, tokenReserve } = await resolveCpmmPool(this.connection, mintPk, new PublicKey(poolHint));

      // Фильтр: минимальная ликвидность
      const solReserveSol = Number(solReserve) / 1e9;
      if (solReserveSol < config.strategy.raydiumCpmm.minLiquiditySol) {
        logger.debug(`[raydium-cpmm-recovery] ${mint.slice(0,8)} too low liquidity ${solReserveSol.toFixed(3)} SOL, skip`);
        return;
      }

      const isScalp = solReserveSol >= config.strategy.scalpLiquidityThresholdSol;
      this.mintScalpFlag.set(mint, isScalp);

      updateMintState(mintPk, {
        isRaydiumCpmm: true,
        raydiumPool: poolId,
      });
      this.raydiumPoolToMint.set(poolId.toBase58(), { mint, protocol: 'raydium-cpmm' });
      this.seenMints.set(mint, Date.now());

      if (config.trend.enabled) {
        this.trendTracker.track(mint, 'raydium-cpmm');
        logger.info(`🔄 Raydium CPMM RECOVERY${isScalp ? ' SCALP' : ''}: ${mint.slice(0, 8)} liq=${solReserveSol.toFixed(2)} SOL — trend tracking started`);
        logEvent('RAYDIUM_CPMM_RECOVERY', { mint, pool: poolId.toBase58(), liquiditySol: solReserveSol, isScalp });
      }

      // Baseline для entry momentum (price = SOL lamports per raw token)
      if (tokenReserve > 0n) {
        this.mintFirstSeenPrice.set(mint, {
          price: Number(solReserve) / Number(tokenReserve),
          ts: Date.now(),
        });
      }
    } catch (err) {
      logger.debug(`[raydium-cpmm-recovery] ${mint.slice(0, 8)}: ${err}`);
    }
  }

  private async recoverRaydiumAmmV4Pool(poolStr: string): Promise<void> {
    try {
      if (this.positions.size >= config.strategy.maxPositions) return;
      if (this.raydiumAmmV4Count >= config.strategy.maxRaydiumAmmV4Positions) return;

      const poolPk = new PublicKey(poolStr);
      const poolAcc = await withRpcLimit(() => this.connection.getAccountInfo(poolPk));
      if (!poolAcc) return;

      const pool = parseAmmV4Pool(poolAcc.data);
      const wsol = new PublicKey(config.wsolMint);
      let mint: PublicKey | null = null;
      if (pool.baseMint.equals(wsol))      mint = pool.quoteMint;
      else if (pool.quoteMint.equals(wsol)) mint = pool.baseMint;
      else return; // не wSOL-пара

      const mintStr = mint.toBase58();
      if (KNOWN_SKIP_MINTS.has(mintStr)) return;
      if (this.seenMints.has(mintStr)) return;

      // Проверка ликвидности через resolveAmmV4Pool
      const resolved = await resolveAmmV4Pool(this.connection, mint, poolPk);
      const solReserveSol = Number(resolved.solReserve) / 1e9;
      if (solReserveSol < config.strategy.raydiumAmmV4.minLiquiditySol) {
        logger.debug(`[raydium-ammv4-recovery] ${mintStr.slice(0,8)} too low liquidity ${solReserveSol.toFixed(3)} SOL, skip`);
        return;
      }

      const isScalp = solReserveSol >= config.strategy.scalpLiquidityThresholdSol;
      this.mintScalpFlag.set(mintStr, isScalp);

      updateMintState(mint, { isRaydiumAmmV4: true, raydiumPool: poolPk });
      this.raydiumPoolToMint.set(poolStr, { mint: mintStr, protocol: 'raydium-ammv4' });
      this.seenMints.set(mintStr, Date.now());

      if (config.trend.enabled) {
        this.trendTracker.track(mintStr, 'raydium-ammv4');
        logger.info(`🔄 Raydium AMM v4 RECOVERY${isScalp ? ' SCALP' : ''}: ${mintStr.slice(0, 8)} liq=${solReserveSol.toFixed(2)} SOL — trend tracking started`);
        logEvent('RAYDIUM_AMMV4_RECOVERY', { mint: mintStr, pool: poolStr, liquiditySol: solReserveSol, isScalp });
      }

      // Baseline для entry momentum
      if (resolved.tokenReserve > 0n) {
        this.mintFirstSeenPrice.set(mintStr, {
          price: Number(resolved.solReserve) / Number(resolved.tokenReserve),
          ts: Date.now(),
        });
      }
    } catch (err) {
      logger.debug(`[raydium-ammv4-recovery] ${poolStr.slice(0, 8)}: ${err}`);
    }
  }

  // ── Entry momentum filter ───────────────────────────────────────────────────
  //
  // Запоминаем первую замеченную цену для mint. Перед покупкой сравниваем текущую
  // с первой: если +300% / 3x — скорее всего поздно, пропускаем вход.

  private trackFirstSeenPrice(mint: string, solReserve: number, tokenReserveUi: number): void {
    if (this.mintFirstSeenPrice.has(mint)) return;
    if (tokenReserveUi <= 0) return;
    const price = solReserve / 1e9 / tokenReserveUi; // SOL per token
    this.mintFirstSeenPrice.set(mint, { price, ts: Date.now() });
  }

  /** Returns true if current price is within acceptable range (not pumped too high). */
  private checkEntryMomentum(mint: string, currentPrice: number): boolean {
    const cfg: any = (config.strategy as any).entryMomentum;
    if (!cfg?.enabled) return true;
    const first = this.mintFirstSeenPrice.get(mint);
    if (!first || first.price <= 0) return true; // нет baseline — пропускаем фильтр
    const ratio = currentPrice / first.price;
    const maxRatio = cfg.maxPumpRatio ?? 3.0;
    if (ratio > maxRatio) {
      logger.info(`🚫 ENTRY MOMENTUM: ${mint.slice(0,8)} pumped ${ratio.toFixed(1)}x > ${maxRatio}x — skip late entry`);
      logEvent('ENTRY_MOMENTUM_BLOCKED', { mint, ratio, firstPrice: first.price, currentPrice });
      return false;
    }
    return true;
  }

  private async onPumpSwapSellDetected(sell: PumpSwapSell) {
    if (!this.running) return;
    logger.debug(`🔄 PUMP SWAP SELL DETECTED: ${sell.mint} amount=${sell.amount}`);
    logEvent('PUMP_SWAP_SELL_DETECTED', { mint: sell.mint, amount: sell.amount.toString() });

    // Trend tracker: forward PumpSwap sell events
    if (config.trend.enabled) {
      this.trendTracker.recordSell(sell.mint, sell.creator, Number(sell.solLamports ?? 0) / 1e9);
    }

    // v3: записываем sell для wallet tracker
    this.walletTracker.recordSell(sell.creator, sell.mint, Number(sell.solLamports ?? 0));

    if (!config.strategy.creatorSellExit) return;

    const position = this.positions.get(sell.mint);
    if (!position) return;
    if (!position.creator) return;

    if (sell.creator === position.creator) {
      // EV-OPT: same smart-exit logic as pump.fun path. See onPumpFunSellDetected.
      const minDrop = (config.strategy as any).creatorSellMinDropPct ?? 0;
      const currentPnl = position.pnlPercent;
      if (minDrop > 0 && currentPnl > -minDrop) {
        logger.info(`🔕 Creator sell IGNORED [PumpSwap]: ${sell.mint.slice(0,8)} — PnL ${currentPnl.toFixed(2)}% > -${minDrop}% threshold`);
        logEvent('CREATOR_SELL_IGNORED', { mint: sell.mint, pnlPct: currentPnl, threshold: minDrop, protocol: position.protocol });
        return;
      }

      logger.warn(`🚨 CREATOR SELL DETECTED [PumpSwap]: ${sell.mint.slice(0,8)}, seller=${sell.creator.slice(0,8)}, amount=${sell.amount}, pnl=${currentPnl.toFixed(2)}%, tx=${sell.signature.slice(0,8)}`);
      logEvent('CREATOR_SELL', { mint: sell.mint, seller: sell.creator, amount: sell.amount.toString(), pnlPct: currentPnl, protocol: position.protocol, tx: sell.signature });

      this.creatorSellSeen.add(sell.mint);

      const acquired = await this.sellingMutex.runExclusive(() => {
        if (this.sellingMints.has(sell.mint)) return false;
        this.sellingMints.add(sell.mint);
        return true;
      });
      if (!acquired) {
        logger.debug(`Creator sell: already selling ${sell.mint.slice(0,8)}`);
        return;
      }

      // Non-blocking: не ждём завершения sell (HISTORY_DEV_SNIPER)
      this.executeFullSell(position, sell.mint, {
        action: 'full',
        reason: 'creator_sell',
        urgent: true,
      }).catch(err => logger.error(`PumpSwap creator sell execution failed for ${sell.mint.slice(0,8)}:`, err));
    }
  }

  // ═══ Trend-Confirmed Entry Handlers ═══════════════════════════════════════

  private async onTrendConfirmed(mint: string, metrics: TrendMetrics) {
    this.eventsDetected++;
    if (!this.running) { this.trackSkip('not_running'); logEvent('TREND_SKIP', { mint, reason: 'not_running' }); return; }
    if (this.positions.has(mint)) { this.trackSkip('position_exists'); logEvent('TREND_SKIP', { mint, reason: 'position_exists' }); return; }
    if (this.sellingMints.has(mint)) { this.trackSkip('selling_in_progress'); logEvent('TREND_SKIP', { mint, reason: 'selling_in_progress' }); return; }
    if (this.failedSellMints.has(mint)) { this.trackSkip('failed_sell_blocked'); logEvent('TREND_SKIP', { mint, reason: 'failed_sell_blocked' }); return; }

    // ── seenMints guard: не покупаем повторно токены, виденные в последний час ──
    if (this.seenMints.has(mint) && !this.reEntryEligible.has(mint)) {
      this.trackSkip('recently_seen'); logEvent('TREND_SKIP', { mint, reason: 'recently_seen' });
      return;
    }

    // ── Re-entry gate: проверяем cooldown, лимиты и ценовой порог ──
    const reCfg: any = (config.strategy as any).trendReEntry;
    const reInfo = this.reEntryEligible.get(mint);
    let entryMultiplier = 1.0;
    if (reInfo) {
      if (!reCfg?.enabled) {
        this.reEntryEligible.delete(mint);
      } else if (!reCfg.allowedProtocols.includes(metrics.protocol)) {
        this.reEntryEligible.delete(mint);
      } else if (reInfo.count >= (reCfg.maxReEntries ?? 2)) {
        logger.debug(`[re-entry] ${mint.slice(0,8)} max re-entries reached (${reInfo.count})`);
        this.reEntryEligible.delete(mint);
        this.trendTracker.remove(mint);
        this.trackSkip('reentry_max_reached'); logEvent('TREND_SKIP', { mint, reason: 'reentry_max_reached', protocol: metrics.protocol, count: reInfo.count, max: reCfg.maxReEntries ?? 2 });
        return;
      } else if (Date.now() - reInfo.closedAt < (reCfg.cooldownMs ?? 30_000)) {
        logger.debug(`[re-entry] ${mint.slice(0,8)} still in cooldown`);
        this.trackSkip('reentry_cooldown'); logEvent('TREND_SKIP', { mint, reason: 'reentry_cooldown', protocol: metrics.protocol, elapsedMs: Date.now() - reInfo.closedAt, cooldownMs: reCfg.cooldownMs ?? 30_000 });
        return;
      } else {
        entryMultiplier = reCfg.entryMultiplier ?? 0.5;
        logger.info(`🔁 RE-ENTRY #${reInfo.count + 1}: ${mint.slice(0,8)} multiplier=${entryMultiplier}`);
        logEvent('RE_ENTRY_ALLOWED', { mint, count: reInfo.count + 1, multiplier: entryMultiplier });
      }
    }

    if (this.positions.size >= config.strategy.maxPositions) {
      logger.debug(`[trend] ${mint.slice(0, 8)} confirmed but max positions reached`);
      this.trackSkip('max_positions'); logEvent('TREND_SKIP', { mint, reason: 'max_positions', protocol: metrics.protocol, current: this.positions.size, max: config.strategy.maxPositions });
      this.trendTracker.remove(mint);
      this.trendTokenData.delete(mint);
      return;
    }

    const totalExposure = [...this.positions.values()].reduce((s, p) => s + p.entryAmountSol, 0);
    if (totalExposure >= config.strategy.maxTotalExposureSol) {
      logger.warn(`[trend] ${mint.slice(0, 8)} confirmed but exposure limit reached (${totalExposure.toFixed(3)})`);
      this.trackSkip('max_exposure'); logEvent('TREND_SKIP', { mint, reason: 'max_exposure', protocol: metrics.protocol, currentExposure: totalExposure, maxExposure: config.strategy.maxTotalExposureSol });
      this.trendTracker.remove(mint);
      this.trendTokenData.delete(mint);
      return;
    }

    // ── Rugcheck gate (protocol-aware, mirrors shadow pipeline) ──
    if (config.strategy.enableRugcheck) {
      const rugResult = await checkRugcheck(mint).catch(() => null);
      if (rugResult && rugResult.risk === 'high') {
        const isMigrated = metrics.protocol === 'pumpswap';
        const hasCriticalRisk = rugResult.risks.some((r: string) =>
          r.includes('HONEYPOT') || r.includes('freeze_authority'),
        );
        if (!isMigrated || hasCriticalRisk) {
          this.trackSkip('rugcheck_high_risk'); logEvent('TREND_SKIP', { mint, reason: 'rugcheck_high_risk', protocol: metrics.protocol, score: rugResult.score, risks: rugResult.risks, isMigrated, hasCriticalRisk });
          this.trendTracker.remove(mint);
          this.trendTokenData.delete(mint);
          return;
        }
      }
      if (rugResult) {
        logEvent('TREND_RUGCHECK_PASS', { mint, protocol: metrics.protocol, risk: rugResult.risk, score: rugResult.score });
      }
    }

    // ── Safety check (protocol-aware, mirrors shadow pipeline) ──
    {
      const safetyResult = await isTokenSafeCached(this.connection, new PublicKey(mint)).catch((): { safe: boolean; reason?: string } => ({ safe: true }));
      if (!safetyResult.safe) {
        const isAmmProtocol = ['pumpswap', 'raydium-cpmm', 'raydium-ammv4'].includes(metrics.protocol);
        const isFreezeIssue = safetyResult.reason?.includes('Freeze authority');
        if (!isAmmProtocol || isFreezeIssue) {
          this.trackSkip('safety_failed'); logEvent('TREND_SKIP', { mint, reason: 'safety_failed', protocol: metrics.protocol, safetyReason: safetyResult.reason });
          this.trendTracker.remove(mint);
          this.trendTokenData.delete(mint);
          return;
        }
      }
    }

    // ── Creator history: block serial ruggers ──
    {
      const trendTokenCreator = this.trendTokenData.get(mint)?.creator ?? this.mintCreatorMap.get(mint);
      if (trendTokenCreator) {
        const creatorHist = checkCreatorHistory(trendTokenCreator);
        if (creatorHist.shouldBlock) {
          this.trackSkip('creator_serial_rugger'); logEvent('TREND_SKIP', {
            mint,
            reason: 'creator_serial_rugger',
            protocol: metrics.protocol,
            creator: trendTokenCreator,
            rugRate: creatorHist.rugRate,
            totalTokens: creatorHist.totalTokens,
          });
          logger.info(
            `🚫 [trend] Serial rugger blocked: ${trendTokenCreator.slice(0, 8)} — ` +
            `rugRate=${(creatorHist.rugRate * 100).toFixed(0)}% tokens=${creatorHist.totalTokens} — ` +
            `skip ${mint.slice(0, 8)}`
          );
          this.trendTracker.remove(mint);
          this.trendTokenData.delete(mint);
          return;
        }
      }
    }

    // ── #6: Creator balance check ──
    {
      const creator = this.trendTokenData.get(mint)?.creator ?? this.mintCreatorMap.get(mint);
      if (creator && (config.strategy as any).creatorBalanceCheck?.enabled) {
        const bal = await getCreatorBalance(this.connection, creator).catch(() => undefined);
        if (bal !== undefined && bal < ((config.strategy as any).creatorBalanceCheck?.minSol ?? 0.5)) {
          this.trackSkip('creator_low_balance'); logEvent('TREND_SKIP', { mint, reason: 'creator_low_balance', protocol: metrics.protocol, creatorBalance: bal });
          logger.info(`[trend] Low creator balance ${bal.toFixed(3)} SOL — skip ${mint.slice(0, 8)}`);
          this.trendTracker.remove(mint);
          this.trendTokenData.delete(mint);
          return;
        }
      }
    }

    // ── #8: Token-2022 extension check ──
    if ((config.strategy as any).token2022Check?.enabled) {
      const t22 = await checkToken2022Extensions(this.connection, new PublicKey(mint)).catch(() => ({ isDangerous: false, extensions: [] }));
      if (t22.isDangerous) {
        this.trackSkip('token2022_dangerous'); logEvent('TREND_SKIP', { mint, reason: 'token2022_dangerous', protocol: metrics.protocol, extensions: t22.extensions });
        logger.info(`[trend] Dangerous Token-2022 extensions: ${t22.extensions.join(',')} — skip ${mint.slice(0, 8)}`);
        this.trendTracker.remove(mint);
        this.trendTokenData.delete(mint);
        return;
      }
    }

    // ── #18: Bundled buy detection ──
    if ((config.strategy as any).bundledBuyDetection?.enabled) {
      const threshold = (config.strategy as any).bundledBuyDetection?.threshold ?? 5;
      const bundled = detectBundledBuys(mint, threshold);
      if (bundled.isBundled) {
        this.trackSkip('bundled_buy_detected'); logEvent('TREND_SKIP', { mint, reason: 'bundled_buy_detected', protocol: metrics.protocol, maxWallets: bundled.maxWalletsInSlot, sameSlotSol: bundled.sameSlotSol });
        logger.info(`[trend] Bundled buy detected: ${bundled.maxWalletsInSlot} wallets in slot — skip ${mint.slice(0, 8)}`);
        this.trendTracker.remove(mint);
        this.trendTokenData.delete(mint);
        return;
      }
    }

    // ── #10: Wash trading detection ──
    {
      const washCreator = this.trendTokenData.get(mint)?.creator ?? this.mintCreatorMap.get(mint);
      const wash = detectWashTrading(mint, washCreator);
      if (wash.isWashTrading) {
        this.trackSkip('wash_trading'); logEvent('TREND_SKIP', { mint, reason: 'wash_trading', protocol: metrics.protocol, repeatBuyers: wash.repeatBuyers, totalBuyers: wash.totalBuyers });
        logger.info(`[trend] Wash trading detected: ${wash.repeatBuyers}/${wash.totalBuyers} repeat — skip ${mint.slice(0, 8)}`);
        this.trendTracker.remove(mint);
        this.trendTokenData.delete(mint);
        return;
      }
    }

    // ── #19: Price stability check ──
    if ((config.strategy as any).priceStability?.enabled) {
      const stability = checkPriceStability(
        mint,
        (config.strategy as any).priceStability?.windowMs ?? 10_000,
        (config.strategy as any).priceStability?.maxDropPct ?? 30,
      );
      if (stability.isUnstable) {
        this.trackSkip('price_unstable'); logEvent('TREND_SKIP', { mint, reason: 'price_unstable', protocol: metrics.protocol, dropPct: stability.dropFromPeakPct, peak: stability.peakPrice, current: stability.currentPrice });
        logger.info(`[trend] Price unstable: ${stability.dropFromPeakPct.toFixed(1)}% drop from peak — skip ${mint.slice(0, 8)}`);
        this.trendTracker.remove(mint);
        this.trendTokenData.delete(mint);
        return;
      }
    }

    // ── Entry momentum filter (только для первичных входов, не re-entry) ──
    if (!reInfo && (metrics.protocol === 'pumpswap' || metrics.protocol === 'raydium-cpmm' || metrics.protocol === 'raydium-ammv4' || metrics.protocol === 'raydium-launch')) {
      const currentPrice = await this.getCurrentPriceForReEntry(mint, metrics.protocol).catch(() => 0);
      if (currentPrice > 0 && !this.checkEntryMomentum(mint, currentPrice)) {
        this.trackSkip('entry_momentum_failed'); logEvent('TREND_SKIP', { mint, reason: 'entry_momentum_failed', protocol: metrics.protocol, currentPrice });
        this.trendTracker.remove(mint);
        this.trendTokenData.delete(mint);
        return;
      }
    }

    // Для pump.fun токенов — используем сохранённые tokenData
    const tokenData = this.trendTokenData.get(mint);
    if (tokenData) {
      logger.info(
        `📈 TREND ENTRY: ${mint.slice(0, 8)} — buyers=${metrics.uniqueBuyers} ` +
        `vol=${metrics.buyVolumeSol.toFixed(3)} ratio=${metrics.buySellRatio.toFixed(1)} ` +
        `protocol=${metrics.protocol}`
      );
      logEvent('TREND_ENTRY', metrics);

      const protocol = metrics.protocol !== 'unknown'
        ? { protocol: metrics.protocol }
        : await detectProtocol(this.connection, new PublicKey(mint));

      if (protocol.protocol === 'pumpswap') {
        try {
          const psCfg = getStrategyForProtocol('pumpswap');
          if (this.pumpSwapCount >= config.strategy.maxPumpSwapPositions) {
            logger.debug(`[trend] PumpSwap slots full, skip ${mint.slice(0, 8)}`);
            this.trackSkip('pumpswap_slots_full'); logEvent('TREND_SKIP', { mint, reason: 'pumpswap_slots_full', protocol: 'pumpswap', current: this.pumpSwapCount, max: config.strategy.maxPumpSwapPositions });
            return;
          }
          const entryAmt = Math.max(psCfg.entryAmountSol * entryMultiplier, config.strategy.minEntryAmountSol);
          const mintPub = new PublicKey(mint);
          const txId = await buyTokenPumpSwap(this.connection, mintPub, this.payer, entryAmt, psCfg.slippageBps);
          logger.info(`🟢 TREND PumpSwap buy sent: ${txId} for ${mint.slice(0, 8)} (entry=${entryAmt})`);
          logEvent('TREND_PUMPSWAP_BUY_SENT', { mint, txId, entry: entryAmt, reEntry: entryMultiplier < 1 });
          this.pumpSwapBuyBlockedMints.set(mint, Date.now());
          await this.createOptimisticPumpSwapPosition(mintPub, txId, entryAmt);
          this.confirmAndUpdatePumpSwapPosition(mintPub, txId).catch(err =>
            logger.error(`[trend] PumpSwap confirm error for ${mint}:`, err)
          );
        } catch (err) {
          logger.error(`[trend] PumpSwap buy failed for ${mint}:`, err);
        }
      } else if (protocol.protocol === 'raydium-cpmm') {
        try {
          if (this.raydiumCpmmCount >= config.strategy.maxRaydiumCpmmPositions) {
            logger.debug(`[trend] Raydium CPMM slots full, skip ${mint.slice(0, 8)}`);
            this.trackSkip('raydium_cpmm_slots_full'); logEvent('TREND_SKIP', { mint, reason: 'raydium_cpmm_slots_full', protocol: 'raydium-cpmm', current: this.raydiumCpmmCount, max: config.strategy.maxRaydiumCpmmPositions });
            return;
          }
          if (this.pendingRaydiumBuys.has(mint)) {
            logger.debug(`[trend] Raydium CPMM buy already pending for ${mint.slice(0, 8)}`);
            this.trackSkip('raydium_cpmm_pending'); logEvent('TREND_SKIP', { mint, reason: 'raydium_cpmm_pending', protocol: 'raydium-cpmm' });
            return;
          }
          const mintPub = new PublicKey(mint);
          const cpmmIsScalp = this.mintScalpFlag.get(mint) ?? false;
          const cpmmCfg = cpmmIsScalp ? config.strategy.scalping : config.strategy.raydiumCpmm;
          const entryAmt = Math.max(cpmmCfg.entryAmountSol * entryMultiplier, cpmmCfg.minEntryAmountSol);
          const txId = await buyTokenCpmm(this.connection, mintPub, this.payer, entryAmt, config.strategy.raydiumCpmm.slippageBps);
          logger.info(`🟢 TREND Raydium CPMM${cpmmIsScalp ? ' SCALP' : ''} buy sent: ${txId} for ${mint.slice(0, 8)} (entry=${entryAmt})`);
          logEvent('TREND_RAYDIUM_CPMM_BUY_SENT', { mint, txId, entry: entryAmt, reEntry: entryMultiplier < 1, isScalp: cpmmIsScalp });
          this.pendingRaydiumBuys.add(mint);
          this.confirmAndCreateRaydiumPosition(mintPub, txId, entryAmt, 'raydium-cpmm', cpmmIsScalp).catch(err =>
            logger.error(`[trend] Raydium CPMM confirm error for ${mint}:`, err)
          );
        } catch (err) {
          logger.error(`[trend] Raydium CPMM buy failed for ${mint}:`, err);
        }
      } else if (protocol.protocol === 'raydium-ammv4') {
        try {
          if (this.raydiumAmmV4Count >= config.strategy.maxRaydiumAmmV4Positions) {
            logger.debug(`[trend] Raydium AMM v4 slots full, skip ${mint.slice(0, 8)}`);
            this.trackSkip('raydium_ammv4_slots_full'); logEvent('TREND_SKIP', { mint, reason: 'raydium_ammv4_slots_full', protocol: 'raydium-ammv4', current: this.raydiumAmmV4Count, max: config.strategy.maxRaydiumAmmV4Positions });
            return;
          }
          if (this.pendingRaydiumBuys.has(mint)) {
            logger.debug(`[trend] Raydium AMM v4 buy already pending for ${mint.slice(0, 8)}`);
            this.trackSkip('raydium_ammv4_pending'); logEvent('TREND_SKIP', { mint, reason: 'raydium_ammv4_pending', protocol: 'raydium-ammv4' });
            return;
          }
          const mintPub = new PublicKey(mint);
          const v4IsScalp = this.mintScalpFlag.get(mint) ?? false;
          const v4Cfg = v4IsScalp ? config.strategy.scalping : config.strategy.raydiumAmmV4;
          const entryAmt = Math.max(v4Cfg.entryAmountSol * entryMultiplier, v4Cfg.minEntryAmountSol);
          const txId = await buyTokenAmmV4(this.connection, mintPub, this.payer, entryAmt, config.strategy.raydiumAmmV4.slippageBps);
          logger.info(`🟢 TREND Raydium AMM v4${v4IsScalp ? ' SCALP' : ''} buy sent: ${txId} for ${mint.slice(0, 8)} (entry=${entryAmt})`);
          logEvent('TREND_RAYDIUM_AMM_V4_BUY_SENT', { mint, txId, entry: entryAmt, reEntry: entryMultiplier < 1, isScalp: v4IsScalp });
          this.pendingRaydiumBuys.add(mint);
          this.confirmAndCreateRaydiumPosition(mintPub, txId, entryAmt, 'raydium-ammv4', v4IsScalp).catch(err =>
            logger.error(`[trend] Raydium AMM v4 confirm error for ${mint}:`, err)
          );
        } catch (err) {
          logger.error(`[trend] Raydium AMM v4 buy failed for ${mint}:`, err);
        }
      } else if (protocol.protocol === 'raydium-launch') {
        try {
          if (this.raydiumLaunchCount >= config.strategy.maxRaydiumLaunchPositions) {
            logger.debug(`[trend] Raydium LaunchLab slots full, skip ${mint.slice(0, 8)}`);
            this.trackSkip('raydium_launch_slots_full'); logEvent('TREND_SKIP', { mint, reason: 'raydium_launch_slots_full', protocol: 'raydium-launch', current: this.raydiumLaunchCount, max: config.strategy.maxRaydiumLaunchPositions });
            return;
          }
          if (this.pendingRaydiumBuys.has(mint)) {
            logger.debug(`[trend] Raydium LaunchLab buy already pending for ${mint.slice(0, 8)}`);
            this.trackSkip('raydium_launch_pending'); logEvent('TREND_SKIP', { mint, reason: 'raydium_launch_pending', protocol: 'raydium-launch' });
            return;
          }
          const mintPub = new PublicKey(mint);
          const llCfg = config.strategy.raydiumLaunch;
          const entryAmt = Math.max(llCfg.entryAmountSol * entryMultiplier, llCfg.minEntryAmountSol);
          const txId = await buyTokenLaunchLab(this.connection, mintPub, this.payer, entryAmt, llCfg.slippageBps);
          logger.info(`🟢 TREND Raydium LaunchLab buy sent: ${txId} for ${mint.slice(0, 8)} (entry=${entryAmt})`);
          logEvent('TREND_RAYDIUM_BUY_SENT', { mint, txId, entry: entryAmt, reEntry: entryMultiplier < 1 });
          this.pendingRaydiumBuys.add(mint);
          this.confirmAndCreateRaydiumPosition(mintPub, txId, entryAmt, 'raydium-launch').catch(err =>
            logger.error(`[trend] Raydium LaunchLab confirm error for ${mint}:`, err)
          );
        } catch (err) {
          logger.error(`[trend] Raydium LaunchLab buy failed for ${mint}:`, err);
        }
      } else {
        try {
          if (this.pumpFunCount >= config.strategy.maxPumpFunPositions) {
            logger.debug(`[trend] Pump.fun slots full, skip ${mint.slice(0, 8)}`);
            this.trackSkip('pumpfun_slots_full'); logEvent('TREND_SKIP', { mint, reason: 'pumpfun_slots_full', protocol: 'pumpfun', current: this.pumpFunCount, max: config.strategy.maxPumpFunPositions });
            return;
          }
          await this.executePendingBuy(tokenData);
        } catch (err) {
          logger.error(`[trend] Pump.fun buy failed for ${mint}:`, err);
        }
      }

      this.trendTracker.remove(mint);
      this.trendTokenData.delete(mint);
      return;
    }

    // Social discovery mint (нет tokenData) — определяем протокол и покупаем
    try {
      const mintPub = new PublicKey(mint);
      const protocol = await detectProtocol(this.connection, mintPub);

      logger.info(
        `📈 TREND ENTRY (social discovery): ${mint.slice(0, 8)} ` +
        `protocol=${protocol.protocol} buyers=${metrics.uniqueBuyers} vol=${metrics.buyVolumeSol.toFixed(3)}`
      );
      logEvent('TREND_SOCIAL_ENTRY', { ...metrics, detectedProtocol: protocol.protocol });

      if (protocol.protocol === 'pumpswap') {
        if (this.pumpSwapCount >= config.strategy.maxPumpSwapPositions) {
          this.trackSkip('social_pumpswap_slots_full'); logEvent('TREND_SKIP', { mint, reason: 'social_pumpswap_slots_full', protocol: 'pumpswap', current: this.pumpSwapCount, max: config.strategy.maxPumpSwapPositions });
          return;
        }
        const psCfg = getStrategyForProtocol('pumpswap');
        const txId = await buyTokenPumpSwap(this.connection, mintPub, this.payer, psCfg.entryAmountSol, psCfg.slippageBps);
        logger.info(`🟢 TREND social PumpSwap buy: ${txId} for ${mint.slice(0, 8)}`);
        this.pumpSwapBuyBlockedMints.set(mint, Date.now());
        await this.createOptimisticPumpSwapPosition(mintPub, txId);
        this.confirmAndUpdatePumpSwapPosition(mintPub, txId).catch(err =>
          logger.error(`[trend] Social PumpSwap confirm error for ${mint}:`, err)
        );
      } else if (protocol.protocol === 'raydium-launch') {
        if (this.raydiumLaunchCount >= config.strategy.maxRaydiumLaunchPositions) {
          this.trackSkip('social_raydium_launch_slots_full'); logEvent('TREND_SKIP', { mint, reason: 'social_raydium_launch_slots_full', protocol: 'raydium-launch', current: this.raydiumLaunchCount, max: config.strategy.maxRaydiumLaunchPositions });
          return;
        }
        if (this.pendingRaydiumBuys.has(mint)) {
          this.trackSkip('social_raydium_launch_pending'); logEvent('TREND_SKIP', { mint, reason: 'social_raydium_launch_pending', protocol: 'raydium-launch' });
          return;
        }
        const cfg = config.strategy.raydiumLaunch;
        const txId = await buyTokenLaunchLab(this.connection, mintPub, this.payer, cfg.entryAmountSol, cfg.slippageBps);
        logger.info(`🟢 TREND social Raydium LaunchLab buy: ${txId} for ${mint.slice(0, 8)}`);
        logEvent('TREND_RAYDIUM_BUY_SENT', { mint, txId });
        this.pendingRaydiumBuys.add(mint);
        this.confirmAndCreateRaydiumPosition(mintPub, txId, cfg.entryAmountSol, 'raydium-launch').catch(err =>
          logger.error(`[trend] Social Raydium LaunchLab confirm error for ${mint}:`, err)
        );
      } else if (protocol.protocol === 'raydium-cpmm') {
        if (this.raydiumCpmmCount >= config.strategy.maxRaydiumCpmmPositions) {
          this.trackSkip('social_raydium_cpmm_slots_full'); logEvent('TREND_SKIP', { mint, reason: 'social_raydium_cpmm_slots_full', protocol: 'raydium-cpmm', current: this.raydiumCpmmCount, max: config.strategy.maxRaydiumCpmmPositions });
          return;
        }
        if (this.pendingRaydiumBuys.has(mint)) {
          this.trackSkip('social_raydium_cpmm_pending'); logEvent('TREND_SKIP', { mint, reason: 'social_raydium_cpmm_pending', protocol: 'raydium-cpmm' });
          return;
        }
        const socCpmmScalp = this.mintScalpFlag.get(mint) ?? false;
        const socCpmmCfg = socCpmmScalp ? config.strategy.scalping : config.strategy.raydiumCpmm;
        const socCpmmEntry = socCpmmCfg.entryAmountSol;
        const txId = await buyTokenCpmm(this.connection, mintPub, this.payer, socCpmmEntry, config.strategy.raydiumCpmm.slippageBps);
        logger.info(`🟢 TREND social Raydium CPMM${socCpmmScalp ? ' SCALP' : ''} buy: ${txId} for ${mint.slice(0, 8)}`);
        logEvent('TREND_RAYDIUM_CPMM_BUY_SENT', { mint, txId, isScalp: socCpmmScalp });
        this.pendingRaydiumBuys.add(mint);
        this.confirmAndCreateRaydiumPosition(mintPub, txId, socCpmmEntry, 'raydium-cpmm', socCpmmScalp).catch(err =>
          logger.error(`[trend] Social Raydium CPMM confirm error for ${mint}:`, err)
        );
      } else if (protocol.protocol === 'raydium-ammv4') {
        if (this.raydiumAmmV4Count >= config.strategy.maxRaydiumAmmV4Positions) {
          this.trackSkip('social_raydium_ammv4_slots_full'); logEvent('TREND_SKIP', { mint, reason: 'social_raydium_ammv4_slots_full', protocol: 'raydium-ammv4', current: this.raydiumAmmV4Count, max: config.strategy.maxRaydiumAmmV4Positions });
          return;
        }
        if (this.pendingRaydiumBuys.has(mint)) {
          this.trackSkip('social_raydium_ammv4_pending'); logEvent('TREND_SKIP', { mint, reason: 'social_raydium_ammv4_pending', protocol: 'raydium-ammv4' });
          return;
        }
        const socV4Scalp = this.mintScalpFlag.get(mint) ?? false;
        const socV4Cfg = socV4Scalp ? config.strategy.scalping : config.strategy.raydiumAmmV4;
        const socV4Entry = socV4Cfg.entryAmountSol;
        const txId = await buyTokenAmmV4(this.connection, mintPub, this.payer, socV4Entry, config.strategy.raydiumAmmV4.slippageBps);
        logger.info(`🟢 TREND social Raydium AMM v4${socV4Scalp ? ' SCALP' : ''} buy: ${txId} for ${mint.slice(0, 8)}`);
        logEvent('TREND_RAYDIUM_AMM_V4_BUY_SENT', { mint, txId, isScalp: socV4Scalp });
        this.pendingRaydiumBuys.add(mint);
        this.confirmAndCreateRaydiumPosition(mintPub, txId, socV4Entry, 'raydium-ammv4', socV4Scalp).catch(err =>
          logger.error(`[trend] Social Raydium AMM v4 confirm error for ${mint}:`, err)
        );
      } else if (protocol.protocol === 'pumpfun') {
        if (this.pumpFunCount >= config.strategy.maxPumpFunPositions) {
          this.trackSkip('social_pumpfun_slots_full'); logEvent('TREND_SKIP', { mint, reason: 'social_pumpfun_slots_full', protocol: 'pumpfun', current: this.pumpFunCount, max: config.strategy.maxPumpFunPositions });
          return;
        }
        const bondingCurve = getBondingCurvePDA(mintPub);
        const syntheticToken: PumpToken = {
          mint, creator: '', bondingCurve: bondingCurve.toBase58(),
          bondingCurveTokenAccount: '', signature: '', receivedAt: Date.now(),
        };
        await this.executePendingBuy(syntheticToken);
      } else {
        logger.info(`[trend] Unknown protocol for social discovery ${mint.slice(0, 8)}: ${protocol.protocol}, skipping`);
        this.trackSkip('social_unknown_protocol'); logEvent('TREND_SKIP', { mint, reason: 'social_unknown_protocol', protocol: protocol.protocol });
      }
    } catch (err) {
      logger.error(`[trend] Social discovery buy failed for ${mint}:`, err);
    } finally {
      this.trendTracker.remove(mint);
      this.trendTokenData.delete(mint);
    }
  }

  private async onTrendStrengthening(mint: string, metrics: TrendMetrics) {
    if (!this.running) return;
    const position = this.positions.get(mint);
    if (!position) return;
    if (this.addOnBuyDone.has(mint)) return;
    if (this.sellingMints.has(mint)) return;

    if (position.pnlPercent > 0) {
      logger.info(
        `📈📈 TREND ADD-ON: ${mint.slice(0, 8)} strengthening — ` +
        `buyers=${metrics.uniqueBuyers} vol=${metrics.buyVolumeSol.toFixed(3)} pnl=${position.pnlPercent.toFixed(1)}%`
      );
      logEvent('TREND_ADDON', { ...metrics, pnl: position.pnlPercent });
      this.addOnBuyDone.add(mint);
      this.executeAddOnBuy(position, mint).catch(err =>
        logger.error(`[trend] Add-on buy failed for ${mint}:`, err)
      );
    }
  }

  private async onTrendWeakening(mint: string, metrics: TrendMetrics) {
    if (!this.running) return;
    const position = this.positions.get(mint);
    if (!position) return;
    if (this.sellingMints.has(mint)) return;

    // Только для позиций с отрицательным PnL или маленьким плюсом — не продаём растущие позиции
    if (position.pnlPercent > 5) return;

    logger.info(
      `📉 TREND EXIT: ${mint.slice(0, 8)} weakening — ` +
      `ratio=${metrics.buySellRatio.toFixed(1)} pnl=${position.pnlPercent.toFixed(1)}%`
    );
    logEvent('TREND_EXIT', { ...metrics, pnl: position.pnlPercent });

    const acquired = await this.sellingMutex.runExclusive(() => {
      if (this.sellingMints.has(mint)) return false;
      this.sellingMints.add(mint);
      return true;
    });
    if (!acquired) return;

    this.executeFullSell(position, mint, {
      action: 'full',
      reason: 'velocity_drop',
      urgent: false,
    }).catch(err => logger.error(`[trend] Weakening sell failed for ${mint}:`, err));
  }

  private onSocialDiscovery(sig: PhaseSocialSignal) {
    if (!config.trend.enabled || !config.trend.socialDiscoveryEnabled) return;
    if (!sig.mint) return;

    const mint = sig.mint;
    if (this.positions.has(mint)) return;
    if (this.seenMints.has(mint)) {
      // Токен уже известен через geyser — просто обновляем trend tracker
      if (this.trendTracker.isTracking(mint)) {
        this.trendTracker.recordSocialSignal(mint, true);
      }
      return;
    }
    if (this.trendTracker.trackedCount >= config.trend.socialMaxTrackedMints) return;

    // Новый mint обнаружен через social — начинаем отслеживать
    this.seenMints.set(mint, Date.now());
    this.trendTracker.track(mint, 'unknown');
    this.trendTracker.recordSocialSignal(mint, true);

    logger.info(
      `🔍 SOCIAL DISCOVERY: ${mint.slice(0, 8)} from ${sig.source} ` +
      `(${sig.author ?? 'unknown'}) — tracking for trend confirmation`
    );
    logEvent('SOCIAL_DISCOVERY', { mint, source: sig.source, author: sig.author, sentiment: sig.sentiment });

    // Начинаем RPC-polling для определения протокола и динамики цены
    this.pollSocialDiscoveryMint(mint).catch(err =>
      logger.debug(`[trend] Social discovery polling failed for ${mint}:`, err)
    );
  }

  private async pollSocialDiscoveryMint(mint: string) {
    const mintPub = new PublicKey(mint);
    const intervalMs = config.trend.socialPollIntervalMs;
    const maxPolls = Math.ceil(config.trend.raydiumTimeoutMs / intervalMs);

    for (let i = 0; i < maxPolls; i++) {
      if (!this.trendTracker.isTracking(mint)) return;
      if (this.positions.has(mint)) return;

      try {
        const protocol = await detectProtocol(this.connection, mintPub);
        if (protocol.protocol !== 'unknown') {
          // Обновляем протокол в трекере
          this.trendTracker.remove(mint);
          this.trendTracker.track(mint, protocol.protocol);
          this.trendTracker.recordSocialSignal(mint, true);
          logger.info(`[trend] Social discovery ${mint.slice(0, 8)}: detected protocol=${protocol.protocol}`);
          return;
        }
      } catch {
        // RPC error — try again next interval
      }

      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  // ═══ Auto-Alpha: Pre-Launch Watcher Auto-Population ═══════════════════════

  // Track per-mint signal sources: mint → Set of unique "source:channel" keys
  private autoAlphaSources: Map<string, { sources: Set<string>; firstSeen: number; lastSig: PhaseSocialSignal }> = new Map();

  private tryAddToPreLaunch(sig: PhaseSocialSignal, reason: string): void {
    if (!sig.mint) return;
    if (this.positions.has(sig.mint)) return;
    if (this.sellingMints.has(sig.mint)) return;
    if (this.preLaunchWatcher.matchMint(sig.mint)) return;

    const autoAlphaCfg = (config.trend as any).autoAlpha;
    const maxCandidates = autoAlphaCfg?.maxCandidates ?? 20;
    if (this.preLaunchWatcher.activeCount >= maxCandidates) return;

    const ttlMs = reason === 'alpha'
      ? 24 * 60 * 60 * 1000
      : (autoAlphaCfg?.ttlMs ?? 3_600_000);

    const sourceLabel = sig.author ? `${sig.source}:${sig.author}` : sig.source;

    const id = this.preLaunchWatcher.add({
      ticker: sig.ticker,
      mint: sig.mint,
      source: sig.source,
      notes: `auto-${reason} via ${sourceLabel}${sig.followers ? ` (${sig.followers} subs)` : ''}`,
    }, ttlMs);

    logger.info(
      `[prelaunch] ⚡ Auto-added (${reason}): ${sig.ticker ?? sig.mint.slice(0, 8)} ` +
      `via ${sourceLabel} ttl=${Math.round(ttlMs / 60000)}m active=${this.preLaunchWatcher.activeCount}/${maxCandidates}`
    );
    logEvent('AUTO_ALPHA_ADDED', {
      mint: sig.mint, ticker: sig.ticker, source: sig.source,
      channel: sig.author, followers: sig.followers, reason,
      activeCount: this.preLaunchWatcher.activeCount,
    });
  }

  private evaluateAutoAlpha(sig: PhaseSocialSignal): void {
    const cfg = (config.trend as any).autoAlpha;
    if (!cfg?.enabled) return;
    if (!sig.mint) return;
    if (this.positions.has(sig.mint)) return;
    if (this.preLaunchWatcher.matchMint(sig.mint)) return;

    const mint = sig.mint;
    const sourceKey = sig.author ? `${sig.source}:${sig.author}` : sig.source;
    const now = Date.now();
    const lookbackMs = cfg.lookbackMs ?? 600_000;

    // DexScreener boost = paid promotion → автоматический alpha сигнал
    if (sig.source === 'dexscreener') {
      this.tryAddToPreLaunch(sig, 'dexscreener_boost');
      return;
    }

    // Track unique sources per mint
    let entry = this.autoAlphaSources.get(mint);
    if (!entry || (now - entry.firstSeen > lookbackMs)) {
      entry = { sources: new Set(), firstSeen: now, lastSig: sig };
      this.autoAlphaSources.set(mint, entry);
    }
    entry.sources.add(sourceKey);
    entry.lastSig = sig;

    const uniqueSources = entry.sources.size;

    // Criterion 1: Cross-source confirmation — mint упоминается в 2+ разных каналах/лентах
    if (uniqueSources >= (cfg.minMentions ?? 2)) {
      const channels = [...entry.sources].join(', ');
      this.tryAddToPreLaunch(sig, `cross_source_${uniqueSources}x`);
      logEvent('AUTO_ALPHA_CROSS_SOURCE', { mint, channels, count: uniqueSources });
      this.autoAlphaSources.delete(mint);
      return;
    }

    // Criterion 2: Large channel (5k+ subs TG, or high-follower Twitter)
    if (sig.followers && sig.followers >= (cfg.minFollowers ?? 5000)) {
      if (sig.sentiment >= (cfg.positiveSentimentMin ?? 0.2)) {
        this.tryAddToPreLaunch(sig, `large_channel_${sig.followers}`);
        this.autoAlphaSources.delete(mint);
        return;
      }
    }

    // Cleanup expired entries
    if (this.autoAlphaSources.size > 1000) {
      for (const [k, v] of this.autoAlphaSources) {
        if (now - v.firstSeen > lookbackMs) this.autoAlphaSources.delete(k);
      }
    }
  }

  // ═══ Raydium Event Handlers ════════════════════════════════════════════════

  private async onRaydiumLaunchCreate(event: RaydiumLaunchCreate) {
    if (!this.running) return;
    if (this.positions.size >= config.strategy.maxPositions) return;
    if (this.raydiumLaunchCount >= config.strategy.maxRaydiumLaunchPositions) return;

    const mintStr = event.mint;
    if (this.seenMints.has(mintStr)) return;
    if (this.positions.has(mintStr)) return;
    if (this.pendingBuys.has(mintStr)) return;
    if (this.failedSellMints.has(mintStr)) return;

    this.seenMints.set(mintStr, Date.now());

    dossier.recordSeen(mintStr, 'raydium_launch_create', { creator: event.creator });
    dossier.recordProtocol(mintStr, { protocol: 'raydium-launch', poolPda: event.pool });

    logger.info(`🚀 RAYDIUM LAUNCH CREATE: ${mintStr.slice(0, 8)}, pool=${event.pool.slice(0, 8)}`);
    logEvent('RAYDIUM_LAUNCH_CREATE', { mint: mintStr, pool: event.pool, creator: event.creator });

    const mint = new PublicKey(mintStr);
    updateMintState(mint, {
      isRaydiumLaunch: true,
      raydiumPool: new PublicKey(event.pool),
      creator: new PublicKey(event.creator),
    });
    this.raydiumPoolToMint.set(event.pool, { mint: mintStr, protocol: 'raydium-launch' });

    // ── Watchlist check ──
    const plMintLl    = this.preLaunchWatcher.matchMint(mintStr);
    const plCreatorLl = !plMintLl ? this.preLaunchWatcher.matchCreator(event.creator) : null;
    const plMatchLl   = plMintLl ?? plCreatorLl;

    if (plMatchLl) {
      logger.info(`🎯 PRE-LAUNCH HIT (LaunchLab): ${mintStr.slice(0, 8)} ticker=${plMatchLl.ticker ?? '-'}`);
      logEvent('PRELAUNCH_HIT', { mint: mintStr, id: plMatchLl.id, protocol: 'raydium-launch' });
      this.preLaunchWatcher.markFired(plMatchLl.id, mintStr);

      const plLlCfg = config.strategy.raydiumLaunch;
      const plLlExposure = [...this.positions.values()].reduce((s, p) => s + p.entryAmountSol, 0);
      if (plLlExposure < config.strategy.maxTotalExposureSol) {
        if (config.strategy.enableRugcheck) {
          const plLlRug = await checkRugcheck(mintStr).catch(() => null);
          if (plLlRug?.risk === 'high') {
            logEvent('PRELAUNCH_SKIP_RUGCHECK', { mint: mintStr, protocol: 'raydium-launch' });
            return;
          }
        }
        try {
          const txId = await buyTokenLaunchLab(this.connection, mint, this.payer, plLlCfg.entryAmountSol, plLlCfg.slippageBps);
          logEvent('PRELAUNCH_BUY_SENT', { mint: mintStr, protocol: 'raydium-launch', txId });
          this.confirmAndCreateRaydiumPosition(mint, txId, plLlCfg.entryAmountSol, 'raydium-launch').catch(() => {});
        } catch (err) {
          logger.error(`[prelaunch-launch] Buy failed for ${mintStr.slice(0, 8)}:`, err);
        }
        return;
      }
    }

    // Register in TrendTracker for trend-confirmed entry
    if (config.trend.enabled) {
      this.trendTracker.track(mintStr, 'raydium-launch');
      this.pushScoredToken({ mint: mintStr, protocol: 'raydium-launch', score: 0, shouldEnter: true, entryMultiplier: 1, reasons: ['trend:tracking'], rugcheckRisk: 'unknown', socialScore: 0 });
      logger.info(`📊 TREND TRACKING (Raydium LaunchLab): ${mintStr.slice(0, 8)} — waiting for trend confirmation`);
      logEvent('TREND_TRACKING', { mint: mintStr, protocol: 'raydium-launch', mode: 'B' });
    }
  }

  private recentLaunchLabSigs: Set<string> = new Set();

  private async onRaydiumLaunchBuy(event: RaydiumLaunchBuy) {
    if (!this.running) return;

    if (event.signature && this.recentLaunchLabSigs.has(event.signature)) return;
    if (event.signature) {
      this.recentLaunchLabSigs.add(event.signature);
      if (this.recentLaunchLabSigs.size > 2000) {
        const first = this.recentLaunchLabSigs.values().next().value;
        if (first !== undefined) this.recentLaunchLabSigs.delete(first);
      }
    }

    if (this.positions.size >= config.strategy.maxPositions) return;
    if (this.raydiumLaunchCount >= config.strategy.maxRaydiumLaunchPositions) return;

    const mintStr = event.mint;
    if (this.positions.has(mintStr)) return;
    if (this.raydiumMigrateBlockedMints.has(mintStr)) return;
    if (this.pendingRaydiumBuys.has(mintStr)) return;

    const solAmount = Number(event.amountSol) / 1e9;
    if (solAmount < config.strategy.minIndependentBuySol) return;

    // Авторегистрация mint при первом buy (CREATE может не прийти через geyser)
    if (!this.seenMints.has(mintStr)) {
      this.seenMints.set(mintStr, Date.now());
      const mintPub = new PublicKey(mintStr);
      updateMintState(mintPub, {
        isRaydiumLaunch: true,
        raydiumPool: event.pool ? new PublicKey(event.pool) : undefined,
        creator: event.buyer ? new PublicKey(event.buyer) : undefined,
      });
      logger.info(`Auto-registered Raydium LaunchLab mint from buy event: ${mintStr.slice(0,8)}`);
    }

    logger.info(`💰 RAYDIUM LAUNCH BUY: ${mintStr.slice(0, 8)}, sol=${solAmount.toFixed(4)}, buyer=${event.buyer.slice(0, 8)}`);
    logEvent('RAYDIUM_LAUNCH_BUY', { mint: mintStr, sol: solAmount, buyer: event.buyer });

    // Trend tracker: forward Raydium buy events
    if (config.trend.enabled) {
      this.trendTracker.recordBuy(mintStr, event.buyer, solAmount);
      // Auto-register in trend tracker if not yet tracking
      if (!this.trendTracker.isTracking(mintStr)) {
        this.trendTracker.track(mintStr, 'raydium-launch');
        logger.info(`📊 TREND TRACKING (Raydium LaunchLab from buy): ${mintStr.slice(0, 8)}`);
      }
      // In trend mode, don't buy immediately — wait for trend:confirmed
      return;
    }

    const mint = new PublicKey(mintStr);
    const cfg = config.strategy.raydiumLaunch;

    // ── Legacy path (trend disabled): Параллельная проверка rugcheck + balance ──
    const [rugResult, balance] = await Promise.all([
      config.strategy.enableRugcheck ? checkRugcheck(mintStr).catch(() => null) : Promise.resolve(null),
      this.getCachedBalance(),
    ]);
    if (rugResult && rugResult.risk === 'high') {
      logger.warn(`🛑 Raydium LaunchLab Rugcheck HIGH RISK — BLOCKING: ${mintStr.slice(0,8)} score=${rugResult.score}`);
      logEvent('RUGCHECK_BLOCKED', { mint: mintStr, score: rugResult.score, risks: rugResult.risks, path: 'raydium_launch' });
      return;
    }
    const minRequired = cfg.entryAmountSol + config.jito.tipAmountSol * 2 + 0.002;
    if (balance / 1e9 < minRequired) {
      logger.warn(`🚫 Raydium LaunchLab: insufficient balance ${(balance/1e9).toFixed(4)} < ${minRequired.toFixed(4)}`);
      return;
    }

    try {
      const txId = await buyTokenLaunchLab(
        this.connection, mint, this.payer, cfg.entryAmountSol, cfg.slippageBps,
      );
      logger.info(`🟢 Raydium LaunchLab buy sent: ${txId} for ${mintStr.slice(0, 8)}`);
      logEvent('RAYDIUM_LAUNCH_BUY_SENT', { mint: mintStr, txId });
      this.pendingRaydiumBuys.add(mintStr);
      this.confirmAndCreateRaydiumPosition(mint, txId, cfg.entryAmountSol, 'raydium-launch').catch(err =>
        logger.error(`[legacy-launch] Confirm error for ${mintStr}:`, err)
      );
    } catch (err) {
      if (err instanceof PoolMigratedError) {
        logEvent('RAYDIUM_LAUNCH_MIGRATED', { mint: mintStr, migrateType: err.migrateType });
        // CPMM is the default migration target regardless of migrateType field
        const attempts: Array<{ protocol: 'raydium-cpmm' | 'raydium-ammv4'; buy: () => Promise<string> }> = [
          { protocol: 'raydium-cpmm', buy: () => buyTokenCpmm(this.connection, mint, this.payer, config.strategy.raydiumCpmm.entryAmountSol, config.strategy.raydiumCpmm.slippageBps) },
          { protocol: 'raydium-ammv4', buy: () => buyTokenAmmV4(this.connection, mint, this.payer, config.strategy.raydiumAmmV4.entryAmountSol, config.strategy.raydiumAmmV4.slippageBps) },
        ];
        logger.info(`🔄 LaunchLab pool migrated for ${mintStr.slice(0, 8)}, trying CPMM then AMM v4`);
        // Pool indexing after graduation takes 8–15s; wait before lookup
        await new Promise(r => setTimeout(r, 8000));
        // Concurrent-handler dedup: another handler may have already bought this mint
        if (this.positions.has(mintStr) || this.raydiumMigrateBlockedMints.has(mintStr)) {
          logger.info(`Migration dedup for ${mintStr.slice(0, 8)}: already handled by concurrent handler`);
          return;
        }
        let bought = false;
        const POOL_RETRY_DELAYS = [0, 5000, 10000]; // immediate + 2 retries (5s, 10s)
        for (const { protocol, buy } of attempts) {
          if (bought) break;
          const cpmmCfg = protocol === 'raydium-cpmm' ? config.strategy.raydiumCpmm : config.strategy.raydiumAmmV4;
          for (let retry = 0; retry < POOL_RETRY_DELAYS.length; retry++) {
            if (retry > 0) {
              await new Promise(r => setTimeout(r, POOL_RETRY_DELAYS[retry]));
              if (this.positions.has(mintStr)) { bought = true; break; }
            }
            try {
              const txId = await buy();
              logger.info(`🟢 Raydium ${protocol} buy (migrated) sent: ${txId} for ${mintStr.slice(0, 8)}`);
              const position = new Position(
                mint, cpmmCfg.entryAmountSol, 0,
                { programId: protocol, quoteMint: config.wsolMint },
                6,
                { entryAmountSol: cpmmCfg.entryAmountSol, protocol, creator: event.buyer }
              );
              this.positions.set(mintStr, position);
              this.emitPositionOpen(position);
              this.confirmedPositions.add(mintStr);
              updateMintState(mint, {
                isRaydiumCpmm: protocol === 'raydium-cpmm',
                isRaydiumAmmV4: protocol === 'raydium-ammv4',
              });
              logger.info(`✅ RAYDIUM ${protocol.toUpperCase()} POSITION OPENED (migrated): ${mintStr.slice(0, 8)}`);
              logEvent('POSITION_OPENED', { mint: mintStr, protocol, entryAmountSol: cpmmCfg.entryAmountSol, migrated: true });
              bought = true;
              break;
            } catch (e) {
              const emsg = e instanceof Error ? e.message : String(e);
              if (emsg.includes('not found') && retry < POOL_RETRY_DELAYS.length - 1) {
                logger.warn(`Migrated ${protocol} pool not found for ${mintStr.slice(0, 8)} (retry ${retry + 1}), waiting...`);
              } else {
                logger.warn(`Migrated ${protocol} buy failed for ${mintStr.slice(0, 8)}: ${emsg}`);
                break;
              }
            }
          }
        }
        if (!bought) {
          logger.error(`Failed to buy migrated Raydium token ${mintStr.slice(0, 8)} via both CPMM and AMM v4`);
          this.raydiumMigrateBlockedMints.add(mintStr);
        }
      } else {
        logger.error(`Failed to buy Raydium LaunchLab token ${mintStr.slice(0, 8)}: ${err}`);
      }
    }
  }

  /**
   * Raydium LaunchLab creator_sell detection.
   * Symmetric to pump.fun/PumpSwap paths. See onPumpFunSellDetected for full rationale.
   */
  private async onRaydiumLaunchSell(sell: RaydiumLaunchSell): Promise<void> {
    if (!this.running) return;

    // Track for trend + wallet tracker regardless of creator check
    if (config.trend.enabled) {
      this.trendTracker.recordSell(sell.mint, sell.seller, 0);  // sol amount unknown from event
    }
    this.walletTracker.recordSell(sell.seller, sell.mint, Number(sell.amountTokens ?? 0));

    if (!config.strategy.creatorSellExit) return;

    const position = this.positions.get(sell.mint);
    if (!position) return;
    if (!position.creator) return;

    if (sell.seller === position.creator) {
      const minDrop = (config.strategy as any).creatorSellMinDropPct ?? 0;
      const currentPnl = position.pnlPercent;
      if (minDrop > 0 && currentPnl > -minDrop) {
        logger.info(`🔕 Creator sell IGNORED [Raydium Launch]: ${sell.mint.slice(0,8)} — PnL ${currentPnl.toFixed(2)}% > -${minDrop}% threshold`);
        logEvent('CREATOR_SELL_IGNORED', { mint: sell.mint, pnlPct: currentPnl, threshold: minDrop, protocol: position.protocol });
        return;
      }

      logger.warn(`🚨 CREATOR SELL DETECTED [Raydium Launch]: ${sell.mint.slice(0,8)}, seller=${sell.seller.slice(0,8)}, pnl=${currentPnl.toFixed(2)}%, tx=${sell.signature.slice(0,8)}`);
      logEvent('CREATOR_SELL', { mint: sell.mint, seller: sell.seller, pnlPct: currentPnl, protocol: position.protocol, tx: sell.signature });

      this.creatorSellSeen.add(sell.mint);

      const acquired = await this.sellingMutex.runExclusive(() => {
        if (this.sellingMints.has(sell.mint)) return false;
        this.sellingMints.add(sell.mint);
        return true;
      });
      if (!acquired) return;

      this.executeFullSell(position, sell.mint, {
        action: 'full',
        reason: 'creator_sell',
        urgent: true,
      }).catch(err => logger.error(`Raydium Launch creator sell execution failed for ${sell.mint.slice(0,8)}:`, err));
    }
  }

  private async onRaydiumCpmmNewPool(event: RaydiumCpmmNewPool) {
    if (!this.running) return;
    if (this.positions.size >= config.strategy.maxPositions) return;
    if (this.raydiumCpmmCount >= config.strategy.maxRaydiumCpmmPositions) return;

    const mintStr = event.mint;
    if (this.seenMints.has(mintStr)) return;
    if (this.positions.has(mintStr)) return;
    if (this.failedSellMints.has(mintStr)) return;

    this.seenMints.set(mintStr, Date.now());

    dossier.recordSeen(mintStr, 'raydium_cpmm_new_pool', { creator: event.creator });
    dossier.recordProtocol(mintStr, { protocol: 'raydium-cpmm', poolPda: event.pool });

    logger.info(`🆕 RAYDIUM CPMM NEW POOL: ${mintStr.slice(0, 8)}, pool=${event.pool.slice(0, 8)}`);
    logEvent('RAYDIUM_CPMM_NEW_POOL', { mint: mintStr, pool: event.pool, creator: event.creator });

    const mint = new PublicKey(mintStr);
    updateMintState(mint, {
      isRaydiumCpmm: true,
      raydiumPool: new PublicKey(event.pool),
    });
    this.raydiumPoolToMint.set(event.pool, { mint: mintStr, protocol: 'raydium-cpmm' });

    // Baseline для entry momentum — async fetch reserves (не блокируем entry flow)
    resolveCpmmPool(this.connection, mint, new PublicKey(event.pool)).then(({ solReserve, tokenReserve }) => {
      if (tokenReserve > 0n) {
        this.mintFirstSeenPrice.set(mintStr, { price: Number(solReserve) / Number(tokenReserve), ts: Date.now() });
      }
    }).catch(() => {});

    // ── Watchlist check ──
    const plMintCpmm    = this.preLaunchWatcher.matchMint(mintStr);
    const plCreatorCpmm = !plMintCpmm && event.creator ? this.preLaunchWatcher.matchCreator(event.creator) : null;
    const plMatchCpmm   = plMintCpmm ?? plCreatorCpmm;

    if (plMatchCpmm) {
      logger.info(`🎯 PRE-LAUNCH HIT (CPMM): ${mintStr.slice(0, 8)} ticker=${plMatchCpmm.ticker ?? '-'}`);
      logEvent('PRELAUNCH_HIT', { mint: mintStr, id: plMatchCpmm.id, protocol: 'raydium-cpmm' });
      this.preLaunchWatcher.markFired(plMatchCpmm.id, mintStr);

      const plCpmmCfg = config.strategy.raydiumCpmm;
      const plCpmmExposure = [...this.positions.values()].reduce((s, p) => s + p.entryAmountSol, 0);
      if (plCpmmExposure < config.strategy.maxTotalExposureSol) {
        if (config.strategy.enableRugcheck) {
          const plCpmmRug = await checkRugcheck(mintStr).catch(() => null);
          if (plCpmmRug?.risk === 'high') {
            logEvent('PRELAUNCH_SKIP_RUGCHECK', { mint: mintStr, protocol: 'raydium-cpmm' });
            return;
          }
        }
        try {
          const txId = await buyTokenCpmm(this.connection, mint, this.payer, plCpmmCfg.entryAmountSol, plCpmmCfg.slippageBps);
          logEvent('PRELAUNCH_BUY_SENT', { mint: mintStr, protocol: 'raydium-cpmm', txId });
          this.confirmAndCreateRaydiumPosition(mint, txId, plCpmmCfg.entryAmountSol, 'raydium-cpmm').catch(() => {});
        } catch (err) {
          logger.error(`[prelaunch-cpmm] Buy failed for ${mintStr.slice(0, 8)}:`, err);
        }
        return;
      }
    }

    // ── Trend gate: регистрируем и ждём подтверждения тренда ──
    if (config.trend.enabled) {
      this.trendTracker.track(mintStr, 'raydium-cpmm');
      this.trendTokenData.set(mintStr, { mint: mintStr, creator: event.creator ?? '', bondingCurve: '', bondingCurveTokenAccount: '', signature: '', receivedAt: Date.now() } as any);
      this.pushScoredToken({ mint: mintStr, protocol: 'raydium-cpmm', score: 0, shouldEnter: true, entryMultiplier: 1, reasons: ['trend:tracking'], rugcheckRisk: 'unknown', socialScore: 0 });
      logger.debug(`[trend] Raydium CPMM ${mintStr.slice(0, 8)} → tracking, waiting for trend confirmation`);
      return;
    }

    const cfg = config.strategy.raydiumCpmm;

    // ── Параллельная проверка rugcheck + balance ──
    const [rugResultCpmm, balanceCpmm] = await Promise.all([
      config.strategy.enableRugcheck ? checkRugcheck(mintStr).catch(() => null) : Promise.resolve(null),
      this.getCachedBalance(),
    ]);
    if (rugResultCpmm && rugResultCpmm.risk === 'high') {
      logger.warn(`🛑 Raydium CPMM Rugcheck HIGH RISK — BLOCKING: ${mintStr.slice(0,8)} score=${rugResultCpmm.score}`);
      logEvent('RUGCHECK_BLOCKED', { mint: mintStr, score: rugResultCpmm.score, risks: rugResultCpmm.risks, path: 'raydium_cpmm' });
      return;
    }
    const minRequiredCpmm = cfg.entryAmountSol + config.jito.tipAmountSol * 2 + 0.002;
    if (balanceCpmm / 1e9 < minRequiredCpmm) {
      logger.warn(`🚫 Raydium CPMM: insufficient balance ${(balanceCpmm/1e9).toFixed(4)} < ${minRequiredCpmm.toFixed(4)}`);
      return;
    }

    try {
      const txId = await buyTokenCpmm(
        this.connection, mint, this.payer, cfg.entryAmountSol, cfg.slippageBps,
      );
      logger.info(`🟢 Raydium CPMM buy sent: ${txId} for ${mintStr.slice(0, 8)}`);
      logEvent('RAYDIUM_CPMM_BUY_SENT', { mint: mintStr, txId });
      this.pendingRaydiumBuys.add(mintStr);
      this.confirmAndCreateRaydiumPosition(mint, txId, cfg.entryAmountSol, 'raydium-cpmm').catch(err =>
        logger.error(`[legacy-cpmm] Confirm error for ${mintStr}:`, err)
      );
    } catch (err) {
      logger.error(`Failed to buy Raydium CPMM token ${mintStr.slice(0, 8)}: ${err}`);
    }
  }

  private async onRaydiumAmmV4NewPool(event: RaydiumAmmV4NewPool) {
    if (!this.running) return;
    if (this.positions.size >= config.strategy.maxPositions) return;
    if (this.raydiumAmmV4Count >= config.strategy.maxRaydiumAmmV4Positions) return;

    const mintStr = event.baseMint;
    if (this.seenMints.has(mintStr)) return;
    if (this.positions.has(mintStr)) return;
    if (this.failedSellMints.has(mintStr)) return;

    // Только wSOL-пары
    if (event.quoteMint !== config.wsolMint) return;

    this.seenMints.set(mintStr, Date.now());

    dossier.recordSeen(mintStr, 'raydium_ammv4_new_pool', {});
    dossier.recordProtocol(mintStr, { protocol: 'raydium-ammv4', poolPda: event.pool, poolQuoteMint: event.quoteMint });

    logger.info(`🆕 RAYDIUM AMM V4 NEW POOL: ${mintStr.slice(0, 8)}, pool=${event.pool.slice(0, 8)}`);
    logEvent('RAYDIUM_AMM_V4_NEW_POOL', { mint: mintStr, pool: event.pool });

    const mint = new PublicKey(mintStr);
    updateMintState(mint, {
      isRaydiumAmmV4: true,
      raydiumPool: new PublicKey(event.pool),
    });
    this.raydiumPoolToMint.set(event.pool, { mint: mintStr, protocol: 'raydium-ammv4' });

    // Baseline для entry momentum — async fetch reserves
    resolveAmmV4Pool(this.connection, mint, new PublicKey(event.pool)).then(({ solReserve, tokenReserve }) => {
      if (tokenReserve > 0n) {
        this.mintFirstSeenPrice.set(mintStr, { price: Number(solReserve) / Number(tokenReserve), ts: Date.now() });
      }
    }).catch(() => {});

    // ── Watchlist check ──
    const plMintV4    = this.preLaunchWatcher.matchMint(mintStr);
    const plMatchV4   = plMintV4;

    if (plMatchV4) {
      logger.info(`🎯 PRE-LAUNCH HIT (AMM v4): ${mintStr.slice(0, 8)} ticker=${plMatchV4.ticker ?? '-'}`);
      logEvent('PRELAUNCH_HIT', { mint: mintStr, id: plMatchV4.id, protocol: 'raydium-ammv4' });
      this.preLaunchWatcher.markFired(plMatchV4.id, mintStr);

      const plV4Cfg = config.strategy.raydiumAmmV4;
      const plV4Exposure = [...this.positions.values()].reduce((s, p) => s + p.entryAmountSol, 0);
      if (plV4Exposure < config.strategy.maxTotalExposureSol) {
        if (config.strategy.enableRugcheck) {
          const plV4Rug = await checkRugcheck(mintStr).catch(() => null);
          if (plV4Rug?.risk === 'high') {
            logEvent('PRELAUNCH_SKIP_RUGCHECK', { mint: mintStr, protocol: 'raydium-ammv4' });
            return;
          }
        }
        try {
          const txId = await buyTokenAmmV4(this.connection, mint, this.payer, plV4Cfg.entryAmountSol, plV4Cfg.slippageBps);
          logEvent('PRELAUNCH_BUY_SENT', { mint: mintStr, protocol: 'raydium-ammv4', txId });
          this.confirmAndCreateRaydiumPosition(mint, txId, plV4Cfg.entryAmountSol, 'raydium-ammv4').catch(() => {});
        } catch (err) {
          logger.error(`[prelaunch-ammv4] Buy failed for ${mintStr.slice(0, 8)}:`, err);
        }
        return;
      }
    }

    // ── Trend gate: регистрируем и ждём подтверждения тренда ──
    if (config.trend.enabled) {
      this.trendTracker.track(mintStr, 'raydium-ammv4');
      this.trendTokenData.set(mintStr, { mint: mintStr, creator: '', bondingCurve: '', bondingCurveTokenAccount: '', signature: '', receivedAt: Date.now() } as any);
      this.pushScoredToken({ mint: mintStr, protocol: 'raydium-ammv4', score: 0, shouldEnter: true, entryMultiplier: 1, reasons: ['trend:tracking'], rugcheckRisk: 'unknown', socialScore: 0 });
      logger.debug(`[trend] Raydium AMM v4 ${mintStr.slice(0, 8)} → tracking, waiting for trend confirmation`);
      return;
    }

    const cfg = config.strategy.raydiumAmmV4;

    // ── Параллельная проверка rugcheck + balance ──
    const [rugResultV4, balanceV4] = await Promise.all([
      config.strategy.enableRugcheck ? checkRugcheck(mintStr).catch(() => null) : Promise.resolve(null),
      this.getCachedBalance(),
    ]);
    if (rugResultV4 && rugResultV4.risk === 'high') {
      logger.warn(`🛑 Raydium AMM v4 Rugcheck HIGH RISK — BLOCKING: ${mintStr.slice(0,8)} score=${rugResultV4.score}`);
      logEvent('RUGCHECK_BLOCKED', { mint: mintStr, score: rugResultV4.score, risks: rugResultV4.risks, path: 'raydium_ammv4' });
      return;
    }
    const minRequiredV4 = cfg.entryAmountSol + config.jito.tipAmountSol * 2 + 0.002;
    if (balanceV4 / 1e9 < minRequiredV4) {
      logger.warn(`🚫 Raydium AMM v4: insufficient balance ${(balanceV4/1e9).toFixed(4)} < ${minRequiredV4.toFixed(4)}`);
      return;
    }

    try {
      const txId = await buyTokenAmmV4(
        this.connection, mint, this.payer, cfg.entryAmountSol, cfg.slippageBps,
      );
      logger.info(`🟢 Raydium AMM v4 buy sent: ${txId} for ${mintStr.slice(0, 8)}`);
      logEvent('RAYDIUM_AMM_V4_BUY_SENT', { mint: mintStr, txId });
      this.pendingRaydiumBuys.add(mintStr);
      this.confirmAndCreateRaydiumPosition(mint, txId, cfg.entryAmountSol, 'raydium-ammv4').catch(err =>
        logger.error(`[legacy-ammv4] Confirm error for ${mintStr}:`, err)
      );
    } catch (err) {
      logger.error(`Failed to buy Raydium AMM v4 token ${mintStr.slice(0, 8)}: ${err}`);
    }
  }

  private startMonitoring() {
    if (this.monitoringInterval) clearTimeout(this.monitoringInterval);
    // 2000ms base + random jitter 0-500ms = 2000-2500ms effective.
    // gRPC account subscriptions deliver real-time updates; this polling is a fallback
    // for missed updates. Reduced from 600ms to save ~70% RPC credits.
    const scheduleNext = () => {
      const jitter = Math.floor(Math.random() * 500);
      this.monitoringInterval = setTimeout(() => {
        this.checkPositions().finally(scheduleNext);
      }, 2000 + jitter);
    };
    scheduleNext();
    logger.info('Position monitoring started (interval 2000-2500ms with jitter)');
  }

  private stopMonitoring() {
    if (this.monitoringInterval) {
      clearTimeout(this.monitoringInterval);
      this.monitoringInterval = null;
      logger.info('Position monitoring stopped');
    }
  }

  private async checkPositions() {
    if (!this.running || this.isCheckingPositions) return;
    this.isCheckingPositions = true;
    try {
      const keys = Array.from(this.positions.keys());
      if (keys.length === 0) return;

      // ── Batch RPC: собираем все нужные аккаунты и делаем 1 getMultipleAccounts ──
      // Вместо N sequential getAccountInfo/getTokenAccountBalance = 1 batch RPC call.
      const accountKeys: PublicKey[] = [];
      const accountMap: { mintStr: string; type: string; idx: number }[] = [];

      for (const mintStr of keys) {
        const position = this.positions.get(mintStr);
        if (!position) continue;

        if (position.protocol === 'pump.fun' || position.protocol === 'mayhem') {
          const bc = getBondingCurvePDA(position.mint);
          accountMap.push({ mintStr, type: 'pump_bc', idx: accountKeys.length });
          accountKeys.push(bc);
        } else if (position.protocol === 'pumpswap') {
          const state = getMintState(position.mint);
          if (state.poolBaseTokenAccount && state.poolQuoteTokenAccount) {
            accountMap.push({ mintStr, type: 'swap_base', idx: accountKeys.length });
            accountKeys.push(state.poolBaseTokenAccount);
            accountMap.push({ mintStr, type: 'swap_quote', idx: accountKeys.length });
            accountKeys.push(state.poolQuoteTokenAccount);
          }
        } else if (position.protocol === 'raydium-launch') {
          const state = getMintState(position.mint);
          if (state.raydiumPool) {
            accountMap.push({ mintStr, type: 'ray_launch', idx: accountKeys.length });
            accountKeys.push(state.raydiumPool);
          }
        } else if (position.protocol === 'raydium-cpmm' || position.protocol === 'raydium-ammv4') {
          // CPMM/AMMv4 need pool + 2 vault balances = 3 accounts; fall back to sequential
          accountMap.push({ mintStr, type: 'ray_fallback', idx: -1 });
        }
      }

      // One batch RPC call for all positions
      let batchResults: (import('@solana/web3.js').AccountInfo<Buffer> | null)[] = [];
      if (accountKeys.length > 0) {
        try {
          batchResults = await withRpcLimit(() =>
            this.connection.getMultipleAccountsInfo(accountKeys, { commitment: 'processed' })
          );
        } catch (err) {
          logger.warn('Batch getMultipleAccounts failed, falling back to sequential', err);
          // Fall back to sequential on error
          batchResults = new Array(accountKeys.length).fill(null);
        }
      }

      // ── Parse results per position ──
      const swapBaseByMint = new Map<string, bigint>();
      const swapQuoteByMint = new Map<string, bigint>();

      for (const entry of accountMap) {
        const position = this.positions.get(entry.mintStr);
        if (!position) continue;

        try {
          if (entry.type === 'pump_bc') {
            const accInfo = batchResults[entry.idx];
            if (!accInfo) { position.updateErrors++; continue; }
            const layout = getRuntimeLayout();
            const tokenOffset = layout.bondingCurve?.tokenReserveOffset ?? 8;
            const solOffset = layout.bondingCurve?.solReserveOffset ?? 16;
            const vSol = accInfo.data.readBigUInt64LE(solOffset);
            const vToken = accInfo.data.readBigUInt64LE(tokenOffset);
            position.updatePrice(safeNumber(vSol, 'vSol'), safeNumber(vToken, 'vToken'));
	    this.emit('position:update', {
	      mint: position.mint.toBase58(),
	      currentPrice: position.currentPrice,
	      pnlPercent: position.pnlPercent,
	    });
            position.updateErrors = 0;
          } else if (entry.type === 'swap_base') {
            const accInfo = batchResults[entry.idx];
            if (accInfo && accInfo.data.length >= 72) {
              swapBaseByMint.set(entry.mintStr, accInfo.data.readBigUInt64LE(64));
            }
          } else if (entry.type === 'swap_quote') {
            const accInfo = batchResults[entry.idx];
            if (accInfo && accInfo.data.length >= 72) {
              swapQuoteByMint.set(entry.mintStr, accInfo.data.readBigUInt64LE(64));
            }
            // Now we have both base and quote for this PumpSwap position
            const base = swapBaseByMint.get(entry.mintStr);
            const quote = swapQuoteByMint.get(entry.mintStr);
            if (base !== undefined && quote !== undefined) {
              const mintState = getMintState(position.mint);
              const isMemeBase = mintState.isMemeBase !== false;
              const solRes = isMemeBase ? Number(quote) : Number(base);
              const tokenRes = isMemeBase ? Number(base) : Number(quote);
              position.updatePrice(solRes, tokenRes);
              position.updateErrors = 0;
            } else {
              position.updateErrors++;
            }
          } else if (entry.type === 'ray_launch') {
            const accInfo = batchResults[entry.idx];
            if (accInfo) {
              const pool = parseLaunchLabPool(accInfo.data);
              position.updatePrice(Number(pool.virtualB), Number(pool.virtualA));
              position.updateErrors = 0;
            } else {
              position.updateErrors++;
            }
          } else if (entry.type === 'ray_fallback') {
            // Sequential fallback for CPMM/AMMv4 (need vault balances)
            try {
              const reserves = await this.getRaydiumReserves(position);
              if (reserves) {
                position.updatePrice(safeNumber(reserves.solReserve, 'solRes'), safeNumber(reserves.tokenReserve, 'tokenRes'));
                position.updateErrors = 0;
              } else {
                position.updateErrors++;
              }
            } catch {
              position.updateErrors++;
            }
          }
        } catch (err) {
          position.updateErrors++;
          logger.debug(`Error parsing batch result for ${entry.mintStr}:`, err);
        }
      }

      // ── Evaluate sell decisions ──
      for (const mintStr of keys) {
        const position = this.positions.get(mintStr);
        if (!position) continue;

        if (position.updateErrors > 5) {
          setImmediate(() => {
            this.executeFullSell(position, mintStr, { action: 'full', reason: 'rpc_error', urgent: false });
          });
          continue;
        }

        logger.debug(
          `${mintStr}: price=${position.currentPrice.toFixed(12)} pnl=${position.pnlPercent.toFixed(1)}% max=${position.maxPrice.toFixed(12)}`
        );

        // ── Whale sell detection: periodic top holder check ──
        const wsCfg: any = (config.strategy as any).whaleSell;
        if (wsCfg?.enabled && !this.sellingMints.has(mintStr)) {
          const posAge = Date.now() - position.openedAt;
          const sinceLastCheck = Date.now() - position.whaleLastCheckTs;
          if (posAge >= (wsCfg.minPositionAgeMs ?? 10_000) && sinceLastCheck >= (wsCfg.checkIntervalMs ?? 30_000)) {
            this.checkWhaleActivity(position, mintStr).catch(() => {});
          }
        }

        // ── Jupiter pre-warm (brainstorm v4): speculatively fetch quote ──
        const cached = this.jupiterQuoteCache.get(mintStr);
        const needsWarm = !cached || Date.now() - cached.fetchedAt > Sniper.JUP_QUOTE_TTL;
        if (needsWarm && (position.pnlPercent > 50 || Date.now() - position.openedAt > 30_000)) {
          const tokenAmount = BigInt(Math.floor(position.amount * 10 ** position.tokenDecimals));
          if (tokenAmount > 0n) {
            getJupiterQuote(mintStr, tokenAmount).then(result => {
              if (result) {
                if (this.jupiterQuoteCache.size >= Sniper.JUP_CACHE_MAX) {
                  const oldest = this.jupiterQuoteCache.keys().next().value;
                  if (oldest !== undefined) this.jupiterQuoteCache.delete(oldest);
                }
                this.jupiterQuoteCache.set(mintStr, { quote: result.quoteResponse, fetchedAt: Date.now() });
              }
            }).catch(() => {}); // fire-and-forget
          }
        }

        const decision = position.shouldSell(logger);
        if (decision.action !== 'none') {
          setImmediate(() => {
            this.evaluateAndActOnDecision(position, mintStr, decision);
          });
        }
      }
    } finally {
      this.isCheckingPositions = false;
    }
  }

  private async executeFullSell(position: Position, mintStr: string, decision: SellDecision) {
    // Guard removed: mutex-callers add to sellingMints before calling;
    // the old `if (has) return` was blocking ALL mutex-guarded sells.
    // add() is idempotent — safe for callers that already added.
    this.sellingMints.add(mintStr);
    try {
      const closedAt = Date.now();
      const mintPk = new PublicKey(mintStr);

      // ── Ensure MintState has correct protocol flags for sell routing ──
      // Without this, sellTokenAuto falls through to pump.fun path and fails
      // with "Bonding curve not found" for PumpSwap/Raydium positions.
      this.ensureMintStateForSell(mintPk, position);

      // ── FIX #3: Перед sell читаем РЕАЛЬНЫЙ баланс ATA ──────────────────────
      // Optimistic position.amount может не совпадать с ATA (buy через mempool).
      // Если ATA пуст — позиция уже продана или buy не приземлился → удаляем.
      let realAmountRaw: bigint;
      try {
        const mintState = getMintState(mintPk);
        if (!mintState.tokenProgramId) {
          const mInfo = await withRpcLimit(() => this.connection.getAccountInfo(mintPk));
          if (mInfo) mintState.tokenProgramId = mInfo.owner;
        }
        if (mintState.tokenProgramId) {
          const ata = await getAssociatedTokenAddress(mintPk, this.payer.publicKey, false, mintState.tokenProgramId);
          let ataInfo = await withRpcLimit(() => this.connection.getTokenAccountBalance(ata));
          let ataAmount = ataInfo?.value ? BigInt(ataInfo.value.amount) : 0n;
          // ATA race condition fix: buy TX may not have propagated yet.
          // Retry up to 2 times with 500ms delay before declaring phantom.
          if (ataAmount === 0n) {
            for (let ataRetry = 0; ataRetry < 2; ataRetry++) {
              await new Promise(r => setTimeout(r, 500));
              ataInfo = await withRpcLimit(() => this.connection.getTokenAccountBalance(ata));
              ataAmount = ataInfo?.value ? BigInt(ataInfo.value.amount) : 0n;
              if (ataAmount > 0n) {
                logger.info(`ATA populated after ${(ataRetry + 1) * 500}ms delay for ${mintStr.slice(0,8)}`);
                break;
              }
            }
          }
          if (ataAmount === 0n) {
            logger.warn(`🗑️ ATA empty before sell for ${mintStr.slice(0,8)} — position already sold or buy never landed`);
            logEvent('SELL_ATA_EMPTY_BEFORE', { mint: mintStr, reason: decision.reason });
            this.emitTradeClose(position, mintStr, '', decision.reason ?? 'ata_empty', decision.urgent ?? false, 0, closedAt, 'none');
            this.totalTrades++;
            this.consecutiveLosses++;
            this.recordTradeResult(false);
            this.positions.delete(mintStr);
            this.copyTradeMints.delete(mintStr);
            this.sellFailureCount.delete(mintStr);
            await this.savePositions();
            this.unsubscribeFromPositionAccount(position);
            return;
          }
          realAmountRaw = ataAmount;
          const realTokens = Number(ataAmount) / Math.pow(10, position.tokenDecimals);
          if (Math.abs(realTokens - position.amount) > position.amount * 0.05) {
            logger.warn(`🔧 ATA mismatch before sell: position=${position.amount.toFixed(0)}, ATA=${realTokens.toFixed(0)} — using ATA`);
            position.amount = realTokens;
          }
          // ADDED LOG: SELL_ATA_BALANCE
          logEvent('SELL_ATA_BALANCE', {
            mint: mintStr,
            positionAmount: position.amount,
            ataAmount: realTokens,
            ataRaw: realAmountRaw.toString(),
            tokenDecimals: position.tokenDecimals,
            reason: decision.reason,
            urgent: decision.urgent,
          });
        } else {
          realAmountRaw = BigInt(Math.floor(position.amount * 10 ** position.tokenDecimals));
        }
      } catch (err) {
        // ATA pre-check failed = ATA doesn't exist = buy never landed
        // НЕ откатываемся на position.amount (optimistic мусор)!
        logger.warn(`🗑️ ATA pre-check failed for ${mintStr.slice(0,8)} — buy likely never landed, removing position`);
        logEvent('SELL_ATA_CHECK_FAILED', { mint: mintStr, reason: decision.reason });
        this.emitTradeClose(position, mintStr, '', (decision.reason ?? 'rpc_error') as CloseReason, decision.urgent ?? false, 0, closedAt, 'none');
        this.totalTrades++;
        this.consecutiveLosses++;
        this.recordTradeResult(false); // FIX: ATA failed = loss для defensive mode
        this.positions.delete(mintStr);
        this.seenMints.set(mintStr, Date.now());
        this.copyTradeMints.delete(mintStr);
        this.sellFailureCount.delete(mintStr);
        await this.savePositions();
        this.unsubscribeFromPositionAccount(position);
        return;
      }

      logEvent('SELL_ATTEMPT', { mint: mintStr, amount: position.amount, reason: decision.reason, urgent: decision.urgent });

      // ── Liquidity depth check: если наш sell займёт >X% пула — escalate slippage ──
      const depthImpact = await this.computeSellImpact(position, realAmountRaw).catch(() => null);
      if (depthImpact !== null) {
        logEvent('LIQUIDITY_DEPTH', { mint: mintStr, impactPct: depthImpact, amountRaw: realAmountRaw.toString() });
        const ldCfg: any = (config.strategy as any).liquidityDepth;
        if (ldCfg?.enabled && depthImpact > (ldCfg.maxPoolImpactPct ?? 15)) {
          logger.warn(`💧 DEEP POSITION: ${mintStr.slice(0,8)} sell = ${depthImpact.toFixed(1)}% of pool — escalating slippage`);
          // Отметим: ниже в sell loop при неудаче сразу уходим в Jupiter (skip chain)
          (position as any)._forceJupiterOnFail = true;
        }
      }

      // ── Sell loop: до 4 попыток, adaptive polling (brainstorm v4) ──
      // Вместо фиксированных 500ms: поллим каждые 100ms до maxWait.
      // Jito landing = 200-400ms, directRpc = 50-150ms.
      const MAX_SELL_ATTEMPTS = 4;
      const POLL_INTERVAL_MS = 100;
      const getMaxWait = (attempt: number) => attempt === 0 ? 600 : 400; // Jito = 600ms, directRpc = 400ms

      // bloXroute только как последнее средство + процентный кэп
      const bxTipSol = config.bloxroute.tipLamports / 1e9;
      const expectedProceedsSol = position.entryAmountSol * Math.max(0.1, position.currentPrice / position.entryPrice);
      const bxCostRatio = expectedProceedsSol > 0 ? bxTipSol / expectedProceedsSol : 1;
      const bxAllowedByCost = config.bloxroute.enabled && bxCostRatio <= config.bloxroute.maxTipPctOfProceeds;
      let sellPath: 'jito' | 'direct' | 'direct+bx' | 'jupiter' = 'jito';
      if (!bxAllowedByCost && config.bloxroute.enabled) {
        logEvent('BLOXROUTE_SKIPPED_COST', { mint: mintStr, tipSol: bxTipSol, proceedsSol: expectedProceedsSol, ratio: bxCostRatio });
      }

      let confirmedTxId = '';
      let sellSuccess = false; // true только если TX confirmed AND err === null
      let lastTxId = '';
      const allSentTxIds: string[] = []; // для batch status check
      const basePriorityFee = getCachedPriorityFee();
      let lastSellError = '';
      let sameErrorCount = 0;

      for (let attempt = 0; attempt < MAX_SELL_ATTEMPTS; attempt++) {
        // Liquidity depth: если позиция слишком велика для пула, skip to Jupiter immediately
        if ((position as any)._forceJupiterOnFail && attempt > 0) {
          logger.info(`💧 Deep position ${mintStr.slice(0,8)} — short-circuit to Jupiter after attempt 1`);
          logEvent('SELL_DEEP_POSITION_JUPITER', { mint: mintStr, attempt: attempt+1 });
          break;
        }
        // ADDED LOG: SELL_ATTEMPT_DETAIL before sending
        logEvent('SELL_ATTEMPT_DETAIL', {
          mint: mintStr,
          attempt: attempt+1,
          totalAttempts: MAX_SELL_ATTEMPTS,
          useDirectRpc: attempt > 0,
          feeRecipient: (attempt === 0 && position.feeRecipientUsed) ? position.feeRecipientUsed : 'fresh_global',
          tipMultiplier: 1.0, // not used in directRpc path, but for Jito first attempt
          urgent: decision.urgent,
          reason: decision.reason,
        });
        try {
          // B6 FIX: Re-read ATA balance on retries — previous attempt may have partially sold
          if (attempt > 0) {
            try {
              const mintState = getMintState(mintPk);
              if (mintState.tokenProgramId) {
                const ata = await getAssociatedTokenAddress(mintPk, this.payer.publicKey, false, mintState.tokenProgramId);
                const ataInfo = await withRpcLimit(() => this.connection.getTokenAccountBalance(ata));
                const freshAmount = ataInfo?.value ? BigInt(ataInfo.value.amount) : 0n;
                if (freshAmount === 0n) {
                  logger.info(`ATA empty on retry ${attempt+1} for ${mintStr.slice(0,8)} — sell likely landed`);
                  sellSuccess = true;
                  confirmedTxId = lastTxId;
                  break;
                }
                if (freshAmount < realAmountRaw) {
                  logger.info(`ATA balance decreased on retry: ${realAmountRaw} → ${freshAmount} for ${mintStr.slice(0,8)}`);
                  realAmountRaw = freshAmount;
                }
              }
            } catch (e) {
              logger.debug(`ATA re-read failed on retry ${attempt+1}: ${e}`);
            }
          }

          // FIX feeRecipient: cached with 5s TTL (brainstorm v4)
          // Не дёргаем RPC внутри retry loop — используем кэш.
          let feeRecipient: PublicKey | undefined;
          if (attempt === 0 && position.feeRecipientUsed) {
            feeRecipient = new PublicKey(position.feeRecipientUsed);
          } else {
            const now = Date.now();
            if (this.cachedFeeRecipient && now - this.cachedFeeRecipientTs < Sniper.FEE_RECIPIENT_CACHE_TTL) {
              feeRecipient = this.cachedFeeRecipient;
            } else {
              try {
                feeRecipient = await getFeeRecipient(this.connection);
                this.cachedFeeRecipient = feeRecipient;
                this.cachedFeeRecipientTs = now;
              } catch {
                feeRecipient = this.cachedFeeRecipient ?? this.feeRecipient ?? undefined;
              }
            }
          }

          const useDirectRpc = attempt > 0; // первая попытка через Jito, retry через RPC
          // bloXroute разрешён только на финальной попытке и только если tip <5% от выхода
          const useBloXrouteNow = useDirectRpc && bxAllowedByCost && attempt >= config.bloxroute.minAttemptIdx;
          sellPath = !useDirectRpc ? 'jito' : (useBloXrouteNow ? 'direct+bx' : 'direct');
          // Priority fee escalation: ×1.5 per retry (brainstorm v4)
          const escalatedPriorityFee = attempt === 0
            ? undefined  // use default from cache
            : Math.min(
                Math.ceil(basePriorityFee * Math.pow(config.jito.tipIncreaseFactor, attempt)),
                config.compute.unitPriceMicroLamports * 5  // cap at 5× base
              );
          const txId = await sellTokenAuto(
            this.connection,
            position.mint,
            this.payer,
            realAmountRaw,
            computeDynamicSellSlippage(getStrategyForProtocol(position.protocol).slippageBps, position.pnlPercent ?? 0, decision.urgent ?? false, decision.reason),
            decision.urgent ?? false,
            feeRecipient,
            position.protocol === 'mayhem',
            position.creator ? new PublicKey(position.creator) : undefined,
            position.cashbackEnabled,
            useDirectRpc,
            useBloXrouteNow,
            escalatedPriorityFee,
          );
          lastTxId = txId;
          allSentTxIds.push(txId);

          // ── Adaptive polling: проверяем каждые 100ms вместо фиксированных 500ms ──
          const maxWait = getMaxWait(attempt);
          let elapsed = 0;
          while (elapsed < maxWait && !sellSuccess) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
            elapsed += POLL_INTERVAL_MS;
            const statuses = await this.connection.getSignatureStatuses(allSentTxIds);
            for (let i = 0; i < allSentTxIds.length; i++) {
              const status = statuses.value[i];
              if ((status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') && !status.err) {
                confirmedTxId = allSentTxIds[i];
                sellSuccess = true;
                logger.info(`Sell confirmed (attempt ${attempt+1}, tx #${i+1}, path=${sellPath}, ${elapsed}ms): ${confirmedTxId.slice(0,8)} for ${mintStr.slice(0,8)}`);
                logEvent('SELL_PATH_CONFIRMED', { mint: mintStr, path: sellPath, attempt: attempt+1, pollMs: elapsed });
                metrics.inc(`sell_path_${sellPath.replace(/[^a-z]/g,'_')}_ok`);
                metrics.observe('sell_confirm_ms', elapsed);
                break;
              }
            }
          }
          if (sellSuccess) break;

          logger.info(`Sell attempt ${attempt+1}/${MAX_SELL_ATTEMPTS} not confirmed after ${maxWait}ms for ${mintStr.slice(0,8)}`);
          logEvent('SELL_NOT_CONFIRMED', { mint: mintStr, attempt: attempt + 1, txId: txId.slice(0,8), pollMs: maxWait });
        } catch (err: any) {
          const errMsg = String(err?.message ?? err).slice(0, 120);
          logger.warn(`Sell attempt ${attempt+1} exception for ${mintStr.slice(0,8)}:`, err);
          if (errMsg === lastSellError) {
            sameErrorCount++;
          } else {
            lastSellError = errMsg;
            sameErrorCount = 1;
          }
          if (sameErrorCount >= 2) {
            logger.warn(`Circuit-breaker: 2 identical errors for ${mintStr.slice(0,8)}, skipping to Jupiter fallback`);
            logEvent('SELL_CIRCUIT_BREAK', { mint: mintStr, error: errMsg, attempt: attempt + 1 });
            metrics.inc('sell_circuit_break_total');
            break;
          }
        }
      }

      // ── FIX #2: Если все попытки провалились — УДАЛЯЕМ ПОЗИЦИЮ ─────────────
      // Без этого checkPositions → shouldSell → executeFullSell → бесконечный цикл
      if (!sellSuccess) {
        logger.error(`❌ All ${MAX_SELL_ATTEMPTS} sell attempts failed for ${mintStr.slice(0,8)} — force-closing position`);
        logEvent('SELL_ALL_FAILED', { mint: mintStr, attempts: MAX_SELL_ATTEMPTS, reason: decision.reason, lastTxId });
        metrics.inc('sell_all_failed_total');

        // Последняя проверка: может одна из TX всё-таки прошла через mempool
        try {
          if (lastTxId) {
            const txInfo = await this.connection.getTransaction(lastTxId, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
            if (txInfo?.meta && !txInfo.meta.err) {
              const solReceived = ((txInfo.meta.postBalances[0] ?? 0) - (txInfo.meta.preBalances[0] ?? 0)) / 1e9;
              logger.info(`Late confirmation: sell actually succeeded for ${mintStr.slice(0,8)}, received ${solReceived.toFixed(6)} SOL`);
              this.emitTradeClose(position, mintStr, lastTxId, decision.reason ?? 'unknown', decision.urgent ?? false, Math.max(0, solReceived), closedAt, sellPath);
              this.totalTrades++;
              if (solReceived > position.entryAmountSol) { this.winTrades++; this.consecutiveLosses = 0; this.recordTradeResult(true); }
              else { this.consecutiveLosses++; this.recordTradeResult(false); }
              this.positions.delete(mintStr);
              this.copyTradeMints.delete(mintStr);
              this.sellFailureCount.delete(mintStr);
              await this.savePositions();
              this.unsubscribeFromPositionAccount(position);
              return;
            }
          }
        } catch {}

        // ── Jupiter sell fallback (brainstorm v4: pre-warmed) ────────────────
        // Jupiter находит маршрут через любой DEX, даже если пул мигрировал.
        // Если есть pre-warmed quote — используем его (экономит 1-2s).
        try {
          const jupSlippage = Math.min(5000, getStrategyForProtocol(position.protocol).slippageBps * 3);
          const preWarmed = this.jupiterQuoteCache.get(mintStr);
          const usePreWarmed = preWarmed && Date.now() - preWarmed.fetchedAt < Sniper.JUP_QUOTE_TTL;

          logger.info(`🔄 Jupiter fallback sell for ${mintStr.slice(0,8)}...${usePreWarmed ? ' (pre-warmed)' : ''}`);
          logEvent('JUPITER_SELL_ATTEMPT', { mint: mintStr, amount: realAmountRaw.toString(), reason: decision.reason, preWarmed: !!usePreWarmed });

          const jupTxId = usePreWarmed
            ? await sellTokenJupiterWithQuote(this.connection, mintStr, this.payer, realAmountRaw, preWarmed!.quote, jupSlippage)
            : await sellTokenJupiter(this.connection, mintStr, this.payer, realAmountRaw, jupSlippage);

          this.jupiterQuoteCache.delete(mintStr); // used, clear cache

          // Ждём подтверждения (Jupiter обеспечивает быстрый landing)
          await new Promise(r => setTimeout(r, 1000));
          const jupStatus = await this.connection.getSignatureStatuses([jupTxId]);
          const jupStat = jupStatus.value[0];

          if (jupStat?.confirmationStatus && !jupStat.err) {
            let solReceived = 0;
            try {
              const txInfo = await this.connection.getTransaction(jupTxId, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
              if (txInfo?.meta && !txInfo.meta.err) {
                solReceived = Math.max(0, ((txInfo.meta.postBalances[0] ?? 0) - (txInfo.meta.preBalances[0] ?? 0)) / 1e9);
              }
            } catch {}

            logger.info(`✅ Jupiter fallback sell SUCCESS for ${mintStr.slice(0,8)}, received ${solReceived.toFixed(6)} SOL`);
            logEvent('JUPITER_SELL_SUCCESS', { mint: mintStr, txId: jupTxId, solReceived });
            metrics.inc('sell_path_jupiter_ok');

            const totalReceived = solReceived + ((position as any).partialSolReceived ?? 0);
            this.emitTradeClose(position, mintStr, jupTxId, (decision.reason ?? 'manual') as CloseReason, decision.urgent ?? false, solReceived, closedAt, 'jupiter');
            this.totalTrades++;
            if (totalReceived > position.entryAmountSol) { this.winTrades++; this.consecutiveLosses = 0; this.recordTradeResult(true); }
            else { this.consecutiveLosses++; this.recordTradeResult(false); }
            this.positions.delete(mintStr);
            this.copyTradeMints.delete(mintStr);
            this.sellFailureCount.delete(mintStr);
            await this.savePositions();
            this.unsubscribeFromPositionAccount(position);
            return;
          } else {
            logger.warn(`[jupiter-sell] TX not confirmed or reverted for ${mintStr.slice(0,8)}`);
            logEvent('JUPITER_SELL_NOT_CONFIRMED', { mint: mintStr, txId: jupTxId });
          }
        } catch (jupErr: any) {
          logger.warn(`[jupiter-sell] Fallback failed for ${mintStr.slice(0,8)}: ${jupErr?.message ?? jupErr}`);
          logEvent('JUPITER_SELL_FAILED', { mint: mintStr, error: String(jupErr?.message ?? jupErr) });
        }

        // ── FIX: Rescue attempt — re-read ATA, try Jupiter with max slippage ──
        // All 4 sell channels failed. Before giving up, check if tokens are still
        // in ATA and attempt one final Jupiter sell with 50% slippage (last resort).
        let rescueSolReceived = 0;
        try {
          const mintPk = new PublicKey(mintStr);
          const mintState = getMintState(mintPk);
          if (mintState.tokenProgramId) {
            const rescueAta = await getAssociatedTokenAddress(mintPk, this.payer.publicKey, false, mintState.tokenProgramId);
            const rescueBal = await withRpcLimit(() => this.connection.getTokenAccountBalance(rescueAta));
            const rescueAmount = rescueBal?.value ? BigInt(rescueBal.value.amount) : 0n;
            if (rescueAmount > 0n) {
              logger.warn(`🚑 Rescue attempt for ${mintStr.slice(0,8)}: ${rescueBal.value.uiAmountString} tokens still in ATA`);
              logEvent('RESCUE_SELL_ATTEMPT', { mint: mintStr, amount: rescueBal.value.uiAmountString });
              const rescueTxId = await sellTokenJupiter(this.connection, mintStr, this.payer, rescueAmount, 5000);
              if (rescueTxId) {
                logger.info(`🚑 Rescue sell succeeded for ${mintStr.slice(0,8)}: ${rescueTxId.slice(0,8)}`);
                logEvent('RESCUE_SELL_OK', { mint: mintStr, txId: rescueTxId });
                // Approximate SOL received (we can't know exact, but it's better than 0)
                rescueSolReceived = position.entryAmountSol * 0.5; // conservative estimate
              }
            }
          }
        } catch (rescueErr: any) {
          logger.debug(`🚑 Rescue sell failed for ${mintStr.slice(0,8)}: ${rescueErr?.message ?? rescueErr}`);
        }

        // Force-close — принимаем потерю, удаляем позицию.
        this.emitTradeClose(position, mintStr, lastTxId, (decision.reason ?? 'rpc_error') as CloseReason, decision.urgent ?? false, rescueSolReceived, closedAt, rescueSolReceived > 0 ? 'rescue' : sellPath);
        this.totalTrades++;
        if (rescueSolReceived > position.entryAmountSol) { this.winTrades++; this.consecutiveLosses = 0; this.recordTradeResult(true); }
        else { this.consecutiveLosses++; this.recordTradeResult(false); }
        if (config.strategy.consecutiveLossesMax && this.consecutiveLosses >= config.strategy.consecutiveLossesMax) {
          logger.warn(`❗ ${this.consecutiveLosses} consecutive losses, pausing buys for ${config.strategy.pauseAfterLossesMs / 60000} min`);
          this.pauseUntil = Date.now() + config.strategy.pauseAfterLossesMs;
        }
        this.positions.delete(mintStr);
        this.seenMints.set(mintStr, Date.now());
        this.copyTradeMints.delete(mintStr);
        this.sellFailureCount.delete(mintStr);
        await this.savePositions();
        this.unsubscribeFromPositionAccount(position);
        return;
      }

      // ── Sell succeeded — read actual SOL received ──────────────────────────
      this.sellFailureCount.delete(mintStr);

      let solReceived = 0;
      for (let txReadAttempt = 0; txReadAttempt < 4; txReadAttempt++) {
        try {
          if (txReadAttempt > 0) await new Promise(r => setTimeout(r, 300));
          const txInfo = await this.connection.getTransaction(confirmedTxId, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          });

          if (txInfo?.meta && !txInfo.meta.err) {
            const preBalance = txInfo.meta.preBalances[0] ?? 0;
            const postBalance = txInfo.meta.postBalances[0] ?? 0;
            solReceived = Math.max(0, (postBalance - preBalance) / 1e9);
            break;
          }
          if (txInfo?.meta?.err) {
            logger.warn(`Sell TX has error for ${mintStr.slice(0,8)}: ${JSON.stringify(txInfo.meta.err)}`);
            break;
          }
          logger.debug(`getTransaction returned null for ${mintStr.slice(0,8)}, retry ${txReadAttempt + 1}/4`);
        } catch (err) {
          logger.warn(`Failed to read sell TX details for ${mintStr.slice(0,8)} (attempt ${txReadAttempt + 1}):`, err);
        }
      }
      if (solReceived === 0 && confirmedTxId) {
        logger.warn(`⚠️ solReceived=0 for confirmed TX ${confirmedTxId.slice(0,8)} — getTransaction may not have indexed yet`);
      }

      const totalReceived = solReceived + position.partialSolReceived;
      const isWin = totalReceived > position.entryAmountSol;
      if (isWin) {
        this.winTrades++;
        this.consecutiveLosses = 0;
        this.recordTradeResult(true);
        metrics.inc('trades_won_total');
      } else {
        metrics.inc('trades_lost_total');
        this.consecutiveLosses++;
        this.recordTradeResult(false);
        if (config.strategy.consecutiveLossesMax && this.consecutiveLosses >= config.strategy.consecutiveLossesMax) {
          logger.warn(`❗ ${this.consecutiveLosses} consecutive losses, pausing buys for ${config.strategy.pauseAfterLossesMs / 60000} min`);
          this.pauseUntil = Date.now() + config.strategy.pauseAfterLossesMs;
        }
      }

      logger.info(
        `🔴 FULL SELL [${decision.reason ?? 'unknown'}]${decision.urgent ? ' ⚡URGENT' : ''} ${mintStr} получено ${solReceived.toFixed(6)} SOL, всего ${totalReceived.toFixed(6)} SOL tx=${confirmedTxId.slice(0,8)}`
      );
      logEvent('SELL_SUCCESS', { mint: mintStr, reason: decision.reason, urgent: decision.urgent, solReceived, totalReceived, txId: confirmedTxId, sellPath });
      this.emitTradeClose(position, mintStr, confirmedTxId, decision.reason ?? 'unknown', decision.urgent ?? false, solReceived, closedAt, sellPath);
      this.totalTrades++;
      this.positions.delete(mintStr);
      this.seenMints.set(mintStr, Date.now());
      this.copyTradeMints.delete(mintStr);
      await this.savePositions();

      this.unsubscribeFromPositionAccount(position);

    } finally {
      this.sellingMints.delete(mintStr);
    }
  }

  private scheduleSocialRetry(mint: string, position: Position) {
    if (this.socialRetryTimers.has(mint)) return;

    let attempts = 0;
    const maxAttempts = 10;
    const intervalMs = 500;

    const check = async () => {
      attempts++;
      try {
        const signal = await checkSocialSignals(this.connection, position.mint);
        if (signal.score >= 1 && !this.addOnBuyDone.has(mint)) {
          logger.info(`📱 Социальные сигналы обнаружены (score=${signal.score}) для ${mint.slice(0,8)}, докупаем до full entry`);
          logEvent('SOCIAL_RETRY_FOUND', { mint, score: signal.score });

          this.addOnBuyDone.add(mint);

          const protocol = position.protocol;
          const cfg = getStrategyForProtocol(protocol === 'pumpswap' ? 'pumpswap' : 'pump.fun');
          const targetEntry = cfg.entryAmountSol * config.strategy.socialHighMultiplier;
          const additionalSol = targetEntry - position.entryAmountSol;
          if (additionalSol > 0) {
            await this.executeAddOnBuy(position, mint, additionalSol);
          }
          const timer = this.socialRetryTimers.get(mint);
          if (timer) clearTimeout(timer);
          this.socialRetryTimers.delete(mint);
          return;
        }
      } catch (err) {
        logger.debug(`Social retry check for ${mint.slice(0,8)} failed:`, err);
      }

      if (attempts < maxAttempts) {
        const timer = setTimeout(check, intervalMs);
        this.socialRetryTimers.set(mint, timer);
      } else {
        this.socialRetryTimers.delete(mint);
        logger.debug(`Social retry timeout for ${mint.slice(0,8)} – score still 0`);
      }
    };

    const timer = setTimeout(check, intervalMs);
    this.socialRetryTimers.set(mint, timer);
  }

  private async executeAddOnBuy(position: Position, mintStr: string, addOnSol: number = 0.03) {
    try {
      // ── FIX Bug 1.2: блокируем add-on buy при активной паузе ──
      if (Date.now() < this.pauseUntil) {
        logger.debug(`Add-on buy blocked for ${mintStr.slice(0,8)} — paused until ${new Date(this.pauseUntil).toISOString()}`);
        return;
      }

      if (this.sellingMints.has(mintStr) || this.creatorSellSeen.has(mintStr)) {
        logger.warn(`Add-on buy cancelled for ${mintStr.slice(0,8)} — sell in progress`);
        return;
      }
      if (!this.positions.has(mintStr)) {
        logger.warn(`Add-on buy cancelled for ${mintStr.slice(0,8)} — position gone`);
        return;
      }

      // ── FIX Bug 1.1 (этап 2): Полный scoring при add-on buy ──
      // К этому моменту social и rugcheck уже вернулись (200-2000мс прошло).
      if (config.strategy.enableScoring && position.protocol !== 'pumpswap') {
        const mintPk = new PublicKey(mintStr);
        const socialScore = this.mintSocialScore.get(mintStr) ?? 0;
        const rugResult = (position as any)._rugcheckResult;
        const realBuyers = this.confirmedRealBuyers.get(mintStr);

        // Holder concentration for add-on scoring
        let topHolderPct: number | undefined;
        try {
          const largest = await withRpcLimit(() =>
            this.connection.getTokenLargestAccounts(mintPk)
          );
          if (largest.value.length > 0) {
            const totalKnown = largest.value.reduce((s, a) => s + Number(a.amount), 0);
            if (totalKnown > 0) topHolderPct = (Number(largest.value[0].amount) / totalKnown) * 100;
          }
        } catch { /* non-critical */ }

        const features: TokenFeatures = {
          socialScore,
          independentBuyers: realBuyers?.size ?? 0,
          firstBuySol: 0,
          creatorRecentTokens: this.countCreatorRecentTokens(position.creator ?? ''),
          metadataJsonSize: 0,
          rugcheckRisk: rugResult?.risk ?? 'unknown',
          hasMintAuthority: rugResult?.hasMintAuthority ?? false,
          hasFreezeAuthority: rugResult?.hasFreezeAuthority ?? false,
          isMayhem: getMintState(mintPk).isMayhemMode ?? false,
          topHolderPct,
          socialMentions: this.getSocialMentionCount(mintStr),
          hasDexBoost: hasDexBoost(mintStr),
        };
        const effMinScore = this.getEffectiveMinScore();
        const scoringResult = scoreToken(features, effMinScore);
        position.tokenScore = Math.max(position.tokenScore, scoringResult.score);
        logEvent('ADDON_SCORE', { mint: mintStr, score: scoringResult.score, enter: scoringResult.shouldEnter, reasons: scoringResult.reasons });
        this.pushScoredToken({
          mint: mintStr, protocol: position.protocol,
          score: scoringResult.score, shouldEnter: scoringResult.shouldEnter,
          entryMultiplier: scoringResult.entryMultiplier,
          reasons: scoringResult.reasons,
          rugcheckRisk: rugResult?.risk ?? 'unknown',
          socialScore,
        });
        if (!scoringResult.shouldEnter) {
          logger.info(`📊 Add-on blocked: score=${scoringResult.score} < ${effMinScore} for ${mintStr.slice(0,8)} — ${scoringResult.reasons.join(' ')}`);
          return;
        }
      }

      if (position.protocol === 'pumpswap') {
        logger.info(`🔥 ADD-ON BUY [pumpswap]: ${mintStr.slice(0,8)} (${addOnSol} SOL)`);
        const pumpSwapCfg = getStrategyForProtocol('pumpswap');
        try {
          const txId = await buyTokenPumpSwap(
            this.connection,
            new PublicKey(mintStr),
            this.payer,
            addOnSol,
            pumpSwapCfg.slippageBps,
          );
          logger.info(`🔥 ADD-ON BUY [pumpswap] sent: ${txId.slice(0,8)} for ${mintStr.slice(0,8)}`);
          logEvent('ADD_ON_BUY_SENT', { mint: mintStr, txId, addOnSol, protocol: 'pumpswap' });

          await new Promise(r => setTimeout(r, 2000));
          if (!this.positions.has(mintStr) || this.sellingMints.has(mintStr) || this.creatorSellSeen.has(mintStr)) return;

          const mintPk = new PublicKey(mintStr);
          const mintState = getMintState(mintPk);
          if (mintState.tokenProgramId) {
            const ataCheck = await getAssociatedTokenAddress(mintPk, this.payer.publicKey, false, mintState.tokenProgramId);
            const ataInfo = await withRpcLimit(() => this.connection.getTokenAccountBalance(ataCheck));
            if (ataInfo?.value) {
              const actualTokens = Number(ataInfo.value.amount) / Math.pow(10, ataInfo.value.decimals);
              if (actualTokens > position.amount * 1.01) {
                position.amount = actualTokens;
                position.entryAmountSol += addOnSol;
                position.entryPrice = position.entryAmountSol / position.amount;
                await this.savePositions();
                logger.info(`📈 ADD-ON [pumpswap] confirmed: ${mintStr.slice(0,8)} now ${actualTokens.toFixed(0)} tokens`);
                logEvent('ADD_ON_BUY_CONFIRMED', { mint: mintStr, txId, newAmount: actualTokens, entryAmountSol: position.entryAmountSol });
              } else {
                logger.warn(`Add-on buy [pumpswap] NOT landed for ${mintStr.slice(0,8)}`);
                logEvent('ADD_ON_BUY_NOT_LANDED', { mint: mintStr, txId });
              }
            }
          }
        } catch (err) {
          logger.error(`Add-on buy [pumpswap] error for ${mintStr}:`, err);
          logEvent('ADD_ON_BUY_FAIL', { mint: mintStr, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      const mintPubkey = new PublicKey(mintStr);
      const bondingCurve = getBondingCurvePDA(mintPubkey);
      const mintState = getMintState(mintPubkey);

      if (!mintState.tokenProgramId) {
        const mintInfo = await withRpcLimit(() => this.connection.getAccountInfo(mintPubkey));
        if (!mintInfo) throw new Error('Mint not found');
        mintState.tokenProgramId = mintInfo.owner;
      }

      const curveAcc = await withRpcLimit(() => this.connection.getAccountInfo(bondingCurve));
      if (!curveAcc) throw new Error('Bonding curve not found');
      const layout = getRuntimeLayout();
      const vSol = curveAcc.data.readBigUInt64LE(layout.bondingCurve?.solReserveOffset ?? 16);
      const vToken = curveAcc.data.readBigUInt64LE(layout.bondingCurve?.tokenReserveOffset ?? 8);

      const creatorPubkey = curveAcc.data.length >= BONDING_CURVE_LAYOUT.CREATOR_OFFSET + 32
        ? getCreatorFromCurveData(curveAcc.data)
        : new PublicKey(position.creator ?? mintStr);

      const ata = await getAssociatedTokenAddress(mintPubkey, this.payer.publicKey, false, mintState.tokenProgramId);
      const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        this.payer.publicKey, ata, this.payer.publicKey, mintPubkey, mintState.tokenProgramId
      );

      const pumpFunCfg = getStrategyForProtocol('pump.fun');
      const buyIx = buildBuyInstructionFromCreate({
        mint: mintPubkey, bondingCurve, creator: creatorPubkey,
        userAta: ata, user: this.payer.publicKey,
        amountSol: addOnSol, slippageBps: pumpFunCfg.slippageBps,
        virtualSolReserves: vSol, virtualTokenReserves: vToken,
        feeRecipient: getEffectiveFeeRecipient(curveAcc.data, this.feeRecipient!),
        eventAuthority: this.eventAuthority,
        tokenProgramId: mintState.tokenProgramId!,
        isMayhem: mintState.isMayhemMode ?? false,
      });

      const buildTx = async (burstIndex?: number): Promise<VersionedTransaction> => {
        const { blockhash } = await getCachedBlockhashWithHeight();
        const priorityFee = getCachedPriorityFee();
        const message = new TransactionMessage({
          payerKey: this.payer.publicKey, recentBlockhash: blockhash,
          instructions: [
            ComputeBudgetProgram.setComputeUnitLimit({ units: config.compute.unitLimit + (burstIndex ?? 0) }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
            createAtaIx, buyIx,
          ],
        }).compileToV0Message();
        const tx = new VersionedTransaction(message);
        tx.sign([this.payer]);
        return tx;
      };

      const burstResults = await sendJitoBurst(buildTx, this.payer, config.jito.burstTipMultipliers, true);
      const txId = burstResults[0].signature;
      logger.info(`🔥 ADD-ON buy sent: ${txId.slice(0,8)} for ${mintStr.slice(0,8)} (${addOnSol} SOL)`);
      logEvent('ADD_ON_BUY_SENT', { mint: mintStr, txId, addOnSol });

      await new Promise(r => setTimeout(r, 2000));

      if (!this.positions.has(mintStr) || this.sellingMints.has(mintStr) || this.creatorSellSeen.has(mintStr)) {
        logger.warn(`Add-on buy: position gone or selling for ${mintStr.slice(0,8)} after send`);
        return;
      }

      const ataCheck = await getAssociatedTokenAddress(mintPubkey, this.payer.publicKey, false, mintState.tokenProgramId);
      const ataInfo = await withRpcLimit(() => this.connection.getTokenAccountBalance(ataCheck));
      if (!ataInfo || !ataInfo.value) {
        logger.warn(`Add-on buy: ATA empty for ${mintStr.slice(0,8)}, buy may not have landed`);
        logEvent('ADD_ON_BUY_UNCONFIRMED', { mint: mintStr, txId });
        return;
      }

      const actualTokens = Number(ataInfo.value.amount) / Math.pow(10, ataInfo.value.decimals);
      const previousAmount = position.amount;

      if (actualTokens <= previousAmount * 1.01) {
        logger.warn(`Add-on buy NOT landed for ${mintStr.slice(0,8)}: ATA=${actualTokens.toFixed(0)}, position=${previousAmount.toFixed(0)}`);
        logEvent('ADD_ON_BUY_NOT_LANDED', { mint: mintStr, txId, ataTokens: actualTokens, positionTokens: previousAmount });
        return;
      }

      position.amount = actualTokens;
      position.entryAmountSol += addOnSol;
      position.entryPrice = position.entryAmountSol / position.amount;
      await this.savePositions();

      logger.info(`📈 ADD-ON confirmed: ${mintStr.slice(0,8)} now ${position.amount.toFixed(0)} tokens (was ${previousAmount.toFixed(0)}), entry ${position.entryAmountSol} SOL`);
      logEvent('ADD_ON_BUY_CONFIRMED', { mint: mintStr, txId, previousAmount, newAmount: actualTokens, entryAmountSol: position.entryAmountSol });

    } catch (err) {
      logger.error(`Add-on buy error for ${mintStr}:`, err);
      logEvent('ADD_ON_BUY_FAIL', { mint: mintStr, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async executePartialSell(position: Position, mintStr: string, decision: SellDecision) {
    const mintPk = new PublicKey(mintStr);

    // ── FIX: читаем реальный ATA баланс перед partial sell ──────────────
    let realTotalRaw: bigint;
    try {
      const mintState = getMintState(mintPk);
      if (!mintState.tokenProgramId) {
        const mInfo = await withRpcLimit(() => this.connection.getAccountInfo(mintPk));
        if (mInfo) mintState.tokenProgramId = mInfo.owner;
      }
      if (mintState.tokenProgramId) {
        const ata = await getAssociatedTokenAddress(mintPk, this.payer.publicKey, false, mintState.tokenProgramId);
        const ataInfo = await withRpcLimit(() => this.connection.getTokenAccountBalance(ata));
        realTotalRaw = ataInfo?.value ? BigInt(ataInfo.value.amount) : 0n;
        if (realTotalRaw === 0n) {
          logger.warn(`ATA empty before partial sell for ${mintStr.slice(0,8)} — skipping`);
          return;
        }
        const realTokens = Number(realTotalRaw) / Math.pow(10, position.tokenDecimals);
        if (Math.abs(realTokens - position.amount) > position.amount * 0.05) {
          logger.warn(`🔧 ATA mismatch partial: position=${position.amount.toFixed(0)}, ATA=${realTokens.toFixed(0)} — using ATA`);
          position.amount = realTokens;
        }
      } else {
        realTotalRaw = BigInt(Math.floor(position.amount * 10 ** position.tokenDecimals));
      }
    } catch {
      realTotalRaw = BigInt(Math.floor(position.amount * 10 ** position.tokenDecimals));
    }

    const partialAmountTokens = position.amount * decision.portion!;
    const amountRaw = BigInt(Math.floor(partialAmountTokens * 10 ** position.tokenDecimals));
    const msFromOpen = Date.now() - position.openedAt;

    logEvent('SELL_ATTEMPT', { mint: mintStr, amount: partialAmountTokens, reason: decision.reason, urgent: false });

    // ── Sell с retry и fresh feeRecipient ────────────────────────────────
    let txId: string;
    let sellOk = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let feeRecipient: PublicKey | undefined;
        if (attempt === 0 && position.feeRecipientUsed) {
          feeRecipient = new PublicKey(position.feeRecipientUsed);
        } else {
          try { feeRecipient = await getFeeRecipient(this.connection); } catch { feeRecipient = this.feeRecipient ?? undefined; }
        }

        txId = await sellTokenAuto(
          this.connection, position.mint, this.payer, amountRaw,
          getStrategyForProtocol(position.protocol).slippageBps,
          false, feeRecipient,
          position.protocol === 'mayhem',
          position.creator ? new PublicKey(position.creator) : undefined,
          position.cashbackEnabled,
          attempt > 0 // directRpc on retry
        );

        // B8 FIX: Use getSignatureStatuses polling instead of confirmTransaction
        let partialConfirmed = false;
        const partialPollStart = Date.now();
        while (Date.now() - partialPollStart < config.timeouts.confirmTransactionTimeoutMs) {
          await new Promise(r => setTimeout(r, 200));
          const statuses = await this.connection.getSignatureStatuses([txId!]);
          const status = statuses.value[0];
          if (status?.err) {
            logger.warn(`Partial sell attempt ${attempt+1} reverted: ${JSON.stringify(status.err)}`);
            break;
          }
          if (status?.confirmationStatus) {
            partialConfirmed = true;
            break;
          }
        }
        if (!partialConfirmed) continue;
        sellOk = true;
        break;
      } catch (err) {
        logger.warn(`Partial sell attempt ${attempt+1} failed:`, err);
      }
    }

    if (!sellOk || !txId!) {
      logger.error(`All partial sell attempts failed for ${mintStr.slice(0,8)}`);
      logEvent('PARTIAL_SELL_FAILED', { mint: mintStr, reason: decision.reason });
      return;
    }

    let solReceived = 0;
    try {
      const txInfo = await this.connection.getTransaction(txId!, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (txInfo?.meta && !txInfo.meta.err) {
        const preBalance = txInfo.meta.preBalances[0] ?? 0;
        const postBalance = txInfo.meta.postBalances[0] ?? 0;
        solReceived = Math.max(0, (postBalance - preBalance) / 1e9);
      }
    } catch (err) {
      logger.warn(`Failed to read partial sell TX for ${mintStr.slice(0,8)}: ${err}`);
    }

    if (decision.tpLevelPercent) {
      position.markTpLevel(decision.tpLevelPercent);
    }
    position.reduceAmount(decision.portion!, solReceived);

    if (position.amount <= 1e-9) {
      logger.info(`Position ${mintStr} reduced to zero, closing`);
      this.positions.delete(mintStr);
      this.seenMints.set(mintStr, Date.now());
      this.copyTradeMints.delete(mintStr);
      await this.savePositions();
      this.unsubscribeFromPositionAccount(position);
    } else {
      await this.savePositions();
    }

    logger.info(
      `🟡 PARTIAL SELL ${(decision.portion! * 100).toFixed(0)}% ${mintStr} pnl=${position.pnlPercent.toFixed(1)}% tx=${txId} получено ${solReceived.toFixed(6)} SOL`
    );
    logEvent('PARTIAL_SELL', { mint: mintStr, portion: decision.portion, pnl: position.pnlPercent, solReceived, txId });

    tradeLog.partial({
      mint: mintStr,
      protocol: position.protocol,
      tpLevelPercent: decision.tpLevelPercent ?? position.pnlPercent,
      tpIndex: position.partialSellsCount - 1,
      portion: decision.portion!,
      tokensSold: partialAmountTokens,
      solReceived,
      priceAtSell: position.currentPrice,
      pnlPercent: position.pnlPercent,
      accumulatedSolSoFar: position.partialSolReceived,
      txId,
      msFromOpen,
    });

    await this.savePositions();
  }

  /** Safe wrapper around EventEmitter.emit — never throws even if a subscriber misbehaves. */
  private safeEmit(event: string, payload: any): void {
    try {
      this.emit(event, payload);
    } catch (e) {
      logger.warn(`[event] subscriber for ${event} threw: ${(e as Error).message}`);
    }
  }

  /** Notify subscribers about a freshly opened position (used by TG push alerts). */
  private emitPositionOpen(position: Position): void {
    const mintStr = position.mint.toBase58();
    dossier.recordTradeOpen(mintStr);
    this.safeEmit('position:open', {
      mint:           mintStr,
      protocol:       position.protocol,
      entryAmountSol: position.entryAmountSol,
      entryPrice:     position.entryPrice,
    });
  }

  private emitTradeClose(
    position: Position,
    mintStr: string,
    txId: string,
    reason: CloseReason,
    urgent: boolean,
    finalSolReceived: number,
    closedAt: number,
    sellPathValue: string = 'unknown'
  ) {
    const totalEntry = position.originalEntryAmountSol ?? position.entryAmountSol;
    const totalSolReceived = finalSolReceived + position.partialSolReceived;
    const pnlSol = totalSolReceived - totalEntry;
    const pnlPercent = totalEntry > 0 ? (pnlSol / totalEntry) * 100 : 0;
    const durationMs = closedAt - position.openedAt;

    // Dossier: trade outcome
    dossier.recordTradeClose(mintStr, pnlSol, pnlPercent);

    const ataRent = 0.002039;
    const tipPerTx = config.jito.tipAmountSol;
    const txCount = 1 + position.partialSellsCount + 1;
    const protocolFeeRate = position.protocol === 'pumpswap' ? 0.0125 : 0.01;
    const overheadSol = ataRent + tipPerTx * txCount + totalEntry * protocolFeeRate;
    const netPnlSol = pnlSol - overheadSol;
    const netPnlPercent = totalEntry > 0 ? (netPnlSol / totalEntry) * 100 : 0;
    const isCopyTrade = this.copyTradeMints.has(mintStr);

    clearReserveHistory(mintStr);

    this.eventsExited++;
    this.safeEmit('position:close', {
      mint:       mintStr,
      protocol:   position.protocol,
      reason,
      urgent,
      pnlPercent,
      pnlSol,
      netPnlSol,
      netPnlPercent,
      overheadSol,
      txId,
    });

    tradeLog.close({
      mint: mintStr,
      protocol: position.protocol,
      reason,
      urgent,
      entryPrice: position.entryPrice,
      exitPrice: position.currentPrice,
      peakPrice: position.maxPrice,
      peakPnlPercent: position.peakPnlPercent,
      entryAmountSol: totalEntry,
      finalSolReceived,
      partialSolReceived: position.partialSolReceived,
      totalSolReceived,
      pnlSol,
      pnlPercent,
      overheadSol,
      netPnlSol,
      netPnlPercent,
      isCopyTrade,
      tokenScore: position.tokenScore ?? 0,
      openedAt: position.openedAt,
      closedAt,
      durationMs,
      durationSec: durationMs / 1000,
      txId,
      sellPath: sellPathValue as any,
      partialSells: position.partialSellsCount,
      priceHistory: position.priceHistory,
      configSnapshot: position.configSnapshot,
    });

    insertTrade({
      mint: mintStr,
      protocol: position.protocol,
      entryPrice: position.entryPrice,
      exitPrice: position.currentPrice,
      entryAmountSol: totalEntry,
      exitAmountSol: totalSolReceived,
      pnlPercent: pnlPercent,
      tokenScore: position.tokenScore ?? 0,
      exitReason: reason,
      sellPath: sellPathValue,
      openedAt: position.openedAt,
      closedAt: closedAt,
      isCopyTrade,
    });

    // ── CRITICAL: Anti-rebuy на failed sell ──
    // Если ни один sell path не вернул SOL (exit=0 при entry>0), токены остались
    // в кошельке как dust. Блокируем mint на 24ч чтобы не купить снова (в логах
    // зафиксированы 3x повторные покупки одного и того же mint → -0.09 SOL за 5 мин).
    if (totalSolReceived === 0 && totalEntry > 0) {
      this.failedSellMints.set(mintStr, Date.now());
      logger.warn(`🚫 FAILED_SELL_BLOCKED: ${mintStr.slice(0, 8)} exit=0 SOL, blocked from re-entry 24h`);
      logEvent('FAILED_SELL_BLOCKED', { mint: mintStr, protocol: position.protocol, entry: totalEntry, reason, sellPath: sellPathValue });
    }

    // ── Re-entry eligibility: при profit на allowed-протоколе — даём шанс повторного входа
    this.registerReEntryEligible(position, pnlPercent, reason);
  }

  private registerReEntryEligible(position: Position, pnlPercent: number, reason: CloseReason): void {
    const reCfg: any = (config.strategy as any).trendReEntry;
    if (!reCfg?.enabled) return;
    if (!reCfg.allowedProtocols.includes(position.protocol)) return;
    if (reCfg.requiresTpProfit && pnlPercent <= 0) return;
    // CRITICAL FIX: расширенный skip-list — все failed-exit reasons, иначе failed sell
    // регистрирует mint как re-entry eligible и бот покупает его снова в cooldown.
    // В логах: 3x повторные покупки одного mint после ata_empty = -0.09 SOL за 5 мин.
    const badReasons: string[] = [
      'stop_loss', 'hard_stop', 'score_gate',
      'ata_empty', 'rpc_error', 'bundle_failed', 'bundle_invalid_repeated',
      'manual', 'sell_failed',
    ];
    if (badReasons.includes(reason as string)) return;

    const mintStr = position.mint.toBase58();
    const prev = this.reEntryEligible.get(mintStr);
    const count = prev ? prev.count : 0;
    if (count >= (reCfg.maxReEntries ?? 2)) return;

    this.reEntryEligible.set(mintStr, {
      closedAt: Date.now(),
      count: count + 1,
      lastEntryPrice: position.entryPrice,
    });

    // Возвращаем mint в TrendTracker, чтобы новый тренд смог триггернуть re-entry
    if (config.trend.enabled && !this.trendTracker.isTracking(mintStr)) {
      this.trendTracker.track(mintStr, position.protocol);
      logger.info(`🔁 RE-ENTRY ELIGIBLE: ${mintStr.slice(0,8)} (count=${count + 1}) — re-tracking trend`);
      logEvent('RE_ENTRY_ELIGIBLE', { mint: mintStr, count: count + 1, lastEntryPrice: position.entryPrice, protocol: position.protocol });
    }
  }

  private async getPoolReserves(mint: PublicKey) {
    const key = mint.toBase58() + '_pump';
    const cached = this.reservesCache.get(key);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) return cached.reserves;

    const bondingCurve = getBondingCurvePDA(mint);
    const accountInfo = await withRetry(() => withRpcLimit(() => this.connection.getAccountInfo(bondingCurve, {
      commitment: 'processed'
    })));
    if (!accountInfo) throw new Error('Bonding curve not found');

    const layout = getRuntimeLayout();
    const tokenOffset = layout.bondingCurve?.tokenReserveOffset ?? 8;
    const solOffset = layout.bondingCurve?.solReserveOffset ?? 16;

    const result = {
      virtualSolReserves: accountInfo.data.readBigUInt64LE(solOffset),
      virtualTokenReserves: accountInfo.data.readBigUInt64LE(tokenOffset),
      creator: accountInfo.data.length >= BONDING_CURVE_LAYOUT.CREATOR_OFFSET + 32
        ? new PublicKey(accountInfo.data.slice(BONDING_CURVE_LAYOUT.CREATOR_OFFSET, BONDING_CURVE_LAYOUT.CREATOR_OFFSET + 32))
        : new PublicKey(accountInfo.data.slice(32, 64)),
      data: accountInfo.data,
    };
    this.reservesCache.set(key, { reserves: result, timestamp: Date.now() });
    return result;
  }

  /**
   * Получить текущую цену токена (SOL per token) для re-entry price check.
   * Работает только для PumpSwap/Raydium. Для pump.fun re-entry отключён.
   */
  private async getCurrentPriceForReEntry(mint: string, protocol: string): Promise<number> {
    try {
      const mintPk = new PublicKey(mint);
      if (protocol === 'pumpswap') {
        const r = await this.getPumpSwapReserves(mintPk);
        if (!r || r.baseReserve === 0n) return 0;
        return Number(r.quoteReserve) / Number(r.baseReserve); // price in lamports per raw token
      }
      if (protocol === 'raydium-launch' || protocol === 'raydium-cpmm' || protocol === 'raydium-ammv4') {
        // Создаём dummy position для переиспользования getRaydiumReserves
        const dummyPos = { mint: mintPk, protocol } as Position;
        const r = await this.getRaydiumReserves(dummyPos);
        if (!r || r.tokenReserve === 0n) return 0;
        return Number(r.solReserve) / Number(r.tokenReserve);
      }
      return 0;
    } catch {
      return 0;
    }
  }

  /**
   * Liquidity depth: возвращает процент от пула, который займёт наш sell.
   * Используется для решения о escalating slippage / routing через Jupiter.
   */
  private async computeSellImpact(position: Position, amountRaw: bigint): Promise<number | null> {
    try {
      const protocol = position.protocol;
      const mint = position.mint;

      if (protocol === 'pump.fun' || protocol === 'mayhem') {
        const r = await this.getPoolReserves(mint);
        if (!r || r.virtualTokenReserves === 0n) return null;
        return (Number(amountRaw) / Number(r.virtualTokenReserves)) * 100;
      }

      if (protocol === 'pumpswap') {
        const r = await this.getPumpSwapReserves(mint);
        if (!r || r.baseReserve === 0n) return null;
        return (Number(amountRaw) / Number(r.baseReserve)) * 100;
      }

      if (protocol === 'raydium-launch' || protocol === 'raydium-cpmm' || protocol === 'raydium-ammv4') {
        const r = await this.getRaydiumReserves(position);
        if (!r || r.tokenReserve === 0n) return null;
        return (Number(amountRaw) / Number(r.tokenReserve)) * 100;
      }

      return null;
    } catch {
      return null;
    }
  }

  private async checkWhaleActivity(position: Position, mintStr: string): Promise<void> {
    try {
      position.whaleLastCheckTs = Date.now();
      const mintPk = new PublicKey(mintStr);
      const largest = await withRpcLimit(() =>
        this.connection.getTokenLargestAccounts(mintPk)
      );
      if (!largest.value || largest.value.length === 0) return;

      const wsCfg: any = (config.strategy as any).whaleSell;
      const dropThreshold = (wsCfg.dropThresholdPct ?? 50) / 100;
      const minHolderPct = wsCfg.minHolderPct ?? 5;
      const totalSupply = largest.value.reduce((s, a) => s + Number(a.amount), 0);
      if (totalSupply === 0) return;

      const currentHolders = new Map<string, number>();
      for (const acc of largest.value) {
        const pct = (Number(acc.amount) / totalSupply) * 100;
        if (pct >= minHolderPct) {
          currentHolders.set(acc.address.toBase58(), Number(acc.amount));
        }
      }

      if (position.whaleSnapshot.size === 0) {
        position.whaleSnapshot = currentHolders;
        return;
      }

      for (const [addr, prevAmount] of position.whaleSnapshot) {
        if (addr === this.payer.publicKey.toBase58()) continue;
        const currentAmount = currentHolders.get(addr) ?? 0;
        if (prevAmount > 0 && currentAmount < prevAmount * (1 - dropThreshold)) {
          const dropPct = ((prevAmount - currentAmount) / prevAmount * 100).toFixed(0);
          const holderPct = ((prevAmount / totalSupply) * 100).toFixed(1);
          logger.warn(`🐋 WHALE SELL: ${mintStr.slice(0,8)} holder ${addr.slice(0,8)} dropped ${dropPct}% (was ${holderPct}% of supply)`);
          logEvent('WHALE_SELL_DETECTED', {
            mint: mintStr, holder: addr.slice(0, 8), dropPct, holderPct,
            prevAmount, currentAmount, protocol: position.protocol,
          });

          const acquired = await this.sellingMutex.runExclusive(() => {
            if (this.sellingMints.has(mintStr)) return false;
            this.sellingMints.add(mintStr);
            return true;
          });
          if (!acquired) return;

          this.executeFullSell(position, mintStr, {
            action: 'full', reason: 'whale_sell' as any, urgent: true,
          }).catch(err => logger.error(`Whale sell exit failed for ${mintStr}:`, err));
          return;
        }
      }

      position.whaleSnapshot = currentHolders;
    } catch (err) {
      logger.debug(`[whale-check] Error for ${mintStr.slice(0,8)}: ${err}`);
    }
  }

  private async getPumpSwapReserves(mint: PublicKey) {
    const key = mint.toBase58() + '_swap';
    const cached = this.reservesCache.get(key);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) return cached.reserves;

    try {
      const state = getMintState(mint);
      if (!state.poolBaseTokenAccount || !state.poolQuoteTokenAccount) return null;
      const [baseBalance, quoteBalance] = await Promise.all([
        withRetry(() => withRpcLimit(() => this.connection.getTokenAccountBalance(state.poolBaseTokenAccount!))),
        withRetry(() => withRpcLimit(() => this.connection.getTokenAccountBalance(state.poolQuoteTokenAccount!))),
      ]);
      const result = {
        baseReserve: BigInt(baseBalance.value.amount),
        quoteReserve: BigInt(quoteBalance.value.amount),
      };
      this.reservesCache.set(key, { reserves: result, timestamp: Date.now() });
      return result;
    } catch {
      return null;
    }
  }

  private async getRaydiumReserves(position: Position): Promise<{ solReserve: bigint; tokenReserve: bigint } | null> {
    const mintStr = position.mint.toBase58();
    const key = mintStr + '_raydium';
    const cached = this.reservesCache.get(key);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) return cached.reserves;

    try {
      const state = getMintState(position.mint);
      const poolPk = state.raydiumPool;
      if (!poolPk) return null;

      if (position.protocol === 'raydium-launch') {
        // LaunchLab: read virtual reserves directly from pool account
        const acc = await withRetry(() => withRpcLimit(() => this.connection.getAccountInfo(poolPk)));
        if (!acc) return null;
        const pool = parseLaunchLabPool(acc.data);
        const result = { solReserve: pool.virtualB, tokenReserve: pool.virtualA };
        this.reservesCache.set(key, { reserves: result, timestamp: Date.now() });
        return result;
      }

      if (position.protocol === 'raydium-cpmm') {
        const acc = await withRetry(() => withRpcLimit(() => this.connection.getAccountInfo(poolPk)));
        if (!acc) return null;
        const pool = parseCpmmPool(acc.data);
        // Read vault token balances
        const [balA, balB] = await Promise.all([
          withRetry(() => withRpcLimit(() => this.connection.getTokenAccountBalance(pool.vaultA))),
          withRetry(() => withRpcLimit(() => this.connection.getTokenAccountBalance(pool.vaultB))),
        ]);
        const isBaseToken = pool.mintA.toBase58() !== config.wsolMint;
        const result = isBaseToken
          ? { tokenReserve: BigInt(balA.value.amount), solReserve: BigInt(balB.value.amount) }
          : { solReserve: BigInt(balA.value.amount), tokenReserve: BigInt(balB.value.amount) };
        this.reservesCache.set(key, { reserves: result, timestamp: Date.now() });
        return result;
      }

      if (position.protocol === 'raydium-ammv4') {
        const acc = await withRetry(() => withRpcLimit(() => this.connection.getAccountInfo(poolPk)));
        if (!acc) return null;
        const pool = parseAmmV4Pool(acc.data);
        const [baseBal, quoteBal] = await Promise.all([
          withRetry(() => withRpcLimit(() => this.connection.getTokenAccountBalance(pool.baseVault))),
          withRetry(() => withRpcLimit(() => this.connection.getTokenAccountBalance(pool.quoteVault))),
        ]);
        const result = { tokenReserve: BigInt(baseBal.value.amount), solReserve: BigInt(quoteBal.value.amount) };
        this.reservesCache.set(key, { reserves: result, timestamp: Date.now() });
        return result;
      }

      return null;
    } catch {
      return null;
    }
  }

  private async checkMinLiquidity(mint: PublicKey, protocol: 'pump.fun' | 'pumpswap'): Promise<boolean> {
    try {
      if (protocol === 'pump.fun') {
        const { virtualSolReserves } = await this.getPoolReserves(mint);
        return this.checkMinLiquidityFromReserves(virtualSolReserves, protocol);
      } else {
        const reserves = await this.getPumpSwapReserves(mint);
        if (!reserves) return false;
        const liquidity = safeNumber(reserves.quoteReserve, 'quoteRes') / 1e9;
        if (liquidity < config.strategy.pumpSwap.minLiquiditySol) {
          logger.warn(`Liquidity too low for PumpSwap ${mint.toBase58()}: ${liquidity.toFixed(3)} SOL`);
          return false;
        }
        return true;
      }
    } catch (err) {
      logger.error(`Failed to check liquidity for ${mint.toBase58()}:`, err);
      return false;
    }
  }

  private async isTipTooExpensive(): Promise<boolean> {
    if (Date.now() < this.pauseUntil) {
      logger.debug(`Paused until ${new Date(this.pauseUntil).toISOString()}`);
      return true;
    }
    // ── Execution quality kill-switch ────────────────────────────────────────
    // Jito status API returns false "Invalid" — real invalid rate is much lower.
    // Raised threshold to 90% and shortened pause to 2 min to avoid blocking trading.
    if (this.recentBundleResults.length >= this.BUNDLE_QUALITY_WINDOW) {
      const invalidCount = this.recentBundleResults.filter(v => !v).length;
      const invalidRate  = invalidCount / this.recentBundleResults.length;
      if (invalidRate >= 0.90) {
        const pauseMs = 2 * 60_000;
        this.pauseUntil = Date.now() + pauseMs;
        logger.warn(`🛑 Execution quality kill-switch: Invalid rate ${(invalidRate*100).toFixed(0)}% ≥ 90% over last ${this.BUNDLE_QUALITY_WINDOW} bundles — pausing ${pauseMs/60000} min`);
        logEvent('KILL_SWITCH_INVALID_RATE', { invalidRate, window: this.BUNDLE_QUALITY_WINDOW, pauseMs });
        this.recentBundleResults = [];
        return true;
      }
    }
    // ── Trade win-rate kill-switch ────────────────────────────────────────────
    // Если за последние 10 сделок win rate < 25% → пауза 10 минут.
    if (this.recentTradeWins.length >= this.TRADE_QUALITY_WINDOW) {
      const wins    = this.recentTradeWins.filter(v => v).length;
      const winRate = wins / this.recentTradeWins.length;
      if (winRate < 0.25) {
        const pauseMs = 10 * 60_000;
        this.pauseUntil = Date.now() + pauseMs;
        logger.warn(`🛑 Trade quality kill-switch: win rate ${(winRate*100).toFixed(0)}% < 25% over last ${this.TRADE_QUALITY_WINDOW} trades — pausing ${pauseMs/60000} min`);
        logEvent('KILL_SWITCH_WIN_RATE', { winRate, window: this.TRADE_QUALITY_WINDOW, pauseMs });
        this.recentTradeWins = [];
        return true;
      }
    }
    try {
      const tipLamports = await resolveTipLamports(1.0, false);
      const tipSol = tipLamports / 1e9;
      if (tipSol > config.strategy.maxJitoTipForEntry) {
        logger.warn(`Jito p75 ${tipSol.toFixed(4)} SOL > max ${config.strategy.maxJitoTipForEntry} — пауза покупок`);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // ── Quality tracking helpers ─────────────────────────────────────────────────
  private recordBundleResult(landed: boolean): void {
    this.recentBundleResults.push(landed);
    if (this.recentBundleResults.length > this.BUNDLE_QUALITY_WINDOW) {
      this.recentBundleResults.shift();
    }
  }

  private recordTradeResult(isWin: boolean): void {
    this.recentTradeWins.push(isWin);
    if (this.recentTradeWins.length > this.TRADE_QUALITY_WINDOW) {
      this.recentTradeWins.shift();
    }
    const winRate = this.recentTradeWins.filter(v => v).length / this.recentTradeWins.length;
    logEvent('TRADE_QUALITY', {
      winRate,
      window: this.recentTradeWins.length,
      recentWins: this.recentTradeWins.filter(v => v).length,
    });
    this.recalcDefensiveMode(winRate);
  }

  private getSocialMentionCount(mint: string): number | undefined {
    const sgCfg: any = (config.strategy as any).socialGate;
    if (!sgCfg?.enabled) return undefined;
    try {
      const now = Date.now();
      const signals = getSignalsForMint(mint, now - (sgCfg.lookbackMs ?? 300_000), now);
      return signals.length;
    } catch {
      return undefined;
    }
  }

  private recalcDefensiveMode(winRate: number): void {
    const dCfg = (config.strategy as any).defensive;
    if (!dCfg?.enabled) return;
    if (this.recentTradeWins.length < dCfg.window) return;
    const wasDefensive = this.defensiveMode;
    if (!wasDefensive && winRate < dCfg.entryThreshold) {
      this.defensiveMode = true;
      logger.warn(`🛡 Defensive mode ON: WR=${(winRate*100).toFixed(0)}% over last ${this.recentTradeWins.length} — filters tightened`);
      logEvent('DEFENSIVE_MODE_ON', { winRate, window: this.recentTradeWins.length });
      metrics.set('defensive_mode', 1);
    } else if (wasDefensive && winRate > dCfg.exitThreshold) {
      this.defensiveMode = false;
      logger.info(`✅ Defensive mode OFF: WR=${(winRate*100).toFixed(0)}% recovered`);
      logEvent('DEFENSIVE_MODE_OFF', { winRate, window: this.recentTradeWins.length });
      metrics.set('defensive_mode', 0);
    }
  }

  private getEffectiveMinScore(): number {
    const dCfg = (config.strategy as any).defensive;
    const base = config.strategy.minTokenScore;
    const defensiveBump = this.defensiveMode && dCfg?.enabled ? (dCfg.scoreDelta ?? 0) : 0;
    const adaptiveBump = this.getAdaptiveScoreBump();
    const combinedBump = Math.min(defensiveBump + adaptiveBump, 12);
    return base + combinedBump;
  }

  private getAdaptiveScoreBump(): number {
    const aCfg: any = (config.strategy as any).adaptiveScoring;
    if (!aCfg?.enabled) return 0;
    if (this.recentTradeWins.length < aCfg.window) return 0;

    const wins = this.recentTradeWins.filter(v => v).length;
    const winRate = wins / this.recentTradeWins.length;
    const target = aCfg.targetWinRate ?? 0.50;
    if (winRate >= target) return 0;

    // Бампим +bumpPerMiss за каждые 5pp ниже target
    const gapPp = (target - winRate) * 100;
    const raw = Math.ceil(gapPp / 5) * (aCfg.bumpPerMiss ?? 3);
    return Math.min(raw, aCfg.maxBump ?? 15);
  }

  private getEffectiveEntry(baseEntry: number): number {
    const dCfg = (config.strategy as any).defensive;
    return this.defensiveMode && dCfg?.enabled ? baseEntry * (dCfg.entryMultiplier ?? 1) : baseEntry;
  }

  private pushScoredToken(data: {
    mint: string; protocol: string; score: number; shouldEnter: boolean;
    entryMultiplier: number; reasons: string[]; rugcheckRisk: string;
    socialScore: number;
  }): void {
    const entry = { ...data, timestamp: Date.now() };
    this.recentScoredTokens.push(entry);
    if (this.recentScoredTokens.length > 200) this.recentScoredTokens.shift();
    this.safeEmit('token:scored', entry);
  }

  // ── F7: Blacklist management ────────────────────────────────────────────────

  addToBlacklist(mint: string): void {
    this.tokenBlacklist.add(mint);
    logger.info(`🚫 Token blacklisted: ${mint.slice(0, 8)}`);
    this.saveBlacklist().catch(e => logger.error('saveBlacklist failed:', e));
  }

  removeFromBlacklist(mint: string): boolean {
    const removed = this.tokenBlacklist.delete(mint);
    if (removed) {
      logger.info(`✅ Token unblacklisted: ${mint.slice(0, 8)}`);
      this.saveBlacklist().catch(e => logger.error('saveBlacklist failed:', e));
    }
    return removed;
  }

  addCreatorToBlacklist(creator: string): void {
    this.creatorBlacklist.add(creator);
    logger.info(`🚫 Creator blacklisted: ${creator.slice(0, 8)}`);
    this.saveBlacklist().catch(e => logger.error('saveBlacklist failed:', e));
  }

  removeCreatorFromBlacklist(creator: string): boolean {
    const removed = this.creatorBlacklist.delete(creator);
    if (removed) {
      logger.info(`✅ Creator unblacklisted: ${creator.slice(0, 8)}`);
      this.saveBlacklist().catch(e => logger.error('saveBlacklist failed:', e));
    }
    return removed;
  }

  isBlacklisted(mint: string, creator?: string): boolean {
    return this.tokenBlacklist.has(mint) || (!!creator && this.creatorBlacklist.has(creator));
  }

  getBlacklistStats(): { tokens: number; creators: number } {
    return { tokens: this.tokenBlacklist.size, creators: this.creatorBlacklist.size };
  }

  getBlacklist(): { tokens: string[]; creators: string[] } {
    return {
      tokens: [...this.tokenBlacklist],
      creators: [...this.creatorBlacklist],
    };
  }

  /**
   * Persist blacklist to data/blacklist.json so entries survive restarts.
   * Called fire-and-forget from every mutation; failures are logged but
   * don't throw — blacklist stays consistent in memory either way.
   *
   * After saving we refresh `blacklistMtime` so the polling reloader
   * doesn't ping-pong on our own writes.
   */
  private async saveBlacklist(): Promise<void> {
    saveBlacklist(this.tokenBlacklist, this.creatorBlacklist);
    this.blacklistMtime = getBlacklistMtime();
  }

  /** Load blacklist from disk on startup. Silent on ENOENT (first run). */
  private async loadBlacklist(): Promise<void> {
    const bl = loadBlacklist();
    this.tokenBlacklist = bl.tokens;
    this.creatorBlacklist = bl.creators;
    this.blacklistMtime = bl.loadedAt;
    logger.info(
      `[sniper] loaded blacklist: ${this.tokenBlacklist.size} tokens, ${this.creatorBlacklist.size} creators`,
    );
  }

  // ========== Web UI methods ==========

  public isRunning(): boolean {
    return this.running;
  }

  public isDefensiveMode(): boolean {
    return this.defensiveMode;
  }

  public async getWalletBalance(): Promise<number> {
    return (await this.getCachedBalance()) / 1e9;
  }

  // ── Wallet tracker proxies (for Web UI Copy-Trade page) ────────────────────

  public getTrackedWallets() {
    return this.walletTracker.getAll();
  }

  public addTrackedWallet(address: string): boolean {
    return this.walletTracker.addManual(address);
  }

  public removeTrackedWallet(address: string): boolean {
    return this.walletTracker.remove(address);
  }

  public setTrackedWalletTier(address: string, tier: 0 | 1 | 2): boolean {
    return this.walletTracker.setTier(address, tier);
  }

  // ── Social signals proxies (Phase 3) ────────────────────────────────────────
  //
  // Read-side helpers are fulfilled directly from SQLite via signal-store so the
  // Web UI /api/social endpoints work even when the bot is stopped. The manager
  // instance is only needed for the live 'signal' stream (Socket.IO) and for
  // diagnostics / on-the-fly source registration.

  public getSocialFeed(limit = 50, alphaOnly = false) {
    const rows = getRecentSignals(limit);
    return alphaOnly ? rows.filter(r => r.alpha) : rows;
  }

  public getSocialMentions(windowMs: number, limit = 20) {
    return getMentionCounts(windowMs, limit);
  }

  public getSocialStatus() {
    return this.socialManager.getStatus();
  }

  /** Subscribe to live 'signal' events — used by Socket.IO bridge. */
  public onSocialSignal(cb: (s: PhaseSocialSignal) => void): () => void {
    this.socialManager.on('signal', cb);
    return () => this.socialManager.off('signal', cb);
  }

  /** Subscribe to live 'alpha' events — only whitelisted signals. */
  public onSocialAlpha(cb: (s: PhaseSocialSignal) => void): () => void {
    this.socialManager.on('alpha', cb);
    return () => this.socialManager.off('alpha', cb);
  }

  public getOpenPositions(): any[] {
    return [...this.positions.values()].map(p => ({
      mint: p.mint,
      protocol: p.protocol,
      entryPrice: p.entryPrice,
      currentPrice: p.currentPrice,
      pnlPercent: p.pnlPercent,
      amount: p.amount,
      entryAmountSol: p.entryAmountSol,
      openedAt: p.openedAt,
      runnerTailActivated: p.runnerTailActivated,
    }));
  }

  public getActiveExitSignals(pos: any): string[] {
    const sigs: string[] = [];
    if (pos.trailingActivated) sigs.push('trailing');
    if (pos.runnerTailActivated) sigs.push('runner-tail');
    if (pos.drawdownStart) sigs.push('drawdown');
    return sigs;
  }

  public requestSell(mint: string, reason: string): void {
    if (this.sellingMints.has(mint) || !this.positions.has(mint)) return;
    const pos = this.positions.get(mint)!;
    this.executeFullSell(pos, mint, { action: 'full', reason: reason as any, urgent: true }).catch(() => {});
  }

  public getPreLaunchWatcher(): PreLaunchWatcher {
    return this.preLaunchWatcher;
  }

  public getTrendTrackedMints(): { mint: string; metrics: TrendMetrics }[] {
    const result: { mint: string; metrics: TrendMetrics }[] = [];
    for (const [mint] of this.trendTokenData) {
      const m = this.trendTracker.getMetrics(mint);
      if (m) result.push({ mint, metrics: m });
    }
    return result;
  }

  public getTrendTrackedCount(): number {
    return this.trendTracker.trackedCount;
  }

  private trackSkip(reason: string): void {
    this.eventsSkipped++;
    this.skipReasons.set(reason, (this.skipReasons.get(reason) ?? 0) + 1);
  }

  public getEventCounts() {
    const skipReasons: Record<string, number> = {};
    for (const [r, c] of this.skipReasons) skipReasons[r] = c;
    return {
      detected: this.eventsDetected,
      entered: this.eventsEntered,
      exited: this.eventsExited,
      skipped: this.eventsSkipped,
      skipReasons,
    };
  }

  public getExposure(): number {
    let total = 0;
    for (const pos of this.positions.values()) total += pos.entryAmountSol;
    return total;
  }

  public getStartBalance(): number {
    return this.startBalance / 1e9;
  }

  public onTrendEvent(event: string, cb: (mint: string, metrics: TrendMetrics) => void): () => void {
    this.trendTracker.on(event, cb);
    return () => this.trendTracker.off(event, cb);
  }

  /**
   * Polling check: if data/blacklist.json was edited externally (e.g. via
   * scripts/blacklist.ts CLI while the bot is running), reload it without
   * restarting. mtime tracking prevents reloading our own writes.
   */
  private checkBlacklistReload(): void {
    const mtime = getBlacklistMtime();
    if (mtime <= this.blacklistMtime) return;
    const bl = loadBlacklist();
    this.tokenBlacklist = bl.tokens;
    this.creatorBlacklist = bl.creators;
    this.blacklistMtime = bl.loadedAt;
    logger.info(`[blacklist] reloaded from disk: ${bl.tokens.size} tokens, ${bl.creators.size} creators`);
  }

  private checkSentinels(): void {
    if (checkSilence()) {
      logger.warn('[sentinel] No events for 5+ minutes — bot may be stuck');
      metrics.inc('sentinel_silence_total');
    }
    metrics.set('positions_open', this.positions.size);
    metrics.set('selling_mints', this.sellingMints.size);
  }
}
