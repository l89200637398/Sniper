// src/core/wallet-tracker.ts
//
// v3: Автоматическое обнаружение прибыльных кошельков из gRPC потока.
// Отслеживает buy/sell каждого кошелька, вычисляет win rate,
// генерирует copy-trade сигналы для eligible кошельков.
//
// Работает полностью в фоне — не влияет на торговлю пока
// config.strategy.copyTrade.enabled = false.

import fs from 'fs/promises';
import path from 'path';
import { logger } from '../utils/logger';
import { logEvent } from '../utils/event-logger';
import { config } from '../config';

const TRACKER_FILE = path.join(process.cwd(), 'data', 'wallet-tracker.json');

interface WalletTrade {
  mint: string;
  buySolLamports: number;
  buyTimestamp: number;
  sold: boolean;
}

interface WalletStats {
  address: string;
  trades: WalletTrade[];
  completedTrades: number;
  wins: number;
  lastSeen: number;
  isCopyEligible: boolean;       // tier 1 (conservative)
  isCopyEligibleTier2: boolean;  // tier 2 (aggressive, half entry)
  recentLosses: number;          // consecutive recent losses (для state tracking)
  avgHoldMs: number;             // average holding time in ms (flipper detection)
}

export class WalletTracker {
  private wallets: Map<string, WalletStats> = new Map();
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private readonly MAX_WALLETS: number;
  private readonly MAX_TRADES_PER_WALLET = 20;
  private readonly MIN_COMPLETED: number;
  private readonly MIN_WIN_RATE: number;
  private readonly TIER2_MIN_COMPLETED: number;
  private readonly TIER2_MIN_WIN_RATE: number;
  private readonly SAVE_INTERVAL: number;
  private readonly MIN_COPY_SOL: number;

  constructor() {
    const wt = config.walletTracker ?? {} as any;
    this.MAX_WALLETS = wt.maxTrackedWallets ?? 2000;
    this.MIN_COMPLETED = wt.minCompletedTrades ?? 15;
    this.MIN_WIN_RATE = wt.minWinRate ?? 0.60;
    this.TIER2_MIN_COMPLETED = wt.tier2MinCompletedTrades ?? 8;
    this.TIER2_MIN_WIN_RATE = wt.tier2MinWinRate ?? 0.50;
    this.SAVE_INTERVAL = wt.saveIntervalMs ?? 5 * 60 * 1000;
    this.MIN_COPY_SOL = wt.minCopyBuySolLamports ?? 100_000_000;

    // Load on boot so the Web UI Copy-Trade page shows persisted wallets even
    // when the bot isn't running. Fire-and-forget — file read is fast.
    this.load().catch(e => logger.error('WalletTracker load on boot failed:', e));
  }

  async start(): Promise<void> {
    // load() already ran from the constructor. If somehow it hasn't completed
    // by now (very unlikely on disk-backed JSON), the save timer below won't
    // overwrite anything because dirty stays false until recordBuy/recordSell.
    this.saveTimer = setInterval(() => this.save(), this.SAVE_INTERVAL);
    const eligible = [...this.wallets.values()].filter(w => w.isCopyEligible).length;
    logger.info(`WalletTracker started: ${this.wallets.size} wallets, ${eligible} copy-eligible`);
  }

  async stop(): Promise<void> {
    if (this.saveTimer) { clearInterval(this.saveTimer); this.saveTimer = null; }
    await this.save();
    logger.info(`WalletTracker stopped: ${this.wallets.size} wallets saved`);
  }

  /** Записать покупку кошелька */
  recordBuy(wallet: string, mint: string, solLamports: number): void {
    if (solLamports < 30_000_000) return; // < 0.03 SOL — dust/bot, игнорируем
    let stats = this.wallets.get(wallet);
    if (!stats) {
      if (this.wallets.size >= this.MAX_WALLETS) this.evictOldest();
      stats = {
        address: wallet, trades: [], completedTrades: 0,
        wins: 0, lastSeen: Date.now(), isCopyEligible: false,
        isCopyEligibleTier2: false, recentLosses: 0, avgHoldMs: 0,
      };
      this.wallets.set(wallet, stats);
    }
    // Не дублировать открытую позицию для того же mint
    if (stats.trades.some(t => t.mint === mint && !t.sold)) return;
    // Ограничить количество trades в памяти
    if (stats.trades.length >= this.MAX_TRADES_PER_WALLET) {
      const idx = stats.trades.findIndex(t => t.sold);
      if (idx >= 0) stats.trades.splice(idx, 1); else return;
    }
    stats.trades.push({ mint, buySolLamports: solLamports, buyTimestamp: Date.now(), sold: false });
    stats.lastSeen = Date.now();
    this.dirty = true;
  }

