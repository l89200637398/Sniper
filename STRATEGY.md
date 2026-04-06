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

1. **Jito bundle** (attempt 0-2): tip escalation 0.00003→0.0001 SOL (×1.5 per retry)
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
| Copy-trade quality | ВЫСОКИЙ | 2-tier eligible (T1: WR≥60%/15+, T2: WR≥50%/8+) |
| Runner capture | ВЫСОКИЙ | runner-tail (контролируем) |
| Buyer rate | СРЕДНИЙ | рынок (не контролируем) |
| Scoring quality | СРЕДНИЙ | двухэтапный + defensive mode |

---

## 6. Wallet Tracker — 2-tier copy-trade (brainstorm v4)

За 1.5 часа работы tracker накапливает ~145 кошельков. С 2-tier системой eligible ~100+.

### Tier 1 (Conservative)
- minCompletedTrades: 15
- minWinRate: 0.60 (60%)
- entryAmount: 0.08 SOL
- Loss streak skip: ≥5 consecutive losses

### Tier 2 (Aggressive)
- minCompletedTrades: 8
- minWinRate: 0.50 (50%)
- entryAmount: 0.04 SOL (half)
- Loss streak skip: ≥3 consecutive losses

### Win detection
- PnL-based: sellSOL > buySOL × 0.98 → win
- Fallback: holdTime 4-90 сек → win
- recentLosses tracking: сброс на каждом win

### Copy-trade этапы

| Этап | Условие | Параметры | Статус |
|------|---------|-----------|--------|
| CT-1: Наблюдение | Мало данных | enabled=false | Пройден |
| CT-2: 2-tier | 100+ eligible | T1: 0.08, T2: 0.04, maxPos 3 | **АКТИВЕН** |
| CT-3: Расширенный | Стабильный PnL | entry 0.15, maxPos 5 | Следующий шаг |
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

## 8. Поэтапный план запуска → 15+ SOL/неделю

### Фаза 0: Подготовка (день 0)

**Цель:** Убедиться что инфраструктура работает.

```bash
npx ts-node scripts/verify.ts          # ✅ Все layouts совпадают
SIMULATE=true npm run dev               # ✅ Запустить на 30 минут
npx ts-node scripts/analyze-trades.ts   # ✅ Проверить симуляцию
```

**Чеклист:**
- [ ] verify.ts проходит без ошибок
- [ ] gRPC стрим получает CREATE/BUY события
- [ ] Scoring отсекает ~50% шума
- [ ] Telegram бот отвечает на /status

**Депозит:** 0.5 SOL на кошельке (минимум для старта).

---

### Фаза 1: Калибровка (дни 1-3)

**Цель:** Подтвердить что sell pipeline приземляется, собрать baseline метрики.

**Конфигурация:**
```
entryAmountSol:     0.05 SOL  (снижен для калибровки)
SIMULATE:           false
maxPositions:       2
copyTrade.enabled:  false     (сначала только sniper)
```

**Мониторинг (ежедневно):**
| KPI | Целевое | Действие при отклонении |
|-----|---------|------------------------|
| Buy landing rate | > 40% | ↑ tipAmountSol |
| Sell success rate | > 85% | Проверить feeRecipient, endpoint |
| Win rate | > 20% | ↑ minTokenScore |
| PnL/день | > -0.03 SOL | Проверить exit params |

**Ожидаемый PnL:** -0.01 до +0.02 SOL/день (калибровочный).

**Решение на выход из фазы:** sell success ≥ 85%, buy landing ≥ 40% на 20+ trades.

---

### Фаза 2: Полный sniper (дни 4-7)

**Цель:** Выйти на стабильный базовый PnL от снайпинга.

**Конфигурация:**
```
entryAmountSol:     0.15 SOL  (штатный)
maxPositions:       4
copyTrade.enabled:  false     (ещё не включаем)
```

**Что проверяем:**
- Exit timing: early exits vs runners → tune trailing/TP ladder
- Defensive mode: триггерится ли при WR < 40%? Правильно ли возвращает WR > 50%?
- Runner-tail: ловим ли ×5-×10? (1-2 в день на активном рынке)

**Ожидаемый PnL:** 0 до +0.5 SOL/день (breakeven — уже хорошо).

**Решение:** WR ≥ 22%, sell success ≥ 85%, ≥50 trades. Вклад runners ≥ 30% PnL.

---

### Фаза 3: Copy-trade activation (дни 8-14)

**Цель:** Подключить 2-tier copy-trade, удвоить источники PnL.

**Конфигурация:**
```
copyTrade.enabled:  true
entryAmountSol:     0.08 SOL (T1) / 0.04 SOL (T2)
maxPositions:       3 (copy-trade)
```

**Предварительно:**
- [ ] WalletTracker накопил ≥ 50 eligible кошельков (T1+T2)
- [ ] Проверить в логах: isCopySignal срабатывает, tier определяется корректно
- [ ] Loss streak filter работает (кошельки с 3+ losses пропускаются)

