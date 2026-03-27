/**
 * scripts/test-trade.ts
 *
 * Тестовый скрипт: купить одну монету и продать её через N секунд.
 * Автоматически определяет протокол (pump.fun bonding curve / PumpSwap AMM).
 *
 * Использование:
 *   npx ts-node scripts/test-trade.ts <MINT_ADDRESS> [HOLD_SECONDS] [ENTRY_SOL]
 *
 * Пример:
 *   npx ts-node scripts/test-trade.ts 7d4vS8zNckZ8r4abc...pump 30 0.01
 */

import dotenv from 'dotenv';
dotenv.config();

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';
import {
  getBondingCurvePDA,
  getGlobalPDA,
  getFeeRecipient,
  getEffectiveFeeRecipient,
  buildBuyInstructionFromCreate,
  getCreatorFromCurveData,
  getCreatorVaultPDA,
  isCashbackEnabled,
  getBondingCurveV2PDA,
} from '../src/trading/buy';
import { sellTokenAuto } from '../src/core/sell-engine';
import { startBlockhashCache, stopBlockhashCache } from '../src/infra/blockhash-cache';
import { startPriorityFeeCache, stopPriorityFeeCache, getCachedPriorityFee } from '../src/infra/priority-fee-cache';
import { sendJitoBundle, warmupJitoCache, resolveTipLamports } from '../src/jito/bundle';
import { BONDING_CURVE_LAYOUT, PUMP_FUN_PROGRAM_ID } from '../src/constants';
import { getMintState } from '../src/core/state-cache';
import { detectProtocol } from '../src/core/detector';          // 👈 НОВЫЙ ИМПОРТ
import { buyTokenPumpSwap } from '../src/trading/pumpSwap';     // 👈 НОВЫЙ ИМПОРТ

// ─── Параметры из командной строки ───────────────────────────────────────────

const MINT_ARG   = process.argv[2];
const HOLD_SEC   = parseInt(process.argv[3] ?? '30', 10);
const ENTRY_SOL  = parseFloat(process.argv[4] ?? '0.01');

