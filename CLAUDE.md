# CLAUDE.md — Solana Sniper Bot v3

## Правила работы

- Перед правкой кода: прочитай файл, покажи что планируешь менять
- После правки кода: обязательно `tsc --noEmit`
- Не удаляй код без grep-подтверждения что он не используется
- Параметры `trailingDrawdownPercent` и `velocityDropPercent` — менять с осторожностью, после EV-симуляции
- Не трогай файлы в `src/trading/` без явного разрешения
- Коммить только после подтверждения пользователя
- Перед коммитом: `git diff --stat` + краткое описание что меняется
- Язык общения: русский

## What This Is

A Solana MEV sniper bot targeting Pump.fun, PumpSwap, and Raydium (LaunchLab + CPMM + AMM v4) token launches. It streams real-time events via Yellowstone Geyser gRPC, executes buys through Jito MEV-Share bundles, manages positions with rule-based exits (incl. **scalping mode** for high-liquidity pools and **TP5 +1000% combat mode**), and exposes three operator surfaces: a **read-only Telegram bot** (push notifications + 4-button status menu), a **CLI toolkit** under `scripts/` (incl. EV-analysis, dossier, prelaunch, shadow), and a **Web UI** (React + Vite, 13 REST endpoints + Socket.IO) with full operator dashboard.

Three entry modes work in parallel: **Mode A** (elite-score immediate buy), **Mode B** (trend-confirmed via TrendTracker — volume/buyers/social) and **Mode C** (PreLaunchWatcher — manual + auto-alpha watchlist with TTL).

## Tech Stack

- **Language**: TypeScript 5.9 (strict mode, ES2020 target, CommonJS modules)
- **Runtime**: Node.js with ts-node (dev) / compiled JS (prod)
- **Blockchain**: @solana/web3.js 1.87.6, @solana/spl-token 0.3.9
- **Streaming**: gRPC via @grpc/grpc-js + Yellowstone Geyser
- **MEV**: Jito bundle submission via @triton-one/yellowstone-grpc
- **Bot**: Telegraf 4.15.3 (Telegram)
- **Logging**: Pino (structured JSON) + JSONL event/trade logs
- **Other**: dotenv, axios, p-limit, bs58, google-protobuf

## Repository Structure

