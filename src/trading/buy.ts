// src/trading/buy.ts
//
// ИСПРАВЛЕНО 2026-03-20 (v2.4) — cashback upgrade февраль 2026:
//
// 1. Новый вариант buy-инструкции: buy_exact_sol_in
//    Дискриминатор: [56, 252, 116, 8, 158, 223, 205, 95]
//    Args: sol_amount (SOL в лампортах, exact-in), min_tokens_out (minimum tokens, slippage)
//    Старый buy (exact-out: amount=токены, max_sol_cost) УСТАРЕЛ и вызывает 6024.
//
// 2. Добавлен bonding_curve_v2 (PDA: ["bonding-curve-v2", mint]) на индекс 16.
//    Обязателен для ВСЕХ токенов. Может не существовать on-chain — это нормально.
//    Без него программа читает неверные индексы → u64 overflow (6024).
//
// 3. Добавлен флаг isCashbackEnabled(data) — читает byte[82] bonding curve.
//    Не путать с is_mayhem_mode (byte[81]).
//
// ИСПРАВЛЕНО 2026-03-20 (v2.3):
//    buildBuyInstructionFromCreate принимает резервы и вычисляет min_tokens_out.
//    При buy_exact_sol_in min_tokens_out = sol / (vSol+sol) * vToken * (1 - slippage).
//
// ИСПРАВЛЕНО 2026-03-20 (v2.2):
//    getFeeRecipient читает Global аккаунт (offset 41 + 162).
//    feeConfig содержит RATES, не адреса.

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
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { config } from '../config';
import { queueJitoSend } from '../infra/jito-queue';
import { getCachedBlockhash } from '../infra/blockhash-cache';
import { getCachedPriorityFee } from '../infra/priority-fee-cache';
import { getMintState, ensureAta } from '../core/state-cache';
import { logger } from '../utils/logger';
import { ensureSufficientBalance, estimateTransactionFee } from '../utils/balance';
import {
  DISCRIMINATOR,
  PUMP_FUN_PROGRAM_ID,
  PUMP_FUN_ROUTER_PROGRAM_ID,
  FEE_PROGRAM_ID,
  MAYHEM_FEE_RECIPIENTS,
  BONDING_CURVE_LAYOUT,
  GLOBAL_ACCOUNT_ADDRESS,
  GLOBAL_ACCOUNT_LAYOUT,
} from '../constants';

export const PUMP_PROGRAM_ID = new PublicKey(PUMP_FUN_PROGRAM_ID);
export const PUMP_ROUTER_PROGRAM_ID = new PublicKey(PUMP_FUN_ROUTER_PROGRAM_ID);
const FEE_PROGRAM = new PublicKey(FEE_PROGRAM_ID);
const GLOBAL_PUBKEY = new PublicKey(GLOBAL_ACCOUNT_ADDRESS);

function encodeU64(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

// ─── PDA helpers ──────────────────────────────────────────────────────────────

export function getGlobalPDA(programId: PublicKey = PUMP_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('global')], programId)[0];
}

export function getBondingCurvePDA(mint: PublicKey, programId: PublicKey = PUMP_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()], programId
  )[0];
}

/** bonding_curve_v2 PDA — обязателен с февраля 2026 для всех buy/sell.
 *  Может не существовать on-chain — передаётся как read-only remaining account. */
export function getBondingCurveV2PDA(mint: PublicKey, programId: PublicKey = PUMP_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve-v2'), mint.toBuffer()], programId
  )[0];
}

/** Vault — ATA bonding curve (NOT a PDA программы pump.fun) */
export function getVaultPDA(bondingCurve: PublicKey, mint: PublicKey, tokenProgramId: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, bondingCurve, true, tokenProgramId);
}

export function getGlobalVolumeAccumulatorPDA(programId: PublicKey = PUMP_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('global_volume_accumulator')], programId
  )[0];
}

export function getUserVolumeAccumulatorPDA(user: PublicKey, programId: PublicKey = PUMP_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user_volume_accumulator'), user.toBuffer()], programId
  )[0];
}

export function getPumpFeeConfigPDA(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('fee_config'), PUMP_PROGRAM_ID.toBuffer()],
    FEE_PROGRAM
  )[0];
}

export function getCreatorVaultPDA(creator: PublicKey, programId: PublicKey = PUMP_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), creator.toBuffer()], programId
  )[0];
}

