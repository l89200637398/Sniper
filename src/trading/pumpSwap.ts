// src/trading/pumpSwap.ts
//
// ВЕРСИЯ 3 — 2026-03-27
//
// ═══════════════════════════════════════════════════════════════════════════════
// КАНОНИЧЕСКИЕ PUMP.FUN ПУЛЫ:
//
//   baseMint  = meme token   (токен купленный пользователем)
//   quoteMint = wSOL
//
// IDL семантика (интуитивная):
//   buy(base_amount_out, max_quote_amount_in)
//     = купить base(meme) заплатив quote(wSOL) = BOT BUY meme
//     disc: 66063d12 (PUMP_SWAP_BUY = global:buy)
//
//   sell(base_amount_in, min_quote_amount_out)
//     = продать base(meme) получить quote(wSOL) = BOT SELL meme
//     disc: 33e685a4 (PUMP_SWAP_SELL = global:sell)
//
// Pool PDA seeds (подтверждено официальной документацией):
//   ['pool', u16_le(0), pumpAuthority(token), token, wSOL]
//   где pumpAuthority = PDA(['pool-authority', token], pump.fun_program)
//
// Fee в wSOL:
//   protocolFeeRecipientTokenAccount = ATA(feeRecipient, wSOL)
//   coinCreatorVaultAta              = ATA(vaultAuthority, wSOL)
//
// Аккаунтов: 19 для BOT BUY (IDL buy), 21 для BOT SELL (IDL sell)
//   Sep 2025: +2 fee_config/fee_program для обоих
//   Aug 2025: vol.accumulators только в IDL buy (= BOT BUY)
//
// Источники:
//   - pump-fun/pump-public-docs (официальная документация)
//   - Shyft API: base_mint=meme_token, quote_mint=wSOL для canonical pools
//   - pump_pool_authority_pda(base_mint=meme_token) из docs/PUMP_SWAP_CREATOR_FEE_README.md
// ═══════════════════════════════════════════════════════════════════════════════

import {
  Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction,
  VersionedTransaction, TransactionMessage, ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { config }                          from '../config';
import { queueJitoSend }                   from '../infra/jito-queue';
import { getCachedBlockhashWithHeight }    from '../infra/blockhash-cache';
import { getCachedPriorityFee }            from '../infra/priority-fee-cache';
import { getMintState, updateMintState }   from '../core/state-cache';
import { logger }                          from '../utils/logger';
import { ensureSufficientBalance, estimateTransactionFee } from '../utils/balance';
import {
  DISCRIMINATOR, PUMP_SWAP_PROGRAM_ID, PUMP_FUN_PROGRAM_ID, FEE_PROGRAM_ID,
} from '../constants';
import { sha256 }      from '../utils/sha';
import { withRetry }   from '../utils/retry';
import { withRpcLimit } from '../utils/rpc-limiter';

const PUMP_SWAP_PROGRAM = new PublicKey(PUMP_SWAP_PROGRAM_ID);
const PUMP_PROGRAM      = new PublicKey(PUMP_FUN_PROGRAM_ID);
const FEE_PROGRAM       = new PublicKey(FEE_PROGRAM_ID);
const WSOL_MINT         = new PublicKey(config.wsolMint);

const POOL_FEE_BPS               = 30n;
const POOL_ACCOUNT_DISCRIMINATOR = sha256('account:Pool').subarray(0, 8);

// ─── PDA helpers ──────────────────────────────────────────────────────────────

/**
 * Pool PDA для canonical pump.fun пулов (index=0).
 *
 * Официальные seeds (из pump-public-docs):
 *   ['pool', u16_le(0), pumpPoolAuthority(token), token, wSOL]
 *
 * baseMint  = meme token
 * quoteMint = wSOL
 */
export function getPoolPDA(tokenMint: PublicKey): PublicKey {
  const creator = getPumpPoolAuthorityPDA(tokenMint);
  const idxBuf  = Buffer.alloc(2);
  idxBuf.writeUInt16LE(0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), idxBuf, creator.toBuffer(), tokenMint.toBuffer(), WSOL_MINT.toBuffer()],
    PUMP_SWAP_PROGRAM,
  )[0];
}

export function getPoolPDAByMint(mint: PublicKey): PublicKey { return getPoolPDA(mint); }

