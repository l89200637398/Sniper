# CLAUDE.md — Solana Sniper Bot v3

## What This Is

A Solana MEV sniper bot targeting Pump.fun, PumpSwap, and (planned) Raydium token launches. It streams real-time events via Yellowstone Geyser gRPC, executes buys through Jito MEV-Share bundles, manages positions with rule-based exits, and provides a Telegram control interface.

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
├── test-pumpswap.ts         # PumpSwap simulation test script
└── autogen/
    └── runtime-layout.json  # Auto-generated on-chain layout snapshot

proto/                        # gRPC protocol buffer definitions
scripts/
├── analyze-trades.ts        # Post-trade analysis from JSONL logs
├── test-trade.ts            # Manual trade execution testing (auto-detects protocol)
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
- `scripts/test-trade.ts` — manual trade execution (auto-detects pump.fun vs PumpSwap)
- `src/test-pumpswap.ts` — PumpSwap-specific simulation test
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

- **Pump.fun**: Bonding curve buys with cashback upgrade support (Feb 2026)
- **PumpSwap**: AMM pool buys/sells with poolV2 PDA + cashback support
- **Mayhem Mode**: Alternative protocol with special fee recipients

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
- **Detector** (`core/detector.ts`): On-chain protocol detection (pump.fun bonding curve vs PumpSwap AMM)

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

## Known Issues & Fixes (March 2026)

### PumpSwap Overflow 6023 — FIXED
- **Root cause**: Missing `poolV2` PDA as remaining account in buy/sell instructions
- **Fix**: Added `getPoolV2PDA(baseMint)` with seeds `['pool-v2', baseMint]`, included as remaining account
- **Also**: Added `track_volume: OptionBool = true` (byte 0x01) to buy instruction data

### PumpSwap ConstraintTokenMint 2014 — FIXED
- **Root cause**: Fee and creator vault ATAs were using hardcoded wSOL instead of pool's `quoteMint`
- **Fix**: Use `poolState.quoteMint` for both `protocolFeeRecipientTokenAccount` and `coinCreatorVaultAta`

### PumpSwap Cashback Support — ADDED
- Analogous to pump.fun's Feb 2026 cashback upgrade
- Pool byte[244] = `is_cashback_coin` (OptionBool)
- For cashback coins, additional remaining accounts needed before poolV2

## Important Notes

- The `scripts/verify.ts` prestart hook must pass before production startup — it validates on-chain account layouts match expectations
- `data/positions.json` persists across restarts; do not delete while positions are open
- Jito tip amounts are critical for execution speed — too low = missed trades, too high = wasted SOL
- The copy-trading system (`copyTrade.enabled`) is currently disabled in config
- Documentation exists in DOCX format (English + Russian) in the repo root
- Official PumpSwap SDK reference: `@pump-fun/pump-swap-sdk` v1.14.1 (npm)
