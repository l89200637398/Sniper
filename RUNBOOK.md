# RUNBOOK — эксплуатация бота

> Обновлено: 2026-04-19

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

| Команда | Что делает |
|---|---|
| `npm start` / `npm run stop` | Prod lifecycle |
| `npm run verify` | On-chain layout + config validation |
| `npm run analyze` | JSONL анализ + social correlation. Флаги: `--date`, `--full`, `--mint`, `--replay`, `--no-social` |
| `npm run recommend` | Советы по config.ts. Флаги: `--full`, `--date`, `--json`, `--quiet` |
| `npm run blacklist -- <cmd>` | `add/remove/add-creator/remove-creator/list/stats/clear` — hot-reload без рестарта |
| `npm run cleanup-dust` | Закрытие пустых ATA, возврат rent. `--dry` для preview |
| `npx ts-node scripts/test-trade.ts <mint>` | Ручная сделка (auto-detect protocol) |
| `npx ts-node scripts/control.ts start` | Foreground без TG/Web UI |

Рекомендуемый cron:
```cron
0 */4 * * * cd ~/solana-sniper-v2 && npm run recommend >> logs/recommend.log 2>&1
```

## 5. Telegram (read-only)

Бот не принимает управляющих команд — только статус по кнопкам и push.

**Меню:** 📊 Статус | 💰 Баланс | 📈 Анализ сессии | ⚙️ Рекомендации

**Push-уведомления:** `position:open` (💰 КУПИЛ), `position:close` (💸 ПРОДАЛ / ❌ ОШИБКА)

## 6. Web UI

React + Vite SPA на `WEB_PORT` (default 3001).

**Страницы:** Dashboard `/` | Positions `/positions` | Blacklist `/blacklist` | Wallets `/wallets` | Config `/config` | Social `/social` | Trades `/trades`

**Socket.IO:** `position:open`, `position:close`, `social:signal`, `social:alpha`

**Настройка пароля:** см. env `JWT_SECRET` + `WEB_PASSWORD_HASH`.

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
tail -f ~/solana-sniper-v2/logs/sniper.log | npx pino-pretty        # Live logs
tail -f ~/solana-sniper-v2/logs/sniper.log | grep "\[social\]"      # Social module
sqlite3 data/sniper.db "SELECT source, COUNT(*) FROM social_signals WHERE timestamp > strftime('%s','now','-1 day')*1000 GROUP BY source;"
ps aux | grep -E "node.*(sniper|index)" | grep -v grep    # Process alive?
lsof ~/solana-sniper-v2/data/sniper.db                              # Who holds DB?
```

## 9. Горячая замена

Без рестарта можно менять:
- `data/blacklist.json` — бот подхватывает через mtime-polling

Всё остальное (env, config, social parsers) — требует рестарта.
