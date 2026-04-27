# Solana Sniper Bot v3 — Документация проекта

## 1. Описание проекта

MEV-снайпер бот для Solana, нацеленный на автоматическую покупку токенов на ранних стадиях запуска через протоколы Pump.fun, PumpSwap, Raydium LaunchLab, Raydium CPMM и Raydium AMM v4.

**Что делает:**
- Отслеживает создание новых токенов в реальном времени через Yellowstone Geyser gRPC
- Оценивает токены по набору критериев (scoring, safety checks, social signals)
- Покупает через Jito MEV-Share bundles для защиты от frontrunning
- Управляет позициями с правилами автоматического выхода (stop-loss, trailing stop, take-profit)
- Предоставляет управление через Telegram-бот и консольный скрипт

**Стек технологий:**
- TypeScript 5.9 (strict mode), Node.js, CommonJS
- @solana/web3.js 1.87.6, @solana/spl-token 0.3.9
- gRPC через @grpc/grpc-js + Yellowstone Geyser
- Jito bundle submission
- Telegraf 4.15.3 (Telegram)
- Pino (structured JSON logging)

---

## 2. Архитектура

### Поток данных

```
Geyser gRPC stream
    |
    v
EventEmitter (GeyserClient)
    |
    +---> [pump:create]     ---> Token scoring + safety ---> Buy (Jito bundle)
    +---> [pumpswap:create] ---> Token scoring + safety ---> Buy (Jito bundle)
    +---> [raydium:launch]  ---> Token scoring + safety ---> Buy (Jito bundle)
    +---> [raydium:cpmm]    ---> Token scoring + safety ---> Buy (Jito bundle)
    +---> [raydium:ammv4]   ---> Token scoring + safety ---> Buy (Jito bundle)
    |
    v
Position monitoring (PnL, exit signals)
    |
    v
Sell (Jito bundle) ---> Trade log (JSONL)
```

### Основные компоненты

| Компонент | Файл | Назначение |
|-----------|------|------------|
| Sniper | `src/core/sniper.ts` | Главный класс — entry/exit логика, position management |
| GeyserClient | `src/geyser/client.ts` | gRPC стриминг, EventEmitter |
| JitoBundle | `src/jito/bundle.ts` | Отправка Jito bundles, управление tips |
| SellEngine | `src/core/sell-engine.ts` | Унифицированная продажа через все протоколы |
| Detector | `src/core/detector.ts` | Определение протокола токена (pump.fun vs PumpSwap) |
| Position | `src/core/position.ts` | Трекинг позиций, PnL, exit signals |
| TokenScorer | `src/utils/token-scorer.ts` | Скоринг токенов (0-100) |
| WalletTracker | `src/core/wallet-tracker.ts` | Copy-trading система |
| TelegramBot | `src/bot/bot.ts` | Telegram интерфейс |
| BloXroute | `src/infra/bloxroute.ts` | Параллельная отправка sell через bloXroute BDN |
| JupiterSell | `src/trading/jupiter-sell.ts` | Jupiter Metis V6 fallback sell (RPC-only) |
| Metrics | `src/utils/metrics.ts` | Prometheus-совместимый endpoint (/metrics) |

### Структура каталогов

