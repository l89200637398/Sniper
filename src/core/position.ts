// src/core/position.ts
import { PublicKey } from '@solana/web3.js';
import { config } from '../config';
import { PriceTick } from '../utils/trade-logger';
import { logger as globalLogger } from '../utils/logger';
import { logEvent } from '../utils/event-logger';

export interface PoolInfo {
  programId: string;
  quoteMint: string;
}

export interface TakeProfitLevel {
  levelPercent: number;
  portion: number;
}

export interface SellDecision {
  action: 'partial' | 'full' | 'none';
  reason?:
    | 'stop_loss'
    | 'velocity_drop'
    | 'time_stop'
    | 'stagnation'
    | 'tp_partial'
    | 'hard_stop'
    | 'trailing_stop'
    | 'slow_drawdown'
    | 'break_even'
    | 'manual'
    | 'rpc_error'
    | 'creator_sell'
    | 'tp_all'
    | 'early_exit'
    | 'dead_volume'
    | 'whale_sell'
    | 'reserve_imbalance';
  portion?: number;
  tpLevelPercent?: number;
  urgent?: boolean;
}

const MAX_PRICE_HISTORY = 2000;

export class Position {
  public readonly mint: PublicKey;
  public protocol: 'pump.fun' | 'pumpswap' | 'mayhem' | 'raydium-launch' | 'raydium-cpmm' | 'raydium-ammv4';
  public entryPrice: number;
  public entryAmountSol: number;
  public originalEntryAmountSol: number;
  public amount: number;
  public maxPrice: number;
  public currentPrice: number;
  public pool: PoolInfo;
  public tokenDecimals: number;

  public lastPrice: number;
  public lastTimestamp: number;
  public drawdownStart: number | null;
  public trailingActivated: boolean;
  public runnerTailActivated: boolean = false;

  private takeProfitLevels: TakeProfitLevel[];
  private takenLevels: Set<number>;
  public pendingTpLevels: Set<number>; // race condition guard: levels currently being sold
  public takenLevelsCount: number;

  public readonly openedAt: number;
  public priceHistory: PriceTick[];
  public partialSolReceived: number;
  public partialSellsCount: number;

  private levelsReached: Set<number>;

  public feeRecipientUsed?: string;
  public creator?: string;
  public cashbackEnabled: boolean = false;
  public tokenScore: number = 0;
  public updateErrors: number = 0;

  public lastBuyActivityTs: number;
  public isScalp: boolean = false;
  public whaleSnapshot: Map<string, number> = new Map();
  public whaleLastCheckTs: number = 0;

  // Price tick throttling: log to events only on meaningful moves
  private lastLoggedTickPnl: number = 0;
  private lastLoggedTickTs: number = 0;

  // Ring buffer state for priceHistory (O(1) push instead of O(n) shift)
  private priceHistoryIdx: number = 0;
  private priceHistoryFull: boolean = false;