/**
 * pump.fun program PDA: ['pool-authority', tokenMint] — creator canonical пула.
 * Источник: pump-fun/pump-public-docs/docs/PUMP_SWAP_CREATOR_FEE_README.md
 */
function getPumpPoolAuthorityPDA(tokenMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool-authority'), tokenMint.toBuffer()],
    PUMP_PROGRAM,
  )[0];
}

export function getPoolAuthorityPDA(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool_authority'), pool.toBuffer()], PUMP_SWAP_PROGRAM,
  )[0];
}

function getGlobalConfigPDA(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('global_config')], PUMP_SWAP_PROGRAM)[0];
}

function getEventAuthorityPDA(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_SWAP_PROGRAM)[0];
}

function getGlobalVolumeAccumulatorPDA(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('global_volume_accumulator')], PUMP_SWAP_PROGRAM,
  )[0];
}

function getUserVolumeAccumulatorPDA(user: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user_volume_accumulator'), user.toBuffer()], PUMP_SWAP_PROGRAM,
  )[0];
}

function getCoinCreatorVaultAuthorityPDA(coinCreator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('creator_vault'), coinCreator.toBuffer()], PUMP_SWAP_PROGRAM,
  )[0];
}

function getFeeConfigPDA(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('fee_config'), PUMP_SWAP_PROGRAM.toBuffer()], FEE_PROGRAM,
  )[0];
}

const CACHED_GLOBAL_CONFIG     = getGlobalConfigPDA();
const CACHED_EVENT_AUTHORITY   = getEventAuthorityPDA();
const CACHED_GLOBAL_VOLUME_ACC = getGlobalVolumeAccumulatorPDA();
const CACHED_FEE_CONFIG        = getFeeConfigPDA();

// ─── GlobalConfig reader ──────────────────────────────────────────────────────

let cachedFeeRecipients: PublicKey[] | null = null;

async function getProtocolFeeRecipients(connection: Connection): Promise<PublicKey[]> {
  if (cachedFeeRecipients) return cachedFeeRecipients;
  const acc = await withRpcLimit(() => connection.getAccountInfo(CACHED_GLOBAL_CONFIG));
  if (!acc) throw new Error('PumpSwap GlobalConfig not found');
  const offset = 8 + 32 + 8 + 8 + 1; // 57
  const recipients: PublicKey[] = [];
  for (let i = 0; i < 8; i++) {
    recipients.push(new PublicKey(acc.data.subarray(offset + i * 32, offset + (i + 1) * 32)));
  }
  cachedFeeRecipients = recipients;
  return recipients;
}

// ─── Pool account parser ──────────────────────────────────────────────────────

export interface PoolState {
  baseMint:              PublicKey;   // meme token (для canonical pump.fun pools)
  quoteMint:             PublicKey;   // wSOL
  poolBaseTokenAccount:  PublicKey;   // pool meme token vault
  poolQuoteTokenAccount: PublicKey;   // pool wSOL vault
  coinCreator:           PublicKey | null;
}

export function parsePoolAccount(data: Buffer): PoolState {
  if (!data.subarray(0, 8).equals(POOL_ACCOUNT_DISCRIMINATOR)) {
    throw new Error('Invalid pool account discriminator');
  }
  // Layout: disc(8)+bump(1)+index(2)+creator(32)+baseMint(32)+quoteMint(32)
  //         +lpMint(32)+poolBase(32)+poolQuote(32)+lpSupply(8) = 211 bytes
  // Canonical pools: baseMint=meme_token, quoteMint=wSOL
  const baseMint              = new PublicKey(data.subarray(43,  75));  // meme token
  const quoteMint             = new PublicKey(data.subarray(75,  107)); // wSOL
  const poolBaseTokenAccount  = new PublicKey(data.subarray(139, 171)); // pool meme vault
  const poolQuoteTokenAccount = new PublicKey(data.subarray(171, 203)); // pool wSOL vault

  let coinCreator: PublicKey | null = null;
  if (data.length >= 243) {
    const bytes = data.subarray(211, 243);
    if (!bytes.every(b => b === 0)) coinCreator = new PublicKey(bytes);
  }
  return { baseMint, quoteMint, poolBaseTokenAccount, poolQuoteTokenAccount, coinCreator };
}