```
src/
  index.ts                 # Entry point: стартует Sniper + TelegramBot + Web UI
  config.ts                # Все параметры конфигурации
  constants.ts             # Program IDs, discriminators, on-chain layouts
  core/                    # Ядро бота (sniper, position, detector, sell-engine, wallet-tracker)
  trading/                 # Построители транзакций по протоколам
  geyser/                  # gRPC клиент
  jito/                    # Jito bundle sending
  infra/                   # RPC, blockhash cache, priority fees, bloxroute
  bot/                     # Telegram (read-only: push + on-demand кнопки)
  analysis/                # ← Этап 3: session stats + recommendations + формат-слой
    session.ts             #   чтение JSONL + агрегирование метрик
    recommendations.ts     #   10 эвристик советов по config.ts
    format.ts              #   форматирование для CLI и Telegram HTML
  social/                  # Phase 3: DexScreener / Telegram / Twitter + watchlist
  db/                      # SQLite (better-sqlite3) + миграции
  web/                     # REST + Socket.IO backend для Web UI
  utils/                   # Logger, retry, scoring, safety, metrics
scripts/
  verify.ts                # prestart hook — проверка on-chain layouts
  control.ts               # foreground запуск без Telegram
  stop.ts                  # graceful SIGTERM по .sniper.pid
  blacklist.ts             # управление data/blacklist.json
  cleanup-dust.ts          # закрытие пустых ATA, возврат rent
  analyze-trades.ts        # полный анализ JSONL + social-корреляция
  recommend-config.ts      # ← Этап 3: короткий отчёт + советы по config (cron-friendly)
  test-trade.ts            # ручное тестирование сделок
data/
  positions.json           # Персистентные позиции (переживают рестарт)
  blacklist.json           # Blacklist (tokens + creators), читается в runtime с polling
  wallet-tracker.json      # Данные copy-trading
  sniper.db                # SQLite: social_signals и т.д.
web-ui/                    # Frontend (React + Vite), раздаётся из backend в prod
```

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
npm run build       # TS → dist/
npm start           # prestart: scripts/verify.ts; затем node dist/index.js

# Разработка через ts-node (без компиляции):
npm run dev

# Симуляция (dry-run):
SIMULATE=true npm run dev

# Foreground без Telegram — только ядро, полезно для headless VPS:
npx ts-node scripts/control.ts start
```

После старта:
- **Telegram**: отправь `/start` боту (с `chat_id = ALLOWED_CHAT_ID`) → появится read-only меню.
- **Web UI**: `http://localhost:3001` (или `WEB_PORT`). Авторизация по паролю.
- **Metrics**: `http://localhost:9469/metrics` (Prometheus).
- **Логи**: `logs/sniper.log` (pino JSONL). Trade events: `logs/trades-YYYY-MM-DD.jsonl`.

### Telegram (read-only)

Telegram-бот сознательно НЕ принимает управляющих команд — это защита от
компрометации TG-аккаунта (см. `src/bot/bot.ts` header). Доступно:

**Кнопки меню (on-demand):**
| Кнопка | Что делает |
|---|---|
| 📊 Статус | открытые позиции, PnL сессии, баланс, uptime |
| 💰 Баланс | SOL-баланс + публичный ключ кошелька |
| 📈 Анализ сессии | Short stats за сегодня (UTC): WR, ROI, причины exit, протоколы, urgent |
| ⚙️ Рекомендации | Эвристики на `config.ts` по всем доступным логам — **только советы, не применяются автоматически** |

**Push-уведомления (автоматически):**
| Событие | Что приходит |
|---|---|
| `position:open`  | 💰 КУПИЛ `<mint>…` [protocol], сумма, цена |
| `position:close` | 💸 ПРОДАЛ `<mint>…` `+PnL%`, причина — нормальный exit |
| `position:close` | ❌ ОШИБКА `<mint>…` — если reason ∈ {bundle_failed, bundle_invalid_repeated, ata_empty, rpc_error} |

### CLI (управление ботом с сервера)

Вся активная операционка перенесена в CLI-скрипты — audit-friendly,
работают с тем же state, что и боевой процесс.

| Команда | Что делает |
|---|---|
| `npm start` | Продакшен-запуск (prestart verify, затем dist). Пишет PID в `.sniper.pid`. |
| `npm run dev` | Запуск через ts-node без компиляции. |
| `npm run stop` | Graceful SIGTERM по `.sniper.pid` (закрывает позиции до 30с). `-- --force` → SIGKILL после таймаута. |
| `npm run verify` | Проверка on-chain layouts (запускается также как prestart hook). |
| `npm run analyze` | Полный анализ JSONL: общая статистика + social correlation + pre-buy anticipation. Флаги: `--date YYYY-MM-DD`, `--full`, `--mint <addr>`, `--replay <addr>`, `--no-social`, `--no-hints`. |
| `npm run recommend` | Короткий отчёт + советы по `config.ts`. Флаги: `--full`, `--date`, `--json` (для cron), `--quiet`. |
| `npm run blacklist <cmd>` | `add <mint>`, `remove <mint>`, `add-creator <addr>`, `remove-creator <addr>`, `list`, `stats`, `clear`. Боевой бот подхватывает изменения через mtime-polling без рестарта. |
| `npm run cleanup-dust` | Закрывает пустые ATA → rent возвращается. `-- --dry` — только показать. |
| `npx ts-node scripts/control.ts start` | Foreground-запуск без Telegram/Web UI. |
| `npx ts-node scripts/test-trade.ts <mint>` | Ручное тестирование сделки (auto-detect протокол). |

