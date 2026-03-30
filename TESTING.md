# TESTING.md — Полная инструкция по тестированию Sniper Bot v3

## Подготовка

```bash
# 1. Установить зависимости
npm install

# 2. Проверить .env файл
cat .env  # PRIVATE_KEY, PUBLIC_KEY, RPC_URL, GRPC_ENDPOINT, GRPC_TOKEN

# 3. Пополнить кошелёк минимум до 0.02 SOL для buy+sell тестов

# 4. Проверить компиляцию
npm run build
```

---

## Часть 1: Raydium — Simulation тесты (SIMULATE=true)

### 1.1 Raydium CPMM — simulation

**Как найти токен на Solscan:**
1. Открыть https://solscan.io/account/CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C (программа CPMM)
2. Вкладка **Transactions**
3. Искать транзакции с инструкцией `initialize` (создание пула)
4. Кликнуть на транзакцию → раздел **Token Balances** → найти mint-адрес НЕ-wSOL токена
5. Или: в **Account Input** смотреть аккаунт с `Associated Token Account` — нужен тот mint, который не `So11111111111111111111111111111111111111112`
6. Убедиться что пул имеет ликвидность: во вкладке **Token Balances** должен быть ненулевой баланс wSOL

**Быстрый поиск (альтернатива):**
- На странице программы CPMM → **Transactions** → фильтр по недавним → найти любой `SwapBaseIn` → в его аккаунтах найти mint

**Команда:**
```bash
npx ts-node src/test-raydium.ts <CPMM_MINT_ADDRESS> cpmm
```

**Ожидаемый результат:**
- Pool found: `<адрес>`
- Все поля pool state заполнены (mintA, mintB, vaults)
- Reserves ненулевые
- AMM math: корректный расчёт expected tokens
- `Simulation OK (XXX CU)` — симуляция прошла без ошибок

### 1.2 Raydium AMM v4 — simulation

**Как найти токен на Solscan:**
1. Открыть https://solscan.io/account/675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 (программа AMM v4)
2. Вкладка **Transactions**
3. Искать транзакции типа `SwapBaseIn` (instruction index = 9)
4. Кликнуть → в **Account Input** найти baseMint и quoteMint
5. Нужен baseMint (если quoteMint = wSOL) или quoteMint (если baseMint = wSOL)
6. Или: в **Token Balances** найти НЕ-wSOL токен

**Альтернатива — через Raydium UI:**
- Открыть https://raydium.io/swap/ → найти любую торгующуюся пару → скопировать адрес токена

**Команда:**
```bash
npx ts-node src/test-raydium.ts <AMM_V4_MINT_ADDRESS> ammv4
```

**Ожидаемый результат:**
- Pool found
- Pool state: baseMint, quoteMint, vaults, tradeFee (обычно 25 bps)
- openOrders, marketId, targetOrders — заполнены
- `Simulation OK`

### 1.3 Raydium LaunchLab — simulation

**Как найти токен на Solscan:**
1. Открыть https://solscan.io/account/LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj (программа LaunchLab)
2. Вкладка **Transactions**
3. Искать транзакции с `BuyExactIn` — это активные пулы
4. Кликнуть → в **Account Input** найти mintA (позиция [9] в аккаунтах инструкции)
5. **Важно:** пул должен иметь `status=0` (active). Если `status=1` — токен уже мигрировал на AMM

**Команда:**
```bash
npx ts-node src/test-raydium.ts <LAUNCHLAB_MINT_ADDRESS> launchlab
```

**Ожидаемый результат:**
- Pool found
- status=0 (active), virtualA/virtualB ненулевые
- migrateType: 0 (AMM v4) или 1 (CPMM)
- `Simulation OK`

### 1.4 Raydium auto-detect

```bash
# Скрипт сам определит протокол
npx ts-node src/test-raydium.ts <ANY_RAYDIUM_MINT_ADDRESS>
```

### 1.5 test-trade.ts с Raydium (SIMULATE=true)

```bash
# LaunchLab
SIMULATE=true npx ts-node scripts/test-trade.ts <LAUNCHLAB_MINT> 15 0.001

# CPMM
SIMULATE=true npx ts-node scripts/test-trade.ts <CPMM_MINT> 15 0.001

# AMM v4
SIMULATE=true npx ts-node scripts/test-trade.ts <AMM_V4_MINT> 15 0.001
```

**Ожидание:** скрипт определит протокол как `raydium-launch`/`raydium-cpmm`/`raydium-ammv4`, построит транзакцию, в режиме SIMULATE выведет симуляцию без отправки.

---