// ─── AMM math ─────────────────────────────────────────────────────────────────

function computeAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (reserveIn === 0n || reserveOut === 0n) throw new Error('Zero reserves');
  const amountInAfterFee = amountIn * (10000n - POOL_FEE_BPS);
  return (amountInAfterFee * reserveOut) / (reserveIn * 10000n + amountInAfterFee);
}

function computeMinOut(expectedOut: bigint, slippageBps: number, reserveOut: bigint): bigint {
  const maxFraction = BigInt(Math.floor(config.strategy.pumpSwapMaxReserveFraction * 100));
  if (reserveOut > 0n && expectedOut * 100n > reserveOut * maxFraction) {
    throw new Error(`Trade too large: ${expectedOut} > ${Number(maxFraction) / 100}% of reserve`);
  }
  return (expectedOut * BigInt(10000 - slippageBps)) / 10000n;
}

function encodeU64(v: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(v);
  return buf;
}

// ─── Account interface ────────────────────────────────────────────────────────

interface SwapAccounts {
  pool:                              PublicKey;
  user:                              PublicKey;
  baseMint:                          PublicKey;  // meme token
  quoteMint:                         PublicKey;  // wSOL
  userBaseTokenAccount:              PublicKey;  // user meme token ATA
  userQuoteTokenAccount:             PublicKey;  // user wSOL ATA
  poolBaseTokenAccount:              PublicKey;  // pool meme vault
  poolQuoteTokenAccount:             PublicKey;  // pool wSOL vault
  protocolFeeRecipient:              PublicKey;
  protocolFeeRecipientTokenAccount:  PublicKey;  // ATA(recipient, wSOL)
  baseTokenProgram:                  PublicKey;  // token program для meme
  quoteTokenProgram:                 PublicKey;  // TOKEN_PROGRAM (wSOL всегда SPL)
  coinCreatorVaultAta:               PublicKey;  // ATA(vaultAuthority, wSOL)
  coinCreatorVaultAuthority:         PublicKey;
}

// ─── Build instructions ───────────────────────────────────────────────────────

/**
 * Bot BUY meme token = IDL 'buy'.
 * User платит wSOL (quote), получает meme token (base).
 * disc: 66063d12 (PUMP_SWAP_BUY = global:buy)
 * args: base_amount_out (мем токены к получению), max_quote_amount_in (макс wSOL к трате)
 * 21 аккаунт (Aug 2025: +vol.acc, Sep 2025: +fee_config/fee_program)
 */
