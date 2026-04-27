import {
  Connection, Keypair, PublicKey,
  VersionedTransaction, TransactionMessage,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { config } from '../config';
import { logger } from '../utils/logger';
import { logEvent } from '../utils/event-logger';
import { getCachedBlockhash } from '../infra/blockhash-cache';
import { getCachedPriorityFee } from '../infra/priority-fee-cache';

import {
  buildBuyInstruction as buildPumpBuyIx,
  getBondingCurvePDA, getBondingCurveV2PDA, getVaultPDA,
  getCreatorVaultPDA, getFeeRecipient,
  isMayhemToken, isCashbackEnabled, getCreatorFromCurveData,
} from '../trading/buy';
import { buildSellInstruction as buildPumpSellIx } from '../trading/sell';
import {
  resolveSwapAccounts, buildBuyInstruction as buildPSwapBuyIx,
  buildSellInstruction as buildPSwapSellIx, computeAmountOut,
} from '../trading/pumpSwap';
import {
  resolveCpmmPool, buildCpmmSwapBaseInInstruction, computeSwapOut as cpmmSwapOut,
} from '../trading/raydiumCpmm';
import {
  resolveAmmV4Pool, buildAmmV4SwapBaseInInstruction, computeSwapOut as ammV4SwapOut,
} from '../trading/raydiumAmmV4';
import {
  resolveLaunchLabPool, buildLaunchLabBuyInstruction, buildLaunchLabSellInstruction,
  computeBuyExactIn as launchBuyCalc,
} from '../trading/raydiumLaunchLab';

const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

export interface TxBuildResult {
  success: boolean;
  error?: string;
  diagnostics: Record<string, any>;
  tx?: VersionedTransaction;
}

export interface SimulationResult {
  success: boolean;
  error?: string;
  unitsConsumed?: number;
  logs?: string[];
}

export async function buildBuyTransaction(
  connection: Connection,
  mint: PublicKey,
  payer: Keypair,
  protocol: string,
  solAmount: number,
  slippageBps: number,
): Promise<TxBuildResult> {
  const diagnostics: Record<string, any> = {
    protocol, action: 'buy', shadow: true,
    mint: mint.toBase58(), solAmount, slippageBps,
  };

  try {
    switch (protocol) {
      case 'pump.fun':
        return await buildPumpFunBuyTx(connection, mint, payer, solAmount, slippageBps, diagnostics);
      case 'pumpswap':
        return await buildPumpSwapBuyTx(connection, mint, payer, solAmount, slippageBps, diagnostics);
      case 'raydium-cpmm':
        return await buildCpmmBuyTx(connection, mint, payer, solAmount, slippageBps, diagnostics);
      case 'raydium-ammv4':
        return await buildAmmV4BuyTx(connection, mint, payer, solAmount, slippageBps, diagnostics);
      case 'raydium-launch':
        return await buildLaunchLabBuyTx(connection, mint, payer, solAmount, slippageBps, diagnostics);
      default:
        return { success: false, error: `unknown protocol: ${protocol}`, diagnostics };
    }
  } catch (err) {
    diagnostics.error = String(err);
    return { success: false, error: String(err), diagnostics };
  }
}

export async function buildSellTransaction(
  connection: Connection,
  mint: PublicKey,
  payer: Keypair,
  protocol: string,
  tokenAmountRaw: bigint,
  slippageBps: number,
): Promise<TxBuildResult> {
  const diagnostics: Record<string, any> = {
    protocol, action: 'sell', shadow: true,
    mint: mint.toBase58(), tokenAmountRaw: tokenAmountRaw.toString(), slippageBps,
  };

  try {
    switch (protocol) {
      case 'pump.fun':
        return await buildPumpFunSellTx(connection, mint, payer, tokenAmountRaw, slippageBps, diagnostics);
      case 'pumpswap':
        return await buildPumpSwapSellTx(connection, mint, payer, tokenAmountRaw, slippageBps, diagnostics);
      case 'raydium-cpmm':
        return await buildCpmmSellTx(connection, mint, payer, tokenAmountRaw, slippageBps, diagnostics);
      case 'raydium-ammv4':
        return await buildAmmV4SellTx(connection, mint, payer, tokenAmountRaw, slippageBps, diagnostics);
      case 'raydium-launch':
        return await buildLaunchLabSellTx(connection, mint, payer, tokenAmountRaw, slippageBps, diagnostics);
      default:
        return { success: false, error: `unknown protocol: ${protocol}`, diagnostics };
    }
  } catch (err) {
    diagnostics.error = String(err);
    return { success: false, error: String(err), diagnostics };
  }
}

export async function simulateTx(
  connection: Connection,
  tx: VersionedTransaction,
): Promise<SimulationResult> {
  try {
    const sim = await connection.simulateTransaction(tx, { sigVerify: false });
    return {
      success: !sim.value.err,
      error: sim.value.err ? JSON.stringify(sim.value.err) : undefined,
      unitsConsumed: sim.value.unitsConsumed ?? undefined,
      logs: sim.value.logs ?? undefined,
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function wrapTx(
  payer: Keypair,
  instructions: any[],
): Promise<VersionedTransaction> {
  const blockhash = await getCachedBlockhash('shadow');
  const priorityFee = getCachedPriorityFee('shadow');
  const allIx = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: config.compute.unitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
    ...instructions,
  ];
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: allIx,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  return tx;
}

// ── Pump.fun ─────────────────────────────────────────────────────────────────

async function buildPumpFunBuyTx(
  connection: Connection, mint: PublicKey, payer: Keypair,
  solAmount: number, slippageBps: number, diagnostics: Record<string, any>,
): Promise<TxBuildResult> {
  const bondingCurve = getBondingCurvePDA(mint);
  const curveData = await connection.getAccountInfo(bondingCurve);
  if (!curveData) return { success: false, error: 'bonding curve not found', diagnostics };

  const virtualTokenReserves = curveData.data.readBigUInt64LE(8);
  const virtualSolReserves = curveData.data.readBigUInt64LE(16);
  const creator = getCreatorFromCurveData(curveData.data);
  const mayhem = isMayhemToken(curveData.data);
  const cashback = isCashbackEnabled(curveData.data);

  const feeRecipient = await getFeeRecipient(connection);
  const mintInfo = await connection.getAccountInfo(mint);
  const tokenProgramId = mintInfo?.owner ?? TOKEN_PROGRAM_ID;

  const solLamports = BigInt(Math.floor(solAmount * 1e9));
  const expectedTokens = (solLamports * virtualTokenReserves) / (virtualSolReserves + solLamports);
  const minTokensOut = expectedTokens * BigInt(10000 - slippageBps) / 10000n;

  const userAta = getAssociatedTokenAddressSync(mint, payer.publicKey, false, tokenProgramId);

  diagnostics.bondingCurve = bondingCurve.toBase58();
  diagnostics.virtualSolReserves = virtualSolReserves.toString();
  diagnostics.virtualTokenReserves = virtualTokenReserves.toString();
  diagnostics.creator = creator.toBase58();
  diagnostics.isMayhem = mayhem;
  diagnostics.isCashback = cashback;
  diagnostics.expectedTokens = expectedTokens.toString();
  diagnostics.minTokensOut = minTokensOut.toString();

  const eventAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
  )[0];

  const createATAix = createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey, userAta, payer.publicKey, mint, tokenProgramId,
  );
  const buyIx = buildPumpBuyIx(
    mint, payer.publicKey, creator, feeRecipient, eventAuthority,
    solLamports, minTokensOut, tokenProgramId, userAta, mayhem,
  );

  const tx = await wrapTx(payer, [createATAix, buyIx]);
  return { success: true, diagnostics, tx };
}

async function buildPumpFunSellTx(
  connection: Connection, mint: PublicKey, payer: Keypair,
  tokenAmountRaw: bigint, slippageBps: number, diagnostics: Record<string, any>,
): Promise<TxBuildResult> {
  const bondingCurve = getBondingCurvePDA(mint);
  const curveData = await connection.getAccountInfo(bondingCurve);
  if (!curveData) return { success: false, error: 'bonding curve not found', diagnostics };

  const virtualTokenReserves = curveData.data.readBigUInt64LE(8);
  const virtualSolReserves = curveData.data.readBigUInt64LE(16);
  const creator = getCreatorFromCurveData(curveData.data);
  const mayhem = isMayhemToken(curveData.data);
  const cashback = isCashbackEnabled(curveData.data);

  const feeRecipient = await getFeeRecipient(connection);
  const mintInfo = await connection.getAccountInfo(mint);
  const tokenProgramId = mintInfo?.owner ?? TOKEN_PROGRAM_ID;

  const expectedSol = (tokenAmountRaw * virtualSolReserves) / (virtualTokenReserves + tokenAmountRaw);
  const minSolOut = expectedSol * BigInt(10000 - slippageBps) / 10000n;

  const userAta = getAssociatedTokenAddressSync(mint, payer.publicKey, false, tokenProgramId);

  diagnostics.virtualSolReserves = virtualSolReserves.toString();
  diagnostics.virtualTokenReserves = virtualTokenReserves.toString();
  diagnostics.expectedSol = expectedSol.toString();
  diagnostics.minSolOut = minSolOut.toString();

  const eventAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
  )[0];

  const sellIx = buildPumpSellIx(
    mint, payer.publicKey, creator, feeRecipient, eventAuthority,
    tokenAmountRaw, minSolOut, tokenProgramId, userAta, mayhem, cashback,
  );

  const tx = await wrapTx(payer, [sellIx]);
  return { success: true, diagnostics, tx };
}