```
src/
├── index.ts                 # Entry point — initializes Sniper + TelegramBot + Web UI
├── config.ts                # All config parameters (230+ lines)
├── constants.ts             # Solana program IDs, discriminators, layouts
├── runtime-layout.ts        # Dynamic on-chain layout caching
├── core/
│   ├── sniper.ts            # Main Sniper class (~7700 lines, EventEmitter: position:open/close)
│   ├── position.ts          # Position tracking (PnL, exit signals, take-profit, scalp flag)
│   ├── detector.ts          # Protocol detection (pump.fun vs PumpSwap, LRU cache cleanup)
│   ├── migration.ts         # Bonding curve → AMM migration detection
│   ├── state-cache.ts       # MintState cache
│   ├── wallet-tracker.ts    # Copy-trading wallet analysis
│   ├── sell-engine.ts       # Unified sell logic across protocols
│   ├── blacklist-store.ts   # Atomic JSON persistence (tokens + creators), mtime-poll
│   ├── prelaunch-watcher.ts # Mode C: pre-launch candidates (24h TTL, mint/creator match)
│   └── trend-tracker.ts     # Mode B: real-time trend metrics + emit('trend:confirmed/weakening')
├── trading/
│   ├── buy.ts               # Pump.fun buy instruction builder
│   ├── sell.ts              # Pump.fun sell transaction
│   ├── pumpSwap.ts          # PumpSwap AMM buy/sell (pool parsing, slippage)
│   ├── raydiumLaunchLab.ts  # Raydium LaunchLab bonding curve buy/sell
│   ├── raydiumCpmm.ts       # Raydium CPMM AMM buy/sell
│   ├── raydiumAmmV4.ts      # Raydium AMM v4 legacy swap
│   ├── jupiter-buy.ts       # Jupiter aggregator buy fallback (unknown protocols)
│   └── jupiter-sell.ts      # Jupiter aggregator sell fallback (last resort)
├── geyser/
│   └── client.ts            # Yellowstone Geyser gRPC streaming client (EventEmitter)
├── jito/
│   └── bundle.ts            # Jito bundle sending, tip management, retry logic
├── infra/
│   ├── rpc.ts               # Solana RPC connection + backup RPC failover
│   ├── jito-queue.ts        # Async queue for Jito submissions (p-limit)
│   ├── jito-rate-limiter.ts # Token bucket rate limiter (10 RPS)
│   ├── blockhash-cache.ts   # Auto-refreshing blockhash cache
│   ├── priority-fee-cache.ts
│   └── bloxroute.ts         # bloXroute fallback (STUB — gated on BLOXROUTE_* env)
├── bot/
│   └── bot.ts               # Telegram bot — READ-ONLY (push + 4-button menu)
├── analysis/                # Stage 3: session stats + config recommendations
│   ├── session.ts           # JSONL reader + metric aggregator
│   ├── recommendations.ts   # 10 heuristics for config.ts advice
│   └── format.ts            # CLI/TG-HTML formatting layer
├── utils/
│   ├── logger.ts            # Pino logger (file + console)
│   ├── event-logger.ts      # Structured JSONL event logging
│   ├── trade-logger.ts      # JSONL trade event tracking
│   ├── token-scorer.ts      # v4 rule-based token scoring (0–100) with entry multiplier
│   ├── social.ts            # LEGACY: pre-Phase-3 on-chain social check (used by token-scorer)
│   ├── metrics.ts           # In-memory metrics: counters, gauges, histograms (optional /metrics HTTP)
│   ├── rugcheck.ts          # Rug check API integration (relaxed for graduated PumpSwap)
│   ├── safety.ts            # Token safety checks (mint/freeze auth + Token-2022 dangerous extensions)
│   ├── balance.ts           # Balance validation
│   ├── retry.ts             # Retry with exponential backoff
│   ├── rpc-limiter.ts       # RPC rate limiting decorator
│   ├── sha.ts               # SHA256 utility
│   ├── bonding-curve-progress.ts  # %-of-curve gate (too early <2%, too late >85%)
│   ├── bundled-buy-detector.ts    # Slot-bucketed buyer count (≥5 = bundled dev-buy)
│   ├── creator-balance.ts         # Creator SOL balance (120s cache, <0.5 = -15)
│   ├── creator-history.ts         # SQLite rug-rate by creator (5min cache, blocks repeat ruggers)
│   ├── creator-wallet-age.ts      # First-tx slot estimate, isNew if <1h
│   ├── dex-boost-check.ts         # DexScreener active boosts cache (1min)
│   ├── holder-check.ts            # getTokenLargestAccounts top holder %
│   ├── metadata-quality.ts        # Random/copycat name detection (-20..+5)
│   ├── pool-age-gate.ts           # In-memory pool age (skip if <30s and <0.3 SOL volume)
│   ├── price-stability.ts         # 10s window, panic-exit on drop >30% from peak
│   ├── reserve-monitor.ts         # 30s SOL reserve snapshots, exit on >20% drop / liquidity drain
│   ├── token2022-check.ts         # Blocks DANGEROUS extensions (TransferFee, PermanentDelegate, etc.)
│   └── wash-trade-detector.ts     # 30s window repeat-buyer % (≥40% = wash flag)
├── social/                  # Phase 3: pluggable social-signal pipeline
│   ├── models/signal.ts     # SocialSignal interface + signalKey() dedup
│   ├── manager.ts           # SocialManager (polling, dedup, persist, emit)
│   ├── watchlist.ts         # Alpha whitelist (ALPHA_TICKERS/MINTS/AUTHORS) — STUB
│   ├── nlp/sentiment.ts     # Keyword sentiment + ticker/mint extractors
│   ├── storage/signal-store.ts  # SQLite persistence (social_signals table)
│   └── parsers/
│       ├── dexscreener.ts   # Free boosts API (no key) — always active
│       ├── telegram.ts      # Public-channel HTML scraper (t.me/s/{slug}) — no keys
│       └── twitter.ts       # RapidAPI-based search parser (STUB — gated on RAPIDAPI_KEY)
├── db/
│   ├── sqlite.ts            # better-sqlite3 singleton + auto migrations
│   ├── dossier.ts           # Per-mint history (seen → protocol → scoring → trade → close); replaces solscan
│   └── migrations/*.sql     # Idempotent schema migrations
├── shadow/                  # Parallel backtester (3 profiles, mirrors live entry pipeline)
│   ├── engine.ts            # ShadowEngine: portfolio sim, TradeLogEntry emit, ws integration
│   ├── pipeline.ts          # Entry decision: limits → rugcheck/safety/social || → score
│   ├── profiles.ts          # Conservative/balanced/aggressive (startBalance, entry, maxPositions)
│   └── tx-builder.ts        # Unified buy/sell tx for all 5 protocols + simulation
├── maintenance/             # Background workers
│   ├── cleanup.ts           # Hourly TTL eviction + CleanupReport (saved to analysis_reports)
│   └── disk-monitor.ts      # Free-space alerts at 10/8/6/4/3/2/1 GB (each fires once)
├── web/                     # REST + Socket.IO backend for Web UI (13 routes)
│   ├── server.ts            # Express 5 + JWT middleware + Socket.IO + static SPA
│   ├── auth.ts              # JWT + bcrypt (gated on JWT_SECRET + WEB_PASSWORD_HASH)
│   ├── routes/              # 13 REST endpoints (control, config, positions, trades,
│   │                        #   wallet, wallets, blacklist, social, prelaunch, tokens,
│   │                        #   logs, shadow, index)
│   └── ws/events.ts         # Socket.IO: position:*, balance/stats (5s), trend:*, social:*
├── test-pumpswap.ts         # PumpSwap simulation test script (ops tool)
├── test-raydium.ts          # Raydium simulation test script (ops tool)
└── autogen/
    └── runtime-layout.json  # Auto-generated on-chain layout snapshot

proto/                        # gRPC protocol buffer definitions
scripts/
├── verify.ts                # On-chain layout validation (prestart hook); handles TP5 portion=1.0
├── stop.ts                  # Graceful SIGTERM via .sniper.pid
├── control.ts               # Foreground launcher (no Telegram, no Web UI)
├── blacklist.ts             # Blacklist CLI (add/remove/list/stats/clear)
├── cleanup-dust.ts          # Close empty ATAs, reclaim rent
├── analyze-trades.ts        # Post-trade JSONL analysis (+ social correlation)
├── recommend-config.ts      # Stage 3: config.ts advice (cron-friendly)
├── test-trade.ts            # Manual trade execution (auto-detects protocol)
├── shadow-run.ts            # Shadow-mode replay (parallel backtester)
├── dossier.ts               # CLI viewer for per-mint full history (replaces solscan)
├── prelaunch.ts             # CLI for PreLaunchWatcher (add/list/remove/clear)
├── sell-unknown-tokens.ts   # Emergency mass-sell on wallet (+ burn unsellable)
├── verify-sell.ts           # Pre-launch validator: imports + routing + TP system (48 checks)
├── ev-simulation.ts         # 50k Monte Carlo with full exit logic
├── monte-carlo.ts           # 100k trades × 5 protocols with traffic weights
└── ev-analysis/             # 6 EV-tuning utilities
    ├── ev-model-v2.ts       # Calibrated on real 18 trades; finds stable EV at WR≥30%
    ├── aggregate-ev.ts      # 100k sim across 5 protocols, weighted EV
    ├── grid-search.ts       # creatorSellMinDropPct × TP1 × SL grid stress-test
    ├── per-protocol.ts      # Per-protocol breakdown (profit factor, distribution)
    ├── final-comparison.ts  # Side-by-side comparison table
    └── tp-reachability.ts   # Probability of reaching each TP level
data/
├── positions.json           # Persisted active positions
├── blacklist.json           # Blacklist (tokens + creators); hot-reloaded via mtime poll
├── wallet-tracker.json      # Copy-trading wallet data
├── prelaunch.json           # PreLaunchWatcher candidates (24h TTL)
├── runtime-config.json      # Web UI overrides (RuntimeConfig persistence)
└── sniper.db                # SQLite (social_signals, events, trades, dossier, analysis_reports)
web-ui/                       # Frontend (React + Vite) — served from web-ui/dist
                             # Pages: Dashboard, Positions, Trades, Config, Blacklist,
                             # Wallets, Social, PreLaunch, Tokens, Shadow, Logs
```

