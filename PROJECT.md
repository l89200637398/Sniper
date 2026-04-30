# Solana Sniper Bot v3 — Документация проекта

> Обновлено: 2026-04-29 (по состоянию на коммит `c894f31`).

## 1. Описание проекта

MEV-снайпер бот для Solana, нацеленный на автоматическую покупку токенов на ранних стадиях запуска через протоколы Pump.fun, PumpSwap, Raydium LaunchLab, Raydium CPMM и Raydium AMM v4.

**Что делает:**
- Отслеживает создание новых токенов и активность в пулах в реальном времени через Yellowstone Geyser gRPC
- Оценивает токены по 13+ фильтрам (scoring, safety, social signals, holder concentration, creator history, liquidity, etc.)
- Поддерживает **три режима входа**:
  - **Mode A** (elite snipe): мгновенный вход по высокому score (`eliteScoreThreshold = 25`)
  - **Mode B** (trend-confirmed): TrendTracker подтверждает тренд по объёму/покупателям/соц.сигналам, затем вход
  - **Mode C** (pre-launch): PreLaunchWatcher следит за списком ожидаемых токенов (manual + auto-alpha)
- Покупает через Jito MEV-Share bundles (burst из 2 TX с защитой от double-buy)
- Управляет позициями с правилами выхода: stop-loss, trailing, **break-even after TP1**, **runner tail**, **scalping mode** для высоколиквидных пулов, **TP5 +1000% (combat mode)**, liquidity drain detection, whale-sell detection
- Продаёт через 4-канальный fallback: Jito → directRPC → bloXroute → Jupiter
- Предоставляет три операторских поверхности: read-only Telegram-бот, CLI скрипты, Web UI с Dashboard

**Стек технологий:**
- TypeScript 5.9 (strict mode, ES2020, CommonJS), Node.js
- @solana/web3.js 1.98.4, @solana/spl-token 0.3.9
- gRPC через @grpc/grpc-js + Yellowstone Geyser (`@triton-one/yellowstone-grpc`)
- @jup-ag/api (Jupiter aggregator), @bloxroute/solana-trader-client-ts (опц.)
- Express 5 + Socket.IO 4 (Web UI backend)
- Telegraf 4.15.3 (Telegram), better-sqlite3 (локальная персистенция)
- Pino (structured JSON logging) + JSONL event/trade logs
- React + Vite (web-ui SPA)

---

## 2. Архитектура

### Поток данных

```
Geyser gRPC stream
    |
    v
GeyserClient (EventEmitter, dual-queue: priority for CREATE)
    |
    +---> [pump:create] / [pumpswap:create] / [raydium:*] / [pump:trade] / [pumpswap:trade]
    |
    v
   Sniper.handleCreate()  ──► Filter gates (~13 utils)
    |                          ├─ blacklist, suspiciousReserve, poolAgeGate
    |                          ├─ token2022, curveProgress, metadataQuality
    |                          ├─ holder-check, bundled-buy-detector
    |                          ├─ creator-history/age/balance, dex-boost
    |                          └─ rugcheck (parallel) + safety + social
    v
   Mode A: score ≥ eliteScoreThreshold (25) → buy immediately
   Mode B: TrendTracker accumulates buys/sells/social →
           emit('trend:confirmed') (≥4 buyers, ratio≥2.0, accel↑) → buy
   Mode C: PreLaunchWatcher match (mint/ticker/creator) → forced buy
    |
    v
   Buy (Jito burst 2 TX, double-buy guarded by confirmedPositions Set)
    |
    v
   Optimistic Position → confirm flow (getSignatureStatuses + ATA balance)
    |
    v
   Position monitoring (per-protocol exit + scalp branch for high-liq pools):
     stop-loss / hard-stop / velocity-drop / time-stop / stagnation
     trailing-stop / take-profit (4-5 levels) / break-even after TP1
     runner-tail (100-200%+ PnL widens trailing)
     liquidity-drain (solReserve <0.001 SOL → close)
     whale-sell, price-stability, reserve-imbalance
    |
    v
   Sell pipeline (4-chain fallback + circuit-breaker):
     Jito → directRPC → bloXroute → Jupiter
     → Rescue: if all fail, final Jupiter at 50% slippage
    |
    v
   Trade close → JSONL trade log + dossier UPSERT + metrics histogram
                 + Socket.IO emit (position:close)
                 + Optional trend re-entry (PumpSwap + Raydium, requires TP-profit)
```

### Основные компоненты

| Компонент | Файл | Назначение |
|-----------|------|------------|
| **Sniper** | `src/core/sniper.ts` (~7700 строк) | Главный класс — entry/exit логика, position management, recovery flows |
| **GeyserClient** | `src/geyser/client.ts` | gRPC стриминг, dual-queue, 64MB message limit |
| **JitoBundle** | `src/jito/bundle.ts` | Отправка bundles, dynamic tips (1.5s cache TTL), burst, escalation |
| **SellEngine** | `src/core/sell-engine.ts` | Унифицированная продажа через все 6 путей, 4-chain fallback |
| **Detector** | `src/core/detector.ts` | Определение протокола, permanent cache + 1s pump.fun TTL |
| **Migration** | `src/core/migration.ts` | Bonding curve → AMM detection, валидация ≥301 байт пула |
| **Position** | `src/core/position.ts` | Трекинг позиций, PnL, exit signals, `pendingTpLevels` race guard, isScalp флаг |
| **StateCache** | `src/core/state-cache.ts` | LRU cache MintState с cleanup |
| **TokenScorer** | `src/utils/token-scorer.ts` | Скоринг 0-100, entry multiplier (2.0/1.0/0.5x) |
| **WalletTracker** | `src/core/wallet-tracker.ts` | Copy-trading 2-tier (T1 active, T2 disabled) |
| **TrendTracker** ★ | `src/core/trend-tracker.ts` | Mode B: агрегация buy/sell + social → emit `trend:*` |
| **PreLaunchWatcher** ★ | `src/core/prelaunch-watcher.ts` | Mode C: manual + auto-alpha кандидаты с 24h TTL |
| **BlacklistStore** ★ | `src/core/blacklist-store.ts` | Atomic JSON persist (.tmp+rename), mtime-poll reload |
| **Dossier** ★ | `src/db/dossier.ts` | Per-mint history (seen/protocol/scoring/trade/close) — заменяет solscan |
| **ShadowEngine** ★ | `src/shadow/engine.ts` | Параллельный backtester (3 профиля), dynamic slippage formula |
| **Cleanup/DiskMonitor** ★ | `src/maintenance/*.ts` | Hourly TTL eviction + report; алерты на свободное место (10/8/6/4/3/2/1 GB) |
| **TelegramBot** | `src/bot/bot.ts` | Read-only: 4-кнопочное меню + push |
| **JupiterSell** | `src/trading/jupiter-sell.ts` | Jupiter Metis V6 fallback (последнее средство) |
| **JupiterBuy** | `src/trading/jupiter-buy.ts` | Jupiter buy для unknown protocols (DISABLED по-умолчанию) |
| **BloXroute** | `src/infra/bloxroute.ts` | BDN fallback sell (gated на ENV) |
| **JitoRateLimiter** | `src/infra/jito-rate-limiter.ts` | Token bucket 10 RPS |
| **Metrics** | `src/utils/metrics.ts` | Counters/gauges/histograms + опц. /metrics HTTP |
| **Web Backend** ★ | `src/web/` | Express 5 + Socket.IO + JWT auth, 13 REST routes |
| **Web Frontend** ★ | `web-ui/` (React + Vite) | Dashboard, Positions, Trades, Config, Blacklist, Wallets, Social, PreLaunch, Tokens, Shadow, Logs |

★ — добавлено в апреле 2026; в старых документах могло отсутствовать.

### Структура каталогов