Рекомендуемый cron перед ежедневным рестартом:

```cron
0 */4 * * * cd /opt/sniper && npm run recommend >> logs/recommend.log 2>&1
```

### Web UI (operator dashboard)

Raspberry-friendly SPA на React + Vite; backend раздаёт статику из
`web-ui/dist/` когда `NODE_ENV=production`. Подключён к тому же процессу,
что и бот (один Node, порт `WEB_PORT`).

**Первичная настройка пароля:**

```bash
# 1. Сгенерировать bcrypt-хэш из чистого пароля:
node -e 'require("bcrypt").hash(process.argv[1], 10).then(console.log)' 'MySecretPassword'

# 2. Положить в .env:
#    JWT_SECRET=<долгая случайная строка>
#    WEB_PASSWORD_HASH=<вывод из шага 1>
#    WEB_COOKIE_SECURE=true   ← только если фронт под HTTPS

# 3. Перезапустить бота (npm run stop && npm start).
```

**Доступные страницы:**
- `/` — Dashboard (статус, позиции, PnL)
- `/positions` — открытые позиции + история
- `/blacklist` — просмотр/правка blacklist (пишет в `data/blacklist.json`)
- `/wallets` — copy-trade wallet tracker
- `/config` — read-only просмотр конфигурации
- `/social` — Live Feed / Top Mentions / Source chips
- `/trades` — JSONL-сделки с фильтрами

**Socket.IO:** real-time `position:open`/`position:close`, `social:signal`,
`social:alpha`. Клиент аутентифицируется по JWT из httpOnly-cookie.

Если фронтенд разворачивается отдельно (dev-режим `npm run dev` в
`web-ui/`) — ему надо разрешить cross-origin JWT: выставить `WEB_ORIGIN`
в `.env` и поднять бэкенд через `npm start`.

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

- Base tip: 0.00003 SOL
- Увеличение при retry: ×1.5 за каждую попытку
- Max tip: 0.0001 SOL
- Min tip: 0.000015 SOL
- Max retries: 3
- Dynamic tip из getTipFloor percentiles
- Urgent sell: сразу maxTip без ramp-up

---

## 5. Конфигурация (config.ts)

### Лимиты

| Параметр | Значение | Описание |
|----------|----------|----------|
| maxPositions | 4 | Максимум одновременных позиций (все протоколы) |
| maxPumpFunPositions | 3 | Максимум позиций Pump.fun |
| maxPumpSwapPositions | 1 | Максимум позиций PumpSwap |
| maxRaydiumLaunchPositions | 1 | Максимум позиций LaunchLab |
| maxRaydiumCpmmPositions | 1 | Максимум позиций CPMM |
| maxRaydiumAmmV4Positions | 1 | Максимум позиций AMM v4 |
| maxTotalExposureSol | 0.60 | Максимальная общая сумма во всех позициях |

### Entry

| Параметр | Значение | Описание |
|----------|----------|----------|
| entryAmountSol | 0.10 | Сумма входа по умолчанию (pump.fun, PumpSwap) — D3: снижено с 0.15 |
| minEntryAmountSol | 0.05 | Минимальная сумма входа |
| minBalanceToTradeSol | 0.5 | Balance floor — не открывать позиции ниже этого баланса (F6) |
| minIndependentBuySol | 0.25 | Мин. сумма independent buyer для подтверждения |
| waitForBuyerTimeoutMs | 3000 | Время ожидания independent buyer |
| earlyExitTimeoutMs | 1500 | Быстрый выход (socialLow: 1000ms автоматически) |
| maxTokenAgeMs | 20000 | Максимальный возраст токена для входа |
| minTokenAgeMs | 400 | Минимальный возраст (пропускаем bundled dev-buys) |
| minTokenScore | 50 | Минимальный score для входа |
| dynamicSlippage | auto | `sqrt(entry/liquidity) × maxBps`, min 300 bps |
| aggBuyVolumeGate | 0.5 SOL | 2+ independent wallets = fast entry |