## Commands

```bash
npm run dev       # Run with ts-node (development)
npm run build     # tsc -p tsconfig.build.json + copy db/migrations → dist/
npm start         # Run verify.ts prestart hook, then dist/index.js
npm run shadow    # Parallel backtester (3 profiles)
npm test          # jest --verbose (unit tests under __tests__/)
```

Test/validation tooling:
- `scripts/verify.ts` — validates on-chain account layouts + config consistency (handles TP5 portion=1.0 since 821e9fe)
- `scripts/verify-sell.ts` — pre-launch sell-path validator (imports, sell-engine routing, TP system, 48 checks)
- `scripts/test-trade.ts` — manual trade execution (auto-detects protocol)
- `src/test-pumpswap.ts` / `src/test-raydium.ts` — protocol-specific simulation
- `scripts/analyze-trades.ts` — post-trade JSONL + social correlation
- `scripts/recommend-config.ts` — heuristic advice on config.ts (cron-friendly)
- `scripts/shadow-run.ts` — parallel backtester (3 profiles, mirrors live pipeline)
- `scripts/ev-simulation.ts` / `scripts/monte-carlo.ts` — synthetic EV projection
- `scripts/ev-analysis/*.ts` — 6 EV calibration utilities

Operator CLI (see `RUNBOOK.md §4`):
- `npm start` / `npm run stop` — prod lifecycle via `.sniper.pid`
- `npm run blacklist -- <cmd>` — manage `data/blacklist.json` (hot-reloaded via mtime)
- `npm run cleanup-dust` — reclaim rent from empty ATAs
- `npm run analyze` / `npm run recommend` — JSONL + config heuristics
- `npx ts-node scripts/control.ts start` — foreground, no TG/Web UI
- `npx ts-node scripts/dossier.ts <mint>` — full per-mint history from SQLite
- `npx ts-node scripts/prelaunch.ts <add|list|remove|clear>` — PreLaunchWatcher CRUD
- `npx ts-node scripts/sell-unknown-tokens.ts [--dry-run] [--burn-unsellable]` — emergency mass-sell

## Architecture

### Event Flow

```
Geyser gRPC stream → EventEmitter events
  ├─► Mode A: elite score (≥eliteScoreThreshold=25) → immediate buy
  ├─► Mode B: TrendTracker aggregates volume/buyers/social
  │           → emit('trend:confirmed') → buy
  └─► Mode C: PreLaunchWatcher match (manual + auto-alpha)
              → forced score floor → buy
  ↓
  Token scoring + safety + filter gates (~13 utils: bundled-buy,
    creator-history/age/balance, holder-check, pool-age, suspiciousReserve,
    metadata-quality, token2022, curve-progress, dex-boost, wash-trade, etc.)
  ↓
  Buy via Jito bundle (burst 2 TXs; double-buy guarded by confirmedPositions Set)
    └─► unknown protocol → Jupiter fallback (DISABLED by default)
  ↓
  Position monitoring (PnL, exit signals, BE after TP1, scalping mode for high-liq pools)
    ├─► reserve-monitor: liquidity drain detection (solReserve <0.001 → close)
    ├─► price-stability: panic exit on >30% drop from peak
    └─► whale-sell: top-holder dump detection
  ↓
  Sell: Jito → directRPC → bloXroute → Jupiter (4-chain fallback + circuit-breaker)
  ↓
  Trend re-entry (PumpSwap + Raydium): if previous exit was profitable
                                        and trend resumes → re-enter
  ↓
  JSONL trade log + dossier UPSERT + metrics + Socket.IO emit
```

### Protocols Supported

- **Pump.fun**: Bonding curve buys with cashback upgrade support (Feb 2026)
- **PumpSwap**: AMM pool buys/sells with poolV2 PDA + cashback support
- **Mayhem Mode**: Alternative protocol with special fee recipients
- **Raydium LaunchLab**: Bonding curve protocol (graduation at 85 SOL → migration to AMM v4 or CPMM)
- **Raydium CPMM (CP-Swap)**: Constant product AMM, 4 fee tiers (25/100/200/400 bps), Token-2022 support
- **Raydium AMM v4**: Legacy constant product AMM, fixed 25 bps fee, instruction index-based (not Anchor)
- **Jupiter fallback**: Aggregator buy for unknown protocols (opt-in); sell as last-resort fallback for all protocols

### Protocol Details

#### Pump.fun (Bonding Curve)

- **Program**: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
- **Instruction**: `buy_exact_sol_in` (disc: `38fc74089edfcd5f`)
  - Old `buy` (exact-out) is deprecated → error 6024
  - Args: `sol_amount` (u64), `min_tokens_out` (u64)
- **Account layout**: 17 accounts (indices 0–16)
  - [9] `creatorVault` — PDA: `['creator-vault', creator]`
  - [12] `globalVolumeAccumulator` (read-only)
  - [13] `userVolumeAccumulator` (writable)
  - [14] `feeConfig` — PDA under fee program
  - [15] `feeProgram`: `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`
  - [16] `bondingCurveV2` — PDA: `['bonding-curve-v2', mint]` (added Feb 2026)
- **Cashback**: byte[82] of bonding curve = `cashback_enabled`
- **BondingCurve layout**: 151 bytes after cashback upgrade
  - virtual_token_reserves: u64 @ 8
  - virtual_sol_reserves: u64 @ 16
  - real_token_reserves: u64 @ 24
  - real_sol_reserves: u64 @ 32
  - complete: bool @ 48
  - creator: Pubkey @ 49
  - is_mayhem_mode: bool @ 81
  - cashback_enabled: bool @ 82

#### PumpSwap (AMM)

- **Program**: `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`
- **Fee Program**: `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`
- **Buy instruction**: disc `66063d1201daebea`
  - Args: `base_amount_out` (u64), `max_quote_amount_in` (u64), `track_volume` (OptionBool)
  - Data: 25 bytes (8 disc + 8 + 8 + 1 track_volume)
  - 23 fixed accounts + remainingAccounts
- **Sell instruction**: disc `33e685a4...`
  - Args: `base_amount_in` (u64), `min_quote_amount_out` (u64)
  - Data: 24 bytes
  - 21 fixed accounts + remainingAccounts
