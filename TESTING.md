# TESTING.md — Тестирование Sniper Bot v3

> Обновлено: 2026-04-19

## Подготовка

```bash
npm install
npm run build                # проверить компиляцию
cat .env                     # PRIVATE_KEY, PUBLIC_KEY, RPC_URL, GRPC_ENDPOINT, GRPC_TOKEN
```

---

## Часть 1: Prestart verification (verify.ts)

```bash
npx ts-node scripts/verify.ts
```

**Проверяет:**
- RPC connectivity + slot
- GlobalAccount layout (fee_recipient offsets)
- BondingCurve layout (reserves, cashback_enabled)
- PumpSwap Pool layout (base_mint, quote_mint = WSOL)
- Instruction discriminators
- Program IDs (base58 validation)
- Config consistency:
  - Position limits: maxPositions ≤ sum per-protocol
  - Exposure: maxTotalExposureSol reasonable
  - Entry amounts: min < default per protocol
  - Jito tips: min ≤ max, escalation within bounds
  - Exit params: hardStop > stopLoss, trailing activation > drawdown
  - TP: portions sum 0.65–1.0, levels ascending
  - Token age: min < max
  - Slippage: 100–10000 bps

**Ожидание:** `VERIFY COMPLETE — ALL CHECKS PASSED`, exit code 0.

---

## Часть 2: Simulation тесты (SIMULATE=true, без SOL)

### 2.1 Raydium CPMM
```bash
npx ts-node src/test-raydium.ts <CPMM_MINT> cpmm
```

### 2.2 Raydium AMM v4
```bash
npx ts-node src/test-raydium.ts <AMM_V4_MINT> ammv4
```

### 2.3 Raydium LaunchLab
```bash
npx ts-node src/test-raydium.ts <LAUNCHLAB_MINT> launchlab
```

### 2.4 Auto-detect
```bash
npx ts-node src/test-raydium.ts <ANY_RAYDIUM_MINT>
```

### 2.5 PumpSwap
```bash
npx ts-node src/test-pumpswap.ts <PUMPSWAP_MINT>
```

### 2.6 Pump.fun bonding curve
```bash
SIMULATE=true npx ts-node scripts/test-trade.ts <PUMPFUN_MINT> 15 0.001
```

**Как найти тестовые mint'ы:** см. Solscan по адресам программ в CLAUDE.md.

---

## Часть 3: Buy+Sell (нужен ≥ 0.02 SOL)

```bash
npx ts-node scripts/test-trade.ts <MINT> 15 0.001
```

Скрипт auto-detect определяет протокол, делает buy → hold → sell.

**Проверять для каждого протокола:**
- pump.fun: `Protocol: pump.fun`, buy_exact_sol_in
- pumpswap: `Protocol: pumpswap`, pool PDA
- raydium-cpmm: `Protocol: raydium-cpmm`, SwapBaseIn
- raydium-ammv4: `Protocol: raydium-ammv4`, instruction index 9
- raydium-launch: `Protocol: raydium-launch`, BuyExactIn (status=0 only)

---

## Часть 4: Safety & Resilience тесты

### 4.1 Jupiter TX validation (C1)

**Что тестируем:** malicious Jupiter API response не подписывается.

**Проверка:** в `src/trading/jupiter-buy.ts` и `jupiter-sell.ts` — `validateJupiterTx()` проверяет payer, inputMint, outputMint в account keys до `tx.sign()`.

**В логах при невалидной TX:**
```
[jupiter-buy] TX does not include payer — possible malicious response
```

### 4.2 Break-even after TP1 (C2)

**Что тестируем:** после первого partial sell стоп-лосс сдвигается на уровень входа.

**Проверка:** запустить бота, дождаться TP1 → стоп-лосс в логах показывает 0% (BE) вместо -15%.

**Также тестирует:** `pendingTpLevels` — пока TX TP sell in-flight, стоп-лосс уже на BE (race condition guard).

### 4.3 Sell circuit-breaker (H6)

**Что тестируем:** 2 одинаковых sell-ошибки подряд → skip retry, jump to Jupiter.

**В логах:**
```
SELL_CIRCUIT_BREAK: <error> (2 identical errors)
```

### 4.4 ATA pre-check

**Сценарий:** пустой ATA → позиция удаляется без sell.

```
ATA balance 0 for <mint> — removing phantom position
```

### 4.5 Force-close после 4 попыток

```
FORCE_CLOSE: <mint> after MAX_SELL_ATTEMPTS=4
```

### 4.6 Backup RPC failover (H3)

**Что тестируем:** при 429/timeout переключение на BACKUP_RPC_URL.

**Проверка:** задать `BACKUP_RPC_URL` в .env, наблюдать в логах:
```
[rpc] Switching to backup RPC for 30s: <reason>
```

Через 30s возвращается на primary.

### 4.7 Migration pool size check (H4)

