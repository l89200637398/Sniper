import { Router } from 'express';
import type { Sniper } from '../../core/sniper';

export function walletsRouter(sniper: Sniper) {
  const router = Router();

  // List all tracked wallets (sorted by win rate desc at the client).
  router.get('/', (_, res) => {
    res.json(sniper.getTrackedWallets());
  });

  // Manually add a wallet to the tracker.
  router.post('/', (req, res) => {
    const address = (req.body?.address ?? '').trim();
    if (!address) return res.status(400).json({ error: 'address required' });
    const added = sniper.addTrackedWallet(address);
    res.json({ ok: true, added });
  });

  // Remove a wallet from the tracker.
  router.delete('/:addr', (req, res) => {
    const removed = sniper.removeTrackedWallet(req.params.addr);
    res.json({ ok: true, removed });
  });

  // Force a copy-trade tier (0 = none, 1 = T1, 2 = T2).
  // Note: tier may be revised automatically by the tracker on the wallet's
  // next sell if its win rate doesn't match the manual override.
  router.post('/:addr/tier', (req, res) => {
    const tier = Number(req.body?.tier);
    if (![0, 1, 2].includes(tier)) {
      return res.status(400).json({ error: 'tier must be 0, 1 or 2' });
    }
    const updated = sniper.setTrackedWalletTier(req.params.addr, tier as 0 | 1 | 2);
    if (!updated) return res.status(404).json({ error: 'wallet not tracked' });
    res.json({ ok: true });
  });

  return router;
}
