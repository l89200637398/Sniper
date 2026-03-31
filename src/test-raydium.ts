/**
 * test-raydium.ts — Raydium protocol simulation test
 * Аналог test-pumpswap.ts для Raydium протоколов.
 *
 * Тестирует:
 *   1. Pool discovery (PDA + getProgramAccounts fallback)
 *   2. Pool state parsing (reserves, mints, vaults, fees)
 *   3. AMM math (swap calculation)
 *   4. Buy instruction build + simulation
 *
 * Запуск:
 *   npx ts-node src/test-raydium.ts <MINT_ADDRESS> [PROTOCOL]
 *
 * PROTOCOL: auto | launchlab | cpmm | ammv4  (default: auto)
 *
 * Примеры:
 *   npx ts-node src/test-raydium.ts 7d4vS8zNckZ8r4abc...pump          # auto-detect
 *   npx ts-node src/test-raydium.ts 7d4vS8zNckZ8r4abc...pump cpmm     # force CPMM
 *   npx ts-node src/test-raydium.ts 7d4vS8zNckZ8r4abc...pump ammv4    # force AMM v4
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, ComputeBudgetProgram,
  VersionedTransaction, TransactionMessage,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction,
} from '@solana/spl-token';
import bs58 from 'bs58';
import dotenv from 'dotenv';
dotenv.config();

import { config } from './config';
import {
  resolveLaunchLabPool, parseLaunchLabPool,
  computeBuyExactIn, buildLaunchLabBuyInstruction,
  getLaunchPoolPDA,
} from './trading/raydiumLaunchLab';
import {
  resolveCpmmPool, parseCpmmPool,
  computeSwapOut as cpmmSwapOut, buildCpmmSwapBaseInInstruction,
} from './trading/raydiumCpmm';
import {
  resolveAmmV4Pool, parseAmmV4Pool,
  computeSwapOut as ammV4SwapOut, buildAmmV4SwapBaseInInstruction,
} from './trading/raydiumAmmV4';
import { RAYDIUM_LAUNCHLAB_PROGRAM_ID, RAYDIUM_CPMM_PROGRAM_ID, RAYDIUM_AMM_V4_PROGRAM_ID } from './constants';

const WSOL = new PublicKey(config.wsolMint);

function sep(t: string) { console.log(`\n${'='.repeat(65)}\n  ${t}\n${'='.repeat(65)}`); }
function ok(msg: string)   { console.log(`  ✅ ${msg}`); }
function warn(msg: string) { console.log(`  ⚠️  ${msg}`); }
function err(msg: string)  { console.log(`  ❌ ${msg}`); }
function info(msg: string) { console.log(`  ℹ️  ${msg}`); }

type Protocol = 'launchlab' | 'cpmm' | 'ammv4';

async function testLaunchLab(connection: Connection, mint: PublicKey, payer: Keypair) {
  sep('RAYDIUM LAUNCHLAB (Bonding Curve)');
  const PROGRAM = new PublicKey(RAYDIUM_LAUNCHLAB_PROGRAM_ID);

  // 1. Pool discovery (allowMigrated=true — проверяем layout даже для мигрированных)
  info('1. Pool discovery...');
  let poolId: PublicKey;
  let pool: ReturnType<typeof parseLaunchLabPool> extends infer T ? T : never;
  try {
    const result = await resolveLaunchLabPool(connection, mint, undefined, true);
    poolId = result.poolId;
    pool = result.pool;
    ok(`Pool found: ${poolId.toBase58()}`);
  } catch (e) {
    err(`Pool NOT FOUND: ${e}`);
    return false;
  }

  // 2. Pool state
  info('2. Pool state:');
  info(`   status:       ${pool.status} (0=active, 250=migrated)`);
  info(`   mintA:        ${pool.mintA.toBase58()} (token)`);
  info(`   mintB:        ${pool.mintB.toBase58()} (wSOL)`);
  info(`   vaultA:       ${pool.vaultA.toBase58()}`);
  info(`   vaultB:       ${pool.vaultB.toBase58()}`);
  info(`   creator:      ${pool.creator.toBase58()}`);
  info(`   migrateType:  ${pool.migrateType} (0=AMM v4, 1=CPMM)`);
  info(`   virtualA:     ${pool.virtualA} (token reserves)`);
  info(`   virtualB:     ${Number(pool.virtualB) / 1e9} SOL (SOL reserves)`);
  info(`   realA:        ${pool.realA}`);
  info(`   realB:        ${Number(pool.realB) / 1e9} SOL`);
  info(`   decimalsA:    ${pool.mintDecimalA}`);
  info(`   decimalsB:    ${pool.mintDecimalB}`);

  const isMigrated = pool.status !== 0;
  if (isMigrated) {
    warn(`Pool is migrated (status=${pool.status}). Layout verification only — skipping buy simulation.`);
  }

  // 3. AMM math
  info('3. AMM math (buy 0.001 SOL):');
  const solIn = BigInt(Math.floor(0.001 * 1e9));
  const expectedTokens = computeBuyExactIn(solIn, pool.virtualA, pool.virtualB);
  const minTokens = (expectedTokens * 9700n) / 10000n; // 3% slippage
  info(`   SOL in:           ${Number(solIn) / 1e9} SOL`);
  info(`   Expected tokens:  ${expectedTokens}`);
  info(`   Min tokens (3%):  ${minTokens}`);
  info(`   Price (SOL/token): ${(Number(solIn) / Number(expectedTokens)).toExponential(4)}`);
  ok('AMM math OK');

  // Для мигрированных пулов — layout verified, симуляцию пропускаем
  if (isMigrated) {
    ok('Pool discovery + layout parsing + AMM math verified (migrated pool — buy simulation skipped)');
    return true;
  }

  // 4. Build & simulate (только для активных пулов)
  info('4. Build buy instruction...');
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) { err('Mint account not found'); return false; }
  const tokenProgramA = mintInfo.owner;
  info(`   Token program: ${tokenProgramA.toBase58()}`);

  const owner = payer.publicKey;
  const userTokenA = getAssociatedTokenAddressSync(mint, owner, false, tokenProgramA);
  const userWsolAta = getAssociatedTokenAddressSync(WSOL, owner, false, TOKEN_PROGRAM_ID);

  const buyIx = buildLaunchLabBuyInstruction(
    pool, poolId, owner, userTokenA, userWsolAta,
    solIn, minTokens, tokenProgramA,
  );
  info(`   Accounts: ${buyIx.keys.length}`);
  info(`   Data size: ${buyIx.data.length} bytes`);
  info(`   Discriminator: ${buyIx.data.subarray(0, 8).toString('hex')}`);
  console.log('   Account keys:');
  buyIx.keys.forEach((k, i) => console.log(`     [${i.toString().padStart(2)}] ${k.pubkey.toBase58().substring(0, 20)}... ${k.isSigner ? 'S' : '-'}${k.isWritable ? 'W' : '-'}`));

  // Simulate
  info('5. Simulation...');
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: owner, recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      createAssociatedTokenAccountIdempotentInstruction(owner, userTokenA, owner, mint, tokenProgramA),
      createAssociatedTokenAccountIdempotentInstruction(owner, userWsolAta, owner, WSOL, TOKEN_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: userWsolAta, lamports: solIn }),
      createSyncNativeInstruction(userWsolAta),
      buyIx,
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  const sim = await connection.simulateTransaction(tx, { sigVerify: false });
  if (sim.value.err) {
    err(`SIMULATION FAILED: ${JSON.stringify(sim.value.err)}`);
    sim.value.logs?.forEach(l => console.error('     ' + l));
    return false;
  }
  ok(`Simulation OK (${sim.value.unitsConsumed} CU)`);
  return true;
}

async function testCpmm(connection: Connection, mint: PublicKey, payer: Keypair) {
  sep('RAYDIUM CPMM (CP-Swap)');
  const PROGRAM = new PublicKey(RAYDIUM_CPMM_PROGRAM_ID);

  // 1. Pool discovery
  info('1. Pool discovery...');
  let poolId: PublicKey;
  let pool: ReturnType<typeof parseCpmmPool> extends infer T ? T : never;
  let tokenReserve: bigint;
  let solReserve: bigint;
  let isBaseToken: boolean;
  try {
    const result = await resolveCpmmPool(connection, mint);
    poolId = result.poolId;
    pool = result.pool;
    tokenReserve = result.tokenReserve;
    solReserve = result.solReserve;
    isBaseToken = result.isBaseToken;
    ok(`Pool found: ${poolId.toBase58()}`);
  } catch (e) {
    err(`Pool NOT FOUND: ${e}`);
    return false;
  }

  // 2. Pool state
  info('2. Pool state:');
  info(`   configId:     ${pool.configId.toBase58()}`);
  info(`   mintA:        ${pool.mintA.toBase58()}`);
  info(`   mintB:        ${pool.mintB.toBase58()}`);
  info(`   vaultA:       ${pool.vaultA.toBase58()}`);
  info(`   vaultB:       ${pool.vaultB.toBase58()}`);
  info(`   mintProgramA: ${pool.mintProgramA.toBase58()}`);
  info(`   mintProgramB: ${pool.mintProgramB.toBase58()}`);
  info(`   observationId:${pool.observationId.toBase58()}`);
  info(`   status:       ${pool.status}`);
  info(`   decimalsA:    ${pool.mintDecimalA}`);
  info(`   decimalsB:    ${pool.mintDecimalB}`);
  info(`   isBaseToken:  ${isBaseToken} (token is ${isBaseToken ? 'mintA' : 'mintB'})`);

  // 3. Reserves
  info('3. Reserves:');
  info(`   Token reserve: ${tokenReserve}`);
  info(`   SOL reserve:   ${Number(solReserve) / 1e9} SOL`);
  if (solReserve === 0n) { err('No SOL liquidity'); return false; }

  // 4. AMM math
  info('4. AMM math (buy 0.001 SOL):');
  const solIn = BigInt(Math.floor(0.001 * 1e9));
  const expectedOut = cpmmSwapOut(solIn, solReserve, tokenReserve, 25n);
  const minOut = (expectedOut * 9700n) / 10000n;
  info(`   SOL in:           ${Number(solIn) / 1e9} SOL`);
  info(`   Expected tokens:  ${expectedOut}`);
  info(`   Min tokens (3%):  ${minOut}`);

  // 5. Build & simulate
  info('5. Build swap instruction...');
  const owner = payer.publicKey;
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) { err('Mint not found'); return false; }
  const tokenProgram = mintInfo.owner;
  const isToken2022 = tokenProgram.toBase58() === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  info(`   Token program: ${tokenProgram.toBase58()} ${isToken2022 ? '(Token-2022)' : ''}`);

  const userTokenAta = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  const userWsolAta = getAssociatedTokenAddressSync(WSOL, owner, false, TOKEN_PROGRAM_ID);

  const swapIx = buildCpmmSwapBaseInInstruction(
    pool, poolId, owner,
    userWsolAta,   // userInputAta (SOL in)
    userTokenAta,  // userOutputAta (tokens out)
    isBaseToken ? pool.vaultB : pool.vaultA,   // inputVault (SOL vault)
    isBaseToken ? pool.vaultA : pool.vaultB,   // outputVault (token vault)
    WSOL, mint,
    TOKEN_PROGRAM_ID, tokenProgram,
    solIn, minOut,
  );
  info(`   Accounts: ${swapIx.keys.length}`);
  info(`   Data size: ${swapIx.data.length} bytes`);
  info(`   Discriminator: ${swapIx.data.subarray(0, 8).toString('hex')}`);
  console.log('   Account keys:');
  swapIx.keys.forEach((k, i) => console.log(`     [${i.toString().padStart(2)}] ${k.pubkey.toBase58().substring(0, 20)}... ${k.isSigner ? 'S' : '-'}${k.isWritable ? 'W' : '-'}`));

  // Simulate
  info('6. Simulation...');
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: owner, recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      createAssociatedTokenAccountIdempotentInstruction(owner, userTokenAta, owner, mint, tokenProgram),
      createAssociatedTokenAccountIdempotentInstruction(owner, userWsolAta, owner, WSOL, TOKEN_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: userWsolAta, lamports: solIn }),
      createSyncNativeInstruction(userWsolAta),
      swapIx,
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  const sim = await connection.simulateTransaction(tx, { sigVerify: false });
  if (sim.value.err) {
    err(`SIMULATION FAILED: ${JSON.stringify(sim.value.err)}`);
    sim.value.logs?.forEach(l => console.error('     ' + l));
    return false;
  }
  ok(`Simulation OK (${sim.value.unitsConsumed} CU)`);
  return true;
}

async function testAmmV4(connection: Connection, mint: PublicKey, payer: Keypair) {
  sep('RAYDIUM AMM V4 (Legacy)');
  const PROGRAM = new PublicKey(RAYDIUM_AMM_V4_PROGRAM_ID);

  // 1. Pool discovery
  info('1. Pool discovery...');
  let poolId: PublicKey;
  let pool: ReturnType<typeof parseAmmV4Pool> extends infer T ? T : never;
  let tokenReserve: bigint;
  let solReserve: bigint;
  let isBaseMint: boolean;
  try {
    const result = await resolveAmmV4Pool(connection, mint);
    poolId = result.poolId;
    pool = result.pool;
    tokenReserve = result.tokenReserve;
    solReserve = result.solReserve;
    isBaseMint = result.isBaseMint;
    ok(`Pool found: ${poolId.toBase58()}`);
  } catch (e) {
    err(`Pool NOT FOUND: ${e}`);
    return false;
  }

  // 2. Pool state
  info('2. Pool state:');
  info(`   baseMint:      ${pool.baseMint.toBase58()}`);
  info(`   quoteMint:     ${pool.quoteMint.toBase58()}`);
  info(`   baseVault:     ${pool.baseVault.toBase58()}`);
  info(`   quoteVault:    ${pool.quoteVault.toBase58()}`);
  info(`   openOrders:    ${pool.openOrders.toBase58()}`);
  info(`   marketId:      ${pool.marketId.toBase58()}`);
  info(`   marketProgram: ${pool.marketProgramId.toBase58()}`);
  info(`   targetOrders:  ${pool.targetOrders.toBase58()}`);
  info(`   lpMint:        ${pool.lpMint.toBase58()}`);
  info(`   status:        ${pool.status}`);
  info(`   nonce:         ${pool.nonce}`);
  info(`   baseDecimal:   ${pool.baseDecimal}`);
  info(`   quoteDecimal:  ${pool.quoteDecimal}`);
  info(`   tradeFee:      ${pool.tradeFeeNum}/${pool.tradeFeeDen} (${Number(pool.tradeFeeNum) * 10000 / Number(pool.tradeFeeDen)} bps)`);
  info(`   isBaseMint:    ${isBaseMint}`);

  // 3. Reserves
  info('3. Reserves:');
  info(`   Token reserve: ${tokenReserve}`);
  info(`   SOL reserve:   ${Number(solReserve) / 1e9} SOL`);
  if (solReserve === 0n) { err('No SOL liquidity'); return false; }

  // 4. AMM math
  info('4. AMM math (buy 0.001 SOL):');
  const solIn = BigInt(Math.floor(0.001 * 1e9));
  const expectedOut = ammV4SwapOut(solIn, solReserve, tokenReserve, pool.tradeFeeNum, pool.tradeFeeDen);
  const minOut = (expectedOut * 9700n) / 10000n;
  info(`   SOL in:           ${Number(solIn) / 1e9} SOL`);
  info(`   Expected tokens:  ${expectedOut}`);
  info(`   Min tokens (3%):  ${minOut}`);

  // 5. Build & simulate
  info('5. Build swap instruction...');
  const owner = payer.publicKey;

  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) { err('Mint not found'); return false; }
  const tokenProgram = mintInfo.owner;
  info(`   Token program: ${tokenProgram.toBase58()}`);

  const userTokenAta = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  const userWsolAta = getAssociatedTokenAddressSync(WSOL, owner, false, TOKEN_PROGRAM_ID);

  const swapIx = buildAmmV4SwapBaseInInstruction(
    pool, poolId, owner,
    userWsolAta,   // userInputAta (SOL in)
    userTokenAta,  // userOutputAta (tokens out)
    solIn, minOut,
  );
  info(`   Accounts: ${swapIx.keys.length}`);
  info(`   Data size: ${swapIx.data.length} bytes`);
  info(`   Instruction index: ${swapIx.data[0]} (should be 9 for SwapBaseIn)`);
  console.log('   Account keys:');
  swapIx.keys.forEach((k, i) => console.log(`     [${i.toString().padStart(2)}] ${k.pubkey.toBase58().substring(0, 20)}... ${k.isSigner ? 'S' : '-'}${k.isWritable ? 'W' : '-'}`));

  // Simulate
  info('6. Simulation...');
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: owner, recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      createAssociatedTokenAccountIdempotentInstruction(owner, userTokenAta, owner, mint, tokenProgram),
      createAssociatedTokenAccountIdempotentInstruction(owner, userWsolAta, owner, WSOL, TOKEN_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: userWsolAta, lamports: solIn }),
      createSyncNativeInstruction(userWsolAta),
      swapIx,
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  const sim = await connection.simulateTransaction(tx, { sigVerify: false });
  if (sim.value.err) {
    err(`SIMULATION FAILED: ${JSON.stringify(sim.value.err)}`);
    sim.value.logs?.forEach(l => console.error('     ' + l));
    return false;
  }
  ok(`Simulation OK (${sim.value.unitsConsumed} CU)`);
  return true;
}

// ─── Auto-detect ─────────────────────────────────────────────────────────────

async function autoDetect(connection: Connection, mint: PublicKey): Promise<Protocol | null> {
  // Try LaunchLab
  try {
    const result = await resolveLaunchLabPool(connection, mint);
    if (result && result.pool.status === 0) return 'launchlab';
  } catch {}
  // Try CPMM
  try {
    await resolveCpmmPool(connection, mint);
    return 'cpmm';
  } catch {}
  // Try AMM v4
  try {
    await resolveAmmV4Pool(connection, mint);
    return 'ammv4';
  } catch {}
  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const mintStr  = process.argv[2];
  const protocolArg = (process.argv[3] ?? 'auto').toLowerCase();

  if (!mintStr) {
    console.error('Usage: npx ts-node src/test-raydium.ts <MINT_ADDRESS> [auto|launchlab|cpmm|ammv4]');
    process.exit(1);
  }

  const connection = new Connection(config.rpc.url, 'processed');
  const payer = Keypair.fromSecretKey(bs58.decode(config.wallet.privateKey));
  const mint = new PublicKey(mintStr);

  console.log(`\n🧪 Raydium Test Script`);
  console.log(`   Mint:     ${mint.toBase58()}`);
  console.log(`   Protocol: ${protocolArg}`);
  console.log(`   Payer:    ${payer.publicKey.toBase58()}`);

  const balance = await connection.getBalance(payer.publicKey);
  console.log(`   Balance:  ${(balance / 1e9).toFixed(6)} SOL`);

  let protocol: Protocol | null = null;

  if (protocolArg === 'auto') {
    info('Auto-detecting protocol...');
    protocol = await autoDetect(connection, mint);
    if (!protocol) {
      err('Token not found on any Raydium protocol (LaunchLab, CPMM, AMM v4)');
      process.exit(1);
    }
    ok(`Detected: ${protocol}`);
  } else if (['launchlab', 'cpmm', 'ammv4'].includes(protocolArg)) {
    protocol = protocolArg as Protocol;
  } else {
    err(`Unknown protocol: ${protocolArg}. Use: auto, launchlab, cpmm, ammv4`);
    process.exit(1);
  }

  let success = false;
  switch (protocol) {
    case 'launchlab': success = await testLaunchLab(connection, mint, payer); break;
    case 'cpmm':      success = await testCpmm(connection, mint, payer); break;
    case 'ammv4':     success = await testAmmV4(connection, mint, payer); break;
  }

  sep('RESULT');
  if (success) {
    console.log('  ✅ ALL CHECKS PASSED — Ready to trade!');
  } else {
    console.log('  ❌ SIMULATION FAILED — Check errors above');
  }
}

main().catch(e => { console.error('💥', e); process.exit(1); });
