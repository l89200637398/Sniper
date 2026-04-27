import type { Express } from 'express';
import type { Sniper } from '../../core/sniper';
import { controlRouter } from './control';
import { configRouter } from './config';
import { positionsRouter } from './positions';
import { tradesRouter } from './trades';
import { walletRouter } from './wallet';
import { walletsRouter } from './wallets';
import { blacklistRouter } from './blacklist';
import { socialRouter } from './social';
import { preLaunchRouter } from './prelaunch';
import { tokensRouter } from './tokens';

export function registerRoutes(app: Express, sniper: Sniper) {
  app.use('/api/control', controlRouter(sniper));
  app.use('/api/config', configRouter());
  app.use('/api/positions', positionsRouter(sniper));
  app.use('/api/trades', tradesRouter());
  app.use('/api/wallet', walletRouter(sniper));
  app.use('/api/wallets', walletsRouter(sniper));
  app.use('/api/blacklist', blacklistRouter(sniper));
  app.use('/api/social', socialRouter(sniper));
  app.use('/api/prelaunch', preLaunchRouter(sniper));
  app.use('/api/tokens', tokensRouter(sniper));
}
