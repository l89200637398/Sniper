import { Router } from 'express';

let shadowEngine: any = null;

export function setShadowEngine(engine: any) {
  shadowEngine = engine;
}

export function shadowRouter() {
  const router = Router();

  router.get('/status', (_req, res) => {
    if (!shadowEngine) return res.json({ running: false });
    res.json(shadowEngine.getStatus());
  });

  router.get('/trades', (req, res) => {
    if (!shadowEngine) return res.json({ trades: [] });
    const limit = Number(req.query.limit) || 50;
    res.json(shadowEngine.getTrades(limit));
  });

  router.get('/report', (_req, res) => {
    if (!shadowEngine) return res.status(404).json({ error: 'Shadow engine not running' });
    res.json(shadowEngine.getReport());
  });

  router.post('/stop', async (_req, res) => {
    if (!shadowEngine) return res.status(404).json({ error: 'Shadow engine not running' });
    try {
      const report = await shadowEngine.stop();
      shadowEngine = null;
      res.json({ ok: true, report });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
