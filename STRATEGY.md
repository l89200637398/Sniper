# STRATEGY.md — Торговая стратегия Sniper Bot v3

> Обновлено: 2026-04-30 (sync с config.ts, post-shadow 1001 trades)

---

## 1. Три режима входа

Бот работает одновременно в трёх режимах. Каждый токен может получить вход через любой из них.

| Режим | Триггер | Entry |
|-------|---------|-------|
| **Mode A — Elite Snipe** | `tokenScore ≥ eliteScoreThreshold (25)` | Мгновенный buy без ожидания тренда |
| **Mode B — Trend-Confirmed** | TrendTracker: ≥4 покупателя, ratio≥2.0, объём≥порог, акселерация↑ | Buy после подтверждения momentum |
| **Mode C — PreLaunch** | Совпадение mint/ticker/creator с PreLaunchWatcher | Forced buy с пониженным score-флором |

**Overlap guard**: один mint может получить только один вход. `pendingBuys` Set блокирует дублирование до подтверждения; `confirmedPositions` Set блокирует после.

### Каналы по профилю риска

| Канал | Протоколы | Entry | WR ожид. | Роль |
|-------|-----------|-------|----------|------|
| **Snipe** (Mode A/B) | Pump.fun | 0.05 SOL | ~10% | Минимальный bleeding (3% WR в shadow) |
| **Snipe** (Mode A/B) | PumpSwap | 0.12 SOL | ~20% | Best +EV протокол |
| **Snipe** (Mode A/B) | CPMM | 0.08 SOL | ~14% | Второй по EV |
| **Snipe** (Mode A/B) | AMM v4 | 0.06 SOL | ~7% | Legacy; trailing_stop winner +143% |
| **Snipe** (Mode A/B) | LaunchLab | 0.04 SOL | ~0% | Лотерейный билет |
| **Scalp** | CPMM / AMM v4 (liq >50 SOL) | 0.12 SOL | ~48% BE | Быстрые 5-15% на established пулах |
| **Copy-trade** (T1) | любой протокол | 0.03 SOL | ~65% | Proven-edge (WR≥65%, ≥20 trades) |

## 2. Pipeline принятия решения о входе (псевдокод)

```
onTokenCreate(mint, protocol):
  if mint in blacklist OR creator in blacklist → skip
  if mint in pendingBuys OR confirmedPositions → skip (anti-rebuy)
  if protocol_positions >= maxProtocolPositions → skip
  if totalExposure >= maxTotalExposureSol → skip
  if balance < minBalanceToTradeSol → skip (BUY_SKIPPED_BALANCE)

  # — Фильтры безопасности (параллельно) —
  if suspiciousReserve(age<10s AND reserve>200 SOL) → skip
  if poolAgeGate(age<30s AND volume<0.3 SOL) → skip
  if token2022HasDangerousExtension → skip
  if curveProgress < 2% OR > 85% → skip
  if tokenAge < minTokenAgeMs (400ms) → skip
  if tokenAge > maxTokenAgeMs (20s) → skip
  if entryMomentum.maxPumpRatio violated → skip (entry too late)

  # — Scoring —
  score = computeTokenScore(mint, creator, protocol)
    + metadataQuality()      # ±20
    + holderConcentration()  # ±25
    + creatorHistory()       # ±20
    + creatorBalance()       # ±15
    + creatorWalletAge()     # penalty if <1h
    + bundledBuyPenalty()    # -20 if ≥5 buyers same slot
    + dexBoostBonus()        # +15 if DexScreener boost
    + socialGate()           # -10 if 0 mentions in 5 min / +5 if ≥2

  if defensiveMode.active:
    score -= scoreDelta (8)
    entryAmount *= entryMultiplier (0.50)
  if adaptiveScoring.bump > 0:
    minTokenScore += bump (up to +15)

  # — Entry decision —
  if score >= eliteScoreThreshold (25):
    → Mode A: buy immediately
  elif score >= trackingScoreThreshold (15):
    → Mode B: add to TrendTracker, wait for trend:confirmed
  elif mint in PreLaunchWatcher:
    → Mode C: buy with forced score floor

  # — Buy execution —
  pendingBuys.add(mint)
  amount = entryAmountSol * entryMultiplier(score)
    # score ≥70 → ×2.0 | ≥50 → ×1.0 | ≥minScore → ×0.5
  jito.sendBundle(buyTx, tip=tipAmountSol, burst=2)
  → confirmAndCreatePosition()
  pendingBuys.delete(mint)
  confirmedPositions.add(mint)
```