```
src/
  index.ts                 # Entry: Sniper + TelegramBot + Web UI + cleanup/disk workers
  config.ts                # Все параметры (~775 строк); + computeDynamicSlippage/SellSlippage + RuntimeConfig
  constants.ts             # Program IDs, discriminators, on-chain layouts
  runtime-layout.ts        # Динамическое кэширование on-chain layout
  core/
    sniper.ts              # Главный класс (entry, confirm, exit, recovery)
    position.ts            # Position + isScalp + pendingTpLevels
    detector.ts            # Протокол detector + LRU cleanup
    migration.ts           # BC → AMM detection
    state-cache.ts         # MintState LRU
    sell-engine.ts         # Унифицированная sell + 4-chain fallback
    wallet-tracker.ts      # Copy-trade 2-tier
    blacklist-store.ts     # ★ Atomic JSON persistence
    prelaunch-watcher.ts   # ★ Mode C — pending tokens с TTL
    trend-tracker.ts       # ★ Mode B — TrendMetrics EventEmitter
  trading/
    buy.ts / sell.ts       # Pump.fun
    pumpSwap.ts            # PumpSwap AMM
    raydiumLaunchLab.ts    # Raydium LaunchLab (bonding)
    raydiumCpmm.ts         # Raydium CPMM
    raydiumAmmV4.ts        # Raydium AMM v4 (legacy)
    jupiter-buy.ts         # Jupiter fallback buy (DISABLED)
    jupiter-sell.ts        # Jupiter fallback sell (последнее средство)
  geyser/client.ts         # gRPC streaming, dual-queue
  jito/bundle.ts           # Bundle sending, tip management
  infra/
    rpc.ts                 # Connection + BACKUP_RPC_URL failover
    jito-queue.ts          # Async queue (p-limit 20)
    jito-rate-limiter.ts   # Token bucket 10 RPS
    blockhash-cache.ts     # Auto-refresh blockhash
    priority-fee-cache.ts
    bloxroute.ts           # BDN fallback (gated)
  bot/bot.ts               # Telegram read-only (4-кнопочное меню + push)
  analysis/                # Stage 3: session stats + recommendations
    session.ts
    recommendations.ts
    format.ts
  shadow/                  # ★ Parallel backtester
    engine.ts              # ShadowEngine: 3 профиля, dynamic slippage
    pipeline.ts            # Зеркалирует live entry pipeline
    profiles.ts            # PROFILES (conservative/balanced/aggressive)
    tx-builder.ts          # Unified buy/sell для всех 5 протоколов
  maintenance/             # ★ Background workers
    cleanup.ts             # Hourly TTL + WR/ROI report
    disk-monitor.ts        # Free-space alerts (7 thresholds)
  social/                  # Phase 3: DexScreener / Telegram / Twitter + watchlist
    manager.ts
    models/signal.ts
    parsers/{dexscreener,telegram,twitter}.ts
    storage/signal-store.ts
    nlp/sentiment.ts
    watchlist.ts
  db/
    sqlite.ts              # better-sqlite3 singleton + auto migrations
    dossier.ts             # ★ Per-mint history aggregator
    migrations/*.sql
  web/                     # REST + Socket.IO backend
    server.ts              # Express 5 + JWT + Socket.IO + static SPA
    auth.ts                # JWT + bcrypt
    routes/                # 13 REST endpoints
      index.ts             # Регистрация всех роутов
      control.ts           # ★ Bot start/stop/sell/close-all
      config.ts            # GET/PUT runtimeConfig (whitelist + history)
      positions.ts
      trades.ts
      wallet.ts
      wallets.ts           # Copy-trade tracker CRUD
      blacklist.ts
      social.ts            # feed/mentions/status
      prelaunch.ts         # ★ PreLaunchWatcher CRUD
      tokens.ts            # ★ Recent scored tokens
      logs.ts              # ★ Push-to-Git incremental export (49MB chunks)
      shadow.ts            # ★ Shadow engine status/trades/report
    ws/events.ts           # Socket.IO handlers (position:*, trend:*, social:*)
  utils/
    logger.ts / event-logger.ts / trade-logger.ts
    token-scorer.ts        # v4 scoring + entry multiplier
    rugcheck.ts / safety.ts / balance.ts / retry.ts / rpc-limiter.ts / sha.ts
    metrics.ts             # Counters/gauges/histograms (+ /metrics HTTP)
    social.ts              # LEGACY pre-Phase-3 on-chain social
    bonding-curve-progress.ts ★    # %-of-curve gate
    bundled-buy-detector.ts   ★    # ≥5 buyers in slot
    creator-balance.ts        ★    # 120s cache
    creator-history.ts        ★    # SQLite rug-rate
    creator-wallet-age.ts     ★    # First-tx slot
    dex-boost-check.ts        ★    # DexScreener boosts cache
    holder-check.ts           ★    # Top holder %
    metadata-quality.ts       ★    # Random/copycat names
    pool-age-gate.ts          ★    # Pool age + min volume
    price-stability.ts        ★    # 10s window panic exit
    reserve-monitor.ts        ★    # 30s reserve drop / liquidity drain
    token2022-check.ts        ★    # Dangerous extensions
    wash-trade-detector.ts    ★    # Repeat-buyer % (≥40% = wash)
  test-pumpswap.ts / test-raydium.ts   # Ops simulation tests
  autogen/runtime-layout.json
proto/                     # gRPC .proto files
scripts/
  verify.ts                # Prestart layout + config consistency check (handles TP5 portion=1.0)
  verify-sell.ts           # ★ Pre-launch sell-path validator (48 checks)
  stop.ts                  # Graceful SIGTERM via .sniper.pid
  control.ts               # Foreground без TG/Web UI
  blacklist.ts             # CLI add/remove/list/stats/clear
  cleanup-dust.ts          # Закрытие пустых ATA, возврат rent
  analyze-trades.ts        # JSONL + social correlation
  recommend-config.ts      # Heuristic config advice (cron)
  test-trade.ts            # Ручная сделка (auto-detect)
  shadow-run.ts            # Shadow engine launcher
  dossier.ts               # ★ CLI viewer per-mint history
  prelaunch.ts             # ★ PreLaunchWatcher CRUD
  sell-unknown-tokens.ts   # ★ Emergency mass-sell
  ev-simulation.ts         # ★ 50k Monte Carlo
  monte-carlo.ts           # ★ 100k × 5 protocols
  ev-analysis/             # ★ 6 EV calibration utilities
    ev-model-v2.ts
    aggregate-ev.ts
    grid-search.ts
    per-protocol.ts
    final-comparison.ts
    tp-reachability.ts
data/
  positions.json           # Активные позиции (переживают рестарт)
  blacklist.json           # Token + creator blacklist (mtime hot-reload)
  wallet-tracker.json      # Copy-trade данные
  prelaunch.json           # ★ PreLaunchWatcher persistence
  runtime-config.json      # ★ Web UI overrides (RuntimeConfig)
  sniper.db                # SQLite: events, trades, social_signals,
                           # token_dossier, analysis_reports, config_history
web-ui/                    # React + Vite SPA (раздаётся из dist/ в prod)
  src/pages/               # Dashboard, Positions, Trades, Config, Blacklist,
                           # Wallets, Social, PreLaunch, Tokens, Shadow, Logs
```

★ — новые модули, отсутствовавшие в более ранних версиях документации.

---

## 3. Руководство пользователя

### Установка

```bash
git clone <repo-url>
cd Sniper
npm ci                               # backend deps
cd web-ui && npm ci && npm run build # frontend → web-ui/dist
cd ..
```

### Настройка `.env`

`.env` в корне проекта. Заполни все обязательные переменные и опционально —
Phase 3 секции. Разделение «обязательное / опциональное»:

#### Обязательные (без них бот не стартанёт)

```env
# ── Кошелёк ─────────────────────────────────────────────
PRIVATE_KEY=<base58 приватный ключ>
PUBLIC_KEY=<публичный ключ>

# ── RPC + Geyser ────────────────────────────────────────
RPC_URL=<Solana RPC, QuickNode/Helius/etc>
GRPC_ENDPOINT=<Yellowstone Geyser gRPC endpoint>
GRPC_TOKEN=<токен авторизации gRPC>

# ── Jito (MEV bundles) ──────────────────────────────────
JITO_RPC=<Jito-совместимый RPC URL>
# либо раздельно: JITO_BUNDLE_URL, JITO_STATUS_URL

# ── Telegram (push-уведомления + read-only UI) ──────────
BOT_TOKEN=<token от @BotFather>
ALLOWED_CHAT_ID=<твой chat_id — ограничивает доступ к боту>
```