// ── PumpSwap ─────────────────────────────────────────────────────────────────

async function buildPumpSwapBuyTx(
  connection: Connection, mint: PublicKey, payer: Keypair,
  solAmount: number, slippageBps: number, diagnostics: Record<string, any>,
): Promise<TxBuildResult> {
  const { accs, poolState, tokenReserve, solReserve } =
    await resolveSwapAccounts(connection, mint, payer.publicKey);

  const solLamports = BigInt(Math.floor(solAmount * 1e9));
  const expectedOut = computeAmountOut(solLamports, solReserve, tokenReserve);
  const minOut = expectedOut * BigInt(10000 - slippageBps) / 10000n;

  diagnostics.pool = accs.pool.toBase58();
  diagnostics.tokenReserve = tokenReserve.toString();
  diagnostics.solReserve = solReserve.toString();
  diagnostics.expectedOut = expectedOut.toString();
  diagnostics.isCashbackCoin = poolState.isCashbackCoin;

  const createBaseAta = createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey, accs.userBaseTokenAccount, payer.publicKey, accs.baseMint, accs.baseTokenProgram,
  );
  const createQuoteAta = createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey, accs.userQuoteTokenAccount, payer.publicKey, accs.quoteMint, accs.quoteTokenProgram,
  );
  const buyIx = buildPSwapBuyIx(accs, expectedOut, solLamports, payer.publicKey, poolState.isCashbackCoin);

  const tx = await wrapTx(payer, [createBaseAta, createQuoteAta, buyIx]);
  return { success: true, diagnostics, tx };
}