export function buildBuyInstruction(
  accs:              SwapAccounts,
  tokenAmountOut:    bigint,   // мем токены к получению
  maxSolIn:          bigint,   // макс wSOL к трате (с учётом слиппажа)
  user:              PublicKey,
): TransactionInstruction {
  const data = Buffer.concat([
    DISCRIMINATOR.PUMP_SWAP_BUY,   // 66063d12 = global:buy = BOT BUY MEME
    encodeU64(tokenAmountOut),      // base_amount_out
    encodeU64(maxSolIn),            // max_quote_amount_in
  ]);

  const userVolumeAcc = getUserVolumeAccumulatorPDA(user);

  const keys = [
    { pubkey: accs.pool,                             isSigner: false, isWritable: true  }, //  0 pool (writable Nov 2025)
    { pubkey: accs.user,                             isSigner: true,  isWritable: true  }, //  1 user
    { pubkey: CACHED_GLOBAL_CONFIG,                  isSigner: false, isWritable: false }, //  2 global_config
    { pubkey: accs.baseMint,                         isSigner: false, isWritable: false }, //  3 base_mint = meme token
    { pubkey: accs.quoteMint,                        isSigner: false, isWritable: false }, //  4 quote_mint = wSOL
    { pubkey: accs.userBaseTokenAccount,             isSigner: false, isWritable: true  }, //  5 user_base = user meme ATA
    { pubkey: accs.userQuoteTokenAccount,            isSigner: false, isWritable: true  }, //  6 user_quote = user wSOL ATA
    { pubkey: accs.poolBaseTokenAccount,             isSigner: false, isWritable: true  }, //  7 pool_base = pool meme vault
    { pubkey: accs.poolQuoteTokenAccount,            isSigner: false, isWritable: true  }, //  8 pool_quote = pool wSOL vault
    { pubkey: accs.protocolFeeRecipient,             isSigner: false, isWritable: false }, //  9
    { pubkey: accs.protocolFeeRecipientTokenAccount, isSigner: false, isWritable: true  }, // 10 ATA for wSOL (fee in wSOL)
    { pubkey: accs.baseTokenProgram,                 isSigner: false, isWritable: false }, // 11 base_token_program (meme)
    { pubkey: accs.quoteTokenProgram,                isSigner: false, isWritable: false }, // 12 quote_token_program (wSOL)
    { pubkey: SystemProgram.programId,               isSigner: false, isWritable: false }, // 13
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,           isSigner: false, isWritable: false }, // 14
    { pubkey: CACHED_EVENT_AUTHORITY,                isSigner: false, isWritable: false }, // 15
    { pubkey: PUMP_SWAP_PROGRAM,                     isSigner: false, isWritable: false }, // 16 self
    { pubkey: accs.coinCreatorVaultAta,              isSigner: false, isWritable: true  }, // 17 creator vault (wSOL)
    { pubkey: accs.coinCreatorVaultAuthority,        isSigner: false, isWritable: false }, // 18
    { pubkey: CACHED_GLOBAL_VOLUME_ACC,              isSigner: false, isWritable: true  }, // 19 Aug 2025
    { pubkey: userVolumeAcc,                         isSigner: false, isWritable: true  }, // 20 Aug 2025
    { pubkey: CACHED_FEE_CONFIG,                     isSigner: false, isWritable: false }, // 21 Sep 2025
    { pubkey: FEE_PROGRAM,                           isSigner: false, isWritable: false }, // 22 Sep 2025
  ];

  return new TransactionInstruction({ programId: PUMP_SWAP_PROGRAM, keys, data });
}

/**
 * Bot SELL meme token = IDL 'sell'.
 * User платит meme token (base), получает wSOL (quote).
 * disc: 33e685a4 (PUMP_SWAP_SELL = global:sell)
 * args: base_amount_in (мем токены к трате), min_quote_amount_out (мин wSOL к получению)
 * 21 аккаунт (Sep 2025: +fee_config/fee_program; vol.acc НЕ нужны для sell)
 */
export function buildSellInstruction(
  accs:             SwapAccounts,
  tokenAmountIn:    bigint,   // мем токены к трате
  minSolOut:        bigint,   // мин wSOL к получению
): TransactionInstruction {
  const data = Buffer.concat([
    DISCRIMINATOR.PUMP_SWAP_SELL,  // 33e685a4 = global:sell = BOT SELL MEME
    encodeU64(tokenAmountIn),       // base_amount_in
    encodeU64(minSolOut),           // min_quote_amount_out
  ]);

  const keys = [
    { pubkey: accs.pool,                             isSigner: false, isWritable: true  }, //  0
    { pubkey: accs.user,                             isSigner: true,  isWritable: true  }, //  1
    { pubkey: CACHED_GLOBAL_CONFIG,                  isSigner: false, isWritable: false }, //  2
    { pubkey: accs.baseMint,                         isSigner: false, isWritable: false }, //  3 meme token
    { pubkey: accs.quoteMint,                        isSigner: false, isWritable: false }, //  4 wSOL
    { pubkey: accs.userBaseTokenAccount,             isSigner: false, isWritable: true  }, //  5 user meme ATA
    { pubkey: accs.userQuoteTokenAccount,            isSigner: false, isWritable: true  }, //  6 user wSOL ATA
    { pubkey: accs.poolBaseTokenAccount,             isSigner: false, isWritable: true  }, //  7 pool meme vault
    { pubkey: accs.poolQuoteTokenAccount,            isSigner: false, isWritable: true  }, //  8 pool wSOL vault
    { pubkey: accs.protocolFeeRecipient,             isSigner: false, isWritable: false }, //  9
    { pubkey: accs.protocolFeeRecipientTokenAccount, isSigner: false, isWritable: true  }, // 10 ATA for wSOL
    { pubkey: accs.baseTokenProgram,                 isSigner: false, isWritable: false }, // 11
    { pubkey: accs.quoteTokenProgram,                isSigner: false, isWritable: false }, // 12
    { pubkey: SystemProgram.programId,               isSigner: false, isWritable: false }, // 13
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,           isSigner: false, isWritable: false }, // 14
    { pubkey: CACHED_EVENT_AUTHORITY,                isSigner: false, isWritable: false }, // 15
    { pubkey: PUMP_SWAP_PROGRAM,                     isSigner: false, isWritable: false }, // 16 self
    { pubkey: accs.coinCreatorVaultAta,              isSigner: false, isWritable: true  }, // 17 creator vault (wSOL)
    { pubkey: accs.coinCreatorVaultAuthority,        isSigner: false, isWritable: false }, // 18
    { pubkey: CACHED_FEE_CONFIG,                     isSigner: false, isWritable: false }, // 19 Sep 2025
    { pubkey: FEE_PROGRAM,                           isSigner: false, isWritable: false }, // 20 Sep 2025
  ];

  return new TransactionInstruction({ programId: PUMP_SWAP_PROGRAM, keys, data });
}