**Что тестируем:** pool data < 301 bytes → не кэшируется как migrated, повторная проверка.

**Проверка:** пул в процессе миграции не вызывает routing на неинициализированный PumpSwap pool.

### 4.8 Sentinel silence detection

**Что тестируем:** нет событий > 5 мин → `SENTINEL_SILENCE` в логах.

---

## Часть 5: Kill-switch тесты

### 5.1 Consecutive losses (3 → пауза 15 мин)

Запустить бота, дождаться 3 подряд losses → в логах:
```
LOSS_PAUSE: 3 consecutive losses, pausing 900000ms
```

### 5.2 Win rate kill-switch (< 25% за 10 сделок)

```
TRADE_QUALITY_PAUSE: win rate XX% < 25%, pausing 15 min
```

### 5.3 Defensive mode (WR < 40%)

При WR < 40% за последние 10 сделок → minTokenScore +5, entry ×0.70.
При WR > 50% → отключается.

### 5.4 Balance check

При балансе < 0.5 SOL (`minBalanceToTradeSol`):
```
BUY_SKIPPED_BALANCE: insufficient balance
```

---

## Часть 6: Copy-trade CT-2

**Текущие пороги:**
- Tier 1: WR ≥ 60%, ≥ 15 trades, entry 0.06 SOL
- Tier 2: WR ≥ 50%, ≥ 8 trades, entry 0.03 SOL

```bash
# Проверить eligible кошельки
node -e "
const data = require('./data/wallet-tracker.json');
const t1 = Object.entries(data).filter(([,v]) => v.winRate >= 0.60 && v.completedTrades >= 15);
const t2 = Object.entries(data).filter(([,v]) => v.winRate >= 0.50 && v.completedTrades >= 8 && !(v.winRate >= 0.60 && v.completedTrades >= 15));
console.log('T1 eligible:', t1.length, '| T2 eligible:', t2.length);
"
```

---

## Часть 7: Регрессионные тесты дискриминаторов

| Протокол | Инструкция | Дискриминатор |
|----------|-----------|---------------|
| PumpSwap buy | `buy` | `66063d1201daebea` |
| PumpSwap buy_exact_quote_in | alt | `c62e1552b4d9e870` |
| PumpSwap sell | `sell` | `33e685a4...` |
| Raydium LaunchLab BuyExactIn | | `faea0d7bd59c13ec` |
| Raydium CPMM SwapBaseIn | | `8fbe5adac41e33de` |
| Raydium AMM v4 SwapBaseIn | data[0] = 9 | — |

---

## Часть 8: Post-trade analysis

```bash
npx ts-node scripts/analyze-trades.ts --full
npx ts-node scripts/recommend-config.ts --full
```

**Ожидаемые секции analyze-trades:**
- 📊 Общая статистика (WR, PnL, avg hold time)
- 📡 Социальная корреляция (buzz vs no-buzz)
- 📅 Pre-buy anticipation (lead-time distribution)

---

## Чек-лист: порядок тестирования

### Этап 1: Offline / Simulation
- [ ] verify.ts passes (all checks)
- [ ] Raydium CPMM/AMM v4/LaunchLab simulation
- [ ] PumpSwap simulation (standard + Token-2022)
- [ ] Pump.fun simulation (SIMULATE=true)
- [ ] Дискриминаторы совпадают

### Этап 2: Buy+Sell (≥ 0.02 SOL)
- [ ] PumpSwap buy+sell
- [ ] Raydium CPMM buy+sell
- [ ] Raydium AMM v4 buy+sell
- [ ] Raydium LaunchLab buy+sell (active pool)
- [ ] Pump.fun buy+sell

### Этап 3: Боевые тесты
- [ ] ATA pre-check (пустой ATA → remove)
- [ ] Force-close после 4 попыток
- [ ] Circuit-breaker (2 identical errors → Jupiter)
- [ ] Break-even after TP1
- [ ] Kill-switch: 3 consecutive losses → pause 15 min
- [ ] Defensive mode: WR < 40% → tighten
- [ ] Balance check: < 0.5 SOL → skip
- [ ] Copy-trade CT-2 (T1/T2 eligible)
- [ ] SELL landing rate ≥ 90%
- [ ] Backup RPC failover (if BACKUP_RPC_URL set)
- [ ] Sentinel silence (5 min no events)

---

## Распространённые ошибки

| Код | Название | Причина |
|-----|----------|---------|
| 6023 | Overflow | Arithmetic overflow в fee/amount calculation (PumpSwap) |
| 2014 | ConstraintTokenMint | Неверный mint для ATA аккаунта |
| 3012 | AccountNotInitialized | ATA не существует on-chain |
| 6000 | Custom | feeRecipient устарел |
| 6024 | Custom | Deprecated `buy` вместо `buy_exact_sol_in` (Pump.fun) |
| 6040 | SlippageExceeded | Цена изменилась |
