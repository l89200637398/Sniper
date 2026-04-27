// src/trading/raydiumAmmV4.ts
//
// Raydium AMM v4 — legacy constant product AMM swap
//
// Протокол: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
// Формула: x * y = k, fee 25 bps (фиксированная, numerator=25, denominator=10000)
// Используется для:
//   1. Торговли после миграции LaunchLab (migrateType=0)
//   2. Торговли на любых AMM v4 пулах Raydium (основной DEX Solana)
//
// Инструкции:
//   SwapBaseInV2:  instruction index 16 (без OpenBook accounts)
//   SwapBaseOutV2: instruction index 17 (без OpenBook accounts)
//
// Аккаунты swap V2 (8):
//   0  tokenProgram
//   1  poolId (writable)
//   2  authority (PDA, nonce из pool state)
//   3  vaultA (writable) — coin vault
//   4  vaultB (writable) — pc vault
//   5  userInputTokenAccount (writable)
//   6  userOutputTokenAccount (writable)
//   7  owner (signer)
//
// Источники:
//   - raydium-sdk-V2/src/raydium/liquidity/instruction.ts
//   - raydium-sdk-V2/src/raydium/liquidity/layout.ts
//   - raydium-sdk-V2-demo/src/grpc/subNewAmmPool.ts

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
import { config }                        from '../config';
import { queueJitoSend }                 from '../infra/jito-queue';
import { getCachedBlockhashWithHeight }  from '../infra/blockhash-cache';
import { getCachedPriorityFee }          from '../infra/priority-fee-cache';
import { logger }                        from '../utils/logger';
import { logEvent }                      from '../utils/event-logger';
import { ensureSufficientBalance, estimateTransactionFee } from '../utils/balance';
import { withRetry }                     from '../utils/retry';
import { withRpcLimit }                  from '../utils/rpc-limiter';
import {
  RAYDIUM_AMM_V4_PROGRAM_ID,
  RAYDIUM_DISCRIMINATOR,
  RAYDIUM_AMM_V4_POOL_LAYOUT,
} from '../constants';

const AMM_V4_PROGRAM = new PublicKey(RAYDIUM_AMM_V4_PROGRAM_ID);
const WSOL_MINT      = new PublicKey(config.wsolMint);
const FEE_BPS        = 25n; // фиксированная fee 25 bps для AMM v4

function encodeU64(v: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(v);
  return buf;
}

// ─── Pool state parser ───────────────────────────────────────────────────────

export interface AmmV4PoolState {
  status:          bigint;
  nonce:           bigint;   // для authority PDA
  baseDecimal:     bigint;
  quoteDecimal:    bigint;
  tradeFeeNum:     bigint;
  tradeFeeDen:     bigint;
  baseVault:       PublicKey;
  quoteVault:      PublicKey;
  baseMint:        PublicKey;
  quoteMint:       PublicKey;
  lpMint:          PublicKey;
  openOrders:      PublicKey;
  marketId:        PublicKey;
  marketProgramId: PublicKey;
  targetOrders:    PublicKey;
}

export function parseAmmV4Pool(data: Buffer): AmmV4PoolState {
  const L = RAYDIUM_AMM_V4_POOL_LAYOUT;
  if (data.length < L.TARGET_ORDERS_OFFSET + 32) {
    throw new Error(`AMM v4 pool data too short: ${data.length} bytes`);
  }

  return {
    status:          data.readBigUInt64LE(L.STATUS_OFFSET),
    nonce:           data.readBigUInt64LE(L.NONCE_OFFSET),
    baseDecimal:     data.readBigUInt64LE(L.BASE_DECIMAL_OFFSET),
    quoteDecimal:    data.readBigUInt64LE(L.QUOTE_DECIMAL_OFFSET),
    tradeFeeNum:     data.readBigUInt64LE(L.TRADE_FEE_NUM_OFFSET),
    tradeFeeDen:     data.readBigUInt64LE(L.TRADE_FEE_DEN_OFFSET),
    baseVault:       new PublicKey(data.subarray(L.BASE_VAULT_OFFSET, L.BASE_VAULT_OFFSET + 32)),
    quoteVault:      new PublicKey(data.subarray(L.QUOTE_VAULT_OFFSET, L.QUOTE_VAULT_OFFSET + 32)),
    baseMint:        new PublicKey(data.subarray(L.BASE_MINT_OFFSET, L.BASE_MINT_OFFSET + 32)),
    quoteMint:       new PublicKey(data.subarray(L.QUOTE_MINT_OFFSET, L.QUOTE_MINT_OFFSET + 32)),
    lpMint:          new PublicKey(data.subarray(L.LP_MINT_OFFSET, L.LP_MINT_OFFSET + 32)),
    openOrders:      new PublicKey(data.subarray(L.OPEN_ORDERS_OFFSET, L.OPEN_ORDERS_OFFSET + 32)),
    marketId:        new PublicKey(data.subarray(L.MARKET_ID_OFFSET, L.MARKET_ID_OFFSET + 32)),
    marketProgramId: new PublicKey(data.subarray(L.MARKET_PROGRAM_ID_OFFSET, L.MARKET_PROGRAM_ID_OFFSET + 32)),
    targetOrders:    new PublicKey(data.subarray(L.TARGET_ORDERS_OFFSET, L.TARGET_ORDERS_OFFSET + 32)),
  };
}

