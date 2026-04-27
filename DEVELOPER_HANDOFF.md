# Developer Handoff — Solana Sniper Bot v3

> Подробный комментарий для разработчика, который подхватит проект.
> Дата: 2026-04-07

---

## 1. Текущее состояние

### Что работает

| Протокол | Buy | Sell | Exit-логика | Pool Discovery | Статус |
|----------|-----|------|-------------|----------------|--------|
| Pump.fun | OK | OK | OK | PDA | Production-ready |
| PumpSwap | OK | OK | OK | PDA + cashback | Production-ready |
| Raydium LaunchLab | OK | OK | OK | getProgramAccounts | Работает, PDA нестабилен |
| Raydium CPMM | OK | OK | OK | getProgramAccounts | Работает |
| Raydium AMM v4 | OK | OK | OK | getProgramAccounts (wSOL preferred) | Работает |

### Подсистемы

- **Geyser gRPC стриминг**: работает, подписки на все 6 программ (pump.fun, PumpSwap, Mayhem, LaunchLab, CPMM, AMM v4)
- **Jito bundles**: работает, dynamic tips из getTipFloor, retry с escalation
- **Token scoring**: работает, 0-100 баллов
- **Safety checks**: работает (mint authority, freeze authority, rugcheck API)
- **Copy-trade (2-tier)**: T1: WR≥60%/15+ trades → 0.06 SOL; T2: WR≥50%/8+ trades → 0.03 SOL; maxPositions=3
- **Telegram бот**: работает, все команды
- **Console control**: `scripts/control.ts` — запуск/остановка без Telegram
- **Trade logging**: JSONL логи (events + trades)
- **Graceful shutdown**: SIGINT/SIGTERM, 30s timeout

### Новые подсистемы (апрель 2026)

- **Runner-tail**: после +100% PnL (pump.fun) / +200% (PumpSwap) расширяются trailing и hard stop. Цель — ловить монстр-ранеры ×5-×10
- **Defensive auto-throttle**: rolling WR < 40% → minTokenScore+5, entry×0.70 (hysteresis: выход при WR > 50%)
- **bloXroute fallback**: параллельная отправка sell через bloXroute BDN на финальной попытке, gated по % от proceeds
- **Jupiter fallback**: Jupiter Metis V6 aggregator как последнее средство sell (RPC-only)
- **Prometheus metrics**: endpoint на порту 9469 (/metrics, /snapshot)
- **Persisted createSlots**: createSlotForMint сохраняется на диск для точного age tracking

### Brainstorm v4 (апрель 2026)

- **Dynamic slippage**: `computeDynamicSlippage()` в `config.ts` — формула `sqrt(entry/liquidity) × maxBps`, min 300 bps. Снижает переплату на 3-5% при мелких входах
- **Batch RPC**: `checkPositions()` использует `getMultipleAccountsInfo()` вместо N sequential `getAccountInfo()` — 1 RPC call для всех позиций
- **Adaptive sell polling**: confirmation проверяется каждые 100ms (вместо fixed 500ms), maxWait Jito=600ms / directRpc=400ms
- **Priority fee escalation**: sell retry ×1.5 priority fee на каждом attempt (cap 5×), не только Jito tip
- **feeRecipient cache**: 5s TTL, исключает RPC вызов из sell retry loop
- **2-tier copy-trade**: T1 (WR≥60%, 15+ trades, 0.06 SOL), T2 (WR≥50%, 8+ trades, 0.03 SOL). Loss streak filter (T1: 5+, T2: 3+)
- **Holder concentration**: `getTokenLargestAccounts()` при entry scoring — top holder >50% = -25pts, >30% = -10pts
- **Aggregated buy-volume gate**: 2+ independent wallets с суммарно ≥0.5 SOL = fast entry
- **Jupiter pre-warm**: спекулятивно кешируем quote (5s TTL) для позиций с PnL>50% или age>30s
- **minTokenAgeMs**: 150→400ms — пропускаем bundled dev-buys, фильтруем same-block rugs

### Brainstorm v5 (апрель 2026)