**Мониторинг CT:**
| KPI | Целевое | Действие |
|-----|---------|----------|
| CT win rate (T1) | > 55% | Ничего, работает |
| CT win rate (T1) | < 45% | ↑ minWinRate до 0.65 |
| CT win rate (T2) | > 45% | Ничего |
| CT win rate (T2) | < 35% | Выключить T2 |
| CT PnL/день | > +0.03 SOL | Масштабировать |

**Ожидаемый PnL:** +0.2 to +0.8 SOL/день (sniper + copy-trade).

**Депозит к этому моменту:** 2-3 SOL на кошельке.

---

### Фаза 4: Масштабирование (недели 3-4)

**Цель:** Наращивать entry amounts по каналам с положительным EV.

**Действия по результатам фазы 3:**

| Условие | Действие |
|---------|----------|
| CT T1 WR > 55% стабильно | ↑ entryAmountSol: 0.08 → 0.15 SOL |
| CT T2 WR > 50% стабильно | ↑ tier2EntryAmountSol: 0.04 → 0.08 SOL |
| Sniper WR > 25% стабильно | ↑ entryAmountSol: 0.15 → 0.20 SOL |
| maxTotalExposureSol < 50% бюджета | ↑ maxTotalExposureSol |

**Конфигурация (цель):**
```
pumpFun.entryAmountSol:       0.20 SOL
pumpSwap.entryAmountSol:      0.20 SOL
copyTrade.entryAmountSol:     0.15 SOL (T1)
copyTrade.tier2EntryAmountSol: 0.08 SOL (T2)
maxPositions:                 6
maxTotalExposureSol:          1.20 SOL
```

**Ожидаемый PnL:** +0.5 to +2.0 SOL/день.

**Депозит:** 5-8 SOL.

---

### Фаза 5: 15+ SOL/неделю (неделя 4+)

**Цель:** Стабильные 15+ SOL/неделю = ~2.1 SOL/день.

**Что для этого нужно (модель EV):**

```
Sniper channel:
  Entry:    0.25 SOL × 20 trades/day
  WR:       25%
  Avg win:  +22% (+0.055 SOL)
  Avg loss: -18% (-0.045 SOL)
  EV/trade: 0.25×0.055 - 0.75×0.045 = -0.020 SOL
  Daily:    -0.40 SOL

Runner captures (1-2/day):
  Entry:    0.25 SOL, avg ×4 = +0.75 SOL each
  Daily:    +0.75 to +1.50 SOL

Copy-trade channel (T1+T2):
  Entry:    0.15-0.20 SOL × 10 signals/day
  WR:       55%
  Avg win:  +25% (+0.040 SOL)
  Avg loss: -15% (-0.025 SOL)
  EV/trade: 0.55×0.040 - 0.45×0.025 = +0.011 SOL
  Daily:    +0.11 SOL

Total daily: -0.40 + 1.00 + 0.11 = +0.71 SOL/day
Weekly:      +0.71 × 7 × 0.7 (market factor) = ~3.5 SOL/week
```

**Честно:** с текущим балансом 2 SOL и entry 0.15 — стабильные 15 SOL/неделя нереалистичны.

**Путь к 15+ SOL/week:**

| Рычаг | Эффект | Как |
|-------|--------|-----|
| ↑ Entry до 0.5 SOL (sniper) | ×3.3 PnL | Нужен баланс ≥ 10 SOL |
| ↑ CT entry до 0.3 SOL | ×3.7 CT PnL | Нужен баланс ≥ 10 SOL |
| ↑ maxPositions до 8-10 | ×2 throughput | Нужен баланс ≥ 15 SOL |
| Runner capture rate | Главный источник | Уже оптимизирован (runner-tail) |
| CT-3 расширенный | +50% CT volume | Нужно ≥200 eligible кошельков |

**Формула для 15 SOL/week:**
```
15 SOL / 7 дней = ~2.15 SOL/день

Нужно:
  Sniper: entry 0.30 SOL, 15 trades/day, 2 runners/day → ~+1.0 SOL/день
  CT:     entry 0.25 SOL, 15 signals/day, WR 55% → ~+0.4 SOL/день
  Runners: ×5 avg, 2/day × 0.30 SOL = +2.4 SOL/день (но нестабильно)
  
  Стабильный baseline: +1.4 SOL/день × 7 = ~10 SOL/week
  С учётом runners (2-3/week): +10 + 3-6 = 13-16 SOL/week

  Депозит: минимум 10 SOL, рекомендуется 15 SOL.
```

---

### Сводная таблица фаз

| Фаза | Дни | Депозит | Entry | PnL/день | PnL/нед |
|------|-----|---------|-------|----------|---------|
| 0: Подготовка | 0 | 0.5 | 0 (simulate) | 0 | 0 |
| 1: Калибровка | 1-3 | 0.5 | 0.05 | -0.01..+0.02 | ~0 |
| 2: Полный sniper | 4-7 | 1-2 | 0.15 | 0..+0.5 | 0-3.5 |
| 3: Copy-trade | 8-14 | 2-3 | 0.15+CT | +0.2..+0.8 | 1.5-5.5 |
| 4: Масштабирование | 15-21 | 5-8 | 0.20+CT | +0.5..+2.0 | 3.5-14 |
| 5: Целевой режим | 22+ | 10-15 | 0.30+CT | +1.5..+3.0 | **10-21** |