// ─── Authority PDA ───────────────────────────────────────────────────────────
// AMM v4 authority = PDA с nonce из pool state

const AMM_V4_AUTHORITY = new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1');

// ─── AMM math ─────────────────────────────────────────────────────────────────

/** Compute output: amountOut = amountIn * (1 - fee) * reserveOut / (reserveIn + amountIn * (1 - fee)) */
export function computeSwapOut(
  amountIn:   bigint,
  reserveIn:  bigint,
  reserveOut: bigint,
  feeNum:     bigint = FEE_BPS,
  feeDen:     bigint = 10000n,
): bigint {
  if (reserveIn === 0n || reserveOut === 0n) throw new Error('Zero reserves');
  const amountInAfterFee = amountIn * (feeDen - feeNum);
  return (amountInAfterFee * reserveOut) / (reserveIn * feeDen + amountInAfterFee);
}

// ─── Build swap instruction (SwapBaseInV2) ───────────────────────────────────
//
// Instruction index 16 (первый байт data = 16, не Anchor discriminator)
// Args: amountIn (u64), minAmountOut (u64)

export function buildAmmV4SwapBaseInInstruction(
  pool:              AmmV4PoolState,
  poolId:            PublicKey,
  user:              PublicKey,
  userInputAta:      PublicKey,
  userOutputAta:     PublicKey,
  amountIn:          bigint,
  minAmountOut:      bigint,
): TransactionInstruction {
  // Data layout: instruction_index (u8) + amountIn (u64) + minAmountOut (u64) = 17 bytes
  const data = Buffer.alloc(17);
  data.writeUInt8(RAYDIUM_DISCRIMINATOR.AMM_V4_SWAP_BASE_IN_V2_INDEX, 0); // 16
  data.writeBigUInt64LE(amountIn, 1);
  data.writeBigUInt64LE(minAmountOut, 9);

  const keys = [
    { pubkey: TOKEN_PROGRAM_ID,  isSigner: false, isWritable: false }, // 0
    { pubkey: poolId,            isSigner: false, isWritable: true  }, // 1
    { pubkey: AMM_V4_AUTHORITY,  isSigner: false, isWritable: false }, // 2
    { pubkey: pool.baseVault,    isSigner: false, isWritable: true  }, // 3 coin vault
    { pubkey: pool.quoteVault,   isSigner: false, isWritable: true  }, // 4 pc vault
    { pubkey: userInputAta,      isSigner: false, isWritable: true  }, // 5
    { pubkey: userOutputAta,     isSigner: false, isWritable: true  }, // 6
    { pubkey: user,              isSigner: true,  isWritable: true  }, // 7
  ];

  return new TransactionInstruction({ programId: AMM_V4_PROGRAM, keys, data });
}

// ─── Resolve pool ────────────────────────────────────────────────────────────