**Баг-фиксы:**
- `executeFullSell()` sellingMutex — все 6+ call paths защищены от race condition
- Dual-queue в GeyserClient — CREATE events получают приоритет
- `safeNumber()` helper для BigInt→Number overflow detection (>2^53)
- Jito burst уникальные подписи через `burstIndex` offset
- ATA balance перечитывается между sell retries (partial sells)
- `confirmTransaction` → `getSignatureStatuses` polling (нет blockhash mismatch)
- PumpSwap fee 30→125 bps (правильное значение)
- `Math.max(0, solReceived)` в closeAllPositions
- Jito queue retries идут в конец очереди

**Оптимизации:**
- `detectProtocol()` кэш — permanent для terminal states, 5s TTL для pump.fun
- Rugcheck параллельно с social check (экономия 200-500ms)

**EV-улучшения:**
- TP ladder portions = 0.80 (20% runner reserve для mega-runners)
- Post-entry scoring gate — подтверждённые покупки с низким score → немедленный exit
- Entry 0.15→0.10 SOL (экономия ~1.5pp slippage)
- `safety.ts` null account → unsafe (было ошибочно safe: true)

**Калибровка фильтров:**
- Stop-loss 20→18%, slippage 2500/1800→2000/1500 bps
- PumpSwap: trailing 35→30% activation, 18→15% drawdown, hard stop 48→42%
- Time stop pump.fun 60→45s, loss pause 10→15 min
- Copy-trade entry: T1 0.08→0.06, T2 0.04→0.03 SOL

**Новые функции:**
- Balance floor: не торгуем при балансе < 0.5 SOL (`minBalanceToTradeSol`)
- Token/creator blacklist + Telegram-команды (`/blacklist`, `/unblacklist`, `/blacklist_creator`, `/blacklist_stats`)
- JitoRateLimiter: token bucket (10 RPS)

### Post-audit fixes (апрель 2026)

- **LaunchLab migration routing** (`sell-engine.ts`): sell через LaunchLab автоматически fallback на CPMM → AMM v4 если пул мигрировал
- **Rescue sell** (`sniper.ts`): при force-close перечитывается ATA, финальная попытка Jupiter sell (5000 bps) для спасения runner reserve
- **Dynamic sell slippage** (`config.ts`): `computeDynamicSellSlippage()` — urgent ×2.5, velocity_drop ×2.0, trailing ×1.5, take_profit ×1.3
- **Ghost position prevention** (`sniper.ts`): optimistic timeout проверяет ATA баланс перед удалением (Pump.fun + PumpSwap)

### Senior audit fixes (апрель 2026)

- **Jito tip cache TTL** 10s→1.5s — tip floor может 10x за секунды при хайпе
- **Jupiter timeout** 10s→2s — быстрый fallback при панике
- **Detector cache** pump.fun 5s→1s — уменьшена слепая зона миграции
- **Jito tips** tipAmountSol 0.00003→0.00005, minTip 0.000015→0.0001
- **TP race condition** — `pendingTpLevels` lockTpLevel/unlockTpLevel в position.ts

### Что в процессе

- Полное тестирование в реальном режиме (не SIMULATE)
- Оптимизация exit-параметров на основе реальных данных
- Мониторинг P&L через metrics endpoint
- Web UI Dashboard — замена Telegram-бота (см. `WEBUI_SPEC.md`)

### Поэтапный план: от 3 SOL к 15+ SOL/неделю

> **EV-FIX (апрель 2026)**: Полный пересмотр EV-модели. Старый 4-уровневый TP ladder
> имел отрицательное/нулевое EV при micro-entries. Заменён на "Binary + Runner".
> Подробный математический анализ — см. `PROJECT.md` → "EV-positive restructuring".

**Фаза 0 — Валидация (3 SOL депозит, EV-positive конфиг)**
- Entry: 0.10 SOL, maxPositions: 4, maxExposure: 0.45 SOL
- **TP: Binary + Runner** — TP1 +50% (sell 40%), 60% rides trailing stop
- Stop-loss: 15% (было 18%, экономия 0.003 SOL/loss)
- Copy-trade T2 (0.03 SOL): binary exit (100% sell при первом TP)
- Цель: 50+ сделок, подтверждение EV > 0
- Метрики: WR > 25%, avg PnL > -1%, sell success rate > 85%
- Ожидание при 30% WR: +0.84 SOL/day = **+5.9 SOL/week**
- Если WR < 22% за 50 сделок → пересмотреть scoring/entry filters