// ─── Resolve accounts ─────────────────────────────────────────────────────────

async function resolveSwapAccounts(
  connection: Connection,
  mint:       PublicKey,
  user:       PublicKey,
  poolHint?:  PublicKey,  // адрес пула если известен (из create_pool события)
): Promise<{
  accs:         SwapAccounts;
  poolState:    PoolState;
  tokenReserve: bigint;
  solReserve:   bigint;
}> {
  // Token program для meme токена
  const mintState = getMintState(mint);
  if (!mintState.tokenProgramId) {
    const mintInfo = await withRpcLimit(() => connection.getAccountInfo(mint));
    if (!mintInfo) throw new Error('Mint account not found');
    mintState.tokenProgramId = mintInfo.owner;
  }
  const baseTokenProgram = mintState.tokenProgramId;

  // Найти пул: приоритет - кешированный адрес, затем PDA, затем getProgramAccounts
  let pool: PublicKey;
  let poolAcc: import('@solana/web3.js').AccountInfo<Buffer> | null = null;

  // 1. Использовать кешированный адрес пула из состояния
  if (mintState.pool) {
    pool    = mintState.pool;
    poolAcc = await withRetry(() => withRpcLimit(() => connection.getAccountInfo(pool)));
  }

  // 2. Использовать hint из аргумента
  if (!poolAcc && poolHint) {
    pool    = poolHint;
    poolAcc = await withRetry(() => withRpcLimit(() => connection.getAccountInfo(pool)));
  }

  // 3. Попробовать PDA (работает для canonical pools)
  if (!poolAcc) {
    pool    = getPoolPDA(mint);
    poolAcc = await withRetry(() => withRpcLimit(() => connection.getAccountInfo(pool)));
  }

  // 4. Fallback: getProgramAccounts — поиск пула по байтам mint-адреса
  //    Ищем токен как baseMint (offset 43) и как quoteMint (offset 75)
  if (!poolAcc) {
    logger.debug(`Pool PDA not found for ${mint.toBase58()}, trying getProgramAccounts...`);
    for (const offset of [43, 75]) {
      try {
        const accounts = await connection.getProgramAccounts(PUMP_SWAP_PROGRAM, {
          commitment: 'confirmed',
          filters: [{ memcmp: { offset, bytes: mint.toBase58() } }],
        });
        if (accounts.length > 0) {
          pool    = accounts[0].pubkey;
          poolAcc = accounts[0].account;
          logger.info(`Pool found via getProgramAccounts at offset ${offset}: ${pool.toBase58()}`);
          break;
        }
      } catch (e) {
        logger.warn(`getProgramAccounts failed (offset ${offset}): ${e}`);
      }
    }
  }

  if (!poolAcc) throw new Error(`PumpSwap pool not found for ${mint.toBase58()}`);

  const poolState = parsePoolAccount(poolAcc.data);

  // Определить baseMint и quoteMint (порядок зависит от того как пул создан)
  const isBaseToken = poolState.baseMint.equals(mint);   // meme token = base
  const isQuoteToken = poolState.quoteMint.equals(mint); // meme token = quote

  if (!isBaseToken && !isQuoteToken) {
    throw new Error(`Pool ${pool!.toBase58()} does not contain mint ${mint.toBase58()}`);
  }

  // tokenProgram для SOL-стороны всегда SPL (wSOL)
  const solTokenProgram = TOKEN_PROGRAM_ID;
  // tokenProgram для quote-стороны пула (может быть не wSOL)
  const quoteTokenProgram = isBaseToken ? solTokenProgram : baseTokenProgram;

  // ATA пользователя для meme токена и wSOL
  const userMemeAta = getAssociatedTokenAddressSync(mint, user, false, baseTokenProgram);
  const userWsolAta = getAssociatedTokenAddressSync(WSOL_MINT, user, false, TOKEN_PROGRAM_ID);

  // Protocol fee recipient — ATA для quoteMint пула (не всегда wSOL!)
  const recipients          = await getProtocolFeeRecipients(connection);
  const feeRecipient        = recipients[Math.floor(Math.random() * recipients.length)];
  const feeRecipientAta     = getAssociatedTokenAddressSync(poolState.quoteMint, feeRecipient, true, quoteTokenProgram);

  // Creator vault ATA для quoteMint пула
  const coinCreator        = poolState.coinCreator ?? PublicKey.default;
  const vaultAuthority     = getCoinCreatorVaultAuthorityPDA(coinCreator);
  const coinCreatorVaultAta = getAssociatedTokenAddressSync(poolState.quoteMint, vaultAuthority, true, quoteTokenProgram);

  // Reserves
  const [memeBalanceAcc, solBalanceAcc] = isBaseToken
    ? [poolState.poolBaseTokenAccount, poolState.poolQuoteTokenAccount]
    : [poolState.poolQuoteTokenAccount, poolState.poolBaseTokenAccount];

  const [memeBal, solBal] = await Promise.all([
    withRpcLimit(() => connection.getTokenAccountBalance(memeBalanceAcc)),
    withRpcLimit(() => connection.getTokenAccountBalance(solBalanceAcc)),
  ]);

  // Кешируем pool address
  updateMintState(mint, {
    pool:                  pool!,
    poolBaseTokenAccount:  poolState.poolBaseTokenAccount,
    poolQuoteTokenAccount: poolState.poolQuoteTokenAccount,
  });

  return {
    accs: {
      pool:                             pool!,
      user,
      baseMint:                         poolState.baseMint,
      quoteMint:                        poolState.quoteMint,
      userBaseTokenAccount:             isBaseToken ? userMemeAta : userWsolAta,
      userQuoteTokenAccount:            isBaseToken ? userWsolAta : userMemeAta,
      poolBaseTokenAccount:             poolState.poolBaseTokenAccount,
      poolQuoteTokenAccount:            poolState.poolQuoteTokenAccount,
      protocolFeeRecipient:             feeRecipient,
      protocolFeeRecipientTokenAccount: feeRecipientAta,
      baseTokenProgram:                 isBaseToken ? baseTokenProgram : solTokenProgram,
      quoteTokenProgram:                isBaseToken ? solTokenProgram : baseTokenProgram,
      coinCreatorVaultAta,
      coinCreatorVaultAuthority: vaultAuthority,
    },
    poolState,
    tokenReserve: BigInt(memeBal.value.amount),
    solReserve:   BigInt(solBal.value.amount),
  };
}

