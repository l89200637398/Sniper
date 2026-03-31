# Developer Handoff — Solana Sniper Bot v3

> Подробный комментарий для разработчика, который подхватит проект.
> Дата: 2026-03-31

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
- **Copy-trade (CT-2)**: включён в конфиге, но требует тестирования в production
- **Telegram бот**: работает, все команды
- **Console control**: `scripts/control.ts` — запуск/остановка без Telegram
- **Trade logging**: JSONL логи (events + trades)
- **Graceful shutdown**: SIGINT/SIGTERM, 30s timeout

### Что в процессе

- Полное тестирование в реальном режиме (не SIMULATE)
- Оптимизация exit-параметров на основе реальных данных
- Мониторинг P&L

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

### LaunchLab быстрая миграция
**Проблема**: Пулы LaunchLab мигрируют за минуты (status=0 -> status=250). К моменту запуска теста пул уже мигрирован.

**Что это значит**: Тестирование LaunchLab bonding curve затруднено. При обнаружении мигрированного пула бот выбрасывает ошибку "Pool migrated (status=250), use CPMM/AMM v4 instead".

### AMM v4 instruction index
**Ситуация**: Код использует SwapBaseInV2 (instruction index 16) без OpenBook аккаунтов. Это работает для большинства пулов, но legacy пулы могут требовать SwapBaseIn (index 9) с OpenBook.

**Рекомендация**: Если появятся ошибки "insufficient accounts" на AMM v4, рассмотреть fallback на index 9 с OpenBook accounts.

---

## 3. TODO (что делать дальше)

### Высокий приоритет
- [ ] Полноценное тестирование в production с малыми суммами (0.01-0.02 SOL)
- [ ] Мониторинг P&L: анализ trades.jsonl, оптимизация exit-параметров
- [ ] LaunchLab: исправить PDA seeds для pool discovery
- [ ] Добавить алерты при ошибках (в Telegram или отдельный канал)

### Средний приоритет
- [ ] Dashboard/метрики: win rate, avg PnL, exposure, trades/hour
- [ ] Оптимизация Jito tips на основе реальных данных (сейчас conservative)
- [ ] Token-2022 тестирование для CPMM
- [ ] Расширить rugcheck: больше источников, кэширование
- [ ] Рассмотреть WebSocket fallback при потере gRPC соединения

### Низкий приоритет
- [ ] Web UI для мониторинга (вместо только Telegram)
- [ ] Backtesting framework на исторических данных gRPC
- [ ] Multi-wallet support
- [ ] Автоматическая ребалансировка SOL между trading/fee кошельками

---

## 4. Критические файлы

### `src/core/sniper.ts` (~2500+ строк)
**Самый важный файл**. Содержит:
- Всю логику entry для всех протоколов
- Confirm flow (проверка статуса Jito bundles)
- Exit signal detection и sell triggering
- Position lifecycle management
- Copy-trade логику

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

### Почему tiered take-profit
Одноуровневый TP неэффективен для meme-токенов:
- Слишком низкий — пропускаешь большие пампы
- Слишком высокий — никогда не срабатывает

Tiered подход: забрать часть на ранних уровнях (страховка), оставить часть на рост.

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