#### Опциональные и feature-флаги

```env
# ── Web UI ──────────────────────────────────────────────
JWT_SECRET=<любая длинная случайная строка>
WEB_PASSWORD_HASH=<bcrypt hash пароля; см. §3 "Web UI">
WEB_PORT=3001                        # default 3001
WEB_ORIGIN=https://sniper.example    # production CORS origin
WEB_COOKIE_SECURE=true               # включить только под HTTPS

# ── Prometheus metrics ──────────────────────────────────
METRICS_ENABLED=true                 # default true
METRICS_PORT=9469

# ── Симуляция (dev) ─────────────────────────────────────
SIMULATE=true                        # транзакции НЕ отправляются

# ── bloXroute fallback (см. §5) ─────────────────────────
BLOXROUTE_AUTH_HEADER=<header>
BLOXROUTE_TIP_WALLET=<tip receiver>

# ── Phase 3: Social signals ─────────────────────────────
# TG_ALPHA_CHANNELS  (опц. — переопределяет DEFAULT_CHANNELS в parser'е)
# RAPIDAPI_KEY + TWITTER_*  (опц. — активирует Twitter parser)
# ALPHA_TICKERS / ALPHA_MINTS / ALPHA_AUTHORS  (опц. — watchlist)
```

### Запуск

```bash
npm run build       # tsc -p tsconfig.build.json + копирование db/migrations
npm start           # prestart hook (verify.ts), затем node dist/index.js

# Разработка через ts-node (без компиляции):
npm run dev

# Симуляция (dry-run, транзакции не отправляются):
SIMULATE=true npm run dev

# Параллельный backtester (3 профиля):
npm run shadow

# Foreground без TG/Web UI:
npx ts-node scripts/control.ts start

# Unit-тесты (jest):
npm test
```

После старта:
- **Telegram**: отправь `/start` боту (с `chat_id = ALLOWED_CHAT_ID`) → read-only меню.
- **Web UI**: `http://localhost:3001` (или `WEB_PORT`). Авторизация по паролю; полный Dashboard с Push-to-Git, Push Logs кнопками.
- **Metrics**: `http://localhost:9469/metrics` (Prometheus).
- **Логи**: `logs/sniper.log` (pino JSONL). Trade events: `logs/trades-YYYY-MM-DD.jsonl`. SQLite события: `data/sniper.db`.

### Telegram (read-only)

Telegram-бот сознательно НЕ принимает управляющих команд — это защита от
компрометации TG-аккаунта (см. `src/bot/bot.ts` header). Управление вынесено
в **Web UI** и **CLI скрипты**. Telegram остаётся только наблюдательной поверхностью.

**Кнопки меню (on-demand):**
| Кнопка | Что делает |
|---|---|
| 📊 Статус | Открытые позиции, PnL сессии, баланс, uptime |
| 💰 Баланс | SOL-баланс + публичный ключ кошелька |
| 📈 Анализ сессии | Stats за сегодня (UTC): WR, ROI, причины exit, протоколы |
| ⚙️ Рекомендации | Эвристики на `config.ts` (только советы, не применяются автоматически) |

**Push-уведомления (автоматически):**
| Событие | Что приходит |
|---|---|
| `position:open`  | 💰 КУПИЛ `<mint>…` [protocol], сумма, цена |
| `position:close` | 💸 ПРОДАЛ `<mint>…` `+PnL%`, причина — нормальный exit |
| `position:close` | ❌ ОШИБКА `<mint>…` — если reason ∈ {bundle_failed, bundle_invalid_repeated, ata_empty, rpc_error} |
| Cleanup report (1×/час) | WR, ROI, рекомендации от `maintenance/cleanup.ts` |
| Disk alert | При свободном месте < 10/8/6/4/3/2/1 GB (каждый порог срабатывает один раз) |
| Sentinel silence | Если нет gRPC событий > 5 мин |

### CLI (управление ботом с сервера)

Вся активная операционка перенесена в CLI-скрипты — audit-friendly, работают с тем же state, что и боевой процесс.

**Lifecycle:**
| Команда | Что делает |
|---|---|
| `npm start` | Продакшен-запуск (prestart verify → dist). Пишет PID в `.sniper.pid`. Стартует cleanup + disk-monitor workers. |
| `npm run dev` | Запуск через ts-node (без компиляции). |
| `npm run stop` | Graceful SIGTERM по `.sniper.pid` (закрывает позиции до 60с). `-- --force` → SIGKILL после таймаута. |
| `npm run build` | tsc + копирование `db/migrations` в `dist/`. |
| `npm test` | jest --verbose (юнит-тесты в `__tests__/`). |
| `npx ts-node scripts/control.ts start` | Foreground без TG/Web UI. |

**Verification:**
| Команда | Что делает |
|---|---|
| `npm run verify` | On-chain layouts + config consistency. Также вызывается prestart-хуком. Учитывает TP5 (portion=1.0). |
| `npx ts-node scripts/verify-sell.ts` | Pre-launch валидатор sell pipeline (48 проверок: imports, sell-engine routing, Position TP system). |

**Анализ + рекомендации:**
| Команда | Что делает |
|---|---|
| `npm run analyze` | Полный анализ JSONL: статистика + social correlation + pre-buy anticipation. Флаги: `--date YYYY-MM-DD`, `--full`, `--mint <addr>`, `--replay <addr>`, `--no-social`, `--no-hints`. |
| `npm run recommend` | Короткий отчёт + советы по `config.ts`. Флаги: `--full`, `--date`, `--json` (для cron), `--quiet`. |
| `npx ts-node scripts/dossier.ts <mint>` | Полная история по mint из SQLite. Флаги: `--recent N`, `--creator <pk>`, `--events <mint>`, `--reports`, `--cleanup`. Заменяет solscan для большинства задач. |

**EV-симуляция:**
| Команда | Что делает |
|---|---|
| `npx ts-node scripts/ev-simulation.ts` | 50k Monte Carlo: peak distribution, full exit logic. |
| `npx ts-node scripts/monte-carlo.ts` | 100k trades × 5 протоколов с traffic weights. |
| `npx ts-node scripts/ev-analysis/ev-model-v2.ts` | EV-модель, калиброванная на реальных 18 сделках. |
| `npx ts-node scripts/ev-analysis/aggregate-ev.ts` | 100k всех 5 протоколов с creatorSellMinDropPct=8%. |
| `npx ts-node scripts/ev-analysis/grid-search.ts` | Grid (creatorSellMinDropPct × TP1 × SL) + worst-case EV. |
| `npx ts-node scripts/ev-analysis/per-protocol.ts` | Per-protocol breakdown. |
| `npx ts-node scripts/ev-analysis/final-comparison.ts` | Side-by-side comparison. |
| `npx ts-node scripts/ev-analysis/tp-reachability.ts` | Probability достижения каждого TP. |

**Watchlist + persist:**
| Команда | Что делает |
|---|---|
| `npm run blacklist -- <cmd>` | `add/remove/add-creator/remove-creator/list/stats/clear`. Hot-reload без рестарта. |
| `npx ts-node scripts/prelaunch.ts add --ticker X --source telegram` | Add pre-launch candidate (ticker/mint/creator). |
| `npx ts-node scripts/prelaunch.ts list` | Show all candidates с TTL и статусом (FIRED/EXPIRED/WAITING). |
| `npx ts-node scripts/prelaunch.ts remove <id>` / `clear` | Удаление. |

**Утилиты:**
| Команда | Что делает |
|---|---|
| `npm run cleanup-dust` | Закрытие пустых ATA → возврат rent. `-- --dry` для preview. |
| `npx ts-node scripts/sell-unknown-tokens.ts` | Emergency mass-sell по всему кошельку через `sellTokenAuto`. Флаги: `--dry-run`, `--burn-unsellable`, `--min-value N`, `--slippage N`. |
| `npx ts-node scripts/test-trade.ts <mint>` | Ручная сделка (auto-detect протокол). |

**Backtester:**
| Команда | Что делает |
|---|---|
| `npm run shadow` | Запуск ShadowEngine с 3 профилями (conservative/balanced/aggressive). Status доступен через `/api/shadow/status`. |

Рекомендуемый cron перед ежедневным рестартом:

```cron
0 */4 * * * cd /opt/sniper && npm run recommend >> logs/recommend.log 2>&1
```

### Web UI (operator dashboard)

Полноценный SPA на React + Vite; backend раздаёт статику из `web-ui/dist/` когда `NODE_ENV=production`. Подключён к тому же процессу, что и бот (один Node, порт `WEB_PORT`).

**Полная техническая документация Web UI**: см. отдельный файл `WEBUI.md` — там описаны все 13 REST endpoints, Socket.IO события, страницы, авторизация, RuntimeConfig.

**Доступные страницы:**

| Страница | Назначение |
|---|---|
| `/` Dashboard | Event counters (detected/entered/exited/skipped), Stats Cards, PnL chart, Skip Reasons bar, Recent Trades, Push-to-Git |
| `/positions` | Открытые позиции + Exit Signals + история |
| `/trades` | JSONL-сделки с фильтрами + per-protocol stats |
| `/config` | Редактор конфигурации (whitelist путей) с историей изменений (config_history) |
| `/blacklist` | Tokens + creators (write пишет в `data/blacklist.json`, hot-reloaded) |
| `/wallets` | Copy-trade wallet tracker (CRUD + tier override) |
| `/social` | Live Feed / Top Mentions / Source chips (★ alpha highlighting) |
| `/prelaunch` | PreLaunchWatcher candidates (manual add + auto-alpha view) |
| `/tokens` | Recently scored tokens (последние 100) |
| `/shadow` | Shadow engine status / trades / report (cyan SCALP badge для scalp positions) |
| `/logs` | Live log tail + Push-to-Git (incremental 49 MB chunks, mutex-protected) |

**Первичная настройка пароля:**

```bash
# 1. Сгенерировать bcrypt-хэш:
node -e 'require("bcrypt").hash(process.argv[1], 10).then(console.log)' 'MySecretPassword'

# 2. .env:
#    JWT_SECRET=<долгая случайная строка>
#    WEB_PASSWORD_HASH=<вывод из шага 1>
#    WEB_COOKIE_SECURE=true   ← только если фронт под HTTPS

# 3. Рестарт (npm run stop && npm start).
```

**Socket.IO события (избранные):**
- `position:open`, `position:update`, `position:close`
- `balance:update`, `stats:update` (каждые 5с)
- `trend:confirmed`, `trend:strengthening`, `trend:weakening`
- `social:signal` (все), `social:alpha` (только whitelist hits)
- `trade:close`, `token:scored`

Клиент аутентифицируется по JWT из httpOnly-cookie. Cross-origin режим: задать `WEB_ORIGIN`.

### Режим симуляции

При `SIMULATE=true`:
- Транзакции собираются, но **НЕ** отправляются в сеть.
- Все проверки (scoring, safety, liquidity) выполняются реально.
- Полезно для проверки логики entry/exit без риска потери средств.

### Заглушки (неактивные фичи до подключения API-ключей)

Некоторые модули регистрируются условно — без env-переменных они
скипаются с info-логом, остальная часть бота стартует штатно. Полная
активация — см. `RUNBOOK.md`.

| Фича | Файл | Env | Что получаем |
|---|---|---|---|
| **Twitter-парсер** (RapidAPI) | `src/social/parsers/twitter.ts` | `RAPIDAPI_KEY` (+ опц. `TWITTER_RAPIDAPI_HOST/PATH`, `TWITTER_SEARCH_QUERIES`) | Поиск твитов по фразам, 120s polling. Без ключа — просто не регистрируется. |
| **Alpha watchlist** | `src/social/watchlist.ts` | `ALPHA_TICKERS` / `ALPHA_MINTS` / `ALPHA_AUTHORS` | Отметка `alpha=true` у совпавших сигналов (только метадата) |
| **bloXroute fallback** | `src/infra/bloxroute.ts` | `BLOXROUTE_AUTH_HEADER`, `BLOXROUTE_TIP_WALLET` | Параллельная отправка sell через BDN |
| **Prometheus metrics** | `src/utils/metrics.ts` | `METRICS_ENABLED` (default `true`), `METRICS_PORT` (default 9469) | `/metrics` endpoint |
| **Web UI auth** | `src/web/auth.ts` | `JWT_SECRET`, `WEB_PASSWORD_HASH` | При их отсутствии Web UI вернёт 500 на `/api/login`. Бот стартует, но UI неработоспособен. |

> **Telegram scraper** (`src/social/parsers/telegram.ts`) — больше не заглушка:
> читает `t.me/s/{channel}` без ключей. Список каналов — `TG_ALPHA_CHANNELS` (CSV
> публичных slug'ов / URL'ов) либо `DEFAULT_CHANNELS` в parser'е. Приватные
> каналы (invite-ссылки `t.me/+xxx`) пропускаются автоматически.

Признак того что заглушка не активна — строка в логах при старте:

```
[social] Twitter parser disabled (RAPIDAPI_KEY not set)
```

DexScreener-парсер работает **без ключа** и регистрируется всегда (60s poll).

---

## 4. Руководство программиста

### Конвенции кода

- **Именование**: camelCase для переменных/функций, PascalCase для классов/типов
- **Модули**: CommonJS (TypeScript import/export -> require)
- **Логирование**: Pino через `utils/logger.ts`, НЕ console.log
- **Ошибки**: `utils/retry.ts` для retryable операций
- **RPC**: Через `infra/rpc.ts` singleton, rate-limiting через `utils/rpc-limiter.ts`
- **Конкурентность**: `p-limit` для bounded parallel operations

### Как добавить новый протокол

1. Создать файл в `src/trading/newProtocol.ts`:
   - `resolvePool()` — поиск пула по mint
   - `parsePool()` — парсинг on-chain данных
   - `computeSwapOut()` — AMM математика
   - `buildBuyInstruction()` — построение инструкции
   - `buildSellInstruction()` — построение инструкции продажи

2. Добавить константы в `src/constants.ts`:
   - Program ID
   - Pool layout offsets
   - Discriminators

3. Добавить gRPC подписку в `src/geyser/client.ts`:
   - Новый фильтр по program ID
   - Эмит нового события

4. Добавить обработчик в `src/core/sniper.ts`:
   - Подписка на событие
   - Логика entry (scoring, safety, buy)
   - Логика confirm (bundle status check)
   - Регистрация протокола в sell-engine

5. Добавить в `src/core/sell-engine.ts`:
   - Новый case для протокола

6. Добавить конфигурацию в `src/config.ts`

7. Добавить проверку в `scripts/verify.ts`

### Exit-логика (правила выхода)

Каждая позиция проверяется на следующие сигналы выхода (в порядке приоритета):

1. **Entry Stop-Loss** — выход если PnL < -entryStopLossPercent вскоре после входа
2. **Hard Stop** — безусловный выход при падении > hardStopPercent от пика
3. **Velocity Drop** — резкое падение скорости роста цены
4. **Time Stop** — принудительный выход после timeStopAfterMs если PnL < timeStopMinPnl
5. **Stagnation** — цена не двигается > stagnationMinMove за stagnationWindowMs
6. **Take-Profit** — частичные продажи по уровням (tiered)
7. **Break-Even** — выход в ноль после срабатывания trailing stop (отключён в runner mode)
8. **Trailing Stop** — активируется при росте > trailingActivationPercent, закрывает при откате > trailingDrawdownPercent
9. **Slow Drawdown** — медленное снижение в течение slowDrawdownMinDurationMs
10. **Runner Tail** — после +100% PnL (pump.fun) / +200% (PumpSwap) расширяется trailing (9%→40%) и hard stop (40%→65%), break-even отключается. Цель — дать монстр-ранерам дойти до ×5-×10

### Token scoring (0-100)

Факторы оценки:
- **Social** (max 25 pts): Twitter/Telegram упоминания (score ≥2 = +25, ≥1 = +15)
- **Market validation** (max 25 pts): independent buyers (+10/+8), first buy ≥0.1 SOL (+7)
- **Creator quality** (max 15 / penalty -20): recent tokens <3 = OK, ≥3 = SPAM (-20)
- **Metadata** (max 5 pts): size ≥500B (+5), <200B (-10)
- **Safety** (penalties): rugcheck low (+10), high (-50), mint auth (-40), freeze (-30)
- **Holder concentration** (brainstorm v4): top holder >50% (-25), >30% (-10), <15% (+5)
- **Mayhem bypass**: mayhem токены получают минимум minScore

