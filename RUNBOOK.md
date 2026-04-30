# RUNBOOK — эксплуатация бота

> Обновлено: 2026-04-30 (sync с commit `c894f31`)

> **Правило безопасности:** `data/positions.json` и `data/sniper.db`
> переживают рестарты. Перед инвазивными операциями — `cp
> data/sniper.db data/sniper.db.bak`. Если есть открытые позиции —
> дождись их закрытия или закрой через Web UI / CLI.

---

## 1. Установка

```bash
git clone <repo-url> ~/solana-sniper-v2 && cd ~/solana-sniper-v2
npm ci
cd web-ui && npm ci && npm run build && cd ..
```

## 2. Переменные окружения

Обязательные (без них процесс падает на `requireEnv()`):

```env
PRIVATE_KEY=
PUBLIC_KEY=
RPC_URL=
GRPC_ENDPOINT=
GRPC_TOKEN=
JITO_RPC=
BOT_TOKEN=
ALLOWED_CHAT_ID=
```

Опциональные:

| Переменная | Описание | По умолчанию |
|-----------|----------|-------------|
| `BACKUP_RPC_URL` | Failover RPC (auto-switch при 429/timeout, 30s cooldown) | — |
| `METRICS_ENABLED` | HTTP /metrics endpoint (Prometheus-совместимый) | `true` |
| `METRICS_PORT` | Порт метрик | `9469` |
| `SIMULATE` | Dry-run (транзакции не отправляются) | `false` |
| `JWT_SECRET` | Для Web UI auth | — |
| `WEB_PASSWORD_HASH` | bcrypt hash пароля Web UI | — |
| `WEB_PORT` | Порт Web UI | `3001` |
| `BLOXROUTE_AUTH_HEADER` | bloXroute sell fallback | — |
| `BLOXROUTE_TIP_WALLET` | bloXroute tip wallet | — |
| `RAPIDAPI_KEY` | Twitter social parser (twitter-api45.p.rapidapi.com) | — |
| `TWITTER_POLL_INTERVAL_MS` | Интервал опроса Twitter | `10800000` (3h) |
| `TWITTER_ALPHA_SCREENNAMES` | CSV скринеймов для timeline мониторинга | — |
| `TG_ALPHA_CHANNELS` | CSV публичных TG каналов | built-in 12 каналов |
| `ALPHA_TICKERS` | Watchlist тикеры | — |
| `ALPHA_MINTS` | Watchlist mint-адреса | — |
| `ALPHA_AUTHORS` | Watchlist авторы | — |

## 3. Запуск и остановка

```bash
npm run build && npm start    # Продакшен (prestart → verify.ts)
npm run dev                   # Разработка (ts-node)
SIMULATE=true npm run dev     # Dry-run
npm run stop                  # Graceful SIGTERM (закрытие позиций до 60с)
npm run stop -- --force       # SIGKILL
```

`npm start` пишет PID в `.sniper.pid`.

**prestart hook:** `scripts/verify.ts` проверяет on-chain layouts и config consistency. При ошибке — `exit(1)`, бот не стартует.

## 4. CLI

**Lifecycle:**

| Команда | Что делает |
|---|---|
| `npm start` | Prod: prestart verify → dist/index.js. Пишет PID в `.sniper.pid`. |
| `npm run stop` | Graceful SIGTERM (закрывает позиции ≤ 60с). `-- --force` → SIGKILL. |
| `npm run dev` | ts-node (без компиляции). |
| `npm run build` | tsc + копирование db/migrations в dist/. |
| `npx ts-node scripts/control.ts start` | Foreground без TG/Web UI. |
| `npm run shadow` | Запуск parallel backtester (3 профиля). |

**Validation:**

| Команда | Что делает |
|---|---|
| `npm run verify` | On-chain layouts + config consistency (prestart hook). |
| `npx ts-node scripts/verify-sell.ts` | Pre-launch sell-path validator (48 проверок). |

**Анализ:**