  /** Записать продажу кошелька и обновить win/loss статистику */
  recordSell(wallet: string, mint: string, sellSolLamports: number = 0): void {
    const stats = this.wallets.get(wallet);
    if (!stats) return;
    const trade = stats.trades.find(t => t.mint === mint && !t.sold);
    if (!trade) return;

    trade.sold = true;
    stats.completedTrades++;

    // Fix 5b: Track average hold time for flipper detection
    const holdTime = Date.now() - trade.buyTimestamp;
    stats.avgHoldMs = stats.completedTrades > 1
      ? (stats.avgHoldMs * (stats.completedTrades - 1) + holdTime) / stats.completedTrades
      : holdTime;

    // ── PnL-based win detection (HISTORY_DEV_SNIPER) ─────────────────────────
    let isWin = false;
    if (sellSolLamports > 0 && trade.buySolLamports > 0) {
      isWin = sellSolLamports > trade.buySolLamports * 0.98;
    } else {
      isWin = false;
    }

    if (isWin) {
      stats.wins++;
      stats.recentLosses = 0;
    } else {
      stats.recentLosses++;
    }
    stats.lastSeen = Date.now();

    // Пересчитать eligible статус (2-tier)
    const wasEligible = stats.isCopyEligible;
    const wasTier2 = stats.isCopyEligibleTier2;
    const winRate = stats.completedTrades > 0 ? stats.wins / stats.completedTrades : 0;

    // Tier 1 (conservative): high WR + long history
    stats.isCopyEligible = stats.completedTrades >= this.MIN_COMPLETED && winRate >= this.MIN_WIN_RATE;
    // Tier 2 (aggressive): lower thresholds, half entry
    stats.isCopyEligibleTier2 = !stats.isCopyEligible &&
      stats.completedTrades >= this.TIER2_MIN_COMPLETED && winRate >= this.TIER2_MIN_WIN_RATE;

    if (!wasEligible && stats.isCopyEligible) {
      logger.info(`🎯 COPY-ELIGIBLE T1: ${wallet.slice(0, 8)}... WR=${(winRate * 100).toFixed(0)}% trades=${stats.completedTrades}`);
      logEvent('WALLET_ELIGIBLE', { wallet: wallet.slice(0, 8), tier: 1, winRate: +(winRate.toFixed(2)), trades: stats.completedTrades });
    } else if (!wasTier2 && stats.isCopyEligibleTier2) {
      logger.info(`🎯 COPY-ELIGIBLE T2: ${wallet.slice(0, 8)}... WR=${(winRate * 100).toFixed(0)}% trades=${stats.completedTrades}`);
      logEvent('WALLET_ELIGIBLE', { wallet: wallet.slice(0, 8), tier: 2, winRate: +(winRate.toFixed(2)), trades: stats.completedTrades });
    }
    this.dirty = true;
  }

  /** Проверить, является ли покупка copy-trade сигналом.
   *  Returns: { signal: true, tier: 1|2 } или { signal: false }
   *  Tier 2 wallets с 3+ consecutive losses = skip (loss streak filter).
   */
  isCopySignal(wallet: string, solLamports: number): { signal: boolean; tier?: 1 | 2 } {
    const stats = this.wallets.get(wallet);
    if (!stats) return { signal: false };
    if (solLamports < this.MIN_COPY_SOL) return { signal: false };

    // Fix 5b: Flipper detection — if average hold < 15 seconds with enough data → skip
    if (stats.completedTrades >= 5 && stats.avgHoldMs < 15_000) {
      logger.debug(`[tracker] Flipper detected: ${wallet.slice(0,8)} avgHold=${(stats.avgHoldMs/1000).toFixed(1)}s`);
      return { signal: false };
    }

    if (stats.isCopyEligible) {
      // Tier 1: skip only if 5+ consecutive losses (severe drawdown)
      if (stats.recentLosses >= 5) return { signal: false };
      return { signal: true, tier: 1 };
    }
    if (stats.isCopyEligibleTier2) {
      // Tier 2: skip if 3+ consecutive losses
      if (stats.recentLosses >= 3) return { signal: false };
      return { signal: true, tier: 2 };
    }
    return { signal: false };
  }

  /** Очистка старых данных (вызывается из cleanSeenMints раз в час) */
  cleanup(): void {
    const now = Date.now();
    const INACTIVE_TTL = 24 * 60 * 60 * 1000;          // 24ч для обычных
    const ELIGIBLE_INACTIVE_TTL = 3 * 24 * 60 * 60 * 1000; // 3 дня для eligible
    for (const [addr, stats] of this.wallets) {
      // Удалить незавершённые trades старше 10 минут
      stats.trades = stats.trades.filter(t => t.sold || now - t.buyTimestamp < 10 * 60 * 1000);
      // Удалить неактивные кошельки (eligible тоже, но с бОльшим TTL)
      const ttl = (stats.isCopyEligible || stats.isCopyEligibleTier2) ? ELIGIBLE_INACTIVE_TTL : INACTIVE_TTL;
      if (now - stats.lastSeen > ttl) {
        if (stats.isCopyEligible) {
          logger.info(`🗑️ Eligible wallet ${addr.slice(0,8)} inactive for 7d — removing`);
        }
        this.wallets.delete(addr);
      }
    }
  }