**Фаза 1 — Первое масштабирование (6-8 SOL депозит)**
- Entry: 0.15 SOL, maxPositions: 5, maxExposure: 0.75 SOL
- Copy-trade T1: 0.10 SOL, T2: 0.05 SOL (T2 всё ещё binary exit)
- С 0.15 SOL entry можно добавить промежуточный TP: [50%/0.30, 200%/0.20, runner 50%]
- Ожидание: ~4-8 SOL/неделю при WR 28%+ и 2-3 runners/неделю
- Переход: после 150+ сделок с подтверждённой EV и bankroll > 6 SOL

**Фаза 2 — Полное масштабирование (15-20 SOL депозит)**
- Entry: 0.30 SOL, maxPositions: 8, maxExposure: 2.40 SOL
- maxPumpFunPositions: 5, maxPumpSwapPositions: 2
- С 0.30 SOL entry TP ladder снова оправдан: [40%/0.25, 120%/0.25, 400%/0.15, runner 35%]
- Copy-trade T1: 0.20 SOL (partial TP OK), T2: 0.10 SOL (binary exit)
- Ожидание: ~10-25 SOL/неделю (зависит от рынка и runners)
- 15+ SOL реалистично при 3+ runners ×5 avg в неделю

**Ключевые зависимости для 15+ SOL/неделю:**
- WR > 25% (при Binary + Runner структуре, 25% WR = breakeven; 30% = +5.9 SOL/week)
- Landing rate Jito > 50% (текущий tip 0.0001 SOL minimum)
- Runner tail: 40% позиции остаётся после TP — это основной генератор EV
- Jupiter через Jito (не public mempool): предотвращает MEV sandwich на fallback sells
- Non-blocking blockhash: sell-path не блокируется при перегрузке RPC
- Sell success > 85% (4-канальный pipeline: Jito→RPC→bloXroute→Jupiter, все через private tx)

---

## 2. Известные баги и workaround-ы

### Jito "Invalid" bundle status
**Проблема**: QuickNode с Lil JIT addon иногда возвращает статус "Invalid" для bundles, которые реально прошли on-chain.

**Workaround**: В `src/core/sniper.ts` добавлен on-chain fallback — при получении N подряд "Invalid" статусов, проверяем `getSignatureStatuses`. Если транзакция подтверждена — позиция сохраняется. Это есть для pump.fun (~line 1978) и PumpSwap (~line 2680) confirm flows.

**Корневая причина**: JITO_BUNDLE_URL/JITO_STATUS_URL не были установлены в .env, бот использовал обычный RPC вместо Jito endpoint. Исправлено fallback на JITO_RPC в config.ts.

### LaunchLab PDA calculation
**Проблема**: Расчёт PDA для LaunchLab пулов нестабилен — seeds `['pool', mintA, mintB]` не всегда дают правильный адрес.

**Workaround**: Используется `getProgramAccounts` fallback с фильтром по mintA.

**Что нужно**: Изучить актуальные PDA seeds в raydium-sdk-V2 и исправить.

### LaunchLab быстрая миграция (СМЯГЧЕНО)
**Проблема**: Пулы LaunchLab мигрируют за минуты (status=0 -> status=250). К моменту sell'а пул уже мигрирован.

**Решение**: `sell-engine.ts` теперь при ошибке "migrated" автоматически переключается на CPMM → AMM v4 fallback. Sell больше не падает при миграции пула.

### AMM v4 instruction index
**Ситуация**: Код использует SwapBaseInV2 (instruction index 16) без OpenBook аккаунтов. Это работает для большинства пулов, но legacy пулы могут требовать SwapBaseIn (index 9) с OpenBook.

**Рекомендация**: Если появятся ошибки "insufficient accounts" на AMM v4, рассмотреть fallback на index 9 с OpenBook accounts.

---

## 3. TODO (что делать дальше)

