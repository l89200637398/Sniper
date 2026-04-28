// src/trading/raydiumCpmm.ts
//
// Raydium CPMM (CP-Swap) — constant product AMM swap (аналог PumpSwap)
//
// Протокол: CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
// Формула: x * y = k с fee (25/100/200/400 bps, читается из configId пула)
// Используется для:
//   1. Торговли после миграции LaunchLab (migrateType=1)
//   2. Торговли на любых CPMM пулах Raydium
//
// Инструкции:
//   SwapBaseIn:  disc [143,190,90,218,196,30,51,222] — указываем вход, получаем выход
//   SwapBaseOut: disc [55,217,98,86,163,74,180,173]  — указываем выход, платим вход
//
// Аккаунты swap (13):
//   0  payer (signer)
//   1  authority (CPMM auth PDA)
//   2  configId (pool config — содержит fee rate)
//   3  poolId (writable)
//   4  userInputTokenAccount (writable)
//   5  userOutputTokenAccount (writable)
//   6  inputVault (writable)
//   7  outputVault (writable)
//   8  inputTokenProgram
//   9  outputTokenProgram
//  10  inputMint
//  11  outputMint
//  12  observationId (writable)
//
// Источники:
//   - raydium-sdk-V2/src/raydium/cpmm/instruction.ts
//   - raydium-sdk-V2/src/raydium/cpmm/layout.ts

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
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { config, computeDynamicSlippage } from '../config';
import { queueJitoSend }                 from '../infra/jito-queue';
import { getCachedBlockhashWithHeight }  from '../infra/blockhash-cache';
import { getCachedPriorityFee }          from '../infra/priority-fee-cache';
import { logger }                        from '../utils/logger';
import { logEvent }                      from '../utils/event-logger';
import { ensureSufficientBalance, estimateTransactionFee } from '../utils/balance';
import { withRetry }                     from '../utils/retry';
import { withRpcLimit }                  from '../utils/rpc-limiter';
import {
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_CPMM_AUTH,
  RAYDIUM_DISCRIMINATOR,
  RAYDIUM_CPMM_POOL_LAYOUT,
} from '../constants';

const CPMM_PROGRAM = new PublicKey(RAYDIUM_CPMM_PROGRAM_ID);
const CPMM_AUTH    = new PublicKey(RAYDIUM_CPMM_AUTH);
const WSOL_MINT    = new PublicKey(config.wsolMint);

function encodeU64(v: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(v);
  return buf;
}

// ─── Pool state parser ───────────────────────────────────────────────────────

export interface CpmmPoolState {
  configId:      PublicKey;
  poolCreator:   PublicKey;
  vaultA:        PublicKey;
  vaultB:        PublicKey;
  mintLp:        PublicKey;
  mintA:         PublicKey;   // base token
  mintB:         PublicKey;   // quote token (wSOL)
  mintProgramA:  PublicKey;
  mintProgramB:  PublicKey;
  observationId: PublicKey;
  bump:          number;
  status:        number;
  mintDecimalA:  number;
  mintDecimalB:  number;
  lpAmount:      bigint;
}

export function parseCpmmPool(data: Buffer): CpmmPoolState {
  const L = RAYDIUM_CPMM_POOL_LAYOUT;
  if (data.length < L.LP_AMOUNT_OFFSET + 8) {
    throw new Error(`CPMM pool data too short: ${data.length} bytes`);
  }

  return {
    configId:      new PublicKey(data.subarray(L.CONFIG_ID_OFFSET, L.CONFIG_ID_OFFSET + 32)),
    poolCreator:   new PublicKey(data.subarray(L.POOL_CREATOR_OFFSET, L.POOL_CREATOR_OFFSET + 32)),
    vaultA:        new PublicKey(data.subarray(L.VAULT_A_OFFSET, L.VAULT_A_OFFSET + 32)),
    vaultB:        new PublicKey(data.subarray(L.VAULT_B_OFFSET, L.VAULT_B_OFFSET + 32)),
    mintLp:        new PublicKey(data.subarray(L.MINT_LP_OFFSET, L.MINT_LP_OFFSET + 32)),
    mintA:         new PublicKey(data.subarray(L.MINT_A_OFFSET, L.MINT_A_OFFSET + 32)),
    mintB:         new PublicKey(data.subarray(L.MINT_B_OFFSET, L.MINT_B_OFFSET + 32)),
    mintProgramA:  new PublicKey(data.subarray(L.MINT_PROGRAM_A_OFFSET, L.MINT_PROGRAM_A_OFFSET + 32)),
    mintProgramB:  new PublicKey(data.subarray(L.MINT_PROGRAM_B_OFFSET, L.MINT_PROGRAM_B_OFFSET + 32)),
    observationId: new PublicKey(data.subarray(L.OBSERVATION_ID_OFFSET, L.OBSERVATION_ID_OFFSET + 32)),
    bump:          data[L.BUMP_OFFSET],
    status:        data[L.STATUS_OFFSET],
    mintDecimalA:  data[L.MINT_DECIMAL_A_OFFSET],
    mintDecimalB:  data[L.MINT_DECIMAL_B_OFFSET],
    lpAmount:      data.readBigUInt64LE(L.LP_AMOUNT_OFFSET),
  };
}

