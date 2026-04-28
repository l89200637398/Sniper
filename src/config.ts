import dotenv from 'dotenv';
dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

/**
 * Dynamic slippage: reduces slippage when entry is small relative to liquidity.
 * formula: max(minFloorBps, maxSlippageBps × sqrt(entryAmountSol / liquiditySol))
 * e.g. 0.15 SOL entry / 2 SOL liquidity → sqrt(0.075) ≈ 0.27 → 2500 × 0.27 = 688 bps
 * Falls back to maxSlippageBps when liquidity data unavailable.
 */
export function computeDynamicSlippage(
  entryAmountSol: number,
  liquiditySol: number,
  maxSlippageBps: number,
  minFloorBps: number = 300,
): number {
  if (liquiditySol <= 0 || entryAmountSol <= 0) return maxSlippageBps;
  const ratio = entryAmountSol / liquiditySol;
  if (ratio >= 1) return maxSlippageBps;
  const dynamic = Math.ceil(maxSlippageBps * Math.sqrt(ratio));
  return Math.max(minFloorBps, Math.min(dynamic, maxSlippageBps));
}

/**
 * Dynamic sell slippage: widens slippage based on exit urgency.
 * - urgent / deep loss (PnL < -10%): ×2.5 (cap 5000)
 * - velocity drop (fast price decline): ×2.0 (cap 4000)
 * - trailing / normal TP: ×1.3 (modest bump for safety)
 * - otherwise: base slippage unchanged
 */
/**
 * EV-FIX: Dynamic sell slippage caps reduced.
 * Old caps (5000 bps = 50%) were MEV sandwich bait on public mempool fallbacks.
 * Jupiter/bloXroute txs now go through Jito first, but if Jito fails and falls
 * back to public RPC, lower caps limit sandwich damage.
 *
 * Caps: urgent 3500 (was 5000), velocity 3000 (was 4000), trailing 2500 (was 3500).
 * At 0.10 SOL, 35% slippage = max 0.035 SOL lost vs 50% = 0.05 SOL.
 * Savings per sandwich event: 0.015 SOL.
 */
export function computeDynamicSellSlippage(
  baseSlippageBps: number,
  pnlPercent: number,
  urgent: boolean,
  exitReason?: string,
): number {
  if (urgent || pnlPercent < -10) return Math.min(Math.ceil(baseSlippageBps * 2.0), 2500);
  if (exitReason === 'velocity_drop' || exitReason === 'hard_stop') return Math.min(Math.ceil(baseSlippageBps * 1.8), 2200);
  if (exitReason === 'trailing_stop' || exitReason === 'stop_loss') return Math.min(Math.ceil(baseSlippageBps * 1.5), 2000);
  if (exitReason?.startsWith('take_profit')) return Math.min(Math.ceil(baseSlippageBps * 1.2), 1800);
  return baseSlippageBps;
}

