# WEBUI.md — Web UI: описание реализации

> Обновлено: 2026-04-30 (commit `c894f31`)

React + Vite SPA (`web-ui/`) + Express 5 backend (`src/web/`). Поднимается в одном Node-процессе с ботом.

---

## 1. Архитектура

```
Browser (React SPA)
    ↕ HTTP REST  (JWT в httpOnly cookie)
    ↕ WebSocket  (Socket.IO, аутентификация по тому же cookie)
Express 5 (src/web/server.ts, порт WEB_PORT=3001)
    ├─ /api/*        — 13 REST роутов
    ├─ /socket.io    — Socket.IO namespace /
    └─ /*            — статика из web-ui/dist/ (только в production)
```

**Файлы backend:**

| Файл | Назначение |
|------|-----------|
| `src/web/server.ts` | Express app, JWT middleware, Socket.IO, static |
| `src/web/auth.ts` | JWT генерация/верификация + bcrypt hash check |
| `src/web/routes/index.ts` | Регистрация всех 13 роутов |
| `src/web/ws/events.ts` | Socket.IO handlers: position:*, balance/stats 5s, trend:*, social:* |

**Frontend (web-ui/):** React + Vite, TypeScript. Страниц: 11. Роутинг через React Router.

## 2. Авторизация (JWT + bcrypt)

Все `/api/*` роуты защищены middleware `requireAuth` (кроме `/api/login`).

```
POST /api/login
  body: { password: string }
  → bcrypt.compare(password, WEB_PASSWORD_HASH)
  → если OK: выдать JWT (подпись JWT_SECRET, expires 7d)
             установить httpOnly cookie "token"
  → если нет: 401

requireAuth middleware:
  читает cookie "token" → jwt.verify(token, JWT_SECRET)
  если невалиден → 401
```

**Настройка:**
```bash
# 1. Генерация bcrypt хэша пароля
node -e 'require("bcrypt").hash(process.argv[1], 10).then(console.log)' 'MyPassword'

# 2. .env
JWT_SECRET=<random 32+ chars>
WEB_PASSWORD_HASH=<hash из шага 1>
WEB_COOKIE_SECURE=true   # только под HTTPS

# 3. Опционально: CORS для cross-origin фронта
WEB_ORIGIN=https://sniper.example.com
```

Если `JWT_SECRET` или `WEB_PASSWORD_HASH` не установлены — `/api/login` вернёт 500. Бот при этом стартует штатно.

## 3. REST API (13 endpoints)

| Роут | Методы | Файл | Назначение |
|------|--------|------|-----------|
| `/api/control` | GET, POST | `routes/control.ts` | Статус бота, start/stop, sell-all, close-all |
| `/api/config` | GET, PUT | `routes/config.ts` | Чтение и запись RuntimeConfig (whitelist + history) |
| `/api/positions` | GET | `routes/positions.ts` | Открытые позиции + exit signals |
| `/api/trades` | GET | `routes/trades.ts` | JSONL сделки с фильтрами + per-protocol stats |
| `/api/wallet` | GET | `routes/wallet.ts` | SOL баланс кошелька |
| `/api/wallets` | GET, POST, PUT, DELETE | `routes/wallets.ts` | Copy-trade wallet tracker CRUD |
| `/api/blacklist` | GET, POST, DELETE | `routes/blacklist.ts` | Tokens + creators (hot-reload через mtime) |
| `/api/social` | GET | `routes/social.ts` | `/feed`, `/mentions`, `/status` |
| `/api/prelaunch` | GET, POST, DELETE | `routes/prelaunch.ts` | PreLaunchWatcher CRUD |
| `/api/tokens` | GET | `routes/tokens.ts` | Recently scored tokens (последние 100) |
| `/api/logs` | GET, POST | `routes/logs.ts` | Live log tail + push-to-git |
| `/api/shadow` | GET, POST | `routes/shadow.ts` | Shadow engine status/trades/report/stop |
| `/api/login` | POST | (inline в server.ts) | Аутентификация, выдача JWT cookie |

### Детали ключевых endpoint'ов

**GET /api/positions**
```json
[{
  "mint": "...", "protocol": "pumpswap", "entryPrice": 0.000001,
  "currentPrice": 0.0000015, "pnlPercent": 50, "isScalp": false,
  "amount": 1000000, "entryTime": 1714000000000,
  "pendingTpLevels": [], "exitSignals": ["trailing_stop"]
}]
```

**GET /api/trades?limit=50&protocol=pumpswap&from=2026-04-01**
```json
{ "trades": [...], "stats": { "winRate": 0.22, "totalPnl": 0.45, "byProtocol": {...} } }
```

**GET /api/social/feed?limit=20&alpha=1**
```json
[{ "source": "telegram", "mint": "...", "ticker": "PEPE", "sentiment": 0.8, "alpha": true, ... }]
```

**GET /api/social/mentions?window=600000&limit=10**
```json
[{ "mint": "...", "ticker": "PEPE", "count": 5, "sources": ["telegram", "dexscreener"] }]
```