export async function resolveAmmV4Pool(
  connection: Connection,
  mint:       PublicKey,
  poolHint?:  PublicKey,
): Promise<{
  poolId:       PublicKey;
  pool:         AmmV4PoolState;
  tokenReserve: bigint;
  solReserve:   bigint;
  isBaseMint:   boolean;
}> {
  let poolId  = poolHint;
  let poolAcc: import('@solana/web3.js').AccountInfo<Buffer> | null = null;

  if (poolId) {
    poolAcc = await withRetry(() => withRpcLimit(() => connection.getAccountInfo(poolId!)));
  }

  // Fallback: getProgramAccounts по baseMint/quoteMint, prefer wSOL-paired pools
  if (!poolAcc) {
    const L = RAYDIUM_AMM_V4_POOL_LAYOUT;
    let allCandidates: { pubkey: PublicKey; account: import('@solana/web3.js').AccountInfo<Buffer> }[] = [];
    for (const offset of [L.BASE_MINT_OFFSET, L.QUOTE_MINT_OFFSET]) {
      try {
        const accounts = await withRetry(() => connection.getProgramAccounts(AMM_V4_PROGRAM, {
          commitment: 'confirmed',
          filters: [{ memcmp: { offset, bytes: mint.toBase58() } }],
        }), 3, 500);
        allCandidates.push(...accounts);
      } catch (e) {
        logger.warn(`AMM v4 getProgramAccounts failed (offset ${offset}): ${e}`);
      }
    }
    // Prefer pool where the OTHER mint is wSOL
    for (const candidate of allCandidates) {
      const parsed = parseAmmV4Pool(candidate.account.data);
      const otherMint = parsed.baseMint.equals(mint) ? parsed.quoteMint : parsed.baseMint;
      if (otherMint.equals(WSOL_MINT)) {
        poolId  = candidate.pubkey;
        poolAcc = candidate.account;
        logger.debug(`AMM v4: found wSOL-paired pool ${poolId.toBase58()}`);
        break;
      }
    }
    // If no wSOL pool, use first available
    if (!poolAcc && allCandidates.length > 0) {
      poolId  = allCandidates[0].pubkey;
      poolAcc = allCandidates[0].account;
      logger.warn(`AMM v4: no wSOL-paired pool found for ${mint.toBase58().slice(0,8)}, using first available`);
    }
  }

  if (!poolAcc || !poolId) throw new Error(`AMM v4 pool not found for ${mint.toBase58()}`);

  const pool = parseAmmV4Pool(poolAcc.data);
  const isBaseMint = pool.baseMint.equals(mint);

  const [baseBalance, quoteBalance] = await Promise.all([
    withRpcLimit(() => connection.getTokenAccountBalance(pool.baseVault)),
    withRpcLimit(() => connection.getTokenAccountBalance(pool.quoteVault)),
  ]);

  const tokenReserve = isBaseMint
    ? BigInt(baseBalance.value.amount)
    : BigInt(quoteBalance.value.amount);
  const solReserve = isBaseMint
    ? BigInt(quoteBalance.value.amount)
    : BigInt(baseBalance.value.amount);

  return { poolId, pool, tokenReserve, solReserve, isBaseMint };
}

// ─── buyTokenAmmV4 ───────────────────────────────────────────────────────────

export async function buyTokenAmmV4(
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

  const { poolId, pool, tokenReserve, solReserve, isBaseMint } =
    await resolveAmmV4Pool(connection, mint, poolHint);

  // Validate wSOL pair
  const quoteMint = isBaseMint ? pool.quoteMint : pool.baseMint;
  if (!quoteMint.equals(WSOL_MINT)) {
    throw new Error(`AMM v4 pool ${poolId.toBase58().slice(0,8)} is not wSOL-paired (quote=${quoteMint.toBase58().slice(0,8)})`);
  }

  const solIn       = BigInt(Math.floor(solAmount * 1e9));
  const feeNum      = pool.tradeFeeNum > 0n ? pool.tradeFeeNum : FEE_BPS;
  const feeDen      = pool.tradeFeeDen > 0n ? pool.tradeFeeDen : 10000n;
  const expectedOut = computeSwapOut(solIn, solReserve, tokenReserve, feeNum, feeDen);
  const minOut      = (expectedOut * BigInt(10000 - slippageBps)) / 10000n;

  // AMM v4: vaultA=baseVault(coin), vaultB=quoteVault(pc)
  // Buy: input=wSOL (quote side), output=token (base side)
  const userWsolAta  = getAssociatedTokenAddressSync(WSOL_MINT, owner, false, TOKEN_PROGRAM_ID);
  const userTokenAta = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID);

  const buildTx = async (): Promise<VersionedTransaction> => {
    const { blockhash } = await getCachedBlockhashWithHeight();
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: config.compute.unitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
      createAssociatedTokenAccountIdempotentInstruction(
        owner, userTokenAta, owner, mint, TOKEN_PROGRAM_ID,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        owner, userWsolAta, owner, WSOL_MINT, TOKEN_PROGRAM_ID,
      ),
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: userWsolAta, lamports: solIn }),
      createSyncNativeInstruction(userWsolAta),
      buildAmmV4SwapBaseInInstruction(
        pool, poolId, owner,
        userWsolAta,   // input = wSOL
        userTokenAta,  // output = token
        solIn, minOut,
      ),
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
    if (sim.value.err) throw new Error(`AMM v4 buy sim failed: ${JSON.stringify(sim.value.err)}`);
    logger.info('AMM v4 buy simulation OK (SIMULATE=true, skipping send)');
    return 'sim_' + Date.now();
  }

  logEvent('TX_DIAGNOSTIC', {
    protocol: 'raydium-ammv4',
    action: 'buy',
    mint: mint.toBase58(),
    disc: 'SwapBaseInV2 (index=16)',
    poolId: poolId.toBase58(),
    authority: AMM_V4_AUTHORITY.toBase58(),
    baseVault: pool.baseVault.toBase58(),
    quoteVault: pool.quoteVault.toBase58(),
    baseMint: pool.baseMint.toBase58(),
    quoteMint: pool.quoteMint.toBase58(),
    userWsolAta: userWsolAta.toBase58(),
    userTokenAta: userTokenAta.toBase58(),
    isBaseMint,
    tradeFeeNum: pool.tradeFeeNum.toString(),
    tradeFeeDen: pool.tradeFeeDen.toString(),
    solIn: solIn.toString(),
    expectedOut: expectedOut.toString(),
    minOut: minOut.toString(),
    tokenReserve: tokenReserve.toString(),
    solReserve: solReserve.toString(),
  }, { mint: mint.toBase58(), protocol: 'raydium-ammv4' });

  const txId = await queueJitoSend(buildTx, payer, 0, true);
  logger.info(`AMM v4 buy sent: ${txId} (${solAmount} SOL)`);
  return txId;
}

