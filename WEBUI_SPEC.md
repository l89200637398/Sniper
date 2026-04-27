# ТЗ: Web UI Dashboard — замена Telegram-бота

> Дата: 2026-04-07 | Приоритет: Высокий | Оценка: 2-3 недели

## 1. Цель

Заменить Telegram-бот (`src/bot/bot.ts`) локальным веб-дашбордом на VPS. Полный контроль бота через браузер: мониторинг, конфигурация, аналитика, социальные сигналы.

## 2. Стек

| Компонент | Технология | Почему |
|-----------|-----------|--------|
| Backend | Express.js + Socket.IO | Уже Node.js, real-time updates через WS |
| Frontend | React 18 + Vite | Быстрая сборка, SPA |
| Графики | Lightweight Charts (TradingView) | Лёгкий, финансовые графики |
| UI Kit | Tailwind CSS + shadcn/ui | Быстрая разработка, тёмная тема |
| State | Zustand | Минимальный, без boilerplate |
| Auth | JWT + bcrypt | Простая авторизация для VPS |
| DB (опционально) | SQLite (better-sqlite3) | Для истории trades/PnL, без внешних зависимостей |

## 3. Архитектура

```
┌─────────────┐    WebSocket/REST     ┌──────────────┐
│  React SPA  │ ◄──────────────────► │  Express API  │
│  (порт 3000)│                       │  (порт 3001) │
└─────────────┘                       └──────┬───────┘
                                             │
                         ┌───────────────────┼───────────────────┐
                         │                   │                   │
                    ┌────▼────┐      ┌───────▼──────┐    ┌──────▼──────┐
                    │ Sniper  │      │ Social Parser│    │  SQLite DB  │
                    │ (core)  │      │  (новый)     │    │ (история)   │
                    └─────────┘      └──────────────┘    └─────────────┘
```

### API слой (`src/web/`)

```
src/web/
├── server.ts          # Express + Socket.IO init, JWT middleware
├── routes/
│   ├── config.ts      # GET/PUT /api/config — чтение/запись config
│   ├── positions.ts   # GET /api/positions — текущие позиции
│   ├── trades.ts      # GET /api/trades — история из JSONL/SQLite
│   ├── wallet.ts      # GET /api/wallet — баланс, exposure
│   ├── control.ts     # POST /api/start|stop|sell/:mint
│   ├── blacklist.ts   # GET/POST/DELETE /api/blacklist
│   └── social.ts      # GET /api/social/feed — агрегированная лента
├── ws/
│   └── events.ts      # Socket.IO: position updates, price ticks, alerts
└── auth.ts            # JWT login, bcrypt password
```

## 3.1 Бэкенд — ключевые блоки кода

### `src/web/server.ts` — Express + Socket.IO + JWT middleware

```typescript
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { authenticateJWT, loginHandler } from './auth';
import { registerRoutes } from './routes';
import { registerSocketHandlers } from './ws/events';

export function createWebServer(sniper: Sniper) {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173', credentials: true },
  });

  app.use(express.json());
  app.use(cookieParser());
  app.use(rateLimit({ windowMs: 60_000, max: 200 }));

  // Auth
  app.post('/api/login', loginHandler);

  // Protected routes
  app.use('/api', authenticateJWT);
  registerRoutes(app, sniper);

  // WebSocket
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!verifyToken(token)) return next(new Error('Unauthorized'));
    next();
  });
  registerSocketHandlers(io, sniper);

  // Serve React SPA (production)
  app.use(express.static('web-ui/dist'));
  app.get('*', (_, res) => res.sendFile('web-ui/dist/index.html'));

  const port = Number(process.env.WEB_PORT ?? 3001);
  httpServer.listen(port, () => console.log(`Web UI: http://localhost:${port}`));

  return { app, io };
}
```

### `src/web/auth.ts` — JWT + bcrypt

```typescript
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import type { Request, Response, NextFunction } from 'express';

const SECRET = process.env.JWT_SECRET!;
const PASSWORD_HASH = process.env.WEB_PASSWORD_HASH!; // bcrypt hash

export async function loginHandler(req: Request, res: Response) {
  const { password } = req.body;
  if (!password || !(await bcrypt.compare(password, PASSWORD_HASH))) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = jwt.sign({ role: 'admin' }, SECRET, { expiresIn: '7d' });
  res.cookie('token', token, { httpOnly: true, secure: true, sameSite: 'strict', maxAge: 7 * 86400_000 });
  res.json({ ok: true });
}