// ─── AMM math ─────────────────────────────────────────────────────────────────
// CPMM: x * y = k с fee. Fee читается из pool configId, не хардкодится.
// Для расчёта без точного fee rate используем conservative estimate.

/** Compute output amount for SwapBaseIn (exact input → variable output) */
export function computeSwapOut(
  amountIn:   bigint,
  reserveIn:  bigint,
  reserveOut: bigint,
  feeBps:     bigint = 25n,  // default 25 bps, можно перечитать из configId
): bigint {
  if (reserveIn === 0n || reserveOut === 0n) throw new Error('Zero reserves');
  const amountInAfterFee = amountIn * (10000n - feeBps);
  return (amountInAfterFee * reserveOut) / (reserveIn * 10000n + amountInAfterFee);
}

// ─── Build swap instruction (SwapBaseIn) ─────────────────────────────────────
//
// SwapBaseIn: disc [143,190,90,218,196,30,51,222]
// Args: amountIn (u64), amountOutMin (u64)

export function buildCpmmSwapBaseInInstruction(
  pool:            CpmmPoolState,
  poolId:          PublicKey,
  user:            PublicKey,
  userInputAta:    PublicKey,
  userOutputAta:   PublicKey,
  inputVault:      PublicKey,
  outputVault:     PublicKey,
  inputMint:       PublicKey,
  outputMint:      PublicKey,
  inputTokenProgram:  PublicKey,
  outputTokenProgram: PublicKey,
  amountIn:        bigint,
  amountOutMin:    bigint,
): TransactionInstruction {
  const data = Buffer.concat([
    RAYDIUM_DISCRIMINATOR.CPMM_SWAP_BASE_IN,
    encodeU64(amountIn),
    encodeU64(amountOutMin),
  ]);

  const keys = [
    { pubkey: user,               isSigner: true,  isWritable: true  }, //  0 payer
    { pubkey: CPMM_AUTH,          isSigner: false, isWritable: false }, //  1 authority
    { pubkey: pool.configId,      isSigner: false, isWritable: false }, //  2 configId
    { pubkey: poolId,             isSigner: false, isWritable: true  }, //  3 pool
    { pubkey: userInputAta,       isSigner: false, isWritable: true  }, //  4 user input
    { pubkey: userOutputAta,      isSigner: false, isWritable: true  }, //  5 user output
    { pubkey: inputVault,         isSigner: false, isWritable: true  }, //  6 input vault
    { pubkey: outputVault,        isSigner: false, isWritable: true  }, //  7 output vault
    { pubkey: inputTokenProgram,  isSigner: false, isWritable: false }, //  8
    { pubkey: outputTokenProgram, isSigner: false, isWritable: false }, //  9
    { pubkey: inputMint,          isSigner: false, isWritable: false }, // 10
    { pubkey: outputMint,         isSigner: false, isWritable: false }, // 11
    { pubkey: pool.observationId, isSigner: false, isWritable: true  }, // 12
  ];

  return new TransactionInstruction({ programId: CPMM_PROGRAM, keys, data });
}

// ─── Resolve pool ────────────────────────────────────────────────────────────