  private evictOldest(): void {
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [addr, stats] of this.wallets) {
      if (stats.isCopyEligible || stats.isCopyEligibleTier2) continue; // не вытесняем eligible
      if (stats.lastSeen < oldestTime) { oldestTime = stats.lastSeen; oldest = addr; }
    }
    if (oldest) this.wallets.delete(oldest);
  }

  // ── Public management API for Web UI ────────────────────────────────────────

  /** Snapshot of all tracked wallets for display. */
  getAll(): Array<{
    address: string;
    completedTrades: number;
    wins: number;
    winRate: number;
    tier: 0 | 1 | 2;
    recentLosses: number;
    lastSeen: number;
    openTrades: number;
    avgHoldMs: number;
  }> {
    return [...this.wallets.values()].map(s => ({
      address: s.address,
      completedTrades: s.completedTrades,
      wins: s.wins,
      winRate: s.completedTrades > 0 ? s.wins / s.completedTrades : 0,
      tier: s.isCopyEligible ? 1 : s.isCopyEligibleTier2 ? 2 : 0,
      recentLosses: s.recentLosses,
      lastSeen: s.lastSeen,
      openTrades: s.trades.filter(t => !t.sold).length,
      avgHoldMs: s.avgHoldMs,
    }));
  }

  /** Manually insert a wallet (e.g. a known good trader from Twitter). */
  addManual(address: string): boolean {
    if (this.wallets.has(address)) return false;
    this.wallets.set(address, {
      address,
      trades: [],
      completedTrades: 0,
      wins: 0,
      lastSeen: Date.now(),
      isCopyEligible: false,
      isCopyEligibleTier2: false,
      recentLosses: 0,
      avgHoldMs: 0,
    });
    this.dirty = true;
    logger.info(`[tracker] manually added wallet ${address.slice(0, 8)}`);
    return true;
  }

  /** Remove a wallet from tracking (also clears eligibility). */
  remove(address: string): boolean {
    const removed = this.wallets.delete(address);
    if (removed) {
      this.dirty = true;
      logger.info(`[tracker] removed wallet ${address.slice(0, 8)}`);
    }
    return removed;
  }

  /**
   * Manually force a wallet into a specific copy-trade tier (0 = none).
   * Note: the next recordSell() still re-computes eligibility from WR, so
   * a force-promoted wallet with poor stats will revert on its next sell.
   * Treat this as a hint, not a lock.
   */
  setTier(address: string, tier: 0 | 1 | 2): boolean {
    const stats = this.wallets.get(address);
    if (!stats) return false;
    stats.isCopyEligible     = tier === 1;
    stats.isCopyEligibleTier2 = tier === 2;
    stats.lastSeen = Date.now();
    this.dirty = true;
    logger.info(`[tracker] manual tier ${tier} → ${address.slice(0, 8)}`);
    return true;
  }

  private async save(): Promise<void> {
    if (!this.dirty) return;
    try {
      // Сохраняем только кошельки с >= 2 trades или eligible
      const data = [...this.wallets.values()]
        .filter(s => s.completedTrades >= 2 || s.isCopyEligible || s.isCopyEligibleTier2)
        .map(s => ({
          address: s.address,
          completedTrades: s.completedTrades,
          wins: s.wins,
          lastSeen: s.lastSeen,
          isCopyEligible: s.isCopyEligible,
          isCopyEligibleTier2: s.isCopyEligibleTier2,
          recentLosses: s.recentLosses,
          avgHoldMs: s.avgHoldMs,
        }));
      await fs.mkdir(path.dirname(TRACKER_FILE), { recursive: true });
      await fs.writeFile(TRACKER_FILE, JSON.stringify(data, null, 2), 'utf8');
      this.dirty = false;
    } catch (err) {
      logger.error('WalletTracker save error:', err);
    }
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(TRACKER_FILE, 'utf8');
      for (const item of JSON.parse(raw)) {
        this.wallets.set(item.address, {
          address: item.address,
          trades: [],
          completedTrades: item.completedTrades ?? 0,
          wins: item.wins ?? 0,
          lastSeen: item.lastSeen ?? 0,
          isCopyEligible: item.isCopyEligible ?? false,
          isCopyEligibleTier2: item.isCopyEligibleTier2 ?? false,
          recentLosses: item.recentLosses ?? 0,
          avgHoldMs: item.avgHoldMs ?? 0,
        });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('WalletTracker load error:', err);
      }
    }
  }
}
