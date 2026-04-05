// src/trading/sell.ts
//
// ИСПРАВЛЕНО 2026-03-20 (v2.4) — cashback upgrade февраль 2026:
//
// 1. Добавлен bonding_curve_v2 (PDA: ["bonding-curve-v2", mint]) — ВСЕГДА последний аккаунт.
//    Без него программа читает неверные индексы → 6024 Overflow.
//
// 2. Изменён порядок аккаунтов:
//    index 8: creator_vault (было 9)
//    index 9: tokenProgram  (было 8)
//
// 3. Кэшбэк-условная раскладка (byte[82] bonding curve):
//    cashback=false → 15 аккаунтов (стандарт)
//    cashback=true  → 16 аккаунтов (добавляется userVolumeAcc перед bondingCurveV2)
//
// ИСПРАВЛЕНО 2026-03-20 (v2.2):
//    lastKey = прямой PUMP_PROGRAM_ID, creator_vault семена с дефисом.
//    Volume accumulators отсутствуют (только для buy).

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { config } from '../config';
import { sendViaBloXroute } from '../infra/bloxroute';
import { queueJitoSend } from '../infra/jito-queue';
import { getCachedBlockhash } from '../infra/blockhash-cache';
import { getCachedPriorityFee } from '../infra/priority-fee-cache';
import { getMintState, ensureAta } from '../core/state-cache';
import { logger } from '../utils/logger';
import {
  DISCRIMINATOR,
  PUMP_FUN_PROGRAM_ID,
  PUMP_FUN_ROUTER_PROGRAM_ID,
  FEE_PROGRAM_ID,
} from '../constants';
import {
  getGlobalPDA,
  getBondingCurvePDA,
  getVaultPDA,
  getCreatorVaultPDA,
  getBondingCurveV2PDA,
  getPumpFeeConfigPDA,
  getUserVolumeAccumulatorPDA,
  PUMP_PROGRAM_ID,
} from './buy';

export { PUMP_PROGRAM_ID };
export const PUMP_ROUTER_PROGRAM_ID = new PublicKey(PUMP_FUN_ROUTER_PROGRAM_ID);
const FEE_PROGRAM = new PublicKey(FEE_PROGRAM_ID);

