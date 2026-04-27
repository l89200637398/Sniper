// scripts/cleanup-dust.ts
//
// Закрывает пустые ATA на кошельке, возвращая rent SOL.
// Перенесено из старого src/bot/bot.ts (Telegram-кнопка 🧹 Dust Cleanup),
// чтобы операция была явной CLI-командой с явным argv и логами.
//
// Что делает:
//   1. Сканирует все SPL Token Accounts на кошельке (TOKEN_PROGRAM_ID).
//   2. Отбирает с балансом 0 (uiAmount === 0).
//   3. Исключает mint'ы с открытыми позициями (data/positions.json).
//   4. Закрывает их пачками по 10 (CloseAccount instruction),
//      rent (~0.00203928 SOL/ATA) возвращается на кошелёк.
//
// Использование:
//   npm run cleanup-dust            — реальная очистка
//   npm run cleanup-dust -- --dry   — только показать список, ничего не закрывать
//
// Без npm:
//   npx ts-node scripts/cleanup-dust.ts [--dry]

import dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { config } from '../src/config';

const POSITIONS_FILE = path.join(process.cwd(), 'data', 'positions.json');
const RENT_PER_ATA   = 0.00203928; // empirical
const BATCH_SIZE     = 10;

function loadOpenPositionMints(): Set<string> {
  try {
    if (!fs.existsSync(POSITIONS_FILE)) return new Set();
    const raw = fs.readFileSync(POSITIONS_FILE, 'utf8');
    const arr = JSON.parse(raw) as any[];
    if (!Array.isArray(arr)) return new Set();
    const mints = new Set<string>();
    for (const p of arr) {
      // Position.toJSON() exposes mint either as base58 string or
      // PublicKey-like object. Be defensive — this is best-effort
      // protection, not validation.
      const m =
        typeof p?.mint === 'string'
          ? p.mint
          : p?.mint?.toBase58?.() ?? p?.mint?._bn ? String(p.mint) : null;
      if (m && typeof m === 'string') mints.add(m);
    }
    return mints;
  } catch (e) {
    console.warn(`⚠ Не удалось прочитать ${POSITIONS_FILE}: ${(e as Error).message}`);
    console.warn('  Продолжаю без защиты от закрытия активных позиций — будь внимателен.');
    return new Set();
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry') || process.argv.includes('--dry-run');

  console.log('🧹 Dust Cleanup');
  console.log('───────────────');
  if (dryRun) console.log('Режим: DRY-RUN (ничего не закрываю, только показываю)');
  console.log('');

  const connection = new Connection(config.rpc.url, 'confirmed');
  const payer = Keypair.fromSecretKey(bs58.decode(config.wallet.privateKey));
  const wallet = payer.publicKey;

  console.log(`Кошелёк: ${wallet.toBase58()}`);

  const openMints = loadOpenPositionMints();
  console.log(`Активных позиций (защищены от закрытия): ${openMints.size}`);

  console.log('Получаю список SPL token accounts...');
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet, {
    programId: TOKEN_PROGRAM_ID,
  });

  const dustAccounts: Array<{ pubkey: PublicKey; mint: string }> = [];
  for (const { pubkey, account } of tokenAccounts.value) {
    const parsed = account.data.parsed?.info;
    if (!parsed) continue;
    const mint = parsed.mint as string;
    const uiAmount = Number(parsed.tokenAmount?.uiAmount ?? 0);

    if (openMints.has(mint)) continue;
    if (uiAmount === 0) {
      dustAccounts.push({ pubkey, mint });
    }
  }

  console.log(`Всего token accounts: ${tokenAccounts.value.length}`);
  console.log(`Найдено dust (баланс 0): ${dustAccounts.length}`);

  if (dustAccounts.length === 0) {
    console.log('\n✅ Кошелёк чист, закрывать нечего.');
    return;
  }

  console.log('\nПервые 20:');
  for (const a of dustAccounts.slice(0, 20)) {
    console.log(`  ${a.mint}`);
  }
  if (dustAccounts.length > 20) console.log(`  ... и ещё ${dustAccounts.length - 20}`);

  if (dryRun) {
    console.log('\n— DRY-RUN, ничего не отправляю. Запусти без --dry чтобы реально закрыть.');
    return;
  }

  console.log(`\nЗакрываю пачками по ${BATCH_SIZE}...`);

  let closed = 0;
  let failedBatches = 0;

  for (let i = 0; i < dustAccounts.length; i += BATCH_SIZE) {
    const batch = dustAccounts.slice(i, i + BATCH_SIZE);
    const tx = new Transaction();
    for (const acc of batch) {
      tx.add(createCloseAccountInstruction(acc.pubkey, wallet, wallet));
    }

    try {
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet;
      tx.sign(payer);

      const txId = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 2,
      });
      console.log(`  ✓ batch ${i / BATCH_SIZE + 1}: ${batch.length} accounts, tx=${txId.slice(0, 8)}`);
      closed += batch.length;
    } catch (err) {
      console.error(`  ✗ batch ${i / BATCH_SIZE + 1} failed:`, (err as Error).message);
      failedBatches++;
    }
  }

  const rentRecovered = closed * RENT_PER_ATA;
  console.log('');
  console.log(`Готово: закрыто ${closed} / ${dustAccounts.length} ATA`);
  console.log(`Возвращено rent: ~${rentRecovered.toFixed(4)} SOL`);
  if (failedBatches > 0) {
    console.log(`⚠ Неудачных пачек: ${failedBatches} — посмотри логи выше.`);
  }
}

main().catch((err) => {
  console.error('❌ Cleanup failed:', err);
  process.exit(1);
});