async function buildPumpSwapSellTx(
  connection: Connection, mint: PublicKey, payer: Keypair,
  tokenAmountRaw: bigint, slippageBps: number, diagnostics: Record<string, any>,
): Promise<TxBuildResult> {
  const { accs, poolState, tokenReserve, solReserve } =
    await resolveSwapAccounts(connection, mint, payer.publicKey);

  const expectedSolOut = computeAmountOut(tokenAmountRaw, tokenReserve, solReserve);
  const minSolOut = expectedSolOut * BigInt(10000 - slippageBps) / 10000n;

  diagnostics.pool = accs.pool.toBase58();
  diagnostics.tokenReserve = tokenReserve.toString();
  diagnostics.solReserve = solReserve.toString();
  diagnostics.expectedSolOut = expectedSolOut.toString();

  const sellIx = buildPSwapSellIx(accs, tokenAmountRaw, minSolOut, payer.publicKey, poolState.isCashbackCoin);

  const tx = await wrapTx(payer, [sellIx]);
  return { success: true, diagnostics, tx };
}

// ── Raydium CPMM ─────────────────────────────────────────────────────────────

async function buildCpmmBuyTx(
  connection: Connection, mint: PublicKey, payer: Keypair,
  solAmount: number, slippageBps: number, diagnostics: Record<string, any>,
): Promise<TxBuildResult> {
  const { poolId, pool, tokenReserve, solReserve, isBaseToken } =
    await resolveCpmmPool(connection, mint);

  const solLamports = BigInt(Math.floor(solAmount * 1e9));
  const expectedOut = cpmmSwapOut(solLamports, solReserve, tokenReserve);
  const minOut = expectedOut * BigInt(10000 - slippageBps) / 10000n;

  const inputMint = WSOL_MINT;
  const outputMint = mint;
  const inputVault = isBaseToken ? pool.vaultB : pool.vaultA;
  const outputVault = isBaseToken ? pool.vaultA : pool.vaultB;
  const inputTokenProgram = TOKEN_PROGRAM_ID;
  const outputTokenProgram = isBaseToken ? pool.mintProgramA : pool.mintProgramB;

  const userInputAta = getAssociatedTokenAddressSync(inputMint, payer.publicKey, false, inputTokenProgram);
  const userOutputAta = getAssociatedTokenAddressSync(outputMint, payer.publicKey, false, outputTokenProgram);

  diagnostics.poolId = poolId.toBase58();
  diagnostics.isBaseToken = isBaseToken;
  diagnostics.tokenReserve = tokenReserve.toString();
  diagnostics.solReserve = solReserve.toString();
  diagnostics.expectedOut = expectedOut.toString();

  const createOutputAta = createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey, userOutputAta, payer.publicKey, outputMint, outputTokenProgram,
  );
  const swapIx = buildCpmmSwapBaseInInstruction(
    pool, poolId, payer.publicKey,
    userInputAta, userOutputAta, inputVault, outputVault,
    inputMint, outputMint, inputTokenProgram, outputTokenProgram,
    solLamports, minOut,
  );

  const tx = await wrapTx(payer, [createOutputAta, swapIx]);
  return { success: true, diagnostics, tx };
}