// ─── buyTokenPumpSwap ─────────────────────────────────────────────────────────

export async function buyTokenPumpSwap(
  connection:  Connection,
  mint:        PublicKey,
  payer:       Keypair,
  solAmount:   number,
  slippageBps: number = config.strategy.slippageBps,
): Promise<string> {
  const owner       = payer.publicKey;
  const priorityFee = getCachedPriorityFee();
  const maxTip      = config.jito.maxTipAmountSol;
  const estFee      = estimateTransactionFee(2, config.compute.unitLimit, priorityFee);

  await ensureSufficientBalance(connection, owner, solAmount + maxTip + estFee / 1e9 + 0.003);

  const { accs, tokenReserve, solReserve } = await resolveSwapAccounts(connection, mint, owner, getMintState(mint).pool);

  const solIn           = BigInt(Math.floor(solAmount * 1e9));
  // Bot BUY = IDL buy: платим wSOL (quote), получаем meme token (base)
  // computeAmountOut(wsolIn, poolWsolReserve, poolTokenReserve)
  const expectedTokens  = computeAmountOut(solIn, solReserve, tokenReserve);
  const minTokensOut    = computeMinOut(expectedTokens, slippageBps, tokenReserve);
  const maxSolIn        = (solIn * BigInt(10000 + slippageBps)) / 10000n;

  const isToken2022 = !accs.baseTokenProgram.equals(TOKEN_PROGRAM_ID);
  const wsolAta = accs.userQuoteTokenAccount;
  const memeAta = accs.userBaseTokenAccount;

  const buildTx = async (): Promise<VersionedTransaction> => {
    const { blockhash } = await getCachedBlockhashWithHeight();
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: config.compute.unitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
      // Create user meme token ATA
      createAssociatedTokenAccountIdempotentInstruction(
        owner, memeAta, owner, mint, accs.baseTokenProgram,
      ),
      // Wrap SOL → wSOL
      createAssociatedTokenAccountIdempotentInstruction(
        owner, wsolAta, owner, WSOL_MINT, TOKEN_PROGRAM_ID,
      ),
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsolAta, lamports: solIn }),
      createSyncNativeInstruction(wsolAta),
      // Bot BUY = IDL buy
      // Token-2022 with transfer fee: base_amount_out = 1n to avoid Overflow (6023)
      buildBuyInstruction(accs, isToken2022 ? 1n : minTokensOut, maxSolIn, owner),
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
    if (sim.value.err) throw new Error(`PumpSwap buy sim failed: ${JSON.stringify(sim.value.err)}`);
    logger.debug('PumpSwap buy simulation OK');
  }

  const txId = await queueJitoSend(buildTx, payer, 0, true);
  logger.info(`PumpSwap buy sent: ${txId} (${solAmount} SOL)`);
  return txId;
}