  constructor(
    mint: PublicKey,
    entryPrice: number,
    amount: number,
    pool: PoolInfo,
    decimals: number,
    options: {
      entryAmountSol?: number;
      protocol?: 'pump.fun' | 'pumpswap' | 'mayhem' | 'raydium-launch' | 'raydium-cpmm' | 'raydium-ammv4';
      feeRecipientUsed?: string;
      creator?: string;
      openedAt?: number;
      cashbackEnabled?: boolean;
      isScalp?: boolean;
    } = {}
  ) {
    this.mint = mint;
    this.protocol = options.protocol ?? 'pump.fun';
    this.entryPrice = entryPrice;
    this.entryAmountSol = options.entryAmountSol ?? config.strategy.entryAmountSol;
    this.originalEntryAmountSol = this.entryAmountSol;
    this.amount = amount;
    this.maxPrice = entryPrice;
    this.currentPrice = entryPrice;
    this.pool = pool;
    this.tokenDecimals = decimals;

    this.lastPrice = entryPrice;
    this.lastTimestamp = Date.now();
    this.drawdownStart = null;
    this.trailingActivated = false;
    this.isScalp = options.isScalp ?? false;

    const initExit = this.isScalp                         ? config.strategy.scalping.exit
                   : this.protocol === 'pumpswap'        ? config.strategy.pumpSwap.exit
                   : this.protocol === 'mayhem'          ? config.strategy.mayhem.exit
                   : this.protocol === 'raydium-launch'  ? config.strategy.raydiumLaunch.exit
                   : this.protocol === 'raydium-cpmm'    ? config.strategy.raydiumCpmm.exit
                   : this.protocol === 'raydium-ammv4'   ? config.strategy.raydiumAmmV4.exit
                   : config.strategy.pumpFun.exit;
    this.takeProfitLevels = initExit.takeProfit || [];
    this.takenLevels = new Set();
    this.pendingTpLevels = new Set();
    this.takenLevelsCount = 0;
    this.levelsReached = new Set();

    this.openedAt = options.openedAt ?? Date.now();
    this.priceHistory = new Array(MAX_PRICE_HISTORY);
    this.partialSolReceived = 0;
    this.partialSellsCount = 0;

    this.feeRecipientUsed = options.feeRecipientUsed;
    this.creator = options.creator;
    this.cashbackEnabled = options.cashbackEnabled ?? false;
    this.lastBuyActivityTs = this.openedAt;
  }

  updatePrice(solReserves: number, tokenReserves: number): void {
    if (solReserves === 0 || tokenReserves === 0) return;

    const newPrice = solReserves / 1e9 / (tokenReserves / Math.pow(10, this.tokenDecimals));
    const now = Date.now();

    if (newPrice > this.maxPrice) {
      this.maxPrice = newPrice;
      for (const level of this.takeProfitLevels) {
        if (!this.levelsReached.has(level.levelPercent) && this.maxPrice >= this.entryPrice * (1 + level.levelPercent / 100)) {
          this.levelsReached.add(level.levelPercent);
        }
      }
    }

    if (!this.trailingActivated &&
        newPrice >= this.entryPrice * (1 + this.getExitConfig().trailingActivationPercent / 100)) {
      this.trailingActivated = true;
    }

    // Runner tail: после +runnerActivationPercent позиция переходит в режим
    // монстр-ранера (расширенный trailing + hard stop, без break-even).
    const exitCfgForRunner = this.getExitConfig() as any;
    const runnerActPct = exitCfgForRunner.runnerActivationPercent;
    if (!this.runnerTailActivated && typeof runnerActPct === 'number' &&
        newPrice >= this.entryPrice * (1 + runnerActPct / 100)) {
      this.runnerTailActivated = true;
    }

    if (newPrice < this.maxPrice) {
      if (this.drawdownStart === null) this.drawdownStart = now;
    } else {
      this.drawdownStart = null;
    }

    this.lastPrice = this.currentPrice;
    this.lastTimestamp = now;
    this.currentPrice = newPrice;

    const tick: PriceTick = {
      t: now - this.openedAt,
      p: newPrice,
      pnl: ((newPrice - this.entryPrice) / this.entryPrice) * 100,
      solReserve: solReserves,
      tokenReserve: tokenReserves,
    };
    // Ring buffer write: O(1) — overwrites oldest slot when full
    this.priceHistory[this.priceHistoryIdx] = tick;
    this.priceHistoryIdx = (this.priceHistoryIdx + 1) % MAX_PRICE_HISTORY;
    if (!this.priceHistoryFull && this.priceHistoryIdx === 0) this.priceHistoryFull = true;

    // Price change event (throttled): significant move (>=3%) OR stale (>30s since last log)
    // Event goes to events table for live correlation with other signals.
    const pnlPctNow = tick.pnl;
    const pnlDelta = Math.abs(pnlPctNow - this.lastLoggedTickPnl);
    const tsDelta = now - this.lastLoggedTickTs;
    if (pnlDelta >= 3 || (tsDelta >= 30_000 && pnlDelta >= 0.5)) {
      this.lastLoggedTickPnl = pnlPctNow;
      this.lastLoggedTickTs = now;
      try {
        logEvent('PRICE_TICK', {
          mint: this.mint.toBase58(),
          pnlPct: +pnlPctNow.toFixed(2),
          price: newPrice,
          tMs: tick.t,
          solReserve: solReserves,
          tokenReserve: tokenReserves,
        }, { severity: 'debug', mint: this.mint.toBase58(), protocol: this.protocol } as any);
      } catch { /* swallow */ }
    }
  }

