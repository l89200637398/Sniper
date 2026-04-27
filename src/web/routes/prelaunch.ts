// src/web/routes/prelaunch.ts — CRUD для pre-launch watchlist

import { Router } from 'express';
import type { Sniper } from '../../core/sniper';

export function preLaunchRouter(sniper: Sniper) {
  const router = Router();
  const watcher = () => sniper.getPreLaunchWatcher();

  // GET /api/prelaunch — список всех кандидатов
  router.get('/', (_, res) => {
    const all = watcher().list();
    res.json({
      total: all.length,
      active: watcher().activeCount,
      candidates: all,
    });
  });

  // POST /api/prelaunch — добавить кандидата
  // Body: { ticker?, mint?, creator?, source, notes? }
  router.post('/', (req, res) => {
    const { ticker, mint, creator, source, notes } = req.body ?? {};
    if (!source) return res.status(400).json({ error: 'source is required' });
    if (!mint && !creator) return res.status(400).json({ error: 'mint or creator required' });
    const id = watcher().add({ ticker, mint, creator, source, notes });
    res.json({ ok: true, id });
  });

  // DELETE /api/prelaunch/:id — удалить по id
  router.delete('/:id', (req, res) => {
    const removed = watcher().remove(req.params.id);
    res.json({ ok: true, removed });
  });

  // DELETE /api/prelaunch — очистить всех (unfired) кандидатов
  router.delete('/', (req, res) => {
    const includeFired = req.query.all === '1';
    const count = watcher().clear(includeFired);
    res.json({ ok: true, removed: count });
  });

  return router;
}