## Часть 2: PumpSwap и Pump.fun — Simulation тесты

### 2.1 PumpSwap + Token-2022

**Как найти на Solscan:**
1. Открыть https://solscan.io/account/pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA (PumpSwap)
2. Вкладка **Transactions**
3. Искать транзакции, где среди аккаунтов есть `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` (Token-2022 program)
4. Кликнуть → в **Token Balances** найти mint НЕ-wSOL токена

**Команда:**
```bash
npx ts-node src/test-pumpswap.ts <TOKEN2022_PUMPSWAP_MINT>
```

**Ожидание:**
- `isToken2022: true`
- `base_amount_out=1` (workaround для Overflow)
- `Simulation ✅ OK`

### 2.2 PumpSwap стандартный токен

```bash
npx ts-node src/test-pumpswap.ts <STANDARD_PUMPSWAP_MINT>
```

### 2.3 Pump.fun bonding curve

**Как найти на Solscan:**
1. Открыть https://solscan.io/account/6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P (Pump.fun)
2. Вкладка **Transactions**
3. Искать `buy_exact_sol_in` — это активные (не мигрированные) кривые
4. Кликнуть → в аккаунтах инструкции найти mint (обычно [2])
5. Проверить что кривая НЕ complete: в данных bonding curve байт[48] = 0

**Команда:**
```bash
SIMULATE=true npx ts-node scripts/test-trade.ts <PUMPFUN_MINT> 15 0.001
```

---

## Часть 3: Полный цикл buy+sell (SIMULATE=false, нужен SOL на кошельке)

> **Минимум: 0.02 SOL на кошельке**

### 3.1 PumpSwap buy+sell

```bash
npx ts-node scripts/test-trade.ts <PUMPSWAP_MINT> 15 0.001
```

**Ожидание:**
- Шаг 4b: `Protocol from on-chain: pumpswap`
- Шаг 7: `PUMP SWAP BUY sent: <txId>` → подтверждение
- Шаг 9: `SELL bundle sent: <txId>` → подтверждение
- Шаг 10: PnL (с учётом комиссий, ожидаем ~-0.001 SOL на комиссии)

### 3.2 Raydium CPMM buy+sell

```bash
npx ts-node scripts/test-trade.ts <CPMM_MINT> 15 0.001
```

**Ожидание:**
- Шаг 4b: `Protocol from on-chain: raydium-cpmm`
- Шаг 7: `RAYDIUM CPMM BUY sent: <txId>`
- Шаг 9: `SELL bundle sent: <txId>` (через sellTokenAuto → sellTokenCpmm)
- Шаг 10: PnL

### 3.3 Raydium AMM v4 buy+sell

```bash
npx ts-node scripts/test-trade.ts <AMM_V4_MINT> 15 0.001
```

### 3.4 Raydium LaunchLab buy+sell

```bash
npx ts-node scripts/test-trade.ts <LAUNCHLAB_MINT> 15 0.001
```

**Важно:** LaunchLab пул должен иметь status=0 (active). Мигрированные пулы не торгуются.

### 3.5 Pump.fun bonding curve buy+sell

```bash
npx ts-node scripts/test-trade.ts <PUMPFUN_ACTIVE_MINT> 15 0.001
```

---

## Часть 4: Тесты sell-логики (v3 fixes)

### 4.1 ATA pre-check (Custom:3012 fix)

**Сценарий:** При пустом ATA позиция должна удаляться без попытки sell.

**Как проверить:**
1. Запустить бота в режиме SIMULATE=false
2. Дождаться покупки токена
3. Вручную перевести все токены из ATA на другой адрес (через Phantom/CLI)
4. Наблюдать логи: бот должен обнаружить пустой ATA и удалить позицию без sell

**В логах ожидается:**
```
ATA balance 0 for <mint> — removing phantom position
```

### 4.2 Fresh feeRecipient на retry (Custom:6000 fix)

**Как проверить:**
1. Запустить бота в реальном режиме
2. Дождаться sell-attempt'а
3. В логах проверить: при retry sell должен получать свежий feeRecipient

**В логах:**
```
sellTokenAuto: ... → Pump.fun
```

### 4.3 Force-close после 4 попыток

**Как проверить:**
1. Запустить бота → дождаться позиции
2. Если sell неуспешен 4 раза подряд → позиция должна быть закрыта принудительно

**В логах:**
```
FORCE_CLOSE: <mint> after MAX_SELL_ATTEMPTS=4
```

### 4.4 confirmationStatus + err проверка

**Что проверять:** Reverted транзакция не считается успешной.