export const config = {
  telegram: { botToken: requireEnv('BOT_TOKEN') },
  wallet: {
    privateKey: requireEnv('PRIVATE_KEY'),
    publicKey:  requireEnv('PUBLIC_KEY'),
  },
  rpc: { url: requireEnv('RPC_URL') },
  geyser: {
    endpoint: requireEnv('GRPC_ENDPOINT'),
    token:    requireEnv('GRPC_TOKEN'),
    maxEventQueueSize: 10000,   // было 5000 → 2795 overflow в сессии 26.03
  },

  // ─── Jito MEV ──────────────────────────────────────────────────────────────
  // Tip: p95 обычно 0.000008-0.000023 SOL. Для конкурентного снайпинга нужен
  // tip на уровне p95+. Static tip = 0.00005 SOL — конкурентный
  // но не разорительный. maxTip = 0.00015 SOL, min = 0.0001 SOL.
  jito: {
    bundleUrl: process.env.JITO_BUNDLE_URL || process.env.JITO_RPC || '',
    statusUrl: process.env.JITO_STATUS_URL || process.env.JITO_RPC || '',
    tipAmountSol:      0.0003,     // 0.00005→0.0003: конкурентный tip для landing rate >30%
    maxTipAmountSol:   0.001,      // 0.00015→0.001: достаточно для p99 inclusion
    minTipAmountSol:   0.0002,     // 0.0001→0.0002: floor поднят для гарантированного landing
    // Low-activity floor: когда Jito p50 landed tip < lowActivityP50ThresholdSol,
    // снижаем пол до lowActivityFloorSol. Экономия ~30% на tip'ах при тихой сети
    // без риска потери bundle (p50 уже подтверждает, что его хватает).
    lowActivityFloorSol:          0.0002,    // 0.00007→0.0002: поднят с общим tip increase
    lowActivityP50ThresholdSol:   0.0001,    // 0.00005→0.0001: порог low-activity
    maxRetries:        3,          // 2→3: нужно >=3 чтобы resend код работал (RESEND_FROM_ATTEMPT=2)
    tipIncreaseFactor: 1.5,        // 1.3→1.5: агрессивнее растём к maxTip за 3 попытки
    burstCount:        2,
    burstTipMultipliers: [1.0, 1.3],
    urgentMaxTipImmediate: true,   // dump-сигнал сразу идёт с maxTipAmountSol, без ramp
  },

  // ── bloXroute Trader API (параллельная отправка sell-tx, free-tier) ────────
  // Используется как ПОСЛЕДНЕЕ средство — только когда Jito+directRpc не справились.
  // bloXroute требует SystemProgram.transfer ≥0.001 SOL на tipWallet внутри каждой tx.
  // Чтобы не сжигать tip впустую: активируем только на последней попытке и только
  // если tip составляет менее maxTipPctOfProceeds от ожидаемого выхода (по-умолчанию 5%).
  bloxroute: {
    enabled:              !!process.env.BLOXROUTE_AUTH_HEADER && !!process.env.BLOXROUTE_TIP_WALLET,
    tipWallet:            process.env.BLOXROUTE_TIP_WALLET ?? '',
    tipLamports:          Number(process.env.BLOXROUTE_TIP_LAMPORTS ?? 1_000_000),
    // На какой попытке (0-indexed) sell-loop впервые включает bloXroute.
    // При MAX_SELL_ATTEMPTS=4 значение 3 = только на финальной попытке.
    minAttemptIdx:        3,
    // Если 0.001 SOL (tip) > 5% от ожидаемого выхода — не включаем bloXroute
    // (экономим на mёртвых / почти-дохлых позициях).
    maxTipPctOfProceeds:  0.05,
  },

  metrics: {
    enabled:   process.env.METRICS_ENABLED !== 'false',
    port:      Number(process.env.METRICS_PORT ?? 9469),
  },

  strategy: {
    // ── Лимиты ───────────────────────────────────────────────────────────────
    maxPositions:         12,        // 10→12: +2 scalp slots for established pools
    maxPumpFunPositions:  1,         // 2→1: risky bonding curve, только анонсированные токены
    maxPumpSwapPositions: 5,         // PumpSwap best +EV protocol (aggressive params)
    maxTotalExposureSol:  2.0,       // 3.5→2.0: conservative exposure, PumpSwap 0.14 + rest 0.05 each
    // F6: Auto-stop if wallet balance drops below this threshold (SOL)
    minBalanceToTradeSol: 0.5,       // 0→0.5: аварийный пол, не торгуем на последние крохи

    // ── Фильтрация по возрасту токена ────────────────────────────────────────
    maxTokenAgeMs:        20_000,    // было 30000
    minTokenAgeMs:        400,       // 150→400: пропускаем bundled dev-buys, фильтруем same-block rugs
    disallowToken2022:    false,

    // ── Сетевые/Jito пороги ──────────────────────────────────────────────────
    maxJitoTipForEntry:   0.006,     // было 0.012

    // ── Серии убытков ────────────────────────────────────────────────────────
    // E: tighter loss control — pause 15 min after 3 consecutive losses
    consecutiveLossesMax: 5,          // 0→5: пауза после 5 подряд loss'ов (защита от серии)
    pauseAfterLossesMs:   900_000,

    // ── Entry логика ─────────────────────────────────────────────────────────
    // pumpSwapInstantEntry: FALSE — "Balanced Battle Config" из документов.
    // Мгновенный вход в PumpSwap без подтверждения спроса = убыток.
    // Ждём сигнал от independent buyer через waitForBuyerTimeoutMs.
    pumpSwapInstantEntry:  true,     // false→true: включаем мгновенный вход PumpSwap (rug gate сохранён)
    creatorSellExit:       true,
    // EV-OPT (2026-04-23): min PnL drop (%) before creator_sell triggers exit.
    // Real data: 8/9 creator_sell exits fired at flat PnL (-2.53% to 0%) → panic loss.
    // Threshold 8%: creator_sell only fires when position is meaningfully down.
    // Grid search (100k trades): EV +82% vs threshold=0; +24% vs threshold=5.
    // Applies to all protocols with creator_sell detection: pump.fun, PumpSwap,
    // Raydium Launch, Raydium CPMM, Raydium AMMv4.
    creatorSellMinDropPct: 4,        // 8→4: creator sell exit fires when position is down ≥4%
    socialHighMultiplier:  1.3,      // 1.5→1.3: бонус за social, но не слишком агрессивный
    socialLowMultiplier:   1.0,      // 0.8→1.0: нейтральный — без Twitter 95% имеют score=0, penalty не имеет смысла

    // ── Entry timing ─────────────────────────────────────────────────────────
    minIndependentBuySol:  0.15,     // 0.25→0.15: wider copy-trade funnel, captures more alpha entries
    waitForBuyerTimeoutMs: 3000,     // было 10000
    // earlyExitTimeoutMs: 1000 (full) / 800 (socialLow) — loss-min item #4
    earlyExitTimeoutMs:    5000,     // 1500→5000: даём 5с для подтверждения momentum (1.5с убивало позиции)

    // ── v3 Scoring ────────────────────────────────────────────────────────────
    // ВАЖНО: scoring при входе = только creatorRecentTokens (sync).
    // Полный scoring с social/rugcheck — при add-on buy.
    enableScoring:     true,
    minTokenScore:     45,           // 60→45: снижен — реальный потолок score при входе ~55, порог 60 блокировал всё
    enableRugcheck:    true,

    // ── Copy-Trade: 2-tier system (brainstorm v4) ──────────────────────────────
    // Tier 1 (conservative): WR≥60%, ≥15 trades → полный вход
    // Tier 2 (aggressive):   WR≥50%, ≥8 trades  → половина входа
    // Расширяем воронку: ранее 33 eligible, теперь ~100+ кошельков.
    minCopyTradeScore: 30,          // 15→30: CT 0% WR, жёсткий фильтр до отладки

    copyTrade: {
      enabled:              true,
      entryAmountSol:       0,       // 0.04→0: CT disabled (0% WR, убыточен до отладки)
      tier2EntryAmountSol:  0,       // 0.04→0: T2 disabled (0% WR, -0.545 SOL drain)
      maxPositions:         2,        // 3→2: ограничиваем exposure пока CT не покажет +EV
      minBuySolFromTracked: 1.0,     // 0.5→1.0: только серьёзные покупки ≥1 SOL
      slippageBps:          2000,
      reservedT1Slots:      1,
    },

    // ── Defensive mode (soft throttle, 15 SOL/нед патч P2) ──────────────────
    // Промежуточный уровень между нормальной работой и kill-switch'ом (<25% WR).
    // Активируется если rolling WR за последние N сделок ниже entryThreshold;
    // эффект: minTokenScore +scoreDelta, entry*entryMultiplier. Не паузит, просто
    // усиливает фильтры. Отключается при exitThreshold.
    defensive: {
      enabled:          true,
      window:           10,    // минимум N сделок для оценки
      entryThreshold:   0.50,  // WR < 50% → включить defensive (was 45%)
      exitThreshold:    0.60,  // WR > 60% → выключить (was 55%)
      scoreDelta:       8,     // 4→8: усиленный defensive (score ceiling ~55, при WR<50% блокирует больше)
      entryMultiplier:  0.50,  // 0.70→0.50: при defensive mode entry вдвое меньше
    },

    // ── Entry momentum filter ────────────────────────────────────────────────
    // Если токен уже сильно запампился относительно первой замеченной цены —
    // вход слишком поздний. Блокируем.
    entryMomentum: {
      enabled:       true,
      maxPumpRatio:  3.0,   // current/first >= 3.0x → skip
    },

    // ── Adaptive scoring ─────────────────────────────────────────────────────
    // Если WR в последнем окне низкий, автоматически бампим minTokenScore.
    // Это поверх defensive mode — срабатывает раньше и мягче.
    adaptiveScoring: {
      enabled:         true,
      window:          20,    // смотрим последние N сделок
      targetWinRate:   0.50,  // целевой WR
      bumpPerMiss:     3,     // +3 к minScore за каждые 5pp ниже цели
      maxBump:         15,    // но не больше +15
      relaxAfterWins:  5,     // после N побед подряд — уменьшаем bump
    },

    // ── Liquidity depth check (pre-sell) ─────────────────────────────────────
    // Если наш sell займёт более X% пула — роутим через Jupiter или делим.
    liquidityDepth: {
      enabled:           true,
      maxPoolImpactPct:  15,  // >15% → Jupiter
    },

    // ── Trend re-entry (PumpSwap + Raydium) ──────────────────────────────────
    // Если закрылись по тренду, а тренд возобновился — входим повторно.
    // Pump.fun НЕ поддерживает re-entry (слишком волатилен).
    trendReEntry: {
      enabled:              true,        // false→true: re-entry for scalp + AMM protocols
      maxReEntries:         3,           // 2→3: scalp pools can give multiple waves
      cooldownMs:           20_000,      // 30s→20s: faster re-entry for active pools
      entryMultiplier:      0.5,         // re-entry = 50% of base (risk management)
      maxPriceVsLastEntry:  null,
      requiresTpProfit:     true,        // previous exit must be profitable
      allowedProtocols:     ['pumpswap', 'raydium-launch', 'raydium-cpmm', 'raydium-ammv4'],
    },

    // ── Dead Volume Exit ──────────────────────────────────────────────────────
    // Если в пуле нет buy-активности дольше timeoutMs и ни один TP не зафиксирован —
    // выходим раньше, не ждём stagnation. Спасает от «мёртвых» позиций.
    deadVolume: {
      enabled:     true,
      timeoutMs:   30_000,
      minAgeMs:    10_000,
      scalpTimeoutMs: 45_000,       // scalp: exit after 45s silence (buy activity stopped)
      protocolTimeouts: {
        'pump.fun':        25_000,
        'pumpswap':        60_000,
        'raydium-cpmm':    90_000,
        'raydium-ammv4':  120_000,
        'raydium-launch':  60_000,
      } as Record<string, number>,
    },

    // ── Whale Sell Detection ─────────────────────────────────────────────────
    // Периодически сверяем top holders; если крупный holder сбросил >threshold% —
    // мгновенный exit (вероятен дамп).
    whaleSell: {
      enabled:           true,
      checkIntervalMs:   30_000,  // проверяем раз в 30с
      minPositionAgeMs:  10_000,  // не проверяем в первые 10с
      dropThresholdPct:  50,      // holder сбросил ≥50% от своего snapshot-баланса
      minHolderPct:      10,      // игнорируем holders < 10% supply (5% слишком шумно)
    },

    // ── Social Gate ──────────────────────────────────────────────────────────
    // Штрафуем токены без social mentions при entry scoring. Пайплайн Phase 3
    // уже собирает сигналы — здесь мы их проверяем перед входом.
    socialGate: {
      enabled:          true,
      lookbackMs:       300_000,  // проверяем mentions за последние 5 мин
      noMentionPenalty: 10,       // -10 к score если 0 mentions
      mentionBonus:     5,        // +5 к score если ≥2 mentions
    },

    // ── #6: Creator Balance Check ────────────────────────────────────────────
    creatorBalanceCheck: {
      enabled:          true,
      minSol:           0.5,        // <0.5 SOL = heavy penalty (-15)
      warnSol:          2.0,        // <2 SOL = light penalty (-5)
    },

    // ── #7: PumpSwap Pool Age Gate ───────────────────────────────────────────
    poolAgeGate: {
      enabled:          true,
      minAgeMs:         30_000,     // pool must be >30s old
      minVolumeSol:     0.3,        // unless volume already >0.3 SOL
    },

    // ── #8: Token-2022 Extension Check ───────────────────────────────────────
    token2022Check: {
      enabled:          true,
    },

    // ── #11: Bonding Curve Progress Gate ─────────────────────────────────────
    curveProgress: {
      enabled:          true,
      minProgressPct:   2,          // too early: <2% filled
      maxProgressPct:   85,         // too late: >85% filled (near graduation)
    },

    // ── #12: Metadata Name Quality ───────────────────────────────────────────
    metadataQuality: {
      enabled:          true,
    },

    // ── #13: Adaptive Entry Timing ───────────────────────────────────────────
    adaptiveEntryTiming: {
      enabled:          true,
      pumpFunMinAgeMs:     400,     // pump.fun: fast, keep current
      pumpSwapMinAgeMs:    1000,    // PumpSwap: wait 1s for pool to settle
      raydiumMinAgeMs:     2000,    // Raydium: deeper pools, wait 2s
    },

    // ── #15: Buy Velocity Acceleration ───────────────────────────────────────
    buyAcceleration: {
      enabled:          true,
      windowMs:         10_000,     // measure acceleration over 10s window
      minAcceleration:  1.5,        // buys/sec increasing = organic
    },

    // ── #17: DexScreener Boost at Entry ──────────────────────────────────────
    dexBoostCheck: {
      enabled:          true,
      bonusScore:       15,         // +15 to token score if boosted
    },

    // ── #18: Bundled Buy Detection ───────────────────────────────────────────
    bundledBuyDetection: {
      enabled:          true,
      threshold:        5,          // ≥5 wallets in same slot = bundled
      penalty:          20,         // -20 to score
    },

    // ── #19: Price Stability After Spike ─────────────────────────────────────
    priceStability: {
      enabled:          true,
      windowMs:         10_000,     // check last 10s
      maxDropPct:       30,         // >30% drop from peak = unstable
    },

    // ── #22: Pool Reserve Imbalance ──────────────────────────────────────────
    reserveImbalance: {
      enabled:          true,
      windowMs:         30_000,     // 30s window
      dropThresholdPct: 20,         // >20% SOL reserve drop = exit signal
    },

    // ── Research: Creator Wallet Age ─────────────────────────────────────────
    creatorWalletAge: {
      enabled:          true,
      newWalletThresholdMs: 3_600_000,  // <1h = heavy penalty
    },

    // ── Pump.fun (bonding curve) ──────────────────────────────────────────────
    pumpFun: {
      entryAmountSol:    0.05,               // 0.08→0.05: shadow 3% WR, 166/217=stagnation — минимизируем bleeding
      minEntryAmountSol: 0.03,               // 0.05→0.03: min снижен пропорционально
      minLiquiditySol:   0.04,
      slippageBps:       2000,               // E: 2500→2000: tighter slippage, rejects illiquid pools
      exit: {
        entryStopLossPercent:          8,    // 10→8: bonding curve быстрый, tight SL экономит на dead tokens
        velocityDropPercent:           18,   // 15→18: шире порог, bonding curve volatile
        velocityWindowMs:              1500, // 500→1500: 3-4 блока вместо 1, фильтрует шум одного тика
        trailingActivationPercent:     20,   // 25→20: активируем trailing раньше, ловим больше profit
        trailingDrawdownPercent:       8,    // 7→8: чуть шире trailing, не срубаем на микро-дипах
        slowDrawdownPercent:           30,
        slowDrawdownMinDurationMs:     800,
        hardStopPercent:               40,
        stagnationWindowMs:        45_000,   // 60k→45k: shadow 15/18=stagnation @ avg 52s, выходим раньше
        stagnationMinMove:             0.08,
        timeStopAfterMs:           75_000,   // 90k→75k: согласован с stagnation 45s, не висим мёртвые
        timeStopMinPnl:               -0.02,  // -0.03→-0.02: быстрее cut мёртвые позиции
        breakEvenAfterTrailingPercent: -1.5,
        // ── Runner tail (15 SOL/нед патч P2) ──────────────────────────────
        // После достижения +runnerActivationPercent позиция переходит в режим
        // "монстр-ранера": расширяется trailing drawdown и hard stop, break-even
        // чек отключается. Цель — дать ×5..×10 токенам добежать, они дают основной
        // вклад в EV при низком среднем winrate.
        runnerActivationPercent:       60,    // 80→60: ещё раньше runner mode, pump.fun volatile
        runnerTrailDrawdownPercent:    22,    // 20→22: чуть шире trailing в runner, не срубаем
        runnerHardStopPercent:         35,    // 40→35: tighter hard stop в runner
        // EV-MODEL v3: earlier TP1 for cost recovery. 0.65 total, 35% runner reserve.
        takeProfit: [
          { levelPercent:   12, portion: 0.30 },  // TP1: 15→12%, быстрее recover costs на bonding curve
          { levelPercent:   60, portion: 0.20 },  // TP2: 80→60, solid pump
          { levelPercent:  200, portion: 0.10 },  // TP3: 250→200
          { levelPercent:  500, portion: 0.05 },  // TP4: 600→500, маленькая порция — основное = runner
        ],
      },
    },

    // ── PumpSwap AMM ──────────────────────────────────────────────────────────
    pumpSwap: {
      entryAmountSol:        0.12,   // 0.14→0.12: shadow balanced (0.10) был near break-even (-0.003), aggressive (0.14) хуже — ищем sweet spot
      minEntryAmountSol:     0.07,   // 0.08→0.07: пропорционально снижен
      minLiquiditySol:       1,
      slippageBps:           1500,   // E: 1800→1500: tighter PumpSwap slippage
      maxReserveFraction:    0.20,
      exit: {
        entryStopLossPercent:          15,   // шире SL — shadow показал hard_stop exits с +90% peak, дип перед пампом
        trailingActivationPercent:     40,   // 25→40: AMM volatility, не активируем trailing слишком рано
        trailingDrawdownPercent:       18,   // 12→18: широкий trailing для AMM, даём runners дышать
        slowDrawdownPercent:           35,   // E: 38→35
        slowDrawdownMinDurationMs:     1200,
        velocityDropPercent:           20,   // 14→20: менее чувствителен к дампу, AMM пулы volatile
        velocityWindowMs:              2000, // 500→2000: 5 блоков, фильтрует шум одного тика
        hardStopPercent:               50,   // 42→50: шире hard stop, даём шанс recovery от сильных дипов
        stagnationWindowMs:        180_000,  // 240k→180k: 3 мин вместо 4 — быстрее cut dead positions
        stagnationMinMove:             0.05, // 0.07→0.05: более чувствителен к flatline
        timeStopAfterMs:           360_000,  // 420k→360k: 6 мин вместо 7
        timeStopMinPnl:               -0.06, // -0.08→-0.06: быстрее cut стагнирующие
        breakEvenAfterTrailingPercent: -1.5, // было -3
        // Runner tail для PumpSwap (миграции с bonding curve, потенциал большой).
        runnerActivationPercent:       80,   // 120→80: AMM runner mode быстрее, ловим 2x+ движения
        runnerTrailDrawdownPercent:    30,   // 25→30: шире trailing в runner mode, даём space для volatility
        runnerHardStopPercent:         45,   // 50→45: защита от полного reversal
        // EV-MODEL v4: PumpSwap best protocol, optimize for runners.
        // Portions sum 0.55 → 45% runner reserve. TP5 at 10x: full exit + re-enter trend monitoring.
        takeProfit: [
          { levelPercent:   18, portion: 0.25 },  // TP1: 25→18%, ранняя фиксация при overhead 4.4%
          { levelPercent:   80, portion: 0.15 },  // TP2: solid profit
          { levelPercent:  180, portion: 0.10 },  // TP3: strong move
          { levelPercent:  400, portion: 0.05 },  // TP4: big runner
          { levelPercent: 1000, portion: 1.00 },  // TP5: 10x → sell ALL remaining, transition to trend monitoring
        ],
      },
    },

    // ── Общие параметры (fallback) ────────────────────────────────────────────
    entryAmountSol:    0.06,         // 0.05→0.06: fallback чуть выше для снижения overhead ratio
    minEntryAmountSol: 0.04,         // 0.03→0.04: пропорционально
    minLiquiditySol:   0.05,
    slippageBps:       1500,
    exit: {
      entryStopLossPercent:          14,   // 15→14: чуть tighter global SL
      trailingActivationPercent:     25,   // 32→25: раньше trailing для ранней фиксации
      trailingDrawdownPercent:       12,   // 14→12: tighter trailing
      slowDrawdownPercent:           32,   // 35→32
      slowDrawdownMinDurationMs:     900,  // 1000→900
      velocityDropPercent:           18,   // 14→18: шире, фильтрует шум
      velocityWindowMs:              2000, // 500→2000: 5 блоков
      hardStopPercent:               42,   // 45→42
      stagnationWindowMs:        100_000,  // 120k→100k: 100s stagnation detection
      stagnationMinMove:             0.05, // 0.06→0.05: более чувствителен
      timeStopAfterMs:           200_000,  // 240k→200k: 3.3 min time stop
      timeStopMinPnl:               -0.04, // -0.05→-0.04: быстрее cut
      breakEvenAfterTrailingPercent: -1.5,
      takeProfit: [
        { levelPercent:   20, portion: 0.25 },  // 45→20: ранний cost recovery
        { levelPercent:   80, portion: 0.20 },  // 120→80
        { levelPercent:  250, portion: 0.10 },  // 400→250
        { levelPercent:  600, portion: 0.05 },  // 1000→600: runner reserve 40%
      ],
    },
    pumpSwapMaxReserveFraction: 0.2,

    // ── Raydium LaunchLab (bonding curve) ─────────────────────────────────
    maxRaydiumLaunchPositions: 1,     // 2→1: risky bonding curve, только анонсированные токены
    raydiumLaunch: {
      entryAmountSol:    0.04,       // 0.05→0.04: shadow 0% WR (11 trades, 10=stagnation) — минимальный лотерейный билет
      minEntryAmountSol: 0.03,
      minLiquiditySol:   0.04,
      slippageBps:       2000,   // E: 2500→2000
      exit: {
        entryStopLossPercent:          12,   // 15→12: tighter LaunchLab SL (shadow 0% WR)
        velocityDropPercent:           18,   // 15→18: шире порог
        velocityWindowMs:              2000, // 500→2000: 5 блоков
        trailingActivationPercent:     20,   // 25→20: раньше lock-in profit
        trailingDrawdownPercent:       10,   // 12→10: tighter trailing
        slowDrawdownPercent:           28,   // 30→28
        slowDrawdownMinDurationMs:     800,
        hardStopPercent:               35,   // 40→35: tighter hard stop
        stagnationWindowMs:        45_000,   // 60k→45k: shadow 6/6=stagnation@60s, выходим раньше
        stagnationMinMove:             0.06, // 0.08→0.06: чувствительнее к flatline
        timeStopAfterMs:           75_000,   // 90k→75k: не висим дольше 75с
        timeStopMinPnl:               -0.03, // -0.05→-0.03: быстрее cut losses
        breakEvenAfterTrailingPercent: -1.5,
        // Runner tail for LaunchLab — graduation to AMM means big upside potential
        runnerActivationPercent:       80,    // 120→80: раньше runner mode
        runnerTrailDrawdownPercent:    22,    // 25→22: tighter trailing
        runnerHardStopPercent:         38,    // 45→38
        takeProfit: [
          { levelPercent:   20, portion: 0.25 },  // 30→20: TP1 раньше
          { levelPercent:   70, portion: 0.20 },  // 90→70
          { levelPercent:  200, portion: 0.10 },  // 250→200, меньше порция
          { levelPercent:  500, portion: 0.05 },  // 600→500: runner reserve 40%
        ],
      },
    },

    // ── Raydium CPMM (AMM) ───────────────────────────────────────────────
    maxRaydiumCpmmPositions: 3,       // 2→3: +1 for scalp (established pools)
    raydiumCpmm: {
      entryAmountSol:        0.08,   // 0.05→0.08: лучший не-PS протокол (14.3% WR shadow), overhead ratio 6%→3.8%
      minEntryAmountSol:     0.05,   // 0.03→0.05: пропорционально
      minLiquiditySol:       1,
      slippageBps:           1800,
      maxReserveFraction:    0.15,
      exit: {
        entryStopLossPercent:          15,   // CPMM: keep moderate SL, deeper liquidity = smoother price
        trailingActivationPercent:     30,   // 35→30: раньше trailing
        trailingDrawdownPercent:       15,   // 18→15: tighter trailing
        slowDrawdownPercent:           35,   // 38→35
        slowDrawdownMinDurationMs:     1000, // 1200→1000
        velocityDropPercent:           20,   // 16→20: CPMM менее volatile
        velocityWindowMs:              2500, // 600→2500: 6 блоков для CPMM
        hardStopPercent:               42,   // 48→42: tighter hard stop
        stagnationWindowMs:        180_000,  // 240k→180k: 3 мин
        stagnationMinMove:             0.06, // 0.07→0.06
        timeStopAfterMs:           300_000,  // 420k→300k: 5 мин вместо 7
        timeStopMinPnl:               -0.06, // -0.08→-0.06
        breakEvenAfterTrailingPercent: -1.5,
        // Runner tail for CPMM — deeper liquidity = smoother price action
        runnerActivationPercent:       100,   // 150→100: активируем runner mode раньше (2x)
        runnerTrailDrawdownPercent:    28,    // 25→28: шире trailing в runner mode
        runnerHardStopPercent:         40,    // 45→40
        takeProfit: [
          { levelPercent:   20, portion: 0.25 },  // 30→20: TP1 раньше
          { levelPercent:   70, portion: 0.20 },  // 90→70
          { levelPercent:  200, portion: 0.10 },  // 300→200
          { levelPercent:  500, portion: 0.05 },  // 700→500: runner reserve 40%
        ],
      },
    },

    // ── Raydium AMM v4 (legacy) ──────────────────────────────────────────
    maxRaydiumAmmV4Positions: 3,      // 1→3: established pools with scalping now included
    raydiumAmmV4: {
      entryAmountSol:        0.06,   // 0.05→0.06: shadow 7% WR, trailing_stop winner +143%, минимальный рост для overhead
      minEntryAmountSol:     0.04,   // 0.03→0.04: пропорционально
      minLiquiditySol:       1,
      slippageBps:           1800,
      maxReserveFraction:    0.15,
      exit: {
        entryStopLossPercent:          12,   // 15→12: tighter SL для убыточного протокола
        trailingActivationPercent:     25,   // 35→25: раньше trailing, ловим любой profit
        trailingDrawdownPercent:       14,   // 18→14: tighter trailing
        slowDrawdownPercent:           30,   // 38→30: быстрее exit на slowdown
        slowDrawdownMinDurationMs:     1000, // 1200→1000
        velocityDropPercent:           22,   // 16→22: AMM v4 шумный, меньше false positive
        velocityWindowMs:              3000, // 600→3000: 7 блоков для AMM v4 (глубокая ликвидность)
        hardStopPercent:               35,   // 48→35: tighter hard stop
        stagnationWindowMs:        120_000,  // 240k→120k: 2 мин (shadow: все exits dead_volume)
        stagnationMinMove:             0.05, // 0.07→0.05: чувствительнее к flatline
        timeStopAfterMs:           180_000,  // 420k→180k: 3 мин (shadow avg hold 91s, нет смысла ждать)
        timeStopMinPnl:               -0.04, // -0.08→-0.04: быстрее cut losses
        breakEvenAfterTrailingPercent: -1.5,
        // Runner tail for AMM v4 — tighter than CPMM (0% WR protocol)
        runnerActivationPercent:       80,    // 150→80: раньше runner mode
        runnerTrailDrawdownPercent:    20,    // 25→20: tighter trailing
        runnerHardStopPercent:         35,    // 45→35
        takeProfit: [
          { levelPercent:   15, portion: 0.30 },  // 30→15, 0.25→0.30: ранний cost recovery
          { levelPercent:   60, portion: 0.20 },  // 90→60
          { levelPercent:  200, portion: 0.10 },  // 300→200
          { levelPercent:  500, portion: 0.05 },  // 700→500: runner reserve 35%
        ],
      },
    },

    // ── Scalping Mode (established high-liquidity pools) ────────────────────
    // Activated for CPMM/AMM v4 pools with SOL reserve > scalpLiquidityThresholdSol.
    // Strategy: enter on confirmed slow trend, hold while buy pressure > sell pressure,
    // exit when momentum fades. Tight TP, moderate stagnation, volume-aware.
    scalpLiquidityThresholdSol: 50,    // pools above this = scalp mode
    scalping: {
      entryAmountSol:    0.12,         // higher stake: lower risk on established pools
      minEntryAmountSol: 0.08,
      exit: {
        entryStopLossPercent:          5,     // tight SL — established pools shouldn't dip much
        velocityDropPercent:           8,     // meaningful drop = exit (10→8: ликвидные пулы не дипают резко без причины)
        velocityWindowMs:              5000,  // 12 blocks — sustained drops only, filter single-block noise
        trailingActivationPercent:     6,     // activate trailing at +6% — earlier than TP2
        trailingDrawdownPercent:       3,     // tight trailing — scalp mode
        slowDrawdownPercent:           10,
        slowDrawdownMinDurationMs:     3000,  // 3s sustained decline
        hardStopPercent:               12,    // tight hard stop (15→12: на ликвидных пулах -12% это серьёзно)
        stagnationWindowMs:        180_000,   // 3 min stagnation (60s→180s: ликвидные пулы двигаются медленно)
        stagnationMinMove:             0.01,  // 1% min movement (2%→1%: даже +0.5%/мин = нормально)
        timeStopAfterMs:           300_000,   // 5 min max hold (2→5: даём время медленному тренду)
        timeStopMinPnl:               -0.01,  // quick cut if negative after 5 min
        breakEvenAfterTrailingPercent:  0.5,  // tight break-even after trailing
        runnerActivationPercent:       20,    // runner at +20% (rare for established pools)
        runnerTrailDrawdownPercent:    6,     // runner trailing
        runnerHardStopPercent:         12,    // runner hard stop
        takeProfit: [
          { levelPercent:   5, portion: 0.50 },   // TP1: 3→5%, 50% full exit (partial sells убыточны по overhead)
          { levelPercent:  15, portion: 1.00 },   // TP2: 15% → sell ALL remaining (breakeven WR 91%→48%)
        ],
      },
    },

    // ── Jupiter Fallback Buy (unknown protocol) ───────────────────────────────
    // Активируется когда detectProtocol() вернул 'unknown': bonding curve и pool
    // не найдены, но токен пришёл в gRPC. Покупаем через Jupiter агрегатор.
    // Выход — фиксированный time-stop (timeStopMs), продажа через sell chain → Jupiter.
    // По умолчанию ВЫКЛЮЧЕНО: включать только если понятен источник unknown-токенов.
    jupiterFallback: {
      enabled:         false,      // DISABLED: покупает неизвестные токены, убыток
      entryAmountSol:  0.05,    // меньше стандартного: неизвестный протокол = больший риск
      slippageBps:     2500,
      timeStopMs:      30_000,  // 30с: жёсткий time-stop без мониторинга цены
    },

    // ── MAYHEM MODE ───────────────────────────────────────────────────────────
    // DISABLED (2026-04-23): EV simulation shows NEGATIVE EV (-0.003 SOL/trade).
    // Aggressive 3-level TP (25%/80%/200%) + no runner reserve + high rug rate
    // (8%) + small entry (0.02 SOL) → overhead dominates. Re-enable only after
    // explicit EV re-validation with real Mayhem trades.
    mayhem: {
      enabled:           false,
      delayMs:           300,
      entryAmountSol:    0.02,
      slippageBps:       5000,   // было 10000 → 50% достаточно
      maxRealSolAtEntry: 100,
      exit: {
        entryStopLossPercent:          20,
        trailingActivationPercent:     22,
        trailingDrawdownPercent:       12,
        slowDrawdownPercent:           25,
        slowDrawdownMinDurationMs:     500,
        velocityDropPercent:           18,   // 15→18
        velocityWindowMs:              2000, // 500→2000
        hardStopPercent:               35,
        stagnationWindowMs:         90_000,
        stagnationMinMove:             0.10,
        timeStopAfterMs:           120_000,
        timeStopMinPnl:               -0.10,
        breakEvenAfterTrailingPercent: -1.5,
        takeProfit: [
          { levelPercent:  25, portion: 0.40 },
          { levelPercent:  80, portion: 0.35 },
          { levelPercent: 200, portion: 0.25 },
        ],
      },
    },
  },

  // ─── Trend-Confirmed Entry ──────────────────────────────────────────────────
  trend: {
    enabled: true,

    // Режим A: порог score для мгновенного входа (elite sniper)
    eliteScoreThreshold: 25,          // 50→25: pump.fun не мог пройти (макс без social=35), теперь rug_low=20+creator=15=35 проходит

    // Режим B: минимальный score для отслеживания тренда
    trackingScoreThreshold: 15,       // 45→15: все не-спам токены идут в trendTracker

    // Скользящие окна тренда (ms)
    pumpFunWindowMs:   60_000,       // 20s→60s: 20s блокировал все pump.fun (нужно 4 buyers×1.5 SOL за 20s = нереально)
    pumpSwapWindowMs:  120_000,
    raydiumWindowMs:   300_000,

    // Критерии подтверждения тренда
    minUniqueBuyers: 4,             // 3→4: отсекаем creator+MEV+dust паттерн
    minBuyVolumeSol: 2.0,           // 0.3→2.0: stagnation-токены входили с 1.93 SOL, stop_loss с 4.08
    minBuySellRatio: 2.0,           // 1.5→2.0: требуем более выраженный buy-перевес

    // Protocol-specific volume thresholds (override minBuyVolumeSol per protocol)
    pumpFunMinVolumeSol:       1.0,  // 0.5→1.0: quant рекомендует выше, 0.5 пропускает шум
    pumpSwapMinVolumeSol:      3.0,  // PumpSwap: AMM pool, need stronger volume signal
    raydiumLaunchMinVolumeSol: 2.0,  // LaunchLab: bonding curve similar to pump.fun
    raydiumCpmmMinVolumeSol:   4.0,  // CPMM: deeper liquidity than LaunchLab, moderate threshold
    raydiumAmmMinVolumeSol:    5.0,  // AMM v4: deepest liquidity, highest threshold

    // buyAcceleration gate: require accelerating buy rate for trend confirmation
    buyAccelerationGate: true,

    // Таймаут ожидания подтверждения тренда (после CREATE)
    pumpFunTimeoutMs:   90_000,     // 45s→90s: pump.fun нужно больше времени для набора buyers
    pumpSwapTimeoutMs:  300_000,
    raydiumTimeoutMs:   600_000,

    // Усиление тренда (для add-on)
    strengthenBuyerThreshold: 8,
    strengthenVolumeSol: 2.0,

    // Ослабление тренда (для exit signal)
    weakenSellRatio:   1.5,
    weakenWindowMs:    20_000,        // 30s→20s: must be ≤ pumpFunWindowMs (20s)

    // Social discovery (Режим C)
    socialDiscoveryEnabled: true,
    socialPollIntervalMs: 5_000,
    socialMaxTrackedMints: 20,

    // Auto-alpha: автоматическое заполнение PreLaunchWatcher из social pipeline.
    // Три критерия (любой достаточен):
    //   1. DexScreener boost → автоматический alpha (оплаченная промо)
    //   2. Cross-source: mint упоминается в ≥minMentions разных каналах/лентах за lookbackMs
    //   3. Large channel: канал/лента с ≥minFollowers подписчиков + позитивный sentiment
    autoAlpha: {
      enabled:              true,
      maxCandidates:        20,       // макс. кандидатов в очереди одновременно
      minFollowers:         5000,     // мин. подписчиков канала/ленты (TG channel subs, Twitter followers)
      minMentions:          2,        // мин. кол-во РАЗНЫХ источников (каналов) упоминающих один mint
      lookbackMs:           600_000,  // 10 мин окно для подсчёта cross-source mentions
      positiveSentimentMin: 0.2,      // мин. sentiment для large-channel критерия
      ttlMs:                3_600_000, // 1 час TTL для auto-alpha (vs 24ч для manual alpha)
    },

    // Автоочистка неактивных mint'ов
    inactiveCleanupMs: 300_000,
  },

  // ─── Wallet Tracker (2-tier, brainstorm v4) ─────────────────────────────────
  // Tier 1: WR≥60%, ≥15 trades → conservative, полный вход
  // Tier 2: WR≥50%, ≥8 trades  → aggressive, половина входа
  walletTracker: {
    // Tier 1 (isCopyEligible)
    minCompletedTrades:    15,          // 20→15: расширяем воронку
    minWinRate:            0.60,        // 0.65→0.60: больше eligible кошельков
    // Tier 2 DISABLED (entry=0 SOL) — thresholds kept for future re-enable
    tier2MinCompletedTrades: 15,     // 8→15: подтянули к T1 (T2 давал 0% WR)
    tier2MinWinRate:         0.55,   // 0.50→0.55: требуем лучший WR
    maxTrackedWallets:     2000,
    minCopyBuySolLamports: 150_000_000, // 0.15 SOL
    saveIntervalMs:        300_000,
  },

  priorityFee: {
    defaultMicroLamports: 120_000,
    percentile:           85,
    updateIntervalMs:     10_000,
  },
  blockhashCache: { refreshIntervalMs: 2000 },
  compute: { unitLimit: 200_000, pumpSwapUnitLimit: 300_000, unitPriceMicroLamports: 50_000 },
  wsolMint: 'So11111111111111111111111111111111111111112',
  pumpSwap: { programId: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA' },
  timeouts: {
    pendingBuyTimeoutMs:         10000,
    confirmTransactionTimeoutMs: 30000,
    optimisticPositionTtlMs:     60000,
    confirmIntervalMs:           400,    // было 800 → 400ms компромисс: bundle приземляется за 200-600ms
  },
};

// ========== Runtime Config for Web UI ==========
import get from 'lodash/get';
import set from 'lodash/set';
import cloneDeep from 'lodash/cloneDeep';
import fs from 'fs';
import path from 'path';

class RuntimeConfig {
  private _data: any;
  private _listeners = new Set<(p: string, v: any) => void>();
  private _savePath = path.join(process.cwd(), 'data/runtime-config.json');

  constructor(base: any) {
    try {
      const overrides = JSON.parse(fs.readFileSync(this._savePath, 'utf-8'));
      this._data = cloneDeep(base);
      for (const [p, v] of Object.entries(overrides)) set(this._data, p, v);
    } catch {
      this._data = cloneDeep(base);
    }
  }
  getAll() { return this._data; }
  get<T>(p: string): T { return get(this._data, p) as T; }
  set(p: string, v: any) { set(this._data, p, v); this._listeners.forEach(fn => fn(p, v)); this._persist(); }
  onChange(fn: (p: string, v: any) => void) { this._listeners.add(fn); }
  private _persist() { fs.writeFileSync(this._savePath, JSON.stringify(this._data, null, 2)); }
}

export const runtimeConfig = new RuntimeConfig(config);
