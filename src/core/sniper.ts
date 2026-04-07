// src/core/sniper.ts
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction, TransactionMessage, TokenBalance, ComputeBudgetProgram } from '@solana/web3.js';
import { getAssociatedTokenAddress, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { Mutex } from 'async-mutex';
import bs58 from 'bs58';
import fs from 'fs/promises';
import path from 'path';
import { config, computeDynamicSlippage } from '../config';
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
  getPoolPDAByMint as getPoolPDA,
  parsePoolAccount,
  getPoolAuthorityPDA,
} from '../trading/pumpSwap';
import { sellTokenAuto } from './sell-engine';
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
  RaydiumCpmmNewPool,
  RaydiumAmmV4NewPool,
} from '../geyser/client';
import { buyTokenLaunchLab, parseLaunchLabPool } from '../trading/raydiumLaunchLab';
import { buyTokenCpmm, parseCpmmPool } from '../trading/raydiumCpmm';
import { buyTokenAmmV4, parseAmmV4Pool } from '../trading/raydiumAmmV4';
import { RAYDIUM_LAUNCHLAB_PROGRAM_ID, RAYDIUM_CPMM_PROGRAM_ID, RAYDIUM_AMM_V4_PROGRAM_ID } from '../constants';
import { updateMintState, getMintState, ensureAta } from './state-cache';
import { logger } from '../utils/logger';
import { isTokenSafeCached } from '../utils/safety';
import { checkSocialSignals, SocialSignal } from '../utils/social';
import { tradeLog, CloseReason } from '../utils/trade-logger';
import { lastTipPaid, resolveTipLamports, getBundleId, getInflightBundleStatuses, updateLandedStat, warmupJitoCache, sendJitoBurst, BurstResult } from '../jito/bundle';
import { PUMP_FUN_PROGRAM_ID, PUMP_SWAP_PROGRAM_ID, BONDING_CURVE_LAYOUT, PUMP_FUN_ROUTER_PROGRAM_ID, MAYHEM_FEE_RECIPIENTS } from '../constants';
import { startBlockhashCache, stopBlockhashCache, getCachedBlockhashWithHeight } from '../infra/blockhash-cache';
import { startPriorityFeeCache, stopPriorityFeeCache, getCachedPriorityFee } from '../infra/priority-fee-cache';
import { logEvent } from '../utils/event-logger';
import { metrics } from '../utils/metrics';
import { queueJitoSend } from '../infra/jito-queue';
import { withRetry } from '../utils/retry';
import { withRpcLimit } from '../utils/rpc-limiter';
import { getRuntimeLayout } from '../runtime-layout';
import { sellTokenJupiter, getJupiterQuote, sellTokenJupiterWithQuote } from '../trading/jupiter-sell';
import { detectProtocol } from './detector';
import { WalletTracker } from './wallet-tracker';
import { scoreToken, TokenFeatures } from '../utils/token-scorer';
import { checkRugcheck } from '../utils/rugcheck';

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

export class Sniper {
  private connection: Connection;
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
  private static readonly JUP_QUOTE_TTL = 5_000; // 5s TTL for pre-warmed quotes

  private createdATAs: Set<string> = new Set();

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

  private pumpSwapTokenAccounts: Map<string, { mint: string; type: 'base' | 'quote' }> = new Map();
  private pumpSwapReserveCache: Map<string, { baseReserve: bigint; quoteReserve: bigint }> = new Map();

  private firstBuyDetected: Set<string> = new Set();

  private recentBuysForMint: Map<string, PumpBuy[]> = new Map();
  private createSlotForMint: Map<string, number> = new Map();
  private walletBuyHistory: Map<string, { mints: Set<string>; lastSeen: number }> = new Map();
  private confirmedRealBuyers: Map<string, Set<string>> = new Map();
  private addOnBuyDone: Set<string> = new Set();
  private mintSocialScore: Map<string, number> = new Map();
  private creatorSellSeen: Set<string> = new Set();
  private sellFailureCount: Map<string, number> = new Map();

  private socialRetryTimers: Map<string, NodeJS.Timeout> = new Map();
  private earlyExitTimers: Map<string, NodeJS.Timeout> = new Map();

  // v3: Wallet Tracker для copy-trading (Stage 2)
  private walletTracker: WalletTracker;

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
    const mintCreateSlot = this.createSlotForMint.get(buy.mint);
    const buySlot = (buy as any).slot as number | undefined;
    if (buySlot && mintCreateSlot && Math.abs(buySlot - mintCreateSlot) <= 1) {
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
    this.connection = new Connection(config.rpc.url, { commitment: 'processed' });
    this.payer = Keypair.fromSecretKey(bs58.decode(config.wallet.privateKey));
    this.geyser = new GeyserClient();

    const [eventAuth] = PublicKey.findProgramAddressSync(
      [Buffer.from('__event_authority')],
      PUMP_PROGRAM_ID
    );
    this.eventAuthority = eventAuth;
    this.global = getGlobalPDA();
    this.walletTracker = new WalletTracker();

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

    stopBlockhashCache();
    stopPriorityFeeCache();
    startBlockhashCache(this.connection);
    startPriorityFeeCache(this.connection);

    this.seenCleanupInterval = setInterval(() => this.cleanSeenMints(), 60 * 60 * 1000);

    // v3: запуск wallet tracker (фоновый сбор данных для copy-trading)
    await this.walletTracker.start();

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
    return 'Снайпер запущен';
  }

  async stop(): Promise<string> {
    if (!this.running) return 'Снайпер уже остановлен';
    logger.info('Stopping sniper...');

    this.running = false;

    await this.closeAllPositions();
    this.stopMonitoring();
    this.geyser.stop();

    for (const { timer } of this.pendingBuys.values()) clearTimeout(timer);
    for (const timeout of this.optimisticTimeouts.values()) clearTimeout(timeout);
    for (const { timer } of this.mayhemPending.values()) clearTimeout(timer);
    for (const timer of this.socialRetryTimers.values()) clearTimeout(timer);
    for (const timer of this.earlyExitTimers.values()) clearTimeout(timer);
    this.socialRetryTimers.clear();
    this.earlyExitTimers.clear();

    // v3: остановка wallet tracker (сохранение на диск)
    await this.walletTracker.stop();
    this.pendingBuys.clear();
    this.optimisticTimeouts.clear();
    this.mayhemPending.clear();
    this.positions.clear();
    this.seenMints.clear();
    this.confirmedPositions.clear();

    for (const account of this.accountToMint.keys()) {
      this.geyser.removeAccount(new PublicKey(account));
    }
    this.accountToMint.clear();
    for (const account of this.pumpSwapTokenAccounts.keys()) {
      this.geyser.removeAccount(new PublicKey(account));
    }
    this.pumpSwapTokenAccounts.clear();
    this.pumpSwapReserveCache.clear();

    if (this.seenCleanupInterval) clearInterval(this.seenCleanupInterval);

    stopBlockhashCache();
    stopPriorityFeeCache();

    return 'Снайпер остановлен. Все позиции закрыты.';
  }