// ─── Fee recipient ────────────────────────────────────────────────────────────

/**
 * Возвращает валидный feeRecipient из Global аккаунта.
 * Global содержит 8 допустимых адресов: fee_recipient @ offset 41 + fee_recipients[7] @ offset 162.
 * Программа: require!(fee_recipient ∈ {все 8}, NotAuthorized 6000).
 *
 * НЕ читать из feeConfig — он содержит fee RATES, не адреса.
 */
export async function getFeeRecipient(connection: Connection): Promise<PublicKey> {
  const globalAcc = await connection.getAccountInfo(GLOBAL_PUBKEY);
  if (!globalAcc) throw new Error(`Global account not found: ${GLOBAL_ACCOUNT_ADDRESS}`);

  const data = globalAcc.data;
  const recipients: PublicKey[] = [];

  const off0 = GLOBAL_ACCOUNT_LAYOUT.FEE_RECIPIENT_OFFSET; // 41
  if (data.length >= off0 + 32) {
    recipients.push(new PublicKey(data.slice(off0, off0 + 32)));
  }

  const arrOff = GLOBAL_ACCOUNT_LAYOUT.FEE_RECIPIENTS_ARRAY_OFFSET; // 162
  for (let i = 0; i < GLOBAL_ACCOUNT_LAYOUT.FEE_RECIPIENTS_COUNT; i++) {
    const off = arrOff + i * 32;
    if (data.length >= off + 32) {
      recipients.push(new PublicKey(data.slice(off, off + 32)));
    }
  }

  if (recipients.length === 0) throw new Error(`No fee recipients in Global account`);
  const idx = Math.floor(Math.random() * recipients.length);
  logger.debug(`feeRecipient[${idx}/${recipients.length}] from Global: ${recipients[idx].toBase58()}`);
  return recipients[idx];
}

export function isMayhemToken(bondingCurveData: Buffer): boolean {
  const offset = BONDING_CURVE_LAYOUT.IS_MAYHEM_MODE_OFFSET; // 81
  if (bondingCurveData.length < offset + 1) return false;
  return bondingCurveData[offset] === 1;
}

/** Новый cashback флаг — byte[82] bonding curve (добавлен в cashback upgrade фев 2026).
 *  Определяет раскладку sell: non-cashback = 15 аккаунтов, cashback = 16 аккаунтов. */
export function isCashbackEnabled(bondingCurveData: Buffer): boolean {
  const offset = BONDING_CURVE_LAYOUT.CASHBACK_ENABLED_OFFSET; // 82
  if (bondingCurveData.length < offset + 1) return false;
  return bondingCurveData[offset] === 1;
}

export function getEffectiveFeeRecipient(
  bondingCurveData: Buffer,
  defaultFeeRecipient: PublicKey
): PublicKey {
  if (isMayhemToken(bondingCurveData)) {
    const idx = Math.floor(Math.random() * MAYHEM_FEE_RECIPIENTS.length);
    logger.debug(`Mayhem token, fee recipient [${idx}]: ${MAYHEM_FEE_RECIPIENTS[idx]}`);
    return new PublicKey(MAYHEM_FEE_RECIPIENTS[idx]);
  }
  return defaultFeeRecipient;
}

export function getCreatorFromCurveData(curveData: Buffer): PublicKey {
  const offset = BONDING_CURVE_LAYOUT.CREATOR_OFFSET; // 49
  if (curveData.length < offset + 32) {
    throw new Error(`BondingCurve data too short to read creator: ${curveData.length} bytes`);
  }
  return new PublicKey(curveData.slice(offset, offset + 32));
}

