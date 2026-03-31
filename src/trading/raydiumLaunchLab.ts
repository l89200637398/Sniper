// src/trading/raydiumLaunchLab.ts
//
// Raydium LaunchLab — bonding curve buy/sell (аналог pump.fun)
//
// Протокол: LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj
// Формула: constant product (x * y = k) на bonding curve
// Graduation: при достижении totalFundRaisingB (default 85 SOL) → миграция в AMM v4 или CPMM
//
// Инструкции:
//   BuyExactIn:  disc [250,234,13,123,213,156,19,236] — указываем SOL, получаем токены
//   SellExactIn: disc [149,39,222,155,211,124,152,26] — указываем токены, получаем SOL
//
// Аккаунты buy/sell (16-17):
//   0  owner (signer, writable)
//   1  auth (LaunchLab authority PDA)
//   2  configId
//   3  platformId
//   4  poolId (writable)
//   5  userTokenAccountA (writable) — user's project token ATA
//   6  userTokenAccountB (writable) — user's wSOL ATA
//   7  vaultA (writable) — pool's project token vault
//   8  vaultB (writable) — pool's wSOL vault
//   9  mintA — project token mint
//  10  mintB — wSOL mint
//  11  tokenProgramA
//  12  tokenProgramB
//  13  eventAuthority (CPI event PDA)
//  14  programId (self)
//  15  systemProgram
//  16  platformClaimFeeVault (writable)
//  17  creatorClaimFeeVault (writable)
//  (optional: shareFeeReceiver before systemProgram)
//
// Источники:
//   - raydium-sdk-V2/src/raydium/launchpad/instrument.ts
//   - raydium-sdk-V2/src/raydium/launchpad/pda.ts
//   - raydium-sdk-V2/src/raydium/launchpad/layout.ts

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
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { config }                        from '../config';
import { queueJitoSend }                 from '../infra/jito-queue';
import { getCachedBlockhashWithHeight }  from '../infra/blockhash-cache';
import { getCachedPriorityFee }          from '../infra/priority-fee-cache';
import { logger }                        from '../utils/logger';
import { ensureSufficientBalance, estimateTransactionFee } from '../utils/balance';
import { withRetry }                     from '../utils/retry';
import { withRpcLimit }                  from '../utils/rpc-limiter';
import {
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  RAYDIUM_LAUNCHLAB_AUTH,
  RAYDIUM_LAUNCHLAB_PLATFORM,
  RAYDIUM_LAUNCHLAB_CONFIG,
  RAYDIUM_DISCRIMINATOR,
  RAYDIUM_LAUNCH_POOL_LAYOUT,
  RAYDIUM_PDA_SEEDS,
} from '../constants';

const LAUNCH_PROGRAM  = new PublicKey(RAYDIUM_LAUNCHLAB_PROGRAM_ID);
const LAUNCH_AUTH     = new PublicKey(RAYDIUM_LAUNCHLAB_AUTH);
const LAUNCH_PLATFORM = new PublicKey(RAYDIUM_LAUNCHLAB_PLATFORM);
const LAUNCH_CONFIG   = new PublicKey(RAYDIUM_LAUNCHLAB_CONFIG);
const WSOL_MINT       = new PublicKey(config.wsolMint);

function encodeU64(v: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(v);
  return buf;
}

// ─── PDA helpers ──────────────────────────────────────────────────────────────

export function getLaunchPoolPDA(mintA: PublicKey, mintB: PublicKey = WSOL_MINT): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(RAYDIUM_PDA_SEEDS.POOL), mintA.toBuffer(), mintB.toBuffer()],
    LAUNCH_PROGRAM,
  )[0];
}

export function getLaunchVaultPDA(poolId: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(RAYDIUM_PDA_SEEDS.POOL_VAULT), poolId.toBuffer(), mint.toBuffer()],
    LAUNCH_PROGRAM,
  )[0];
}

export function getLaunchAuthPDA(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(RAYDIUM_PDA_SEEDS.AUTH)],
    LAUNCH_PROGRAM,
  )[0];
}

export function getLaunchEventAuthorityPDA(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(RAYDIUM_PDA_SEEDS.CPI_EVENT)],
    LAUNCH_PROGRAM,
  )[0];
}

function getPlatformFeeVaultAuthPDA(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(RAYDIUM_PDA_SEEDS.PLATFORM_FEE_VAULT_AUTH)],
    LAUNCH_PROGRAM,
  )[0];
}