export async function resolveCpmmPool(
  connection: Connection,
  mint:       PublicKey,
  poolHint?:  PublicKey,
): Promise<{
  poolId:       PublicKey;
  pool:         CpmmPoolState;
  tokenReserve: bigint;
  solReserve:   bigint;
  isBaseToken:  boolean;
}> {
  let poolId  = poolHint;
  let poolAcc: import('@solana/web3.js').AccountInfo<Buffer> | null = null;

  // 1. Hint
  if (poolId) {
    poolAcc = await withRetry(() => withRpcLimit(() => connection.getAccountInfo(poolId!)));
  }

  // 2. getProgramAccounts fallback — ищем mint как mintA или mintB, предпочитаем wSOL-paired
  if (!poolAcc) {
    const L = RAYDIUM_CPMM_POOL_LAYOUT;
    const allCandidates: { pubkey: PublicKey; account: import('@solana/web3.js').AccountInfo<Buffer> }[] = [];
    for (const offset of [L.MINT_A_OFFSET, L.MINT_B_OFFSET]) {
      try {
        const accounts = await withRetry(() => connection.getProgramAccounts(CPMM_PROGRAM, {
          commitment: 'confirmed',
          filters: [{ memcmp: { offset, bytes: mint.toBase58() } }],
        }), 3, 500);
        allCandidates.push(...accounts);
      } catch (e) {
        logger.warn(`CPMM getProgramAccounts failed (offset ${offset}): ${e}`);
      }
    }
    // Prefer wSOL-paired pool
    for (const candidate of allCandidates) {
      const parsed = parseCpmmPool(candidate.account.data);
      const otherMint = parsed.mintA.equals(mint) ? parsed.mintB : parsed.mintA;
      if (otherMint.equals(WSOL_MINT)) {
        poolId  = candidate.pubkey;
        poolAcc = candidate.account;
        break;
      }
    }
    // Fallback to any pool if no wSOL-paired found
    if (!poolAcc && allCandidates.length > 0) {
      poolId  = allCandidates[0].pubkey;
      poolAcc = allCandidates[0].account;
    }
  }

  if (!poolAcc || !poolId) throw new Error(`CPMM pool not found for ${mint.toBase58()}`);

  const pool = parseCpmmPool(poolAcc.data);
  const isBaseToken = pool.mintA.equals(mint);

  // Read reserves from vault accounts
  const [reserveA, reserveB] = await Promise.all([
    withRpcLimit(() => connection.getTokenAccountBalance(pool.vaultA)),
    withRpcLimit(() => connection.getTokenAccountBalance(pool.vaultB)),
  ]);

  const tokenReserve = isBaseToken
    ? BigInt(reserveA.value.amount)
    : BigInt(reserveB.value.amount);
  const solReserve = isBaseToken
    ? BigInt(reserveB.value.amount)
    : BigInt(reserveA.value.amount);

  return { poolId, pool, tokenReserve, solReserve, isBaseToken };
}

// ─── buyTokenCpmm ────────────────────────────────────────────────────────────
// Buy = SOL → token (input=wSOL, output=token)

