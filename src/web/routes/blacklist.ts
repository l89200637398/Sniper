import { Router } from 'express';
import type { Sniper } from '../../core/sniper';

export function blacklistRouter(sniper: Sniper) {
  const router = Router();
  // Returns full lists + counts. Stats are kept as a nested field so the shape
  // is self-descriptive (clients can render lists or just show the badges).
  router.get('/', (_, res) => {
    const lists = sniper.getBlacklist();
    res.json({
      tokens: lists.tokens,
      creators: lists.creators,
      stats: { tokens: lists.tokens.length, creators: lists.creators.length },
    });
  });
  router.post('/token/:mint', (req, res) => { sniper.addToBlacklist(req.params.mint); res.json({ ok: true }); });
  router.delete('/token/:mint', (req, res) => {
    const removed = sniper.removeFromBlacklist(req.params.mint);
    res.json({ ok: true, removed });
  });
  router.post('/creator/:addr', (req, res) => { sniper.addCreatorToBlacklist(req.params.addr); res.json({ ok: true }); });
  router.delete('/creator/:addr', (req, res) => {
    const removed = sniper.removeCreatorFromBlacklist(req.params.addr);
    res.json({ ok: true, removed });
  });
  return router;
}