| Команда | Что делает |
|---|---|
| `npm run analyze` | JSONL анализ + social correlation + pre-buy anticipation. Флаги: `--date`, `--full`, `--mint`, `--replay`, `--no-social`, `--no-hints`. |
| `npm run recommend` | Heuristic config advice. Флаги: `--full`, `--date`, `--json`, `--quiet`. |
| `npx ts-node scripts/dossier.ts <mint>` | Полная история mint из SQLite. Флаги: `--recent N`, `--creator <pk>`, `--events <mint>`, `--reports`, `--cleanup`. |

**EV-симуляция:**

| Команда | Что делает |
|---|---|
| `npx ts-node scripts/ev-simulation.ts` | 50k Monte Carlo с full exit-логикой. |
| `npx ts-node scripts/monte-carlo.ts` | 100k trades × 5 протоколов. |
| `npx ts-node scripts/ev-analysis/ev-model-v2.ts` | EV-модель, калиброванная на реальных сделках. |
| `npx ts-node scripts/ev-analysis/grid-search.ts` | Grid (creatorSellMinDropPct × TP1 × SL). |
| `npx ts-node scripts/ev-analysis/tp-reachability.ts` | Вероятность достижения каждого TP. |

**Watchlist и persist:**

| Команда | Что делает |
|---|---|
| `npm run blacklist -- <cmd>` | `add/remove/add-creator/remove-creator/list/stats/clear`. Hot-reload без рестарта. |
| `npx ts-node scripts/prelaunch.ts add --ticker X --source telegram` | Mode C: добавить pre-launch кандидата. |
| `npx ts-node scripts/prelaunch.ts list` | Показать кандидатов (FIRED/EXPIRED/WAITING + TTL). |
| `npx ts-node scripts/prelaunch.ts remove <id>` / `clear` | Удалить. |

**Утилиты:**

| Команда | Что делает |
|---|---|
| `npm run cleanup-dust` | Закрыть пустые ATA → rent обратно. `-- --dry` для preview. |
| `npx ts-node scripts/sell-unknown-tokens.ts` | Emergency mass-sell по всему кошельку. Флаги: `--dry-run`, `--burn-unsellable`, `--min-value N`, `--slippage N`. |
| `npx ts-node scripts/test-trade.ts <mint>` | Ручная сделка (auto-detect протокол). |

Рекомендуемый cron:
```cron
0 */4 * * * cd ~/solana-sniper-v2 && npm run recommend >> logs/recommend.log 2>&1
```

## 5. Telegram (read-only)

Бот не принимает управляющих команд — только статус по кнопкам и push.

**Меню:** 📊 Статус | 💰 Баланс | 📈 Анализ сессии | ⚙️ Рекомендации

**Push-уведомления:** `position:open` (💰 КУПИЛ), `position:close` (💸 ПРОДАЛ / ❌ ОШИБКА)

## 6. Web UI

React + Vite SPA на `WEB_PORT` (default 3001). Полная техническая документация — `WEBUI.md`.

**Страницы:**

| Путь | Назначение |
|------|-----------|
| `/` Dashboard | Event counters, Stats, PnL, Skip Reasons, Recent Trades, Push-to-Git |
| `/positions` | Открытые позиции + Exit Signals |
| `/trades` | JSONL-сделки с фильтрами + per-protocol stats |
| `/config` | Live редактор конфигурации (RuntimeConfig, whitelist + history) |
| `/blacklist` | Tokens + creators (hot-reload через mtime) |
| `/wallets` | Copy-trade wallet tracker (CRUD + tier) |
| `/social` | Live Feed / Top Mentions / Source chips (alpha ★) |
| `/prelaunch` | PreLaunchWatcher (manual + auto-alpha) |
| `/tokens` | Recently scored tokens (последние 100) |
| `/shadow` | Parallel backtester status / trades / report |
| `/logs` | Live log tail + Push-to-Git (49 MB chunks, mutex) |

**Socket.IO события (основные):**
`position:open`, `position:update`, `position:close`, `balance:update`, `stats:update` (5s), `trend:confirmed`, `social:signal`, `social:alpha`, `trade:close`

**Настройка пароля:**
```bash
node -e 'require("bcrypt").hash(process.argv[1],10).then(console.log)' 'PASSWORD'
# → записать hash в .env: WEB_PASSWORD_HASH=<hash>
#   и JWT_SECRET=<random string>
```