function getCreatorFeeVaultAuthPDA(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(RAYDIUM_PDA_SEEDS.CREATOR_FEE_VAULT_AUTH)],
    LAUNCH_PROGRAM,
  )[0];
}

// ─── Pool state parser ───────────────────────────────────────────────────────

export interface LaunchLabPoolState {
  status:       number;    // 0=active, 1=migrate (graduated)
  mintDecimalA: number;
  mintDecimalB: number;
  supply:       bigint;
  totalSellA:   bigint;
  virtualA:     bigint;    // virtual token reserves
  virtualB:     bigint;    // virtual SOL reserves
  realA:        bigint;    // real token reserves
  realB:        bigint;    // real SOL reserves
  configId:     PublicKey;
  platformId:   PublicKey;
  mintA:        PublicKey;  // project token
  mintB:        PublicKey;  // wSOL
  vaultA:       PublicKey;
  vaultB:       PublicKey;
  creator:      PublicKey;
  migrateType:  number;    // 0=AMM v4, 1=CPMM
}

export function parseLaunchLabPool(data: Buffer): LaunchLabPoolState {
  const L = RAYDIUM_LAUNCH_POOL_LAYOUT;
  if (data.length < L.MIGRATE_TYPE_OFFSET + 1) {
    throw new Error(`LaunchLab pool data too short: ${data.length} bytes`);
  }

  return {
    status:       data[L.STATUS_OFFSET],
    mintDecimalA: data[L.MINT_DECIMAL_A_OFFSET],
    mintDecimalB: data[L.MINT_DECIMAL_B_OFFSET],
    supply:       data.readBigUInt64LE(L.SUPPLY_OFFSET),
    totalSellA:   data.readBigUInt64LE(L.TOTAL_SELL_A_OFFSET),
    virtualA:     data.readBigUInt64LE(L.VIRTUAL_A_OFFSET),
    virtualB:     data.readBigUInt64LE(L.VIRTUAL_B_OFFSET),
    realA:        data.readBigUInt64LE(L.REAL_A_OFFSET),
    realB:        data.readBigUInt64LE(L.REAL_B_OFFSET),
    configId:     new PublicKey(data.subarray(L.CONFIG_ID_OFFSET, L.CONFIG_ID_OFFSET + 32)),
    platformId:   new PublicKey(data.subarray(L.PLATFORM_ID_OFFSET, L.PLATFORM_ID_OFFSET + 32)),
    mintA:        new PublicKey(data.subarray(L.MINT_A_OFFSET, L.MINT_A_OFFSET + 32)),
    mintB:        new PublicKey(data.subarray(L.MINT_B_OFFSET, L.MINT_B_OFFSET + 32)),
    vaultA:       new PublicKey(data.subarray(L.VAULT_A_OFFSET, L.VAULT_A_OFFSET + 32)),
    vaultB:       new PublicKey(data.subarray(L.VAULT_B_OFFSET, L.VAULT_B_OFFSET + 32)),
    creator:      new PublicKey(data.subarray(L.CREATOR_OFFSET, L.CREATOR_OFFSET + 32)),
    migrateType:  data[L.MIGRATE_TYPE_OFFSET],
  };
}

// ─── AMM math ─────────────────────────────────────────────────────────────────
// LaunchLab использует constant product: x * y = k
// Без pool fee на bonding curve (fees берутся из platformConfig/configId)

/** Сколько токенов A получим за amountB SOL (buy exact in) */
export function computeBuyExactIn(
  amountB: bigint,
  virtualA: bigint,
  virtualB: bigint,
): bigint {
  if (virtualA === 0n || virtualB === 0n) throw new Error('Zero reserves');
  // amountA_out = virtualA - k / (virtualB + amountB) = virtualA * amountB / (virtualB + amountB)
  return (virtualA * amountB) / (virtualB + amountB);
}

/** Сколько SOL получим за amountA токенов (sell exact in) */
export function computeSellExactIn(
  amountA: bigint,
  virtualA: bigint,
  virtualB: bigint,
): bigint {
  if (virtualA === 0n || virtualB === 0n) throw new Error('Zero reserves');
  // amountB_out = virtualB * amountA / (virtualA + amountA)
  return (virtualB * amountA) / (virtualA + amountA);
}

