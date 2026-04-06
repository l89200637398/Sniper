# Стратегия и моделирование доходности

> Консолидация из v3.1_моделирование_сценариев.docx, sniper_technical_report.docx, sniper_structured_docs.docx
> Обновлено: 2026-04-06

---

## 1. Архитектура стратегии

Бот разделён на три канала с разными профилями риска:

| Канал | Entry | WR ожид. | Роль |
|-------|-------|----------|------|
| **Grinder** (pump.fun snipe) | 0.15 SOL | 15-25% | Стабильный cash-flow, объём |
| **Hunter** (runner-tail) | 0.15 SOL | 5-10% | Ловля монстр-ранеров ×5-×10 |
| **Copy-trade** (CT-2) | 0.08 SOL | 55-70% | Proven-edge от eligible кошельков |

### Kill-switches (защита капитала)

| Триггер | Действие |
|---------|----------|
| 3 consecutive losses | Пауза 10 минут |
| WR < 25% за 10 сделок | Пауза 10 минут (kill-switch) |
| WR < 40% за 10 сделок | Defensive mode: minScore+5, entry×0.70 |
| Invalid rate ≥ 70% за 20 bundles | Пауза 5 минут |

---

## 2. Sell execution pipeline

Порядок попыток sell (до 4 итераций):

1. **Jito bundle** (attempt 0-4): tip escalation 0.00003→0.0001 SOL
2. **Direct RPC** (attempt 1+): параллельно с Jito
3. **bloXroute** (attempt 3, финальная): только если tip ≤ 5% от proceeds
4. **Jupiter** (last resort): Metis V6 aggregator, RPC-only

При 4 failed attempts → force-close позиции.

---

## 3. Модель: 1 час торговли

Входные данные: ~10 CREATE/мин из gRPC. Scoring отсекает ~50% шум.

### Сценарий A: типичный час

| Группа | Кол-во | PnL/trade | Итого |
|--------|--------|-----------|-------|
| Early exit (нет buyer за 2с) | 12 | -0.0005 | -0.006 |
| Stop_loss | 4 | -0.030 | -0.120 |
| TP1→обвал | 2 | -0.002 | -0.004 |
| TP1-TP2 run | 1 | +0.015 | +0.015 |
| Social run до TP3+ | 0.5 | +0.090 | +0.045 |
| Copy-trade (3 сигнала) | 3 | +0.010 | +0.030 |
| **ИТОГО** | | | **-0.040 SOL/час** |

### С runner-tail (×5-×10 захват)

При текущей конфигурации runner-tail активируется 1-2 раза в день.
Один runner ×5 при entry 0.15 SOL = +0.60 SOL дополнительно.

---

## 4. Сценарии достижения +15 SOL/месяц

### Сценарий A: Минимальный капитал (0.5 SOL)

| Параметр | Значение |
|----------|----------|
| Entry | 0.15 SOL (pump.fun/PumpSwap) |
| Входов/день | 5-15 |
| Ожидаемый PnL/мес | -0.3 до +0.9 SOL |
| Вероятность +15 SOL | < 5% |

### Сценарий B: Рабочий (2 SOL)

| Параметр | Значение |
|----------|----------|
| Entry | 0.15 SOL + copy-trade 0.08 SOL |
| Copy-trade сигналов/день | 5-15 |
| PnL от copy-trade/день | +0.03 до +0.08 SOL |
| Ожидаемый PnL/мес | +1.5 до +3.3 SOL |
| Вероятность +15 SOL | < 15% |

### Сценарий C: Агрессивный (5-10 SOL)

| Параметр | Значение |
|----------|----------|
| Copy-trade entry | 0.20-0.50 SOL |
| Фокус | 80% copy-trade, 20% снайпер |
| Ожидаемый PnL/мес | +5 до +14 SOL |
| Вероятность +15 SOL | 25-40% |
| Минимальный рабочий баланс | 3 SOL |

### Сценарий D: Ставка на раннеры

