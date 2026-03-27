# CLAUDE.md — Solana Sniper Bot v2

## What This Is

A Solana MEV sniper bot targeting Pump.fun and PumpSwap token launches. It streams real-time events via Yellowstone Geyser gRPC, executes buys through Jito MEV-Share bundles, manages positions with rule-based exits, and provides a Telegram control interface.

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
├── index.ts                 # Entry point — initializes Sniper + TelegramBot
├── config.ts                # All config parameters (230+ lines)
├── constants.ts             # Solana program IDs, discriminators, layouts
├── runtime-layout.ts        # Dynamic on-chain layout caching
├── core/
│   ├── sniper.ts            # Main Sniper class — position management, entry/exit
│   ├── position.ts          # Position tracking (PnL, exit signals, take-profit)
│   ├── detector.ts          # Protocol detection (pump.fun vs PumpSwap)
│   ├── migration.ts         # Bonding curve → AMM migration detection
│   ├── state-cache.ts       # MintState cache
│   ├── wallet-tracker.ts    # Copy-trading wallet analysis
│   └── sell-engine.ts       # Unified sell logic across protocols
├── trading/
│   ├── buy.ts               # Pump.fun buy instruction builder
│   ├── sell.ts              # Pump.fun sell transaction
│   └── pumpSwap.ts          # PumpSwap AMM buy/sell (pool parsing, slippage)
├── geyser/
│   └── client.ts            # Yellowstone Geyser gRPC streaming client (EventEmitter)
├── jito/
│   └── bundle.ts            # Jito bundle sending, tip management, retry logic
├── infra/
│   ├── rpc.ts               # Solana RPC connection singleton
│   ├── jito-queue.ts        # Async queue for Jito submissions (p-limit)
│   ├── blockhash-cache.ts   # Auto-refreshing blockhash cache
│   └── priority-fee-cache.ts
├── bot/
│   └── bot.ts               # Telegram bot with command handlers
├── utils/
│   ├── logger.ts            # Pino logger (file + console)
│   ├── event-logger.ts      # Structured JSONL event logging
│   ├── trade-logger.ts      # JSONL trade event tracking
│   ├── token-scorer.ts      # Rule-based token scoring (0–100)
│   ├── social.ts            # Social signal detection (Twitter/Telegram)
│   ├── rugcheck.ts          # Rug check API integration
│   ├── safety.ts            # Token safety checks (mint/freeze authority)
│   ├── balance.ts           # Balance validation
│   ├── retry.ts             # Retry with exponential backoff
│   ├── rpc-limiter.ts       # RPC rate limiting decorator
│   └── sha.ts               # SHA256 utility
└── autogen/
    └── runtime-layout.json  # Auto-generated on-chain layout snapshot

proto/                        # gRPC protocol buffer definitions
scripts/
├── analyze-trades.ts        # Post-trade analysis from JSONL logs
├── test-trade.ts            # Manual trade execution testing
└── verify.ts                # On-chain layout verification (runs as prestart)
data/
├── positions.json           # Persisted active positions
└── wallet-tracker.json      # Copy-trading wallet data
```

## Commands

```bash
npm run dev       # Run with ts-node (development)
npm run build     # Compile TypeScript → dist/
npm start         # Run verify.ts prestart hook, then dist/index.js
```

There is no test runner (Jest/Vitest). Testing is done via:
- `scripts/verify.ts` — validates on-chain account layouts before startup
- `scripts/test-trade.ts` — manual trade execution
- `scripts/analyze-trades.ts` — post-trade log analysis

## Architecture

### Event Flow

```
Geyser gRPC stream → EventEmitter events
  → Token scoring + safety checks
  → Buy via Jito bundle
  → Position monitoring (PnL, exit signals)
  → Sell via Jito bundle
  → JSONL trade log
```

### Protocols Supported

- **Pump.fun**: Bonding curve buys with cashback upgrade support
- **PumpSwap**: AMM pool buys/sells with slippage handling
- **Mayhem Mode**: Alternative protocol with special fee recipients

### Position Lifecycle

1. Token detected via gRPC stream
2. Scoring/safety/social checks applied
3. Buy executed as Jito bundle (pending → confirmed)
4. Position monitored for exit signals (stop-loss, trailing stop, take-profit tiers, time-based, velocity drop)
5. Sell executed with auto-retry and increasing Jito tips
6. Trade logged to JSONL

### Key Subsystems

- **GeyserClient** (`geyser/client.ts`): gRPC streaming with event queue (max 10k), backpressure handling
- **Jito** (`jito/bundle.ts`): Dynamic tip calculation from tip floor percentiles, tip multiplier with 1.2x increase per retry
- **WalletTracker** (`core/wallet-tracker.ts`): Copy-trading system (tracks wallets with >65% win rate, min 20 trades)
- **TokenScorer** (`utils/token-scorer.ts`): 0–100 point scoring for token entry decisions
- **SellEngine** (`core/sell-engine.ts`): Unified sell across pump.fun/pumpswap/mayhem with retry logic

## Configuration

All trading parameters are in `src/config.ts`:
- Max positions: 3 (1 pump.fun, 1 pumpswap, 1 copy-trade)
- Entry amounts: 0.05 SOL default (per-protocol overrides)
- Take-profit: 4 tiered levels (8%, 20%, 50%, 150%)
- Jito tips: 0.000012 SOL base, 0.00005 max, 2 retries

Environment variables via `.env` (dotenv).

## Code Conventions

- **Naming**: camelCase for variables/functions, PascalCase for classes/types/interfaces
- **Modules**: CommonJS (`require`/`module.exports` style, but uses TS `import`/`export`)
- **No linter or formatter configured** — follow existing style
- **Logging**: Use the Pino logger from `utils/logger.ts`, not `console.log`
- **Error handling**: Use `utils/retry.ts` for retryable operations with exponential backoff
- **RPC calls**: Use `infra/rpc.ts` singleton; rate-limit via `utils/rpc-limiter.ts`
- **Concurrency**: Use `p-limit` for bounded parallel operations (e.g., Jito queue at 20)
- **Graceful shutdown**: SIGINT/SIGTERM handlers close all positions with 30s timeout

## Important Notes

- The `scripts/verify.ts` prestart hook must pass before production startup — it validates on-chain account layouts match expectations
- `data/positions.json` persists across restarts; do not delete while positions are open
- Jito tip amounts are critical for execution speed — too low = missed trades, too high = wasted SOL
- The copy-trading system (`copyTrade.enabled`) is currently disabled in config
- Documentation exists in DOCX format (English + Russian) in the repo root