- **Pool PDA**: seeds `['pool', u16_le(0), pumpAuthority, baseMint, wSOL]`
  - pumpAuthority = PDA `['pool-authority', baseMint]` under pump.fun program
- **poolV2 PDA**: seeds `['pool-v2', baseMint]` — REQUIRED as remaining account
- **Pool account layout**: 301 bytes
  - baseMint: Pubkey @ 43 (meme token)
  - quoteMint: Pubkey @ 75 (wSOL)
  - poolBaseTokenAccount: Pubkey @ 139
  - poolQuoteTokenAccount: Pubkey @ 171
  - coinCreator: Pubkey @ 211
  - is_mayhem_mode: bool @ 243
  - is_cashback_coin: OptionBool @ 244
- **Remaining accounts by cashback status**:
  - Non-cashback buy: `[poolV2]`
  - Cashback buy: `[userVolumeAccWsolAta (writable), poolV2]`
  - Non-cashback sell: `[poolV2]`
  - Cashback sell: `[userVolAccQuoteAta (writable), userVolAcc (writable), poolV2]`
- **Fee ATAs**: MUST use `poolState.quoteMint` (not hardcoded wSOL) for:
  - `protocolFeeRecipientTokenAccount` = ATA(feeRecipient, quoteMint)
  - `coinCreatorVaultAta` = ATA(vaultAuthority, quoteMint)
- **OptionBool**: Borsh struct with single bool field = 1 byte (0=false, 1=true)
- **Fees**: Dynamic from feeConfig (not hardcoded). Actual ~125 bps for most pools.
- **Alternative instruction**: `buy_exact_quote_in` (disc `c62e1552b4d9e870`) — specifies SOL input instead of token output

#### Raydium LaunchLab (Bonding Curve)

- **Program**: `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`
- **Buy instruction**: `BuyExactIn` disc `[250,234,13,123,213,156,19,236]`
  - Args: `amountB` (u64, SOL), `minAmountA` (u64, min tokens), `shareFeeRate` (u64, 0)
  - 18 accounts
- **Sell instruction**: `SellExactIn` disc `[149,39,222,155,211,124,152,26]`
  - Args: `amountA` (u64, tokens), `minAmountB` (u64, min SOL), `shareFeeRate` (u64, 0)
  - 18 accounts
- **Pool layout**: virtualA/virtualB (token/SOL reserves), realA/realB, status (0=active, ≥250=migrated)
- **Graduation**: At ~85 SOL → migrates to AMM v4 or CPMM based on `migrateType` (0=AMM v4, 1=CPMM)
- **Auto-routing**: `PoolMigratedError` thrown on graduated pools → sniper re-routes buy to target AMM automatically

#### Raydium CPMM (CP-Swap)

- **Program**: `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`
- **Swap instruction**: `SwapBaseIn` disc `[143,190,90,218,196,30,51,222]`
  - Args: `amountIn` (u64), `minAmountOut` (u64)
  - 13 accounts
- **Pool layout**: configId, vaultA/vaultB, mintA/mintB, decimals, observationId
- **Fee tiers**: 25, 100, 200, 400 bps (from configId)
- **Token-2022 support**: Yes

#### Raydium AMM v4 (Legacy)

- **Program**: `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`
- **Swap instruction**: `SwapBaseInV2` data[0] = 16 (без OpenBook accounts)
  - Args (after index byte): `amountIn` (u64), `minAmountOut` (u64)
  - 8 accounts, hardcoded authority `5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1`
- **Create pool detection**: data[0] = 1
- **Pool layout**: baseVault/quoteVault, baseMint/quoteMint, tradeFeeNum/tradeFeeDen, openOrders, marketId
- **Fee**: On-chain (typically 25 bps, read from tradeFeeNum/tradeFeeDen)

### Position Lifecycle

1. Token detected via gRPC stream
2. Scoring/safety/social checks applied (parallel rugcheck + social)
3. Buy executed as Jito bundle (pending → confirmed); unknown protocol → Jupiter fallback
4. Position monitored for exit signals (stop-loss, break-even after TP1, trailing stop, runner tail, take-profit tiers, time-based, velocity drop)
5. Sell via 4-chain fallback with circuit-breaker; partial sells persist immediately
6. Trade logged to JSONL + metrics histogram

### Key Subsystems

- **GeyserClient** (`geyser/client.ts`): gRPC streaming with dual-queue (priority for CREATE events), backpressure, 64MB message limit
- **Jito** (`jito/bundle.ts`): Dynamic tip from getTipFloor (1.5s cache TTL), burst with unique signatures via burstIndex, tip escalation 1.5x/retry, urgent uses maxTip immediately
- **WalletTracker** (`core/wallet-tracker.ts`): 2-tier system. **T1 active**: WR≥65%, ≥20 completed trades, 0.03 SOL entry, max 1 position. **T2 disabled** (entry=0).
- **TokenScorer** (`utils/token-scorer.ts`): v4 rule-based 0–100 with entry multiplier (≥80=1.5x, ≥60=1.0x, ≥minScore=0.5x); penalties for ZERO_SIGNALS, BOTH_AUTH, tiny metadata
- **TrendTracker** (`core/trend-tracker.ts`): EventEmitter aggregating buy/sell + social per mint into TrendMetrics (volume, ratio, acceleration). Emits `trend:confirmed/strengthening/weakening`. Drives Mode B entry.
- **PreLaunchWatcher** (`core/prelaunch-watcher.ts`): Mode C — pending mint/ticker/creator candidates with 24h TTL; CREATE match forces score floor; auto-alpha from social pipeline (DexScreener boost + cross-source mentions + large channels)
- **ShadowEngine** (`shadow/engine.ts`): Parallel sim with 3 profiles, mirrors live pipeline; dynamic slippage by constant-product formula; SCALP badge in UI
- **Maintenance** (`maintenance/cleanup.ts` + `disk-monitor.ts`): Hourly TTL eviction + WR/ROI report; disk alerts at 10/8/6/4/3/2/1 GB
- **Dossier** (`db/dossier.ts`): Single-table per-mint history (seen → protocol → scoring → trade → close); replaces solscan
- **SellEngine** (`core/sell-engine.ts`): Unified sell across pump.fun/pumpswap/raydium, 4-chain fallback (Jito→directRPC→bloXroute→Jupiter), circuit-breaker after 2 identical errors, wSOL auto-unwrap, Jupiter rescue at 50% slippage
- **Detector** (`core/detector.ts`): On-chain protocol detection; permanent cache for terminal states, 1s TTL for pump.fun (was 5s)
- **Migration** (`core/migration.ts`): Bonding curve → PumpSwap detection; validates pool data ≥301 bytes
- **Raydium Auto-Routing**: LaunchLab buy catches `PoolMigratedError` → auto-routes to CPMM (migrateType=1) or AMM v4 (migrateType=0)
- **Anti-Rebuy**: `pendingBuys` + `confirmedPositions` Sets (replaced `seenMints` since 1c0bd16 — `seenMints` was blocking 100% of TREND_CONFIRMED entries)
- **Double-Buy Guard**: `confirmedPositions` checked in `recoverLandedPosition()` and PumpSwap Landed path (since dd906c3) — prevents burst-TX duplicates
- **JitoRateLimiter** (`infra/jito-rate-limiter.ts`): Token bucket 10 RPS
- **Backup RPC** (`infra/rpc.ts`): Auto-failover to `BACKUP_RPC_URL` on 429/timeout (30s cooldown)