### Высокий приоритет
- [ ] Полноценное тестирование в production с entry 0.10 SOL (обновлено с 0.15)
- [ ] Мониторинг P&L: анализ trades.jsonl + metrics endpoint (порт 9469)
- [ ] LaunchLab: исправить PDA seeds для pool discovery
- [ ] Валидация runner-tail и defensive mode на реальных данных
- [ ] Проверить post-entry scoring gate на реальных сделках

### Средний приоритет
- [x] Dashboard/метрики: Prometheus endpoint реализован (win rate, sell paths, exposure)
- [x] Оптимизация Jito tips: tip 0.00003, max 0.0001, urgentMaxTipImmediate
- [x] Balance floor (F6): остановка торговли при балансе < 0.5 SOL
- [x] Token/creator blacklist (F7): Telegram-команды для управления
- [x] Jito rate limiter: token bucket 10 RPS
- [x] Protocol detection cache: permanent для terminal states, 5s TTL для pump.fun
- [x] Sell mutex: все call paths защищены от race condition
- [x] TP ladder rebalance: portions 0.80 + 20% runner reserve → **заменено на "Binary + Runner" (EV-fix)**
- [ ] Token-2022 тестирование для CPMM
- [ ] Расширить rugcheck: больше источников, кэширование
- [ ] Рассмотреть WebSocket fallback при потере gRPC соединения
- [ ] Kelly criterion auto-sizing для entry (пока не реализован)

### Низкий приоритет
- [ ] Web UI для мониторинга (вместо только Telegram)
- [ ] Backtesting framework на исторических данных gRPC
- [ ] Multi-wallet support
- [ ] Автоматическая ребалансировка SOL между trading/fee кошельками

---

## 4. Критические файлы

### `src/core/sniper.ts` (~4300+ строк)
**Самый важный файл**. Содержит:
- Всю логику entry для всех протоколов
- Confirm flow (проверка статуса Jito bundles)
- Exit signal detection и sell triggering
- Position lifecycle management
- Copy-trade логику
- Defensive auto-throttle (getEffectiveMinScore, getEffectiveEntry)
- bloXroute/Jupiter fallback sell paths
- Metrics counters (sell paths, wins/losses)

**Осторожно**: Файл большой и сложный. Изменения в нём влияют на всю торговую логику. При изменениях тщательно тестировать в SIMULATE mode.

### `src/config.ts`
Все торговые параметры. Изменения влияют на P&L напрямую. Особо критичны:
- `maxTotalExposureSol` — максимальный риск
- `entryAmountSol` — сумма входа
- `exit.*` — все параметры выхода
- `jito.tipAmountSol` — скорость исполнения

### `src/constants.ts`
On-chain layouts. Если протоколы обновят smart contracts, offset'ы здесь устареют. Проверять через `scripts/verify.ts`.

### `src/geyser/client.ts`
gRPC подписки. Ошибка здесь = бот не видит токены. Проверять:
- Все нужные program ID в фильтрах
- Обработка переподключений
- Размер event queue (maxEventQueueSize = 10000)

### `src/infra/jito-rate-limiter.ts`
Token bucket rate limiter (10 RPS). Предотвращает 429 ошибки от Jito endpoint. Используется в `jito/bundle.ts`.

### `.env`
Содержит приватные ключи. НИКОГДА не коммитить. Нет в .gitignore? Проверить.

### `data/positions.json`
Персистентные позиции. Не удалять при работающем боте. При corrupt — удалить и перезапустить (открытые позиции потеряются).

---

## 5. Архитектурные решения

### Почему EventEmitter, а не прямые вызовы
GeyserClient эмитит события, Sniper подписывается. Это:
- Позволяет backpressure через event queue с ограничением (10k)
- Развязывает парсинг gRPC от торговой логики
- Упрощает добавление новых протоколов (новый event → новый handler)

### Почему Jito, а не обычные транзакции
- MEV protection: транзакция не видна в mempool до включения в блок
- Скорость: bundle попадает напрямую к block producer
- Atomic: bundle либо полностью проходит, либо полностью отклоняется

### Почему p-limit для Jito queue
Jito endpoint имеет rate limits. `p-limit(20)` ограничивает параллельные submissions. Без этого — 429 ошибки и потеря bundles.