**Entry multiplier** на основе score:
- ≥70 pts: ×2.0 (high confidence)
- ≥50 pts: ×1.0 (normal)
- ≥minScore: ×0.5 (low confidence → half entry)

### Jito MEV bundles

- Base tip: **0.0003 SOL** (поднят с 0.00005 для landing rate >30%)
- Увеличение при retry: ×1.5 за каждую попытку
- Max tip: **0.001 SOL**
- Min tip (floor): **0.0002 SOL**
- Max retries: 3
- Dynamic tip из getTipFloor (cache TTL 1.5s)
- Urgent sell: сразу maxTip без ramp-up (`urgentMaxTipImmediate: true`)
- Burst: 2 TX, tip multipliers [1.0, 1.3]
- Compute budget: 200k CU limit, 50k µlamports/CU; PumpSwap: 300k CU

---

## 5. Конфигурация (config.ts)

> Значения ниже — актуальная боевая конфигурация (commit `c894f31`, апрель 2026), откалиброванная на 1001+ shadow trades. Изменения параметров — через Web UI (`/config` с whitelist + history) или прямо в `src/config.ts`.

### Лимиты позиций (12 слотов)

| Параметр | Значение | Описание |
|----------|----------|----------|
| maxPositions | 12 | Максимум одновременных позиций (все протоколы) |
| maxPumpFunPositions | 1 | Pump.fun (risky bonding curve, только анонсированные) |
| maxPumpSwapPositions | 5 | PumpSwap — best +EV протокол (aggressive params) |
| maxRaydiumLaunchPositions | 1 | LaunchLab (shadow 0% WR — лотерейный билет) |
| maxRaydiumCpmmPositions | 3 | CPMM (+1 scalp slot) |
| maxRaydiumAmmV4Positions | 3 | AMM v4 (+2 scalp slots) |
| copyTrade.maxPositions | 1 | T1 only, T2 disabled |
| reservedT1Slots | 1 | Зарезервированный слот под copy-trade T1 |
| maxTotalExposureSol | 2.0 | Conservative exposure (было 3.5) |
| minBalanceToTradeSol | 0 | Balance floor disabled (было 0.5, блокировал при 0.37 SOL) |

### Entry (общие)

| Параметр | Значение | Описание |
|----------|----------|----------|
| entryAmountSol (fallback) | 0.06 | Дефолтный fallback |
| minEntryAmountSol (fallback) | 0.04 | Минимальный fallback |
| minIndependentBuySol | 0.15 | Мин. сумма independent buyer (было 0.25 — расширена воронка copy-trade) |
| waitForBuyerTimeoutMs | 3000 | Время ожидания independent buyer |
| earlyExitTimeoutMs | 5000 | Время на подтверждение momentum (было 1500 — слишком агрессивно убивало позиции) |
| maxTokenAgeMs | 20000 | Максимальный возраст токена для входа |
| minTokenAgeMs | 400 | Минимальный возраст (пропускаем bundled dev-buys) |
| minTokenScore | 45 | Минимальный score (было 60 — реальный потолок при входе ~55) |
| disallowToken2022 | false | Token-2022 разрешён, но dangerous extensions блокируются отдельно |
| maxJitoTipForEntry | 0.006 | Не платим больше этого Jito-tip за вход |

### Per-protocol entry amounts (shadow-data-driven)

| Протокол | entryAmountSol | minEntryAmountSol | slippageBps | Комментарий |
|---|---|---|---|---|
| Pump.fun | 0.05 | 0.03 | 2000 | Минимизируем bleeding (3% WR) |
| PumpSwap | 0.12 | 0.07 | 1500 | Best +EV; sweet spot между 0.10 и 0.14 |
| Raydium CPMM | 0.08 | 0.05 | 1800 | 14.3% WR; overhead ratio 6%→3.8% |
| Raydium AMM v4 | 0.06 | 0.04 | 1800 | 7% WR; trailing_stop winner +143% |
| Raydium LaunchLab | 0.04 | 0.03 | 2000 | Lottery ticket (10/11 stagnation) |
| Scalping mode | 0.12 | 0.08 | per-protocol | Активируется при liquidity > 50 SOL |
| Copy-trade T1 | 0.03 | — | 2000 | WR≥65% (было 60%), ≥20 trades (было 15) |
| Copy-trade T2 | 0 | — | — | DISABLED |
| Jupiter fallback | 0.05 | — | 2500 | DISABLED по-умолчанию |
| Mayhem | 0.02 | — | 5000 | DISABLED (negative EV) |

### Dynamic slippage

```
computeDynamicSlippage(entrySol, liquiditySol, maxBps, minFloor=300):
  ratio = entrySol / liquiditySol
  if ratio >= 1: return maxBps
  dynamic = ceil(maxBps * sqrt(ratio))
  return max(minFloor, min(dynamic, maxBps))
```
Пример: 0.15 SOL вход в пул 2 SOL → sqrt(0.075) ≈ 0.27 → 2500×0.27 = 688 bps.

### Dynamic sell slippage (по причине выхода)

```
computeDynamicSellSlippage(baseBps, pnlPct, urgent, exitReason):
  urgent OR pnlPct < -10                  → min(base × 2.0, 2500)
  exitReason ∈ {velocity_drop, hard_stop} → min(base × 1.8, 2200)
  exitReason ∈ {trailing_stop, stop_loss} → min(base × 1.5, 2000)
  exitReason starts with 'take_profit'    → min(base × 1.2, 1800)
  else                                    → base
```
Caps снижены (старые caps 5000 bps = 50% были MEV-sandwich-bait на public mempool fallbacks). Jupiter/bloXroute транзакции теперь идут через Jito сначала, что снижает риск sandwich'а.

### Jito

| Параметр | Значение | Описание |
|----------|----------|----------|
| tipAmountSol | 0.0003 | Базовый tip (поднят 0.00005→0.0003 для landing rate >30%) |
| maxTipAmountSol | 0.001 | Максимальный tip (p99 inclusion) |
| minTipAmountSol | 0.0002 | Нижний floor tip |
| lowActivityFloorSol | 0.0002 | Сниженный floor при тихой сети (p50 <0.0001) |
| maxRetries | 3 | Максимум ретраев (быстрее до maxTip) |
| tipIncreaseFactor | 1.5 | Множитель tip при retry |
| burstCount | 2 | Количество TX в burst |
| burstTipMultipliers | [1.0, 1.3] | Множители tip для burst TX |
| urgentMaxTipImmediate | true | Dump-сигнал сразу идёт с maxTip |

### Sell Pipeline (brainstorm v4)

| Параметр | Значение | Описание |
|----------|----------|----------|
| Confirmation polling | 100ms | Adaptive polling вместо fixed 500ms |
| Max wait (Jito) | 600ms | Ожидание confirmation для Jito attempt |
| Max wait (directRpc) | 400ms | Ожидание confirmation для RPC retry |
| Priority fee escalation | ×1.5/retry | Priority fee растёт на каждом retry, cap 5× |
| feeRecipient cache | 5s TTL | Кешируем Global PDA, не дёргаем RPC в retry loop |
| Jupiter pre-warm | 5s TTL | Quote кешируется для позиций с PnL > 50% или age > 30s |

### Exit (по протоколам)

#### Pump.fun exit

| Параметр | Значение | Описание |
|----------|----------|----------|
| entryStopLossPercent | 8 | Stop-loss (10→8: tight, экономит на dead tokens) |
| hardStopPercent | 40 | Безусловный стоп |
| trailingActivationPercent | 20 | Активация trailing (25→20: раньше, ловим больше) |
| trailingDrawdownPercent | 8 | Откат для trailing |
| velocityDropPercent | 18 | Порог скоростного падения |
| velocityWindowMs | 1500 | Окно для velocity (3-4 блока, фильтрует шум) |
| stagnationWindowMs | 45000 | 45с stagnation (60k→45k) |
| timeStopAfterMs | 75000 | 75с time-stop (90k→75k) |
| runnerActivationPercent | 60 | Активация runner-tail (80→60: раньше) |
| runnerTrailDrawdownPercent | 22 | Расширенный trailing в runner |
| runnerHardStopPercent | 35 | Расширенный hard stop в runner |
| takeProfit | TP1 +12%/30%, TP2 +60%/20%, TP3 +200%/10%, TP4 +500%/5% | 4 уровня, portions sum 0.65, 35% runner reserve |