## Configuration

All trading parameters in `src/config.ts` (~775 lines). Highlights of current production config (April 2026, post-shadow-tuning on 1001 trades):

**Position limits (14 total):**
- maxPumpFunPositions: 1 (risky bonding curve, only announced tokens)
- maxPumpSwapPositions: 5 (best +EV protocol)
- maxRaydiumLaunchPositions: 1
- maxRaydiumCpmmPositions: 3 (scalp и обычные позиции делят слоты)
- maxRaydiumAmmV4Positions: 3 (scalp и обычные позиции делят слоты)
- copyTrade.maxPositions: 1 (T1 only, 1 reservedT1Slot)
- maxTotalExposureSol: 2.0 (was 3.5; conservative)

**Per-protocol entry amounts (shadow-data-driven):**
- Pump.fun: 0.05 SOL (was 0.08; shadow 3% WR, mostly stagnation)
- PumpSwap: 0.12 SOL (best +EV, aggressive)
- Raydium CPMM: 0.08 SOL (14.3% shadow WR)
- Raydium AMM v4: 0.06 SOL
- Raydium LaunchLab: 0.04 SOL (lottery ticket; shadow 0% WR)
- Copy-trade T1: 0.03 SOL (re-enabled with stricter filters)
- Scalping mode: 0.12 SOL (high stake on established pools)
- Jupiter fallback: 0.05 SOL (DISABLED by default)

**Take-profit ladders (per-protocol; portions = % of CURRENT amount):**
- Pump.fun: 12%/30, 60%/20, 200%/10, 500%/5 (35% runner)
- PumpSwap: 18%/25, 80%/15, 180%/10, 400%/5, **1000%/100 (TP5 full exit)** — Combat mode
- Raydium CPMM/LaunchLab: 20%/25, 70%/20, 200%/10, 500%/5 (40% runner)
- Raydium AMM v4: 15%/30, 60%/20, 200%/10, 500%/5 (35% runner)
- Scalping: 5%/50, 15%/100 (TP2 full exit; partial sells unprofitable on overhead)

**Exit guards:**
- Break-even stop after TP1 (only after partial confirms; `pendingTpLevels` race guard)
- Stop-loss: 8% pump.fun / 15% PumpSwap / 12-15% Raydium / 5% scalp
- Trailing: 7-10% normal, 22-30% in runner mode (after 60-100% PnL)
- Velocity drop: 18-22% over 1.5-3s window (filters single-tick noise)
- Time-stop: 75s pump.fun / 360s PumpSwap / 180-300s Raydium / 300s scalp
- Stagnation: protocol-specific (45-180s window, 0.05-0.10 minMove)
- Liquidity drain: solReserve <0.001 SOL → close as loss (since 7dcfb1b)
- Whale-sell: top-holder dump >50% → instant exit
- Suspicious reserve (PumpSwap): pool <10s + reserves >200 SOL → skip entry

**Jito MEV (combat tips, not shadow):**
- tipAmountSol: 0.0003, max 0.001, min 0.0002, 3 retries, 1.5x escalation
- urgentMaxTipImmediate: true (dump signals skip ramp)
- Burst count: 2 (with multipliers [1.0, 1.3])
- Compute budget: 200k CU limit, 50k μlamports/CU; PumpSwap uses 300k

**Trend (Mode B) thresholds:**
- eliteScoreThreshold: 25 (Mode A immediate)
- trackingScoreThreshold: 15
- minUniqueBuyers: 4, minBuySellRatio: 2.0
- Per-protocol minVolume: pump.fun 1.0 / PumpSwap 3.0 / CPMM 4.0 / AMM v4 5.0 / LaunchLab 2.0 SOL
- Windows: pump.fun 60s, PumpSwap 120s, Raydium 300s
- Auto-alpha: DexScreener boost OR ≥2 cross-source mentions in 10min OR large-channel positive (>5000 followers)

**Trend re-entry (Mode B continuation):**
- Enabled for `pumpswap`, `raydium-launch`, `raydium-cpmm`, `raydium-ammv4`
- maxReEntries: 3, cooldownMs: 20_000, entryMultiplier: 0.5
- Requires previous TP-profit exit (`requiresTpProfit: true`)

**Defensive / kill-switches:**
- consecutiveLossesMax: 5 → pause 15 min
- defensive.entryThreshold WR<50% → minScore+8, entry×0.50
- adaptiveScoring window 20: minScore bump per 5pp under target (max +15)
- minBalanceToTradeSol: 0 (disabled — was blocking at 0.37 SOL)

**Filter gates (all enabled by default):**
poolAgeGate, suspiciousReserve, token2022Check, curveProgress (2-85%), metadataQuality, adaptiveEntryTiming (per-protocol minAge), buyAcceleration, dexBoostCheck (+15 score), bundledBuyDetection (-20 score), priceStability, reserveImbalance, creatorWalletAge (<1h penalty), creatorBalanceCheck (<0.5 SOL: -15)

**Inactive (disabled but configured):**
- Mayhem mode (`mayhem.enabled: false`) — EV simulation showed -0.003 SOL/trade
- Jupiter fallback buy (`jupiterFallback.enabled: false`) — buys unknown protocols, lossy
- Twitter parser (gated on `RAPIDAPI_KEY`) — disabled (unstable)
- T2 copy-trade (`tier2EntryAmountSol: 0`) — kept for future re-enable

