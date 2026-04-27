// src/core/trend-tracker.ts
//
// TrendTracker — агрегирует поток geyser buy/sell событий и social-сигналов
// по каждому mint'у, вычисляет метрики тренда и эмитит события:
//   'trend:confirmed'     — тренд подтверждён, можно входить
//   'trend:strengthening'  — тренд усиливается (для add-on buy)
//   'trend:weakening'      — тренд слабеет (для exit signal)
//
// Используется Sniper'ом для Режимов B (trend-confirmed entry) и C (social discovery).

import { EventEmitter } from 'events';
import { config } from '../config';
import { logger } from '../utils/logger';
import { logEvent } from '../utils/event-logger';

export interface TrendMetrics {
  mint: string;
  buyCount: number;
  sellCount: number;
  buyVolumeSol: number;
  sellVolumeSol: number;
  uniqueBuyers: number;
  weightedBuyerScore: number; // volume-weighted buyer quality score
  buySellRatio: number;
  priceDirection: number;   // >0 = рост, <0 = падение
  netVolumeSol: number;     // buyVolumeSol - sellVolumeSol
  ageMs: number;
  protocol: string;
  socialSignals: number;
  hasSocialMint: boolean;   // social signal с mint'ом (не только ticker)
  buyAcceleration: number;  // #15: buy velocity acceleration (ratio of recent vs earlier rate)
}

interface BuyEvent {
  buyer: string;
  solAmount: number;
  timestamp: number;
}

interface SellEvent {
  seller: string;
  solAmount: number;
  timestamp: number;
}

interface PricePoint {
  price: number;
  timestamp: number;
}

interface MintTracker {
  mint: string;
  protocol: string;
  createdAt: number;
  buys: BuyEvent[];
  sells: SellEvent[];
  prices: PricePoint[];
  uniqueBuyers: Set<string>;
  socialSignalCount: number;
  hasSocialMint: boolean;
  confirmed: boolean;
  strengthened: boolean;
  timeoutTimer: NodeJS.Timeout | null;
}

export class TrendTracker extends EventEmitter {
  private trackers: Map<string, MintTracker> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  start(): void {
    this.cleanupInterval = setInterval(
      () => this.cleanup(),
      config.trend.inactiveCleanupMs,
    );
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    for (const [, tracker] of this.trackers) {
      if (tracker.timeoutTimer) clearTimeout(tracker.timeoutTimer);
    }
    this.trackers.clear();
    this.removeAllListeners();
  }

  track(mint: string, protocol: string): void {
    if (this.trackers.has(mint)) return;

    const timeoutMs = this.getTimeoutMs(protocol);

    const tracker: MintTracker = {
      mint,
      protocol,
      createdAt: Date.now(),
      buys: [],
      sells: [],
      prices: [],
      uniqueBuyers: new Set(),
      socialSignalCount: 0,
      hasSocialMint: false,
      confirmed: false,
      strengthened: false,
      timeoutTimer: null,
    };

    tracker.timeoutTimer = setTimeout(() => {
      if (!tracker.confirmed) {
        logger.debug(`[trend] ${mint.slice(0, 8)} timeout (${timeoutMs}ms), no trend confirmed`);
        logEvent('TREND_TIMEOUT', { mint, protocol, ageMs: timeoutMs });
        this.trackers.delete(mint);
      }
    }, timeoutMs);

    this.trackers.set(mint, tracker);
    logger.debug(`[trend] tracking ${mint.slice(0, 8)} (${protocol})`);
  }

  isTracking(mint: string): boolean {
    return this.trackers.has(mint);
  }

  recordBuy(mint: string, buyer: string, solAmount: number): void {
    const tracker = this.trackers.get(mint);
    if (!tracker) return;

    tracker.buys.push({ buyer, solAmount, timestamp: Date.now() });
    tracker.uniqueBuyers.add(buyer);

    this.trimWindow(tracker);
    this.evaluate(tracker);
  }

