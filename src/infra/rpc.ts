import { Connection } from '@solana/web3.js';
import { config } from '../config';

export const rpc = new Connection(config.rpc.url, {
  commitment: 'processed',
  disableRetryOnRateLimit: true,
});