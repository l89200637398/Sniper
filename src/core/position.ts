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
    | 'early_exit';
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
  public takenLevelsCount: number;

  public readonly openedAt: number;
  public priceHistory: PriceTick[];
  public partialSolReceived: number;
  public partialSellsCount: number;

  private levelsReached: Set<number>;

  public feeRecipientUsed?: string;
  public creator?: string;
  public cashbackEnabled: boolean = false;
  public updateErrors: number = 0;

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
    } = {}
  ) {
    this.mint = mint;
    this.protocol = options.protocol ?? 'pump.fun';
    this.entryPrice = entryPrice;
    this.entryAmountSol = options.entryAmountSol ?? config.strategy.entryAmountSol;
    this.amount = amount;
    this.maxPrice = entryPrice;
    this.currentPrice = entryPrice;
    this.pool = pool;
    this.tokenDecimals = decimals;

    this.lastPrice = entryPrice;
    this.lastTimestamp = Date.now();
    this.drawdownStart = null;
    this.trailingActivated = false;

    const initExit = this.protocol === 'pumpswap'        ? config.strategy.pumpSwap.exit
                   : this.protocol === 'mayhem'          ? config.strategy.mayhem.exit
                   : this.protocol === 'raydium-launch'  ? config.strategy.raydiumLaunch.exit
                   : this.protocol === 'raydium-cpmm'    ? config.strategy.raydiumCpmm.exit
                   : this.protocol === 'raydium-ammv4'   ? config.strategy.raydiumAmmV4.exit
                   : config.strategy.pumpFun.exit;
    this.takeProfitLevels = initExit.takeProfit || [];
    this.takenLevels = new Set();
    this.takenLevelsCount = 0;
    this.levelsReached = new Set();

    this.openedAt = options.openedAt ?? Date.now();
    this.priceHistory = [];
    this.partialSolReceived = 0;
    this.partialSellsCount = 0;

    this.feeRecipientUsed = options.feeRecipientUsed;
    this.creator = options.creator;
    this.cashbackEnabled = options.cashbackEnabled ?? false;
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
    if (this.priceHistory.length >= MAX_PRICE_HISTORY) this.priceHistory.shift();
    this.priceHistory.push(tick);
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

    // 1. Entry stop-loss
    if (this.currentPrice <= this.entryPrice * (1 - exit.entryStopLossPercent / 100)) {
      logger.debug(`[${mintStr}] stop_loss: price=${this.currentPrice}, entry=${this.entryPrice}, limit=${this.entryPrice * (1 - exit.entryStopLossPercent / 100)}`);
      logEvent('SHOULD_SELL_TRIGGER', {
        mint: mintStr,
        reason: 'stop_loss',
        price: this.currentPrice,
        entry: this.entryPrice,
        maxPrice: this.maxPrice,
        pnlPercent: this.pnlPercent,
        trailingActivated: this.trailingActivated,
        protocol: this.protocol,
        age,
      });
      return { action: 'full', reason: 'stop_loss', urgent: true };
    }

    // 2. Hard stop (с runner override)
    const drawdown = (this.maxPrice - this.currentPrice) / this.maxPrice;
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

    // 3. Velocity drop
    if (this.priceHistory.length > 1) {
      const windowEdge = now - exit.velocityWindowMs;
      let refTick: PriceTick | undefined;
      for (let i = this.priceHistory.length - 1; i >= 0; i--) {
        if (this.openedAt + this.priceHistory[i].t <= windowEdge) {
          refTick = this.priceHistory[i];
          break;
        }
      }
      if (refTick && refTick.p > 0) {
        const velocityChange = (this.currentPrice - refTick.p) / refTick.p;
        if (velocityChange <= -exit.velocityDropPercent / 100) {
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

    // 5. Stagnation stop
    if (age >= exit.stagnationWindowMs && this.priceHistory.length === 0) {
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
    if (age >= exit.stagnationWindowMs && this.priceHistory.length > 0) {
      const windowEdgeMs = now - exit.stagnationWindowMs;
      const refTick = this.priceHistory.find(
        tick => this.openedAt + tick.t >= windowEdgeMs
      );
      if (refTick && refTick.p > 0) {
        const move = Math.abs((this.currentPrice - refTick.p) / refTick.p);
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

    // 6. Take profit
    for (const level of this.takeProfitLevels) {
      if (this.levelsReached.has(level.levelPercent) && !this.takenLevels.has(level.levelPercent)) {
        logEvent('SHOULD_SELL_TRIGGER', {
          mint: mintStr,
          reason: 'tp_partial',
          levelPercent: level.levelPercent,
          portion: level.portion,
          pnlPercent: this.pnlPercent,
          trailingActivated: this.trailingActivated,
          protocol: this.protocol,
          age,
        });
        return {
          action: 'partial',
          reason: 'tp_partial',
          portion: level.portion,
          tpLevelPercent: level.levelPercent,
          urgent: false,
        };
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

  markTpLevel(levelPercent: number): void {
    this.takenLevels.add(levelPercent);
    this.takenLevelsCount++;
  }

  reduceAmount(portion: number, solReceived = 0): number {
    const amountToSell = this.amount * portion;
    this.amount -= amountToSell;
    this.partialSolReceived += solReceived;
    this.partialSellsCount++;
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
      takenLevelsCount: this.takenLevelsCount,
      openedAt: this.openedAt,
      priceHistory: this.priceHistory,
      partialSolReceived: this.partialSolReceived,
      partialSellsCount: this.partialSellsCount,
      levelsReached: Array.from(this.levelsReached),
      feeRecipientUsed: this.feeRecipientUsed,
      creator: this.creator,
      cashbackEnabled: this.cashbackEnabled,
      updateErrors: this.updateErrors,
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
    pos.takenLevelsCount = data.takenLevelsCount;
    pos.priceHistory = data.priceHistory;
    pos.partialSolReceived = data.partialSolReceived;
    pos.partialSellsCount = data.partialSellsCount;
    pos.levelsReached = new Set(data.levelsReached);
    pos.updateErrors = data.updateErrors || 0;
    pos.cashbackEnabled = data.cashbackEnabled ?? false;
    return pos;
  }
}