**Environment variables (key optional):**
- `BACKUP_RPC_URL` — fallback RPC (auto-switches on 429/timeout, 30s cooldown)
- `JWT_SECRET` + `WEB_PASSWORD_HASH` — Web UI auth
- `RAPIDAPI_KEY` — Twitter social parser
- `BLOXROUTE_AUTH_HEADER` + `BLOXROUTE_TIP_WALLET` — sell fallback chain 3
- `METRICS_ENABLED` (default `true`), `METRICS_PORT` (9469)
- `TG_ALPHA_CHANNELS`, `ALPHA_TICKERS/MINTS/AUTHORS` — social watchlist
- `SIMULATE=true` — dry-run (TXs not sent)

## Code Conventions

- **Naming**: camelCase for variables/functions, PascalCase for classes/types/interfaces
- **Modules**: CommonJS (`require`/`module.exports` style, but uses TS `import`/`export`)
- **No linter or formatter configured** — follow existing style
- **Logging**: Use the Pino logger from `utils/logger.ts`, not `console.log`
- **Error handling**: Use `utils/retry.ts` for retryable operations with exponential backoff
- **RPC calls**: Use `infra/rpc.ts` singleton; rate-limit via `utils/rpc-limiter.ts`
- **Concurrency**: Use `p-limit` for bounded parallel operations (e.g., Jito queue at 20)
- **Graceful shutdown**: SIGINT/SIGTERM handlers close all positions in parallel with 60s timeout

## Implemented Safety & Resilience (April 2026, post-shadow + 3-phase review)

### Transaction Safety
- Jupiter TX validation: account keys checked (payer, inputMint, outputMint) before signing — prevents wallet drain via malicious API response
- `sellingMutex` protects all 6+ sell call paths from double-execution
- ATA balance pre-check before every sell — catches already-sold / never-landed positions
- wSOL auto-unwrap: `createCloseAccountInstruction` added to all 4 sell paths (PumpSwap, LaunchLab, CPMM, AMM v4) — SOL returns to wallet instead of staying locked in wSOL ATA

### Sell Resilience
- 4-chain sell fallback: Jito → directRPC → bloXroute → Jupiter
- Circuit-breaker: 2 identical sell errors → skip remaining retries, jump to Jupiter
- ATA balance re-read between sell retries (catches partial sells)
- Rescue attempt: if all 4 chains fail, final Jupiter sell at 50% slippage

### Position Integrity
- Break-even stop after TP1: `pendingTpLevels` protects against race condition during in-flight TP sell
- Immediate `savePositions()` after every `reduceAmount()` — crash between partial sell and save no longer loses state
- Migration detection validates pool data ≥301 bytes — prevents routing to uninitialized PumpSwap pool
- **Anti-rebuy fix (1c0bd16)**: replaced `seenMints` (was blocking 100% TREND_CONFIRMED entries) with `pendingBuys` + `confirmedPositions` — only real purchases mark mint as taken
- **Double-buy guard (dd906c3)**: burst TXs can both land despite Jito Invalid; `confirmedPositions` Set in `recoverLandedPosition()` and PumpSwap Landed path prevents duplicate positions
- **Bundle_invalid recovery (9bb6518)**: `checkTxLandedOnChain()` 5x retry with `getSignatureStatuses` + ATA balance fallback; `recoverLandedPosition()` unified for pump.fun/PumpSwap
- **Raydium recovery (7dcfb1b)**: RECOVERY path sets trendTokenData (else `onTrendConfirmed` would skip)
- **Liquidity drain detection (7dcfb1b)**: solReserve <0.001 SOL after 5s → close as loss
- **Suspicious reserve filter (b602aa8)**: PumpSwap pool <10s with >200 SOL reserves → skip entry (honeypot/rug indicator)
- **Token-2022 dangerous extensions**: blocks TransferFee, PermanentDelegate, TransferHook, ConfidentialTransfer, DefaultAccountState
- **TP5 verify.ts (821e9fe)**: portion=1.0 (full exit) handled correctly — partial portions checked separately, full exits excluded from sum check

### Raydium Migration Handling
- `PoolMigratedError` thrown when LaunchLab pool status ≥ 250 (graduated)
- Sniper catches error and auto-routes to CPMM (migrateType=1) or AMM v4 (migrateType=0)
- Position created with correct protocol tag for proper sell routing

### Infrastructure
- Backup RPC (`BACKUP_RPC_URL`): auto-failover on 429/timeout, 30s cooldown before returning to primary
- Graceful shutdown 60s (was 30s): parallel position close with directRPC
- Sentinel silence alert: if no events for 5+ min, logs `SENTINEL_SILENCE` and increments counter
- gRPC message limit: 64MB (up from default 4MB) — prevents RESOURCE_EXHAUSTED on large account snapshots
- Compute budget optimized: 200k CU / 50k microLamports (~62% fee reduction vs previous 260k/100k)

### Observability
- Metrics: counters + gauges + histograms (p50/p95/p99) — `buy_confirm_ms`, `sell_confirm_ms`
- Gauges: `positions_open`, `selling_mints` (updated every 60s)
- Trade logger: `sellPath` field in `TradeClosePayload` (jito/direct/direct+bx/jupiter/rescue/none)
- Trade logger: `tokenScore` (0–100) and `isCopyTrade` (bool) fields — real values from position/context
- `SELL_CIRCUIT_BREAK` event when circuit-breaker triggers

## Phase 3 — Social Signals Module (April 2026)

Pluggable social-signals pipeline; independent of the trading hot path
(failures in parsers do NOT affect sniping). Raw signals accumulate in
SQLite for post-trade correlation analysis via `analyze-trades.ts`.

### Components