// ─── sellTokenAmmV4 ──────────────────────────────────────────────────────────

export async function sellTokenAmmV4(
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

  const { poolId, pool, tokenReserve, solReserve } =
    await resolveAmmV4Pool(connection, mint, poolHint);

  const feeNum      = pool.tradeFeeNum > 0n ? pool.tradeFeeNum : FEE_BPS;
  const feeDen      = pool.tradeFeeDen > 0n ? pool.tradeFeeDen : 10000n;
  const expectedSol = computeSwapOut(tokenAmountRaw, tokenReserve, solReserve, feeNum, feeDen);
  const minSolOut   = (expectedSol * BigInt(10000 - slippageBps)) / 10000n;

  const userTokenAta = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID);
  const userWsolAta  = getAssociatedTokenAddressSync(WSOL_MINT, owner, false, TOKEN_PROGRAM_ID);

  const buildTx = async (): Promise<VersionedTransaction> => {
    const { blockhash } = await getCachedBlockhashWithHeight();
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: config.compute.unitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
      createAssociatedTokenAccountIdempotentInstruction(
        owner, userWsolAta, owner, WSOL_MINT, TOKEN_PROGRAM_ID,
      ),
      buildAmmV4SwapBaseInInstruction(
        pool, poolId, owner,
        userTokenAta,  // input = token
        userWsolAta,   // output = wSOL
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
    protocol: 'raydium-ammv4',
    action: 'sell',
    mint: mint.toBase58(),
    disc: 'SwapBaseInV2 (index=16)',
    poolId: poolId.toBase58(),
    baseVault: pool.baseVault.toBase58(),
    quoteVault: pool.quoteVault.toBase58(),
    userTokenAta: userTokenAta.toBase58(),
    userWsolAta: userWsolAta.toBase58(),
    tradeFeeNum: pool.tradeFeeNum.toString(),
    tradeFeeDen: pool.tradeFeeDen.toString(),
    tokenAmountRaw: tokenAmountRaw.toString(),
    expectedSol: expectedSol.toString(),
    minSolOut: minSolOut.toString(),
    tokenReserve: tokenReserve.toString(),
    solReserve: solReserve.toString(),
    directRpc,
  }, { mint: mint.toBase58(), protocol: 'raydium-ammv4' });

  if (process.env.SIMULATE === 'true') {
    const sim = await connection.simulateTransaction(await buildTx());
    if (sim.value.err) throw new Error(`AMM v4 sell sim failed: ${JSON.stringify(sim.value.err)}`);
    logger.info('AMM v4 sell simulation OK (SIMULATE=true, skipping send)');
    return 'sim_' + Date.now();
  }

  if (directRpc) {
    const tx  = await buildTx();
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
    logger.info(`AMM v4 sell via direct RPC: ${sig}`);
    return sig;
  }

  const txId = await queueJitoSend(buildTx, payer, config.jito.maxRetries, false);
  logger.info(`AMM v4 sell sent: ${txId} (~${Number(expectedSol) / 1e9} SOL)`);
  return txId;
}