async function buildCpmmSellTx(
  connection: Connection, mint: PublicKey, payer: Keypair,
  tokenAmountRaw: bigint, slippageBps: number, diagnostics: Record<string, any>,
): Promise<TxBuildResult> {
  const { poolId, pool, tokenReserve, solReserve, isBaseToken } =
    await resolveCpmmPool(connection, mint);

  const expectedSolOut = cpmmSwapOut(tokenAmountRaw, tokenReserve, solReserve);
  const minSolOut = expectedSolOut * BigInt(10000 - slippageBps) / 10000n;

  const inputMint = mint;
  const outputMint = WSOL_MINT;
  const inputVault = isBaseToken ? pool.vaultA : pool.vaultB;
  const outputVault = isBaseToken ? pool.vaultB : pool.vaultA;
  const inputTokenProgram = isBaseToken ? pool.mintProgramA : pool.mintProgramB;
  const outputTokenProgram = TOKEN_PROGRAM_ID;

  const userInputAta = getAssociatedTokenAddressSync(inputMint, payer.publicKey, false, inputTokenProgram);
  const userOutputAta = getAssociatedTokenAddressSync(outputMint, payer.publicKey, false, outputTokenProgram);

  diagnostics.expectedSolOut = expectedSolOut.toString();
  diagnostics.minSolOut = minSolOut.toString();

  const swapIx = buildCpmmSwapBaseInInstruction(
    pool, poolId, payer.publicKey,
    userInputAta, userOutputAta, inputVault, outputVault,
    inputMint, outputMint, inputTokenProgram, outputTokenProgram,
    tokenAmountRaw, minSolOut,
  );

  const tx = await wrapTx(payer, [swapIx]);
  return { success: true, diagnostics, tx };
}

// ── Raydium AMM v4 ──────────────────────────────────────────────────────────

async function buildAmmV4BuyTx(
  connection: Connection, mint: PublicKey, payer: Keypair,
  solAmount: number, slippageBps: number, diagnostics: Record<string, any>,
): Promise<TxBuildResult> {
  const { poolId, pool, tokenReserve, solReserve, isBaseMint } =
    await resolveAmmV4Pool(connection, mint);

  const solLamports = BigInt(Math.floor(solAmount * 1e9));
  const expectedOut = ammV4SwapOut(solLamports, solReserve, tokenReserve, pool.tradeFeeNum, pool.tradeFeeDen);
  const minOut = expectedOut * BigInt(10000 - slippageBps) / 10000n;

  const userInputAta = getAssociatedTokenAddressSync(WSOL_MINT, payer.publicKey);
  const userOutputAta = getAssociatedTokenAddressSync(mint, payer.publicKey);

  diagnostics.poolId = poolId.toBase58();
  diagnostics.tokenReserve = tokenReserve.toString();
  diagnostics.solReserve = solReserve.toString();
  diagnostics.expectedOut = expectedOut.toString();

  const createOutputAta = createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey, userOutputAta, payer.publicKey, mint,
  );
  const swapIx = buildAmmV4SwapBaseInInstruction(
    pool, poolId, payer.publicKey, userInputAta, userOutputAta,
    solLamports, minOut,
  );

  const tx = await wrapTx(payer, [createOutputAta, swapIx]);
  return { success: true, diagnostics, tx };
}