- **SocialSignal** — unified DTO (`source`, `mint?`, `ticker?`, `sentiment`, `rawText`, `author?`, `followers?`, `url?`, `timestamp`, `alpha?`).
- **SocialManager** (`src/social/manager.ts`) — registers parsers, polls each on its own interval, dedupes via LRU (5000 keys), persists and re-emits. Per-source error isolation. Emits `'signal'` and (for whitelist hits) `'alpha'`.
- **Parsers**:
  - **DexScreener** (`dexscreener.ts`) — boosts API, free, 60s poll
  - **Telegram** (`telegram.ts`) — **public-channel HTML scraper** via `t.me/s/{slug}` (no API keys). Channels from `TG_ALPHA_CHANNELS` env (CSV of slugs / URLs / @usernames) or `DEFAULT_CHANNELS` constant. 30s poll. Private (invite-only) channels are skipped automatically.
  - **Twitter** (`twitter.ts`) — RapidAPI-based search (provider `twitter-api45.p.rapidapi.com`, free tier ~500 req/мес, 60 req/min). Flat JSON from `/search.php` (params: `query`, `search_type`). Also supports timeline of alpha screennames via `/timeline.php` (`TWITTER_ALPHA_SCREENNAMES` env). 3h poll default. Tolerant field parsing (`text`, `author.screen_name` / `user_info.screen_name`, `followers_count`, `tweet_id`). Conditional on `RAPIDAPI_KEY`.
- **Watchlist** (`src/social/watchlist.ts`) — `ALPHA_TICKERS` / `ALPHA_MINTS` / `ALPHA_AUTHORS` env. Matching signals get `alpha=true`.
- **Storage** — `social_signals` table (cols: source, mint, ticker, sentiment, raw_text, author, followers, url, timestamp, created_at, alpha). Auto-pruned to 7-day TTL.

### Surfaces

- **REST**:
  - `GET /api/social/feed?limit=N&alpha=1` — recent signals (alpha filter optional)
  - `GET /api/social/mentions?window=ms&limit=N` — aggregated mention counts
  - `GET /api/social/status` — per-parser diagnostics (last run, last yield, last error)
- **Socket.IO**: `social:signal` (all) + `social:alpha` (whitelist hits only)
- **Web UI**: `/social` page — Live Feed with ★ alpha highlighting, Top Mentions, Source status chips
- **CLI**: `scripts/analyze-trades.ts` reports 📡 post-factum correlation + 📅 pre-buy anticipation using `social_signals`

### Activation Prerequisites (see RUNBOOK.md)

DexScreener and Telegram (public-channel scraper) work out of the box without any keys. Optional activation:
- **Twitter**: RapidAPI key into RAPIDAPI_KEY
- **Alpha**: populate ALPHA_TICKERS / ALPHA_MINTS / ALPHA_AUTHORS
- **TG channel override**: set `TG_ALPHA_CHANNELS` to override `DEFAULT_CHANNELS` in `src/social/parsers/telegram.ts`

## Trend / PreLaunch / Shadow / Maintenance Subsystems (April 2026)

### TrendTracker (Mode B)

`src/core/trend-tracker.ts` — EventEmitter aggregating gRPC buy/sell events + social signals into per-mint TrendMetrics. Drives **Mode B entry** (`onTrendConfirmed`) for tokens that did not pass the elite-score immediate-buy gate.

Metrics computed per mint over rolling window (60-300s by protocol):
- `uniqueBuyers`, `buyVolumeSol`, `sellVolumeSol`, `buySellRatio`
- `acceleration` (buys/sec change-over-change)
- `socialMentions` (cross-source dedup count)

Confirms when ALL of: `uniqueBuyers ≥ minUniqueBuyers (4)`, `buyVolumeSol ≥ protocol-specific threshold`, `buySellRatio ≥ 2.0`, `buyAccelerationGate` (rate increasing). Emits `trend:confirmed` → Sniper.handleTrendConfirmed → buy. Also emits `trend:strengthening` (add-on signal) and `trend:weakening` (`weakenSellRatio: 1.5`, `weakenWindowMs: 20s` → exit signal).

Auto-cleanup: `inactiveCleanupMs: 300_000` removes silent mints.

### PreLaunchWatcher (Mode C)

`src/core/prelaunch-watcher.ts` + `data/prelaunch.json` — list of awaited tokens (mint/ticker/creator). On CREATE event, match → forced score floor (bypasses minTokenScore). 24h TTL with periodic cleanup.

**Auto-alpha population** from social pipeline (3 disjunctive criteria, configurable in `trend.autoAlpha`):
1. DexScreener boost → automatic alpha
2. Cross-source: `≥minMentions (2)` distinct sources mentioning same mint within `lookbackMs (10min)`
3. Large channel: `≥minFollowers (5000)` + sentiment ≥ `positiveSentimentMin (0.2)`

Auto-alpha entries get shorter TTL (1h vs 24h for manual). Surface: `/api/prelaunch` REST + `/prelaunch` Web UI page + `scripts/prelaunch.ts` CLI.

### Shadow Engine (Backtester)

`src/shadow/` — parallel simulation that mirrors live entry pipeline. Three profiles (conservative/balanced/aggressive) with own startBalance/entry/maxPositions. Used to calibrate per-protocol entry amounts and exit parameters.

Components:
- `engine.ts` — ShadowEngine: portfolio state, monitors mints, runs entry pipeline, manages positions, emits `TradeLogEntry` (with `isScalp` flag → cyan SCALP badge in UI)
- `pipeline.ts` — full entry decision: limits → rugcheck/safety/social parallel → skip gate → scoring (informational only — does not actually buy)
- `profiles.ts` — `PROFILES` constants
- `tx-builder.ts` — unified buy/sell tx for all 5 protocols + `simulateTx()`. **Dynamic slippage** by constant-product formula (since 972b23e): for 0.1 SOL into 50 SOL pool ≈60 bps vs previous fixed 1000 bps

Surface: `npm run shadow` + `/api/shadow/{status,trades,report,stop}` + `/shadow` Web UI.

### Maintenance Workers

`src/maintenance/` — autonomous background tasks started from `index.ts`:
- **cleanup.ts** (1h interval): TTL eviction of stale events/token_metadata/logs; generates `CleanupReport` (WR, ROI, recommendations) saved to `analysis_reports` table; sends Telegram summary
- **disk-monitor.ts** (5min interval): alerts when free disk space drops below 10/8/6/4/3/2/1 GB; each threshold fires once until recovery; Telegram notify

### Production Dashboard (Web UI /)

Backend (`src/core/sniper.ts` + `src/web/ws/events.ts`):
- `trackSkip()` aggregates skip-reason counters
- Getters: `getEventCounts()`, `getExposure()`, `getStartBalance()`
- WebSocket emit every 5s + on snapshot