// ─── Build buy instruction ───────────────────────────────────────────────────
//
// BuyExactIn: disc [250,234,13,123,213,156,19,236]
// Args: amountB (u64) = SOL to spend, minAmountA (u64) = min tokens out, shareFeeRate (u64) = 0

export function buildLaunchLabBuyInstruction(
  pool:             LaunchLabPoolState,
  poolId:           PublicKey,
  user:             PublicKey,
  userTokenAccountA: PublicKey,
  userTokenAccountB: PublicKey,
  amountB:          bigint,    // SOL lamports to spend
  minAmountA:       bigint,    // min tokens out (slippage)
  tokenProgramA:    PublicKey,
): TransactionInstruction {
  const auth            = getLaunchAuthPDA();
  const eventAuthority  = getLaunchEventAuthorityPDA();
  const platformFeeAuth = getPlatformFeeVaultAuthPDA();
  const creatorFeeAuth  = getCreatorFeeVaultAuthPDA();

  // Fee vault ATAs — платформа и креатор получают fees в mintB (wSOL)
  const platformClaimFeeVault = getAssociatedTokenAddressSync(
    pool.mintB, platformFeeAuth, true, TOKEN_PROGRAM_ID,
  );
  const creatorClaimFeeVault = getAssociatedTokenAddressSync(
    pool.mintB, creatorFeeAuth, true, TOKEN_PROGRAM_ID,
  );

  // Data: disc(8) + amountB(8) + minAmountA(8) + shareFeeRate(8) = 32 bytes
  const data = Buffer.concat([
    RAYDIUM_DISCRIMINATOR.LAUNCH_BUY_EXACT_IN,
    encodeU64(amountB),
    encodeU64(minAmountA),
    encodeU64(0n),  // shareFeeRate = 0
  ]);

  const keys = [
    { pubkey: user,               isSigner: true,  isWritable: true  }, //  0 owner
    { pubkey: auth,               isSigner: false, isWritable: false }, //  1 auth
    { pubkey: pool.configId,      isSigner: false, isWritable: false }, //  2 configId
    { pubkey: pool.platformId,    isSigner: false, isWritable: false }, //  3 platformId
    { pubkey: poolId,             isSigner: false, isWritable: true  }, //  4 poolId
    { pubkey: userTokenAccountA,  isSigner: false, isWritable: true  }, //  5 user token A ATA
    { pubkey: userTokenAccountB,  isSigner: false, isWritable: true  }, //  6 user wSOL ATA
    { pubkey: pool.vaultA,        isSigner: false, isWritable: true  }, //  7 pool vault A
    { pubkey: pool.vaultB,        isSigner: false, isWritable: true  }, //  8 pool vault B
    { pubkey: pool.mintA,         isSigner: false, isWritable: false }, //  9 mintA
    { pubkey: pool.mintB,         isSigner: false, isWritable: false }, // 10 mintB (wSOL)
    { pubkey: tokenProgramA,      isSigner: false, isWritable: false }, // 11 tokenProgramA
    { pubkey: TOKEN_PROGRAM_ID,   isSigner: false, isWritable: false }, // 12 tokenProgramB (wSOL = SPL)
    { pubkey: eventAuthority,     isSigner: false, isWritable: false }, // 13 CPI event authority
    { pubkey: LAUNCH_PROGRAM,     isSigner: false, isWritable: false }, // 14 self program
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 15
    { pubkey: platformClaimFeeVault,   isSigner: false, isWritable: true  }, // 16
    { pubkey: creatorClaimFeeVault,    isSigner: false, isWritable: true  }, // 17
  ];

  return new TransactionInstruction({ programId: LAUNCH_PROGRAM, keys, data });
}

// ─── Build sell instruction ──────────────────────────────────────────────────
//
// SellExactIn: disc [149,39,222,155,211,124,152,26]
// Args: amountA (u64) = tokens to sell, minAmountB (u64) = min SOL out, shareFeeRate (u64) = 0