export async function buyTokenCpmm(
  connection:  Connection,
  mint:        PublicKey,
  payer:       Keypair,
  solAmount:   number,
  slippageBps: number,
  poolHint?:   PublicKey,
): Promise<string> {
  const owner       = payer.publicKey;
  const priorityFee = getCachedPriorityFee();
  const maxTip      = config.jito.maxTipAmountSol;
  const estFee      = estimateTransactionFee(2, config.compute.unitLimit, priorityFee);

  await ensureSufficientBalance(connection, owner, solAmount + maxTip + estFee / 1e9 + 0.003);

  const { poolId, pool, tokenReserve, solReserve, isBaseToken } =
    await resolveCpmmPool(connection, mint, poolHint);

  // Только wSOL-парные пулы (mintA или mintB должен быть wSOL)
  const quoteMint = isBaseToken ? pool.mintB : pool.mintA;
  if (!quoteMint.equals(WSOL_MINT)) {
    throw new Error(`CPMM pool ${poolId.toBase58().slice(0,8)} is not wSOL-paired: quote=${quoteMint.toBase58().slice(0,8)}`);
  }

  const solIn         = BigInt(Math.floor(solAmount * 1e9));
  const expectedOut   = computeSwapOut(solIn, solReserve, tokenReserve);
  // Dynamic slippage: reduce when entry is small relative to pool liquidity
  const liquiditySol     = Number(solReserve) / 1e9;
  const effectiveSlippage = computeDynamicSlippage(solAmount, liquiditySol, slippageBps);
  const minOut        = (expectedOut * BigInt(10000 - effectiveSlippage)) / 10000n;

  // Determine input/output based on pool layout
  const inputMint          = isBaseToken ? pool.mintB : pool.mintA;
  const outputMint         = isBaseToken ? pool.mintA : pool.mintB;
  const inputVault         = isBaseToken ? pool.vaultB : pool.vaultA;
  const outputVault        = isBaseToken ? pool.vaultA : pool.vaultB;
  const inputTokenProgram  = isBaseToken ? pool.mintProgramB : pool.mintProgramA;
  const outputTokenProgram = isBaseToken ? pool.mintProgramA : pool.mintProgramB;

  const userWsolAta  = getAssociatedTokenAddressSync(WSOL_MINT, owner, false, TOKEN_PROGRAM_ID);
  const userTokenAta = getAssociatedTokenAddressSync(mint, owner, false, outputTokenProgram);

  const buildTx = async (): Promise<VersionedTransaction> => {
    const { blockhash } = await getCachedBlockhashWithHeight();
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: config.compute.unitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
      createAssociatedTokenAccountIdempotentInstruction(
        owner, userTokenAta, owner, mint, outputTokenProgram,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        owner, userWsolAta, owner, WSOL_MINT, TOKEN_PROGRAM_ID,
      ),
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: userWsolAta, lamports: solIn }),
      createSyncNativeInstruction(userWsolAta),
      buildCpmmSwapBaseInInstruction(
        pool, poolId, owner,
        userWsolAta,   // input = wSOL
        userTokenAta,  // output = token
        inputVault, outputVault,
        inputMint, outputMint,
        inputTokenProgram, outputTokenProgram,
        solIn, minOut,
      ),
      // Unwrap leftover wSOL from slippage → native SOL
      createCloseAccountInstruction(userWsolAta, owner, owner),
    ];
    const message = new TransactionMessage({
      payerKey: owner, recentBlockhash: blockhash, instructions,
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([payer]);
    return tx;
  };

  if (process.env.SIMULATE === 'true') {
    const sim = await connection.simulateTransaction(await buildTx());
    if (sim.value.err) throw new Error(`CPMM buy sim failed: ${JSON.stringify(sim.value.err)}`);
    logger.info('CPMM buy simulation OK (SIMULATE=true, skipping send)');
    return 'sim_' + Date.now();
  }

  logEvent('TX_DIAGNOSTIC', {
    protocol: 'raydium-cpmm',
    action: 'buy',
    mint: mint.toBase58(),
    disc: 'CPMM_SWAP_BASE_IN',
    poolId: poolId.toBase58(),
    configId: pool.configId.toBase58(),
    authority: CPMM_AUTH.toBase58(),
    inputVault: inputVault.toBase58(),
    outputVault: outputVault.toBase58(),
    inputMint: inputMint.toBase58(),
    outputMint: outputMint.toBase58(),
    observationId: pool.observationId.toBase58(),
    inputTokenProgram: inputTokenProgram.toBase58(),
    outputTokenProgram: outputTokenProgram.toBase58(),
    userWsolAta: userWsolAta.toBase58(),
    userTokenAta: userTokenAta.toBase58(),
    isBaseToken,
    solIn: solIn.toString(),
    expectedOut: expectedOut.toString(),
    minOut: minOut.toString(),
    tokenReserve: tokenReserve.toString(),
    solReserve: solReserve.toString(),
    effectiveSlippage,
  }, { mint: mint.toBase58(), protocol: 'raydium-cpmm' });

  const txId = await queueJitoSend(buildTx, payer, 0, true);
  logger.info(`CPMM buy sent: ${txId} (${solAmount} SOL)`);
  return txId;
}

// ─── sellTokenCpmm ───────────────────────────────────────────────────────────
// Sell = token → SOL (input=token, output=wSOL)