  recordSell(mint: string, seller: string, solAmount: number): void {
    const tracker = this.trackers.get(mint);
    if (!tracker) return;

    tracker.sells.push({ seller, solAmount, timestamp: Date.now() });

    this.trimWindow(tracker);

    if (tracker.confirmed) {
      this.evaluateWeakening(tracker);
    }
  }

  recordPrice(mint: string, price: number): void {
    const tracker = this.trackers.get(mint);
    if (!tracker) return;

    tracker.prices.push({ price, timestamp: Date.now() });
    if (tracker.prices.length > 100) tracker.prices.shift();
  }

  recordSocialSignal(mint: string, hasMint: boolean): void {
    const tracker = this.trackers.get(mint);
    if (!tracker) return;

    tracker.socialSignalCount++;
    if (hasMint) tracker.hasSocialMint = true;

    this.evaluate(tracker);
  }

  /** Удалить mint из трекинга (после покупки или по другой причине). */
  remove(mint: string): void {
    const tracker = this.trackers.get(mint);
    if (tracker) {
      if (tracker.timeoutTimer) clearTimeout(tracker.timeoutTimer);
      this.trackers.delete(mint);
    }
  }

  getMetrics(mint: string): TrendMetrics | null {
    const tracker = this.trackers.get(mint);
    if (!tracker) return null;
    return this.computeMetrics(tracker);
  }