### Почему "Binary + Runner" TP (апрель 2026, заменяет 4-уровневый tiered)
4-уровневый TP ladder (12/30/80/200%) был математически убыточен при micro-entries (0.10 SOL):
- TP1 при +12% давал 0.0012 SOL — меньше стоимости Jito retry
- 4 sell-транзакции = ~0.001 SOL overhead (10%+ от типичного профита)
- К TP4 продано 80% позиции — runner (20%) не компенсирует убытки

Новый подход: 2 уровня. TP1 при +50% (sell 40%) — покрывает все costs + фиксирует profit.
TP2 при +200% (sell 20%). Остальные 40% — runner с trailing stop.
EV: +0.012 SOL/trade при 30% WR (вместо ~0 или отрицательного).

Для micro-позиций (<0.05 SOL, copy-trade T2): binary exit — 100% sell при первом TP.
Partial sells на 0.03 SOL: round-trip cost 3.7% → любой TP < 10% = чистый минус.

### Почему per-protocol exit params
Разные протоколы = разная волатильность:
- Pump.fun: bonding curve, быстрые пампы/дампы → tight stops
- PumpSwap: AMM, более стабильно → wider stops, longer timeouts
- Raydium: зависит от пула, ликвидности

### Почему getCachedBalance вместо прямых RPC вызовов
Баланс кошелька запрашивается часто (проверка перед каждым entry). Кэш с TTL снижает нагрузку на RPC в 10-20 раз.

---

## 6. Как развернуть

### Минимальные требования
- Node.js 18+
- ~512MB RAM
- Стабильное интернет-соединение (gRPC стрим)
- Solana кошелёк с SOL (минимум 0.5 SOL рекомендуется)

### Обязательные .env переменные
```
PRIVATE_KEY      — base58 приватный ключ
PUBLIC_KEY       — публичный ключ
RPC_URL          — Solana RPC (рекомендуется QuickNode/Helius)
BOT_TOKEN        — Telegram bot token
GRPC_ENDPOINT    — Yellowstone gRPC endpoint
GRPC_TOKEN       — токен gRPC
JITO_RPC         — Jito-совместимый endpoint
```

### Порядок проверки

1. **Verify layouts**: `npx ts-node scripts/verify.ts`
   - Все on-chain layouts должны совпадать
   - Config consistency checks должны пройти
   - Если FAIL → не запускать в production

2. **Test protocols**: `SIMULATE=true npx ts-node scripts/test-trade.ts <MINT>` для каждого протокола

3. **Simulate**: `SIMULATE=true npm run dev` — запустить бот на 20-30 минут, проверить логи

4. **Production**: убрать SIMULATE, запустить с малыми суммами

### Мониторинг

- Логи: `logs/bot-YYYY-MM-DD.log` (Pino JSON)
- События: `logs/events-YYYY-MM-DD.log` (JSONL)
- Сделки: `logs/trades.jsonl`
- Позиции: `data/positions.json`
- Telegram: бот отправляет уведомления о сделках

---

## 7. Частые вопросы

**Q: Бот не видит новые токены**
A: Проверить gRPC соединение. Логи покажут reconnect/disconnect. Проверить GRPC_ENDPOINT и GRPC_TOKEN.

**Q: Все bundles "Invalid"**
A: Проверить JITO_RPC в .env. Должен быть Jito-совместимый endpoint (QuickNode с Lil JIT, или dedicated Jito RPC).

**Q: Как изменить сумму входа?**
A: `src/config.ts` → `strategy.pumpFun.entryAmountSol` (и аналогично для других протоколов).

**Q: Как отключить протокол?**
A: Установить maxPositions для протокола в 0 (например, `maxRaydiumLaunchPositions: 0`).

**Q: Как добавить кошелёк для copy-trade?**
A: WalletTracker автоматически отслеживает кошельки. Параметры: `walletTracker.minWinRate`, `walletTracker.minCompletedTrades`.

**Q: Что будет при аварийном завершении?**
A: Позиции сохранены в `data/positions.json`. При перезапуске бот подхватит их и продолжит мониторинг.