export function buildLaunchLabSellInstruction(
  pool:             LaunchLabPoolState,
  poolId:           PublicKey,
  user:             PublicKey,
  userTokenAccountA: PublicKey,
  userTokenAccountB: PublicKey,
  amountA:          bigint,    // tokens to sell
  minAmountB:       bigint,    // min SOL out (slippage)
  tokenProgramA:    PublicKey,
): TransactionInstruction {
  const auth            = getLaunchAuthPDA();
  const eventAuthority  = getLaunchEventAuthorityPDA();
  const platformFeeAuth = getPlatformFeeVaultAuthPDA();
  const creatorFeeAuth  = getCreatorFeeVaultAuthPDA();

  const platformClaimFeeVault = getAssociatedTokenAddressSync(
    pool.mintB, platformFeeAuth, true, TOKEN_PROGRAM_ID,
  );
  const creatorClaimFeeVault = getAssociatedTokenAddressSync(
    pool.mintB, creatorFeeAuth, true, TOKEN_PROGRAM_ID,
  );

  const data = Buffer.concat([
    RAYDIUM_DISCRIMINATOR.LAUNCH_SELL_EXACT_IN,
    encodeU64(amountA),
    encodeU64(minAmountB),
    encodeU64(0n),  // shareFeeRate = 0
  ]);

  const keys = [
    { pubkey: user,               isSigner: true,  isWritable: true  }, //  0 owner
    { pubkey: auth,               isSigner: false, isWritable: false }, //  1 auth
    { pubkey: pool.configId,      isSigner: false, isWritable: false }, //  2 configId
    { pubkey: pool.platformId,    isSigner: false, isWritable: false }, //  3 platformId
    { pubkey: poolId,             isSigner: false, isWritable: true  }, //  4 poolId
    { pubkey: userTokenAccountA,  isSigner: false, isWritable: true  }, //  5 user token A ATA
    { pubkey: userTokenAccountB,  isSigner: false, isWritable: true  }, //  6 user wSOL ATA
    { pubkey: pool.vaultA,        isSigner: false, isWritable: true  }, //  7 pool vault A
    { pubkey: pool.vaultB,        isSigner: false, isWritable: true  }, //  8 pool vault B
    { pubkey: pool.mintA,         isSigner: false, isWritable: false }, //  9 mintA
    { pubkey: pool.mintB,         isSigner: false, isWritable: false }, // 10 mintB (wSOL)
    { pubkey: tokenProgramA,      isSigner: false, isWritable: false }, // 11 tokenProgramA
    { pubkey: TOKEN_PROGRAM_ID,   isSigner: false, isWritable: false }, // 12 tokenProgramB
    { pubkey: eventAuthority,     isSigner: false, isWritable: false }, // 13
    { pubkey: LAUNCH_PROGRAM,     isSigner: false, isWritable: false }, // 14
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 15
    { pubkey: platformClaimFeeVault,   isSigner: false, isWritable: true  }, // 16
    { pubkey: creatorClaimFeeVault,    isSigner: false, isWritable: true  }, // 17
  ];

  return new TransactionInstruction({ programId: LAUNCH_PROGRAM, keys, data });
}

// ─── Resolve pool ────────────────────────────────────────────────────────────

export async function resolveLaunchLabPool(
  connection: Connection,
  mintA:      PublicKey,
  poolHint?:  PublicKey,
): Promise<{ poolId: PublicKey; pool: LaunchLabPoolState }> {
  let poolId = poolHint ?? getLaunchPoolPDA(mintA);
  let poolAcc = await withRetry(() => withRpcLimit(() => connection.getAccountInfo(poolId)));

  // Fallback: getProgramAccounts по mintA offset
  if (!poolAcc) {
    const L = RAYDIUM_LAUNCH_POOL_LAYOUT;
    logger.debug(`LaunchLab pool PDA not found, trying getProgramAccounts for ${mintA.toBase58()}`);
    const accounts = await connection.getProgramAccounts(LAUNCH_PROGRAM, {
      commitment: 'confirmed',
      filters: [{ memcmp: { offset: L.MINT_A_OFFSET, bytes: mintA.toBase58() } }],
    });
    if (accounts.length > 0) {
      poolId  = accounts[0].pubkey;
      poolAcc = accounts[0].account;
    }
  }

  if (!poolAcc) throw new Error(`LaunchLab pool not found for ${mintA.toBase58()}`);

  const pool = parseLaunchLabPool(poolAcc.data);
  if (pool.status !== 0) {
    throw new Error(`LaunchLab pool migrated (status=${pool.status}), use CPMM/AMM v4 instead`);
  }

  return { poolId, pool };
}

// ─── buyTokenLaunchLab ───────────────────────────────────────────────────────