  shouldSell(logger: any = globalLogger): SellDecision {
    const now = Date.now();
    const exitRaw = this.getExitConfig() as any;
    // Runner tail overrides: расширенные пороги для монстр-ранеров.
    const effHardStopPercent = this.runnerTailActivated && typeof exitRaw.runnerHardStopPercent === 'number'
      ? exitRaw.runnerHardStopPercent : exitRaw.hardStopPercent;
    const effTrailingDrawdownPercent = this.runnerTailActivated && typeof exitRaw.runnerTrailDrawdownPercent === 'number'
      ? exitRaw.runnerTrailDrawdownPercent : exitRaw.trailingDrawdownPercent;
    const exit = exitRaw;
    const age = now - this.openedAt;
    const mintStr = this.mint.toBase58().slice(0,8);

    // 1. Entry stop-loss (Loss-min #3: break-even after TP1)
    // Break-even activates only after a TP level is CONFIRMED taken (not pending).
    // pendingTpLevels excluded: if TP tx fails, we must not drop SL to 0%.
    const effStopLossPercent = (this.takenLevelsCount > 0 && !this.runnerTailActivated)
      ? 0
      : exit.entryStopLossPercent;
    if (this.currentPrice <= this.entryPrice * (1 - effStopLossPercent / 100)) {
      const slReason = effStopLossPercent === 0 ? 'break_even_after_tp' : 'stop_loss';
      logger.debug(`[${mintStr}] ${slReason}: price=${this.currentPrice}, entry=${this.entryPrice}, limit=${this.entryPrice * (1 - effStopLossPercent / 100)}, takenLevels=${this.takenLevelsCount}`);
      logEvent('SHOULD_SELL_TRIGGER', {
        mint: mintStr,
        reason: slReason,
        price: this.currentPrice,
        entry: this.entryPrice,
        maxPrice: this.maxPrice,
        pnlPercent: this.pnlPercent,
        trailingActivated: this.trailingActivated,
        takenLevelsCount: this.takenLevelsCount,
        protocol: this.protocol,
        age,
      });
      return { action: 'full', reason: 'stop_loss', urgent: true };
    }

    // 2. Hard stop (с runner override)
    const drawdown = this.maxPrice > 0 ? (this.maxPrice - this.currentPrice) / this.maxPrice : 0;
    if (drawdown >= effHardStopPercent / 100) {
      logger.debug(`[${mintStr}] hard_stop: drawdown=${drawdown}, max=${this.maxPrice}, current=${this.currentPrice}`);
      logEvent('SHOULD_SELL_TRIGGER', {
        mint: mintStr,
        reason: 'hard_stop',
        drawdown,
        maxPrice: this.maxPrice,
        currentPrice: this.currentPrice,
        pnlPercent: this.pnlPercent,
        trailingActivated: this.trailingActivated,
        protocol: this.protocol,
        age,
      });
      return { action: 'full', reason: 'hard_stop', urgent: false };
    }

    // 3. Velocity drop (wider threshold in runner mode — let runners breathe)
    const effVelocityDropPct = this.runnerTailActivated
      ? exit.velocityDropPercent * 1.5  // 50% wider in runner mode
      : exit.velocityDropPercent;
    const phCount = this.priceHistoryFull ? MAX_PRICE_HISTORY : this.priceHistoryIdx;
    if (phCount > 1) {
      const windowEdge = now - exit.velocityWindowMs;
      let refTick: PriceTick | undefined;
      // Scan newest → oldest in ring buffer order to find the oldest tick within window
      for (let i = 0; i < phCount; i++) {
        const idx = (this.priceHistoryIdx - 1 - i + MAX_PRICE_HISTORY) % MAX_PRICE_HISTORY;
        if (this.openedAt + this.priceHistory[idx].t <= windowEdge) {
          refTick = this.priceHistory[idx];
          break;
        }
      }
      if (refTick && refTick.p > 0) {
        const velocityChange = (this.currentPrice - refTick.p) / refTick.p;
        if (velocityChange <= -effVelocityDropPct / 100) {
          logger.debug(`[${mintStr}] velocity_drop: change=${velocityChange}, threshold=-${exit.velocityDropPercent/100}`);
          logEvent('SHOULD_SELL_TRIGGER', {
            mint: mintStr,
            reason: 'velocity_drop',
            velocityChange,
            thresholdPercent: exit.velocityDropPercent,
            windowMs: exit.velocityWindowMs,
            pnlPercent: this.pnlPercent,
            trailingActivated: this.trailingActivated,
            protocol: this.protocol,
            age,
          });
          return { action: 'full', reason: 'velocity_drop', urgent: true };
        }
      }
    }

    // 4. Time stop (до активации трейлинга)
    if (!this.trailingActivated && age >= exit.timeStopAfterMs) {
      const pnl = (this.currentPrice - this.entryPrice) / this.entryPrice;
      if (pnl <= exit.timeStopMinPnl) {
        logEvent('SHOULD_SELL_TRIGGER', {
          mint: mintStr,
          reason: 'time_stop',
          age,
          pnl,
          timeStopAfterMs: exit.timeStopAfterMs,
          timeStopMinPnl: exit.timeStopMinPnl,
          trailingActivated: this.trailingActivated,
          protocol: this.protocol,
        });
        return { action: 'full', reason: 'time_stop', urgent: false };
      }
      if (age >= exit.timeStopAfterMs * 2) {
        logEvent('SHOULD_SELL_TRIGGER', {
          mint: mintStr,
          reason: 'time_stop (double)',
          age,
          pnl,
          timeStopAfterMs: exit.timeStopAfterMs,
          trailingActivated: this.trailingActivated,
          protocol: this.protocol,
        });
        return { action: 'full', reason: 'time_stop', urgent: false };
      }
    }

    // 5. Take profit (BEFORE stagnation — TP must fire before flat-exit kills a winner)
    const isMicroPosition = this.entryAmountSol < 0.03;
    for (const level of this.takeProfitLevels) {
      if (this.levelsReached.has(level.levelPercent) && !this.takenLevels.has(level.levelPercent) && !this.pendingTpLevels.has(level.levelPercent)) {
        const microFullExit = isMicroPosition && this.takenLevelsCount >= 1;
        const effectiveAction = microFullExit ? 'full' as const : 'partial' as const;
        const effectivePortion = microFullExit ? 1.0 : level.portion;
        const effectiveReason = microFullExit ? 'tp_all' as const : 'tp_partial' as const;
        logEvent('SHOULD_SELL_TRIGGER', {
          mint: mintStr,
          reason: effectiveReason,
          levelPercent: level.levelPercent,
          portion: effectivePortion,
          pnlPercent: this.pnlPercent,
          trailingActivated: this.trailingActivated,
          protocol: this.protocol,
          age,
          isMicroPosition,
        });
        return {
          action: effectiveAction,
          reason: effectiveReason,
          portion: effectivePortion,
          tpLevelPercent: level.levelPercent,
          urgent: false,
        };
      }
    }

    // 6. Stagnation stop
    // PnL-aware: skip stagnation if position is in profit > 5% — let trailing handle the exit
    const stagnationPnlBypass = this.pnlPercent > 5;
    if (age >= exit.stagnationWindowMs && phCount === 0 && !stagnationPnlBypass) {
      logEvent('SHOULD_SELL_TRIGGER', {
        mint: mintStr,
        reason: 'stagnation',
        age,
        stagnationWindowMs: exit.stagnationWindowMs,
        trailingActivated: this.trailingActivated,
        protocol: this.protocol,
      });
      return { action: 'full', reason: 'stagnation', urgent: false };
    }
    if (age >= exit.stagnationWindowMs && phCount > 0 && !stagnationPnlBypass) {
      const windowEdgeMs = now - exit.stagnationWindowMs;
      let stagnRefTick: PriceTick | undefined;
      const oldestIdx = this.priceHistoryFull ? this.priceHistoryIdx : 0;
      for (let i = 0; i < phCount; i++) {
        const idx = (oldestIdx + i) % MAX_PRICE_HISTORY;
        const tick = this.priceHistory[idx];
        if (tick && this.openedAt + tick.t >= windowEdgeMs) {
          stagnRefTick = tick;
          break;
        }
      }
      if (stagnRefTick && stagnRefTick.p > 0) {
        const move = Math.abs((this.currentPrice - stagnRefTick.p) / stagnRefTick.p);
        if (move < exit.stagnationMinMove) {
          logEvent('SHOULD_SELL_TRIGGER', {
            mint: mintStr,
            reason: 'stagnation',
            age,
            stagnationWindowMs: exit.stagnationWindowMs,
            move,
            minMove: exit.stagnationMinMove,
            trailingActivated: this.trailingActivated,
            protocol: this.protocol,
          });
          return { action: 'full', reason: 'stagnation', urgent: false };
        }
      }
    }

    // 6b. Dead volume exit
    // PnL-aware: skip dead_volume if position is in profit > 8% — let trailing handle
    const dvCfg = (config.strategy as any).deadVolume;
    if (dvCfg?.enabled && this.takenLevelsCount === 0 && !this.trailingActivated
        && age >= (dvCfg.minAgeMs ?? 15_000) && this.pnlPercent > -exit.entryStopLossPercent
        && this.pnlPercent <= 8) {
      const silenceMs = now - this.lastBuyActivityTs;
      const scalpDvTimeout = this.isScalp ? (dvCfg.scalpTimeoutMs ?? 45_000) : undefined;
      const dvTimeout = scalpDvTimeout ?? dvCfg.protocolTimeouts?.[this.protocol] ?? dvCfg.timeoutMs ?? 60_000;
      if (silenceMs >= dvTimeout) {
        logger.debug(`[${mintStr}] dead_volume: no buy activity for ${(silenceMs / 1000).toFixed(0)}s (timeout=${dvTimeout / 1000}s, proto=${this.protocol})`);
        logEvent('SHOULD_SELL_TRIGGER', {
          mint: mintStr,
          reason: 'dead_volume',
          silenceMs,
          timeoutMs: dvTimeout,
          pnlPercent: this.pnlPercent,
          protocol: this.protocol,
          age,
        });
        return { action: 'full', reason: 'dead_volume', urgent: false };
      }
    }

    // 7. Break-even stop (только после трейлинга; отключён в runner tail режиме)
    if (this.trailingActivated && !this.runnerTailActivated) {
      const pnl = (this.currentPrice - this.entryPrice) / this.entryPrice;
      if (pnl <= exit.breakEvenAfterTrailingPercent / 100) {
        logEvent('SHOULD_SELL_TRIGGER', {
          mint: mintStr,
          reason: 'break_even',
          pnl,
          breakEvenAfterTrailingPercent: exit.breakEvenAfterTrailingPercent,
          trailingActivated: this.trailingActivated,
          protocol: this.protocol,
          age,
        });
        return { action: 'full', reason: 'break_even', urgent: false };
      }
    }

    // 8. Trailing / slow drawdown (только после трейлинга)
    if (this.trailingActivated) {
      if (this.drawdownStart !== null) {
        const dropDuration = now - this.drawdownStart;
        if (dropDuration <= exit.slowDrawdownMinDurationMs) {
          if (drawdown >= effTrailingDrawdownPercent / 100) {
            logEvent('SHOULD_SELL_TRIGGER', {
              mint: mintStr,
              reason: 'trailing_stop',
              drawdown,
              trailingDrawdownPercent: exit.trailingDrawdownPercent,
              dropDuration,
              trailingActivated: this.trailingActivated,
              protocol: this.protocol,
              age,
            });
            return { action: 'full', reason: 'trailing_stop', urgent: false };
          }
        } else {
          if (drawdown >= exit.slowDrawdownPercent / 100) {
            logEvent('SHOULD_SELL_TRIGGER', {
              mint: mintStr,
              reason: 'slow_drawdown',
              drawdown,
              slowDrawdownPercent: exit.slowDrawdownPercent,
              dropDuration,
              trailingActivated: this.trailingActivated,
              protocol: this.protocol,
              age,
            });
            return { action: 'full', reason: 'slow_drawdown', urgent: false };
          }
        }
      } else {
        if (drawdown >= exit.trailingDrawdownPercent / 100) {
          logEvent('SHOULD_SELL_TRIGGER', {
            mint: mintStr,
            reason: 'trailing_stop (no drawdown start)',
            drawdown,
            trailingDrawdownPercent: exit.trailingDrawdownPercent,
            trailingActivated: this.trailingActivated,
            protocol: this.protocol,
            age,
          });
          return { action: 'full', reason: 'trailing_stop', urgent: false };
        }
      }
    }

    return { action: 'none' };
  }

