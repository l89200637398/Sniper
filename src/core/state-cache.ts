// src/core/state-cache.ts
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { Connection } from '@solana/web3.js';

export interface MintState {
  mint: PublicKey;
  ata?: PublicKey;
  decimals?: number;
  tokenProgramId?: PublicKey;
  migrated?: boolean;           // для Pump.fun → PumpSwap
  isPumpSwap?: boolean;          // true, если токен создан сразу на PumpSwap
  bondingCurve?: PublicKey;      // для Pump.fun
  pool?: PublicKey;               // для PumpSwap
  creator?: PublicKey;
  // Поля для PumpSwap (vault-аккаунты)
  poolBaseTokenAccount?: PublicKey;
  poolQuoteTokenAccount?: PublicKey;
  // Mayhem Mode флаг — читается из bonding curve data[81], кешируется здесь
  // чтобы не делать повторный RPC-вызов при каждом executePendingBuy
  isMayhemMode?: boolean;
  // Raydium protocol flags
  isRaydiumLaunch?: boolean;
  isRaydiumCpmm?: boolean;
  isRaydiumAmmV4?: boolean;
  raydiumPool?: PublicKey;
}

const cache = new Map<string, MintState>();

export function getMintState(mint: PublicKey): MintState {
  const key = mint.toBase58();
  if (!cache.has(key)) {
    cache.set(key, { mint });
  }
  return cache.get(key)!;
}

export function updateMintState(mint: PublicKey, partial: Partial<MintState>) {
  const key = mint.toBase58();
  const current = getMintState(mint);
  Object.assign(current, partial);
}

export async function ensureAta(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey,
  tokenProgramId?: PublicKey
): Promise<PublicKey> {
  const state = getMintState(mint);
  if (state.ata) return state.ata;
  const ata = await getAssociatedTokenAddress(mint, owner, false, tokenProgramId);
  state.ata = ata;
  return ata;
}
