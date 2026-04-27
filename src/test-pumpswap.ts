/**
 * test-pumpswap.ts v4 — использует getProgramAccounts для поиска пула
 * Работает с любым пулом (canonical и нестандартным)
 * Запуск: npx ts-node src/test-pumpswap.ts <mint>
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, ComputeBudgetProgram,
  VersionedTransaction, TransactionMessage,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction,
} from '@solana/spl-token';
import bs58 from 'bs58'; import dotenv from 'dotenv'; dotenv.config();
import { config }          from './config';
import { parsePoolAccount, buildBuyInstruction, buildSellInstruction } from './trading/pumpSwap';
import { DISCRIMINATOR }                from './constants';

const PSWAP   = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const WSOL    = new PublicKey(config.wsolMint);
const FEE_PR  = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
function u16le(n: number) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function getGlobalConfigPDA() { return PublicKey.findProgramAddressSync([Buffer.from('global_config')], PSWAP)[0]; }
function getEventAuthPDA()    { return PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PSWAP)[0]; }
function getGlobalVolPDA()    { return PublicKey.findProgramAddressSync([Buffer.from('global_volume_accumulator')], PSWAP)[0]; }
function getUserVolPDA(u: PublicKey) { return PublicKey.findProgramAddressSync([Buffer.from('user_volume_accumulator'), u.toBuffer()], PSWAP)[0]; }
function getVaultAuthPDA(c: PublicKey) { return PublicKey.findProgramAddressSync([Buffer.from('creator_vault'), c.toBuffer()], PSWAP)[0]; }
function getFeeConfigPDA() { return PublicKey.findProgramAddressSync([Buffer.from('fee_config'), PSWAP.toBuffer()], FEE_PR)[0]; }

async function getFeeRecipients(conn: Connection) {
  const acc = await conn.getAccountInfo(getGlobalConfigPDA());
  if (!acc) throw new Error('GlobalConfig not found');
  return Array.from({ length: 8 }, (_, i) => new PublicKey(acc.data.subarray(57 + i*32, 57 + (i+1)*32)));
}

function sep(t: string) { console.log(`\n${'─'.repeat(65)}\n  ${t}\n${'─'.repeat(65)}`); }

async function main() {
  const mintStr = process.argv[2];
  if (!mintStr) { console.error('Usage: npx ts-node src/test-pumpswap.ts <mint>'); process.exit(1); }
  const connection = new Connection(config.rpc.url, 'processed');
  const payer      = Keypair.fromSecretKey(bs58.decode(config.wallet.privateKey));
  const mint       = new PublicKey(mintStr);
  const owner      = payer.publicKey;

  console.log(`\n🧪 PumpSwap Test v4 (getProgramAccounts pool discovery)`);
  console.log(`   Mint: ${mint.toBase58()}`);

  // 1. Find pool via getProgramAccounts
  sep('1. Pool discovery via getProgramAccounts');
  let pool: PublicKey | null = null;
  let poolData: Buffer | null = null;

  for (const offset of [43, 75]) {
    const accounts = await connection.getProgramAccounts(PSWAP, {
      commitment: 'confirmed',
      filters: [{ memcmp: { offset, bytes: mint.toBase58() } }],
    });
    if (accounts.length > 0) {
      pool     = accounts[0].pubkey;
      poolData = accounts[0].account.data;
      console.log(`   ✅ Pool found at offset ${offset}: ${pool.toBase58()} (${poolData.length} bytes)`);
      break;
    }
  }

  if (!pool || !poolData) {
    console.error('   ❌ Pool NOT FOUND in PumpSwap program accounts');
    console.log('   Token may be on Raydium or not graduated yet');
    process.exit(1);
  }

  // 2. Parse pool
  sep('2. Pool account data');
  const poolState = parsePoolAccount(poolData);
  console.log(`   baseMint:  ${poolState.baseMint.toBase58()}`);
  console.log(`   quoteMint: ${poolState.quoteMint.toBase58()}`);
  console.log(`   poolBase:  ${poolState.poolBaseTokenAccount.toBase58()}`);
  console.log(`   poolQuote: ${poolState.poolQuoteTokenAccount.toBase58()}`);
  console.log(`   coinCreator: ${poolState.coinCreator?.toBase58() ?? 'null'}`);

  // Dump remaining pool bytes after coinCreator (offset 243+) — check for cashback/new fields
  if (poolData.length > 243) {
    const remaining = poolData.subarray(243);
    console.log(`\n   Pool data after coinCreator (offset 243, ${remaining.length} bytes):`);
    console.log(`   Hex: ${remaining.toString('hex')}`);
    console.log(`   [243] is_mayhem_mode: ${remaining[0]}`);
    if (remaining.length > 1) console.log(`   [244] is_cashback_coin (OptionBool): ${remaining[1]} ${remaining[1] === 1 ? '← CASHBACK ENABLED' : ''}`);
    if (remaining.length > 2) console.log(`   [245] unknown_2: ${remaining[2]}`);
    if (remaining.length > 8) console.log(`   [244-251] as u64: ${remaining.readBigUInt64LE(1)}`);
    if (remaining.length > 16) console.log(`   [252-259] as u64: ${remaining.readBigUInt64LE(9)}`);
    if (remaining.length > 24) console.log(`   [260-267] as u64: ${remaining.readBigUInt64LE(17)}`);
    if (remaining.length > 32) console.log(`   [268-275] as pubkey: ${new PublicKey(remaining.subarray(25, 57)).toBase58()}`);
    if (remaining.length > 57) console.log(`   [300] last_byte: ${remaining[remaining.length - 1]}`);
  }

  // Determine which is token, which is wSOL
  const tokenIsBase  = poolState.baseMint.equals(mint);
  const tokenIsQuote = poolState.quoteMint.equals(mint);
  if (!tokenIsBase && !tokenIsQuote) { console.error('   ❌ Mint not found in pool'); process.exit(1); }
  console.log(`\n   Token position: ${tokenIsBase ? 'base' : 'quote'}`);
  console.log(`   wSOL position:  ${tokenIsBase ? 'quote' : 'base'}`);

  // 3. Reserves
  sep('3. Reserves');
  const memeVault = tokenIsBase ? poolState.poolBaseTokenAccount : poolState.poolQuoteTokenAccount;
  const solVault  = tokenIsBase ? poolState.poolQuoteTokenAccount : poolState.poolBaseTokenAccount;
  const [memeBal, solBal] = await Promise.all([
    connection.getTokenAccountBalance(memeVault),
    connection.getTokenAccountBalance(solVault),
  ]);
  const tokenReserve = BigInt(memeBal.value.amount);
  const solReserve   = BigInt(solBal.value.amount);
  console.log(`   Token reserve: ${memeBal.value.uiAmountString}`);
  console.log(`   wSOL reserve:  ${Number(solReserve)/1e9} SOL`);
  if (solReserve === 0n) { console.error('   ❌ No wSOL liquidity'); process.exit(1); }

  // 4. User ATAs
  sep('4. User ATAs');
  const mintInfo = await connection.getAccountInfo(mint);
  const baseTokenProg = mintInfo!.owner;
  const userMemeAta = getAssociatedTokenAddressSync(mint, owner, false, baseTokenProg);
  const userWsolAta = getAssociatedTokenAddressSync(WSOL, owner, false, TOKEN_PROGRAM_ID);
  console.log(`   userMemeAta: ${userMemeAta.toBase58()}`);
  console.log(`   userWsolAta: ${userWsolAta.toBase58()}`);
  let tokenBalance = 0n;
  const memeInfo = await connection.getAccountInfo(userMemeAta).catch(() => null);
  if (memeInfo) { const b = await connection.getTokenAccountBalance(userMemeAta).catch(() => null); tokenBalance = b ? BigInt(b.value.amount) : 0n; console.log(`   Token balance: ${tokenBalance}`); }

  // 5. Creator vault & fee
  sep('5. Creator vault & fee recipient (using pool quoteMint)');
  const recipients      = await getFeeRecipients(connection);
  const feeRecipient    = recipients[0];
  // Determine quote token program
  const quoteMint       = poolState.quoteMint;
  const quoteMintInfo   = await connection.getAccountInfo(quoteMint);
  const quoteTokenProg  = quoteMintInfo!.owner;
  const feeAta          = getAssociatedTokenAddressSync(quoteMint, feeRecipient, true, quoteTokenProg);
  const coinCreator     = poolState.coinCreator ?? PublicKey.default;
  const vaultAuth       = getVaultAuthPDA(coinCreator);
  const vaultAta        = getAssociatedTokenAddressSync(quoteMint, vaultAuth, true, quoteTokenProg);
  console.log(`   quoteMint: ${quoteMint.toBase58()}`);
  console.log(`   quoteTokenProgram: ${quoteTokenProg.toBase58()}`);
  console.log(`   feeRecipientAta: ${feeAta.toBase58()}`);
  console.log(`   creatorVaultAta: ${vaultAta.toBase58()}`);

  // 6. Build BOT BUY instruction
  sep('6. BOT BUY (IDL buy, disc 66063d12, 24 accounts + poolV2 PDA)');
  const accs = {
    pool, user: owner,
    baseMint: poolState.baseMint, quoteMint: poolState.quoteMint,
    userBaseTokenAccount:  tokenIsBase ? userMemeAta : userWsolAta,
    userQuoteTokenAccount: tokenIsBase ? userWsolAta : userMemeAta,
    poolBaseTokenAccount:  poolState.poolBaseTokenAccount,
    poolQuoteTokenAccount: poolState.poolQuoteTokenAccount,
    protocolFeeRecipient: feeRecipient,
    protocolFeeRecipientTokenAccount: feeAta,
    baseTokenProgram: tokenIsBase ? baseTokenProg : quoteTokenProg,
    quoteTokenProgram: tokenIsBase ? quoteTokenProg : baseTokenProg,
    coinCreatorVaultAta: vaultAta, coinCreatorVaultAuthority: vaultAuth,
  };

  const FEE = 30n, solIn = BigInt(Math.floor(0.001*1e9));
  const aft = solIn*(10000n-FEE);
  const expTok = (aft*tokenReserve)/(solReserve*10000n+aft);
  const minTok = (expTok*9700n)/10000n;
  const maxSol = (solIn*10300n)/10000n;

  // For IDL buy: base_amount_out = token amount, max_quote_amount_in = wSOL
  // base_amount_out = 1n to avoid Overflow (6023) at buy.rs:414
  // IDL confirms base_amount_out is MINIMUM (error 6040: "slippage - would buy less than min_base_amount_out")
  // Overflow caused by: base_amount_out * quote_reserve > u64_max in program math
  // Using 1n: 1 * 18B = 18B → fits u64. Slippage protection via max_quote_amount_in.
  const isToken2022 = baseTokenProg.equals(new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'));
  const isCashback = poolState.isCashbackCoin;
  // Token-2022 with transfer fee: use 1n as min to avoid Overflow in fee math
  const buyTokenAmount = isToken2022 ? 1n : minTok;
  let buyIx: import('@solana/web3.js').TransactionInstruction;
  if (tokenIsBase) {
    buyIx = buildBuyInstruction(accs, buyTokenAmount, maxSol, owner, isCashback);
    console.log(`   IDL: buy(base_amount_out=${buyTokenAmount}${isToken2022 ? ' [Token-2022 workaround]' : ''}, max_quote_amount_in=${maxSol})`);
  } else {
    // token is quote → we "sell" base(wSOL) to get quote(token) → IDL sell
    buyIx = buildSellInstruction(accs, solIn, minTok, owner, isCashback);
    console.log(`   IDL: sell(base_amount_in=${solIn}, min_quote_amount_out=${minTok})`);
  }
  console.log(`   isCashbackCoin: ${isCashback}`);
  console.log(`   isToken2022: ${isToken2022}`);
  console.log(`   Account count: ${buyIx.keys.length}`);
  console.log(`   Data size: ${buyIx.data.length} bytes (should be 25 with track_volume)`);
  console.log(`   disc: ${buyIx.data.subarray(0,8).toString('hex')}`);
  console.log(`\n   Account keys:`);
  buyIx.keys.forEach((k, i) => console.log(`     [${i.toString().padStart(2)}] ${k.pubkey.toBase58().substring(0,20)}... ${k.isSigner ? 'S' : '-'}${k.isWritable ? 'W' : '-'}`));

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const fee = 100_000; // default priority fee for test
  const memeAtaIx = createAssociatedTokenAccountIdempotentInstruction(owner, userMemeAta, owner, mint, baseTokenProg);
  const wsolAtaIx = createAssociatedTokenAccountIdempotentInstruction(owner, userWsolAta, owner, WSOL, TOKEN_PROGRAM_ID);
  const buyMsg = new TransactionMessage({
    payerKey: owner, recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: config.compute.unitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fee }),
      memeAtaIx, wsolAtaIx,
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: userWsolAta, lamports: solIn }),
      createSyncNativeInstruction(userWsolAta),
      buyIx,
    ],
  }).compileToV0Message();
  const buyTx = new VersionedTransaction(buyMsg); buyTx.sign([payer]);
  console.log('\n   Simulating...');
  const sim = await connection.simulateTransaction(buyTx, { sigVerify: false });
  if (sim.value.err) {
    console.error(`   ❌ FAIL: ${JSON.stringify(sim.value.err)}`);
    sim.value.logs?.forEach(l => console.error('     '+l));
  } else { console.log(`   ✅ OK (units: ${sim.value.unitsConsumed})`); }

  sep('Summary');
  console.log(`   Pool:          ${pool.toBase58()}`);
  console.log(`   Token type:    ${isToken2022 ? 'Token-2022' : 'SPL Token'}`);
  console.log(`   Quote mint:    ${quoteMint.toBase58()}${quoteMint.equals(WSOL) ? ' (wSOL)' : ' (NOT wSOL!)'}`);
  console.log(`   Pool byte[244]:${poolData.length > 244 ? ' ' + poolData[244] : ' N/A'}`);
  console.log(`   Pool discovery: ✅`);
  console.log(`   Simulation:    ${!sim.value.err ? '✅ PASS' : '❌ FAIL'}`);
  if (sim.value.err) {
    console.log(`\n   Error details: ${JSON.stringify(sim.value.err)}`);
    // Extract program error code if present
    const errStr = JSON.stringify(sim.value.err);
    const codeMatch = errStr.match(/"Custom":(\d+)/);
    if (codeMatch) {
      const code = parseInt(codeMatch[1]);
      const knownErrors: Record<number, string> = {
        6001: 'ZeroBaseAmount — base_amount_out cannot be 0',
        6023: 'Overflow — arithmetic overflow in fee/amount calculation',
        2014: 'ConstraintTokenMint — wrong token mint for an ATA account',
        2003: 'ConstraintMut — account not marked as mutable',
        3012: 'AccountNotInitialized — ATA does not exist on-chain',
      };
      console.log(`   Error code ${code}: ${knownErrors[code] ?? 'Unknown'}`);
    }
  }
  if (!sim.value.err) console.log('\n✅ Ready to trade!');
}

main().catch(e => { console.error('💥', e); process.exit(1); });