  private getExitConfig() {
    if (this.isScalp) return config.strategy.scalping.exit;
    switch (this.protocol) {
      case 'pump.fun':        return config.strategy.pumpFun.exit;
      case 'pumpswap':        return config.strategy.pumpSwap.exit;
      case 'mayhem':          return config.strategy.mayhem.exit;
      case 'raydium-launch':  return config.strategy.raydiumLaunch.exit;
      case 'raydium-cpmm':    return config.strategy.raydiumCpmm.exit;
      case 'raydium-ammv4':   return config.strategy.raydiumAmmV4.exit;
      default:                return config.strategy.exit;
    }
  }

  public setTakeProfitLevels(levels: TakeProfitLevel[]): void {
    this.takeProfitLevels = levels;
    this.takenLevels.clear();
    this.levelsReached.clear();
    this.takenLevelsCount = 0;
  }

  migrateToSwap(): void {
    this.protocol = 'pumpswap';
  }

  // Call before sending TP sell tx — blocks duplicate shouldSell() signals while tx is in-flight
  lockTpLevel(levelPercent: number): void {
    this.pendingTpLevels.add(levelPercent);
  }

  // Call on tx failure — unlock so retry is possible
  unlockTpLevel(levelPercent: number): void {
    this.pendingTpLevels.delete(levelPercent);
  }