| Параметр | Значение |
|----------|----------|
| Runner-tail | +100%/+200% activation |
| Прибыль от одного ×10 runner | ~1.2 SOL (при entry 0.15) |
| Нужно раннеров/мес для +15 SOL | ~12-15 |
| Реалистично раннеров/мес | 2-4 |
| Вклад в PnL | +0.3-0.6 SOL/мес |

---

## 5. Математическое ожидание (EV)

### Текущая конфигурация (апрель 2026)

```
Entry:           0.15 SOL (pump.fun/PumpSwap)
Avg Win:         +18% (+0.027 SOL)
Avg Loss:        -15% (-0.0225 SOL)
Win Rate:        ~25%
EV/trade:        0.25 × 0.027 - 0.75 × 0.0225 = -0.010 SOL

Copy-trade:
Entry:           0.08 SOL
Avg Win:         +25% (+0.020 SOL)
Avg Loss:        -20% (-0.016 SOL)
Win Rate:        ~60%
EV/trade:        0.60 × 0.020 - 0.40 × 0.016 = +0.006 SOL

Runner bonus (1-2/день при active market):
EV/runner:       ~+0.30-0.60 SOL
```

### Что определяет прибыльность

| Фактор | Влияние | Контроль |
|--------|---------|----------|
| Sell landing rate | КРИТИЧЕСКИЙ | v3 fixes + Jito escalation + bloXroute |
| Social run frequency | ВЫСОКИЙ | рынок (не контролируем) |
| Copy-trade quality | ВЫСОКИЙ | eligible кошельки (WR>65%, 20+ trades) |
| Runner capture | ВЫСОКИЙ | runner-tail (контролируем) |
| Buyer rate | СРЕДНИЙ | рынок (не контролируем) |
| Scoring quality | СРЕДНИЙ | двухэтапный + defensive mode |

---

## 6. Wallet Tracker — данные для copy-trade

За 1.5 часа работы tracker накапливает ~145 кошельков, из них ~33 eligible.

Критерии eligible:
- minCompletedTrades: 20
- minWinRate: 0.65 (65%)
- PnL-based win detection: sellSOL > buySOL × 0.98
- Fallback: holdTime 4-90 сек

### Copy-trade этапы

| Этап | Условие | Параметры | Статус |
|------|---------|-----------|--------|
| CT-1: Наблюдение | Мало данных | enabled=false | Пройден |
| CT-2: Ограниченный | 10+ eligible, WR>55% | entry 0.08, maxPos 3 | **АКТИВЕН** |
| CT-3: Расширенный | Стабильный decoder | entry 0.15, maxPos 5 | Следующий шаг |
| CT-4: Adaptive | Runtime classification | Вес по recent WR | Будущее |

---

## 7. KPI для принятия решений

| Метрика | Хороший | Плохой → действие |
|---------|---------|-------------------|
| Buy landing rate | > 40% | < 20% → увеличить tipAmountSol |
| Sell success rate | > 85% | < 70% → проверить feeRecipient |
| Win rate | > 25% | < 15% → повысить minTokenScore |
| Early exit % | < 50% | > 70% → увеличить earlyExitTimeoutMs |
| PnL/день | > +0.02 SOL | < -0.05 SOL → остановить, анализ |

---

## 8. Рекомендуемый порядок запуска

1. **День 1-2**: Запуск с SIMULATE=true, проверить sell landing
2. **День 3-5**: SIMULATE=false с малыми суммами, убедиться SELL_SUCCESS > 0
3. **День 5-7**: Включить полные entry (0.15 SOL), мониторить metrics
4. **Неделя 2+**: Оценить реальный PnL от каждого компонента, масштабировать copy-trade

### Честный ответ о +15 SOL/мес

При текущем entry 0.15 SOL и депозите 0.5-2 SOL — математически маловероятно.
Реалистичная цель: +2-5 SOL/мес при хорошем рынке и работающем copy-trade.
Для +15 SOL нужен депозит 5-10 SOL и copy-trade entry 0.20-0.50 SOL.