export async function buyTokenLaunchLab(
  connection:  Connection,
  mintA:       PublicKey,
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

  const { poolId, pool } = await resolveLaunchLabPool(connection, mintA, poolHint);

  // Determine token program for mintA
  const mintInfo = await withRpcLimit(() => connection.getAccountInfo(mintA));
  if (!mintInfo) throw new Error(`Mint account not found: ${mintA.toBase58()}`);
  const tokenProgramA = mintInfo.owner;

  const solIn       = BigInt(Math.floor(solAmount * 1e9));
  const expectedOut = computeBuyExactIn(solIn, pool.virtualA, pool.virtualB);
  const minOut      = (expectedOut * BigInt(10000 - slippageBps)) / 10000n;

  const userTokenA = getAssociatedTokenAddressSync(mintA, owner, false, tokenProgramA);
  const userWsolAta = getAssociatedTokenAddressSync(WSOL_MINT, owner, false, TOKEN_PROGRAM_ID);

  const buildTx = async (): Promise<VersionedTransaction> => {
    const { blockhash } = await getCachedBlockhashWithHeight();
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: config.compute.unitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
      // Create ATAs
      createAssociatedTokenAccountIdempotentInstruction(
        owner, userTokenA, owner, mintA, tokenProgramA,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        owner, userWsolAta, owner, WSOL_MINT, TOKEN_PROGRAM_ID,
      ),
      // Wrap SOL → wSOL
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: userWsolAta, lamports: solIn }),
      createSyncNativeInstruction(userWsolAta),
      // Buy
      buildLaunchLabBuyInstruction(
        pool, poolId, owner, userTokenA, userWsolAta, solIn, minOut, tokenProgramA,
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
    if (sim.value.err) throw new Error(`LaunchLab buy sim failed: ${JSON.stringify(sim.value.err)}`);
    logger.info('LaunchLab buy simulation OK (SIMULATE=true, skipping send)');
    return 'sim_' + Date.now();
  }

  const txId = await queueJitoSend(buildTx, payer, 0, true);
  logger.info(`LaunchLab buy sent: ${txId} (${solAmount} SOL → ~${Number(expectedOut)} tokens)`);
  return txId;
}

// ─── sellTokenLaunchLab ──────────────────────────────────────────────────────

export async function sellTokenLaunchLab(
  connection:      Connection,
  mintA:           PublicKey,
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

  const { poolId, pool } = await resolveLaunchLabPool(connection, mintA, poolHint);

  const mintInfo = await withRpcLimit(() => connection.getAccountInfo(mintA));
  if (!mintInfo) throw new Error(`Mint account not found: ${mintA.toBase58()}`);
  const tokenProgramA = mintInfo.owner;

  const expectedSol = computeSellExactIn(tokenAmountRaw, pool.virtualA, pool.virtualB);
  const minSolOut   = (expectedSol * BigInt(10000 - slippageBps)) / 10000n;

  const userTokenA  = getAssociatedTokenAddressSync(mintA, owner, false, tokenProgramA);
  const userWsolAta = getAssociatedTokenAddressSync(WSOL_MINT, owner, false, TOKEN_PROGRAM_ID);

  const buildTx = async (): Promise<VersionedTransaction> => {
    const { blockhash } = await getCachedBlockhashWithHeight();
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: config.compute.unitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
      // Ensure wSOL ATA exists for receiving proceeds
      createAssociatedTokenAccountIdempotentInstruction(
        owner, userWsolAta, owner, WSOL_MINT, TOKEN_PROGRAM_ID,
      ),
      // Sell
      buildLaunchLabSellInstruction(
        pool, poolId, owner, userTokenA, userWsolAta, tokenAmountRaw, minSolOut, tokenProgramA,
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
    if (sim.value.err) throw new Error(`LaunchLab sell sim failed: ${JSON.stringify(sim.value.err)}`);
    logger.info('LaunchLab sell simulation OK (SIMULATE=true, skipping send)');
    return 'sim_' + Date.now();
  }

  if (directRpc) {
    const tx  = await buildTx();
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
    logger.info(`LaunchLab sell via direct RPC: ${sig}`);
    return sig;
  }

  const txId = await queueJitoSend(buildTx, payer, config.jito.maxRetries, false);
  logger.info(`LaunchLab sell sent: ${txId} (~${Number(expectedSol) / 1e9} SOL)`);
  return txId;
}