export function authenticateJWT(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.token ?? req.headers.authorization?.split(' ')[1];
  try {
    jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

export function verifyToken(token: string): boolean {
  try { jwt.verify(token, SECRET); return true; } catch { return false; }
}

// Утилита для генерации хэша (запустить один раз):
// node -e "require('bcrypt').hash('yourpassword', 12).then(console.log)"
```

### `src/web/routes/control.ts` — start/stop/sell

```typescript
import { Router } from 'express';
import type { Sniper } from '../../core/sniper';

export function controlRouter(sniper: Sniper) {
  const router = Router();

  router.post('/start', async (_, res) => {
    if (sniper.isRunning()) return res.json({ ok: false, error: 'Already running' });
    await sniper.start();
    res.json({ ok: true });
  });

  router.post('/stop', async (_, res) => {
    await sniper.stop();
    res.json({ ok: true });
  });

  router.post('/sell/:mint', async (req, res) => {
    const { mint } = req.params;
    const position = sniper.getPosition(mint);
    if (!position) return res.status(404).json({ error: 'Position not found' });
    sniper.requestSell(mint, 'manual_ui');
    res.json({ ok: true, mint });
  });

  router.post('/close-all', async (_, res) => {
    await sniper.closeAllPositions();
    res.json({ ok: true });
  });

  return router;
}
```

### `src/web/routes/config.ts` — GET/PUT с live apply

```typescript
import { Router } from 'express';
import { runtimeConfig } from '../../config';
import { db } from '../../db/sqlite';

export function configRouter() {
  const router = Router();

  router.get('/', (_, res) => {
    res.json(runtimeConfig.getAll());
  });

  router.put('/', (req, res) => {
    const changes: Array<{ path: string; value: any }> = req.body.changes;
    const errors: string[] = [];
    const applied: string[] = [];

    for (const { path, value } of changes) {
      try {
        const oldValue = runtimeConfig.get(path);
        runtimeConfig.set(path, value);
        db.prepare(`INSERT INTO config_history (changed_at, path, old_value, new_value)
                    VALUES (?, ?, ?, ?)`).run(Date.now(), path, JSON.stringify(oldValue), JSON.stringify(value));
        applied.push(path);
      } catch (e: any) {
        errors.push(`${path}: ${e.message}`);
      }
    }
    res.json({ applied, errors });
  });

  router.post('/rollback', (_, res) => {
    const last = db.prepare(`SELECT * FROM config_history ORDER BY changed_at DESC LIMIT 50`).all() as any[];
    for (const row of last) {
      runtimeConfig.set(row.path, JSON.parse(row.old_value));
    }
    res.json({ ok: true, rolledBack: last.length });
  });

  return router;
}
```

### `src/web/routes/positions.ts` — активные позиции

```typescript
import { Router } from 'express';
import type { Sniper } from '../../core/sniper';

export function positionsRouter(sniper: Sniper) {
  const router = Router();

  router.get('/', (_, res) => {
    const positions = sniper.getAllPositions().map(p => ({
      mint:            p.mint.toBase58(),
      protocol:        p.protocol,
      entryPrice:      p.entryPrice,
      currentPrice:    p.currentPrice,
      pnlPercent:      p.pnlPercent,
      amount:          p.amount,
      entryAmountSol:  p.entryAmountSol,
      openedAt:        p.openedAt,
      ageMs:           Date.now() - p.openedAt,
      runnerTail:      p.runnerTailActivated ?? false,
      exitSignals:     p.activeExitSignals ?? [],
    }));
    res.json(positions);
  });

  return router;
}
```

### `src/web/routes/wallet.ts` — баланс кошелька

```typescript
import { Router } from 'express';
import { getConnection } from '../../infra/rpc';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { config } from '../../config';

export function walletRouter() {
  const router = Router();

  router.get('/', async (_, res) => {
    const connection = getConnection();
    const pubkey = new PublicKey(config.wallet.publicKey);
    const lamports = await connection.getBalance(pubkey);
    res.json({
      address:    pubkey.toBase58(),
      balanceSol: lamports / LAMPORTS_PER_SOL,
      balanceLamports: lamports,
    });
  });

  return router;
}
```

### `src/web/routes/trades.ts` — история сделок из SQLite

```typescript
import { Router } from 'express';
import { db } from '../../db/sqlite';

export function tradesRouter() {
  const router = Router();

  router.get('/', (req, res) => {
    const { protocol, from, to, limit = 100, offset = 0 } = req.query as any;
    let sql = `SELECT * FROM trades WHERE 1=1`;
    const params: any[] = [];

    if (protocol) { sql += ` AND protocol = ?`; params.push(protocol); }
    if (from)     { sql += ` AND opened_at >= ?`; params.push(Number(from)); }
    if (to)       { sql += ` AND closed_at <= ?`; params.push(Number(to)); }

    sql += ` ORDER BY closed_at DESC LIMIT ? OFFSET ?`;
    params.push(Number(limit), Number(offset));

    const rows = db.prepare(sql).all(...params);
    const total = (db.prepare(`SELECT COUNT(*) as n FROM trades`).get() as any).n;

    res.json({ trades: rows, total });
  });

  router.get('/stats', (_, res) => {
    const stats = db.prepare(`
      SELECT
        COUNT(*)                                           AS total,
        SUM(CASE WHEN exit_amount_sol > entry_amount_sol THEN 1 ELSE 0 END) AS wins,
        AVG(pnl_percent)                                  AS avgPnl,
        MAX(pnl_percent)                                  AS bestPnl,
        MIN(pnl_percent)                                  AS worstPnl,
        SUM(entry_amount_sol)                             AS totalVolumeSol,
        SUM(exit_amount_sol - entry_amount_sol)           AS totalPnlSol
      FROM trades
    `).get();
    res.json(stats);
  });

  return router;
}
```

### `src/web/ws/events.ts` — Socket.IO real-time

```typescript
import type { Server } from 'socket.io';
import type { Sniper } from '../../core/sniper';

export function registerSocketHandlers(io: Server, sniper: Sniper) {
  // Пробрасываем события Sniper → все подключённые клиенты
  sniper.on('position:open',   (data) => io.emit('position:open',   data));
  sniper.on('position:update', (data) => io.emit('position:update', data));
  sniper.on('position:close',  (data) => io.emit('position:close',  data));
  sniper.on('system:status',   (data) => io.emit('system:status',   data));

  // Баланс каждые 5 секунд
  setInterval(async () => {
    const bal = await sniper.getWalletBalance();
    io.emit('balance:update', { sol: bal });
  }, 5_000);

  io.on('connection', (socket) => {
    // Сразу отдаём текущее состояние новому клиенту
    socket.emit('snapshot', {
      positions: sniper.getAllPositions(),
      isRunning: sniper.isRunning(),
      defensiveMode: sniper.isDefensiveMode(),
    });

    socket.on('sell:now', ({ mint }) => sniper.requestSell(mint, 'manual_ui'));
    socket.on('bot:start', () => sniper.start());
    socket.on('bot:stop',  () => sniper.stop());
  });
}
```

### `src/web/routes/blacklist.ts`

```typescript
import { Router } from 'express';
import type { Sniper } from '../../core/sniper';

export function blacklistRouter(sniper: Sniper) {
  const router = Router();

  router.get('/',                    (_, res) => res.json(sniper.getBlacklist()));
  router.post('/mint/:mint',         (req, res) => { sniper.blacklistMint(req.params.mint);    res.json({ ok: true }); });
  router.delete('/mint/:mint',       (req, res) => { sniper.unblacklistMint(req.params.mint);  res.json({ ok: true }); });
  router.post('/creator/:address',   (req, res) => { sniper.blacklistCreator(req.params.address); res.json({ ok: true }); });
  router.delete('/creator/:address', (req, res) => { sniper.unblacklistCreator(req.params.address); res.json({ ok: true }); });

  return router;
}
```

### `src/db/sqlite.ts` — инициализация БД

```typescript
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.resolve(process.env.DB_PATH ?? 'data/sniper.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Миграции
const migrations = fs.readFileSync(path.resolve(__dirname, 'migrations/001_init.sql'), 'utf-8');
db.exec(migrations);

// Запись трейда из JSONL-события
export function insertTrade(trade: {
  mint: string; protocol: string; entryPrice: number; exitPrice: number;
  entryAmountSol: number; exitAmountSol: number; pnlPercent: number;
  tokenScore: number; exitReason: string; sellPath: string;
  openedAt: number; closedAt: number; isCopyTrade: boolean;
}) {
  db.prepare(`INSERT INTO trades
    (mint, protocol, entry_price, exit_price, entry_amount_sol, exit_amount_sol,
     pnl_percent, token_score, exit_reason, sell_path, opened_at, closed_at, is_copy_trade)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    trade.mint, trade.protocol, trade.entryPrice, trade.exitPrice,
    trade.entryAmountSol, trade.exitAmountSol, trade.pnlPercent,
    trade.tokenScore, trade.exitReason, trade.sellPath,
    trade.openedAt, trade.closedAt, trade.isCopyTrade ? 1 : 0,
  );
}
```

### `src/config.ts` — RuntimeConfig (добавить)

```typescript
import get from 'lodash/get';
import set from 'lodash/set';
import cloneDeep from 'lodash/cloneDeep';
import fs from 'fs';

export class RuntimeConfig {
  private _data: typeof config;
  private _listeners = new Set<(path: string, value: any) => void>();
  private _savePath = 'data/runtime-config.json';

  constructor(base: typeof config) {
    // Загружаем переопределения с диска если есть
    try {
      const overrides = JSON.parse(fs.readFileSync(this._savePath, 'utf-8'));
      this._data = cloneDeep(base);
      for (const [path, value] of Object.entries(overrides)) {
        set(this._data, path, value);
      }
    } catch {
      this._data = cloneDeep(base);
    }
  }

  getAll() { return this._data; }
  get<T>(path: string): T { return get(this._data, path) as T; }

  set(path: string, value: any): void {
    set(this._data, path, value);
    this._listeners.forEach(fn => fn(path, value));
    this._persist();
  }

  onChange(fn: (path: string, value: any) => void) { this._listeners.add(fn); }

  private _persist() {
    // Сохраняем только измённые пути (diff от base)
    fs.writeFileSync(this._savePath, JSON.stringify(this._data, null, 2));
  }
}

export const runtimeConfig = new RuntimeConfig(config);
```

### `src/web/routes/index.ts` — регистрация всех роутов

```typescript
import type { Express } from 'express';
import type { Sniper } from '../../core/sniper';
import { controlRouter }   from './control';
import { configRouter }    from './config';
import { positionsRouter } from './positions';
import { tradesRouter }    from './trades';
import { walletRouter }    from './wallet';
import { blacklistRouter } from './blacklist';
import { socialRouter }    from './social';

export function registerRoutes(app: Express, sniper: Sniper) {
  app.use('/api/control',   controlRouter(sniper));
  app.use('/api/config',    configRouter());
  app.use('/api/positions', positionsRouter(sniper));
  app.use('/api/trades',    tradesRouter());
  app.use('/api/wallet',    walletRouter());
  app.use('/api/blacklist', blacklistRouter(sniper));
  app.use('/api/social',    socialRouter());
}
```

### `src/index.ts` — интеграция (изменить)

```typescript
// Добавить после создания sniper:
import { createWebServer } from './web/server';

const sniper = new Sniper();
const { io } = createWebServer(sniper);

// Пробросить io в sniper для emit событий UI
sniper.setIo(io);

await sniper.start();
```

---

## 4. Страницы и функционал

### 4.1 Dashboard (главная)

- **Баланс кошелька** (SOL, обновление каждые 5с)
- **Общий PnL**: сегодня / неделя / месяц / всё время
- **График PnL** (Lightweight Charts): equity curve по дням, drawdown overlay
- **Активные позиции** (карточки):
  - Mint (ссылка на Solscan), протокол, время в позиции
  - Текущий PnL% (цвет: зелёный/красный), entry price, current price
  - Exit signals (какие активны: trailing, runner-tail, etc.)
  - Кнопки: [Sell Now] [Force Close]
- **Статистика сессии**: win rate, avg PnL, total trades, consecutive losses
- **Defensive mode индикатор**: ON/OFF, текущий WR, порог
- **Системный статус**: Geyser (connected/reconnecting), Jito (ok/rate-limited), RPC latency

### 4.2 Positions (подробно)

- Таблица всех позиций (активные + история)
- Фильтры: протокол, статус (open/closed/force-closed), дата, PnL range
- Для каждой закрытой позиции:
  - Entry/exit timestamps, причина выхода
  - Sell path (Jito/RPC/bloXroute/Jupiter)
  - Token score при входе
  - TP уровни (какие сработали)
- Экспорт в CSV

### 4.3 Token Quality (скоринг)

- Последние 50 оценённых токенов (прошли/не прошли фильтр)
- Для каждого: score breakdown (social, market, creator, safety, holder)
- Rugcheck результат, holder concentration
- **Heatmap**: время дня vs. win rate (когда лучше торговать)

### 4.4 Configuration (редактор)

- Все параметры из `config.ts` в формах с группировкой:
  - Entry (amounts, slippage, age limits, score threshold)
  - Exit per protocol (stop-loss, trailing, TP levels, time stops)
  - Jito (tips, retries)
  - Copy-trade (tiers, WR thresholds)
  - Defensive mode
  - Balance floor, blacklist
- **Live apply** — изменения применяются без перезапуска (через runtime config object)
- **Presets**: Conservative / Normal / Aggressive
- **Diff view**: показывает что изменилось перед применением
- **Rollback**: откат к предыдущей конфигурации

### 4.5 Social Feed & Signals (НОВЫЙ МОДУЛЬ)

#### Источники

| Источник | Метод | Данные |
|----------|-------|--------|
| Twitter/X | Rapid API или Nitter scraping | Упоминания $TICKER, CT influencers |
| Telegram | HTML scraper (`t.me/s/{channel}`) | Публичные каналы alpha-calls |
| DexScreener | REST API (public) | Trending tokens, new pairs, volume spikes |
| Birdeye | REST API | Top traders, whale alerts |
| Pump.fun | WebSocket / API | New launches, volume, comments |
| Reddit | Reddit API | r/solana, r/memecoin mentions |

#### Функционал

- **Агрегированная лента** в реальном времени (Socket.IO)
- **Mention frequency** график: сколько раз токен упомянут за последние N минут
- **Sentiment score**: простой NLP (positive/negative/neutral keywords)
- **KOL tracking**: отслеживание конкретных аккаунтов (influencer list)
- **Alert rules**: "если >5 упоминаний за 2 мин И score > 60 → auto-buy" (настраиваемые)
- **Корреляция**: показывать social spike vs. price action на одном графике
- **Фильтр шума**: blacklist ботов, retweet threshold, минимальные followers

#### Архитектура парсеров

```
src/social/
├── manager.ts           # Координатор всех парсеров, дедупликация
├── parsers/
│   ├── twitter.ts       # Twitter/X parser
│   ├── telegram.ts      # Telegram channels parser
│   ├── dexscreener.ts   # DexScreener trending + new pairs
│   ├── birdeye.ts       # Whale alerts, top traders
│   ├── pumpfun.ts       # Pump.fun new launches feed
│   └── reddit.ts        # Reddit mentions
├── nlp/
│   └── sentiment.ts     # Keyword-based sentiment (быстрый, без ML)
├── models/
│   └── signal.ts        # { source, mint, ticker, mentionCount, sentiment, timestamp }
└── storage/
    └── signal-store.ts  # SQLite: хранение сигналов для аналитики
```

### 4.6 Wallet Tracker / Copy-Trade

- Список tracked wallets с их WR, avg PnL, tier
- Последние сделки каждого wallet
- Кнопки: [Add Wallet] [Remove] [Promote to T1] [Demote]
- Loss streak индикатор

### 4.7 Logs / Diagnostics

- Live log stream (tail Pino JSON, фильтр по level)
- Geyser event queue size, processing latency
- Jito bundle stats: sent/landed/invalid/timeout
- RPC call count, avg latency, rate limit hits

## 5. Real-time обновления (Socket.IO events)

```typescript
// Server → Client events:
'position:open'      // новая позиция
'position:update'    // PnL/price/signal change
'position:close'     // позиция закрыта
'balance:update'     // баланс изменился
'social:signal'      // новый social signal
'alert:trigger'      // alert rule сработал
'system:status'      // geyser/jito/rpc status change
'config:changed'     // config изменён (другим клиентом)
'log:entry'          // новая строка лога

// Client → Server events:
'sell:now'           // принудительная продажа
'config:update'      // изменение параметра
'bot:start|stop'     // запуск/остановка
'blacklist:add|remove'
```

## 5.1 Фронтенд — ключевые блоки кода

### `web-ui/src/store/index.ts` — Zustand store

```typescript
import { create } from 'zustand';
import { socket } from '../lib/socket';

export interface Position {
  mint: string;
  protocol: string;
  entryPrice: number;
  currentPrice: number;
  pnlPercent: number;
  amount: number;
  entryAmountSol: number;
  openedAt: number;
  ageMs: number;
  runnerTail: boolean;
  exitSignals: string[];
}

export interface SystemStatus {
  geyser: 'ok' | 'reconnecting' | 'down';
  jito: 'ok' | 'rate-limited' | 'down';
  rpcLatencyMs: number;
  isRunning: boolean;
  defensiveMode: boolean;
}

interface AppState {
  positions: Record<string, Position>;
  balanceSol: number;
  status: SystemStatus;
  setPositions: (positions: Position[]) => void;
  updatePosition: (p: Position) => void;
  removePosition: (mint: string) => void;
  setBalance: (sol: number) => void;
  setStatus: (s: Partial<SystemStatus>) => void;
}

export const useStore = create<AppState>((set) => ({
  positions: {},
  balanceSol: 0,
  status: { geyser: 'ok', jito: 'ok', rpcLatencyMs: 0, isRunning: false, defensiveMode: false },

  setPositions: (list) => set({ positions: Object.fromEntries(list.map(p => [p.mint, p])) }),
  updatePosition: (p) => set(s => ({ positions: { ...s.positions, [p.mint]: p } })),
  removePosition: (mint) => set(s => {
    const next = { ...s.positions };
    delete next[mint];
    return { positions: next };
  }),
  setBalance: (sol) => set({ balanceSol: sol }),
  setStatus: (partial) => set(s => ({ status: { ...s.status, ...partial } })),
}));

// Подключаем Socket.IO события к store
export function bindSocketToStore() {
  socket.on('snapshot',          (d) => { useStore.getState().setPositions(d.positions); useStore.getState().setStatus({ isRunning: d.isRunning, defensiveMode: d.defensiveMode }); });
  socket.on('position:open',     (p) => useStore.getState().updatePosition(p));
  socket.on('position:update',   (p) => useStore.getState().updatePosition(p));
  socket.on('position:close',    (p) => useStore.getState().removePosition(p.mint));
  socket.on('balance:update',    (d) => useStore.getState().setBalance(d.sol));
  socket.on('system:status',     (d) => useStore.getState().setStatus(d));
}
```

### `web-ui/src/lib/socket.ts` — Socket.IO клиент

```typescript
import { io } from 'socket.io-client';

export const socket = io(import.meta.env.VITE_API_URL ?? '', {
  auth: { token: document.cookie.match(/token=([^;]+)/)?.[1] ?? '' },
  autoConnect: true,
  reconnection: true,
  reconnectionDelay: 2000,
});
```

### `web-ui/src/lib/api.ts` — REST клиент

```typescript
const BASE = import.meta.env.VITE_API_URL ?? '';

async function request<T>(method: string, path: string, body?: any): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
  return res.json();
}

export const api = {
  login:      (password: string)           => request('POST', '/login', { password }),
  start:      ()                           => request('POST', '/control/start'),
  stop:       ()                           => request('POST', '/control/stop'),
  sellNow:    (mint: string)               => request('POST', `/control/sell/${mint}`),
  closeAll:   ()                           => request('POST', '/control/close-all'),
  getConfig:  ()                           => request('GET',  '/config'),
  setConfig:  (changes: {path:string; value:any}[]) => request('PUT', '/config', { changes }),
  rollback:   ()                           => request('POST', '/config/rollback'),
  getTrades:  (params?: Record<string,any>) => request('GET', `/trades?${new URLSearchParams(params)}`),
  getStats:   ()                           => request('GET', '/trades/stats'),
  getWallet:  ()                           => request('GET', '/wallet'),
  getBlacklist: ()                         => request('GET', '/blacklist'),
  blacklistMint: (mint: string)            => request('POST', `/blacklist/mint/${mint}`),
  unblacklistMint: (mint: string)          => request('DELETE', `/blacklist/mint/${mint}`),
};
```

### `web-ui/src/App.tsx` — роутинг

```tsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect } from 'react';
import { bindSocketToStore } from './store';
import { Layout } from './components/Layout';
import { Dashboard }    from './pages/Dashboard';
import { Positions }    from './pages/Positions';
import { Config }       from './pages/Config';
import { SocialFeed }   from './pages/SocialFeed';
import { TokenQuality } from './pages/TokenQuality';
import { WalletTracker } from './pages/WalletTracker';
import { Logs }         from './pages/Logs';
import { Login }        from './pages/Login';

export default function App() {
  useEffect(() => { bindSocketToStore(); }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/dashboard" />} />
          <Route path="/dashboard"     element={<Dashboard />} />
          <Route path="/positions"     element={<Positions />} />
          <Route path="/config"        element={<Config />} />
          <Route path="/social"        element={<SocialFeed />} />
          <Route path="/tokens"        element={<TokenQuality />} />
          <Route path="/wallets"       element={<WalletTracker />} />
          <Route path="/logs"          element={<Logs />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
```

### `web-ui/src/components/Layout.tsx` — боковое меню

```tsx
import { Outlet, NavLink } from 'react-router-dom';
import { useStore } from '../store';
import { LayoutDashboard, ListOrdered, Settings, Rss, Star, Users, Terminal } from 'lucide-react';

const nav = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/positions',  icon: ListOrdered,    label: 'Positions' },
  { to: '/config',     icon: Settings,       label: 'Config' },
  { to: '/social',     icon: Rss,            label: 'Social Feed' },
  { to: '/tokens',     icon: Star,           label: 'Token Quality' },
  { to: '/wallets',    icon: Users,          label: 'Copy-Trade' },
  { to: '/logs',       icon: Terminal,       label: 'Logs' },
];

export function Layout() {
  const { balanceSol, status } = useStore();
  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      <aside className="w-56 flex flex-col border-r border-zinc-800 p-4 gap-1">
        <div className="text-lg font-bold mb-4 text-green-400">⚡ Sniper</div>
        {nav.map(({ to, icon: Icon, label }) => (
          <NavLink key={to} to={to}
            className={({ isActive }) =>
              `flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition
               ${isActive ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-white hover:bg-zinc-900'}`}>
            <Icon size={16} />{label}
          </NavLink>
        ))}
        <div className="mt-auto text-xs text-zinc-500 space-y-1">
          <div>Balance: <span className="text-green-400">{balanceSol.toFixed(3)} SOL</span></div>
          <div className="flex items-center gap-1">
            <span className={`w-2 h-2 rounded-full ${status.geyser === 'ok' ? 'bg-green-500' : 'bg-red-500'}`} />
            Geyser {status.geyser}
          </div>
          <div>{status.isRunning ? '🟢 Running' : '🔴 Stopped'}</div>
        </div>
      </aside>
      <main className="flex-1 overflow-auto p-6"><Outlet /></main>
    </div>
  );
}
```

### `web-ui/src/pages/Dashboard.tsx`

```tsx
import { useStore } from '../store';
import { PositionCard } from '../components/PositionCard';
import { PnLChart } from '../components/PnLChart';
import { SystemStatus } from '../components/SystemStatus';
import { api } from '../lib/api';

export function Dashboard() {
  const { positions, balanceSol, status } = useStore();
  const positionList = Object.values(positions);

  return (
    <div className="space-y-6">
      {/* Хедер */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <div className="flex gap-2">
          {status.isRunning
            ? <button onClick={() => api.stop()}  className="px-4 py-2 bg-red-600 rounded-lg text-sm">Stop Bot</button>
            : <button onClick={() => api.start()} className="px-4 py-2 bg-green-600 rounded-lg text-sm">Start Bot</button>}
          <button onClick={() => { if (confirm('Close ALL positions?')) api.closeAll(); }}
            className="px-4 py-2 bg-zinc-700 rounded-lg text-sm">Close All</button>
        </div>
      </div>

      {/* Статистика */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard label="Balance"     value={`${balanceSol.toFixed(3)} SOL`} />
        <StatCard label="Positions"   value={positionList.length} />
        <StatCard label="Defensive"   value={status.defensiveMode ? 'ON' : 'OFF'} color={status.defensiveMode ? 'text-yellow-400' : 'text-green-400'} />
        <StatCard label="RPC Latency" value={`${status.rpcLatencyMs}ms`} />
      </div>

      {/* PnL Chart */}
      <div className="bg-zinc-900 rounded-xl p-4">
        <h2 className="text-sm font-medium text-zinc-400 mb-3">Equity Curve</h2>
        <PnLChart />
      </div>

      {/* Активные позиции */}
      <div>
        <h2 className="text-sm font-medium text-zinc-400 mb-3">Active Positions ({positionList.length})</h2>
        {positionList.length === 0
          ? <div className="text-zinc-600 text-sm">No open positions</div>
          : <div className="grid grid-cols-2 gap-3">
              {positionList.map(p => <PositionCard key={p.mint} position={p} />)}
            </div>}
      </div>

      <SystemStatus />
    </div>
  );
}

function StatCard({ label, value, color = 'text-white' }: { label: string; value: any; color?: string }) {
  return (
    <div className="bg-zinc-900 rounded-xl p-4">
      <div className="text-xs text-zinc-500 mb-1">{label}</div>
      <div className={`text-xl font-bold ${color}`}>{value}</div>
    </div>
  );
}
```

### `web-ui/src/components/PositionCard.tsx`

```tsx
import type { Position } from '../store';
import { api } from '../lib/api';

export function PositionCard({ position: p }: { position: Position }) {
  const pnlColor = p.pnlPercent >= 0 ? 'text-green-400' : 'text-red-400';
  const ageMin   = Math.floor(p.ageMs / 60_000);

  return (
    <div className={`bg-zinc-900 border rounded-xl p-4 space-y-2
      ${p.runnerTail ? 'border-yellow-500/40' : 'border-zinc-800'}`}>
      <div className="flex justify-between items-start">
        <div>
          <a href={`https://solscan.io/token/${p.mint}`} target="_blank"
             className="text-xs font-mono text-blue-400 hover:underline">
            {p.mint.slice(0,8)}…
          </a>
          <div className="text-xs text-zinc-500">{p.protocol} · {ageMin}m ago</div>
        </div>
        <div className={`text-lg font-bold ${pnlColor}`}>
          {p.pnlPercent >= 0 ? '+' : ''}{p.pnlPercent.toFixed(1)}%
          {p.runnerTail && <span className="ml-1 text-yellow-400 text-xs">🏃</span>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 text-xs text-zinc-400">
        <span>Entry: {p.entryPrice.toFixed(8)}</span>
        <span>Now: {p.currentPrice.toFixed(8)}</span>
        <span>Amount: {p.amount.toFixed(0)}</span>
        <span>In: {p.entryAmountSol.toFixed(3)} SOL</span>
      </div>

      {p.exitSignals.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {p.exitSignals.map(s => (
            <span key={s} className="text-xs bg-yellow-900/40 text-yellow-300 px-1.5 py-0.5 rounded">{s}</span>
          ))}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button onClick={() => { if (confirm(`Sell ${p.mint.slice(0,8)}?`)) api.sellNow(p.mint); }}
          className="flex-1 py-1.5 bg-red-600/80 hover:bg-red-600 rounded text-xs">
          Sell Now
        </button>
        <a href={`https://dexscreener.com/solana/${p.mint}`} target="_blank"
           className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-xs">
          Chart
        </a>
      </div>
    </div>
  );
}
```

### `web-ui/src/components/PnLChart.tsx`

```tsx
import { useEffect, useRef } from 'react';
import { createChart, ColorType, LineStyle } from 'lightweight-charts';
import { api } from '../lib/api';

export function PnLChart() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      layout:     { background: { type: ColorType.Solid, color: '#18181b' }, textColor: '#a1a1aa' },
      grid:       { vertLines: { color: '#27272a' }, horzLines: { color: '#27272a' } },
      width:      ref.current.clientWidth,
      height:     200,
    });

    const series = chart.addAreaSeries({
      lineColor: '#22c55e', topColor: '#22c55e33', bottomColor: 'transparent',
      lineWidth: 2,
    });

    // Загружаем снапшоты PnL
    api.getTrades({ limit: '200' }).then((data: any) => {
      const points = (data.trades as any[])
        .filter(t => t.closed_at)
        .sort((a, b) => a.closed_at - b.closed_at)
        .reduce((acc: any[], t, i) => {
          const prev = acc[i - 1]?.value ?? 0;
          acc.push({ time: Math.floor(t.closed_at / 1000), value: prev + (t.exit_amount_sol - t.entry_amount_sol) });
          return acc;
        }, []);
      series.setData(points);
      chart.timeScale().fitContent();
    });

    const ro = new ResizeObserver(() => chart.applyOptions({ width: ref.current!.clientWidth }));
    ro.observe(ref.current);
    return () => { chart.remove(); ro.disconnect(); };
  }, []);

  return <div ref={ref} />;
}
```

### `web-ui/src/pages/Config.tsx` — редактор конфига

```tsx
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export function Config() {
  const [cfg, setCfg] = useState<any>(null);
  const [pending, setPending] = useState<Record<string, any>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => { api.getConfig().then(setCfg); }, []);

  const handleChange = (path: string, value: any) =>
    setPending(p => ({ ...p, [path]: value }));

  const handleApply = async () => {
    const changes = Object.entries(pending).map(([path, value]) => ({ path, value }));
    await api.setConfig(changes);
    setSaved(true);
    setPending({});
    setTimeout(() => setSaved(false), 2000);
  };

  if (!cfg) return <div className="text-zinc-400">Loading config...</div>;

  // Рендерим группы параметров
  const groups = [
    { label: 'Entry', paths: [
      'strategy.pumpFun.entryAmountSol',
      'strategy.pumpFun.slippageBps',
      'strategy.minTokenScore',
      'strategy.minBalanceToTradeSol',
    ]},
    { label: 'Pump.fun Exit', paths: [
      'strategy.pumpFun.exit.entryStopLossPercent',
      'strategy.pumpFun.exit.hardStopPercent',
      'strategy.pumpFun.exit.trailingActivationPercent',
      'strategy.pumpFun.exit.trailingDrawdownPercent',
      'strategy.pumpFun.exit.timeStopAfterMs',
    ]},
    { label: 'Jito', paths: [
      'jito.tipAmountSol',
      'jito.maxTipAmountSol',
      'jito.maxRetries',
    ]},
    { label: 'Copy-Trade', paths: [
      'copyTrade.entryAmountSol',
      'copyTrade.tier2EntryAmountSol',
      'copyTrade.maxPositions',
    ]},
  ];

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Configuration</h1>
        <div className="flex gap-2">
          <button onClick={() => { if (confirm('Rollback all recent changes?')) api.rollback().then(() => api.getConfig().then(setCfg)); }}
            className="px-3 py-1.5 bg-zinc-700 rounded text-sm">Rollback</button>
          <button onClick={handleApply} disabled={!Object.keys(pending).length}
            className="px-3 py-1.5 bg-green-600 disabled:opacity-40 rounded text-sm">
            {saved ? '✓ Saved' : 'Apply'}
          </button>
        </div>
      </div>

      {groups.map(({ label, paths }) => (
        <div key={label} className="bg-zinc-900 rounded-xl p-4 space-y-3">
          <h2 className="text-sm font-semibold text-zinc-400">{label}</h2>
          {paths.map(path => {
            const keys = path.split('.');
            const current = keys.reduce((o, k) => o?.[k], cfg);
            const isDirty = path in pending;
            return (
              <div key={path} className="flex items-center gap-3">
                <label className="text-xs text-zinc-400 w-64">{keys[keys.length - 1]}</label>
                <input
                  type="number" step="any"
                  defaultValue={current}
                  onChange={e => handleChange(path, Number(e.target.value))}
                  className={`bg-zinc-800 border rounded px-2 py-1 text-sm w-32
                    ${isDirty ? 'border-yellow-500' : 'border-zinc-700'}`}
                />
                {isDirty && <span className="text-xs text-yellow-400">→ {pending[path]}</span>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
```

### `web-ui/src/components/SystemStatus.tsx`

```tsx
import { useStore } from '../store';

export function SystemStatus() {
  const { status } = useStore();
  const dot = (ok: boolean) =>
    <span className={`inline-block w-2 h-2 rounded-full ${ok ? 'bg-green-500' : 'bg-red-500'}`} />;

  return (
    <div className="bg-zinc-900 rounded-xl p-4">
      <h2 className="text-sm font-medium text-zinc-400 mb-3">System Status</h2>
      <div className="grid grid-cols-3 gap-4 text-xs">
        <div className="flex items-center gap-2">{dot(status.geyser === 'ok')} Geyser: {status.geyser}</div>
        <div className="flex items-center gap-2">{dot(status.jito === 'ok')} Jito: {status.jito}</div>
        <div className="flex items-center gap-2">{dot(status.rpcLatencyMs < 500)} RPC: {status.rpcLatencyMs}ms</div>
      </div>
    </div>
  );
}
```

### `web-ui/src/pages/Login.tsx`

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

export function Login() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const nav = useNavigate();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.login(password);
      nav('/dashboard');
    } catch {
      setError('Invalid password');
    }
  };

  return (
    <div className="flex items-center justify-center h-screen bg-zinc-950">
      <form onSubmit={submit} className="bg-zinc-900 p-8 rounded-2xl space-y-4 w-80">
        <h1 className="text-xl font-bold text-center">⚡ Sniper</h1>
        <input type="password" placeholder="Password" value={password}
          onChange={e => setPassword(e.target.value)}
          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm" />
        {error && <div className="text-red-400 text-xs">{error}</div>}
        <button type="submit" className="w-full bg-green-600 hover:bg-green-500 rounded-lg py-2 text-sm font-medium">
          Login
        </button>
      </form>
    </div>
  );
}
```

### `web-ui/vite.config.ts`

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api':      { target: 'http://localhost:3001', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:3001', ws: true },
    },
  },
  build: { outDir: '../web-ui/dist' },
});
```

### `web-ui/.env.example`

```env
VITE_API_URL=https://sniper.yourdomain.com
```

---

## 6. Безопасность

- **JWT auth**: логин/пароль, токен в httpOnly cookie
- **HTTPS**: Let's Encrypt через Caddy reverse proxy
- **IP whitelist** (опционально): ограничить доступ по IP
- **Rate limiting**: express-rate-limit на API endpoints
- **Никаких приватных ключей в UI** — только публичный адрес кошелька
- **Confirmation dialogs**: для sell, config changes, bot stop
- **Audit log**: кто и когда менял конфиг

## 7. Интеграция с существующим кодом

### Что меняется

| Файл | Изменение |
|------|-----------|
| `src/index.ts` | Запуск web server вместо/параллельно TelegramBot |
| `src/core/sniper.ts` | Добавить EventEmitter для UI events (position changes) |
| `src/config.ts` | Runtime-mutable config object + save to disk |
| `src/utils/token-scorer.ts` | Экспортировать score breakdown (не только total) |
| `src/utils/social.ts` | Расширить → `src/social/` модуль |

### Что НЕ меняется

- Вся trading логика (sniper, sell-engine, position, detector)
- Geyser client, Jito bundle, RPC infra
- Trading modules (buy.ts, sell.ts, pumpSwap.ts, raydium*.ts)

### Telegram бот

Не удалять сразу — оставить как **notification-only channel** (алерты о сделках). Убрать команды управления, оставить read-only уведомления.

## 8. Runtime Config (горячее изменение)

```typescript
// src/config.ts — добавить:
class RuntimeConfig {
  private _config: Config;
  private _listeners: Set<(path: string, value: any) => void> = new Set();

  get<T>(path: string): T { /* lodash.get */ }
  
  set(path: string, value: any): void {
    /* lodash.set + validate + notify listeners + save to disk */
  }

  onChange(fn: (path: string, value: any) => void): void {
    this._listeners.add(fn);
  }
}

export const runtimeConfig = new RuntimeConfig(config);
```

## 9. SQLite схема (минимальная)

```sql
CREATE TABLE trades (
  id INTEGER PRIMARY KEY,
  mint TEXT NOT NULL,
  protocol TEXT,
  entry_price REAL,
  exit_price REAL,
  entry_amount_sol REAL,
  exit_amount_sol REAL,
  pnl_percent REAL,
  token_score INTEGER,
  exit_reason TEXT,
  sell_path TEXT,
  opened_at INTEGER,
  closed_at INTEGER,
  is_copy_trade BOOLEAN DEFAULT 0
);

CREATE TABLE social_signals (
  id INTEGER PRIMARY KEY,
  mint TEXT,
  ticker TEXT,
  source TEXT,           -- twitter/telegram/dexscreener/etc
  mention_count INTEGER,
  sentiment REAL,        -- -1.0 .. +1.0
  raw_text TEXT,
  author TEXT,
  followers INTEGER,
  timestamp INTEGER
);

CREATE TABLE config_history (
  id INTEGER PRIMARY KEY,
  changed_at INTEGER,
  path TEXT,
  old_value TEXT,
  new_value TEXT
);

CREATE TABLE pnl_snapshots (
  id INTEGER PRIMARY KEY,
  timestamp INTEGER,
  balance_sol REAL,
  total_pnl_sol REAL,
  open_positions INTEGER,
  win_rate REAL
);
```

## 10. Приоритеты реализации

### Phase 1 (неделя 1): Core Dashboard
- Express + Socket.IO server
- JWT auth
- Dashboard: баланс, активные позиции, PnL сегодня
- Control: start/stop, sell now
- SQLite миграция trades из JSONL

### Phase 2 (неделя 2): Config + History
- Config editor с live apply
- Trades history таблица с фильтрами
- PnL график (equity curve)
- Wallet tracker UI
- Blacklist management

### Phase 3 (неделя 3): Social + Intelligence
- Social parsers (Twitter, Telegram, DexScreener)
- Агрегированная лента
- Sentiment scoring
- Alert rules engine
- Корреляция social → price
- Token quality heatmap

### Phase 4 (опционально): Polish
- Mobile responsive layout
- Push notifications (Web Push API)
- Presets для конфига
- Экспорт отчётов (CSV/PDF)
- Backtesting UI на исторических данных

## 11. Файловая структура (итоговая)

```
src/
├── web/
│   ├── server.ts
│   ├── auth.ts
│   ├── routes/
│   │   ├── config.ts
│   │   ├── positions.ts
│   │   ├── trades.ts
│   │   ├── wallet.ts
│   │   ├── control.ts
│   │   ├── blacklist.ts
│   │   └── social.ts
│   └── ws/
│       └── events.ts
├── social/
│   ├── manager.ts
│   ├── parsers/
│   │   ├── twitter.ts
│   │   ├── telegram.ts
│   │   ├── dexscreener.ts
│   │   ├── birdeye.ts
│   │   ├── pumpfun.ts
│   │   └── reddit.ts
│   ├── nlp/
│   │   └── sentiment.ts
│   ├── models/
│   │   └── signal.ts
│   └── storage/
│       └── signal-store.ts
├── db/
│   ├── sqlite.ts        # Подключение + миграции
│   └── migrations/
│       └── 001_init.sql
├── core/                 # без изменений
├── trading/              # без изменений
├── geyser/               # без изменений
├── jito/                 # без изменений
├── infra/                # без изменений
├── bot/
│   └── bot.ts            # Только notifications (read-only)
└── utils/                # без изменений

web-ui/                   # React SPA (отдельный Vite проект)
├── src/
│   ├── App.tsx
│   ├── pages/
│   │   ├── Dashboard.tsx
│   │   ├── Positions.tsx
│   │   ├── TokenQuality.tsx
│   │   ├── Config.tsx
│   │   ├── SocialFeed.tsx
│   │   ├── WalletTracker.tsx
│   │   └── Logs.tsx
│   ├── components/
│   │   ├── PositionCard.tsx
│   │   ├── PnLChart.tsx
│   │   ├── ScoreBreakdown.tsx
│   │   ├── ConfigForm.tsx
│   │   ├── SocialSignalCard.tsx
│   │   └── SystemStatus.tsx
│   ├── hooks/
│   │   ├── useSocket.ts
│   │   ├── usePositions.ts
│   │   └── useConfig.ts
│   └── store/
│       └── index.ts      # Zustand store
├── package.json
└── vite.config.ts
```

## 12. Зависимости (новые)

```json
{
  "dependencies": {
    "express": "^4.18",
    "socket.io": "^4.7",
    "better-sqlite3": "^9.4",
    "jsonwebtoken": "^9.0",
    "bcrypt": "^5.1",
    "express-rate-limit": "^7.1",
    "lodash": "^4.17",
    "gram-js": "^2.22"
  }
}
```

Frontend (web-ui/):
```json
{
  "dependencies": {
    "react": "^18.2",
    "react-dom": "^18.2",
    "react-router-dom": "^6.20",
    "socket.io-client": "^4.7",
    "lightweight-charts": "^4.1",
    "zustand": "^4.4",
    "@tanstack/react-table": "^8.10",
    "tailwindcss": "^3.4",
    "lucide-react": "^0.300"
  }
}
```

## 13. Деплой на VPS

```bash
# Build
cd web-ui && npm run build    # → web-ui/dist/
cd .. && npm run build        # → dist/

# Caddy reverse proxy (HTTPS)
# /etc/caddy/Caddyfile:
# sniper.yourdomain.com {
#   reverse_proxy localhost:3001
#   encode gzip
# }

# PM2
pm2 start dist/index.js --name sniper
```

---

## 13.1 Социальные парсеры — ключевые блоки кода

### `src/social/models/signal.ts`

```typescript
export interface SocialSignal {
  id?:          number;
  source:       'twitter' | 'telegram' | 'dexscreener' | 'birdeye' | 'pumpfun' | 'reddit';
  mint?:        string;
  ticker?:      string;
  mentionCount: number;
  sentiment:    number;   // -1.0 .. +1.0
  rawText?:     string;
  author?:      string;
  followers?:   number;
  timestamp:    number;
}
```

### `src/social/nlp/sentiment.ts` — keyword-based sentiment

```typescript
const POSITIVE = ['moon', 'pump', 'bullish', 'gem', 'lfg', '🚀', '💎', 'alpha', 'buy', 'early', 'huge', 'launch'];
const NEGATIVE = ['rug', 'scam', 'dump', 'sell', 'avoid', 'honeypot', 'bearish', 'dead', 'exit', '⚠️', 'warning'];

export function scoreSentiment(text: string): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const w of POSITIVE) if (lower.includes(w)) score += 1;
  for (const w of NEGATIVE) if (lower.includes(w)) score -= 1;
  // Нормализация в [-1, 1]
  return Math.max(-1, Math.min(1, score / 3));
}
```

### `src/social/parsers/dexscreener.ts` — trending tokens

```typescript
import axios from 'axios';
import { scoreSentiment } from '../nlp/sentiment';
import type { SocialSignal } from '../models/signal';

const BASE = 'https://api.dexscreener.com/latest/dex';

export async function fetchDexscreenerTrending(): Promise<SocialSignal[]> {
  const { data } = await axios.get(`${BASE}/tokens/solana`, { timeout: 5000 });
  return (data.pairs ?? [])
    .filter((p: any) => p.chainId === 'solana' && p.volume?.h1 > 10000)
    .slice(0, 20)
    .map((p: any): SocialSignal => ({
      source:       'dexscreener',
      mint:         p.baseToken?.address,
      ticker:       p.baseToken?.symbol,
      mentionCount: 1,
      sentiment:    p.priceChange?.h1 > 0 ? 0.5 : -0.5,
      rawText:      `Vol $${(p.volume.h1 / 1000).toFixed(0)}k | +${p.priceChange?.h1 ?? 0}% 1h`,
      timestamp:    Date.now(),
    }));
}

export async function fetchNewPairs(): Promise<SocialSignal[]> {
  const { data } = await axios.get(`${BASE}/pairs/solana/new`, { timeout: 5000 });
  return (data.pairs ?? []).slice(0, 10).map((p: any): SocialSignal => ({
    source:       'dexscreener',
    mint:         p.baseToken?.address,
    ticker:       p.baseToken?.symbol,
    mentionCount: 1,
    sentiment:    0.3,
    rawText:      `New pair: ${p.baseToken?.symbol} / ${p.quoteToken?.symbol}`,
    timestamp:    Date.now(),
  }));
}
```

### `src/social/parsers/twitter.ts` — через RapidAPI

```typescript
import axios from 'axios';
import { scoreSentiment } from '../nlp/sentiment';
import type { SocialSignal } from '../models/signal';

const RAPID_KEY  = process.env.RAPIDAPI_KEY!;
const RAPID_HOST = 'twitter-api45.p.rapidapi.com';
// Минимум followers для учёта автора
const MIN_FOLLOWERS = Number(process.env.TWITTER_MIN_FOLLOWERS ?? 500);

export async function searchTwitter(query: string): Promise<SocialSignal[]> {
  if (!RAPID_KEY) return [];
  try {
    const { data } = await axios.get('https://twitter-api45.p.rapidapi.com/search.php', {
      headers: { 'x-rapidapi-key': RAPID_KEY, 'x-rapidapi-host': RAPID_HOST },
      params:  { query, searchType: 'Latest' },
      timeout: 6000,
    });
    return (data.timeline ?? [])
      .filter((t: any) => (t.user?.followers ?? 0) >= MIN_FOLLOWERS)
      .map((t: any): SocialSignal => ({
        source:       'twitter',
        ticker:       query.replace('$', '').replace(' solana', '').trim(),
        mentionCount: 1,
        sentiment:    scoreSentiment(t.text ?? ''),
        rawText:      t.text,
        author:       t.user?.screen_name,
        followers:    t.user?.followers,
        timestamp:    new Date(t.created_at).getTime() || Date.now(),
      }));
  } catch (e: any) {
    return [];
  }
}
```

### `src/social/parsers/telegram.ts` — мониторинг каналов

Реализован как HTML-scraper публичного превью `t.me/s/{channel}`: без
api_id/api_hash/session, без аккаунта, без `telegram` NPM-пакета. Виден
только публичный контент (каналы с `@username`); приватные invite-links
(`t.me/+xxx`) пропускаются с warn-логом. Список каналов —
`TG_ALPHA_CHANNELS` (CSV) или хардкодед `DEFAULT_CHANNELS` в исходнике.
Poll-интервал: 30s. Подробнее — см. сам файл `src/social/parsers/telegram.ts`.

### `src/social/parsers/birdeye.ts` — whale alerts

```typescript
import axios from 'axios';
import type { SocialSignal } from '../models/signal';

const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY ?? '';
const BASE        = 'https://public-api.birdeye.so';

export async function fetchWhaleAlerts(): Promise<SocialSignal[]> {
  if (!BIRDEYE_KEY) return [];
  const { data } = await axios.get(`${BASE}/defi/txs/token`, {
    headers: { 'X-API-KEY': BIRDEYE_KEY },
    params: { sort_by: 'block_time', sort_type: 'desc', offset: 0, limit: 20, min_value: 50000 },
    timeout: 5000,
  });
  return (data.data?.items ?? []).map((tx: any): SocialSignal => ({
    source:       'birdeye',
    mint:         tx.address,
    mentionCount: 1,
    sentiment:    tx.side === 'buy' ? 0.6 : -0.3,
    rawText:      `Whale ${tx.side}: $${(tx.value / 1000).toFixed(0)}k`,
    timestamp:    tx.blockUnixTime * 1000,
  }));
}
```

### `src/social/storage/signal-store.ts`

```typescript
import { db } from '../../db/sqlite';
import type { SocialSignal } from '../models/signal';

export function saveSignal(signal: SocialSignal) {
  db.prepare(`INSERT INTO social_signals
    (mint, ticker, source, mention_count, sentiment, raw_text, author, followers, timestamp)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    signal.mint ?? null, signal.ticker ?? null, signal.source,
    signal.mentionCount, signal.sentiment, signal.rawText ?? null,
    signal.author ?? null, signal.followers ?? null, signal.timestamp,
  );
}

export function getMentionCounts(windowMs = 5 * 60_000): Record<string, number> {
  const since = Date.now() - windowMs;
  const rows = db.prepare(`
    SELECT ticker, SUM(mention_count) as total
    FROM social_signals WHERE timestamp >= ? AND ticker IS NOT NULL
    GROUP BY ticker ORDER BY total DESC LIMIT 50
  `).all(since) as { ticker: string; total: number }[];
  return Object.fromEntries(rows.map(r => [r.ticker, r.total]));
}

export function getRecentSignals(limit = 50): SocialSignal[] {
  return db.prepare(`SELECT * FROM social_signals ORDER BY timestamp DESC LIMIT ?`).all(limit) as SocialSignal[];
}
```

### `src/social/manager.ts` — координатор всех парсеров

```typescript
import { EventEmitter } from 'events';
import { fetchDexscreenerTrending, fetchNewPairs } from './parsers/dexscreener';
import { searchTwitter }    from './parsers/twitter';
import { fetchTelegramSignals, initTelegramParser } from './parsers/telegram';
import { fetchWhaleAlerts } from './parsers/birdeye';
import { saveSignal, getMentionCounts } from './storage/signal-store';
import type { SocialSignal } from './models/signal';
import { logger } from '../utils/logger';

export class SocialManager extends EventEmitter {
  private _seen = new Set<string>(); // дедупликация
  private _intervals: NodeJS.Timeout[] = [];

  async start() {
    await initTelegramParser();
    // Разные интервалы для разных источников
    this._intervals.push(
      setInterval(() => this._run(fetchDexscreenerTrending), 30_000),
      setInterval(() => this._run(fetchNewPairs),            60_000),
      setInterval(() => this._run(fetchTelegramSignals),     15_000),
      setInterval(() => this._run(fetchWhaleAlerts),         20_000),
    );
    // Первый запуск сразу
    this._run(fetchDexscreenerTrending);
    this._run(fetchTelegramSignals);
    logger.info('SocialManager started');
  }

  stop() { this._intervals.forEach(clearInterval); }

  private async _run(fn: () => Promise<SocialSignal[]>) {
    try {
      const signals = await fn();
      for (const s of signals) {
        const key = `${s.source}:${s.ticker ?? s.mint}:${Math.floor(s.timestamp / 60_000)}`;
        if (this._seen.has(key)) continue;
        this._seen.add(key);
        if (this._seen.size > 10_000) this._seen.clear(); // memory guard
        saveSignal(s);
        this.emit('signal', s);
      }
    } catch (e: any) {
      logger.debug(`SocialManager error: ${e.message}`);
    }
  }

  getMentions(windowMs?: number) { return getMentionCounts(windowMs); }
}

export const socialManager = new SocialManager();
```

### `src/web/routes/social.ts`

```typescript
import { Router } from 'express';
import { getRecentSignals, getMentionCounts } from '../../social/storage/signal-store';

export function socialRouter() {
  const router = Router();

  router.get('/feed',     (_, res) => res.json(getRecentSignals(50)));
  router.get('/mentions', (req, res) => {
    const windowMs = Number(req.query.window ?? 5 * 60_000);
    res.json(getMentionCounts(windowMs));
  });

  return router;
}
```

### `web-ui/src/pages/SocialFeed.tsx`

```tsx
import { useEffect, useState } from 'react';
import { socket } from '../lib/socket';
import { api } from '../lib/api';
import type { SocialSignal } from '../../../src/social/models/signal';

export function SocialFeed() {
  const [signals, setSignals]   = useState<SocialSignal[]>([]);
  const [mentions, setMentions] = useState<Record<string, number>>({});

  useEffect(() => {
    api.getTrades({ limit: '0' }); // прогрев
    fetch('/api/social/feed').then(r => r.json()).then(setSignals);
    fetch('/api/social/mentions').then(r => r.json()).then(setMentions);
    socket.on('social:signal', (s: SocialSignal) =>
      setSignals(prev => [s, ...prev].slice(0, 100)));
    return () => { socket.off('social:signal'); };
  }, []);

  const sourceColor = (s: string) => ({
    twitter: 'text-sky-400', telegram: 'text-blue-400',
    dexscreener: 'text-green-400', birdeye: 'text-purple-400',
    pumpfun: 'text-pink-400', reddit: 'text-orange-400',
  }[s] ?? 'text-zinc-400');

  return (
    <div className="grid grid-cols-3 gap-6">
      {/* Топ упоминаний */}
      <div className="bg-zinc-900 rounded-xl p-4 col-span-1">
        <h2 className="text-sm font-medium text-zinc-400 mb-3">Top Mentions (5m)</h2>
        <div className="space-y-2">
          {Object.entries(mentions).sort((a,b) => b[1]-a[1]).slice(0,15).map(([ticker, count]) => (
            <div key={ticker} className="flex justify-between text-sm">
              <span className="font-mono text-white">${ticker}</span>
              <span className="text-zinc-400">{count}x</span>
            </div>
          ))}
        </div>
      </div>

      {/* Лента сигналов */}
      <div className="col-span-2 space-y-2">
        <h2 className="text-sm font-medium text-zinc-400 mb-3">Live Feed</h2>
        {signals.map((s, i) => (
          <div key={i} className="bg-zinc-900 rounded-lg p-3 text-xs space-y-1">
            <div className="flex justify-between">
              <span className={sourceColor(s.source)}>{s.source}</span>
              <span className="text-zinc-600">{new Date(s.timestamp).toLocaleTimeString()}</span>
            </div>
            {s.ticker && <span className="font-mono text-green-400">${s.ticker}</span>}
            <div className="text-zinc-300">{s.rawText?.slice(0, 120)}</div>
            <div className={`text-xs ${s.sentiment > 0 ? 'text-green-400' : s.sentiment < 0 ? 'text-red-400' : 'text-zinc-500'}`}>
              sentiment: {s.sentiment > 0 ? '+' : ''}{s.sentiment.toFixed(2)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

## 14. Дополнительные модули

### 14.1 Portfolio Heatmap
- Визуальная карта всех сделок за период (как GitHub contributions)
- Ось X — час дня, ось Y — день недели
- Цвет — средний PnL в этой ячейке
- **Цель**: выявить лучшие часы для торговли, отключить бота в убыточные слоты

```typescript
// src/web/routes/analytics.ts — endpoint для heatmap
router.get('/heatmap', (_, res) => {
  // 7 дней × 24 часа матрица avg PnL
  const rows = db.prepare(`
    SELECT
      strftime('%w', datetime(closed_at/1000, 'unixepoch')) AS dow,  -- 0=Sun..6=Sat
      strftime('%H', datetime(closed_at/1000, 'unixepoch')) AS hour,
      AVG(pnl_percent) AS avgPnl,
      COUNT(*) AS trades
    FROM trades WHERE closed_at IS NOT NULL
    GROUP BY dow, hour
  `).all();
  res.json(rows);
});
```

```tsx
// web-ui/src/components/HeatmapChart.tsx
export function HeatmapChart({ data }: { data: { dow: string; hour: string; avgPnl: number; trades: number }[] }) {
  const DAYS  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const HOURS = Array.from({ length: 24 }, (_, i) => i);
  const matrix: Record<string, number> = {};
  data.forEach(r => { matrix[`${r.dow}-${r.hour}`] = r.avgPnl; });

  return (
    <div className="overflow-x-auto">
      <div className="grid gap-0.5" style={{ gridTemplateColumns: `40px repeat(24, 1fr)` }}>
        {/* Hour labels */}
        <div />{HOURS.map(h => <div key={h} className="text-center text-[10px] text-zinc-500">{h}</div>)}
        {/* Rows per day */}
        {DAYS.map((day, d) => (
          <>
            <div key={day} className="text-xs text-zinc-500 flex items-center">{day}</div>
            {HOURS.map(h => {
              const val = matrix[`${d}-${String(h).padStart(2,'0')}`] ?? null;
              const bg  = val === null ? 'bg-zinc-800'
                        : val > 10  ? 'bg-green-500'
                        : val > 0   ? 'bg-green-700'
                        : val > -10 ? 'bg-red-700'
                        :             'bg-red-500';
              return (
                <div key={h} title={val !== null ? `${val.toFixed(1)}%` : 'no data'}
                  className={`h-5 rounded-sm ${bg} cursor-pointer hover:opacity-80`} />
              );
            })}
          </>
        ))}
      </div>
    </div>
  );
}
```

### 14.2 Protocol Analytics
- Сравнительная таблица протоколов: Pump.fun vs PumpSwap vs Raydium
- Для каждого: win rate, avg PnL, avg hold time, best/worst trade
- Рекомендация: "PumpSwap даёт +2.3% avg PnL при hold >60s, рассмотрите увеличение maxPumpSwapPositions"
- Pie chart распределения объёма по протоколам

```typescript
// src/web/routes/analytics.ts
router.get('/protocols', (_, res) => {
  const rows = db.prepare(`
    SELECT
      protocol,
      COUNT(*) AS trades,
      SUM(CASE WHEN exit_amount_sol > entry_amount_sol THEN 1 ELSE 0 END) * 100.0 / COUNT(*) AS winRate,
      AVG(pnl_percent)  AS avgPnl,
      MAX(pnl_percent)  AS bestPnl,
      MIN(pnl_percent)  AS worstPnl,
      AVG((closed_at - opened_at) / 1000.0) AS avgHoldSec,
      SUM(entry_amount_sol) AS totalVolume
    FROM trades WHERE closed_at IS NOT NULL
    GROUP BY protocol
  `).all();

  // Авто-рекомендации
  const suggestions: string[] = [];
  for (const r of rows as any[]) {
    if (r.winRate > 55 && r.avgPnl > 5)
      suggestions.push(`${r.protocol}: WR ${r.winRate.toFixed(0)}% — consider increasing max positions`);
    if (r.winRate < 35)
      suggestions.push(`${r.protocol}: WR ${r.winRate.toFixed(0)}% — consider tightening entry filters`);
  }
  res.json({ protocols: rows, suggestions });
});
```

### 14.3 Risk Dashboard
- **Текущий exposure**: сколько SOL заблокировано в позициях (gauge chart)
- **Drawdown monitor**: текущий и максимальный drawdown за сессию/неделю/месяц
- **Risk-of-ruin калькулятор**: на основе текущего WR, avg win/loss, bankroll — вероятность потери X% депозита
- **Consecutive loss tracker**: визуальная серия W/L с текущей полосой
- **Auto-pause rules**: если drawdown >X% за день → пауза (настраивается через UI)

```typescript
// src/web/routes/analytics.ts — risk endpoint
router.get('/risk', (_, res) => {
  const stats = db.prepare(`
    SELECT
      SUM(CASE WHEN exit_amount_sol > entry_amount_sol THEN 1.0 ELSE 0 END) / COUNT(*) AS winRate,
      AVG(CASE WHEN exit_amount_sol > entry_amount_sol THEN pnl_percent ELSE NULL END) AS avgWin,
      AVG(CASE WHEN exit_amount_sol <= entry_amount_sol THEN pnl_percent ELSE NULL END) AS avgLoss
    FROM trades WHERE closed_at IS NOT NULL AND closed_at >= ?
  `).get(Date.now() - 7 * 86400_000) as any;

  // Risk of Ruin = ((1 - WR) / WR) ^ (bankroll / avgLoss)
  const wr  = stats?.winRate  ?? 0.5;
  const win = stats?.avgWin   ?? 10;
  const loss = Math.abs(stats?.avgLoss ?? 10);
  const ror = Math.pow((1 - wr) / wr, 10 / (loss || 1)); // 10% ruin threshold

  res.json({ winRate: wr, avgWin: win, avgLoss: loss, riskOfRuin: Math.min(1, ror) });
});
```

```tsx
// web-ui/src/components/RiskGauge.tsx
export function RiskGauge({ value, label }: { value: number; label: string }) {
  // value: 0-1, green→yellow→red
  const pct = Math.round(value * 100);
  const color = pct < 30 ? '#22c55e' : pct < 60 ? '#eab308' : '#ef4444';
  return (
    <div className="flex flex-col items-center">
      <svg width="80" height="50" viewBox="0 0 80 50">
        <path d="M10 45 A30 30 0 0 1 70 45" fill="none" stroke="#27272a" strokeWidth="8" />
        <path d="M10 45 A30 30 0 0 1 70 45" fill="none" stroke={color} strokeWidth="8"
          strokeDasharray={`${pct * 0.94} 94`} />
        <text x="40" y="46" textAnchor="middle" fill={color} fontSize="12" fontWeight="bold">{pct}%</text>
      </svg>
      <span className="text-xs text-zinc-500">{label}</span>
    </div>
  );
}
```

### 14.4 Liquidity Monitor
- Для каждой открытой позиции: текущая ликвидность пула в реальном времени
- Alert если ликвидность упала >30% от момента входа (rug signal)
- График ликвидности vs. цена токена
- **Цель**: раннее обнаружение rug pull до срабатывания stop-loss

```typescript
// src/web/routes/liquidity.ts
import { getConnection } from '../../infra/rpc';

router.get('/liquidity/:mint', async (req, res) => {
  const connection = getConnection();
  const { mint } = req.params;
  const state = getMintState(new PublicKey(mint));

  if (!state.poolBaseTokenAccount || !state.poolQuoteTokenAccount) {
    return res.json({ liquiditySol: null });
  }

  const [baseInfo, quoteInfo] = await Promise.all([
    connection.getTokenAccountBalance(state.poolBaseTokenAccount),
    connection.getTokenAccountBalance(state.poolQuoteTokenAccount),
  ]);

  res.json({
    baseAmount:   baseInfo.value.uiAmount,
    quoteAmount:  quoteInfo.value.uiAmount,  // SOL
    liquiditySol: (quoteInfo.value.uiAmount ?? 0) * 2,  // approx TVL
    timestamp:    Date.now(),
  });
});
```

```tsx
// web-ui: в PositionCard добавить индикатор ликвидности
function LiquidityBadge({ mint }: { mint: string }) {
  const [liq, setLiq] = useState<{ liquiditySol: number; drop?: number } | null>(null);
  useEffect(() => {
    fetch(`/api/liquidity/${mint}`).then(r => r.json()).then(setLiq);
  }, [mint]);
  if (!liq) return null;
  const isAlert = (liq.drop ?? 0) > 30;
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded ${isAlert ? 'bg-red-900 text-red-300' : 'bg-zinc-800 text-zinc-400'}`}>
      {isAlert ? '⚠️ ' : ''}Liq: {liq.liquiditySol.toFixed(1)} SOL
    </span>
  );
}
```

### 14.5 Gas / Fee Tracker
- Сколько потрачено на Jito tips за период
- Средний tip vs. landing rate (график корреляции)
- Сколько потрачено на RPC priority fees
- Рекомендации: "повысьте tip на 0.00001 — landing rate вырастет с 45% до 62%"
- **Общий cost basis**: entry amount + tips + fees = реальный вход

```sql
-- Добавить в 001_init.sql
CREATE TABLE IF NOT EXISTS jito_attempts (
  id           INTEGER PRIMARY KEY,
  mint         TEXT,
  tip_sol      REAL,
  landed       BOOLEAN,
  sell_path    TEXT,     -- jito/rpc/bloxroute/jupiter
  attempted_at INTEGER
);
```

```typescript
// src/web/routes/analytics.ts
router.get('/fees', (_, res) => {
  const since = Date.now() - 7 * 86400_000;
  const stats = db.prepare(`
    SELECT
      SUM(tip_sol)    AS totalTipsSol,
      AVG(tip_sol)    AS avgTip,
      SUM(CASE WHEN landed THEN 1 ELSE 0 END) * 100.0 / COUNT(*) AS landingRate,
      sell_path,
      COUNT(*) AS count
    FROM jito_attempts WHERE attempted_at >= ?
    GROUP BY sell_path
  `).all(since);

  // Рекомендация по тип
  const jitoRow = (stats as any[]).find(r => r.sell_path === 'jito');
  const suggestion = jitoRow && jitoRow.landingRate < 50
    ? `Landing rate ${jitoRow.landingRate.toFixed(0)}% — consider increasing tipAmountSol`
    : null;

  res.json({ stats, suggestion });
});
```

### 14.6 Token Watchlist
- Ручной список токенов для наблюдения (без auto-buy)
- Цена, объём, holder count, social mentions — обновляются live
- Кнопка [Snipe Now] — мгновенная покупка по текущим параметрам
- Кнопка [Set Alert] — уведомление при достижении цены/объёма
- **Цель**: ручной режим для опытных трейдеров

```sql
CREATE TABLE IF NOT EXISTS watchlist (
  mint       TEXT PRIMARY KEY,
  ticker     TEXT,
  added_at   INTEGER,
  alert_price REAL  -- NULL = no alert
);
```

```typescript
// src/web/routes/watchlist.ts
router.get('/',           (_, res)  => res.json(db.prepare('SELECT * FROM watchlist').all()));
router.post('/',          (req, res) => {
  db.prepare('INSERT OR IGNORE INTO watchlist (mint, ticker, added_at) VALUES (?,?,?)').run(req.body.mint, req.body.ticker ?? null, Date.now());
  res.json({ ok: true });
});
router.delete('/:mint',   (req, res) => {
  db.prepare('DELETE FROM watchlist WHERE mint = ?').run(req.params.mint);
  res.json({ ok: true });
});
router.post('/snipe/:mint', async (req, res) => {
  // Запускает вход как если бы токен пришёл через geyser
  await sniper.manualSnipe(req.params.mint);
  res.json({ ok: true });
});
```

### 14.7 Creator Profiler
- При наведении на токен — профиль создателя:
  - Сколько токенов создал, сколько из них rug, средний lifetime
  - Wallet balance, связанные кошельки
- Автоматический флаг "serial rugger" (>3 rug за 7 дней)
- **Интеграция с blacklist**: кнопка [Blacklist Creator] прямо из карточки

```typescript
// src/web/routes/creator.ts
router.get('/:address', async (req, res) => {
  const { address } = req.params;

  // История из наших трейдов
  const history = db.prepare(`
    SELECT mint, pnl_percent, exit_reason, opened_at, closed_at
    FROM trades WHERE creator = ? ORDER BY opened_at DESC LIMIT 20
  `).all(address) as any[];

  const rugCount = history.filter(t => t.exit_reason === 'force_close' || t.pnl_percent < -50).length;
  const isSerialRugger = rugCount >= 3;

  // SOL баланс через RPC
  let balanceSol = 0;
  try {
    const lamports = await getConnection().getBalance(new PublicKey(address));
    balanceSol = lamports / 1e9;
  } catch {}

  res.json({
    address,
    rugCount,
    isSerialRugger,
    totalTokens: history.length,
    balanceSol,
    history,
    isBlacklisted: sniper.isCreatorBlacklisted(address),
  });
});
```

```tsx
// web-ui: CreatorTooltip.tsx — всплывающее окно при hover на mint
function CreatorTooltip({ creator }: { creator: string }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => { fetch(`/api/creator/${creator}`).then(r => r.json()).then(setData); }, [creator]);
  if (!data) return <span className="text-zinc-500 text-xs animate-pulse">Loading...</span>;
  return (
    <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-3 text-xs space-y-1 w-56">
      <div className="font-mono text-zinc-400">{creator.slice(0,16)}…</div>
      {data.isSerialRugger && <div className="text-red-400 font-bold">⚠️ Serial Rugger ({data.rugCount} rugs)</div>}
      <div>Tokens: {data.totalTokens} | Balance: {data.balanceSol.toFixed(3)} SOL</div>
      <button onClick={() => fetch(`/api/blacklist/creator/${creator}`, { method: 'POST' })}
        className="w-full mt-1 py-1 bg-red-700 hover:bg-red-600 rounded text-xs">
        Blacklist Creator
      </button>
    </div>
  );
}
```

### 14.8 A/B Testing для параметров
- Запуск бота с двумя конфигурациями параллельно (paper trading для второй)
- Сравнительная таблица: config A vs config B — PnL, WR, avg hold time
- **Цель**: тестировать изменения параметров без риска на реальном рынке
- Реализация: виртуальные позиции для config B (запись в SQLite, без реальных сделок)

```sql
CREATE TABLE IF NOT EXISTS paper_trades (
  id               INTEGER PRIMARY KEY,
  config_variant   TEXT,   -- 'B'
  mint             TEXT,
  entry_price      REAL,
  exit_price       REAL,
  entry_amount_sol REAL,
  pnl_percent      REAL,
  exit_reason      TEXT,
  opened_at        INTEGER,
  closed_at        INTEGER
);
```

```typescript
// src/web/routes/ab.ts
router.get('/results', (_, res) => {
  const realStats = db.prepare(`
    SELECT 'A' AS variant, AVG(pnl_percent) AS avgPnl,
    SUM(CASE WHEN exit_amount_sol > entry_amount_sol THEN 1 ELSE 0 END)*100.0/COUNT(*) AS winRate,
    COUNT(*) AS trades FROM trades WHERE closed_at IS NOT NULL
  `).get();
  const paperStats = db.prepare(`
    SELECT 'B' AS variant, AVG(pnl_percent) AS avgPnl,
    SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END)*100.0/COUNT(*) AS winRate,
    COUNT(*) AS trades FROM paper_trades WHERE closed_at IS NOT NULL
  `).get();
  res.json([realStats, paperStats]);
});

// В sniper.ts: при PAPER_TRADE_CONFIG_B env — дублировать решения в paper_trades
// вместо отправки реальных транзакций
```

### 14.9 Notifications Center
- Все алерты в одном месте (web push + in-app)
- Категории: trades, system, social, risk
- Настройка: какие события → push, какие → только in-app
- Sound alerts для критических событий (force-close, geyser disconnect)
- **Telegram интеграция**: выбрать какие алерты дублировать в TG

```typescript
// src/web/notifications.ts
import webpush from 'web-push';

webpush.setVapidDetails('mailto:admin@sniper', process.env.VAPID_PUBLIC!, process.env.VAPID_PRIVATE!);

let _subscription: webpush.PushSubscription | null = null;

export function setSubscription(sub: webpush.PushSubscription) { _subscription = sub; }

export async function notify(title: string, body: string, category: 'trade'|'system'|'social'|'risk') {
  if (!_subscription) return;
  await webpush.sendNotification(_subscription, JSON.stringify({ title, body, category })).catch(() => {});
}

// Хук в sniper.ts:
// sniper.on('position:close', p => notify('Trade closed', `${p.mint.slice(0,8)} ${p.pnlPercent>0?'+':''}${p.pnlPercent.toFixed(1)}%`, 'trade'));
// sniper.on('system:geyser:down', () => notify('⚠️ Geyser Down', 'Reconnecting...', 'system'));
```

```tsx
// web-ui: запрос разрешения и подписка
async function subscribePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: import.meta.env.VITE_VAPID_PUBLIC,
  });
  await fetch('/api/notifications/subscribe', { method: 'POST', body: JSON.stringify(sub), headers: { 'Content-Type': 'application/json' }, credentials: 'include' });
}
```

### 14.10 Session Replay
- Запись всех событий за сессию (positions, prices, decisions)
- Воспроизведение: "что произошло пока я спал"
- Timeline с маркерами: вход, выход, alert, config change
- **Цель**: post-mortem анализ без чтения raw логов

```sql
CREATE TABLE IF NOT EXISTS session_events (
  id         INTEGER PRIMARY KEY,
  type       TEXT,    -- 'position:open'|'position:close'|'alert'|'config:change'|'system'
  payload    TEXT,    -- JSON
  timestamp  INTEGER
);
```

```typescript
// src/web/ws/events.ts — записываем все события в БД
function recordEvent(type: string, payload: any) {
  db.prepare('INSERT INTO session_events (type, payload, timestamp) VALUES (?,?,?)')
    .run(type, JSON.stringify(payload), Date.now());
}

sniper.on('position:open',  p  => { recordEvent('position:open',  p);  io.emit('position:open',  p); });
sniper.on('position:close', p  => { recordEvent('position:close', p);  io.emit('position:close', p); });
```

```typescript
// src/web/routes/replay.ts
router.get('/', (req, res) => {
  const { from, to } = req.query as any;
  const events = db.prepare(`
    SELECT * FROM session_events
    WHERE timestamp BETWEEN ? AND ?
    ORDER BY timestamp ASC
  `).all(Number(from ?? Date.now() - 86400_000), Number(to ?? Date.now()));
  res.json(events.map((e: any) => ({ ...e, payload: JSON.parse(e.payload) })));
});
```

```tsx
// web-ui/src/pages/SessionReplay.tsx — timeline
export function SessionReplay() {
  const [events, setEvents] = useState<any[]>([]);
  useEffect(() => {
    const from = Date.now() - 8 * 3600_000; // последние 8 часов
    fetch(`/api/replay?from=${from}&to=${Date.now()}`).then(r => r.json()).then(setEvents);
  }, []);

  const icon = (type: string) => ({ 'position:open': '🟢', 'position:close': '🔴', 'alert': '⚠️', 'config:change': '⚙️', 'system': '🔧' }[type] ?? '•');

  return (
    <div className="space-y-2 max-w-2xl">
      <h1 className="text-xl font-bold">Session Replay</h1>
      <div className="relative border-l border-zinc-700 ml-4 pl-4 space-y-3">
        {events.map(e => (
          <div key={e.id} className="relative">
            <span className="absolute -left-6 text-base">{icon(e.type)}</span>
            <div className="text-xs text-zinc-500">{new Date(e.timestamp).toLocaleTimeString()}</div>
            <div className="text-sm text-zinc-200">{e.type}</div>
            <pre className="text-xs text-zinc-500 bg-zinc-900 rounded p-1 overflow-x-auto">
              {JSON.stringify(e.payload, null, 2).slice(0, 200)}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
```

### 14.11 Multi-Wallet View
- Поддержка нескольких кошельков (read-only мониторинг)
- Суммарный PnL по всем кошелькам
- Подготовка к будущему multi-wallet trading

```typescript
// src/web/routes/wallets.ts — мониторинг дополнительных кошельков (read-only)
const WATCH_WALLETS: string[] = (process.env.WATCH_WALLETS ?? '').split(',').filter(Boolean);

router.get('/all', async (_, res) => {
  const connection = getConnection();
  const results = await Promise.all(WATCH_WALLETS.map(async (addr) => {
    try {
      const lamports = await connection.getBalance(new PublicKey(addr));
      return { address: addr, balanceSol: lamports / 1e9, label: addr.slice(0, 8) };
    } catch {
      return { address: addr, balanceSol: null, label: addr.slice(0, 8) };
    }
  }));
  // Добавляем основной кошелёк
  const main = await connection.getBalance(new PublicKey(config.wallet.publicKey));
  results.unshift({ address: config.wallet.publicKey, balanceSol: main / 1e9, label: 'Main' });
  res.json(results);
});
```

```env
# .env — добавить
WATCH_WALLETS=addr1,addr2,addr3  # read-only мониторинг
```

### 14.12 API Keys Management
- Страница для управления ключами внешних сервисов (RPC, Geyser, Jito)
- Проверка валидности ключа (ping test)
- Ротация: переключение между RPC провайдерами при сбоях
- Статус каждого endpoint: latency, uptime, rate limit remaining

```typescript
// src/web/routes/apikeys.ts
const SERVICES = ['RPC_URL', 'JITO_RPC', 'GRPC_ENDPOINT', 'RAPIDAPI_KEY', 'BIRDEYE_API_KEY'];

router.get('/', (_, res) => {
  // Никогда не отдаём полные ключи — только маску
  const keys = SERVICES.map(name => ({
    name,
    configured: !!process.env[name],
    masked: process.env[name] ? `${process.env[name]!.slice(0, 6)}…${process.env[name]!.slice(-4)}` : null,
  }));
  res.json(keys);
});

router.post('/ping/:service', async (req, res) => {
  const { service } = req.params;
  const start = Date.now();
  try {
    if (service === 'RPC_URL') {
      await getConnection().getSlot();
      return res.json({ ok: true, latencyMs: Date.now() - start });
    }
    if (service === 'GRPC_ENDPOINT') {
      // Простая TCP проверка
      return res.json({ ok: !!process.env.GRPC_ENDPOINT, latencyMs: Date.now() - start });
    }
    res.json({ ok: false, error: 'Unknown service' });
  } catch (e: any) {
    res.json({ ok: false, latencyMs: Date.now() - start, error: e.message });
  }
});
```

```tsx
// web-ui/src/pages/ApiKeys.tsx
export function ApiKeys() {
  const [keys, setKeys] = useState<any[]>([]);
  const [pings, setPings] = useState<Record<string, any>>({});

  useEffect(() => { fetch('/api/apikeys').then(r => r.json()).then(setKeys); }, []);

  const ping = async (name: string) => {
    const r = await fetch(`/api/apikeys/ping/${name}`, { method: 'POST', credentials: 'include' });
    const d = await r.json();
    setPings(p => ({ ...p, [name]: d }));
  };

  return (
    <div className="space-y-4 max-w-lg">
      <h1 className="text-xl font-bold">API Keys</h1>
      {keys.map(k => (
        <div key={k.name} className="bg-zinc-900 rounded-xl p-4 flex items-center gap-3">
          <div className="flex-1">
            <div className="text-sm font-medium">{k.name}</div>
            <div className="text-xs text-zinc-500 font-mono">{k.masked ?? 'not set'}</div>
            {pings[k.name] && (
              <div className={`text-xs mt-1 ${pings[k.name].ok ? 'text-green-400' : 'text-red-400'}`}>
                {pings[k.name].ok ? `✓ ${pings[k.name].latencyMs}ms` : `✗ ${pings[k.name].error}`}
              </div>
            )}
          </div>
          <button onClick={() => ping(k.name)}
            className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 rounded text-xs">
            Ping
          </button>
        </div>
      ))}
      <p className="text-xs text-zinc-600">Keys are configured in .env file on server. Restart bot after changes.</p>
    </div>
  );
}
```

---

## 15. Руководство по развёртыванию на VPS

### 15.1 Требования к серверу

| Параметр | Минимум | Рекомендуется |
|----------|---------|---------------|
| CPU | 1 vCPU | 2 vCPU |
| RAM | 1 GB | 2 GB |
| Диск | 10 GB SSD | 20 GB SSD |
| ОС | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS |
| Node.js | 18.x | 20.x LTS |
| Порты | 80, 443 | 80, 443 |

---

### 15.2 Установка зависимостей на VPS

```bash
# Подключаемся к VPS
ssh root@YOUR_VPS_IP

# Обновляем систему
apt update && apt upgrade -y

# Устанавливаем Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Проверяем версии
node -v   # v20.x.x
npm -v    # 10.x.x

# Устанавливаем PM2 глобально
npm install -g pm2

# Устанавливаем Caddy (HTTPS reverse proxy)
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install caddy -y

# Устанавливаем git (если не установлен)
apt install -y git
```

---

### 15.3 Клонирование и установка

```bash
# Клонируем репозиторий
git clone https://github.com/l89200637398/Sniper.git /opt/sniper
cd /opt/sniper

# Устанавливаем зависимости бэкенда
npm install

# Устанавливаем зависимости фронтенда
cd web-ui
npm install
cd ..
```

---

### 15.4 Настройка `.env`

```bash
# Копируем шаблон
cp .env.example .env

# Открываем для редактирования
nano .env
```

Полный список переменных:

```env
# ── Кошелёк ──────────────────────────────────────────────────
PRIVATE_KEY=ВАШ_BASE58_ПРИВАТНЫЙ_КЛЮЧ
PUBLIC_KEY=ВАШ_ПУБЛИЧНЫЙ_КЛЮЧ

# ── Solana RPC ────────────────────────────────────────────────
RPC_URL=https://YOUR_QUICKNODE_OR_HELIUS_URL

# ── Geyser gRPC ──────────────────────────────────────────────
GRPC_ENDPOINT=YOUR_YELLOWSTONE_GRPC_ENDPOINT
GRPC_TOKEN=YOUR_GRPC_TOKEN

# ── Jito ─────────────────────────────────────────────────────
JITO_RPC=https://YOUR_JITO_COMPATIBLE_RPC

# ── Telegram (read-only уведомления) ────────────────────────
BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN

# ── Web UI ───────────────────────────────────────────────────
WEB_PORT=3001
WEB_ORIGIN=https://sniper.yourdomain.com

# Пароль для входа в UI — генерируем хэш:
# node -e "require('bcrypt').hash('ВАШ_ПАРОЛЬ', 12).then(console.log)"
WEB_PASSWORD_HASH=$2b$12$СГЕНЕРИРОВАННЫЙ_ХЭШ

# JWT секрет — случайная строка 32+ символов
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
JWT_SECRET=СЛУЧАЙНАЯ_СТРОКА_32_СИМВОЛА

# ── База данных ───────────────────────────────────────────────
DB_PATH=data/sniper.db

# ── Социальные парсеры (опционально) ────────────────────────
RAPIDAPI_KEY=ВАШ_RAPIDAPI_KEY           # для Twitter поиска
BIRDEYE_API_KEY=ВАШ_BIRDEYE_KEY         # для whale alerts
TG_ALPHA_CHANNELS=channel1,channel2      # опционально, CSV @username публичных
                                         # каналов; без значения используется
                                         # DEFAULT_CHANNELS из src/social/parsers/telegram.ts

# ── Push-уведомления (опционально) ──────────────────────────
# Генерация VAPID ключей: npx web-push generate-vapid-keys
VAPID_PUBLIC=ВАШ_VAPID_PUBLIC_KEY
VAPID_PRIVATE=ВАШ_VAPID_PRIVATE_KEY

# ── Дополнительные кошельки для мониторинга ─────────────────
WATCH_WALLETS=addr1,addr2               # read-only, через запятую

# ── Режим работы ─────────────────────────────────────────────
SIMULATE=false                          # true = без реальных сделок
NODE_ENV=production
```

---

### 15.5 Генерация секретов

```bash
# 1. Хэш пароля для Web UI
node -e "require('bcrypt').hash('ВАШ_ПАРОЛЬ', 12).then(console.log)"
# Вставьте результат в WEB_PASSWORD_HASH=

# 2. JWT секрет
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Вставьте результат в JWT_SECRET=

# 3. VAPID ключи для push-уведомлений (опционально)
npx web-push generate-vapid-keys
# Вставьте PUBLIC в VAPID_PUBLIC=, PRIVATE в VAPID_PRIVATE=
```

---

### 15.6 Сборка фронтенда

```bash
cd /opt/sniper

# Создаём .env для фронтенда
cat > web-ui/.env.production << EOF
VITE_API_URL=https://sniper.yourdomain.com
VITE_VAPID_PUBLIC=ВАШ_VAPID_PUBLIC_KEY
EOF

# Собираем React SPA
cd web-ui && npm run build && cd ..
# Результат: web-ui/dist/ — статические файлы

# Собираем бэкенд TypeScript
npm run build
# Результат: dist/ — скомпилированный JS
```

---

### 15.7 Настройка Caddy (HTTPS)

```bash
# Редактируем конфиг Caddy
nano /etc/caddy/Caddyfile
```

```caddy
sniper.yourdomain.com {
    # Автоматический Let's Encrypt сертификат
    encode gzip

    # Проксируем API и WebSocket на бэкенд
    handle /api/* {
        reverse_proxy localhost:3001
    }

    handle /socket.io/* {
        reverse_proxy localhost:3001 {
            transport http {
                versions h1  # WebSocket требует HTTP/1.1
            }
        }
    }

    # Всё остальное — React SPA
    handle {
        reverse_proxy localhost:3001
    }
}
```

```bash
# Проверяем конфиг и перезапускаем Caddy
caddy validate --config /etc/caddy/Caddyfile
systemctl restart caddy
systemctl enable caddy

# Проверяем статус
systemctl status caddy
```

> **Важно**: Домен `sniper.yourdomain.com` должен быть направлен (A-запись) на IP вашего VPS до запуска Caddy. Caddy сам получит SSL сертификат от Let's Encrypt.

---

### 15.8 Настройка PM2

```bash
cd /opt/sniper

# Создаём конфиг PM2
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name:        'sniper',
    script:      'dist/index.js',
    cwd:         '/opt/sniper',
    env_file:    '.env',
    instances:   1,
    autorestart: true,
    watch:       false,
    max_memory_restart: '512M',
    log_file:    'logs/pm2.log',
    error_file:  'logs/pm2-error.log',
    out_file:    'logs/pm2-out.log',
    time:        true,
  }],
};
EOF

# Создаём папку для логов
mkdir -p logs data

# Первый запуск
pm2 start ecosystem.config.js

# Автозапуск при перезагрузке VPS
pm2 startup
# Выполните команду которую выведет pm2 startup (она начинается с sudo env ...)
pm2 save

# Проверка статуса
pm2 status
pm2 logs sniper --lines 50
```

---

### 15.9 Структура папок после установки

```
/opt/sniper/
├── .env                    # ← секреты, НЕ в git
├── ecosystem.config.js     # PM2 конфиг
├── dist/                   # скомпилированный бэкенд
├── web-ui/
│   ├── dist/               # собранный фронтенд (отдаётся Caddy)
│   └── .env.production     # VITE_API_URL
├── data/
│   ├── sniper.db           # SQLite база данных
│   ├── positions.json      # активные позиции
│   ├── wallet-tracker.json # copy-trade данные
│   └── runtime-config.json # горячие изменения конфига
├── logs/
│   ├── bot-YYYY-MM-DD.log  # Pino логи бота
│   ├── trades.jsonl        # JSONL история сделок
│   └── pm2.log             # PM2 логи
└── src/                    # исходники (для разработки)
```

---

### 15.10 Первый вход в браузере

1. Откройте браузер: `https://sniper.yourdomain.com`
2. Введите пароль (тот, хэш которого вы положили в `WEB_PASSWORD_HASH`)
3. После входа попадёте на **Dashboard**

> Если используете VPS без домена — доступ через IP: `http://YOUR_VPS_IP:3001`
> В этом случае Caddy не нужен, но HTTPS не будет (не рекомендуется для production).

---

### 15.11 Обновление (деплой новой версии)

```bash
cd /opt/sniper

# Тянем изменения
git pull origin main

# Устанавливаем новые зависимости (если появились)
npm install

# Пересобираем бэкенд
npm run build

# Пересобираем фронтенд (если менялся)
cd web-ui && npm run build && cd ..

# Перезапускаем бот
pm2 restart sniper

# Проверяем логи
pm2 logs sniper --lines 30
```

---

### 15.12 Полезные команды

```bash
# Статус бота
pm2 status

# Логи в реальном времени
pm2 logs sniper

# Перезапуск
pm2 restart sniper

# Остановка
pm2 stop sniper

# Мониторинг CPU/RAM
pm2 monit

# Просмотр БД (SQLite)
sqlite3 data/sniper.db "SELECT * FROM trades ORDER BY closed_at DESC LIMIT 10;"

# Бэкап БД
cp data/sniper.db data/sniper.db.bak

# Проверка HTTPS сертификата
caddy validate --config /etc/caddy/Caddyfile

# Перезагрузка Caddy без даунтайма
systemctl reload caddy

# Проверка открытых портов
ss -tlnp | grep -E '3001|80|443'
```

---

### 15.13 Firewall (UFW)

```bash
# Разрешаем только нужные порты
ufw allow OpenSSH
ufw allow 80/tcp     # HTTP (Caddy → HTTPS redirect)
ufw allow 443/tcp    # HTTPS
# Порт 3001 НЕ открываем — только через Caddy
ufw enable
ufw status
```

---

### 15.14 Переменные окружения — быстрая шпаргалка

| Переменная | Где взять |
|------------|-----------|
| `PRIVATE_KEY` | Ваш Solana кошелёк (base58) |
| `PUBLIC_KEY` | Публичный адрес того же кошелька |
| `RPC_URL` | QuickNode / Helius / Alchemy dashboard |
| `GRPC_ENDPOINT` | QuickNode Yellowstone addon → Endpoint URL |
| `GRPC_TOKEN` | QuickNode Yellowstone addon → Token |
| `JITO_RPC` | QuickNode Lil JIT addon URL |
| `BOT_TOKEN` | @BotFather в Telegram → /newbot |
| `WEB_PASSWORD_HASH` | `node -e "require('bcrypt').hash('пароль',12).then(console.log)"` |
| `JWT_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `RAPIDAPI_KEY` | rapidapi.com → Subscribe to Twitter API |
| `BIRDEYE_API_KEY` | birdeye.so → API section |

---

**Итого**: Web UI полностью заменяет Telegram как интерфейс управления. TG остаётся как read-only notification channel. Социальные парсеры — новый модуль для повышения качества entry decisions. Дополнительные модули (14.1–14.12) покрывают аналитику, риск-менеджмент, ликвидность, creator profiling и A/B тестирование параметров.
