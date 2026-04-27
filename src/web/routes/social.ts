import { Router } from 'express';
import type { Sniper } from '../../core/sniper';

export function socialRouter(sniper: Sniper) {
  const router = Router();

  // Feed: последние N сигналов. Работает даже при остановленном боте —
  // читает напрямую из SQLite через signal-store.
  //
  // Query:
  //   ?limit=50   (default 50, clamp 1..500)
  //   ?alpha=1    — вернуть только сигналы с alpha=true (whitelist hits)
  router.get('/feed', (req, res) => {
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) ? Math.max(1, Math.min(500, Math.floor(raw))) : 50;
    const alphaOnly = req.query.alpha === '1' || req.query.alpha === 'true';
    res.json(sniper.getSocialFeed(limit, alphaOnly));
  });

  // Mentions: агрегированный счёт упоминаний в последнем окне.
  //
  // Query:
  //   ?window=3600000  (ms, default 1h, clamp 60_000..86_400_000)
  //   ?limit=20        (default 20, clamp 1..100)
  router.get('/mentions', (req, res) => {
    const winRaw = Number(req.query.window);
    const windowMs = Number.isFinite(winRaw)
      ? Math.max(60_000, Math.min(86_400_000, Math.floor(winRaw)))
      : 60 * 60 * 1000;
    const limRaw = Number(req.query.limit);
    const limit = Number.isFinite(limRaw) ? Math.max(1, Math.min(100, Math.floor(limRaw))) : 20;
    res.json(sniper.getSocialMentions(windowMs, limit));
  });

  // Source diagnostics (per-parser last run, errors, counts). Полезно
  // при отладке ("почему нет данных из Twitter?").
  router.get('/status', (_, res) => {
    res.json(sniper.getSocialStatus());
  });

  return router;
}