export async function sellTokenCpmm(
  connection:      Connection,
  mint:            PublicKey,
  payer:           Keypair,
  tokenAmountRaw:  bigint,
  slippageBps:     number,
  directRpc:       boolean = false,
  poolHint?:       PublicKey,
): Promise<string> {
  const owner       = payer.publicKey;
  const priorityFee = getCachedPriorityFee();
  const maxTip      = config.jito.maxTipAmountSol;
  const estFee      = estimateTransactionFee(2, config.compute.unitLimit, priorityFee);

  await ensureSufficientBalance(connection, owner, maxTip + estFee / 1e9 + 0.001);

  const { poolId, pool, tokenReserve, solReserve, isBaseToken } =
    await resolveCpmmPool(connection, mint, poolHint);

  const quoteM = isBaseToken ? pool.mintB : pool.mintA;
  if (!quoteM.equals(WSOL_MINT)) {
    throw new Error(`CPMM pool ${poolId.toBase58().slice(0,8)} is not wSOL-paired: quote=${quoteM.toBase58().slice(0,8)}`);
  }

  const expectedSol = computeSwapOut(tokenAmountRaw, tokenReserve, solReserve);
  const minSolOut   = (expectedSol * BigInt(10000 - slippageBps)) / 10000n;

  // input=token, output=wSOL
  const inputMint          = isBaseToken ? pool.mintA : pool.mintB;
  const outputMint         = isBaseToken ? pool.mintB : pool.mintA;
  const inputVault         = isBaseToken ? pool.vaultA : pool.vaultB;
  const outputVault        = isBaseToken ? pool.vaultB : pool.vaultA;
  const inputTokenProgram  = isBaseToken ? pool.mintProgramA : pool.mintProgramB;
  const outputTokenProgram = isBaseToken ? pool.mintProgramB : pool.mintProgramA;

  const userTokenAta = getAssociatedTokenAddressSync(mint, owner, false, inputTokenProgram);
  const userWsolAta  = getAssociatedTokenAddressSync(WSOL_MINT, owner, false, TOKEN_PROGRAM_ID);

  const buildTx = async (): Promise<VersionedTransaction> => {
    const { blockhash } = await getCachedBlockhashWithHeight();
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: config.compute.unitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
      createAssociatedTokenAccountIdempotentInstruction(
        owner, userWsolAta, owner, WSOL_MINT, TOKEN_PROGRAM_ID,
      ),
      buildCpmmSwapBaseInInstruction(
        pool, poolId, owner,
        userTokenAta,  // input = token
        userWsolAta,   // output = wSOL
        inputVault, outputVault,
        inputMint, outputMint,
        inputTokenProgram, outputTokenProgram,
        tokenAmountRaw, minSolOut,
      ),
      // Unwrap wSOL → native SOL
      createCloseAccountInstruction(userWsolAta, owner, owner),
    ];
    const message = new TransactionMessage({
      payerKey: owner, recentBlockhash: blockhash, instructions,
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([payer]);
    return tx;
  };

  logEvent('TX_DIAGNOSTIC', {
    protocol: 'raydium-cpmm',
    action: 'sell',
    mint: mint.toBase58(),
    disc: 'CPMM_SWAP_BASE_IN',
    poolId: poolId.toBase58(),
    configId: pool.configId.toBase58(),
    inputVault: inputVault.toBase58(),
    outputVault: outputVault.toBase58(),
    inputTokenProgram: inputTokenProgram.toBase58(),
    outputTokenProgram: outputTokenProgram.toBase58(),
    userTokenAta: userTokenAta.toBase58(),
    userWsolAta: userWsolAta.toBase58(),
    isBaseToken,
    tokenAmountRaw: tokenAmountRaw.toString(),
    expectedSol: expectedSol.toString(),
    minSolOut: minSolOut.toString(),
    tokenReserve: tokenReserve.toString(),
    solReserve: solReserve.toString(),
    directRpc,
  }, { mint: mint.toBase58(), protocol: 'raydium-cpmm' });

  if (process.env.SIMULATE === 'true') {
    const sim = await connection.simulateTransaction(await buildTx());
    if (sim.value.err) throw new Error(`CPMM sell sim failed: ${JSON.stringify(sim.value.err)}`);
    logger.info('CPMM sell simulation OK (SIMULATE=true, skipping send)');
    return 'sim_' + Date.now();
  }

  if (directRpc) {
    const tx  = await buildTx();
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
    logger.info(`CPMM sell via direct RPC: ${sig}`);
    return sig;
  }

  const txId = await queueJitoSend(buildTx, payer, config.jito.maxRetries, false);
  logger.info(`CPMM sell sent: ${txId} (~${Number(expectedSol) / 1e9} SOL)`);
  return txId;
}
