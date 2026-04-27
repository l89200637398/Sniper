# Стратегия и моделирование доходности

> Обновлено: 2026-04-19 (sync с config.ts)

---

## 1. Архитектура стратегии

Бот разделён на три канала с разными профилями риска:

| Канал | Entry | WR ожид. | Роль |
|-------|-------|----------|------|
| **Grinder** (pump.fun/pumpswap snipe) | 0.07 SOL | 15-25% | Стабильный cash-flow, объём |
| **Hunter** (runner-tail) | 0.07 SOL | 5-10% | Ловля монстр-ранеров ×5-×10 |
| **Copy-trade** (CT-2) | T1: 0.06 / T2: 0.03 SOL | 55-70% | Proven-edge от eligible кошельков |

### Kill-switches (защита капитала)

| Триггер | Действие |
|---------|----------|
| 3 consecutive losses | Пауза 15 минут |
| WR < 25% за 10 сделок | Пауза 15 минут (kill-switch) |
| WR < 45% за 10 сделок | Defensive mode: minScore+8, entry×0.70 |
| Invalid rate ≥ 70% за 20 bundles | Пауза 5 минут |

---

## 2. Sell execution pipeline

Порядок попыток sell (до 4 итераций):

1. **Jito bundle** (attempt 0-2): base tip 0.00005 SOL, escalation ×1.5/retry, max 0.00015 SOL, floor 0.0001 SOL
2. **Direct RPC** (attempt 1+): параллельно с Jito
3. **bloXroute** (attempt 3, финальная): только если tip ≤ 5% от proceeds
4. **Jupiter** (last resort): Metis V6 aggregator, RPC-only

**Circuit-breaker:** 2 одинаковых ошибки подряд → пропуск оставшихся ретраев, сразу Jupiter.

**Rescue:** если все 4 chain'а fail → финальная Jupiter sell со slippage 50%.

При полном провале → force-close позиции.

---

## 3. Take-Profit: 4-уровневая лестница + runner reserve

TP portions суммируются до **0.60** (60%), оставшиеся **40%** — runner reserve.
После TP1 срабатывает **break-even stop** (стоп-лосс на уровне входа).

### Pump.fun (SL 12%, trailing 7%, runner trailing 25%)

| Level | Trigger | Portion | Profit при entry 0.07 SOL |
|-------|---------|---------|--------------------------|
| TP1 | +35% | 15% | 0.0037 SOL |
| TP2 | +80% | 20% | 0.0112 SOL |
| TP3 | +250% | 15% | 0.0263 SOL |
| TP4 | +700% | 10% | 0.0490 SOL |
| Runner reserve | — | 40% | trailing stop |

### PumpSwap (SL 15%, trailing 10%, runner trailing 25%)

| Level | Trigger | Portion | Profit при entry 0.07 SOL |
|-------|---------|---------|--------------------------|
| TP1 | +40% | 15% | 0.0042 SOL |
| TP2 | +100% | 20% | 0.0140 SOL |
| TP3 | +300% | 15% | 0.0315 SOL |
| TP4 | +900% | 10% | 0.0630 SOL |
| Runner reserve | — | 40% | trailing stop |

---

## 4. Математическое ожидание (EV)

### Текущая конфигурация (апрель 2026)

```
Pump.fun snipe (EV-tuned, апрель 2026):
  Entry:           0.07 SOL
  Stop-loss:       -12% = -0.0084 SOL
  TP1 (35%/15%):   +0.0037 SOL
  Trailing (7%):   при peak +30% → exit +23% = 0.0161 SOL (full position)
  Avg Win:         ~+26% (+0.018 SOL) — средневзвешенный TP1-trailing
  Avg Loss:        -12% (-0.0084 SOL)
  Overhead:        0.00037 SOL (tips + priority + base fees)
  Win Rate ожид.:  ~28-33% (minTokenScore 60)
  EV/trade @30%:   0.30 × 0.018 - 0.70 × 0.0084 - 0.00037 = -0.001 SOL
  Breakeven WR:    (0.0084 + 0.00037) / (0.018 + 0.0084) = 33.2%

Copy-trade:
  Entry T1:        0.06 SOL, WR ~60%
  Entry T2:        0.03 SOL, WR ~50%
  EV/trade T1:     0.60 × 0.015 - 0.40 × 0.009 - 0.00037 = +0.0050 SOL
  EV/trade T2:     0.50 × 0.0075 - 0.50 × 0.0045 - 0.00037 = +0.0011 SOL

Runner bonus (1-2/день при active market):
  Entry:           0.07 SOL × 40% runner reserve = 0.028 SOL at risk
  Runner trail:    25% drawdown (pump.fun), 25% (PumpSwap)
  Avg runner ×5:   +0.134 SOL (reserve × (500%-20%))
  EV/runner:       +0.13 to +0.27 SOL
```

### Overhead breakdown (per completed trade)

```
Priority fee:    120k μlamports × 260k CU = 0.0000312 SOL × 2 sides = 0.0000624
Jito tips:       0.0001 SOL × 2 sides = 0.0002
Base fees:       0.000005 × 2 = 0.00001
Failed bundles:  ~0.0001 (tip на landed-with-error)
─────────────────────────────────────────────────────────────────
Total:           ~0.00037 SOL per round-trip
```

### Модель: 1 час торговли (после EV-tuning)

~10 CREATE/мин из gRPC. minTokenScore 60 отсекает ~60% шум.

