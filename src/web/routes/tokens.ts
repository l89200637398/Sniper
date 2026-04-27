import { Router } from 'express';
import type { Sniper } from '../../core/sniper';

export function tokensRouter(sniper: Sniper) {
  const router = Router();

  // GET /api/tokens/recent — last N scored tokens.
  // sniper.recentScoredTokens will be populated by another patch to sniper.ts;
  // until then, safely return an empty array.
  router.get('/recent', (_, res) => {
    try {
      const tokens = (sniper as any).recentScoredTokens ?? [];
      res.json({ tokens: tokens.slice(-100) });
    } catch {
      res.json({ tokens: [] });
    }
  });

  return router;
}