// ─── Buy instruction ──────────────────────────────────────────────────────────
//
// Актуальный порядок аккаунтов по IDL после cashback upgrade (фев 2026):
// 17 аккаунтов, индексы 0–16.
//
//   0  global                     (readonly)
//   1  feeRecipient               (writable)
//   2  mint                       (readonly)
//   3  bondingCurve               (writable)
//   4  vault (ATA bonding curve)  (writable)
//   5  userAta                    (writable)
//   6  user                       (signer, writable)
//   7  systemProgram              (readonly)
//   8  tokenProgram               (readonly)
//   9  creatorVault               (writable)  seeds: ['creator-vault', creator]
//  10  eventAuthority             (readonly)  seeds: ['__event_authority']
//  11  program                    (readonly)  ВСЕГДА прямой PUMP_PROGRAM_ID
//  12  globalVolumeAcc            (readonly)
//  13  userVolumeAcc              (writable)
//  14  feeConfig                  (readonly)
//  15  feeProgram                 (readonly)
//  16  bondingCurveV2             (readonly)  seeds: ['bonding-curve-v2', mint] — НОВОЕ фев 2026
//
// Инструкция: buy_exact_sol_in (НЕ buy!)
// Args: sol_amount: u64, min_tokens_out: u64
//   sol_amount    = количество SOL в лампортах (exact-in)
//   min_tokens_out = минимум токенов (slippage protection): vToken * sol / (vSol + sol) * (1 - slippage)

export function buildBuyInstruction(
  mint: PublicKey,
  user: PublicKey,
  creator: PublicKey,
  feeRecipient: PublicKey,
  eventAuthority: PublicKey,
  solAmount: bigint,       // ← SOL в лампортах (exact-in)
  minTokensOut: bigint,    // ← минимум токенов (slippage check)
  tokenProgramId: PublicKey,
  userAta: PublicKey,
  isMayhem: boolean = false
): TransactionInstruction {
  const programId = PUMP_PROGRAM_ID;
  const global = getGlobalPDA(programId);
  const bondingCurve = getBondingCurvePDA(mint, programId);
  const vault = getVaultPDA(bondingCurve, mint, tokenProgramId);
  const creatorVault = getCreatorVaultPDA(creator, programId);
  const globalVolumeAcc = getGlobalVolumeAccumulatorPDA(programId);
  const userVolumeAcc = getUserVolumeAccumulatorPDA(user, programId);
  const feeConfig = getPumpFeeConfigPDA();
  const bondingCurveV2 = getBondingCurveV2PDA(mint, programId);
  const lastKey = programId;

  // buy_exact_sol_in: args = sol_amount (u64), min_tokens_out (u64)
  const solBuf      = encodeU64(solAmount);
  const minTokenBuf = encodeU64(minTokensOut);
  const data = Buffer.concat([DISCRIMINATOR.BUY_EXACT_SOL_IN, solBuf, minTokenBuf]);

  const keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [
    { pubkey: global,           isSigner: false, isWritable: false }, //  0
    { pubkey: feeRecipient,     isSigner: false, isWritable: true  }, //  1
    { pubkey: mint,             isSigner: false, isWritable: false }, //  2
    { pubkey: bondingCurve,     isSigner: false, isWritable: true  }, //  3
    { pubkey: vault,            isSigner: false, isWritable: true  }, //  4
    { pubkey: userAta,          isSigner: false, isWritable: true  }, //  5
    { pubkey: user,             isSigner: true,  isWritable: true  }, //  6
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, //  7
    { pubkey: tokenProgramId,   isSigner: false, isWritable: false }, //  8
    { pubkey: creatorVault,     isSigner: false, isWritable: true  }, //  9
    { pubkey: eventAuthority,   isSigner: false, isWritable: false }, // 10
    { pubkey: lastKey,          isSigner: false, isWritable: false }, // 11
    { pubkey: globalVolumeAcc,  isSigner: false, isWritable: false }, // 12 (RO с ноя 2025)
    { pubkey: userVolumeAcc,    isSigner: false, isWritable: true  }, // 13
    { pubkey: feeConfig,        isSigner: false, isWritable: false }, // 14
    { pubkey: FEE_PROGRAM,      isSigner: false, isWritable: false }, // 15
    { pubkey: bondingCurveV2,   isSigner: false, isWritable: false }, // 16 ← НОВОЕ фев 2026
  ];

  return new TransactionInstruction({ programId, keys, data });
}

/**
 * Строит buy_exact_sol_in инструкцию из параметров события CREATE или gRPC данных.
 *
 * buy_exact_sol_in — exact-in:
 *   sol_amount    = точное количество SOL в лампортах
 *   min_tokens_out = минимум токенов (AMM-формула с учётом slippage)
 *
 * min_tokens_out вычисляется как:
 *   expectedTokens = sol_amount × vToken / (vSol + sol_amount)
 *   min_tokens_out = expectedTokens × (10000 - slippageBps) / 10000
 */