### TrendTracker (Mode B) — условия подтверждения

```
TrendMetrics per mint (rolling window, по протоколу):
  uniqueBuyers       # уникальные wallets с buy
  buyVolumeSol       # суммарный объём buy
  sellVolumeSol      # суммарный объём sell
  buySellRatio       # buyVol / max(sellVol, 0.001)
  acceleration       # (buys_rate_now - buys_rate_prev) / dt

emit('trend:confirmed') when ALL:
  uniqueBuyers >= minUniqueBuyers (4)
  AND buyVolumeSol >= protocol_threshold
       (pump.fun: 1.0 / PumpSwap: 3.0 / CPMM: 4.0 / AMM v4: 5.0 / LaunchLab: 2.0 SOL)
  AND buySellRatio >= minBuySellRatio (2.0)
  AND buyAccelerationGate: acceleration > 0

emit('trend:weakening') when:
  sellVolume / buyVolume > weakenSellRatio (1.5) over weakenWindowMs (20s)
  → used as exit signal for open positions
```

## 3. Exit-логика (псевдокод)

Каждая позиция проверяется каждые ~400ms. Порядок приоритетов:

```
checkExitSignals(position):
  pnl = (currentPrice - entryPrice) / entryPrice * 100
  peak = max(allPrices)
  drawdownFromPeak = (peak - currentPrice) / peak * 100

  # 1. Liquidity drain (мгновенный выход)
  if solReserve < 0.001 SOL AND age > 5s:
    → close as loss (LIQUIDITY_DRAIN)

  # 2. Whale-sell (top holder dump)
  if topHolderDropped >= 50% of snapshot:
    → close immediately (WHALE_SELL)

  # 3. Price stability (panic exit)
  if dropFromPeak10s > 30%:
    → close (PRICE_UNSTABLE)

  # 4. Hard stop (безусловный)
  if runnerMode:
    if drawdownFromPeak > runnerHardStopPercent: → exit
  else:
    if drawdownFromPeak > hardStopPercent: → exit

  # 5. Entry stop-loss
  if pnl < -entryStopLossPercent: → exit (STOP_LOSS)

  # 6. Velocity drop
  if priceVelocity dropped by > velocityDropPercent in velocityWindowMs:
    → exit (VELOCITY_DROP)

  # 7. Runner-tail activation
  if not runnerMode AND pnl >= runnerActivationPercent:
    runnerMode = true
    # widens trailing, disables break-even

  # 8. Take-profit (tiered)
  for each tp in takeProfit levels:
    if pnl >= tp.levelPercent AND level not yet taken:
      if not pendingTpLevels.has(level):      # race condition guard
        pendingTpLevels.add(level)
        sell(amount * tp.portion)
        if first TP: set break-even stop
        pendingTpLevels.delete(level)

  # 9. Trailing stop
  if trailingActive OR pnl >= trailingActivationPercent:
    trailingActive = true
    trailingHigh = max(trailingHigh, currentPrice)
    if currentPrice <= trailingHigh * (1 - trailingDrawdownPercent/100):
      → exit (TRAILING_STOP)

  # 10. Break-even (после TP1, отключён в runner mode)
  if firstTpTaken AND not runnerMode:
    if pnl < breakEvenAfterTrailingPercent (-1.5%): → exit (BREAK_EVEN)

  # 11. Stagnation
  if priceMove < stagnationMinMove over stagnationWindowMs:
    → exit (STAGNATION)

  # 12. Time stop
  if age > timeStopAfterMs AND pnl < timeStopMinPnl:
    → exit (TIME_STOP)

  # 13. Dead volume
  if no buy activity for deadVolumeTimeoutMs AND no TP taken:
    → exit (DEAD_VOLUME)

  # 14. Trend weakening signal (Mode B)
  if trend:weakening received for this mint:
    → exit (TREND_WEAKENING)
```

### Break-even after TP1

После первого partial sell стоп-лосс сдвигается на уровень входа:
```
onTp1Confirmed():
  breakEvenActive = true
  pendingTpLevels.add('tp1')    # блокирует дублирование пока TX in-flight
  sell(amount * portion)
  pendingTpLevels.delete('tp1')

monitorLoop():
  if breakEvenActive AND not runnerMode:
    if pnl < breakEvenAfterTrailingPercent: → exit BREAK_EVEN
```

## 4. Scalping mode

Активируется автоматически для CPMM и AMM v4 пулов с `solReserve > scalpLiquidityThresholdSol (50 SOL)`.

