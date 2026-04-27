import { Router } from 'express';
import type { Sniper } from '../../core/sniper';

export function controlRouter(sniper: Sniper) {
  const router = Router();
  router.post('/start', async (_, res) => {
    try { await sniper.start(); res.json({ ok: true }); }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  });
  router.post('/stop', async (_, res) => {
    try { await sniper.stop(); res.json({ ok: true }); }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  });
  router.post('/sell/:mint', async (req, res) => {
    const { mint } = req.params;
    try { sniper.requestSell(mint, 'manual_ui'); res.json({ ok: true, mint }); }
    catch (e: any) { res.status(404).json({ error: 'Position not found or selling already' }); }
  });
  router.post('/close-all', async (_, res) => {
    try { await sniper.closeAllPositions(); res.json({ ok: true }); }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  });
  return router;
}
