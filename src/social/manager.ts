// src/social/manager.ts
//
// SocialManager — координатор социальных парсеров.
//
// Парсер = функция `() => Promise<SocialSignal[]>`, которая опрашивает один
// внешний источник (DexScreener / Twitter / Telegram / ...). Каждый парсер
// регистрируется через registerSource() с собственным интервалом. Manager:
//
//   • запускает/останавливает polling-таймеры
//   • ловит ошибки парсеров (один упавший источник не валит остальные)
//   • дедуплицирует сигналы (LRU Set на последние 5000 signalKey)
//   • пишет новые сигналы в SQLite через signal-store
//   • эмитит 'signal' event — для Socket.IO ретрансляции в Web UI
//   • раз в час чистит старые записи (TTL 7 дней)

import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import { saveSignal } from './storage/signal-store';
import { pruneOlderThan } from './storage/signal-store';
import type { SocialSignal } from './models/signal';
import { signalKey } from './models/signal';
import { isAlpha, describeWatchlist } from './watchlist';

type Fetcher = () => Promise<SocialSignal[]>;

interface Source {
  name: string;
  fetch: Fetcher;
  intervalMs: number;
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
  lastError?: string;
  lastRunAt?: number;
  lastYield?: number;   // сколько сигналов пришло в последнем опросе (всего)
  lastNew?: number;     // сколько из них были новыми (прошли dedup)
}

const DEDUP_LIMIT = 5000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;   // 1h
const PRUNE_TTL_MS      = 7 * 24 * 60 * 60 * 1000; // 7d

export class SocialManager extends EventEmitter {
  private sources: Source[] = [];
  private running = false;
  private pruneTimer: NodeJS.Timeout | null = null;

  // LRU-дедуп. Set сохраняет порядок вставки — старые ключи выкидываем, когда
  // размер > DEDUP_LIMIT.
  private seen = new Set<string>();

  registerSource(name: string, fetch: Fetcher, intervalMs: number): void {
    if (this.sources.some(s => s.name === name)) {
      logger.warn(`[social] source "${name}" already registered, skipping`);
      return;
    }
    this.sources.push({ name, fetch, intervalMs, timer: null, inFlight: false });
    logger.info(`[social] registered source "${name}" (${intervalMs}ms interval)`);

    // Если manager уже запущен — немедленно активируем новый источник.
    if (this.running) this.startSource(this.sources[this.sources.length - 1]);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const s of this.sources) this.startSource(s);
    this.pruneTimer = setInterval(() => this.runPrune(), PRUNE_INTERVAL_MS);
    logger.info(`[social] started with ${this.sources.length} source(s)  |  watchlist: ${describeWatchlist()}`);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const s of this.sources) {
      if (s.timer) { clearInterval(s.timer); s.timer = null; }
    }
    if (this.pruneTimer) { clearInterval(this.pruneTimer); this.pruneTimer = null; }
    logger.info('[social] stopped');
  }

  /** Диагностика для Web UI / логов. */
  getStatus(): Array<{
    name: string; intervalMs: number; running: boolean;
    lastRunAt?: number; lastYield?: number; lastNew?: number; lastError?: string;
  }> {
    return this.sources.map(s => ({
      name: s.name,
      intervalMs: s.intervalMs,
      running: this.running && s.timer !== null,
      lastRunAt: s.lastRunAt,
      lastYield: s.lastYield,
      lastNew: s.lastNew,
      lastError: s.lastError,
    }));
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private startSource(s: Source): void {
    // Immediate first run + interval.
    this.runSource(s).catch(() => {});
    s.timer = setInterval(() => this.runSource(s).catch(() => {}), s.intervalMs);
  }

  private async runSource(s: Source): Promise<void> {
    if (s.inFlight) {
      logger.debug(`[social] ${s.name}: previous run still in-flight, skipping`);
      return;
    }
    s.inFlight = true;
    s.lastRunAt = Date.now();
    try {
      const signals = await s.fetch();
      s.lastYield = signals.length;
      let added = 0;
      for (const sig of signals) {
        if (this.ingest(sig)) added++;
      }
      s.lastNew = added;
      s.lastError = undefined;
      if (added > 0) {
        logger.debug(`[social] ${s.name}: +${added}/${signals.length} new signals`);
      }
    } catch (err) {
      s.lastError = (err as Error)?.message ?? String(err);
      logger.warn(`[social] ${s.name} fetch failed: ${s.lastError}`);
    } finally {
      s.inFlight = false;
    }
  }

  /** Dedup + watchlist-mark + persist + emit. Returns true if signal was new. */
  private ingest(sig: SocialSignal): boolean {
    const key = signalKey(sig);
    if (this.seen.has(key)) return false;

    // LRU trim.
    if (this.seen.size >= DEDUP_LIMIT) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.add(key);

    // Alpha-флаг — ставим до persist, чтобы он сохранился в БД и попал
    // к подписчикам WS одновременно с самим сигналом.
    sig.alpha = isAlpha(sig);

    try {
      saveSignal(sig);
    } catch (err) {
      logger.error('[social] saveSignal error:', err);
      return false;
    }
    this.emit('signal', sig);
    // Параллельный канал только для alpha — слушатель может подписаться на
    // 'alpha' и не фильтровать поток сам.
    if (sig.alpha) this.emit('alpha', sig);
    return true;
  }

  private runPrune(): void {
    try {
      const removed = pruneOlderThan(PRUNE_TTL_MS);
      if (removed > 0) logger.info(`[social] pruned ${removed} old signals`);
    } catch (err) {
      logger.error('[social] prune error:', err);
    }
  }
}