**В логах при sell:**
```
SELL CONFIRMED but has error: ...
```
Позиция НЕ удаляется, retry продолжается.

---

## Часть 5: Регрессионные тесты дискриминаторов

### 5.1 PumpSwap canonical buy (66063d1201daebea)

```bash
npx ts-node src/test-pumpswap.ts <PUMPSWAP_MINT>
```

**Проверка:** в выводе `disc: 66063d1201daebea`

### 5.2 PumpSwap buy_exact_quote_in (c62e1552b4d9e870)

**Как найти на Solscan:**
1. На странице PumpSwap программы → Transactions
2. Искать транзакции с disc `c62e1552b4d9e870` в данных инструкции
3. Или: в geyser логах бота при работе — событие с этим дискриминатором

**Проверка:** В geyser/client.ts код обрабатывает оба дискриминатора для PumpSwap buy.

### 5.3 PumpSwap sell (33e685a4...)

**Проверка:** при запуске test-trade.ts с PumpSwap токеном, sell использует дискриминатор `33e685a4...`.

### 5.4 Raydium LaunchLab BuyExactIn

```bash
npx ts-node src/test-raydium.ts <LAUNCHLAB_MINT> launchlab
```

**Проверка:** `Discriminator: faea0d7bd59c13ec` (= [250,234,13,123,213,156,19,236])

### 5.5 Raydium CPMM SwapBaseIn

```bash
npx ts-node src/test-raydium.ts <CPMM_MINT> cpmm
```

**Проверка:** `Discriminator: 8fbe5adac41e33de` (= [143,190,90,218,196,30,51,222])

### 5.6 Raydium AMM v4 SwapBaseIn

```bash
npx ts-node src/test-raydium.ts <AMM_V4_MINT> ammv4
```

**Проверка:** `Instruction index: 9` (или 16 для SwapBaseInV2)

---

## Часть 6: Preflight simulation для бандлов

**Сценарий:** перед отправкой Jito-бандла вызвать `simulateTransaction()`.

**Как проверить:**
1. Запустить test-trade.ts — он всегда делает симуляцию перед отправкой
2. Убедиться в логах: `Симуляция OK (XXX CU)` перед `BUY bundle sent`
3. Если симуляция ловит ошибку (6023, 2014) — транзакция НЕ отправляется, tip не тратится

**test-pumpswap.ts тоже делает simulation перед выводом результата.**

```bash
# Специально подать невалидный mint — симуляция должна упасть, bundle не отправится
npx ts-node src/test-pumpswap.ts 11111111111111111111111111111111
```

---

## Часть 7: Kill-switch тесты

### 7.1 Invalid rate kill-switch

**Что тестируем:** если 14+ из 20 последних бандлов = invalid → пауза 5 мин.

**Как проверить:**
1. Запустить бота в реальном режиме с маленьким балансом (~0.005 SOL)
2. Бот будет отправлять бандлы, которые будут fail'иться из-за недостатка SOL
3. После 14+ invalid → в логах должно появиться:
```
BUNDLE_QUALITY_PAUSE: invalid rate XX% > threshold, pausing 5 min
```

### 7.2 Win rate kill-switch

**Что тестируем:** если <25% win rate из 10 последних трейдов → пауза 10 мин.

**Как проверить:**
1. Запустить бота в реальном режиме
2. Дождаться 10+ трейдов
3. Если win rate < 25% → в логах:
```
TRADE_QUALITY_PAUSE: win rate XX% < 25%, pausing 10 min
```

**Примечание:** Эти тесты требуют длительной работы бота. Для ускорения можно временно уменьшить BUNDLE_QUALITY_WINDOW до 5 и TRADE_QUALITY_WINDOW до 3 в sniper.ts.

---

## Часть 8: Balance check

**Что тестируем:** бот НЕ отправляет buy при балансе < minEntryAmountSol.

**Как проверить:**
1. Убедиться что баланс кошелька < 0.005 SOL (минимальный порог)
2. Запустить бота: `npm run dev`
3. Наблюдать логи — при обнаружении нового токена должно быть:
```
BUY_SKIPPED_BALANCE: insufficient balance X.XXX SOL < Y.YYY required
```
4. Ни один buy НЕ отправляется

---

## Часть 9: Copy-trade CT-2

**Что тестируем:** copy-trade сигналы генерируются при покупке eligible кошельком >=0.1 SOL.

**Предварительные условия:**
- `copyTrade.enabled: true` в config.ts (уже включён)
- Файл `data/wallet-tracker.json` содержит накопленные кошельки
- Кошельки с winRate >= 65% и >= 20 трейдов = eligible