// ─── sellTokenPumpSwap ────────────────────────────────────────────────────────

export async function sellTokenPumpSwap(
  connection:      Connection,
  mint:            PublicKey,
  payer:           Keypair,
  tokenAmountRaw:  bigint,
  slippageBps:     number  = config.strategy.slippageBps,
  urgent:          boolean = false,
  directRpc:       boolean = false,
): Promise<string> {
  const owner       = payer.publicKey;
  const priorityFee = getCachedPriorityFee();
  const maxTip      = config.jito.maxTipAmountSol;
  const estFee      = estimateTransactionFee(2, config.compute.unitLimit, priorityFee);

  await ensureSufficientBalance(connection, owner, maxTip + estFee / 1e9 + 0.001);

  const { accs, tokenReserve, solReserve } = await resolveSwapAccounts(connection, mint, owner, getMintState(mint).pool);

  // Bot SELL = IDL sell: платим meme token (base), получаем wSOL (quote)
  // computeAmountOut(tokenIn, poolTokenReserve, poolWsolReserve)
  const expectedSol = computeAmountOut(tokenAmountRaw, tokenReserve, solReserve);
  const minSolOut   = computeMinOut(expectedSol, slippageBps, solReserve);

  const wsolAta = accs.userQuoteTokenAccount;

  const buildTx = async (): Promise<VersionedTransaction> => {
    const { blockhash } = await getCachedBlockhashWithHeight();
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: config.compute.unitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
      // Create wSOL ATA to receive proceeds
      createAssociatedTokenAccountIdempotentInstruction(
        owner, wsolAta, owner, WSOL_MINT, TOKEN_PROGRAM_ID,
      ),
      // Bot SELL = IDL sell
      buildSellInstruction(accs, tokenAmountRaw, minSolOut),
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
    if (sim.value.err) throw new Error(`PumpSwap sell sim failed: ${JSON.stringify(sim.value.err)}`);
    logger.debug('PumpSwap sell simulation OK');
  }

  if (directRpc) {
    const tx  = await buildTx();
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
    logger.info(`PumpSwap sell via direct RPC: ${sig}`);
    return sig;
  }

  const txId = await queueJitoSend(buildTx, payer, config.jito.maxRetries, urgent);
  logger.info(`PumpSwap sell sent: ${txId} (~${Number(expectedSol) / 1e9} SOL)`);
  return txId;
}