#### PumpSwap exit

| Параметр | Значение | Описание |
|----------|----------|----------|
| entryStopLossPercent | 15 | Stop-loss (шире — shadow показал дипы перед пампом) |
| hardStopPercent | 50 | Безусловный стоп (42→50: даём шанс recovery) |
| trailingActivationPercent | 40 | Trailing активация (25→40: AMM volatile) |
| trailingDrawdownPercent | 18 | Trailing откат (12→18: широкий, даём runners дышать) |
| velocityDropPercent | 20 | Порог скоростного падения (14→20) |
| velocityWindowMs | 2000 | Окно velocity (5 блоков) |
| stagnationWindowMs | 180000 | 3 мин stagnation (240k→180k) |
| timeStopAfterMs | 360000 | 6 мин time-stop (420k→360k) |
| runnerActivationPercent | 80 | Активация runner-tail (120→80) |
| runnerTrailDrawdownPercent | 30 | Расширенный trailing в runner |
| runnerHardStopPercent | 45 | Расширенный hard stop в runner |
| takeProfit | TP1 +18%/25%, TP2 +80%/15%, TP3 +180%/10%, TP4 +400%/5%, **TP5 +1000%/100%** | 5 уровней, TP5 = полный выход (combat mode) |

#### Raydium LaunchLab exit

| Параметр | Значение | Описание |
|----------|----------|----------|
| entryStopLossPercent | 12 | Tight SL (15→12, shadow 0% WR) |
| hardStopPercent | 35 | Tight hard stop (40→35) |
| trailingActivationPercent | 20 | Trailing activation (25→20) |
| stagnationWindowMs | 45000 | 45с (60k→45k: shadow 6/6=stagnation) |
| timeStopAfterMs | 75000 | 75с (90k→75k) |
| runnerActivationPercent | 80 | Runner-tail activation |
| takeProfit | TP1 +20%/25%, TP2 +70%/20%, TP3 +200%/10%, TP4 +500%/5% | 4 уровня, 40% runner reserve |

#### Raydium CPMM exit

| Параметр | Значение | Описание |
|----------|----------|----------|
| entryStopLossPercent | 15 | Moderate SL (глубже ликвидность = smoother price) |
| hardStopPercent | 42 | Hard stop (48→42) |
| trailingActivationPercent | 30 | Trailing activation (35→30) |
| trailingDrawdownPercent | 15 | Trailing откат (18→15) |
| stagnationWindowMs | 180000 | 3 мин (240k→180k) |
| timeStopAfterMs | 300000 | 5 мин (420k→300k) |
| runnerActivationPercent | 100 | Runner-tail activation (150→100) |
| takeProfit | TP1 +20%/25%, TP2 +70%/20%, TP3 +200%/10%, TP4 +500%/5% | 4 уровня, 40% runner reserve |

#### Raydium AMM v4 exit

| Параметр | Значение | Описание |
|----------|----------|----------|
| entryStopLossPercent | 12 | Tight SL (15→12: убыточный протокол) |
| hardStopPercent | 35 | Hard stop (48→35) |
| trailingActivationPercent | 25 | Trailing activation (35→25: ловим любой profit) |
| trailingDrawdownPercent | 14 | Trailing откат (18→14) |
| stagnationWindowMs | 120000 | 2 мин (240k→120k: все exits dead_volume в shadow) |
| timeStopAfterMs | 180000 | 3 мин (420k→180k: shadow avg hold 91s) |
| runnerActivationPercent | 80 | Runner-tail activation (150→80) |
| takeProfit | TP1 +15%/30%, TP2 +60%/20%, TP3 +200%/10%, TP4 +500%/5% | 4 уровня, 35% runner reserve |

#### Scalping mode (CPMM/AMM v4 при liquidity > 50 SOL)

| Параметр | Значение | Описание |
|----------|----------|----------|
| entryAmountSol | 0.12 | Выше (низкий риск на established pools) |
| entryStopLossPercent | 5 | Tight SL |
| hardStopPercent | 12 | Tight hard stop (15→12) |
| trailingActivationPercent | 6 | Trailing activation (+6%) |
| trailingDrawdownPercent | 3 | Tight trailing |
| velocityDropPercent | 8 | Значимое падение = выход (10→8) |
| stagnationWindowMs | 180000 | 3 мин (60s→180s: ликвидные пулы медленны) |
| stagnationMinMove | 0.01 | 1% min movement (2%→1%) |
| timeStopAfterMs | 300000 | 5 мин max hold (2→5 мин) |
| takeProfit | TP1 +5%/50%, TP2 +15%/100% | 2 уровня (TP2 = полный выход; partial sells убыточны на overhead) |

### Copy-Trade (2-tier)

| Параметр | Значение | Описание |
|----------|----------|----------|
| enabled | true | Copy-trade активирован |
| entryAmountSol | 0.03 | Tier 1 вход (re-enabled с минимальным входом) |
| tier2EntryAmountSol | 0 | Tier 2 **DISABLED** (0% WR в проде) |
| maxPositions | 1 | Макс 1 CT позиция одновременно |
| minBuySolFromTracked | 1.5 | Мин. покупка tracked wallet (1.0→1.5: только крупные) |
| slippageBps | 2000 | Slippage для copy-trade сделок |
| reservedT1Slots | 1 | Зарезервированный слот под T1 |

**Wallet Tracker (T1 active, T2 disabled):**

| Параметр | Значение | Описание |
|----------|----------|----------|
| minCompletedTrades | 20 | T1: минимум завершённых сделок (15→20) |
| minWinRate | 0.65 | T1: минимум win rate (0.60→0.65: только стабильные) |
| tier2MinCompletedTrades | 15 | T2: порог (kept for future re-enable) |
| tier2MinWinRate | 0.55 | T2: порог (kept for future re-enable) |
| maxTrackedWallets | 2000 | Максимум отслеживаемых кошельков |
| minCopyBuySolLamports | 150_000_000 | 0.15 SOL мин. buy от tracked wallet |

### Defensive Mode (soft throttle)

| Параметр | Значение | Описание |
|----------|----------|----------|
| enabled | true | Промежуточный уровень между нормой и kill-switch |
| window | 10 | Минимум N сделок для оценки |
| entryThreshold | 0.50 | WR < 50% — включить defensive (было 45%) |
| exitThreshold | 0.60 | WR > 60% — выключить (было 55%) |
| scoreDelta | 8 | minTokenScore += 8 в defensive (4→8) |
| entryMultiplier | 0.50 | entry × 0.50 в defensive (0.70→0.50: вдвое меньше) |

### Kill-switches

| Триггер | Действие | Параметр |
|---------|----------|----------|
| consecutiveLossesMax (5) подряд проигрышей | Пауза `pauseAfterLossesMs` (15 мин) | `consecutiveLossesMax: 5` |
| WR < 25% за 10 сделок | Пауза 15 мин (TRADE_QUALITY_PAUSE) | в `analyze` / JSONL |
| Invalid rate ≥ 70% за 20 bundles | Пауза 5 мин | внутри Sniper |

### Trend (Mode B / TrendTracker)

| Параметр | Значение | Описание |
|----------|----------|----------|
| eliteScoreThreshold | 25 | Mode A: мгновенный вход при score ≥ 25 |
| trackingScoreThreshold | 15 | Mode B: отслеживание в TrendTracker |
| minUniqueBuyers | 4 | Мин. уникальных покупателей для подтверждения |
| minBuySellRatio | 2.0 | Перевес покупателей |
| pumpFunMinVolumeSol | 1.0 | Мин. объём pump.fun |
| pumpSwapMinVolumeSol | 3.0 | Мин. объём PumpSwap |
| raydiumLaunchMinVolumeSol | 2.0 | Мин. объём LaunchLab |
| raydiumCpmmMinVolumeSol | 4.0 | Мин. объём CPMM |
| raydiumAmmMinVolumeSol | 5.0 | Мин. объём AMM v4 |
| pumpFunWindowMs | 60000 | Скользящее окно pump.fun |
| pumpSwapWindowMs | 120000 | Скользящее окно PumpSwap |
| raydiumWindowMs | 300000 | Скользящее окно Raydium |
| weakenSellRatio | 1.5 | Порог ослабления тренда (exit signal) |
| weakenWindowMs | 20000 | Окно ослабления |
| inactiveCleanupMs | 300000 | Очистка неактивных mint'ов |