**Как проверить:**
1. Запустить бота в режиме SIMULATE=true: `SIMULATE=true npm run dev`
2. Подождать загрузки wallet-tracker данных (логи: `WalletTracker: loaded XXX wallets`)
3. Дождаться покупки eligible кошельком >= 0.15 SOL на Pump.fun/PumpSwap
4. В логах должно появиться:
```
COPY_TRADE_SIGNAL: wallet=XXXX, mint=YYYY, amount=Z.ZZ SOL
```

**Проверка eligible кошельков:**
```bash
# Вывести топ eligible кошельков из wallet-tracker.json
node -e "
const data = require('./data/wallet-tracker.json');
const eligible = Object.entries(data)
  .filter(([,v]) => v.winRate >= 0.65 && v.completedTrades >= 20)
  .sort((a,b) => b[1].winRate - a[1].winRate);
console.log('Eligible wallets:', eligible.length);
eligible.slice(0,10).forEach(([k,v]) => console.log(k.slice(0,8), 'WR:', (v.winRate*100).toFixed(0)+'%', 'trades:', v.completedTrades));
"
```

---

## Часть 10: SELL landing rate (полноценный тест)

**Что тестируем:** SELL_SUCCESS landing rate >= 90%.

**Как проверить:**
1. Запустить бота в реальном режиме (SIMULATE=false) с достаточным балансом (~0.1 SOL)
2. Дождаться 10+ sell-операций
3. Проанализировать trade log:

```bash
npx ts-node scripts/analyze-trades.ts
```

**Метрика:** из всех TRADE_CLOSE событий, доля с `reason !== 'ata_empty'` и `reason !== 'bundle_failed'` должна быть >= 90%.

---

## Чек-лист: порядок тестирования

### Этап 1: Simulation (без SOL, без риска)
- [ ] 1.1 Raydium CPMM simulation
- [ ] 1.2 Raydium AMM v4 simulation
- [ ] 1.3 Raydium LaunchLab simulation
- [ ] 1.4 Raydium auto-detect
- [ ] 2.1 PumpSwap + Token-2022 simulation
- [ ] 2.2 PumpSwap standard simulation
- [ ] 2.3 Pump.fun bonding curve simulation (SIMULATE=true)
- [ ] 5.1-5.6 Дискриминаторы: проверить в выводе скриптов
- [ ] 6 Preflight simulation (невалидный mint → ошибка, не отправка)

### Этап 2: Buy+Sell (нужен >= 0.02 SOL)
- [ ] 3.1 PumpSwap buy+sell
- [ ] 3.2 Raydium CPMM buy+sell
- [ ] 3.3 Raydium AMM v4 buy+sell
- [ ] 3.4 Raydium LaunchLab buy+sell (если найден active pool)
- [ ] 3.5 Pump.fun buy+sell

### Этап 3: Боевые тесты (длительная работа бота)
- [ ] 4.1 ATA pre-check
- [ ] 4.2 Fresh feeRecipient на retry
- [ ] 4.3 Force-close после 4 попыток
- [ ] 4.4 confirmationStatus + err
- [ ] 7.1 Kill-switch: invalid rate
- [ ] 7.2 Kill-switch: win rate
- [ ] 8 Balance check
- [ ] 9 Copy-trade CT-2
- [ ] 10 SELL landing rate >= 90%

---

## Полезные команды Solscan

```
# Программы
Pump.fun:         https://solscan.io/account/6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
PumpSwap:         https://solscan.io/account/pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
Raydium LaunchLab: https://solscan.io/account/LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj
Raydium CPMM:     https://solscan.io/account/CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
Raydium AMM v4:   https://solscan.io/account/675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
Token-2022:       https://solscan.io/account/TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb

# Проверка токена
https://solscan.io/token/<MINT_ADDRESS>

# Проверка транзакции
https://solscan.io/tx/<TX_ID>

# Jito Explorer
https://explorer.jito.wtf/bundle/<BUNDLE_ID>
```

## Распространённые ошибки

| Код | Название | Причина |
|-----|----------|---------|
| 6023 | Overflow | Arithmetic overflow в fee/amount calculation (PumpSwap) |
| 2014 | ConstraintTokenMint | Неверный mint для ATA аккаунта |
| 3012 | AccountNotInitialized | ATA не существует on-chain |
| 6000 | Custom | feeRecipient устарел, нужно обновить |
| 6024 | Custom | Использован deprecated `buy` вместо `buy_exact_sol_in` (Pump.fun) |
| 6040 | SlippageExceeded | Slippage превышен — цена изменилась |