async function buildAmmV4SellTx(
  connection: Connection, mint: PublicKey, payer: Keypair,
  tokenAmountRaw: bigint, slippageBps: number, diagnostics: Record<string, any>,
): Promise<TxBuildResult> {
  const { poolId, pool, tokenReserve, solReserve } =
    await resolveAmmV4Pool(connection, mint);

  const expectedSolOut = ammV4SwapOut(tokenAmountRaw, tokenReserve, solReserve, pool.tradeFeeNum, pool.tradeFeeDen);
  const minSolOut = expectedSolOut * BigInt(10000 - slippageBps) / 10000n;

  const userInputAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
  const userOutputAta = getAssociatedTokenAddressSync(WSOL_MINT, payer.publicKey);

  diagnostics.expectedSolOut = expectedSolOut.toString();
  diagnostics.minSolOut = minSolOut.toString();

  const swapIx = buildAmmV4SwapBaseInInstruction(
    pool, poolId, payer.publicKey, userInputAta, userOutputAta,
    tokenAmountRaw, minSolOut,
  );

  const tx = await wrapTx(payer, [swapIx]);
  return { success: true, diagnostics, tx };
}

// ── Raydium LaunchLab ────────────────────────────────────────────────────────

async function buildLaunchLabBuyTx(
  connection: Connection, mint: PublicKey, payer: Keypair,
  solAmount: number, slippageBps: number, diagnostics: Record<string, any>,
): Promise<TxBuildResult> {
  const { poolId, pool } = await resolveLaunchLabPool(connection, mint);

  const solLamports = BigInt(Math.floor(solAmount * 1e9));
  const expectedTokens = launchBuyCalc(solLamports, pool.virtualA, pool.virtualB);
  const minTokens = expectedTokens * BigInt(10000 - slippageBps) / 10000n;

  const mintInfo = await connection.getAccountInfo(mint);
  const tokenProgramA = mintInfo?.owner ?? TOKEN_PROGRAM_ID;

  const userTokenAccountA = getAssociatedTokenAddressSync(mint, payer.publicKey, false, tokenProgramA);
  const userTokenAccountB = getAssociatedTokenAddressSync(WSOL_MINT, payer.publicKey);

  diagnostics.poolId = poolId.toBase58();
  diagnostics.virtualA = pool.virtualA.toString();
  diagnostics.virtualB = pool.virtualB.toString();
  diagnostics.expectedTokens = expectedTokens.toString();
  diagnostics.migrateType = pool.migrateType;

  const createAta = createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey, userTokenAccountA, payer.publicKey, mint, tokenProgramA,
  );
  const buyIx = buildLaunchLabBuyInstruction(
    pool, poolId, payer.publicKey,
    userTokenAccountA, userTokenAccountB,
    solLamports, minTokens, tokenProgramA,
  );

  const tx = await wrapTx(payer, [createAta, buyIx]);
  return { success: true, diagnostics, tx };
}

async function buildLaunchLabSellTx(
  connection: Connection, mint: PublicKey, payer: Keypair,
  tokenAmountRaw: bigint, slippageBps: number, diagnostics: Record<string, any>,
): Promise<TxBuildResult> {
  const { poolId, pool } = await resolveLaunchLabPool(connection, mint);

  const expectedSol = (tokenAmountRaw * pool.virtualB) / (pool.virtualA + tokenAmountRaw);
  const minSolOut = expectedSol * BigInt(10000 - slippageBps) / 10000n;

  const mintInfo = await connection.getAccountInfo(mint);
  const tokenProgramA = mintInfo?.owner ?? TOKEN_PROGRAM_ID;

  const userTokenAccountA = getAssociatedTokenAddressSync(mint, payer.publicKey, false, tokenProgramA);
  const userTokenAccountB = getAssociatedTokenAddressSync(WSOL_MINT, payer.publicKey);

  diagnostics.expectedSol = expectedSol.toString();
  diagnostics.minSolOut = minSolOut.toString();

  const sellIx = buildLaunchLabSellInstruction(
    pool, poolId, payer.publicKey,
    userTokenAccountA, userTokenAccountB,
    tokenAmountRaw, minSolOut, tokenProgramA,
  );

  const tx = await wrapTx(payer, [sellIx]);
  return { success: true, diagnostics, tx };
}
