import { Router } from 'express';
import type { Sniper } from '../../core/sniper';

export function walletRouter(sniper: Sniper) {
  const router = Router();
  router.get('/', async (_, res) => {
    const bal = await sniper.getWalletBalance();
    res.json({ address: sniper.getPayerPublicKey().toBase58(), balanceSol: bal });
  });
  return router;
}