  // Call on tx success — permanently marks level as taken
  markTpLevel(levelPercent: number): void {
    this.pendingTpLevels.delete(levelPercent);
    this.takenLevels.add(levelPercent);
    this.takenLevelsCount++;
  }

  reduceAmount(portion: number, solReceived = 0): number {
    const amountToSell = this.amount * portion;
    this.amount = Math.max(0, this.amount - amountToSell);
    this.partialSolReceived += solReceived;
    this.partialSellsCount++;
    this.entryAmountSol = Math.max(0, this.entryAmountSol * (1 - portion));
    return amountToSell;
  }

  get pnlPercent(): number {
    if (this.entryPrice === 0) return 0;
    return ((this.currentPrice - this.entryPrice) / this.entryPrice) * 100;
  }

  get peakPnlPercent(): number {
    if (this.entryPrice === 0) return 0;
    return ((this.maxPrice - this.entryPrice) / this.entryPrice) * 100;
  }

  get configSnapshot() {
    const exit = this.getExitConfig();
    return {
      entryStopLossPercent:      exit.entryStopLossPercent,
      trailingActivationPercent: exit.trailingActivationPercent,
      trailingDrawdownPercent:   exit.trailingDrawdownPercent,
      slowDrawdownPercent:       exit.slowDrawdownPercent,
      hardStopPercent:           exit.hardStopPercent,
      velocityDropPercent:       exit.velocityDropPercent,
      velocityWindowMs:          exit.velocityWindowMs,
      stagnationWindowMs:        exit.stagnationWindowMs,
      stagnationMinMove:         exit.stagnationMinMove,
      timeStopAfterMs:           exit.timeStopAfterMs,
      timeStopMinPnl:            exit.timeStopMinPnl,
      breakEvenAfterTrailingPercent: exit.breakEvenAfterTrailingPercent,
    };
  }

