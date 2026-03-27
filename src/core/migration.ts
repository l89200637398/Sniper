import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config';
import { getMintState, updateMintState } from './state-cache';
import { getPoolPDAByMint } from '../trading/pumpSwap';

export async function isMigrated(connection: Connection, mint: PublicKey): Promise<boolean> {
  const state = getMintState(mint);
  if (state.migrated !== undefined) return state.migrated;

  const pool = getPoolPDAByMint(mint);

  const account = await connection.getAccountInfo(pool, 'processed');
  const migrated = !!account;
  updateMintState(mint, { migrated });
  return migrated;
}