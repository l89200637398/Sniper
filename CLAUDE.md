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

A Solana MEV sniper bot targeting Pump.fun, PumpSwap, and Raydium (LaunchLab + CPMM + AMM v4) token launches. It streams real-time events via Yellowstone Geyser gRPC, executes buys through Jito MEV-Share bundles, manages positions with rule-based exits, and exposes three operator surfaces: a **read-only Telegram bot** (push notifications + 4-button status menu), a **CLI toolkit** under `scripts/`, and a **Web UI** (React + Vite) with Socket.IO.

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
│   ├── sniper.ts            # Main Sniper class (EventEmitter: position:open/close)
│   ├── position.ts          # Position tracking (PnL, exit signals, take-profit)
│   ├── detector.ts          # Protocol detection (pump.fun vs PumpSwap)
│   ├── migration.ts         # Bonding curve → AMM migration detection
│   ├── state-cache.ts       # MintState cache
│   ├── wallet-tracker.ts    # Copy-trading wallet analysis
│   └── sell-engine.ts       # Unified sell logic across protocols
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
│   ├── rugcheck.ts          # Rug check API integration
│   ├── safety.ts            # Token safety checks (mint/freeze authority)
│   ├── balance.ts           # Balance validation
│   ├── retry.ts             # Retry with exponential backoff
│   ├── rpc-limiter.ts       # RPC rate limiting decorator
│   └── sha.ts               # SHA256 utility
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
│   └── migrations/*.sql     # Idempotent schema migrations
├── web/                     # REST + Socket.IO backend for Web UI
│   ├── server.ts            # Express app + static web-ui/dist
│   ├── auth.ts              # JWT + bcrypt (STUB — gated on JWT_SECRET + WEB_PASSWORD_HASH)
│   ├── routes/              # REST endpoints
│   └── ws/                  # Socket.IO
├── test-pumpswap.ts         # PumpSwap simulation test script (ops tool)
├── test-raydium.ts          # Raydium simulation test script (ops tool)
└── autogen/
    └── runtime-layout.json  # Auto-generated on-chain layout snapshot

proto/                        # gRPC protocol buffer definitions
scripts/
├── verify.ts                # On-chain layout validation (prestart hook)
├── stop.ts                  # Graceful SIGTERM via .sniper.pid
├── control.ts               # Foreground launcher (no Telegram, no Web UI)
├── blacklist.ts             # Blacklist CLI (add/remove/list/stats/clear)
├── cleanup-dust.ts          # Close empty ATAs, reclaim rent
├── analyze-trades.ts        # Post-trade JSONL analysis (+ social correlation)
├── recommend-config.ts      # Stage 3: config.ts advice (cron-friendly)
├── test-trade.ts            # Manual trade execution (auto-detects protocol)
└── shadow-run.ts            # Shadow-mode replay (dev)
data/
├── positions.json           # Persisted active positions
├── blacklist.json           # Blacklist (tokens + creators); hot-reloaded via mtime poll
├── wallet-tracker.json      # Copy-trading wallet data
└── sniper.db                # SQLite (social_signals, etc.)
web-ui/                       # Frontend (React + Vite) — served from web-ui/dist
```

## Commands

```bash
npm run dev       # Run with ts-node (development)
npm run build     # Compile TypeScript → dist/
npm start         # Run verify.ts prestart hook, then dist/index.js
```

There is no test runner (Jest/Vitest). Testing is done via:
- `scripts/verify.ts` — validates on-chain account layouts before startup
- `scripts/test-trade.ts` — manual trade execution (auto-detects pump.fun vs PumpSwap)
- `src/test-pumpswap.ts` — PumpSwap-specific simulation test
- `src/test-raydium.ts` — Raydium-specific simulation test
- `scripts/analyze-trades.ts` — post-trade log analysis
- `scripts/recommend-config.ts` — heuristic advice on config.ts

Operator-facing CLI (see `PROJECT.md §3` / `RUNBOOK.md §A.5`):
- `npm start` / `npm run stop` — prod lifecycle via `.sniper.pid`
- `npm run blacklist -- <cmd>` — manage `data/blacklist.json` (hot-reloaded)
- `npm run cleanup-dust` — reclaim rent from empty ATAs
- `npx ts-node scripts/control.ts start` — foreground, no TG/Web UI

## Architecture

### Event Flow

```
Geyser gRPC stream → EventEmitter events
  → Token scoring + safety checks
  → Buy via Jito bundle (unknown protocol → Jupiter fallback)
  → Position monitoring (PnL, exit signals, break-even after TP1)
  → Sell: Jito → directRPC → bloXroute → Jupiter (4-chain fallback)
  → Circuit-breaker: 2 identical sell errors → skip to Jupiter
  → JSONL trade log + metrics (buy/sell latency histograms)
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

- **GeyserClient** (`geyser/client.ts`): gRPC streaming with dual-queue (priority for CREATE events), backpressure handling, 64MB message limit
- **Jito** (`jito/bundle.ts`): Dynamic tip calculation, burst with unique signatures via burstIndex, tip escalation 1.5x/retry
- **WalletTracker** (`core/wallet-tracker.ts`): 2-tier copy-trading (T1: WR≥60%/15 trades, T2: WR≥50%/8 trades)
- **TokenScorer** (`utils/token-scorer.ts`): v4 rule-based scoring (0–100) with entry multiplier (1.5x/1.0x/0.5x based on score); enhanced penalties for unverified tokens (ZERO_SIGNALS, BOTH_AUTH, tiny metadata)
- **SellEngine** (`core/sell-engine.ts`): Unified sell across pump.fun/pumpswap/raydium, 4-chain fallback (Jito→directRPC→bloXroute→Jupiter), circuit-breaker after 2 identical errors, wSOL auto-unwrap
- **Detector** (`core/detector.ts`): On-chain protocol detection with cache (permanent for terminal states, 5s TTL for pump.fun)
- **Migration** (`core/migration.ts`): Bonding curve → PumpSwap detection; validates pool data ≥301 bytes (skips mid-migration)
- **Raydium Auto-Routing**: LaunchLab buy catches `PoolMigratedError` and auto-routes to CPMM (migrateType=1) or AMM v4 (migrateType=0)
- **Anti-Rebuy**: `seenMints` Map with 1h TTL refreshed on every position close — prevents duplicate entries
- **JitoRateLimiter** (`infra/jito-rate-limiter.ts`): Token bucket rate limiter (10 RPS)
- **Backup RPC** (`infra/rpc.ts`): Auto-failover to `BACKUP_RPC_URL` on 429/timeout (30s cooldown)

## Configuration

All trading parameters are in `src/config.ts`:
- Max positions: 8 (3 pump.fun, 2 pumpswap, 2 raydium-launch, 2 raydium-cpmm, 2 raydium-ammv4, 3 copy-trade, 1 reserved T1 slot)
- Entry amounts: 0.10 SOL default (pump.fun/pumpswap), 0.08 SOL (Raydium LaunchLab/CPMM/AMM v4), 0.06/0.03 SOL (copy T1/T2), 0.05 SOL (Jupiter fallback)
- Take-profit: 4 tiered levels with 40% runner reserve (portions sum to 0.60)
- Break-even stop after TP1: once first partial sell confirms, stop-loss moves to entry price
- Jito tips: 0.00005 SOL base, 0.00015 max, 0.0001 min, 3 retries, 1.5x escalation, low-activity floor 0.00007
- Compute budget: 200k CU limit, 50k microLamports/CU (~0.010 SOL/TX vs prev. 0.026)
- Max total exposure: 1.5 SOL, min independent buy: 0.15 SOL
- Stop-loss: 12% (pump.fun) / 15% (pumpswap) / 20% (Raydium); trailing drawdown: 7% / 10% / 12-18%
- Early exit timeout: 5000ms (allows more time for momentum confirmation)
- Balance floor: disabled (minBalanceToTradeSol=0)
- Token scoring: minTokenScore=45, entry multiplier scales position size
- Defensive mode: auto-tighten filters when rolling WR < 50% (minTokenScore +4, entry x0.70); consecutiveLossesMax=0 (pause disabled)
- Loss pause: 15 min trigger configured but disabled by default to avoid cold-start blocking
- Jupiter fallback buy: disabled by default (`jupiterFallback.enabled: false`)

Environment variables via `.env` (dotenv). Key optional vars:
- `BACKUP_RPC_URL` — fallback RPC (auto-switches on 429/timeout)
- `JUPITER_API_KEY` — optional for Jupiter paid tier
- `RAPIDAPI_KEY` — enables Twitter social parser
- `METRICS_ENABLED` — enables HTTP /metrics endpoint

## Code Conventions

- **Naming**: camelCase for variables/functions, PascalCase for classes/types/interfaces
- **Modules**: CommonJS (`require`/`module.exports` style, but uses TS `import`/`export`)
- **No linter or formatter configured** — follow existing style
- **Logging**: Use the Pino logger from `utils/logger.ts`, not `console.log`
- **Error handling**: Use `utils/retry.ts` for retryable operations with exponential backoff
- **RPC calls**: Use `infra/rpc.ts` singleton; rate-limit via `utils/rpc-limiter.ts`
- **Concurrency**: Use `p-limit` for bounded parallel operations (e.g., Jito queue at 20)
- **Graceful shutdown**: SIGINT/SIGTERM handlers close all positions in parallel with 60s timeout

## Implemented Safety & Resilience (April 2026)

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
- Anti-rebuy: `seenMints` refreshed with `Date.now()` on every position close (8 locations) — 1h TTL prevents repeated entry

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

## Future Development Proposals

Two proposal documents exist in the repo root:
- **"Внедрение ИИ в проект.docx"** — ML/AI integration roadmap (dynamic scoring, predictive exits, regime detection, copy-trade 2.0)
- **"Реализация скальпинга на DEX.docx"** — DEX scalping module proposal (grid/momentum/RSI strategies, technical analysis, separate from sniper logic)

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

- The `scripts/verify.ts` prestart hook must pass before production startup — it validates on-chain account layouts match expectations
- `data/positions.json` persists across restarts; do not delete while positions are open
- Jito tip amounts are critical for execution speed — too low = missed trades, too high = wasted SOL
- Copy-trading is enabled by default (`copyTrade.enabled: true`) with 2-tier system
- Documentation exists in DOCX format (English + Russian) in the repo root
- Official PumpSwap SDK reference: `@pump-fun/pump-swap-sdk` v1.14.1 (npm)
- Twitter social parser: `twitter-api45.p.rapidapi.com` (free tier ~500 req/month, requires `RAPIDAPI_KEY`)
- Telegram DEFAULT_CHANNELS (12 каналов): protocol-agnostic coverage of pump.fun, PumpSwap, Raydium, общий Solana alpha