  /** Returns priceHistory entries in chronological (oldest → newest) order. */
  private priceHistoryToArray(): PriceTick[] {
    const count = this.priceHistoryFull ? MAX_PRICE_HISTORY : this.priceHistoryIdx;
    if (count === 0) return [];
    const result: PriceTick[] = new Array(count);
    const oldestIdx = this.priceHistoryFull ? this.priceHistoryIdx : 0;
    for (let i = 0; i < count; i++) {
      result[i] = this.priceHistory[(oldestIdx + i) % MAX_PRICE_HISTORY];
    }
    return result;
  }

  toJSON(): any {
    return {
      mint: this.mint.toBase58(),
      protocol: this.protocol,
      entryPrice: this.entryPrice,
      entryAmountSol: this.entryAmountSol,
      amount: this.amount,
      maxPrice: this.maxPrice,
      currentPrice: this.currentPrice,
      pool: this.pool,
      tokenDecimals: this.tokenDecimals,
      lastPrice: this.lastPrice,
      lastTimestamp: this.lastTimestamp,
      drawdownStart: this.drawdownStart,
      trailingActivated: this.trailingActivated,
      runnerTailActivated: this.runnerTailActivated,
      takenLevels: Array.from(this.takenLevels),
      pendingTpLevels: Array.from(this.pendingTpLevels),
      takenLevelsCount: this.takenLevelsCount,
      originalEntryAmountSol: this.originalEntryAmountSol,
      openedAt: this.openedAt,
      priceHistory: this.priceHistoryToArray(),
      partialSolReceived: this.partialSolReceived,
      partialSellsCount: this.partialSellsCount,
      levelsReached: Array.from(this.levelsReached),
      feeRecipientUsed: this.feeRecipientUsed,
      creator: this.creator,
      cashbackEnabled: this.cashbackEnabled,
      updateErrors: this.updateErrors,
      tokenScore: this.tokenScore,
    };
  }