```
if protocol in ['raydium-cpmm', 'raydium-ammv4']:
  if poolSolReserve > 50 SOL:
    position.isScalp = true
    useExitParams = config.scalping.exit
    entryAmount = config.scalping.entryAmountSol (0.12)
```

### Параметры scalping exit

| Параметр | Значение | Логика |
|----------|----------|--------|
| entryStopLossPercent | 5% | Established пулы не дипают резко без причины |
| hardStopPercent | 12% | -12% на ликвидном пуле = серьёзный сигнал |
| trailingActivationPercent | 6% | Активируем trailing раньше TP2 |
| trailingDrawdownPercent | 3% | Tight trailing — scalp mode |
| velocityDropPercent | 8% | Менее чувствителен, ликвидность сглаживает |
| stagnationWindowMs | 180s | Ликвидные пулы двигаются медленно |
| stagnationMinMove | 0.01 (1%) | Даже +0.5%/мин = норма |
| timeStopAfterMs | 300s (5 мин) | Даём время медленному тренду |

### TP лестница (2 уровня вместо 4)

```
TP1: pnl >= +5%  → sell 50%   (cost recovery + small profit)
TP2: pnl >= +15% → sell 100%  (full exit)
```

Partial TP продажи убыточны при overhead ~4%, поэтому scalp использует только 2 уровня с большими порциями. Break-even WR для scalp: **48%** (было 91% при 3% TP1 порции).

### Trend re-entry для scalp

После TP-profit exit на пуле с активным трендом:
```
if previousExit.reason.startsWith('take_profit') AND previousExit.pnl > 0:
  if trend:confirmed received again for same mint:
    if reEntryCount < maxReEntries (3) AND cooldown > 20s:
      buy(entryAmount * entryMultiplier (0.5))
      reEntryCount++
```

Поддерживается для: pumpswap, raydium-launch, raydium-cpmm, raydium-ammv4.

## 5. TP5 Combat mode (PumpSwap ×10)

TP5 — эксклюзивно для PumpSwap. При достижении +1000% (×10):

```
TP5: pnl >= +1000% → sell 100% (portion = 1.0, полный выход)
```

После полного выхода позиция закрывается. Если для этого mint активен
TrendTracker и тренд сохраняется — возможен re-entry (Trend re-entry,
см. §4). Это позволяет захватить продолжение движения после ×10 без
удержания всего объёма на таком уровне риска.

### Полная TP лестница PumpSwap

| Уровень | Trigger | Portion | Комментарий |
|---------|---------|---------|-------------|
| TP1 | +18% | 25% | Ранняя фиксация при overhead 4.4% |
| TP2 | +80% | 15% | Solid profit |
| TP3 | +180% | 10% | Strong move |
| TP4 | +400% | 5% | Big runner |
| TP5 | +1000% | **100%** | ×10 combat — sell ALL, перейти в trend monitoring |

После TP1 → break-even stop активен. После TP5 → позиция закрыта, возможен re-entry.

> `verify.ts` корректно обрабатывает `portion = 1.0` (полный выход): такие уровни
> исключаются из проверки суммы partial-portions.

## 6. Copy-trade (2-tier)

WalletTracker отслеживает до 2000 кошельков. При buy от eligible wallet — немедленный вход.

```
onWalletBuy(trackedWallet, mint, buySol):
  if buySol < minCopyBuySolLamports (0.15 SOL): skip
  if trackedWallet.recentLosses >= lossStreakLimit: skip
  wallet = walletTracker.getWallet(trackedWallet)
  tier = determineTier(wallet)
  if tier == null: skip (not eligible)
  entryAmount = tier == 'T1' ? copyTrade.entryAmountSol : tier2EntryAmountSol
  if entryAmount == 0: skip  # T2 disabled
  buy(mint, entryAmount, slippage=2000)
```

### Tier-критерии (апрель 2026)

| Параметр | Tier 1 (active) | Tier 2 (disabled) |
|----------|-----------------|-------------------|
| minCompletedTrades | 20 | 15 |
| minWinRate | 0.65 (65%) | 0.55 (55%) |
| entryAmountSol | 0.03 SOL | 0 (DISABLED) |
| lossStreakLimit | ≥5 consecutive | — |
| maxPositions | 1 (reservedT1Slots=1) | — |

### Win detection