### Jito

| Параметр | Значение | Описание |
|----------|----------|----------|
| tipAmountSol | 0.00005 | Базовый tip (повышен для конкурентного включения) |
| maxTipAmountSol | 0.0001 | Максимальный tip |
| minTipAmountSol | 0.0001 | Минимальный tip (повышен до уровня tipAmountSol) |
| maxRetries | 3 | Максимум ретраев (быстрее до maxTip) |
| tipIncreaseFactor | 1.5 | Множитель tip при retry |
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
| entryStopLossPercent | 18 | Stop-loss при входе (E: 20→18) |
| hardStopPercent | 40 | Безусловный стоп |
| trailingActivationPercent | 25 | Активация trailing stop |
| trailingDrawdownPercent | 9 | Откат для trailing stop |
| timeStopAfterMs | 45000 | Время до принудительного выхода (E: 60k→45k) |
| takeProfit | 12%→15%, 30%→15%, 80%→30%, 200%→20% | 4 уровня (portions sum 0.80, D1: 20% runner reserve) |
| runnerActivationPercent | 100 | Активация runner-tail |
| runnerTrailDrawdownPercent | 40 | Расширенный trailing в runner |
| runnerHardStopPercent | 65 | Расширенный hard stop в runner |

#### PumpSwap exit

| Параметр | Значение | Описание |
|----------|----------|----------|
| entryStopLossPercent | 18 | Stop-loss (E: 20→18) |
| hardStopPercent | 42 | Безусловный стоп (E: 48→42) |
| trailingActivationPercent | 30 | Trailing активация (E: 35→30) |
| trailingDrawdownPercent | 15 | Trailing откат (E: 18→15) |
| timeStopAfterMs | 420000 | 7 мин до выхода |
| takeProfit | 25%→15%, 80%→25%, 250%→25%, 700%→15% | 4 уровня (portions sum 0.80, 20% runner reserve) |
| runnerActivationPercent | 200 | Runner-tail activation |

#### Raydium (LaunchLab / CPMM / AMM v4)

Аналогичные параметры; подробности в `src/config.ts`.

### Copy-Trade (2-tier, brainstorm v4)

| Параметр | Значение | Описание |
|----------|----------|----------|
| enabled | true | CT-2 активирован |
| entryAmountSol | 0.06 | Tier 1 вход (WR≥60%, ≥15 trades) — E: 0.08→0.06 |
| tier2EntryAmountSol | 0.03 | Tier 2 вход (WR≥50%, ≥8 trades) — E: 0.04→0.03 |
| maxPositions | 3 | Макс позиций copy-trade |
| minBuySolFromTracked | 0.25 | Мин. сумма покупки от tracked wallet |
| slippageBps | 2000 | Slippage для copy-trade сделок |

**Wallet Tracker:**

| Параметр | Значение | Описание |
|----------|----------|----------|
| minCompletedTrades | 15 | Tier 1: минимум завершённых сделок |
| minWinRate | 0.60 | Tier 1: минимум win rate |
| tier2MinCompletedTrades | 8 | Tier 2: минимум завершённых сделок |
| tier2MinWinRate | 0.50 | Tier 2: минимум win rate |
| maxTrackedWallets | 2000 | Максимум отслеживаемых кошельков |
| Loss streak filter | T1: 5+, T2: 3+ | Пропускаем кошельки с серией лоссов |

### Defensive Mode (soft throttle)

| Параметр | Значение | Описание |
|----------|----------|----------|
| enabled | true | Промежуточный уровень между нормой и kill-switch |
| window | 10 | Минимум N сделок для оценки |
| entryThreshold | 0.40 | WR < 40% — включить defensive |
| exitThreshold | 0.50 | WR > 50% — выключить |
| scoreDelta | 5 | minTokenScore += 5 в defensive |
| entryMultiplier | 0.70 | entry × 0.70 в defensive |

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