if (!MINT_ARG) {
  console.error('Usage: npx ts-node scripts/test-trade.ts <MINT_ADDRESS> [HOLD_SECONDS=30] [ENTRY_SOL=0.01]');
  console.error('');
  console.error('Example:');
  console.error('  npx ts-node scripts/test-trade.ts 7d4vS8zNckZ8r4...pump 30 0.01');
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function step(msg: string) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[${new Date().toISOString()}] ${msg}`);
  console.log('─'.repeat(60));
}

function ok(msg: string)   { console.log(`  ✅ ${msg}`); }
function warn(msg: string) { console.log(`  ⚠️  ${msg}`); }
function err(msg: string)  { console.log(`  ❌ ${msg}`); }
function info(msg: string) { console.log(`  ℹ️  ${msg}`); }

// ─── Главная функция ──────────────────────────────────────────────────────────

async function main() {
  console.log('\n🚀 TEST TRADE SCRIPT');
  console.log(`Mint:       ${MINT_ARG}`);
  console.log(`Hold:       ${HOLD_SEC} seconds`);
  console.log(`Entry SOL:  ${ENTRY_SOL} SOL`);
  console.log(`Network:    ${process.env.RPC_URL?.slice(0, 40)}...`);

  // ── Кошелёк ────────────────────────────────────────────────────────────────
  step('1. Настройка кошелька и подключения');

  const privateKey = process.env.PRIVATE_KEY;
  const publicKey  = process.env.PUBLIC_KEY;
  if (!privateKey) { err('PRIVATE_KEY не задан в .env'); process.exit(1); }

  const payer = Keypair.fromSecretKey(bs58.decode(privateKey));
  info(`Payer: ${payer.publicKey.toBase58()}`);

  if (publicKey && payer.publicKey.toBase58() !== publicKey) {
    err(`Несовпадение ключей! Derived=${payer.publicKey.toBase58()}, PUBLIC_KEY=${publicKey}`);
    process.exit(1);
  }
  ok('Ключи совпадают');

  const connection = new Connection(process.env.RPC_URL!, { commitment: 'processed' });

  // Баланс
  const balanceLamports = await connection.getBalance(payer.publicKey);
  const balanceSOL = balanceLamports / 1e9;
  info(`Баланс: ${balanceSOL.toFixed(6)} SOL`);
  if (balanceSOL < ENTRY_SOL + 0.01) {
    err(`Недостаточно SOL! Нужно минимум ${(ENTRY_SOL + 0.01).toFixed(3)} SOL`);
    process.exit(1);
  }
  ok(`Баланс достаточен`);

  // ── Кеши ───────────────────────────────────────────────────────────────────
  step('2. Инициализация кешей');
  startBlockhashCache(connection);
  startPriorityFeeCache(connection);
  await sleep(600);
  ok('Blockhash cache запущен');
  ok('Priority fee cache запущен');

  // ── Jito прогрев ────────────────────────────────────────────────────────────
  step('3. Jito warmup');
  try {
    await warmupJitoCache();
    const tipLamports = await resolveTipLamports(1.0, false);
    ok(`Jito доступен, текущий tip: ${(tipLamports/1e9).toFixed(6)} SOL`);
  } catch (e) {
    err(`Jito недоступен: ${e}`);
    warn('Продолжаем без Jito (транзакции пойдут через RPC)');
  }

  // ── Данные токена ────────────────────────────────────────────────────────────
  step('4. Получение данных токена');

  const mintPubkey   = new PublicKey(MINT_ARG);
  const bondingCurve = getBondingCurvePDA(mintPubkey);

  info(`Mint:          ${mintPubkey.toBase58()}`);
  info(`BondingCurve:  ${bondingCurve.toBase58()}`);

  // Проверяем mint аккаунт
  const mintInfo = await connection.getAccountInfo(mintPubkey);
  if (!mintInfo) { err(`Mint аккаунт не найден: ${MINT_ARG}`); process.exit(1); }
  const tokenProgramId = mintInfo.owner;
  info(`Token Program: ${tokenProgramId.toBase58()}`);

  const mintState = getMintState(mintPubkey);
  mintState.tokenProgramId = tokenProgramId;

  // Проверяем bonding curve
  const curveAcc = await connection.getAccountInfo(bondingCurve);
  let isComplete = false;
  let isMayhem = false;
  let virtualSolReserves = 0n;
  let virtualTokenReserves = 0n;
  let realSolReserves = 0n;
  let realTokenReserves = 0n;
  let creatorPubkey: PublicKey | null = null;

  if (curveAcc) {
    ok(`Bonding curve найдена (${curveAcc.data.length} bytes)`);

    // Парсим резервы
    virtualTokenReserves = curveAcc.data.readBigUInt64LE(BONDING_CURVE_LAYOUT.VIRTUAL_TOKEN_RESERVES_OFFSET);
    virtualSolReserves   = curveAcc.data.readBigUInt64LE(BONDING_CURVE_LAYOUT.VIRTUAL_SOL_RESERVES_OFFSET);
    realSolReserves      = curveAcc.data.readBigUInt64LE(BONDING_CURVE_LAYOUT.REAL_SOL_RESERVES_OFFSET);
    realTokenReserves    = curveAcc.data.readBigUInt64LE(BONDING_CURVE_LAYOUT.REAL_TOKEN_RESERVES_OFFSET);
    isComplete           = curveAcc.data[BONDING_CURVE_LAYOUT.COMPLETE_OFFSET] === 1;
    isMayhem = curveAcc.data[BONDING_CURVE_LAYOUT.IS_MAYHEM_MODE_OFFSET] === 1;
    const isCashback = isCashbackEnabled(curveAcc.data);
    try {
      creatorPubkey = getCreatorFromCurveData(curveAcc.data);
    } catch (e) {
      warn(`Не удалось прочитать creator из кривой: ${e}`);
    }

    info(`virtualSolReserves:   ${(Number(virtualSolReserves)/1e9).toFixed(6)} SOL`);
    info(`virtualTokenReserves: ${(Number(virtualTokenReserves)/1e6).toFixed(0)} (×10⁶)`);
    info(`realSolReserves:      ${(Number(realSolReserves)/1e9).toFixed(6)} SOL`);
    info(`realTokenReserves:    ${(Number(realTokenReserves)/1e6).toFixed(0)} (×10⁶)`);
    info(`complete:             ${isComplete}`);
    info(`is_mayhem_mode:       ${isMayhem}`);
    info(`cashback_enabled:     ${isCashback}`);
    if (creatorPubkey) {
      const pumpProgramPubkey = new PublicKey(PUMP_FUN_PROGRAM_ID);
      const creatorVaultPDA = getCreatorVaultPDA(creatorPubkey, pumpProgramPubkey);
      info(`Creator:       ${creatorPubkey.toBase58()}`);
      info(`CreatorVault:  ${creatorVaultPDA.toBase58()}`);
    }

    if (isComplete) {
      warn('Кривая помечена как complete — токен готов к миграции или уже мигрировал');
    }
    if (Number(realSolReserves) < 0.1 * 1e9) {
      warn('realSolReserves очень мал — кривая почти пуста, покупка рискованна');
    }
  } else {
    warn('Bonding curve не найдена — токен, вероятно, уже на PumpSwap');
  }

  // ── Определение протокола ───────────────────────────────────────────────────
  step('4b. Определение протокола');
  const protocolInfo = await detectProtocol(connection, mintPubkey);
  info(`Protocol from on-chain: ${protocolInfo.protocol}`);
  let usePumpSwap = false;

  // Решаем, через какой протокол покупать
  if (protocolInfo.protocol === 'pumpswap') {
    usePumpSwap = true;
    info('✅ Токен уже на PumpSwap — будем покупать через AMM');
  } else if (protocolInfo.protocol === 'pumpfun') {
    if (isComplete && virtualSolReserves === 0n && virtualTokenReserves === 0n) {
      usePumpSwap = true;
      info('⚠️  Bonding curve complete и резервы нулевые — токен мигрировал, используем PumpSwap');
    } else {
      info('✅ Токен на pump.fun bonding curve — будем покупать через bonding curve');
    }
  } else {
    err('Не удалось определить протокол токена');
    process.exit(1);
  }

  // ── feeRecipient (только для pump.fun) ─────────────────────────────────────
  let feeRecipient: PublicKey | undefined;
  if (!usePumpSwap) {
    step('5. Получение feeRecipient');
    try {
      const defaultFeeRecipient = await getFeeRecipient(connection);
      if (curveAcc) {
        feeRecipient = getEffectiveFeeRecipient(curveAcc.data, defaultFeeRecipient);
      } else {
        feeRecipient = defaultFeeRecipient;
      }
      ok(`feeRecipient: ${feeRecipient.toBase58()}`);
    } catch (e) {
      err(`Не удалось получить feeRecipient: ${e}`);
      process.exit(1);
    }
  }

  // ── ATA (всегда нужно) ──────────────────────────────────────────────────────
  step('6. Проверка/создание ATA');
  const ata = await getAssociatedTokenAddress(mintPubkey, payer.publicKey, false, tokenProgramId);
  info(`ATA: ${ata.toBase58()}`);

  const ataInfo = await connection.getAccountInfo(ata);
  if (ataInfo) {
    ok('ATA уже существует');
  } else {
    info('ATA не существует — создаём...');
    const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, ata, payer.publicKey, mintPubkey, tokenProgramId
    );
    const { blockhash } = await connection.getLatestBlockhash('processed');
    const createAtaTx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: blockhash,
        instructions: [createAtaIx],
      }).compileToV0Message()
    );
    createAtaTx.sign([payer]);
    const createAtaSig = await connection.sendRawTransaction(createAtaTx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
    info(`ATA create tx: ${createAtaSig}`);
    await sleep(2000);
    ok('ATA создан');
  }

  // ── ПОКУПКА (ветвление) ────────────────────────────────────────────────────
  step(`7. ПОКУПКА через ${usePumpSwap ? 'PumpSwap AMM' : 'pump.fun bonding curve'}`);

  let buyTxId: string;
  const priorityFee = getCachedPriorityFee();

  if (usePumpSwap) {
    // Покупка через PumpSwap
    const pumpSwapCfg = {
      entryAmountSol: ENTRY_SOL,
      slippageBps: 3000, // 30% для теста
    };
    info(`Входная сумма:  ${ENTRY_SOL} SOL`);
    info(`Slippage:       ${pumpSwapCfg.slippageBps / 100}%`);
    try {
      buyTxId = await buyTokenPumpSwap(
        connection,
        mintPubkey,
        payer,
        pumpSwapCfg.entryAmountSol,
        pumpSwapCfg.slippageBps
      );
      ok(`PUMP SWAP BUY sent: ${buyTxId}`);
    } catch (e) {
      err(`PumpSwap buy failed: ${e}`);
      process.exit(1);
    }
  } else {
    // Покупка через pump.fun bonding curve
    if (!curveAcc) {
      err('Нет данных bonding curve для pump.fun покупки');
      process.exit(1);
    }
    if (virtualSolReserves === 0n || virtualTokenReserves === 0n) {
      err('Резервы нулевые — невозможно купить через bonding curve');
      process.exit(1);
    }

    const slippageBps = 3000; // 30% для теста
    info(`Входная сумма:  ${ENTRY_SOL} SOL`);
    info(`Slippage:       ${slippageBps / 100}%`);

    const programId = new PublicKey(PUMP_FUN_PROGRAM_ID);
    const eventAuthority = PublicKey.findProgramAddressSync(
      [Buffer.from('__event_authority')],
      programId
    )[0];

    if (!creatorPubkey) {
      err('Не удалось получить creator публичный ключ');
      process.exit(1);
    }

    const buyIx = buildBuyInstructionFromCreate({
      mint:                 mintPubkey,
      bondingCurve,
      creator:              creatorPubkey,
      userAta:              ata,
      user:                 payer.publicKey,
      amountSol:            ENTRY_SOL,
      slippageBps,
      virtualSolReserves,
      virtualTokenReserves,
      feeRecipient:         feeRecipient!,
      eventAuthority,
      tokenProgramId,
      isMayhem,
    });

    // Отладочный вывод
    console.log(`  🔍 Instruction programId: ${buyIx.programId.toBase58()}`);
    console.log(`  🔍 Total keys: ${buyIx.keys.length}  (ожидается 17)`);
    console.log(`  🔍 Key at [11] (program): ${buyIx.keys[11]?.pubkey.toBase58() ?? 'N/A'}`);
    console.log('  🔑 ALL KEYS:');
    const KEY_NAMES = [
      'global', 'feeRecipient', 'mint', 'bondingCurve', 'vault', 'userAta',
      'user', 'systemProgram', 'tokenProgram',
      'creatorVault',           // [9]
      'eventAuthority',         // [10]
      'program',                // [11]
      'globalVolumeAcc',        // [12]
      'userVolumeAcc',          // [13]
      'feeConfig',              // [14]
      'feeProgram',             // [15]
    ];
    buyIx.keys.forEach((k, i) => {
      const name = KEY_NAMES[i] ?? `unknown_${i}`;
      console.log(`    [${i.toString().padStart(2)}] ${name.padEnd(24)} ${k.pubkey.toBase58()} ${k.isSigner ? 'SIGNER' : ''} ${k.isWritable ? 'MUT' : 'RO'}`);
    });

    const createAtaIxForBundle = createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, ata, payer.publicKey, mintPubkey, tokenProgramId
    );

    const buildBuyTx = async (): Promise<VersionedTransaction> => {
      const { blockhash } = await connection.getLatestBlockhash('processed');
      const message = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 260_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
          createAtaIxForBundle,
          buyIx,
        ],
      }).compileToV0Message();
      const tx = new VersionedTransaction(message);
      tx.sign([payer]);
      return tx;
    };

    // Симуляция перед отправкой
    info('Симуляция транзакции...');
    const simTx = await buildBuyTx();
    const sim = await connection.simulateTransaction(simTx, { sigVerify: false });
    if (sim.value.err) {
      err(`СИМУЛЯЦИЯ ПРОВАЛИЛАСЬ: ${JSON.stringify(sim.value.err)}`);
      info('Логи симуляции:');
      sim.value.logs?.forEach(l => console.log('  ' + l));
      process.exit(1);
    }
    ok(`Симуляция OK (${sim.value.unitsConsumed} CU)`);

    // Отправка через Jito
    info('Отправка через Jito bundle...');
    try {
      const buyTx = await buildBuyTx();
      buyTxId = await sendJitoBundle(buyTx, payer, 1.0, false);
      ok(`BUY bundle sent: ${buyTxId}`);
      info(`Solscan: https://solscan.io/tx/${buyTxId}`);
      info(`Jito Explorer: https://explorer.jito.wtf/bundle/${buyTxId}`);
    } catch (e) {
      err(`Jito bundle failed: ${e}`);
      warn('Пробуем через обычный RPC...');
      const fallbackTx = await buildBuyTx();
      buyTxId = await connection.sendRawTransaction(fallbackTx.serialize(), {
        skipPreflight: true,
        maxRetries: 3,
      });
      ok(`BUY tx sent via RPC: ${buyTxId}`);
    }

    // Ждём подтверждения
    info('Ожидание подтверждения...');
    const { blockhash: buyBlockhash, lastValidBlockHeight: buyBlockHeight } = await connection.getLatestBlockhash('confirmed');
    try {
      const buyConfirm = await Promise.race([
        connection.confirmTransaction({
          signature: buyTxId,
          blockhash: buyBlockhash,
          lastValidBlockHeight: buyBlockHeight,
        }, 'confirmed'),
        sleep(30_000).then(() => { throw new Error('timeout 30s'); }),
      ]) as any;

      if (buyConfirm.value?.err) {
        err(`BUY ПРОВАЛИЛСЯ: ${JSON.stringify(buyConfirm.value.err)}`);
        const txInfo = await connection.getTransaction(buyTxId, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });
        if (txInfo?.meta?.logMessages) {
          info('Логи транзакции:');
          txInfo.meta.logMessages.forEach((l: string) => console.log('  ' + l));
        }
        process.exit(1);
      }
      ok('BUY ПОДТВЕРЖДЁН!');
    } catch (e) {
      err(`Подтверждение не получено за 30с: ${e}`);
      warn('Транзакция могла пройти — проверь вручную:');
      info(`https://solscan.io/tx/${buyTxId}`);
    }
  }

  // ── Читаем фактический баланс токенов после покупки ─────────────────────────
  await sleep(2000);
  let tokenAmount = 0;
  let tokenDecimals = 6;
  try {
    const tokenBalance = await connection.getTokenAccountBalance(ata);
    tokenAmount  = Number(tokenBalance.value.uiAmount ?? 0);
    tokenDecimals = tokenBalance.value.decimals;
    if (tokenAmount > 0) {
      ok(`Куплено: ${tokenAmount.toFixed(0)} токенов (decimals=${tokenDecimals})`);
    } else {
      warn('Баланс токенов = 0 после покупки. Транзакция могла не пройти.');
    }
  } catch (e) {
    warn(`Не удалось прочитать баланс токенов: ${e}`);
  }

  const balanceAfterBuy = await connection.getBalance(payer.publicKey);
  info(`Баланс SOL после покупки: ${(balanceAfterBuy/1e9).toFixed(6)} SOL`);
  info(`Потрачено на покупку:     ${((balanceLamports - balanceAfterBuy)/1e9).toFixed(6)} SOL`);

  if (tokenAmount === 0) {
    err('Токены не получены — продавать нечего. Проверь транзакцию вручную.');
    stopBlockhashCache();
    stopPriorityFeeCache();
    process.exit(1);
  }

  // ── ПАУЗА ─────────────────────────────────────────────────────────────────────
  step(`8. Ожидание ${HOLD_SEC} секунд перед продажей`);
  for (let i = HOLD_SEC; i > 0; i -= 5) {
    const wait = Math.min(i, 5);
    await sleep(wait * 1000);
    const remaining = i - wait;
    if (remaining > 0) {
      process.stdout.write(`  ⏳ Осталось ${remaining}с...\r`);
    }
  }
  console.log('');
  ok('Готов к продаже');

  // ── ПРОДАЖА (всегда через sellTokenAuto) ─────────────────────────────────────
  step('9. ПРОДАЖА');

  const amountRaw = BigInt(Math.floor(tokenAmount * 10 ** tokenDecimals));
  info(`Продаём: ${tokenAmount.toFixed(0)} токенов (raw: ${amountRaw})`);

  const balanceBeforeSell = await connection.getBalance(payer.publicKey);

  let sellTxId: string;
  try {
    sellTxId = await sellTokenAuto(
      connection,
      mintPubkey,
      payer,
      amountRaw,
      3000, // 30% slippage для теста
      false,
      feeRecipient,  // для PumpSwap этот параметр игнорируется, но можно передать
      isMayhem
    );
    ok(`SELL bundle sent: ${sellTxId}`);
    info(`Solscan: https://solscan.io/tx/${sellTxId}`);
  } catch (e) {
    err(`SELL ПРОВАЛИЛСЯ: ${e}`);
    process.exit(1);
  }

  // Ждём подтверждения продажи
  info('Ожидание подтверждения продажи...');
  const { blockhash: sellBlockhash, lastValidBlockHeight: sellBlockHeight } = await connection.getLatestBlockhash('confirmed');
  try {
    const sellConfirm = await Promise.race([
      connection.confirmTransaction({
        signature: sellTxId,
        blockhash: sellBlockhash,
        lastValidBlockHeight: sellBlockHeight,
      }, 'confirmed'),
      sleep(30_000).then(() => { throw new Error('timeout 30s'); }),
    ]) as any;

    if (sellConfirm.value?.err) {
      err(`SELL ПРОВАЛИЛСЯ on-chain: ${JSON.stringify(sellConfirm.value.err)}`);
    } else {
      ok('SELL ПОДТВЕРЖДЁН!');
    }
  } catch (e) {
    warn(`Подтверждение продажи не получено за 30с: ${e}`);
    info(`Проверь вручную: https://solscan.io/tx/${sellTxId}`);
  }

  // ── ИТОГ ─────────────────────────────────────────────────────────────────────
  step('10. ИТОГИ');

  await sleep(2000);
  const balanceFinal = await connection.getBalance(payer.publicKey);
  const spent  = (balanceLamports - balanceBeforeSell) / 1e9;
  const earned = (balanceFinal    - balanceBeforeSell) / 1e9;
  const pnl    = (balanceFinal    - balanceLamports)   / 1e9;

  info(`Начальный баланс: ${(balanceLamports/1e9).toFixed(6)} SOL`);
  info(`Конечный баланс:  ${(balanceFinal/1e9).toFixed(6)} SOL`);
  info(`Потрачено (buy):  ${spent.toFixed(6)} SOL`);
  info(`Получено (sell):  ${earned.toFixed(6)} SOL`);
  console.log('');
  if (pnl >= 0) {
    ok(`PnL: +${pnl.toFixed(6)} SOL`);
  } else {
    warn(`PnL: ${pnl.toFixed(6)} SOL (включая комиссии)`);
  }

  console.log('\n✅ ТЕСТ ЗАВЕРШЁН\n');

  stopBlockhashCache();
  stopPriorityFeeCache();
  process.exit(0);
}

main().catch(e => {
  console.error('\n💥 НЕОБРАБОТАННАЯ ОШИБКА:', e);
  stopBlockhashCache();
  stopPriorityFeeCache();
  process.exit(1);
});