  private async closeAllPositions(): Promise<void> {
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

          this.emitTradeClose(position, mintStr, txId, 'manual', false, solReceived, closedAt);
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
    const currentBalance = await this.connection.getBalance(this.payer.publicKey);
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
      await fs.writeFile(POSITIONS_FILE, data, 'utf8');
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
      const arr = JSON.parse(raw) as Array<[string, number]>;
      for (const [mint, slot] of arr) {
        this.createSlotForMint.set(mint, slot);
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
        if (!this.pumpSwapTokenAccounts.has(baseStr)) {
          this.pumpSwapTokenAccounts.set(baseStr, { mint: mintStr, type: 'base' });
          this.geyser.addAccount(state.poolBaseTokenAccount);
        }
        if (!this.pumpSwapTokenAccounts.has(quoteStr)) {
          this.pumpSwapTokenAccounts.set(quoteStr, { mint: mintStr, type: 'quote' });
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

    for (const [mint, ts] of this.createSlotForMint.entries()) {
      if (now - ts > shortExpiry) this.createSlotForMint.delete(mint);
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

    // v3: очистка wallet tracker
    this.walletTracker.cleanup();

    logger.debug(
      `cleanSeenMints: seenMints=${this.seenMints.size} recentBuys=${this.recentBuysForMint.size} ` +
      `confirmedBuyers=${this.confirmedRealBuyers.size} socialScore=${this.mintSocialScore.size} ` +
      `creatorSell=${this.creatorSellSeen.size} sellFails=${this.sellFailureCount.size} ` +
      `walletHistory=${this.walletBuyHistory.size}`
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
    this.geyser.on('raydiumCpmmNewPool',      this.onRaydiumCpmmNewPool.bind(this));
    this.geyser.on('raydiumAmmV4NewPool',     this.onRaydiumAmmV4NewPool.bind(this));
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
          logger.debug(`[gRPC] Position ${mintStr} updated: price=${position.currentPrice.toFixed(12)} pnl=${position.pnlPercent.toFixed(1)}%`);

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
        const cached = this.pumpSwapReserveCache.get(swapInfo.mint) ?? { baseReserve: 0n, quoteReserve: 0n };

        if (swapInfo.type === 'base') {
          cached.baseReserve = amount;
        } else {
          cached.quoteReserve = amount;
        }
        this.pumpSwapReserveCache.set(swapInfo.mint, cached);

        if (cached.baseReserve > 0n && cached.quoteReserve > 0n) {
          const position = this.positions.get(swapInfo.mint);
          if (position) {
            position.updatePrice(safeNumber(cached.quoteReserve, 'quoteRes'), safeNumber(cached.baseReserve, 'baseRes'));
            position.updateErrors = 0;
            logger.debug(`[gRPC] PumpSwap ${swapInfo.mint.slice(0,8)} updated: price=${position.currentPrice.toFixed(12)} pnl=${position.pnlPercent.toFixed(1)}%`);

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
      const socialScore = this.mintSocialScore.get(mintStr) ?? 0;
      if (socialScore === 0) {
        logger.info(`🎯 Score=0 TP override: selling 100% of ${mintStr.slice(0,8)} at +${decision.tpLevelPercent}% (was ${(decision.portion! * 100).toFixed(0)}%)`);
        logEvent('TP_OVERRIDE_FULL_SELL', { mint: mintStr, originalPortion: decision.portion, tpLevel: decision.tpLevelPercent, socialScore });
        decision.action = 'full';
        decision.reason = 'tp_all';
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
          logger.error(`Full sell (TP override) error for ${mintStr}:`, err)
        );
        return;
      }

      const key = `${mintStr}:${decision.tpLevelPercent}`;
      let shouldSell = true;
      await this.partialSellingMutex.runExclusive(() => {
        if (this.partialSellingMints.has(key)) {
          shouldSell = false;
        } else {
          this.partialSellingMints.add(key);
        }
      });
      if (!shouldSell) {
        logger.debug(`Duplicate partial sell blocked: ${key}`);
        return;
      }
      this.executePartialSell(position, mintStr, decision)
        .catch(err => logger.error(`Partial sell error for ${mintStr}:`, err))
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

    // ── v3: Wallet Tracker — записываем buy для статистики ──
    const isSelfWallet = buyer === this.payer.publicKey.toBase58();
    if (!isSelfWallet) {
      this.walletTracker.recordBuy(buyer, mint, Number(buy.solLamports));

      // ── v3: Copy-trade signal → EXEC (2-tier, brainstorm v4) ──
      const ctSignal = config.strategy.copyTrade.enabled &&
          !this.positions.has(mint) && !this.pendingBuys.has(mint) &&
          this.positions.size < config.strategy.maxPositions
          ? this.walletTracker.isCopySignal(buyer, Number(buy.solLamports))
          : { signal: false as const };

      if (ctSignal.signal) {
        if (this.copyTradeCount >= config.strategy.copyTrade.maxPositions) {
          logger.debug(`CT skip: already ${this.copyTradeCount} CT position(s)`);
        } else {
          // Tier-based entry amount
          const ctEntryAmount = ctSignal.tier === 1
            ? config.strategy.copyTrade.entryAmountSol
            : ((config.strategy.copyTrade as any).tier2EntryAmountSol ?? config.strategy.copyTrade.entryAmountSol * 0.5);

          const totalExposure = [...this.positions.values()].reduce((s, p) => s + p.entryAmountSol, 0);
          if (totalExposure + ctEntryAmount <= config.strategy.maxTotalExposureSol) {
            logger.info(`🎯 COPY-TRADE T${ctSignal.tier} EXEC: ${buyer.slice(0,8)} bought ${mint.slice(0,8)} for ${(Number(buy.solLamports)/1e9).toFixed(4)} SOL, entry=${ctEntryAmount}`);
            logEvent('COPY_TRADE_EXEC', { mint, buyer: buyer.slice(0,8), solLamports: Number(buy.solLamports), tier: ctSignal.tier, entryAmount: ctEntryAmount });

            const ctMintPk = new PublicKey(mint);
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

    const alreadySeen = await this.seenMutex.runExclusive(() => {
      if (this.seenMints.has(token.mint)) return true;
      this.seenMints.set(token.mint, Date.now());
      return false;
    });
    if (alreadySeen) return;

    // HISTORY_DEV_SNIPER: запоминаем slot CREATE для детекции bundled buys
    if ((token as any).slot) {
      this.createSlotForMint.set(token.mint, (token as any).slot);
      this.scheduleCreateSlotsSave();
    }

    if (this.positions.size >= config.strategy.maxPositions) {
      logger.debug(`Max positions reached (${this.positions.size}), skip ${token.mint}`);
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

    logger.info(`🔥 NEW PUMP TOKEN DETECTED: ${token.mint}`);
    logEvent('CREATE', { mint: token.mint, creator: token.creator, bondingCurve: token.bondingCurve, tx: token.signature });

    const mintPubkey = new PublicKey(token.mint);
    const protocolInfo = await detectProtocol(this.connection, mintPubkey);
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

    if (this.pumpFunCount >= config.strategy.maxPumpFunPositions) {
      logger.debug(`Pump.fun slots full (${this.pumpFunCount}/${config.strategy.maxPumpFunPositions}), skip ${token.mint}`);
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
    if (tokenAge > config.strategy.maxTokenAgeMs) {
      logger.debug(`Token ${token.mint.slice(0,8)} too old (${tokenAge}ms > ${config.strategy.maxTokenAgeMs}ms), skip`);
      logEvent('BUY_SKIPPED_TOO_OLD', { mint: token.mint, ageMs: tokenAge });
      return;
    }

    const [tipTooExpensive, accountInfo] = await Promise.all([
      this.isTipTooExpensive(),
      withRetry(() => withRpcLimit(() => this.connection.getAccountInfo(bondingCurvePubkey, {
        commitment: 'processed'
      })), 3, 200).catch(() => null),
    ]);

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
        const multiplier = (token as any)._socialEntryMultiplier ?? config.strategy.socialLowMultiplier;
        logger.info(`🌪️ Mayhem + curveReady → scheduling delayed entry for ${token.mint.slice(0,8)} (social multiplier: ${multiplier})`);
        this.scheduleMayhemDelayedEntry(token, reserves.virtualSolReserves, reserves.virtualTokenReserves, multiplier);
        // ADDED LOG: ENTRY_DECISION for delayed mayhem
        logEvent('ENTRY_DECISION', {
          mint: token.mint,
          creator: token.creator,
          socialMultiplier: multiplier,
          adjustedEntry: Math.max(pumpFunCheck.entryAmountSol * multiplier, config.strategy.minEntryAmountSol),
          reason: 'curve_ready_mayhem_delayed'
        });
        return;
      }

      // Обычный вход с учётом социального множителя
      const multiplier = (token as any)._socialEntryMultiplier ?? config.strategy.socialLowMultiplier;
      const adjustedEntry = Math.max(pumpFunCheck.entryAmountSol * multiplier, config.strategy.minEntryAmountSol);
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
          logger.warn(`⏰ Pending buy for ${token.mint} timed out`);
          logEvent('BUY_PENDING_TIMEOUT', { mint: token.mint });
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
              const adjustedEntry = Math.max(getStrategyForProtocol('pump.fun').entryAmountSol * multiplier, config.strategy.minEntryAmountSol);
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
      Math.max(baseEntry * socialMultiplier, config.strategy.minEntryAmountSol),
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
      const adjustedEntryAmountSol = Math.max(
        pumpFunCfg.entryAmountSol * socialMultiplier,
        config.strategy.minEntryAmountSol
      );

      if (isMayhem) {
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
      const effectiveEntry   = this.getEffectiveEntry(overrideEntryAmountSol ?? cfg.entryAmountSol);
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
      await this.savePositions();
      this.subscribeToPositionAccount(position);

      const timeout = setTimeout(() => {
        if (this.positions.has(token.mint) && !this.confirmedPositions.has(token.mint)) {
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

  private async confirmAndUpdatePosition(token: PumpToken, txId: string, sharedConfirmed?: { value: boolean }) {
    const maxAttempts = config.jito.maxRetries;
    const RESEND_FROM_ATTEMPT = 2;
    const confirmInterval = config.timeouts.confirmIntervalMs;
    let tipMultiplier = 1.0;
    let invalidCount = 0;
    const MAX_INVALID_BEFORE_REMOVE = 4;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, confirmInterval));
      logEvent('CONFIRM_ATTEMPT', { mint: token.mint, attempt: attempt+1, txId, bundleId: getBundleId(txId) });

      let bundleStatus: string | undefined;

      try {
        const bundleId = getBundleId(txId);
        if (bundleId) {
          const statuses = await getInflightBundleStatuses([bundleId]);
          logger.info(`Bundle statuses raw [${token.mint.slice(0,8)}]: ${JSON.stringify(statuses)}`);
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

                    // ─── НОВОЕ: для токенов score=0 запускаем таймер раннего выхода ───
                    const socialScore = this.mintSocialScore.get(token.mint) ?? 0;
                    if (socialScore === 0 && !this.earlyExitTimers.has(token.mint) && !this.sellingMints.has(token.mint)) {
                      // Дифференцированный таймаут: socialLow (0.03 SOL) — 1000ms,
                      // full entry (0.15 SOL) — earlyExitTimeoutMs (1500ms).
                      // При socialLow рисковать 1.5с нет смысла — ранний выход дешёвый.
                      const isSocialLow = position.entryAmountSol <= pumpFunCfg.entryAmountSol * config.strategy.socialLowMultiplier * 1.1;
                      const earlyTimeout = isSocialLow ? Math.min(1000, config.strategy.earlyExitTimeoutMs) : config.strategy.earlyExitTimeoutMs;
                      const exitTimer = setTimeout(async () => {
                        logger.warn(`⏰ No independent buyer for ${token.mint.slice(0,8)} within ${earlyTimeout}ms — exiting position`);
                        logEvent('EARLY_EXIT_TIMEOUT', { mint: token.mint, timeoutMs: earlyTimeout, socialLow: isSocialLow });
                        const pos = this.positions.get(token.mint);
                        if (pos && !this.sellingMints.has(token.mint)) {
                          await this.executeFullSell(pos, token.mint, { action: 'full', reason: 'early_exit', urgent: true });
                        }
                        this.earlyExitTimers.delete(token.mint);
                      }, earlyTimeout);
                      this.earlyExitTimers.set(token.mint, exitTimer);
                      logger.info(`⏱️ Early exit timer started (${earlyTimeout}ms, socialLow=${isSocialLow}) for ${token.mint.slice(0,8)}`);
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
                    };
                    const scoringResult = scoreToken(features, this.getEffectiveMinScore());
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
              this.emitTradeClose(position, token.mint, txId, 'bundle_failed', false, 0, Date.now());
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
              // ── On-chain fallback: Jito status API may lie about "Invalid" ──
              // Check if tx actually landed on-chain before removing position
              try {
                const sigStatus = await withRpcLimit(() => this.connection.getSignatureStatuses([txId]));
                const status = sigStatus?.value?.[0];
                if (status && status.confirmationStatus && !status.err) {
                  logger.info(`🔄 Bundle "Invalid" but tx ${txId.slice(0,8)} LANDED on-chain (${status.confirmationStatus}) — treating as confirmed`);
                  logEvent('BUNDLE_INVALID_BUT_LANDED', { mint: token.mint, txId, confirmationStatus: status.confirmationStatus });
                  // Treat as Landed — fetch tx info and update position
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
                          logger.info(`✅ Position confirmed (on-chain fallback) for ${token.mint}: ${actualAmount} tokens at ${actualEntryPrice}`);
                          this.confirmedPositions.add(token.mint);
                          const timeout = this.optimisticTimeouts.get(token.mint);
                          if (timeout) { clearTimeout(timeout); this.optimisticTimeouts.delete(token.mint); }
                          tradeLog.open({
                            mint: token.mint, protocol: 'pump.fun', entryPrice: actualEntryPrice,
                            amountSol: position.entryAmountSol, tokensReceived: actualAmount,
                            slippageBps: pumpFunCfg.slippageBps, jitoTipSol: lastTipPaid, txId, openedAt: position.openedAt,
                          });
                          return;
                        }
                      }
                    }
                  }
                  return; // tx landed but couldn't parse — don't remove position
                }
              } catch (err) {
                logger.warn(`On-chain fallback check failed for ${token.mint}:`, err);
              }

              logger.warn(`🗑️ ${invalidCount} Invalid bundles for ${token.mint} — removing optimistic position`);
              const position = this.positions.get(token.mint);
              if (position) {
                this.emitTradeClose(position, token.mint, txId, 'bundle_invalid_repeated', false, 0, Date.now());
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
                    const isSocialLow2 = position.entryAmountSol <= pumpFunCfg.entryAmountSol * config.strategy.socialLowMultiplier * 1.1;
                    const earlyTimeout2 = isSocialLow2 ? Math.min(1000, config.strategy.earlyExitTimeoutMs) : config.strategy.earlyExitTimeoutMs;
                    const exitTimer = setTimeout(async () => {
                      logger.warn(`⏰ No independent buyer for ${token.mint.slice(0,8)} within ${earlyTimeout2}ms — exiting position`);
                      logEvent('EARLY_EXIT_TIMEOUT', { mint: token.mint, timeoutMs: earlyTimeout2, socialLow: isSocialLow2 });
                      const pos = this.positions.get(token.mint);
                      if (pos && !this.sellingMints.has(token.mint)) {
                        await this.executeFullSell(pos, token.mint, { action: 'full', reason: 'early_exit', urgent: true });
                      }
                      this.earlyExitTimers.delete(token.mint);
                    }, earlyTimeout2);
                    this.earlyExitTimers.set(token.mint, exitTimer);
                    logger.info(`⏱️ Early exit timer started (${earlyTimeout2}ms, socialLow=${isSocialLow2}) for ${token.mint.slice(0,8)}`);
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
    }
  }

  private async onNewPumpSwapToken(token: PumpSwapNewPool) {
    if (!this.running) return;

    const hasOpenPosition = this.positions.has(token.mint);

    const alreadySeenSwap = await this.seenMutex.runExclusive(() => {
      if (this.seenMints.has(token.mint) && !hasOpenPosition) return true;
      this.seenMints.set(token.mint, Date.now());
      return false;
    });
    if (alreadySeenSwap) return;

    logger.info(`🔥 NEW PUMP SWAP TOKEN DETECTED: ${token.mint}`);
    logEvent('CREATE_POOL', { mint: token.mint, creator: token.creator, quoteMint: token.quoteMint });

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
        updateMintState(mintPubkey, {
          creator: new PublicKey(token.creator),
          pool: poolAddr,
          isPumpSwap: true,
          poolBaseTokenAccount: poolState.poolBaseTokenAccount,
          poolQuoteTokenAccount: poolState.poolQuoteTokenAccount,
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

    if (config.strategy.pumpSwapInstantEntry) {
      if (this.positions.size >= config.strategy.maxPositions) return;
      if (this.pumpSwapCount >= config.strategy.maxPumpSwapPositions) return;
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

      // Duplicate rugcheck removed — already checked in Promise.all above

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
    }

    if (this.positions.size >= config.strategy.maxPositions) return;
    if (this.pumpSwapCount >= config.strategy.maxPumpSwapPositions) return;
    if (this.positions.has(buy.mint)) return;

    if (await this.isTipTooExpensive()) return;

    const totalExposurePswap = [...this.positions.values()].reduce((s, p) => s + p.entryAmountSol, 0);
    if (totalExposurePswap >= config.strategy.maxTotalExposureSol) {
      logger.warn(`PumpSwap buy: exposure ${totalExposurePswap.toFixed(3)} SOL >= limit, skip ${buy.mint.slice(0,8)}`);
      return;
    }

    if (!this.seenMints.has(buy.mint)) {
      logger.warn(`PumpSwap buy for unknown mint ${buy.mint}, ignoring`);
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
      return;
    }

    // Duplicate rugcheck removed — already checked in Promise.all above

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

      await this.createOptimisticPumpSwapPosition(mintPubkey, txId);

      this.confirmAndUpdatePumpSwapPosition(mintPubkey, txId).catch(err =>
        logger.error(`Background confirm error for PumpSwap ${buy.mint}:`, err)
      );

    } catch (error) {
      logger.error('PumpSwap buy failed:', error);
      logEvent('PUMP_SWAP_BUY_FAIL', { mint: buy.mint, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async createOptimisticPumpSwapPosition(mint: PublicKey, txId: string) {
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
      const baseReserve  = BigInt(baseBalance.value.amount);
      const quoteReserve = BigInt(quoteBalance.value.amount);
      const decimals     = baseBalance.value.decimals;

      const pumpSwapCfg      = getStrategyForProtocol('pumpswap');
      const amountInLamports = BigInt(Math.floor(pumpSwapCfg.entryAmountSol * 1e9));
      const expectedTokens   = safeNumber((amountInLamports * baseReserve) / quoteReserve, 'expectedTokensRaw') / Math.pow(10, decimals);
      const entryPrice       = pumpSwapCfg.entryAmountSol / expectedTokens;

      const position = new Position(
        mint,
        entryPrice,
        expectedTokens,
        { programId: PUMP_SWAP_PROGRAM_ID, quoteMint: config.wsolMint },
        decimals,
        {
          entryAmountSol:   pumpSwapCfg.entryAmountSol,
          protocol:         'pumpswap',
          feeRecipientUsed: undefined,
        }
      );

      this.positions.set(mint.toBase58(), position);
      await this.savePositions();
      logger.info(`📈 Optimistic PumpSwap position opened: ${expectedTokens} tokens at ${entryPrice} SOL (tx: ${txId})`);
      logEvent('OPTIMISTIC_PUMP_SWAP_POSITION', { mint: mint.toBase58(), txId, expectedTokens, entryPrice });

      this.subscribeToPositionAccount(position);

      const timeout = setTimeout(() => {
        if (this.positions.has(mint.toBase58()) && !this.confirmedPositions.has(mint.toBase58())) {
          logger.warn(`Optimistic PumpSwap position for ${mint.toBase58()} timed out, removing`);
          this.unsubscribeFromPositionAccount(position);
          this.positions.delete(mint.toBase58());
          this.copyTradeMints.delete(mint.toBase58());
          this.savePositions().catch(e => logger.error('Failed to save after timeout:', e));
          logEvent('OPTIMISTIC_PUMP_SWAP_TIMEOUT', { mint: mint.toBase58() });
        }
        this.optimisticTimeouts.delete(mint.toBase58());
      }, config.timeouts.optimisticPositionTtlMs);
      this.optimisticTimeouts.set(mint.toBase58(), timeout);

    } catch (err) {
      logger.error(`Failed to create optimistic PumpSwap position for ${mint.toBase58()}:`, err);
    }
  }

  private async confirmAndUpdatePumpSwapPosition(mint: PublicKey, txId: string) {
    const maxAttempts = config.jito.maxRetries;
    const RESEND_FROM_ATTEMPT = 2;
    const confirmInterval = config.timeouts.confirmIntervalMs;
    let tipMultiplier = 1.0;
    let invalidCount = 0;
    const MAX_INVALID_BEFORE_REMOVE = 4;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, confirmInterval));
      logEvent('CONFIRM_ATTEMPT', { mint: mint.toBase58(), attempt: attempt+1, txId, bundleId: getBundleId(txId) });

      let bundleStatus: string | undefined;

      try {
        const bundleId = getBundleId(txId);
        if (bundleId) {
          const statuses = await getInflightBundleStatuses([bundleId]);
          logger.info(`Bundle statuses raw [PumpSwap ${mint.toBase58().slice(0,8)}]: ${JSON.stringify(statuses)}`);
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
                  const pumpSwapCfg = getStrategyForProtocol('pumpswap');
                  const entryPrice  = pumpSwapCfg.entryAmountSol / actualAmount;
                  const position = this.positions.get(mint.toBase58());
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
              this.emitTradeClose(position, mint.toBase58(), txId, 'bundle_failed', false, 0, Date.now());
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
              // ── On-chain fallback: Jito status API may lie about "Invalid" ──
              const mintStr = mint.toBase58();
              try {
                const sigStatus = await withRpcLimit(() => this.connection.getSignatureStatuses([txId]));
                const status = sigStatus?.value?.[0];
                if (status && status.confirmationStatus && !status.err) {
                  logger.info(`🔄 PumpSwap Bundle "Invalid" but tx ${txId.slice(0,8)} LANDED on-chain (${status.confirmationStatus})`);
                  logEvent('BUNDLE_INVALID_BUT_LANDED', { mint: mintStr, txId, confirmationStatus: status.confirmationStatus });
                  updateLandedStat(true);
                  this.recordBundleResult(true);
                  const txInfoSwap = await withRpcLimit(() => this.connection.getTransaction(txId, {
                    commitment: 'confirmed',
                    maxSupportedTransactionVersion: 0,
                  }));
                  const postBalance = txInfoSwap?.meta?.postTokenBalances?.find(
                    (b: TokenBalance) => b.owner === this.payer.publicKey.toBase58() && b.mint === mintStr
                  );
                  if (postBalance) {
                    const actualAmount = Number(postBalance.uiTokenAmount.uiAmount ?? 0);
                    const decimals = postBalance.uiTokenAmount.decimals;
                    if (actualAmount > 0) {
                      const pumpSwapCfg = getStrategyForProtocol('pumpswap');
                      const entryPrice = pumpSwapCfg.entryAmountSol / actualAmount;
                      const position = this.positions.get(mintStr);
                      if (position) {
                        position.amount = actualAmount;
                        position.entryPrice = entryPrice;
                        position.tokenDecimals = decimals;
                        await this.savePositions();
                        logger.info(`✅ PumpSwap position confirmed (on-chain fallback): ${actualAmount} tokens at ${entryPrice}`);
                        this.confirmedPositions.add(mintStr);
                        const timeout = this.optimisticTimeouts.get(mintStr);
                        if (timeout) { clearTimeout(timeout); this.optimisticTimeouts.delete(mintStr); }
                        tradeLog.open({
                          mint: mintStr, protocol: 'pumpswap', entryPrice,
                          amountSol: pumpSwapCfg.entryAmountSol, tokensReceived: actualAmount,
                          slippageBps: pumpSwapCfg.slippageBps, jitoTipSol: lastTipPaid, txId, openedAt: position.openedAt,
                        });
                        return;
                      }
                    }
                  }
                  return;
                }
              } catch (err) {
                logger.warn(`On-chain fallback check failed for PumpSwap ${mintStr}:`, err);
              }

              logger.warn(`🗑️ ${invalidCount} Invalid bundles for PumpSwap ${mint.toBase58()} — removing optimistic position`);
              const position = this.positions.get(mint.toBase58());
              if (position) {
                this.emitTradeClose(position, mint.toBase58(), txId, 'bundle_invalid_repeated', false, 0, Date.now());
                this.positions.delete(mint.toBase58());
                this.copyTradeMints.delete(mint.toBase58());
                await this.savePositions();
              }
              logEvent('PUMP_SWAP_BUY_FAIL', { mint: mint.toBase58(), txId, reason: `bundle_invalid_x${invalidCount}` });
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

    // v3: записываем sell для wallet tracker (всегда, до других проверок)
    this.walletTracker.recordSell(sell.seller, sell.mint, Number(sell.solLamports ?? 0));

    if (!config.strategy.creatorSellExit) return;

    const position = this.positions.get(sell.mint);
    if (!position) return;
    if (!position.creator) return;

    if (sell.seller === position.creator) {
      logger.warn(`🚨 CREATOR SELL DETECTED [pump.fun]: ${sell.mint.slice(0,8)}, seller=${sell.seller.slice(0,8)}, amount=${sell.amount}, tx=${sell.signature.slice(0,8)}`);
      logEvent('CREATOR_SELL', { mint: sell.mint, seller: sell.seller, amount: sell.amount.toString(), protocol: position.protocol, tx: sell.signature });

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

  private async onPumpSwapSellDetected(sell: PumpSwapSell) {
    if (!this.running) return;
    logger.debug(`🔄 PUMP SWAP SELL DETECTED: ${sell.mint} amount=${sell.amount}`);
    logEvent('PUMP_SWAP_SELL_DETECTED', { mint: sell.mint, amount: sell.amount.toString() });

    // v3: записываем sell для wallet tracker
    this.walletTracker.recordSell(sell.creator, sell.mint, Number(sell.solLamports ?? 0));

    if (!config.strategy.creatorSellExit) return;

    const position = this.positions.get(sell.mint);
    if (!position) return;
    if (!position.creator) return;

    if (sell.creator === position.creator) {
      logger.warn(`🚨 CREATOR SELL DETECTED [PumpSwap]: ${sell.mint.slice(0,8)}, seller=${sell.creator.slice(0,8)}, amount=${sell.amount}, tx=${sell.signature.slice(0,8)}`);
      logEvent('CREATOR_SELL', { mint: sell.mint, seller: sell.creator, amount: sell.amount.toString(), protocol: position.protocol, tx: sell.signature });

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

  // ═══ Raydium Event Handlers ════════════════════════════════════════════════

  private async onRaydiumLaunchCreate(event: RaydiumLaunchCreate) {
    if (!this.running) return;
    if (this.positions.size >= config.strategy.maxPositions) return;
    if (this.raydiumLaunchCount >= config.strategy.maxRaydiumLaunchPositions) return;

    const mintStr = event.mint;
    if (this.seenMints.has(mintStr)) return;
    if (this.positions.has(mintStr)) return;
    if (this.pendingBuys.has(mintStr)) return;

    this.seenMints.set(mintStr, Date.now());

    logger.info(`🚀 RAYDIUM LAUNCH CREATE: ${mintStr.slice(0, 8)}, pool=${event.pool.slice(0, 8)}`);
    logEvent('RAYDIUM_LAUNCH_CREATE', { mint: mintStr, pool: event.pool, creator: event.creator });

    const mint = new PublicKey(mintStr);
    updateMintState(mint, {
      isRaydiumLaunch: true,
      raydiumPool: new PublicKey(event.pool),
      creator: new PublicKey(event.creator),
    });

    // Не входим сразу — ждём подтверждение спроса через buy event
  }

  private async onRaydiumLaunchBuy(event: RaydiumLaunchBuy) {
    if (!this.running) return;
    if (this.positions.size >= config.strategy.maxPositions) return;
    if (this.raydiumLaunchCount >= config.strategy.maxRaydiumLaunchPositions) return;

    const mintStr = event.mint;
    if (this.positions.has(mintStr)) return;

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

    const mint = new PublicKey(mintStr);
    const cfg = config.strategy.raydiumLaunch;

    // ── Параллельная проверка rugcheck + balance ──
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

      // Создаём оптимистичную позицию (amount=0 — обновится после подтверждения)
      const position = new Position(
        mint, cfg.entryAmountSol, 0,
        { programId: 'raydium-launchlab', quoteMint: config.wsolMint },
        6,
        {
          entryAmountSol: cfg.entryAmountSol,
          protocol: 'raydium-launch',
          creator: event.buyer,
        }
      );
      this.positions.set(mintStr, position);
      this.confirmedPositions.add(mintStr);
      logger.info(`✅ RAYDIUM LAUNCH POSITION OPENED: ${mintStr.slice(0, 8)}`);
      logEvent('POSITION_OPENED', { mint: mintStr, protocol: 'raydium-launch', entryAmountSol: cfg.entryAmountSol });
    } catch (err) {
      logger.error(`Failed to buy Raydium LaunchLab token ${mintStr.slice(0, 8)}: ${err}`);
    }
  }

  private async onRaydiumCpmmNewPool(event: RaydiumCpmmNewPool) {
    if (!this.running) return;
    if (this.positions.size >= config.strategy.maxPositions) return;
    if (this.raydiumCpmmCount >= config.strategy.maxRaydiumCpmmPositions) return;

    const mintStr = event.mint;
    if (this.seenMints.has(mintStr)) return;
    if (this.positions.has(mintStr)) return;

    this.seenMints.set(mintStr, Date.now());

    logger.info(`🆕 RAYDIUM CPMM NEW POOL: ${mintStr.slice(0, 8)}, pool=${event.pool.slice(0, 8)}`);
    logEvent('RAYDIUM_CPMM_NEW_POOL', { mint: mintStr, pool: event.pool, creator: event.creator });

    const mint = new PublicKey(mintStr);
    updateMintState(mint, {
      isRaydiumCpmm: true,
      raydiumPool: new PublicKey(event.pool),
    });

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

      const position = new Position(
        mint, cfg.entryAmountSol, 0,
        { programId: 'raydium-cpmm', quoteMint: config.wsolMint },
        6,
        {
          entryAmountSol: cfg.entryAmountSol,
          protocol: 'raydium-cpmm',
          creator: event.creator,
        }
      );
      this.positions.set(mintStr, position);
      this.confirmedPositions.add(mintStr);
      logger.info(`✅ RAYDIUM CPMM POSITION OPENED: ${mintStr.slice(0, 8)}`);
      logEvent('POSITION_OPENED', { mint: mintStr, protocol: 'raydium-cpmm', entryAmountSol: cfg.entryAmountSol });
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

    // Только wSOL-пары
    if (event.quoteMint !== config.wsolMint) return;

    this.seenMints.set(mintStr, Date.now());

    logger.info(`🆕 RAYDIUM AMM V4 NEW POOL: ${mintStr.slice(0, 8)}, pool=${event.pool.slice(0, 8)}`);
    logEvent('RAYDIUM_AMM_V4_NEW_POOL', { mint: mintStr, pool: event.pool });

    const mint = new PublicKey(mintStr);
    updateMintState(mint, {
      isRaydiumAmmV4: true,
      raydiumPool: new PublicKey(event.pool),
    });

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

      const position = new Position(
        mint, cfg.entryAmountSol, 0,
        { programId: 'raydium-ammv4', quoteMint: config.wsolMint },
        6,
        {
          entryAmountSol: cfg.entryAmountSol,
          protocol: 'raydium-ammv4',
        }
      );
      this.positions.set(mintStr, position);
      this.confirmedPositions.add(mintStr);
      logger.info(`✅ RAYDIUM AMM V4 POSITION OPENED: ${mintStr.slice(0, 8)}`);
      logEvent('POSITION_OPENED', { mint: mintStr, protocol: 'raydium-ammv4', entryAmountSol: cfg.entryAmountSol });
    } catch (err) {
      logger.error(`Failed to buy Raydium AMM v4 token ${mintStr.slice(0, 8)}: ${err}`);
    }
  }

  private startMonitoring() {
    if (this.monitoringInterval) clearTimeout(this.monitoringInterval);
    // 600ms base + random jitter 0-200ms = 600-800ms effective.
    // Stagger внутри checkPositions (50ms между позициями) снижает RPC burst.
    // При 4 позициях: 4 × getAccountInfo за 600-800ms = ~5-6 req/s вместо 10 req/s.
    const scheduleNext = () => {
      const jitter = Math.floor(Math.random() * 200);
      this.monitoringInterval = setTimeout(() => {
        this.checkPositions().finally(scheduleNext);
      }, 600 + jitter);
    };
    scheduleNext();
    logger.info('Position monitoring started (interval 600-800ms with jitter)');
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
              position.updatePrice(Number(quote), Number(base));
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

        // ── Jupiter pre-warm (brainstorm v4): speculatively fetch quote ──
        // When PnL > 50% or position age > 30s, pre-warm Jupiter quote in background.
        // This saves 1-2s when Jupiter fallback is needed after all sell attempts fail.
        const cached = this.jupiterQuoteCache.get(mintStr);
        const needsWarm = !cached || Date.now() - cached.fetchedAt > Sniper.JUP_QUOTE_TTL;
        if (needsWarm && (position.pnlPercent > 50 || Date.now() - position.openedAt > 30_000)) {
          const tokenAmount = BigInt(Math.floor(position.amount * 10 ** position.tokenDecimals));
          if (tokenAmount > 0n) {
            getJupiterQuote(mintStr, tokenAmount).then(result => {
              if (result) {
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
    this.sellingMints.add(mintStr);
    try {
      const closedAt = Date.now();
      const mintPk = new PublicKey(mintStr);

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
          const ataInfo = await withRpcLimit(() => this.connection.getTokenAccountBalance(ata));
          const ataAmount = ataInfo?.value ? BigInt(ataInfo.value.amount) : 0n;
          if (ataAmount === 0n) {
            logger.warn(`🗑️ ATA empty before sell for ${mintStr.slice(0,8)} — position already sold or buy never landed`);
            logEvent('SELL_ATA_EMPTY_BEFORE', { mint: mintStr, reason: decision.reason });
            this.emitTradeClose(position, mintStr, '', decision.reason ?? 'ata_empty', decision.urgent ?? false, 0, closedAt);
            this.totalTrades++;
            this.consecutiveLosses++;
            this.recordTradeResult(false); // FIX: ATA empty = loss для defensive mode
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
        this.emitTradeClose(position, mintStr, '', (decision.reason ?? 'rpc_error') as CloseReason, decision.urgent ?? false, 0, closedAt);
        this.totalTrades++;
        this.consecutiveLosses++;
        this.recordTradeResult(false); // FIX: ATA failed = loss для defensive mode
        this.positions.delete(mintStr);
        this.copyTradeMints.delete(mintStr);
        this.sellFailureCount.delete(mintStr);
        await this.savePositions();
        this.unsubscribeFromPositionAccount(position);
        return;
      }

      logEvent('SELL_ATTEMPT', { mint: mintStr, amount: position.amount, reason: decision.reason, urgent: decision.urgent });

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

      for (let attempt = 0; attempt < MAX_SELL_ATTEMPTS; attempt++) {
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
            decision.urgent ? Math.min(getStrategyForProtocol(position.protocol).slippageBps * 3, 5000) : getStrategyForProtocol(position.protocol).slippageBps,
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
              if (status?.confirmationStatus && !status.err) {
                confirmedTxId = allSentTxIds[i];
                sellSuccess = true;
                logger.info(`Sell confirmed (attempt ${attempt+1}, tx #${i+1}, path=${sellPath}, ${elapsed}ms): ${confirmedTxId.slice(0,8)} for ${mintStr.slice(0,8)}`);
                logEvent('SELL_PATH_CONFIRMED', { mint: mintStr, path: sellPath, attempt: attempt+1, pollMs: elapsed });
                metrics.inc(`sell_path_${sellPath.replace(/[^a-z]/g,'_')}_ok`);
                break;
              }
            }
          }
          if (sellSuccess) break;

          logger.info(`Sell attempt ${attempt+1}/${MAX_SELL_ATTEMPTS} not confirmed after ${maxWait}ms for ${mintStr.slice(0,8)}`);
          logEvent('SELL_NOT_CONFIRMED', { mint: mintStr, attempt: attempt + 1, txId: txId.slice(0,8), pollMs: maxWait });
        } catch (err) {
          logger.warn(`Sell attempt ${attempt+1} exception for ${mintStr.slice(0,8)}:`, err);
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
              this.emitTradeClose(position, mintStr, lastTxId, decision.reason ?? 'unknown', decision.urgent ?? false, Math.max(0, solReceived), closedAt);
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
            this.emitTradeClose(position, mintStr, jupTxId, (decision.reason ?? 'manual') as CloseReason, decision.urgent ?? false, solReceived, closedAt);
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

        // Реально не удалось продать. Принимаем потерю, удаляем позицию.
        this.emitTradeClose(position, mintStr, lastTxId, (decision.reason ?? 'rpc_error') as CloseReason, decision.urgent ?? false, 0, closedAt);
        this.totalTrades++;
        this.consecutiveLosses++;
        this.recordTradeResult(false); // FIX: force-close = loss, defensive mode должен это видеть
        if (config.strategy.consecutiveLossesMax && this.consecutiveLosses >= config.strategy.consecutiveLossesMax) {
          logger.warn(`❗ ${this.consecutiveLosses} consecutive losses, pausing buys for ${config.strategy.pauseAfterLossesMs / 60000} min`);
          this.pauseUntil = Date.now() + config.strategy.pauseAfterLossesMs;
        }
        this.positions.delete(mintStr);
        this.copyTradeMints.delete(mintStr);
        this.sellFailureCount.delete(mintStr);
        await this.savePositions();
        this.unsubscribeFromPositionAccount(position);
        return;
      }

      // ── Sell succeeded — read actual SOL received ──────────────────────────
      this.sellFailureCount.delete(mintStr);

      let solReceived = 0;
      try {
        const txInfo = await this.connection.getTransaction(confirmedTxId, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });

        if (txInfo?.meta && !txInfo.meta.err) {
          const preBalance = txInfo.meta.preBalances[0] ?? 0;
          const postBalance = txInfo.meta.postBalances[0] ?? 0;
          solReceived = Math.max(0, (postBalance - preBalance) / 1e9);
        }
      } catch (err) {
        logger.warn(`Failed to read sell TX details for ${mintStr.slice(0,8)}:`, err);
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
      logEvent('SELL_SUCCESS', { mint: mintStr, reason: decision.reason, urgent: decision.urgent, solReceived, totalReceived, txId: confirmedTxId });

      this.emitTradeClose(position, mintStr, confirmedTxId, decision.reason ?? 'unknown', decision.urgent ?? false, solReceived, closedAt);
      this.totalTrades++;
      this.positions.delete(mintStr);
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
        };
        const effMinScore = this.getEffectiveMinScore();
        const scoringResult = scoreToken(features, effMinScore);
        logEvent('ADDON_SCORE', { mint: mintStr, score: scoringResult.score, enter: scoringResult.shouldEnter, reasons: scoringResult.reasons });
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

    const txInfo = await this.connection.getTransaction(txId!, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });

    let solReceived = 0;
    if (txInfo?.meta && !txInfo.meta.err) {
      const preBalance = txInfo.meta.preBalances[0] ?? 0;
      const postBalance = txInfo.meta.postBalances[0] ?? 0;
      solReceived = Math.max(0, (postBalance - preBalance) / 1e9);
    }

    if (decision.tpLevelPercent) {
      position.markTpLevel(decision.tpLevelPercent);
    }
    position.reduceAmount(decision.portion!, solReceived);

    if (position.amount <= 1e-9) {
      logger.info(`Position ${mintStr} reduced to zero, closing`);
      this.positions.delete(mintStr);
      this.copyTradeMints.delete(mintStr);
      await this.savePositions();
      this.unsubscribeFromPositionAccount(position);
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

  private emitTradeClose(
    position: Position,
    mintStr: string,
    txId: string,
    reason: CloseReason,
    urgent: boolean,
    finalSolReceived: number,
    closedAt: number
  ) {
    const totalSolReceived = finalSolReceived + position.partialSolReceived;
    const pnlSol = totalSolReceived - position.entryAmountSol;
    const pnlPercent = (pnlSol / position.entryAmountSol) * 100;
    const durationMs = closedAt - position.openedAt;

    tradeLog.close({
      mint: mintStr,
      protocol: position.protocol,
      reason,
      urgent,
      entryPrice: position.entryPrice,
      exitPrice: position.currentPrice,
      peakPrice: position.maxPrice,
      peakPnlPercent: position.peakPnlPercent,
      entryAmountSol: position.entryAmountSol,
      finalSolReceived,
      partialSolReceived: position.partialSolReceived,
      totalSolReceived,
      pnlSol,
      pnlPercent,
      openedAt: position.openedAt,
      closedAt,
      durationMs,
      durationSec: durationMs / 1000,
      txId,
      partialSells: position.partialSellsCount,
      priceHistory: position.priceHistory,
      configSnapshot: position.configSnapshot,
    });
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
    // Если за последние 20 bundle >= 70% Invalid → пауза 5 минут.
    // Причина: высокая доля Invalid = проблема с decoder или instruction build,
    // а не с рынком. Продолжать торговать = сжигать SOL на gas впустую.
    if (this.recentBundleResults.length >= this.BUNDLE_QUALITY_WINDOW) {
      const invalidCount = this.recentBundleResults.filter(v => !v).length;
      const invalidRate  = invalidCount / this.recentBundleResults.length;
      if (invalidRate >= 0.70) {
        const pauseMs = 5 * 60_000;
        this.pauseUntil = Date.now() + pauseMs;
        logger.warn(`🛑 Execution quality kill-switch: Invalid rate ${(invalidRate*100).toFixed(0)}% ≥ 70% over last ${this.BUNDLE_QUALITY_WINDOW} bundles — pausing ${pauseMs/60000} min`);
        logEvent('KILL_SWITCH_INVALID_RATE', { invalidRate, window: this.BUNDLE_QUALITY_WINDOW, pauseMs });
        this.recentBundleResults = []; // сбрасываем — после паузы даём шанс
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
    return this.defensiveMode && dCfg?.enabled ? base + (dCfg.scoreDelta ?? 0) : base;
  }

  private getEffectiveEntry(baseEntry: number): number {
    const dCfg = (config.strategy as any).defensive;
    return this.defensiveMode && dCfg?.enabled ? baseEntry * (dCfg.entryMultiplier ?? 1) : baseEntry;
  }
}