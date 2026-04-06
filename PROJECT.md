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
  index.ts                 # Entry point
  config.ts                # Все параметры конфигурации
  constants.ts             # Program IDs, discriminators, on-chain layouts
  core/                    # Ядро бота (sniper, position, detector, sell-engine, wallet-tracker)
  trading/                 # Построители транзакций по протоколам (+ jupiter-sell.ts)
  geyser/                  # gRPC клиент
  jito/                    # Jito bundle sending
  infra/                   # RPC, blockhash cache, priority fees, bloxroute
  bot/                     # Telegram бот
  utils/                   # Logger, retry, scoring, safety, social, metrics
scripts/
  verify.ts                # Проверка on-chain layouts (prestart hook)
  test-trade.ts            # Ручное тестирование сделок
  control.ts               # Консольный запуск без Telegram
  analyze-trades.ts        # Анализ JSONL логов
data/
  positions.json           # Персистентные позиции
  wallet-tracker.json      # Данные copy-trading
```

---

## 3. Руководство пользователя

### Установка

```bash
git clone <repo-url>
cd Sniper
npm install
```

### Настройка .env

Создайте файл `.env` в корне проекта:

```env
# Обязательные
PRIVATE_KEY=<base58 приватный ключ кошелька>
PUBLIC_KEY=<публичный ключ кошелька>
RPC_URL=<URL Solana RPC (QuickNode/Helius/etc)>
BOT_TOKEN=<Telegram bot token от @BotFather>
GRPC_ENDPOINT=<Yellowstone Geyser gRPC endpoint>
GRPC_TOKEN=<токен авторизации gRPC>

# Jito (рекомендуется QuickNode с Lil JIT addon)
JITO_RPC=<Jito-совместимый RPC URL>
# Или отдельно:
# JITO_BUNDLE_URL=<URL для отправки bundles>
# JITO_STATUS_URL=<URL для проверки статуса>

# Опционально
SIMULATE=true              # Режим симуляции (без реальных сделок)
TEST_MINT=<mint для verify.ts>
TEST_POOL_ADDRESS=<pool для verify.ts>
```

### Запуск

```bash
# Разработка (ts-node)
npm run dev

# Продакшен
npm run build
npm start          # verify.ts -> dist/index.js

# Симуляция
SIMULATE=true npm run dev

# Консольный режим (без Telegram)
npx ts-node scripts/control.ts
```

### Telegram-бот

После запуска бот доступен в Telegram. Основные команды:
- `/start` — запуск бота
- `/stop` — остановка
- `/status` — текущие позиции и состояние
- `/positions` — детали открытых позиций
- `/balance` — баланс кошелька
- `/config` — текущая конфигурация

### Режим симуляции

При `SIMULATE=true`:
- Транзакции собираются, но НЕ отправляются в сеть
- Все проверки (scoring, safety, liquidity) выполняются реально
- Полезно для проверки логики entry/exit без риска потери средств

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
- Количество недавних токенов от создателя (>3 = снижение)
- Social signals (Twitter/Telegram упоминания)
- Rugcheck API проверка
- Safety checks (mint authority, freeze authority)
- Ликвидность (минимальный порог)

### Jito MEV bundles

- Base tip: 0.000012 SOL
- Увеличение при retry: x1.2 за каждую попытку
- Max tip: 0.00005 SOL
- Max retries: 2
- Dynamic tip из getTipFloor percentiles

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
| entryAmountSol | 0.15 | Сумма входа по умолчанию (pump.fun, PumpSwap) |
| minEntryAmountSol | 0.05 | Минимальная сумма входа |
| minIndependentBuySol | 0.25 | Мин. сумма independent buyer для подтверждения |
| waitForBuyerTimeoutMs | 3000 | Время ожидания independent buyer |
| earlyExitTimeoutMs | 2000 | Быстрый выход при слабых токенах |
| maxTokenAgeMs | 20000 | Максимальный возраст токена для входа |
| minTokenAgeMs | 150 | Минимальный возраст (защита от same-block rugs) |
| minTokenScore | 50 | Минимальный score для входа |

### Jito

| Параметр | Значение | Описание |
|----------|----------|----------|
| tipAmountSol | 0.00003 | Базовый tip |
| maxTipAmountSol | 0.0001 | Максимальный tip |
| minTipAmountSol | 0.000015 | Минимальный tip |
| maxRetries | 5 | Максимум ретраев |
| tipIncreaseFactor | 1.3 | Множитель при retry |
| urgentMaxTipImmediate | true | Dump-сигнал сразу идёт с maxTip |

### Exit (по протоколам)

Каждый протокол имеет свои exit-параметры. Пример для Pump.fun:

| Параметр | Значение | Описание |
|----------|----------|----------|
| entryStopLossPercent | 20 | Stop-loss при входе |
| hardStopPercent | 40 | Безусловный стоп |
| trailingActivationPercent | 25 | Активация trailing stop |
| trailingDrawdownPercent | 9 | Откат для trailing stop |
| timeStopAfterMs | 60000 | Время до принудительного выхода |
| takeProfit | 4 уровня | 12%/30%/80%/200% |
| runnerActivationPercent | 100 | Активация runner-tail режима |
| runnerTrailDrawdownPercent | 40 | Расширенный trailing в runner mode |
| runnerHardStopPercent | 65 | Расширенный hard stop в runner mode |

### Copy-Trade

| Параметр | Значение | Описание |
|----------|----------|----------|
| enabled | true | CT-2 активирован |
| entryAmountSol | 0.08 | Вход по сигналу от proven-edge кошельков |
| maxPositions | 3 | Макс позиций copy-trade |
| minBuySolFromTracked | 0.25 | Мин. сумма покупки от tracked wallet |

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

## 8. Известные проблемы

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

## 9. Troubleshooting

| Ошибка | Причина | Решение |
|--------|---------|---------|
| Missing required env: X | Не установлена переменная .env | Проверить .env файл |
| getTipFloor failed | Неправильный Jito endpoint | Установить JITO_RPC в .env |
| Error 6023 (Overflow) | Отсутствует poolV2 PDA | Обновить код pumpSwap.ts |
| Error 2014 (ConstraintTokenMint) | Неправильный quoteMint для fee ATA | Использовать quoteMint из пула |
| Custom error 42 (AMM v4) | Пул не wSOL-paired | Pool discovery предпочитает wSOL |
| Pool migrated (status=250) | LaunchLab пул мигрировал | Использовать CPMM/AMM v4 |
| 100% Invalid bundles | Неправильный Jito endpoint | Установить JITO_RPC (не обычный RPC) |
| data/positions.json corrupt | Аварийное завершение | Удалить файл (потеряются позиции) |