export function buildBuyInstructionFromCreate(
  params: {
    mint: PublicKey;
    /** @deprecated Не используется — PDA вычисляется внутри buildBuyInstruction из mint.
     *  Оставлен для обратной совместимости вызовов. */
    bondingCurve?: PublicKey;
    creator: PublicKey;
    userAta: PublicKey;
    user: PublicKey;
    amountSol: number;
    slippageBps: number;
    virtualSolReserves: bigint;
    virtualTokenReserves: bigint;
    feeRecipient: PublicKey;
    eventAuthority: PublicKey;
    tokenProgramId: PublicKey;
    isMayhem?: boolean;
  }
): TransactionInstruction {
  const { mint, userAta, user, creator, amountSol, slippageBps,
          virtualSolReserves, virtualTokenReserves,
          feeRecipient, eventAuthority, tokenProgramId, isMayhem = false } = params;

  const solAmountLamports = BigInt(Math.floor(amountSol * 1e9));

  if (virtualSolReserves === 0n || virtualTokenReserves === 0n) {
    throw new Error('buildBuyInstructionFromCreate: reserves must be non-zero');
  }

  // Ожидаемое количество токенов по AMM constant-product
  const expectedTokens = (solAmountLamports * virtualTokenReserves)
    / (virtualSolReserves + solAmountLamports);

  if (expectedTokens === 0n) {
    throw new Error('buildBuyInstructionFromCreate: expectedTokens is 0 (amountSol too small?)');
  }

  // min_tokens_out: защита от проскальзывания цены
  const minTokensOut = (expectedTokens * (10000n - BigInt(slippageBps))) / 10000n;

  return buildBuyInstruction(
    mint, user, creator, feeRecipient, eventAuthority,
    solAmountLamports, // ← SOL (exact-in)
    minTokensOut,      // ← минимум токенов
    tokenProgramId, userAta, isMayhem
  );
}

export async function buyToken(
  connection: Connection,
  mint: PublicKey,
  payer: Keypair,
  creator: PublicKey,
  feeRecipient: PublicKey,
  eventAuthority: PublicKey,
  solAmount: bigint,
  minTokensOut: bigint,
  isMayhem: boolean = false
): Promise<string> {
  const owner = payer.publicKey;
  const mintState = getMintState(mint);

  if (!mintState.tokenProgramId) {
    const mintInfo = await connection.getAccountInfo(mint);
    if (!mintInfo) throw new Error('Mint account not found');
    mintState.tokenProgramId = mintInfo.owner;
  }

  const maxTip = config.jito.maxTipAmountSol;
  const priorityFee = getCachedPriorityFee();
  const estimatedFee = estimateTransactionFee(2, config.compute.unitLimit, priorityFee);
  const requiredSol = Number(solAmount) / 1e9 + maxTip + estimatedFee / 1e9 + 0.00001;
  await ensureSufficientBalance(connection, owner, requiredSol);

  const tokenATA = await ensureAta(connection, mint, owner, mintState.tokenProgramId);
  const createATAix = createAssociatedTokenAccountIdempotentInstruction(
    owner, tokenATA, owner, mint, mintState.tokenProgramId
  );

  const buyIx = buildBuyInstruction(
    mint, owner, creator, feeRecipient, eventAuthority,
    solAmount, minTokensOut, mintState.tokenProgramId, tokenATA, isMayhem
  );

  const buildTx = async (): Promise<VersionedTransaction> => {
    const blockhash = await getCachedBlockhash();
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: config.compute.unitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
      createATAix,
      buyIx,
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
    if (sim.value.err) throw new Error(`Buy simulation failed: ${JSON.stringify(sim.value.err)}`);
    logger.info('Buy simulation OK (SIMULATE=true, skipping send)');
    return 'sim_' + Date.now();
  }

  // ── retries=0: buy НЕ должен ретраиться на уровне jito-queue.
  // Каждый retry = новый buildTx() → новый blockhash → новая on-chain транзакция.
  // Ресенды с ATA-check делает sniper.ts confirmAndUpdatePosition.
  // Queue-level retry для buy = дублирование покупок (см. анализ сессии 20.03.2026).
  const txId = await queueJitoSend(buildTx, payer, 0, true);
  logger.info('Buy transaction sent:', txId);
  return txId;
}
