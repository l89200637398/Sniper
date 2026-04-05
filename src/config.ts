import dotenv from 'dotenv';
dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
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
  // tip на уровне p95+. Static tip = 0.00003 SOL (~$0.0025) — конкурентный
  // но не разорительный. maxTip = 0.0001 SOL (~$0.008).
  jito: {
    bundleUrl: process.env.JITO_BUNDLE_URL || process.env.JITO_RPC || '',
    statusUrl: process.env.JITO_STATUS_URL || process.env.JITO_RPC || '',
    tipAmountSol:      0.00003,    // было 0.000012 → слишком низкий, bundles не приземлялись
    maxTipAmountSol:   0.0001,     // было 0.00005 → потолок для retry escalation
    minTipAmountSol:   0.000015,   // было 0.000008
    maxRetries:        5,          // было 2 → слишком мало, bundle не успевал приземлиться
    tipIncreaseFactor: 1.3,        // было 1.2
    burstCount:        1,
    burstTipMultipliers: [1.0],
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
    maxPositions:         3,         // было 4
    maxPumpFunPositions:  2,         // было 3
    maxPumpSwapPositions: 1,
    maxTotalExposureSol:  0.25,      // было 0.60 → Balanced Battle Config: 0.25

    // ── Фильтрация по возрасту токена ────────────────────────────────────────
    maxTokenAgeMs:        20_000,    // было 30000
    minTokenAgeMs:        150,       // было 50 → меньше same-block rugs
    disallowToken2022:    false,

    // ── Сетевые/Jito пороги ──────────────────────────────────────────────────
    maxJitoTipForEntry:   0.006,     // было 0.012

    // ── Серии убытков ────────────────────────────────────────────────────────
    consecutiveLossesMax: 3,         // было 5 (HISTORY_DEV_SNIPER: source file использует 3)
    pauseAfterLossesMs:   600_000,   // было 300000 → 10 мин вместо 5

    // ── Entry логика ─────────────────────────────────────────────────────────
    // pumpSwapInstantEntry: FALSE — "Balanced Battle Config" из документов.
    // Мгновенный вход в PumpSwap без подтверждения спроса = убыток.
    // Ждём сигнал от independent buyer через waitForBuyerTimeoutMs.
    pumpSwapInstantEntry:  false,    // было true — "самоубийственный режим"
    creatorSellExit:       true,
    socialHighMultiplier:  1.5,      // было 2.0
    socialLowMultiplier:   0.2,

    // ── Entry timing ─────────────────────────────────────────────────────────
    // minIndependentBuySol: 0.15 — только реальные деньги копируем
    minIndependentBuySol:  0.15,     // было 0.05
    waitForBuyerTimeoutMs: 3000,     // было 10000
    // earlyExitTimeoutMs: 800 — быстрый выход при слабых токенах
    earlyExitTimeoutMs:    2000,     // было 800 → срезало profitable trades (HISTORY_DEV_SNIPER P0)

    // ── v3 Scoring ────────────────────────────────────────────────────────────
    // ВАЖНО: scoring при входе = только creatorRecentTokens (sync).
    // Полный scoring с social/rugcheck — при add-on buy.
    enableScoring:     true,
    minTokenScore:     40,           // было 25 → отсекаем низкокачественные токены (HISTORY_DEV_SNIPER P1)
    enableRugcheck:    true,

    // ── Copy-Trade: CT-2 активирован ─────────────────────────────────────────
    // Условия CT-2 выполнены: 33 eligible кошелька, WR > 65%.
    // minWinRate поднят до 0.65 (было 0.55) — только проверенные.
    // minTrades = 20 (было 5) — нужна история.
    copyTrade: {
      enabled:              true,    // было false → CT-2 активируем
      entryAmountSol:       0.03,    // консервативный вход
      maxPositions:         1,       // не разгоняемся
      minBuySolFromTracked: 0.15,    // было 0.10 — только значимые входы
      slippageBps:          2000,
    },

    // ── Pump.fun (bonding curve) ──────────────────────────────────────────────
    pumpFun: {
      entryAmountSol:    0.05,
      minEntryAmountSol: 0.015,      // было 0.005 (HISTORY_DEV_SNIPER: отсечка dust-входов)
      minLiquiditySol:   0.04,
      slippageBps:       2500,
      exit: {
        entryStopLossPercent:          25,
        velocityDropPercent:           15,   // v3
        velocityWindowMs:              500,  // v3
        trailingActivationPercent:     25,
        trailingDrawdownPercent:       12,
        slowDrawdownPercent:           30,
        slowDrawdownMinDurationMs:     800,
        hardStopPercent:               40,
        stagnationWindowMs:        35_000,   // было 60000 → быстрее выходим из stuck трейдов (HISTORY_DEV_SNIPER)
        stagnationMinMove:             0.08,
        timeStopAfterMs:           90_000,
        timeStopMinPnl:               -0.05,
        breakEvenAfterTrailingPercent: -1.5, // было -2 → умирают у -1%
        takeProfit: [
          { levelPercent:   8, portion: 0.20 },
          { levelPercent:  20, portion: 0.10 },
          { levelPercent:  50, portion: 0.40 },
          { levelPercent: 150, portion: 0.30 },
        ],
      },
    },

    // ── PumpSwap AMM ──────────────────────────────────────────────────────────
    pumpSwap: {
      entryAmountSol:        0.05,
      minEntryAmountSol:     0.015,  // было 0.005 (HISTORY_DEV_SNIPER)
      minLiquiditySol:       1,
      slippageBps:           1800,
      maxReserveFraction:    0.15,
      exit: {
        entryStopLossPercent:          20,
        trailingActivationPercent:     35,
        trailingDrawdownPercent:       18,
        slowDrawdownPercent:           38,
        slowDrawdownMinDurationMs:     1200,
        velocityDropPercent:           16,
        velocityWindowMs:              600,
        hardStopPercent:               48,
        stagnationWindowMs:        240_000,
        stagnationMinMove:             0.07,
        timeStopAfterMs:           420_000,
        timeStopMinPnl:               -0.08,
        breakEvenAfterTrailingPercent: -1.5, // было -3
        takeProfit: [
          { levelPercent:   50, portion: 0.25 },
          { levelPercent:  200, portion: 0.25 },
          { levelPercent:  600, portion: 0.25 },
          { levelPercent: 1500, portion: 0.25 },
        ],
      },
    },

    // ── Общие параметры (fallback) ────────────────────────────────────────────
    entryAmountSol:    0.05,
    minEntryAmountSol: 0.015,        // было 0.005 (HISTORY_DEV_SNIPER)
    minLiquiditySol:   0.05,
    slippageBps:       1500,
    exit: {
      entryStopLossPercent:          18,
      trailingActivationPercent:     32,
      trailingDrawdownPercent:       16,
      slowDrawdownPercent:           35,
      slowDrawdownMinDurationMs:     1000,
      velocityDropPercent:           14,
      velocityWindowMs:              500,
      hardStopPercent:               45,
      stagnationWindowMs:        180_000,
      stagnationMinMove:             0.08,
      timeStopAfterMs:           300_000,
      timeStopMinPnl:               -0.07,
      breakEvenAfterTrailingPercent: -1.5,
      takeProfit: [
        { levelPercent:   40, portion: 0.30 },
        { levelPercent:  200, portion: 0.20 },
        { levelPercent:  700, portion: 0.30 },
        { levelPercent: 1500, portion: 0.20 },
      ],
    },
    pumpSwapMaxReserveFraction: 0.2,

    // ── Raydium LaunchLab (bonding curve) ─────────────────────────────────
    maxRaydiumLaunchPositions: 1,
    raydiumLaunch: {
      entryAmountSol:    0.05,
      minEntryAmountSol: 0.015,
      minLiquiditySol:   0.04,
      slippageBps:       2500,
      exit: {
        entryStopLossPercent:          25,
        velocityDropPercent:           15,
        velocityWindowMs:              500,
        trailingActivationPercent:     25,
        trailingDrawdownPercent:       12,
        slowDrawdownPercent:           30,
        slowDrawdownMinDurationMs:     800,
        hardStopPercent:               40,
        stagnationWindowMs:        60_000,
        stagnationMinMove:             0.08,
        timeStopAfterMs:           90_000,
        timeStopMinPnl:               -0.05,
        breakEvenAfterTrailingPercent: -1.5,
        takeProfit: [
          { levelPercent:   8, portion: 0.20 },
          { levelPercent:  20, portion: 0.10 },
          { levelPercent:  50, portion: 0.40 },
          { levelPercent: 150, portion: 0.30 },
        ],
      },
    },

    // ── Raydium CPMM (AMM) ───────────────────────────────────────────────
    maxRaydiumCpmmPositions: 1,
    raydiumCpmm: {
      entryAmountSol:        0.05,
      minEntryAmountSol:     0.015,
      minLiquiditySol:       1,
      slippageBps:           1800,
      maxReserveFraction:    0.15,
      exit: {
        entryStopLossPercent:          20,
        trailingActivationPercent:     35,
        trailingDrawdownPercent:       18,
        slowDrawdownPercent:           38,
        slowDrawdownMinDurationMs:     1200,
        velocityDropPercent:           16,
        velocityWindowMs:              600,
        hardStopPercent:               48,
        stagnationWindowMs:        240_000,
        stagnationMinMove:             0.07,
        timeStopAfterMs:           420_000,
        timeStopMinPnl:               -0.08,
        breakEvenAfterTrailingPercent: -1.5,
        takeProfit: [
          { levelPercent:   50, portion: 0.25 },
          { levelPercent:  200, portion: 0.25 },
          { levelPercent:  600, portion: 0.25 },
          { levelPercent: 1500, portion: 0.25 },
        ],
      },
    },

    // ── Raydium AMM v4 (legacy) ──────────────────────────────────────────
    maxRaydiumAmmV4Positions: 1,
    raydiumAmmV4: {
      entryAmountSol:        0.05,
      minEntryAmountSol:     0.015,
      minLiquiditySol:       1,
      slippageBps:           1800,
      maxReserveFraction:    0.15,
      exit: {
        entryStopLossPercent:          20,
        trailingActivationPercent:     35,
        trailingDrawdownPercent:       18,
        slowDrawdownPercent:           38,
        slowDrawdownMinDurationMs:     1200,
        velocityDropPercent:           16,
        velocityWindowMs:              600,
        hardStopPercent:               48,
        stagnationWindowMs:        240_000,
        stagnationMinMove:             0.07,
        timeStopAfterMs:           420_000,
        timeStopMinPnl:               -0.08,
        breakEvenAfterTrailingPercent: -1.5,
        takeProfit: [
          { levelPercent:   50, portion: 0.25 },
          { levelPercent:  200, portion: 0.25 },
          { levelPercent:  600, portion: 0.25 },
          { levelPercent: 1500, portion: 0.25 },
        ],
      },
    },

    // ── MAYHEM MODE ───────────────────────────────────────────────────────────
    mayhem: {
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
        velocityDropPercent:           15,
        velocityWindowMs:              500,
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

  // ─── Wallet Tracker ─────────────────────────────────────────────────────────
  // Пороги подняты под CT-2: minWinRate 0.65, minCompletedTrades 20.
  walletTracker: {
    minCompletedTrades:    20,          // было 5 → нужна история
    minWinRate:            0.65,        // было 0.55 → только сильные кошельки
    maxTrackedWallets:     2000,
    minCopyBuySolLamports: 150_000_000, // 0.15 SOL (было 0.10)
    saveIntervalMs:        300_000,
  },

  priorityFee: {
    defaultMicroLamports: 120_000,
    percentile:           85,
    updateIntervalMs:     3_000,
  },
  blockhashCache: { refreshIntervalMs: 2000 },
  compute: { unitLimit: 260_000, unitPriceMicroLamports: 100_000 },
  wsolMint: 'So11111111111111111111111111111111111111112',
  pumpSwap: { programId: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA' },
  timeouts: {
    pendingBuyTimeoutMs:         10000,
    confirmTransactionTimeoutMs: 30000,
    optimisticPositionTtlMs:     60000,
    confirmIntervalMs:           800,    // было 200 → bundle не успевал приземлиться за 200ms
  },
};