```
completeTrade(wallet, buyTx, sellTx):
  pnl = sellSol / buySol
  if pnl > 0.98: win = true   # PnL-based
  elif holdTime in [4s, 90s]: win = true  # fallback
  wallet.completedTrades++
  if win: wallet.recentLosses = 0
  else:   wallet.recentLosses++
```

T2 disabled — 0% WR в production. Thresholds сохранены для future re-enable.

## 7. Kill-switches и Defensive mode

### Kill-switches (полная остановка входов)

| Условие | Параметр | Действие |
|---------|----------|----------|
| 5 подряд убыточных сделок | `consecutiveLossesMax: 5` | Пауза `pauseAfterLossesMs: 900_000` (15 мин) |
| WR < 25% за 10 сделок | JSONL анализ | Пауза 15 мин (TRADE_QUALITY_PAUSE) |
| Invalid bundle rate ≥ 70% за 20 bundles | внутри Sniper | Пауза 5 мин |

### Defensive mode (мягкий throttle)

Активируется раньше kill-switch — усиливает фильтры, не останавливает.

```
defensive.window = 10       # смотрим последние N сделок
defensive.entryThreshold = 0.50  # WR < 50% → включить
defensive.exitThreshold  = 0.60  # WR > 60% → выключить

if rollingWinRate(window) < entryThreshold:
  defensiveMode = true
  minTokenScore += scoreDelta (8)
  entryAmount  *= entryMultiplier (0.50)

if rollingWinRate(window) > exitThreshold:
  defensiveMode = false
  restore defaults
```

### Adaptive scoring (мягче Defensive)

Срабатывает ещё раньше — постепенно бампит minTokenScore:

```
adaptiveScoring.window = 20        # последние N сделок
adaptiveScoring.targetWinRate = 0.50
adaptiveScoring.bumpPerMiss = 3    # +3 к minScore за каждые 5pp ниже цели
adaptiveScoring.maxBump = 15       # но не больше +15
adaptiveScoring.relaxAfterWins = 5 # после 5 побед подряд — уменьшаем bump
```

### Balance check

```
if walletBalance < minBalanceToTradeSol (0):
  skip all new entries (BUY_SKIPPED_BALANCE)
# Сейчас minBalanceToTradeSol=0 (disabled), ранее было 0.5 — блокировало при 0.37 SOL
```

## 8. Sell pipeline (4-chain fallback)

```
sellPosition(position, reason):
  lock sellingMutex(mint)          # защита от double-sell
  ataBalance = readAtaBalance()
  if ataBalance == 0:
    removePosition()               # ATA_EMPTY — токены уже ушли
    return

  slippage = computeDynamicSellSlippage(base, pnl, urgent, reason)

  for attempt in 0..MAX_SELL_ATTEMPTS(4):
    # Circuit-breaker: 2 одинаковых ошибки подряд → прыжок к Jupiter
    if sameError(lastError, currentError) × 2:
      SELL_CIRCUIT_BREAK → goto Jupiter

    if attempt == 0-2:
      try Jito bundle (tip escalation ×1.5/retry, urgent → maxTip immediately)
      try directRPC in parallel (attempt >= 1)

    if attempt == 3 AND bloXroute.enabled:
      if tip <= maxTipPctOfProceeds (5%):
        try bloXroute (BDN)

    # Re-read ATA between retries (catches partial sells)
    ataBalance = readAtaBalance()
    if ataBalance == 0: break (sold successfully)

  # Jupiter fallback (last resort)
  if not sold:
    jupiterSell(slippage=baseBps * 1.5)

  # Rescue attempt (all chains failed)
  if still not sold:
    jupiterSell(slippage=5000)   # 50% slippage rescue

  # Force-close (токены застряли)
  if ATA_EMPTY after all attempts:
    removePosition() (FORCE_CLOSE)
  unlock sellingMutex
```

### Цепочка sell (приоритеты)

| Попытка | Канал | Условие |
|---------|-------|---------|
| 0-2 | **Jito bundle** | Всегда; tip: base→max за 3 попытки |
| 1-2 | **directRPC** | Параллельно с Jito начиная с attempt 1 |
| 3 | **bloXroute** | Если tip ≤ 5% proceeds И env настроен |
| 4 | **Jupiter** | Last resort; slippage × 1.5 |
| Rescue | **Jupiter** | 50% slippage; если всё упало |

### Dynamic sell slippage по причине выхода

| Причина | Формула | Cap |
|---------|---------|-----|
| urgent / pnl < -10% | base × 2.0 | 2500 bps |
| velocity_drop / hard_stop | base × 1.8 | 2200 bps |
| trailing_stop / stop_loss | base × 1.5 | 2000 bps |
| take_profit | base × 1.2 | 1800 bps |
| иные | base | — |

