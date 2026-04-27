import { Router } from 'express';
import type { Sniper } from '../../core/sniper';

export function positionsRouter(sniper: Sniper) {
  const router = Router();
  router.get('/', (_, res) => {
    const positions = sniper.getOpenPositions().map(p => ({
      mint: p.mint.toBase58(),
      protocol: p.protocol,
      entryPrice: p.entryPrice,
      currentPrice: p.currentPrice,
      pnlPercent: p.pnlPercent,
      amount: p.amount,
      entryAmountSol: p.entryAmountSol,
      openedAt: p.openedAt,
      ageMs: Date.now() - p.openedAt,
      runnerTail: p.runnerTailActivated,
      exitSignals: sniper.getActiveExitSignals(p),
    }));
    res.json(positions);
  });
  return router;
}
