/**
 * scripts/sell-unknown-tokens.ts
 *
 * Продаёт все токены на кошельке через прямой путь (sellTokenAuto: pump.fun / PumpSwap /
 * Raydium / Jupiter-fallback). Если продажа невозможна — сжигает токены и закрывает ATA
 * (опция --burn-unsellable), возвращая rent (~0.002 SOL за ATA).
 *
 * Запуск:
 *   npx ts-node scripts/sell-unknown-tokens.ts [флаги]
 *
 * Флаги:
 *   --dry-run            Показать токены без действий
 *   --burn-unsellable    Если sell провалился — сжечь токены и закрыть ATA
 *   --min-value N        Минимальная стоимость (SOL) для попытки продажи (default: 0.0001)
 *   --slippage N         Slippage в bps (default: 5000 = 50%)
 *   --skip-mint X        Пропустить конкретный mint (можно несколько раз)
 */

import dotenv from 'dotenv';
dotenv.config();

import {
  Connection, Keypair, PublicKey, Transaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createBurnInstruction,
  createCloseAccountInstruction,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { sellTokenAuto } from '../src/core/sell-engine';
import { sellTokenJupiter, jupiterBase } from '../src/trading/jupiter-sell';
import { detectProtocol } from '../src/core/detector';
import { updateMintState } from '../src/core/state-cache';
import { startBlockhashCache } from '../src/infra/blockhash-cache';
import { startPriorityFeeCache } from '../src/infra/priority-fee-cache';

const WSOL_MINT       = 'So11111111111111111111111111111111111111112';
const DRY_RUN         = process.argv.includes('--dry-run');
const BURN_UNSELLABLE = process.argv.includes('--burn-unsellable');

const MIN_VALUE_IDX  = process.argv.indexOf('--min-value');
const MIN_VALUE_SOL  = MIN_VALUE_IDX >= 0 ? parseFloat(process.argv[MIN_VALUE_IDX + 1]) : 0.0001;

const SLIPPAGE_IDX   = process.argv.indexOf('--slippage');
const SLIPPAGE_BPS   = SLIPPAGE_IDX >= 0 ? parseInt(process.argv[SLIPPAGE_IDX + 1]) : 5000;

const SKIP_MINTS = new Set<string>();
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--skip-mint' && process.argv[i + 1]) SKIP_MINTS.add(process.argv[i + 1]);
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function closeAta(
  connection: Connection,
  payer: Keypair,
  ata: PublicKey,
  tokenProgramId: PublicKey,
): Promise<boolean> {
  try {
    const tx = new Transaction();
    tx.add(createCloseAccountInstruction(ata, payer.publicKey, payer.publicKey, [], tokenProgramId));
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.sign(payer);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    await connection.confirmTransaction(sig, 'confirmed');
    return true;
  } catch (e: any) {
    console.error(`  ⚠️  ATA close failed: ${e?.message ?? e}`);
    return false;
  }
}

async function burnAndClose(
  connection: Connection,
  payer: Keypair,
  ata: PublicKey,
  mint: PublicKey,
  amount: bigint,
  tokenProgramId: PublicKey,
): Promise<boolean> {
  try {
    const tx = new Transaction();
    tx.add(createBurnInstruction(ata, mint, payer.publicKey, amount, [], tokenProgramId));
    tx.add(createCloseAccountInstruction(ata, payer.publicKey, payer.publicKey, [], tokenProgramId));
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.sign(payer);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    await connection.confirmTransaction(sig, 'confirmed');
    return true;
  } catch (e: any) {
    console.error(`  ⚠️  Burn+close failed: ${e?.message ?? e}`);
    return false;
  }
}

async function main() {
  const rpcUrl     = process.env.RPC_URL;
  const privateKey = process.env.PRIVATE_KEY;
  if (!rpcUrl || !privateKey) { console.error('❌ RPC_URL / PRIVATE_KEY не заданы в .env'); process.exit(1); }

  const connection = new Connection(rpcUrl, 'confirmed');
  const payer      = Keypair.fromSecretKey(bs58.decode(privateKey));
  const owner      = payer.publicKey;

  // sellTokenAuto (особенно CPMM/AMM v4 пути) требует blockhash cache.
  startBlockhashCache(connection);
  startPriorityFeeCache(connection);

  const hasJupiterKey = !!process.env.JUPITER_API_KEY;

  console.log(`\n🔫 Sell Unknown Tokens`);
  console.log(`   Wallet:          ${owner.toBase58()}`);
  console.log(`   DryRun:          ${DRY_RUN}`);
  console.log(`   BurnUnsellable:  ${BURN_UNSELLABLE}`);
  console.log(`   MinValue:        ${MIN_VALUE_SOL} SOL`);
  console.log(`   Slippage:        ${SLIPPAGE_BPS / 100}%`);
  console.log(`   JUPITER_API_KEY: ${hasJupiterKey ? 'present' : 'MISSING (free tier may 401)'}`);
  if (!hasJupiterKey) {
    console.log(`   ⚠️  Без JUPITER_API_KEY Jupiter fallback часто возвращает 401.`);
    console.log(`   ⚠️  Добавь JUPITER_API_KEY в .env для надёжного продажи неизвестных токенов.`);
  }
  console.log('');

  // Сканируем оба token-программы (TOKEN_PROGRAM_ID + TOKEN_2022)
  const [t1, t2] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);
  const all = [
    ...t1.value.map(a => ({ ...a, programId: TOKEN_PROGRAM_ID })),
    ...t2.value.map(a => ({ ...a, programId: TOKEN_2022_PROGRAM_ID })),
  ];

  // Фильтр: ненулевой баланс, не wSOL, не в skip-list
  const candidates: {
    ata: PublicKey;
    mint: string;
    amount: bigint;
    decimals: number;
    uiAmount: number;
    programId: PublicKey;
  }[] = [];

  for (const acc of all) {
    const info     = acc.account.data.parsed.info;
    const mint     = info.mint as string;
    const amount   = BigInt(info.tokenAmount.amount as string);
    const decimals = info.tokenAmount.decimals as number;
    const uiAmount = (info.tokenAmount.uiAmount as number) ?? 0;

    if (mint === WSOL_MINT)     continue;
    if (amount === 0n)          continue;
    if (SKIP_MINTS.has(mint))   continue;

    candidates.push({ ata: acc.pubkey, mint, amount, decimals, uiAmount, programId: acc.programId });
  }

  console.log(`   Найдено токенов с ненулевым балансом: ${candidates.length}\n`);
  if (candidates.length === 0) { console.log('   Нечего продавать.'); return; }

  for (const c of candidates) {
    console.log(`   ${c.mint.slice(0, 8)}...  ui=${c.uiAmount.toFixed(2)}  raw=${c.amount}`);
  }
  console.log('');

  if (DRY_RUN) {
    console.log('🔍 DRY-RUN — действия пропущены. Убери --dry-run для выполнения.');
    return;
  }

  let sold = 0, burned = 0, failed = 0, skipped = 0;
  const RENT_PER_ATA = 0.00203928;

  for (const c of candidates) {
    const mintPk = new PublicKey(c.mint);
    console.log(`\n→ ${c.mint.slice(0, 8)}...  (${c.uiAmount.toFixed(2)} tokens)`);

    // 0. On-chain детекция протокола с retry — критично, т.к. state-cache у CLI-процесса пустой
    let detected: Awaited<ReturnType<typeof detectProtocol>> | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        detected = await detectProtocol(connection, mintPk);
        break;
      } catch (e: any) {
        if (attempt === 2) {
          console.log(`  ⚠️  detectProtocol failed (3 retries): ${(e?.message ?? e).slice(0, 80)}`);
        } else {
          await sleep(500 * Math.pow(2, attempt));
        }
      }
    }

    if (detected && detected.protocol !== 'unknown') {
      console.log(`  🔍 Detected: ${detected.protocol}${detected.isComplete ? ' (bonding complete)' : ''}`);
      // Заполняем state-cache вручную, чтобы sellTokenAuto не падал в pump.fun fallback
      if (detected.protocol === 'pumpswap' || detected.isComplete) {
        updateMintState(mintPk, { isPumpSwap: true, pool: detected.pool, migrated: detected.isComplete === true });
      } else if (detected.protocol === 'raydium-cpmm') {
        updateMintState(mintPk, { isRaydiumCpmm: true, raydiumPool: detected.pool });
      } else if (detected.protocol === 'raydium-ammv4') {
        updateMintState(mintPk, { isRaydiumAmmV4: true, raydiumPool: detected.pool });
      } else if (detected.protocol === 'raydium-launch') {
        updateMintState(mintPk, { isRaydiumLaunch: true, raydiumPool: detected.pool });
      }
    } else {
      console.log(`  🔍 Detected: unknown (no pool found on-chain)`);
    }

    // 1. Сначала пробуем sellTokenAuto (pump.fun / PumpSwap / Raydium / directRpc)
    let sellOk = false;
    try {
      const sig = await sellTokenAuto(
        connection, mintPk, payer, c.amount,
        SLIPPAGE_BPS,
        true,    // urgent
        undefined, undefined, undefined, undefined,
        true,    // directRpc — без Jito, экономим на чаевых
      );
      console.log(`  ✅ sellTokenAuto: ${sig}`);
      sold++;
      sellOk = true;
    } catch (e: any) {
      console.log(`  ⚠️  sellTokenAuto failed: ${(e?.message ?? e).slice(0, 120)}`);
    }

    // 2. Если не продали — пробуем Jupiter (quote-check + swap)
    if (!sellOk) {
      try {
        const quoteUrl = `${jupiterBase}/quote?inputMint=${c.mint}&outputMint=${WSOL_MINT}&amount=${c.amount.toString()}&slippageBps=${SLIPPAGE_BPS}&swapMode=ExactIn`;
        const quoteRes = await fetch(quoteUrl, { signal: AbortSignal.timeout(10000) });
        if (!quoteRes.ok) throw new Error(`no route (status ${quoteRes.status})`);
        const quote = await quoteRes.json() as any;
        const outSol = Number(quote.outAmount ?? 0) / 1e9;
        if (outSol < MIN_VALUE_SOL) {
          console.log(`  ⏭  Jupiter est. ${outSol.toFixed(6)} SOL < minValue — пропускаю продажу`);
        } else {
          const sig = await sellTokenJupiter(connection, c.mint, payer, c.amount, SLIPPAGE_BPS);
          console.log(`  ✅ Jupiter: ${sig}  (~${outSol.toFixed(6)} SOL)`);
          sold++;
          sellOk = true;
        }
      } catch (e: any) {
        console.log(`  ⚠️  Jupiter failed: ${(e?.message ?? e).slice(0, 120)}`);
      }
    }

    if (sellOk) {
      // Ждём подтверждения, затем закрываем пустую ATA
      await sleep(3000);
      const closed = await closeAta(connection, payer, c.ata, c.programId);
      if (closed) console.log(`  ♻️  ATA закрыта (+${RENT_PER_ATA} SOL rent)`);
    } else if (BURN_UNSELLABLE) {
      // 3. Продажа невозможна — сжигаем и закрываем
      console.log(`  🔥 Сжигаю ${c.uiAmount.toFixed(2)} токенов и закрываю ATA...`);
      const ok = await burnAndClose(connection, payer, c.ata, mintPk, c.amount, c.programId);
      if (ok) {
        console.log(`  ✅ Сожжено, ATA закрыта (+${RENT_PER_ATA} SOL rent)`);
        burned++;
      } else {
        failed++;
      }
    } else {
      console.log(`  ℹ️  Добавь --burn-unsellable чтобы сжечь токены и вернуть rent (~${RENT_PER_ATA} SOL)`);
      failed++;
    }

    await sleep(1500);
  }

  const rentRecovered = (sold + burned) * RENT_PER_ATA;

  console.log(`\n═══ ИТОГ ═══`);
  console.log(`  Продано:           ${sold}`);
  console.log(`  Сожжено (dust):    ${burned}`);
  console.log(`  Провалено:         ${failed}`);
  console.log(`  Пропущено:         ${skipped}`);
  console.log(`  Rent возвращено:   ~${rentRecovered.toFixed(4)} SOL`);
  console.log('');
}

main().catch(e => { console.error('💥', e); process.exit(1); });