Frontend:
- `EventCountsBar` (detected/entered/exited/skipped + hit-rate)
- `StatsCards` (Balance, Positions, WinRate, PnL, per-protocol breakdown)
- Skip-reasons bar chart with %
- `RecentTradesTable` (30 rows)
- **Push Logs to Git** button (POST /api/logs/push-to-git, 49MB chunks, mutex-protected)

## Future Development Proposals

Two proposal documents exist in repo root:
- **"Внедрение ИИ в проект.docx"** — ML/AI integration roadmap (dynamic scoring, predictive exits, regime detection, copy-trade 2.0). NOT IMPLEMENTED.
- **"Реализация скальпинга на DEX.docx"** — DEX scalping module proposal. **PARTIALLY IMPLEMENTED** as `scalping` config section (CPMM/AMM v4 high-liquidity pools, see commits `a9b49e2`, `3fc8d25`, `f5cb84e`).

## TX Diagnostic Logging (April 2026)

Every buy/sell across all 6 protocols emits `TX_DIAGNOSTIC` event to SQLite `events` table with full construction data:
- **Account addresses**: pool, vaults, authority PDA, fee recipient + ATA, user ATA
- **Discriminators**: which instruction discriminator was used
- **PDA/ATA derivation results**: derived addresses for audit
- **Pool reserves**: tokenReserve, solReserve at entry time
- **Token program IDs**: TOKEN_PROGRAM_ID vs TOKEN_2022 for each mint
- **Calculation inputs**: expectedOut, minOut, slippage, fees
- **Flags**: isCashbackCoin, isWsolBase, isMayhem, directRpc

Files with TX_DIAGNOSTIC: `buy.ts`, `sell.ts`, `pumpSwap.ts`, `raydiumCpmm.ts`, `raydiumAmmV4.ts`, `raydiumLaunchLab.ts`

Query: `SELECT data FROM events WHERE type='TX_DIAGNOSTIC' AND mint=? ORDER BY ts DESC`

## Senior++ Audit Results (April 2026)

### Verified Correct
- All 7 discriminators match sha256/index values (pump.fun, PumpSwap, CPMM, AMM v4, LaunchLab)
- All PDA seeds (25+) match IDL documentation across all protocols
- All account ordering in buy/sell instructions matches IDL
- ATA derivations use correct tokenProgramId (Token-2022 for CPMM, TOKEN_PROGRAM_ID for AMM v4)
- Pool parsers use correct offsets (verified against raydium-sdk-V2)
- Fee recipient handling reads from Global account (not feeConfig)
- Sell engine routing correctly identifies all 6 protocol paths

### Fixed Bugs (commit 408403a)
- **CRITICAL**: `scripts/verify.ts` used PDA seed `'bonding_curve'` (underscore) instead of `'bonding-curve'` (hyphen) — BondingCurve verification never ran
- Removed dead `getAmmAuthority()` function from `raydiumAmmV4.ts`

### Known Gaps
- `verify.ts` does NOT verify Raydium pool layouts (CPMM, AMM v4, LaunchLab) — only pump.fun/PumpSwap
- Raydium CPMM/AMM v4 do NOT run pre-send simulation (PumpSwap does)

## Raydium Position Creation (April 2026)

Raydium positions use confirm-before-position pattern via `confirmAndCreateRaydiumPosition()`:
- Polls TX status up to 15 attempts (30s)
- Reads ATA balance after confirmation to get real token count
- Creates Position with correct `entryPrice = entryAmountSol / tokenAmount` (NOT raw SOL amount)
- Tracks pending buys via `pendingRaydiumBuys: Set<string>`
- Mirrors pattern from PumpSwap's `createOptimisticPumpSwapPosition` / `confirmAndUpdatePumpSwapPosition`

**Previous bug (fixed in 4319f15)**: Position was created with `entryPrice = entryAmountSol` and `amount = 0` → instant -100% PnL → failed sell.

## VPS Operations

### Project path: `/home/deploy/solana-sniper-v2`
### User: `deploy`

### Rebuild & restart
```bash
cd ~/solana-sniper-v2
npm run stop 2>/dev/null
git stash
git pull origin main
git stash pop
npm run build
npm start
```

### Log export for analysis
```bash
cd ~/solana-sniper-v2
mkdir -p logs-export
cp logs/bot-$(date +%F).log logs/events-$(date +%F).log data/sniper.db logs-export/
cp logs/trades.1.jsonl logs-export/ 2>/dev/null
git add -f logs-export/
git commit -m "chore: export logs for analysis"
git push
```

### Useful commands
```bash
cd ~/solana-sniper-v2
tail -f logs/sniper.log | npx pino-pretty                # Live logs
sqlite3 data/sniper.db "SELECT type, COUNT(*) FROM events GROUP BY type ORDER BY COUNT(*) DESC LIMIT 20;"
sqlite3 data/sniper.db "SELECT * FROM events WHERE type='TX_DIAGNOSTIC' ORDER BY ts DESC LIMIT 5;"
npm run stop                                              # Graceful stop
```

## Important Notes

- The `scripts/verify.ts` prestart hook must pass before production startup — validates on-chain layouts + config consistency (TP portion sums, position limits, exit params, slippage bounds)
- `data/positions.json` persists across restarts; do not delete while positions are open
- Jito tip amounts are critical for execution speed — current production tip is 0.0003 SOL (was 0.00005), max 0.001 — calibrated for >30% landing rate
- **Copy-trading**: T1 ENABLED (WR≥65%, ≥20 trades, 0.03 SOL); T2 DISABLED (entry=0)
- **Mayhem mode**: DISABLED (negative EV)
- **Twitter parser**: DISABLED (unstable)
- **Jupiter fallback buy**: DISABLED (lossy on unknown protocols); Jupiter still used as last-resort SELL chain
- Documentation exists in DOCX format (Russian) in repo root: see "Future Development Proposals" section
- Official PumpSwap SDK reference: `@pump-fun/pump-swap-sdk` v1.14.1 (npm)
- Telegram DEFAULT_CHANNELS (12 каналов): protocol-agnostic coverage of pump.fun, PumpSwap, Raydium, общий Solana alpha (see `src/social/parsers/telegram.ts`)
- Web UI auth: bcrypt + JWT in httpOnly cookie. Generate hash: `node -e 'require("bcrypt").hash(process.argv[1],10).then(console.log)' 'PASSWORD'`