  get trackedCount(): number {
    return this.trackers.size;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private getProtocolThresholds(protocol: string): { minVolume: number; minBuyers: number } {
    const cfg = config.trend;
    if (protocol === 'pump.fun' || protocol === 'mayhem') {
      return { minVolume: cfg.pumpFunMinVolumeSol ?? cfg.minBuyVolumeSol, minBuyers: cfg.minUniqueBuyers };
    }
    if (protocol === 'pumpswap') {
      return { minVolume: cfg.pumpSwapMinVolumeSol ?? cfg.minBuyVolumeSol, minBuyers: cfg.minUniqueBuyers + 1 };
    }
    if (protocol === 'raydium-cpmm' || protocol === 'raydium-ammv4') {
      return { minVolume: cfg.raydiumAmmMinVolumeSol ?? cfg.minBuyVolumeSol, minBuyers: cfg.minUniqueBuyers + 2 };
    }
    if (protocol === 'raydium-launch') {
      return { minVolume: cfg.raydiumLaunchMinVolumeSol ?? cfg.minBuyVolumeSol, minBuyers: cfg.minUniqueBuyers };
    }
    return { minVolume: cfg.minBuyVolumeSol, minBuyers: cfg.minUniqueBuyers };
  }

  private getWindowMs(protocol: string): number {
    if (protocol === 'pump.fun' || protocol === 'mayhem') return config.trend.pumpFunWindowMs;
    if (protocol === 'pumpswap') return config.trend.pumpSwapWindowMs;
    return config.trend.raydiumWindowMs;
  }

  private getTimeoutMs(protocol: string): number {
    if (protocol === 'pump.fun' || protocol === 'mayhem') return config.trend.pumpFunTimeoutMs;
    if (protocol === 'pumpswap') return config.trend.pumpSwapTimeoutMs;
    return config.trend.raydiumTimeoutMs;
  }

  private trimWindow(tracker: MintTracker): void {
    const windowMs = this.getWindowMs(tracker.protocol);
    const cutoff = Date.now() - windowMs;

    tracker.buys = tracker.buys.filter(b => b.timestamp >= cutoff);
    tracker.sells = tracker.sells.filter(s => s.timestamp >= cutoff);

    // uniqueBuyers пересчитываем из актуального окна
    tracker.uniqueBuyers.clear();
    for (const b of tracker.buys) tracker.uniqueBuyers.add(b.buyer);
  }

  /** Volume-weighted buyer weight: bigger buys = higher conviction signal. */
  private getBuyerWeight(solAmount: number): number {
    if (solAmount >= 0.5) return 2.0;
    if (solAmount >= 0.1) return 1.0;
    if (solAmount >= 0.05) return 0.5;
    return 0.2;
  }

  /**
   * Compute weighted buyer score from current window buys.
   * Each unique buyer gets the weight of their LARGEST buy in the window.
   */
  private computeWeightedBuyerScore(buys: BuyEvent[]): number {
    const bestByBuyer = new Map<string, number>();
    for (const b of buys) {
      const prev = bestByBuyer.get(b.buyer) ?? 0;
      if (b.solAmount > prev) bestByBuyer.set(b.buyer, b.solAmount);
    }
    let score = 0;
    for (const solAmount of bestByBuyer.values()) {
      score += this.getBuyerWeight(solAmount);
    }
    return score;
  }

  private computeMetrics(tracker: MintTracker): TrendMetrics {
    const buyCount = tracker.buys.length;
    const sellCount = tracker.sells.length;
    const buyVolumeSol = tracker.buys.reduce((s, b) => s + b.solAmount, 0);
    const sellVolumeSol = tracker.sells.reduce((s, b) => s + b.solAmount, 0);
    const uniqueBuyers = tracker.uniqueBuyers.size;
    const weightedBuyerScore = this.computeWeightedBuyerScore(tracker.buys);
    const buySellRatio = sellVolumeSol > 0 ? buyVolumeSol / sellVolumeSol : buyVolumeSol > 0 ? buyVolumeSol * 10 : 0;

    let priceDirection = 0;
    if (tracker.prices.length >= 2) {
      const first = tracker.prices[0].price;
      const last = tracker.prices[tracker.prices.length - 1].price;
      priceDirection = first > 0 ? (last - first) / first : 0;
    }

    const buyAcceleration = this.computeBuyAcceleration(tracker.buys);

    return {
      mint: tracker.mint,
      buyCount,
      sellCount,
      buyVolumeSol,
      sellVolumeSol,
      uniqueBuyers,
      weightedBuyerScore,
      buySellRatio,
      priceDirection,
      netVolumeSol: buyVolumeSol - sellVolumeSol,
      ageMs: Date.now() - tracker.createdAt,
      protocol: tracker.protocol,
      socialSignals: tracker.socialSignalCount,
      hasSocialMint: tracker.hasSocialMint,
      buyAcceleration,
    };
  }

  private computeBuyAcceleration(buys: BuyEvent[]): number {
    if (buys.length < 4) return 1.0;
    const now = Date.now();
    const windowMs = (config.strategy as any).buyAcceleration?.windowMs ?? 10_000;
    const midpoint = now - windowMs / 2;

    const early = buys.filter(b => b.timestamp < midpoint && b.timestamp >= now - windowMs);
    const late = buys.filter(b => b.timestamp >= midpoint);

    if (early.length === 0) return late.length > 0 ? 3.0 : 1.0;
    const halfWindow = windowMs / 2 / 1000;
    const earlyRate = early.length / halfWindow;
    const lateRate = late.length / halfWindow;
    return earlyRate > 0 ? lateRate / earlyRate : lateRate > 0 ? 3.0 : 1.0;
  }

  private evaluate(tracker: MintTracker): void {
    if (tracker.confirmed) {
      this.evaluateStrengthening(tracker);
      return;
    }

    const cfg = config.trend;
    const m = this.computeMetrics(tracker);

    const { minVolume, minBuyers } = this.getProtocolThresholds(tracker.protocol);
    const ratioOk = m.buySellRatio >= cfg.minBuySellRatio;
    const weightedScoreOk = m.weightedBuyerScore >= 3.0;

    const socialBoost = tracker.hasSocialMint;
    const buyersThreshold = socialBoost ? Math.max(2, minBuyers - 1) : minBuyers;
    const volumeThreshold = socialBoost ? minVolume * 0.7 : minVolume;

    const netVolumeOk = m.netVolumeSol > 0;
    const accelerationOk = !cfg.buyAccelerationGate || m.buyAcceleration >= 1.2;
    const confirmed = (m.uniqueBuyers >= buyersThreshold) && weightedScoreOk && (m.buyVolumeSol >= volumeThreshold) && ratioOk && netVolumeOk && accelerationOk;

    if (confirmed) {
      tracker.confirmed = true;
      logger.info(
        `📈 TREND CONFIRMED: ${tracker.mint.slice(0, 8)} ` +
        `buyers=${m.uniqueBuyers} wScore=${m.weightedBuyerScore.toFixed(1)} vol=${m.buyVolumeSol.toFixed(3)} ratio=${m.buySellRatio.toFixed(1)} ` +
        `social=${m.socialSignals} protocol=${m.protocol}`
      );
      logEvent('TREND_CONFIRMED', m);
      this.emit('trend:confirmed', tracker.mint, m);
    }
  }

  private evaluateStrengthening(tracker: MintTracker): void {
    if (tracker.strengthened) return;

    const cfg = config.trend;
    const m = this.computeMetrics(tracker);

    if (m.uniqueBuyers >= cfg.strengthenBuyerThreshold && m.buyVolumeSol >= cfg.strengthenVolumeSol) {
      tracker.strengthened = true;
      logger.info(
        `📈📈 TREND STRENGTHENING: ${tracker.mint.slice(0, 8)} ` +
        `buyers=${m.uniqueBuyers} vol=${m.buyVolumeSol.toFixed(3)}`
      );
      logEvent('TREND_STRENGTHENING', m);
      this.emit('trend:strengthening', tracker.mint, m);
    }
  }

  private evaluateWeakening(tracker: MintTracker): void {
    const cfg = config.trend;
    const windowMs = cfg.weakenWindowMs;
    const cutoff = Date.now() - windowMs;

    const recentBuys = tracker.buys.filter(b => b.timestamp >= cutoff).length;
    const recentSells = tracker.sells.filter(s => s.timestamp >= cutoff).length;

    if (recentSells > 0 && recentBuys === 0) {
      const m = this.computeMetrics(tracker);
      logger.info(
        `📉 TREND WEAKENING: ${tracker.mint.slice(0, 8)} ` +
        `recentBuys=0 recentSells=${recentSells} in ${windowMs}ms`
      );
      logEvent('TREND_WEAKENING', { mint: tracker.mint, recentBuys, recentSells, windowMs });
      this.emit('trend:weakening', tracker.mint, m);
    } else if (recentSells > 0 && recentBuys > 0) {
      const ratio = recentSells / recentBuys;
      if (ratio >= cfg.weakenSellRatio) {
        const m = this.computeMetrics(tracker);
        logger.info(
          `📉 TREND WEAKENING: ${tracker.mint.slice(0, 8)} ` +
          `sell/buy ratio=${ratio.toFixed(1)} >= ${cfg.weakenSellRatio} in ${windowMs}ms`
        );
        logEvent('TREND_WEAKENING', { mint: tracker.mint, recentBuys, recentSells, ratio, windowMs });
        this.emit('trend:weakening', tracker.mint, m);
      }
    }
  }

  private cleanup(): void {
    const now = Date.now();
    let removed = 0;
    for (const [mint, tracker] of this.trackers) {
      if (tracker.confirmed) continue;
      const age = now - tracker.createdAt;
      if (age > config.trend.inactiveCleanupMs) {
        if (tracker.timeoutTimer) clearTimeout(tracker.timeoutTimer);
        this.trackers.delete(mint);
        removed++;
      }
    }
    if (removed > 0) {
      logger.debug(`[trend] cleanup: removed ${removed} inactive trackers, remaining=${this.trackers.size}`);
    }
  }
}