  static fromJSON(data: any): Position {
    const pos = new Position(
      new PublicKey(data.mint),
      data.entryPrice,
      data.amount,
      data.pool,
      data.tokenDecimals,
      {
        entryAmountSol: data.entryAmountSol,
        protocol: data.protocol,
        feeRecipientUsed: data.feeRecipientUsed,
        creator: data.creator,
        openedAt: data.openedAt,
      }
    );
    pos.maxPrice = data.maxPrice;
    pos.currentPrice = data.currentPrice;
    pos.lastPrice = data.lastPrice;
    pos.lastTimestamp = data.lastTimestamp;
    pos.drawdownStart = data.drawdownStart;
    pos.trailingActivated = data.trailingActivated;
    pos.runnerTailActivated = data.runnerTailActivated ?? false;
    pos.takenLevels = new Set(data.takenLevels);
    pos.pendingTpLevels = new Set(data.pendingTpLevels ?? []);
    pos.takenLevelsCount = data.takenLevelsCount;
    pos.originalEntryAmountSol = data.originalEntryAmountSol ?? data.entryAmountSol;
    // Restore ring buffer from serialized chronological array
    const savedHistory: PriceTick[] = data.priceHistory ?? [];
    pos.priceHistory = new Array(MAX_PRICE_HISTORY);
    const loadCount = Math.min(savedHistory.length, MAX_PRICE_HISTORY);
    for (let i = 0; i < loadCount; i++) {
      pos.priceHistory[i] = savedHistory[i];
    }
    pos.priceHistoryIdx = loadCount % MAX_PRICE_HISTORY;
    pos.priceHistoryFull = savedHistory.length >= MAX_PRICE_HISTORY;
    pos.partialSolReceived = data.partialSolReceived;
    pos.partialSellsCount = data.partialSellsCount;
    pos.levelsReached = new Set(data.levelsReached);
    pos.updateErrors = data.updateErrors || 0;
    pos.cashbackEnabled = data.cashbackEnabled ?? false;
    pos.tokenScore = data.tokenScore ?? 0;
    return pos;
  }
}