// src/core/prelaunch-watcher.ts
//
// PreLaunchWatcher — хранилище "ожидаемых" токенов, которые ещё не появились
// в on-chain потоке, но уже обсуждаются / анонсированы.
//
// Матчинг при CREATE:
//   1. mint (exact)   — самый надёжный, если mint известен заранее
//   2. creator (exact) — если известен кошелёк создателя
//
// При совпадении → вход в первые блоки, prelimScore принудительно > eliteScoreThreshold.
// Тикер хранится как метка, не используется для матчинга on-chain (имя недоступно при CREATE).

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { logEvent } from '../utils/event-logger';

const DATA_FILE = path.join(process.cwd(), 'data', 'prelaunch.json');
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 часа

export interface PreLaunchCandidate {
  id: string;
  /** Тикер (без $, uppercase) — только для отображения */
  ticker?: string;
  /** Известный mint-адрес (наиболее точный матч) */
  mint?: string;
  /** Кошелёк создателя */
  creator?: string;
  /** Откуда инсайт: 'telegram' | 'twitter' | 'manual' | 'alpha' */
  source: string;
  /** Произвольные заметки */
  notes?: string;
  addedAt: number;
  expiresAt: number;
  fired: boolean;
  firedAt?: number;
  firedMint?: string;
}

export class PreLaunchWatcher {
  private candidates: Map<string, PreLaunchCandidate> = new Map();
  private byMint: Map<string, string> = new Map();     // normalised mint    → id
  private byCreator: Map<string, string> = new Map();  // normalised creator → id
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.load();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  add(candidate: Omit<PreLaunchCandidate, 'id' | 'addedAt' | 'expiresAt' | 'fired'>, ttlMs?: number): string {
    const id = `pl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const now = Date.now();
    const entry: PreLaunchCandidate = {
      ...candidate,
      ticker: candidate.ticker?.toUpperCase().replace(/^\$/, ''),
      id,
      addedAt: now,
      expiresAt: now + (ttlMs ?? DEFAULT_TTL_MS),
      fired: false,
    };
    this.candidates.set(id, entry);
    if (entry.mint)    this.byMint.set(entry.mint.toLowerCase(), id);
    if (entry.creator) this.byCreator.set(entry.creator.toLowerCase(), id);
    this.save();
    logger.info(
      `[prelaunch] ➕ Added: ${entry.ticker ?? id} ` +
      `mint=${entry.mint?.slice(0, 8) ?? '-'} creator=${entry.creator?.slice(0, 8) ?? '-'} ` +
      `source=${entry.source} expires=${new Date(entry.expiresAt).toISOString()}`
    );
    logEvent('PRELAUNCH_ADDED', { id, ticker: entry.ticker, mint: entry.mint, creator: entry.creator, source: entry.source });
    return id;
  }

  remove(id: string): boolean {
    const c = this.candidates.get(id);
    if (!c) return false;
    if (c.mint)    this.byMint.delete(c.mint.toLowerCase());
    if (c.creator) this.byCreator.delete(c.creator.toLowerCase());
    this.candidates.delete(id);
    this.save();
    logger.info(`[prelaunch] ➖ Removed: ${c.ticker ?? id}`);
    return true;
  }

  /** Проверка по mint-адресу — вызывается при каждом CREATE event. */
  matchMint(mint: string): PreLaunchCandidate | null {
    const id = this.byMint.get(mint.toLowerCase());
    if (!id) return null;
    const c = this.candidates.get(id);
    if (!c || c.fired || Date.now() > c.expiresAt) return null;
    return c;
  }

  /** Проверка по creator-кошельку — вызывается при каждом CREATE event. */
  matchCreator(creator: string): PreLaunchCandidate | null {
    const id = this.byCreator.get(creator.toLowerCase());
    if (!id) return null;
    const c = this.candidates.get(id);
    if (!c || c.fired || Date.now() > c.expiresAt) return null;
    return c;
  }

  markFired(id: string, firedMint: string): void {
    const c = this.candidates.get(id);
    if (!c) return;
    c.fired = true;
    c.firedAt = Date.now();
    c.firedMint = firedMint;
    this.save();
    logger.info(`[prelaunch] 🎯 FIRED: ${c.ticker ?? id} mint=${firedMint.slice(0, 8)}`);
    logEvent('PRELAUNCH_FIRED', { id, ticker: c.ticker, firedMint, source: c.source });
  }

  list(): PreLaunchCandidate[] {
    return [...this.candidates.values()].sort((a, b) => b.addedAt - a.addedAt);
  }

  clear(includeFired = false): number {
    let count = 0;
    for (const [id, c] of this.candidates) {
      if (!includeFired && c.fired) continue;
      if (c.mint)    this.byMint.delete(c.mint.toLowerCase());
      if (c.creator) this.byCreator.delete(c.creator.toLowerCase());
      this.candidates.delete(id);
      count++;
    }
    this.save();
    return count;
  }

  get activeCount(): number {
    const now = Date.now();
    return [...this.candidates.values()].filter(c => !c.fired && now <= c.expiresAt).length;
  }

  get totalCount(): number {
    return this.candidates.size;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  start(): void {
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private cleanup(): void {
    const now = Date.now();
    let removed = 0;
    for (const [id, c] of this.candidates) {
      if (now <= c.expiresAt) continue;
      if (c.mint)    this.byMint.delete(c.mint.toLowerCase());
      if (c.creator) this.byCreator.delete(c.creator.toLowerCase());
      this.candidates.delete(id);
      removed++;
    }
    if (removed > 0) {
      logger.debug(`[prelaunch] Expired and removed ${removed} candidates`);
      this.save();
    }
  }

  private load(): void {
    try {
      if (!fs.existsSync(DATA_FILE)) return;
      const data: PreLaunchCandidate[] = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      for (const c of data) {
        this.candidates.set(c.id, c);
        if (c.mint)    this.byMint.set(c.mint.toLowerCase(), c.id);
        if (c.creator) this.byCreator.set(c.creator.toLowerCase(), c.id);
      }
      logger.info(`[prelaunch] Loaded ${this.candidates.size} candidates (${this.activeCount} active)`);
    } catch (e) {
      logger.warn(`[prelaunch] Failed to load ${DATA_FILE}: ${e}`);
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(DATA_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify([...this.candidates.values()], null, 2));
    } catch (e) {
      logger.warn(`[prelaunch] Failed to save: ${e}`);
    }
  }
}