wSOL автоматически unwrap'ается (`createCloseAccountInstruction`) на всех 4 путях sell.

## 9. EV-модель (апрель 2026)

### Overhead на сделку (round-trip)

```
Priority fee:  120k µlamports × 200k CU × 2 sides = 0.000048 SOL
Jito tips:     0.0003 SOL × 2 sides = 0.0006 SOL
Base fees:     0.000005 × 2 = 0.00001 SOL
Failed bundles: ~0.0003 SOL (tip на landed-with-error)
──────────────────────────────────────────────────────
Total overhead: ~0.00096 SOL per round-trip (~1 mSOL)
```

### EV per протокол (при текущих entry amounts)

| Протокол | Entry | WR (shadow) | Avg Win | Avg Loss | EV/trade |
|----------|-------|-------------|---------|----------|----------|
| Pump.fun | 0.05 | ~10% | +0.009 SOL | -0.004 SOL | ~-0.003 |
| PumpSwap | 0.12 | ~20% | +0.028 SOL | -0.018 SOL | ~+0.003 |
| CPMM | 0.08 | ~14% | +0.016 SOL | -0.012 SOL | ~+0.0005 |
| AMM v4 | 0.06 | ~7% | +0.012 SOL | -0.007 SOL | ~-0.005 |
| LaunchLab | 0.04 | ~0% | lottery | -0.005 SOL | ~-0.005 |
| Scalp | 0.12 | ~48% | +0.007 SOL | -0.006 SOL | ~+0.004 |
| Copy T1 | 0.03 | ~65% | +0.006 SOL | -0.005 SOL | ~+0.003 |

### Breakeven WR

```
breakeven_WR = (avgLoss + overhead) / (avgWin + avgLoss)

PumpSwap: (0.018 + 0.00096) / (0.028 + 0.018) = 41%
Scalp:    (0.006 + 0.00096) / (0.007 + 0.006) = 53%
Copy T1:  (0.005 + 0.00096) / (0.006 + 0.005) = 54%
```

### Модель: 1 час торговли

~10 CREATE/мин из gRPC. minTokenScore 45 отсекает ~70% шум.

| Группа | Кол-во/час | PnL/trade | Итого |
|--------|-----------|-----------|-------|
| Early exit / dead volume | 5 | -0.0009 | -0.0045 |
| Stop-loss (-8-15%) | 4 | -0.012 | -0.048 |
| Trailing/TP exit (+18-40%) | 2.5 | +0.016 | +0.040 |
| Runner-tail (×2-×5) | 0.3 | +0.060 | +0.018 |
| Scalp exits (+5-15%) | 2 | +0.006 | +0.012 |
| Copy-trade (2 сигнала/час) | 2 | +0.004 | +0.008 |
| **ИТОГО** | | | **+0.025 SOL/час** |
| Monster runner ×10 (раз в 3 дня) | 0.014/час | +0.500 | **+0.007** |
| **С runners** | | | **~+0.032 SOL/час** |

### Что критически влияет на прибыльность

| Фактор | Влияние | Контроль |
|--------|---------|----------|
| Sell landing rate | КРИТИЧЕСКИЙ | 4-chain fallback + circuit-breaker |
| PumpSwap WR (main +EV) | ВЫСОКИЙ | entry timing, aggressive params |
| Runner capture (TP5 + tail) | ВЫСОКИЙ | 35-45% runner reserve, trailing 8-30% |
| Copy-trade quality | СРЕДНИЙ | T1 WR≥65%, ≥20 trades |
| Overhead control | СРЕДНИЙ | scalp binary exit, минимизируем TP-sells |
| Token scoring accuracy | СРЕДНИЙ | minScore 45, adaptive bump до +15 |
| Break-even after TP1 | СРЕДНИЙ | защита от reversal после первого TP |

### EV-симуляция

```bash
npx ts-node scripts/ev-simulation.ts   # 50k Monte Carlo с полной exit-логикой
npx ts-node scripts/monte-carlo.ts     # 100k trades × 5 протоколов
npx ts-node scripts/ev-analysis/ev-model-v2.ts      # калиброванная на 18 реальных сделках
npx ts-node scripts/ev-analysis/grid-search.ts      # grid: creatorSellMinDropPct × TP1 × SL
npx ts-node scripts/ev-analysis/tp-reachability.ts  # вероятность достижения каждого TP
```