**GET /api/social/status**
```json
{ "dexscreener": { "lastRun": ..., "lastYield": ..., "lastError": null },
  "telegram": {...}, "twitter": {...} }
```

**GET /api/shadow/report** — WR/PnL/exit breakdown по каждому профилю и протоколу.

## 4. Socket.IO события

Клиент аутентифицируется по httpOnly-cookie JWT при handshake. Эмиты из `src/web/ws/events.ts`.

| Событие | Источник | Данные |
|---------|----------|--------|
| `position:open` | Sniper.emit | `{ mint, protocol, entryPrice, amount, isScalp }` |
| `position:update` | Sniper.emit | `{ mint, pnlPercent, currentPrice, exitSignals }` |
| `position:close` | Sniper.emit | `{ mint, pnlPercent, reason, sellPath, tokenScore }` |
| `balance:update` | timer 5s | `{ sol: number }` |
| `stats:update` | timer 5s | `{ positions, winRate, pnl, exposure, eventCounts, skipReasons }` |
| `trend:confirmed` | TrendTracker | `{ mint, protocol, uniqueBuyers, buyVolume }` |
| `trend:strengthening` | TrendTracker | `{ mint, ... }` |
| `trend:weakening` | TrendTracker | `{ mint, ... }` |
| `social:signal` | SocialManager | `SocialSignal` DTO |
| `social:alpha` | SocialManager | `SocialSignal` с `alpha=true` |
| `trade:close` | TradeLogger | TradeClosePayload (tokenScore, isCopyTrade, sellPath) |
| `token:scored` | Sniper | `{ mint, score, protocol }` |

## 5. Страницы

| Путь | Компонент | Ключевые фичи |
|------|-----------|---------------|
| `/` | Dashboard | EventCountsBar (detected/entered/exited/skipped + hit-rate); StatsCards (Balance, Positions, WinRate, PnL, per-protocol); Skip-reasons chart; RecentTradesTable (30 строк); Push-to-Git кнопка |
| `/positions` | Positions | Список открытых позиций, PnL в реальном времени, exit signals, isScalp badge |
| `/trades` | Trades | JSONL-сделки с фильтрами (дата, протокол, причина exit); per-protocol stats таблица |
| `/config` | Config | Редактор RuntimeConfig с whitelist путей; история изменений из config_history |
| `/blacklist` | Blacklist | Добавление/удаление tokens и creators; hot-reload на save |
| `/wallets` | Wallets | Copy-trade wallet tracker: список кошельков, WR, completedTrades, tier, кнопки add/override/remove |
| `/social` | Social | Live Feed с ★ alpha highlighting; Top Mentions (кол-во упоминаний/источники); Source status chips (last run, last error) |
| `/prelaunch` | PreLaunch | PreLaunchWatcher: list с TTL/статус (WAITING/FIRED/EXPIRED); add form (mint/ticker/creator/source); auto-alpha секция |
| `/tokens` | Tokens | Последние 100 scored токенов: score, protocol, причины +/-, время |
| `/shadow` | Shadow | ShadowEngine: статус 3 профилей; таблица shadow-trades (cyan SCALP badge); summary report |
| `/logs` | Logs | Live tail последних N строк лога; Push-to-Git кнопка (incremental 49 MB chunks) |

## 6. RuntimeConfig (live config editing)

`src/config.ts` экспортирует `runtimeConfig` (экземпляр `RuntimeConfig`). При старте читает `data/runtime-config.json` и накладывает overrides поверх base config.

```typescript
// Чтение (используется везде в коде вместо config.*)
runtimeConfig.get<number>('strategy.pumpSwap.entryAmountSol')

// Запись (только через Web UI)
runtimeConfig.set('strategy.pumpSwap.entryAmountSol', 0.15)
// → немедленно сохраняется в data/runtime-config.json
// → все listeners уведомляются (onChange callbacks)
```

**Whitelist**: только определённые пути разрешены для изменения через Web UI (задаётся в `src/web/routes/config.ts`). Например, нельзя изменить `wallet.privateKey`.

**History**: каждое изменение записывается в SQLite таблицу `config_history` (timestamp, path, old_value, new_value). Доступно в UI `/config`.

**Персистентность**: `data/runtime-config.json` переживает рестарты. При остановке бота overrides сохранены. При следующем старте они применятся снова.

## 7. Push-to-Git (log export)

Кнопка на Dashboard и на `/logs` страницах. Вызывает `POST /api/logs/push-to-git`.

```
POST /api/logs/push-to-git
  → mutex-protected (один экспорт одновременно)
  → собирает logs/*.jsonl + logs/sniper.log
  → разбивает на chunks ≤ 49 MB (лимит git blob)
  → git add -f logs-export/
  → git commit -m "chore: export logs <timestamp>"
  → git push origin <current-branch>
  ← { ok: true, commit: "abc123", files: [...] }
```

Используется для анализа логов с удалённой VPS без SSH:
1. Нажать Push-to-Git в UI
2. `git pull` локально
3. `npm run analyze` / `npm run recommend`