**Auto-Alpha** (PreLaunchWatcher):

| Критерий | Значение |
|----------|----------|
| DexScreener boost | → автоматический alpha |
| Cross-source mentions ≥ minMentions (2) за lookbackMs (10 мин) | → alpha |
| Large channel ≥ minFollowers (5000) + sentiment ≥ 0.2 | → alpha |
| TTL auto-alpha | 1 час (vs 24ч для manual) |

### bloXroute (последнее средство при sell)

| Параметр | Значение | Описание |
|----------|----------|----------|
| enabled | auto (.env) | Активируется при наличии BLOXROUTE_AUTH_HEADER + TIP_WALLET |
| tipLamports | 1000000 | 0.001 SOL tip внутри tx |
| minAttemptIdx | 3 | Только на финальной попытке sell |
| maxTipPctOfProceeds | 0.05 | Не включать если tip > 5% от выхода |

### Metrics

| Параметр | Значение | Описание |
|----------|----------|----------|
| enabled | true | Prometheus-совместимый endpoint |
| port | 9469 | GET /metrics, GET /snapshot |

---

## 6. Поддерживаемые протоколы

### Pump.fun (Bonding Curve)

- **Program**: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
- **Инструкция**: `buy_exact_sol_in` (disc: `38fc74089edfcd5f`)
- **17 аккаунтов** включая creatorVault, feeConfig, bondingCurveV2
- **Cashback**: byte[82] bonding curve = cashback_enabled
- **BondingCurve layout**: 151 байт (post-cashback upgrade Feb 2026)

### PumpSwap (AMM)

- **Program**: `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`
- **Buy disc**: `66063d1201daebea`
- **Pool PDA**: seeds `['pool', u16_le(0), pumpAuthority, baseMint, wSOL]`
- **poolV2 PDA**: seeds `['pool-v2', baseMint]` — ОБЯЗАТЕЛЬНО как remaining account
- **Cashback support**: OptionBool @ byte[244] пула
- **Fees**: динамические из feeConfig (~125 bps)

### Raydium LaunchLab (Bonding Curve)

- **Program**: `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`
- **Buy**: `BuyExactIn` disc `[250,234,13,123,213,156,19,236]`
- **Sell**: `SellExactIn` disc `[149,39,222,155,211,124,152,26]`
- **Graduation**: ~85 SOL -> миграция в AMM v4 (type 0) или CPMM (type 1)
- **Pool status**: 0=active, 1=migrated, 250=migrated (extended)

### Raydium CPMM (CP-Swap)

- **Program**: `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`
- **Swap**: `swap_base_input` disc `[143,190,90,218,196,30,51,222]`
- **Fee tiers**: 25, 100, 200, 400 bps
- **Token-2022**: поддерживается

### Raydium AMM v4 (Legacy)

- **Program**: `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`
- **Swap**: data[0] = 9 (SwapBaseIn) или 16 (SwapBaseInV2)
- **Authority**: `5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1`
- **Fee**: 25 bps (on-chain)

---

## 7. Тестирование

### Предпродакшен верификация

```bash
npx ts-node scripts/verify.ts
```
Проверяет on-chain layouts, program IDs, config consistency. Должен пройти без ошибок.

### Ручные тесты

```bash
# Pump.fun / PumpSwap (auto-detect)
SIMULATE=true npx ts-node scripts/test-trade.ts <MINT>

# PumpSwap симуляция
SIMULATE=true npx ts-node src/test-pumpswap.ts <MINT>

# Raydium (auto/launchlab/cpmm/ammv4)
SIMULATE=true npx ts-node src/test-raydium.ts <MINT> [PROTOCOL]
```

### Анализ логов

```bash
npx ts-node scripts/analyze-trades.ts
```

### Порядок тестирования

1. `scripts/verify.ts` — layouts и config
2. Ручные тесты каждого протокола в SIMULATE mode
3. Полный бот в SIMULATE mode (~20 мин)
4. Анализ логов
5. Production с малыми суммами

---

## 8. Brainstorm v5 — Изменения (апрель 2026)

### Баг-фиксы (B-category)
- **B1**: `executeFullSell()` защищён sellingMutex — все 6+ call paths защищены от race condition
- **B3+B11**: Dual-queue в GeyserClient — CREATE events получают приоритет, исправлен repeated pause/resume
- **B4**: `safeNumber()` helper предупреждает при BigInt→Number overflow (>2^53)
- **B5**: Jito burst — уникальные подписи через `burstIndex` offset в ComputeUnitLimit
- **B6**: ATA balance перечитывается между sell retries (ловит partial sells)
- **B8**: Замена `confirmTransaction` на `getSignatureStatuses` polling (нет blockhash mismatch)
- **B9**: PumpSwap fee исправлена с 30→125 bps
- **B10**: `Math.max(0, solReceived)` предотвращает отрицательный баланс в `closeAllPositions`
- **B12**: Jito queue retries идут в конец очереди (нет priority inversion)

### Оптимизации латентности (C-category)
- **C1**: `detectProtocol()` кэш — permanent для terminal states (pumpswap/raydium), 5s TTL для pump.fun
- **C2+C5**: Rugcheck запускается параллельно с social check (экономия 200-500ms), удалены дублирующие вызовы

### EV-улучшения (D-category)
- **D1**: TP ladder portions суммируют 0.80 (было 1.0) — 20% runner reserve для mega-runners
- **D2**: Post-entry scoring gate — подтверждённые покупки с низким score сразу закрываются
- **D3**: Entry снижен до 0.10 SOL (было 0.15) — экономия ~1.5pp slippage
- **D5**: `safety.ts` null account → unsafe (было неверно: safe: true)

### Калибровка фильтров (E-category)
- Stop-loss 18% (было 20%), slippage 2000/1500 bps (было 2500/1800)
- Trailing activation pump.fun 25% (без изменений), PumpSwap 30% (было 35%), drawdown 9%/15% (было 12%/18%)
- Time stop pump.fun 45s (было 60s)
- Copy-trade entry: T1 0.06 SOL (было 0.08), T2 0.03 SOL (было 0.04)
- Loss pause 15 min (было 10 min)

### Новые функции (F-category)
- **F6**: Balance floor — не открывать позиции при балансе < `minBalanceToTradeSol` (0.5 SOL)
- **F7**: Token/creator blacklist с Telegram-командами (`/blacklist`, `/unblacklist`, `/blacklist_creator`, `/blacklist_stats`)

### Новые подсистемы
- **JitoRateLimiter** (`src/infra/jito-rate-limiter.ts`): Token bucket rate limiter (10 RPS)
- **Protocol detection cache** (`src/core/detector.ts`): Permanent cache для terminal states, 5s TTL для pump.fun

### Post-audit fixes (апрель 2026)
- **LaunchLab migration routing** (`sell-engine.ts`): при продаже через LaunchLab, если пул мигрировал (status=1/250), автоматический fallback на CPMM → AMM v4. Ранее sell падал с `Custom(6001)`
- **Rescue sell при force-close** (`sniper.ts`): перед удалением позиции после провала всех 4 sell-каналов, перечитывается ATA и делается финальная попытка Jupiter sell (5000 bps slippage). Спасает runner reserve токены
- **Dynamic sell slippage** (`config.ts`): `computeDynamicSellSlippage()` — slippage для продаж адаптируется по причине выхода: urgent/deep loss ×2.5, velocity_drop ×2.0, trailing ×1.5, take_profit ×1.3
- **Ghost position prevention** (`sniper.ts`): optimistic timeout для Pump.fun и PumpSwap проверяет ATA баланс перед удалением позиции. Если токены есть — позиция восстанавливается как confirmed

