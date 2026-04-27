import { Connection } from '@solana/web3.js';
import { config } from '../config';
import { logger } from '../utils/logger';

const BACKUP_RPC_URL = process.env.BACKUP_RPC_URL ?? '';

export const rpc = new Connection(config.rpc.url, {
  commitment: 'processed',
  disableRetryOnRateLimit: true,
});

export const backupRpc: Connection | null = BACKUP_RPC_URL
  ? new Connection(BACKUP_RPC_URL, { commitment: 'processed', disableRetryOnRateLimit: true })
  : null;

let useBackup = false;
let backupUntil = 0;
const BACKUP_COOLDOWN_MS = 30_000;

export function getActiveRpc(): Connection {
  if (useBackup && backupRpc && Date.now() < backupUntil) return backupRpc;
  useBackup = false;
  return rpc;
}

export function switchToBackupRpc(reason: string): void {
  if (!backupRpc) return;
  if (!useBackup) {
    logger.warn(`[rpc] Switching to backup RPC for ${BACKUP_COOLDOWN_MS / 1000}s: ${reason}`);
  }
  useBackup = true;
  backupUntil = Date.now() + BACKUP_COOLDOWN_MS;
}