function encodeU64(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

// ─── Sell instruction ─────────────────────────────────────────────────────────
//
// Актуальный порядок аккаунтов после cashback upgrade (фев 2026):
//
// Non-cashback (cashback_enabled=false, byte[82]=0) — 15 аккаунтов:
//   0  global                     (readonly)
//   1  feeRecipient               (writable)
//   2  mint                       (readonly)
//   3  bondingCurve               (writable)
//   4  vault                      (writable)
//   5  userAta                    (writable)
//   6  user                       (signer, writable)
//   7  systemProgram              (readonly)
//   8  creatorVault               (writable)   ← сдвинут с 9 на 8
//   9  tokenProgram               (readonly)   ← сдвинут с 8 на 9
//  10  eventAuthority             (readonly)
//  11  program                    (readonly)   ВСЕГДА прямой PUMP_PROGRAM_ID
//  12  feeConfig                  (readonly)
//  13  feeProgram                 (readonly)
//  14  bondingCurveV2             (readonly)   ← НОВОЕ фев 2026, ВСЕГДА последний
//
// Cashback-enabled (cashback_enabled=true, byte[82]=1) — 16 аккаунтов:
//   0–13  (аналогично non-cashback)
//  14  userVolumeAccumulator      (writable)   ← ТОЛЬКО для cashback
//  15  bondingCurveV2             (readonly)   ← ВСЕГДА последний

export function buildSellInstruction(
  mint: PublicKey,
  user: PublicKey,
  creator: PublicKey,
  feeRecipient: PublicKey,
  eventAuthority: PublicKey,
  amount: bigint,
  minSolOutput: bigint,
  tokenProgramId: PublicKey,
  userAta: PublicKey,
  isMayhem: boolean = false,
  cashbackEnabled: boolean = false   // ← byte[82] bonding curve
): TransactionInstruction {
  const programId = PUMP_PROGRAM_ID;
  const global = getGlobalPDA(programId);
  const bondingCurve = getBondingCurvePDA(mint, programId);
  const vault = getVaultPDA(bondingCurve, mint, tokenProgramId);
  const creatorVault = getCreatorVaultPDA(creator, programId);
  const feeConfig = getPumpFeeConfigPDA();
  const bondingCurveV2 = getBondingCurveV2PDA(mint, programId);
  const lastKey = programId;

  const amountBuf    = encodeU64(amount);
  const minOutputBuf = encodeU64(minSolOutput);
  const data = Buffer.concat([DISCRIMINATOR.SELL, amountBuf, minOutputBuf]);

  const keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [
    { pubkey: global,           isSigner: false, isWritable: false }, //  0
    { pubkey: feeRecipient,     isSigner: false, isWritable: true  }, //  1
    { pubkey: mint,             isSigner: false, isWritable: false }, //  2
    { pubkey: bondingCurve,     isSigner: false, isWritable: true  }, //  3
    { pubkey: vault,            isSigner: false, isWritable: true  }, //  4
    { pubkey: userAta,          isSigner: false, isWritable: true  }, //  5
    { pubkey: user,             isSigner: true,  isWritable: true  }, //  6
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, //  7
    { pubkey: creatorVault,     isSigner: false, isWritable: true  }, //  8 ← creator_vault сдвинут
    { pubkey: tokenProgramId,   isSigner: false, isWritable: false }, //  9 ← tokenProgram сдвинут
    { pubkey: eventAuthority,   isSigner: false, isWritable: false }, // 10
    { pubkey: lastKey,          isSigner: false, isWritable: false }, // 11
    { pubkey: feeConfig,        isSigner: false, isWritable: false }, // 12
    { pubkey: FEE_PROGRAM,      isSigner: false, isWritable: false }, // 13
  ];

  // Cashback-токены: добавить userVolumeAccumulator перед bondingCurveV2
  if (cashbackEnabled) {
    const userVolumeAcc = getUserVolumeAccumulatorPDA(user, programId);
    keys.push({ pubkey: userVolumeAcc, isSigner: false, isWritable: true }); // 14 (только cashback)
  }

  // bondingCurveV2 — ВСЕГДА последний аккаунт
  keys.push({ pubkey: bondingCurveV2, isSigner: false, isWritable: false }); // 14 или 15

  return new TransactionInstruction({ programId, keys, data });
}

export async function sellToken(
  connection: Connection,
  mint: PublicKey,
  payer: Keypair,
  creator: PublicKey,
  feeRecipient: PublicKey,
  eventAuthority: PublicKey,
  amount: bigint,
  minSolOutput: bigint,
  urgent: boolean = false,
  isMayhem: boolean = false,
  cashbackEnabled: boolean = false,
  directRpc: boolean = false       // ← НОВОЕ: bypass Jito, send via sendRawTransaction
): Promise<string> {
  const owner = payer.publicKey;
  const mintState = getMintState(mint);

  if (!mintState.tokenProgramId) {
    const mintInfo = await connection.getAccountInfo(mint);
    if (!mintInfo) throw new Error('Mint account not found');
    mintState.tokenProgramId = mintInfo.owner;
  }

  const userAta = await ensureAta(connection, mint, owner, mintState.tokenProgramId);

  const sellIx = buildSellInstruction(
    mint, owner, creator, feeRecipient, eventAuthority,
    amount, minSolOutput, mintState.tokenProgramId, userAta,
    isMayhem, cashbackEnabled
  );

  const priorityFee = getCachedPriorityFee();

  const buildTx = async (): Promise<VersionedTransaction> => {
    const blockhash = await getCachedBlockhash();
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: config.compute.unitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
      sellIx,
    ];
    const message = new TransactionMessage({
      payerKey: owner, recentBlockhash: blockhash, instructions,
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([payer]);
    return tx;
  };

  if (process.env.SIMULATE === 'true') {
    const simTx = await buildTx();
    const sim = await connection.simulateTransaction(simTx);
    if (sim.value.err) throw new Error(`Sell simulation failed: ${JSON.stringify(sim.value.err)}`);
    logger.info('Sell simulation OK (SIMULATE=true, skipping send)');
    return 'sim_' + Date.now();
  }

  // ── Direct RPC path (fallback): bypass Jito, send через sendRawTransaction ──
  // HISTORY_DEV_SNIPER: параллельная fire-and-forget отправка через bloXroute
  // для повышения landing rate. RPC остаётся primary — его ошибки пробрасываются.
  if (directRpc) {
    const tx = await buildTx();
    const serialized = tx.serialize();
    sendViaBloXroute(Buffer.from(serialized)).catch(() => {});
    const sig = await connection.sendRawTransaction(serialized, {
      skipPreflight: true,
      maxRetries: 2,
    });
    logger.info(`Sell sent via direct RPC + bloXroute: ${sig}`);
    return sig;
  }

  const txId = await queueJitoSend(buildTx, payer, config.jito.maxRetries, urgent);
  logger.info('Sell transaction sent:', txId);
  return txId;
}