### Senior audit fixes (апрель 2026)
- **Jito tip cache TTL** (`bundle.ts`): 10s → 1.5s — tip floor может взлететь 10x за 2 секунды при хайп-токене
- **Jupiter fallback timeout** (`jupiter-sell.ts`): 10s → 2s — при панике 10 секунд = полная потеря позиции
- **Detector cache TTL** (`detector.ts`): pump.fun 5s → 1s — уменьшена слепая зона миграции
- **Jito tips повышены** (`config.ts`): tipAmountSol 0.00003→0.00005, minTip 0.000015→0.0001
- **TP race condition** (`position.ts` + `sniper.ts`): `pendingTpLevels` Set — lockTpLevel/unlockTpLevel предотвращает дублирование TP sell пока транзакция в полёте

### EV-positive restructuring (апрель 2026)
Полный пересмотр стратегии выхода на основе математического анализа мат.ожидания.

**Проблема**: При 0.10 SOL entry, 4-уровневый TP ladder (12/30/80/200%) имел отрицательное EV:
- TP1 при +12% давал 0.0012 SOL чистыми — меньше стоимости одного retry Jito
- 4 sell-транзакции = ~0.001 SOL overhead (10%+ типичного профита)
- К моменту TP4 продано 80% позиции — runner reserve (20%) не может компенсировать убытки
- Copy-trade T2 (0.03 SOL) с partial TPs: round-trip cost 3.7% → любой TP < 10% = гарантированный минус

**Решения**:
- **TP ladder → "Binary + Runner"**: 2 уровня вместо 4. Pump.fun: TP1 +50% (sell 40%), TP2 +200% (sell 20%), 40% runner. Первый TP покрывает все costs + фиксирует profit. Меньше sell-транзакций = меньше overhead
- **Micro-position binary exit** (`position.ts`): позиции < 0.05 SOL (copy-trade T2) продаются 100% при первом TP, без partial sells — tx costs непропорциональны
- **Fee-adjusted buy** (`buy.ts`): `expectedTokens * 99n / 100n` — учёт 1% protocol fee ДО расчёта slippage. Реальный slippage buffer был на 1% меньше заявленного
- **Jupiter via Jito** (`jupiter-sell.ts`): Jupiter-транзакции отправляются через Jito bundle (приватный mempool). Ранее отправлялись через публичный RPC с slippage до 50% = гарантированный MEV sandwich
- **Non-blocking blockhash** (`blockhash-cache.ts`): stale cache (5-30s) возвращает кэшированный blockhash немедленно, обновление в фоне. Раньше await на RPC блокировал sell-path на 1-3с при нагрузке
- **Sell slippage caps снижены** (`config.ts`): urgent 5000→3500, velocity 4000→3000, trailing 3500→2500 bps
- **Stop-loss 18% → 15%**: экономия 0.003 SOL/loss × 55% loss rate = +0.12 SOL/day
- **PumpSwap trailing drawdown 15% → 12%**: тighter защита прибыли

**EV модель после изменений** (при 30% WR, 70 trades/day):
- EV ≈ +0.012 SOL/trade (было ~0 или отрицательное)
- Прогноз: +0.84 SOL/day = +5.9 SOL/week при 3 SOL bankroll

---

## 9. Известные проблемы

### Jito "Invalid" bundle status (ИСПРАВЛЕНО)
- **Причина**: QuickNode Lil JIT может возвращать "Invalid" для bundles, которые реально прошли
- **Решение**: On-chain fallback через getSignatureStatuses в sniper.ts

### PumpSwap Overflow 6023 (ИСПРАВЛЕНО)
- **Причина**: Отсутствие poolV2 PDA в remaining accounts
- **Решение**: Добавлен `getPoolV2PDA(baseMint)` с seeds `['pool-v2', baseMint]`

### PumpSwap ConstraintTokenMint 2014 (ИСПРАВЛЕНО)
- **Причина**: Fee ATAs использовали hardcoded wSOL вместо quoteMint из пула
- **Решение**: Используется `poolState.quoteMint`

### LaunchLab PDA calculation (ИЗВЕСТНО)
- PDA расчёт нестабилен для некоторых токенов
- Используется getProgramAccounts fallback
- Пулы мигрируют быстро (минуты), что затрудняет тестирование

---

## 9.5. Phase 3 — Social Signals (April 2026)

Отдельный модуль `src/social/`, независимый от торгового горячего пути.
Отказ любого парсера не влияет на снайпинг. Все сигналы складываются
в SQLite (`data/sniper.db` таблица `social_signals`) для корреляции
с реальными сделками через `scripts/analyze-trades.ts`.

### Архитектура

```
parsers/         → SocialManager → saveSignal() → SQLite
  dexscreener       dedup LRU 5k         ↓
  telegram          + isAlpha()      emit('signal')
  twitter           + persist        emit('alpha')     → Socket.IO + REST
                                                       → Web UI /social
```

### Парсеры

| Парсер | Требования | Интервал | Что даёт |
|--------|-----------|----------|----------|
| DexScreener | ничего (free API) | 60s | Boosted токены (solana) — прокси хайпа |
| Telegram | ничего (HTML scraper t.me/s); опц. TG_ALPHA_CHANNELS | 30s | Сообщения из публичных каналов (DEFAULT_CHANNELS или env override) |
| Twitter | RAPIDAPI_KEY (+ host/path/queries) | 120s | Результаты поиска по ключевикам |

### Alpha whitelist

Ручные env-списки (`ALPHA_TICKERS` / `ALPHA_MINTS` / `ALPHA_AUTHORS`)
помечают совпавшие сигналы `alpha=true`. Это метадата — автоматических
торговых действий по флагу сейчас нет. Применения:
- UI подсвечивает ★ жёлтой рамкой
- REST: `GET /api/social/feed?alpha=1`
- WS: отдельный канал `social:alpha`
- Analyze: можно фильтровать по `alpha` колонке в SQL

### Surfaces

- REST `/api/social/{feed,mentions,status}`
- WS `social:signal`, `social:alpha`
- UI `/social` — Live Feed, Top Mentions, source status
- CLI `npx ts-node scripts/analyze-trades.ts --full` → секции
  📡 "СОЦИАЛЬНАЯ КОРРЕЛЯЦИЯ" и 📅 "PRE-BUY ANTICIPATION"

### Инструкция по активации

См. `RUNBOOK.md` в корне репозитория.

---

## 10. Troubleshooting

| Ошибка | Причина | Решение |
|--------|---------|---------|
| Missing required env: X | Не установлена переменная .env | Проверить .env файл |
| getTipFloor failed | Неправильный Jito endpoint | Установить JITO_RPC в .env |
| Error 6023 (Overflow) | Отсутствует poolV2 PDA | Обновить код pumpSwap.ts |
| Error 2014 (ConstraintTokenMint) | Неправильный quoteMint для fee ATA | Использовать quoteMint из пула |
| Custom error 42 (AMM v4) | Пул не wSOL-paired | Pool discovery предпочитает wSOL |
| Pool migrated (status=250) | LaunchLab пул мигрировал | Использовать CPMM/AMM v4 |
| 100% Invalid bundles | Неправильный Jito endpoint | Установить JITO_RPC (не обычный RPC) |
| [tg] channel X HTTP 404 | Канал удалён / приватный / неверный slug | Проверить URL в браузере; приватные (t.me/+xxx) не читаются |
| [tg] channel X fetch failed: timeout | Telegram temp-ratelimit (редко) / сетевые | Обычно решается само на следующем polling-цикле |
| [tw] query X failed (status=429) | Превышен RapidAPI rate limit | Уменьшить TWITTER_SEARCH_QUERIES, повысить интервал, или поменять тариф |
| [tw] query X failed (status=401/403) | Неверный RAPIDAPI_KEY или не подписан на host | Проверить ключ + подписку на конкретный provider на rapidapi.com |
| [social] Telegram parser disabled | Не все 4 TG_* env заданы | Заполнить недостающие или оставить пустыми (парсер просто не зарегистрируется) |
| social_signals table only has 10 cols | Старый процесс бота держит DB открытой | `lsof data/sniper.db` → рестарт бота; миграция колонок применится при старте |
| data/positions.json corrupt | Аварийное завершение | Удалить файл (потеряются позиции) |