| Группа | Кол-во | PnL/trade | Итого |
|--------|--------|-----------|-------|
| Early exit (нет buyer за 0.8с) | 6 | -0.0003 | -0.002 |
| Stop-loss (-12%) | 3 | -0.0084 | -0.025 |
| Trailing exit (+16-23%) | 1.5 | +0.014 | +0.021 |
| TP1-TP2 run | 0.5 | +0.015 | +0.008 |
| Copy-trade (3 сигнала) | 3 | +0.004 | +0.012 |
| **ИТОГО (без runners)** | | | **+0.014 SOL/час** |
| Runner ×5 (0.3/day) | ~0.04 | +0.134 | +0.005 |
| **ИТОГО (с runners)** | | | **+0.019 SOL/час** |

### Что определяет прибыльность

| Фактор | Влияние | Контроль |
|--------|---------|----------|
| Sell landing rate | КРИТИЧЕСКИЙ | 4-chain fallback + circuit-breaker |
| Runner capture | ВЫСОКИЙ | runner-tail 40% reserve, trailing 7%/25% |
| Copy-trade quality | ВЫСОКИЙ | 2-tier eligible (T1: WR≥60%/15+, T2: WR≥50%/8+) |
| Social run frequency | ВЫСОКИЙ | рынок (не контролируем) |
| Token scoring | СРЕДНИЙ | minTokenScore 60, двухэтапный + defensive (+8 при WR<45%) |
| BE after TP1 | СРЕДНИЙ | защита от reversal после первого TP |
| SL tightness | СРЕДНИЙ | 12% pump.fun (не восстанавливается), 15% PumpSwap |

---

## 5. Wallet Tracker — 2-tier copy-trade

### Tier 1 (Conservative)
- minCompletedTrades: 15
- minWinRate: 0.60 (60%)
- entryAmount: 0.06 SOL
- Loss streak skip: ≥5 consecutive losses

### Tier 2 (Aggressive)
- minCompletedTrades: 8
- minWinRate: 0.50 (50%)
- entryAmount: 0.03 SOL
- Loss streak skip: ≥3 consecutive losses

### Win detection
- PnL-based: sellSOL > buySOL × 0.98 → win
- Fallback: holdTime 4-90 сек → win
- recentLosses tracking: сброс на каждом win

---

## 6. KPI для принятия решений

| Метрика | Хороший | Плохой → действие |
|---------|---------|-------------------|
| Buy landing rate | > 40% | < 20% → увеличить tipAmountSol |
| Sell success rate | > 85% | < 70% → проверить feeRecipient, circuit-breaker |
| Win rate | > 25% | < 15% → повысить minTokenScore |
| Early exit % | < 50% | > 70% → увеличить earlyExitTimeoutMs |
| PnL/день | > +0.02 SOL | < -0.05 SOL → остановить, анализ |

---

## 7. Поэтапный план запуска

### Фаза 0: Подготовка (день 0)

```bash
npx ts-node scripts/verify.ts          # layouts + config consistency
SIMULATE=true npm run dev               # 30 минут наблюдения
npx ts-node scripts/analyze-trades.ts   # проверка симуляции
```

**Депозит:** 0.5 SOL на кошельке (минимум).

### Фаза 1: Калибровка (дни 1-3)

```
entryAmountSol:     0.07 SOL (pump.fun/pumpswap)
maxPositions:       4
copyTrade.enabled:  true (T1=0.06, T2=0.03)
minBalanceToTradeSol: 0.5
```

**Целевые KPI:** sell success ≥ 85%, buy landing ≥ 40% на 20+ trades.

**Ожидаемый PnL:** -0.01 to +0.02 SOL/день.

### Фаза 2: Стабилизация (дни 4-7)

**Проверяем:** exit timing, defensive mode, runner-tail capture.

**Ожидаемый PnL:** 0 to +0.3 SOL/день.

### Фаза 3: Масштабирование (недели 2-3)

При стабильном WR ≥ 22% и sell success ≥ 85%:

| Условие | Действие |
|---------|----------|
| CT T1 WR > 55% стабильно | ↑ entryAmountSol: 0.06 → 0.10 SOL |
| CT T2 WR > 50% стабильно | ↑ tier2EntryAmountSol: 0.03 → 0.06 SOL |
| Sniper WR > 25% стабильно | ↑ entryAmountSol: 0.07 → 0.12 SOL |
| maxTotalExposureSol < 50% бюджета | ↑ maxTotalExposureSol |

**Депозит:** 2-5 SOL.

### Фаза 4: Целевой режим (неделя 4+)

```
Стабильный baseline: +0.5-1.0 SOL/день
С учётом runners (2-3/week): +1.0-2.0 SOL/день
Депозит: 5-10 SOL рекомендуется.
```

### Сводная таблица

| Фаза | Дни | Депозит | Entry | PnL/день | PnL/нед |
|------|-----|---------|-------|----------|---------|
| 0: Подготовка | 0 | 0.5 | 0 (simulate) | 0 | 0 |
| 1: Калибровка | 1-3 | 0.5 | 0.07 | -0.01..+0.02 | ~0 |
| 2: Стабилизация | 4-7 | 1-2 | 0.07+CT | 0..+0.3 | 0-2 |
| 3: Масштабирование | 8-21 | 2-5 | 0.10+CT | +0.2..+0.8 | 1.5-5.5 |
| 4: Целевой режим | 22+ | 5-10 | 0.15+CT | +0.5..+2.0 | **3.5-14** |