## 6.5. Shadow Engine (backtester)

```bash
npm run shadow    # Запуск 3 профилей (conservative / balanced / aggressive)
```

Состояние через REST: `GET /api/shadow/status`, `/trades`, `/report`, `/stop`.
Web UI страница: `/shadow` (cyan SCALP badge для scalp позиций).

Shadow зеркалирует live pipeline: filters, scoring, dynamic slippage — но не отправляет TX.

## 7. Social Signals

DexScreener и Telegram (HTML scraper) работают **из коробки без ключей**.

| Источник | Интервал | Нужен ключ |
|----------|----------|-----------|
| DexScreener boosts | 60s | Нет |
| Telegram (t.me/s/) | 30s | Нет |
| Twitter (RapidAPI) | 3h | `RAPIDAPI_KEY` |

**Twitter:** подписка на `twitter-api45.p.rapidapi.com` (RapidAPI, alexanderxbx), бесплатный тариф ~500 req/мес + rate limit 60 req/min (хватает при 3h интервале). Опциональные ENV: `TWITTER_SEARCH_QUERIES` (CSV, default "solana pump.fun"), `TWITTER_SEARCH_TYPE` (Top/Latest), `TWITTER_ALPHA_SCREENNAMES` (CSV usernames для мониторинга их timeline).

**Alpha watchlist:** заполнить `ALPHA_TICKERS`, `ALPHA_MINTS`, `ALPHA_AUTHORS` — совпадающие сигналы помечаются `alpha=true`.

**REST API:**
```
GET /api/social/feed?limit=N&alpha=1
GET /api/social/mentions?window=ms&limit=N
GET /api/social/status
```

## 8. Мониторинг

```bash
# Live logs
tail -f logs/sniper.log | npx pino-pretty
tail -f logs/sniper.log | grep "\[social\]"       # Social module
tail -f logs/sniper.log | grep "SENTINEL_SILENCE"  # gRPC silence alert

# Process
ps aux | grep -E "node.*(sniper|index)" | grep -v grep
lsof data/sniper.db    # кто держит DB

# SQLite queries
sqlite3 data/sniper.db "SELECT type, COUNT(*) FROM events GROUP BY type ORDER BY COUNT(*) DESC LIMIT 20;"
sqlite3 data/sniper.db "SELECT source, COUNT(*) FROM social_signals WHERE timestamp > strftime('%s','now','-1 day')*1000 GROUP BY source;"
sqlite3 data/sniper.db "SELECT * FROM events WHERE type='TX_DIAGNOSTIC' ORDER BY ts DESC LIMIT 5;"

# Disk space (disk-monitor alerts at 10/8/6/4/3/2/1 GB)
df -h .

# Prometheus metrics
curl -s http://localhost:9469/metrics | grep sniper_
```

**Ключевые лог-строки:**

| Строка | Что означает |
|--------|-------------|
| `SENTINEL_SILENCE` | Нет gRPC событий > 5 мин |
| `SELL_CIRCUIT_BREAK` | 2 одинаковых sell ошибки → прыжок к Jupiter |
| `ATA balance 0 for <mint>` | Позиция уже продана или не приземлилась |
| `FORCE_CLOSE: <mint>` | Все 4 sell канала failed → position removed |
| `LOSS_PAUSE: 5 consecutive losses` | Kill-switch, пауза 15 мин |
| `[rpc] Switching to backup RPC` | Failover на BACKUP_RPC_URL |
| `TRADE_QUALITY_PAUSE: win rate XX%` | WR < 25%, пауза 15 мин |

## 9. Горячая замена

Без рестарта можно менять:

| Что | Как |
|-----|-----|
| `data/blacklist.json` | Прямо файл или через `npm run blacklist --` — mtime-poll подхватывает |
| `data/runtime-config.json` | Web UI `/config` или прямое редактирование — RuntimeConfig перечитывает |
| `data/prelaunch.json` | `npx ts-node scripts/prelaunch.ts add/remove` |

Всё остальное (env, src/config.ts параметры вне RuntimeConfig, social parsers) — требует рестарта.
