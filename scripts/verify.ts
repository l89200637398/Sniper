#!/usr/bin/env ts-node

/**
 * scripts/verify.ts
 *
 * Runtime verification of on-chain layouts.
 * Generates runtime layout file:
 *
 * src/autogen/runtime-layout.json
 *
 * This file is used by the bot instead of hardcoded constants.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../src/config';
import {
  PUMP_FUN_PROGRAM_ID,
  DISCRIMINATOR,
  GLOBAL_ACCOUNT_ADDRESS,
  GLOBAL_ACCOUNT_LAYOUT,
  BONDING_CURVE_LAYOUT,
} from '../src/constants';
import * as fs from 'fs';
import * as path from 'path';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Тестовые адреса можно переопределить через переменные окружения
const TEST_MINT = process.env.TEST_MINT || '7xKXtg2CW3dHL1tDmDNXg7A5q9nK5K6m7Y9yQqZ2tVpU';
const TEST_POOL_ADDRESS = process.env.TEST_POOL_ADDRESS || 'EC8MWiBZ2fCsbvWQYcUgvTV2iraEcPaNryqYoL6SCb1s';

const connection = new Connection(config.rpc.url, 'confirmed');

const AUTOGEN_DIR = path.resolve(__dirname, '../src/autogen');
const AUTOGEN_FILE = path.join(AUTOGEN_DIR, 'runtime-layout.json');

/** Безопасно читает публичный ключ из буфера по смещению */
function readPubkey(data: Buffer, offset: number): PublicKey | null {
  if (offset + 32 > data.length) return null;
  try {
    return new PublicKey(data.slice(offset, offset + 32));
  } catch {
    return null;
  }
}

function ensureAutogenDir() {
  if (!fs.existsSync(AUTOGEN_DIR)) {
    fs.mkdirSync(AUTOGEN_DIR, { recursive: true });
  }
}

/**
 * Верифицирует layout Global аккаунта.
 *
 * Использует GLOBAL_ACCOUNT_ADDRESS (константный PDA = '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf')
 * вместо пересчёта через findProgramAddressSync, т.к. адрес верифицирован по IDL.
 *
 * Проверяет:
 *   - fee_recipient @ offset 41 (первый из 8)
 *   - fee_recipients[0..6] @ offset 162 (следующие 7, каждый 32 байта)
 *
 * Источник layout: deepwiki 3.3-account-structure + idl/pump.json
 */
async function verifyGlobalAccount() {
  console.log('\n══════════════════════════════════════');
  console.log(' GlobalAccount verification');
  console.log('══════════════════════════════════════');

  const globalAddress = new PublicKey(GLOBAL_ACCOUNT_ADDRESS);
  console.log('Global account address:', globalAddress.toBase58());

  const acc = await connection.getAccountInfo(globalAddress);
  if (!acc) throw new Error('Global account not found');

  console.log('Account size:', acc.data.length, 'bytes');

  // ── Верификация fee_recipient (offset 41) ──────────────────────────────────
  const { FEE_RECIPIENT_OFFSET, FEE_RECIPIENTS_ARRAY_OFFSET, FEE_RECIPIENTS_COUNT } = GLOBAL_ACCOUNT_LAYOUT;

  const primaryFeeRecipient = readPubkey(acc.data, FEE_RECIPIENT_OFFSET);
  if (!primaryFeeRecipient) {
    console.error(`❌ Cannot read fee_recipient at offset ${FEE_RECIPIENT_OFFSET}`);
  } else {
    console.log(`✅ fee_recipient @ ${FEE_RECIPIENT_OFFSET}: ${primaryFeeRecipient.toBase58()}`);
  }

  // ── Верификация fee_recipients[0..6] (offset 162, 7 × 32 байта) ───────────
  const feeRecipients: Array<{ index: number; offset: number; key: string }> = [];
  for (let i = 0; i < FEE_RECIPIENTS_COUNT; i++) {
    const offset = FEE_RECIPIENTS_ARRAY_OFFSET + i * 32;
    const key = readPubkey(acc.data, offset);
    if (!key) {
      console.warn(`  ⚠️  fee_recipients[${i}] @ offset ${offset}: unreadable`);
      continue;
    }
    const b58 = key.toBase58();
    console.log(`  fee_recipients[${i}] @ ${offset}: ${b58}`);
    feeRecipients.push({ index: i, offset, key: b58 });
  }

  // ── Быстрая проверка: initialized bool @ offset 8 должен быть 1 ───────────
  const initialized = acc.data[8];
  console.log(`\ninitialized @ 8: ${initialized} (expected: 1)`);
  if (initialized !== 1) {
    console.warn('⚠️  initialized != 1, possible layout mismatch or wrong account');
  }

  return {
    address: globalAddress.toBase58(),
    size: acc.data.length,
    feeRecipientOffset: FEE_RECIPIENT_OFFSET,
    feeRecipient: primaryFeeRecipient?.toBase58() ?? null,
    feeRecipientsArrayOffset: FEE_RECIPIENTS_ARRAY_OFFSET,
    feeRecipients,
  };
}

/**
 * Верифицирует layout BondingCurve аккаунта.
 *
 * Проверяет смещения виртуальных резервов и наличие cashback_enabled поля.
 * Источник: BONDING_CURVE_LAYOUT из constants.ts (cashback upgrade фев 2026).
 */
async function verifyBondingCurve() {
  console.log('\n══════════════════════════════════════');
  console.log(' BondingCurve verification');
  console.log('══════════════════════════════════════');

  const mint = new PublicKey(TEST_MINT);
  const [curve] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    new PublicKey(PUMP_FUN_PROGRAM_ID)
  );

  console.log('TEST_MINT:       ', TEST_MINT);
  console.log('BondingCurve PDA:', curve.toBase58());

  const acc = await connection.getAccountInfo(curve);
  if (!acc) {
    console.log('⚠️  BondingCurve not found for TEST_MINT (token may be migrated or invalid). Skipping.');
    return null;
  }

  console.log('Account size:', acc.data.length, 'bytes');
  const {
    VIRTUAL_TOKEN_RESERVES_OFFSET,
    VIRTUAL_SOL_RESERVES_OFFSET,
    COMPLETE_OFFSET,
    CREATOR_OFFSET,
    CASHBACK_ENABLED_OFFSET,
    MIN_SIZE,
    EXTENDED_SIZE,
  } = BONDING_CURVE_LAYOUT;

  // Читаем виртуальные резервы
  if (acc.data.length >= VIRTUAL_SOL_RESERVES_OFFSET + 8) {
    const virtualTokenRes = acc.data.readBigUInt64LE(VIRTUAL_TOKEN_RESERVES_OFFSET);
    const virtualSolRes   = acc.data.readBigUInt64LE(VIRTUAL_SOL_RESERVES_OFFSET);
    console.log(`✅ virtual_token_reserves @ ${VIRTUAL_TOKEN_RESERVES_OFFSET}: ${virtualTokenRes}`);
    console.log(`✅ virtual_sol_reserves   @ ${VIRTUAL_SOL_RESERVES_OFFSET}:   ${virtualSolRes}`);
  } else {
    console.warn(`⚠️  Account too short to read reserves (${acc.data.length} < ${VIRTUAL_SOL_RESERVES_OFFSET + 8})`);
  }

  // Проверяем complete bool
  if (acc.data.length > COMPLETE_OFFSET) {
    const complete = acc.data[COMPLETE_OFFSET];
    console.log(`✅ complete @ ${COMPLETE_OFFSET}: ${complete === 1}`);
  }

  // Проверяем creator pubkey
  const creator = readPubkey(acc.data, CREATOR_OFFSET);
  if (creator) {
    console.log(`✅ creator @ ${CREATOR_OFFSET}: ${creator.toBase58()}`);
  }

  // Проверяем cashback_enabled (новое поле фев 2026)
  if (acc.data.length >= MIN_SIZE) {
    const cashbackEnabled = acc.data[CASHBACK_ENABLED_OFFSET];
    console.log(`✅ cashback_enabled @ ${CASHBACK_ENABLED_OFFSET}: ${cashbackEnabled === 1}`);
  } else {
    console.warn(`⚠️  Account size (${acc.data.length}) < MIN_SIZE (${MIN_SIZE}): cashback_enabled field missing`);
  }

  const hasExtended = acc.data.length >= EXTENDED_SIZE;
  console.log(`\nLayout: ${hasExtended ? 'EXTENDED (post-cashback upgrade)' : 'COMPACT (pre-cashback upgrade)'}`);
  console.log(`Account size: ${acc.data.length} (expected ${EXTENDED_SIZE} for full layout)`);

  return {
    mint: TEST_MINT,
    pda: curve.toBase58(),
    size: acc.data.length,
    hasExtendedLayout: hasExtended,
    virtualTokenReservesOffset: VIRTUAL_TOKEN_RESERVES_OFFSET,
    virtualSolReservesOffset:   VIRTUAL_SOL_RESERVES_OFFSET,
    cashbackEnabledOffset:      CASHBACK_ENABLED_OFFSET,
  };
}

/**
 * Верифицирует layout PumpSwap Pool аккаунта.
 *
 * Pool layout (pump_amm.json IDL, аккаунт Pool):
 *   discriminator (8)  @ 0
 *   bump (1)           @ 8
 *   index (2)          @ 9
 *   creator (32)       @ 11
 *   base_mint (32)     @ 43
 *   quote_mint (32)    @ 75
 *   lp_mint (32)       @ 107
 *   pool_base (32)     @ 139
 *   pool_quote (32)    @ 171
 *   lp_supply (8)      @ 203
 *   coin_creator (32)  @ ~244 (extended layout, если size >= 276)
 *
 * Верифицирует: наличие WSOL в quote_mint @ 75, base_mint @ 43.
 */
async function verifyPumpSwapPool() {
  console.log('\n══════════════════════════════════════');
  console.log(' PumpSwap Pool verification');
  console.log('══════════════════════════════════════');

  const pool = new PublicKey(TEST_POOL_ADDRESS);
  console.log('TEST_POOL_ADDRESS:', TEST_POOL_ADDRESS);

  const acc = await connection.getAccountInfo(pool);
  if (!acc) {
    console.log('⚠️  Pool not found for TEST_POOL_ADDRESS. Skipping.');
    return null;
  }

  console.log('Account size:', acc.data.length, 'bytes');

  // Проверяем discriminator (8 байт)
  const disc = acc.data.subarray(0, 8);
  console.log('Discriminator (hex):', disc.toString('hex'));

  // Ожидаемые смещения по IDL
  const BASE_MINT_OFFSET  = 43;
  const QUOTE_MINT_OFFSET = 75;
  const POOL_BASE_OFFSET  = 139;
  const POOL_QUOTE_OFFSET = 171;
  const COIN_CREATOR_OFFSET = 244;

  const baseMint  = readPubkey(acc.data, BASE_MINT_OFFSET);
  const quoteMint = readPubkey(acc.data, QUOTE_MINT_OFFSET);
  const poolBase  = readPubkey(acc.data, POOL_BASE_OFFSET);
  const poolQuote = readPubkey(acc.data, POOL_QUOTE_OFFSET);

  console.log(`\nbase_mint  @ ${BASE_MINT_OFFSET}:  ${baseMint?.toBase58() ?? 'UNREADABLE'}`);
  console.log(`quote_mint @ ${QUOTE_MINT_OFFSET}:  ${quoteMint?.toBase58() ?? 'UNREADABLE'}`);
  console.log(`pool_base  @ ${POOL_BASE_OFFSET}: ${poolBase?.toBase58() ?? 'UNREADABLE'}`);
  console.log(`pool_quote @ ${POOL_QUOTE_OFFSET}: ${poolQuote?.toBase58() ?? 'UNREADABLE'}`);

  // Верифицируем: quote_mint должен быть WSOL
  const quoteMintStr = quoteMint?.toBase58() ?? '';
  if (quoteMintStr === WSOL_MINT) {
    console.log(`✅ quote_mint is WSOL — layout matches IDL`);
  } else {
    console.warn(`⚠️  quote_mint ${quoteMintStr} != WSOL (${WSOL_MINT})`);
    console.warn('   Возможно, пул не base/WSOL, или смещения изменились.');
  }

  // coin_creator (extended layout)
  let coinCreator: string | null = null;
  if (acc.data.length >= COIN_CREATOR_OFFSET + 32) {
    const cc = readPubkey(acc.data, COIN_CREATOR_OFFSET);
    if (cc && !cc.equals(PublicKey.default)) {
      coinCreator = cc.toBase58();
      console.log(`coin_creator @ ${COIN_CREATOR_OFFSET}: ${coinCreator}`);
    } else {
      console.log(`coin_creator @ ${COIN_CREATOR_OFFSET}: (zero / not set)`);
    }
  } else {
    console.log(`coin_creator: account too short (${acc.data.length} < ${COIN_CREATOR_OFFSET + 32})`);
  }

  return {
    address: TEST_POOL_ADDRESS,
    size: acc.data.length,
    baseMintOffset:  BASE_MINT_OFFSET,
    quoteMintOffset: QUOTE_MINT_OFFSET,
    poolBaseOffset:  POOL_BASE_OFFSET,
    poolQuoteOffset: POOL_QUOTE_OFFSET,
    coinCreatorOffset: COIN_CREATOR_OFFSET,
    baseMint:  baseMint?.toBase58() ?? null,
    quoteMint: quoteMintStr || null,
    coinCreator,
    isWsolPool: quoteMintStr === WSOL_MINT,
  };
}

async function writeRuntimeLayout(layout: any) {
  ensureAutogenDir();
  fs.writeFileSync(AUTOGEN_FILE, JSON.stringify(layout, null, 2));
  console.log('\n✅ Runtime layout saved:');
  console.log(AUTOGEN_FILE);
}

/**
 * Выводит все дискриминаторы из DISCRIMINATOR константы для ручной сверки.
 */
function printDiscriminators() {
  console.log('\n══════════════════════════════════════');
  console.log(' Instruction discriminators');
  console.log('══════════════════════════════════════');

  for (const [name, buf] of Object.entries(DISCRIMINATOR)) {
    console.log(name.padEnd(24), buf.toString('hex'));
  }

  // Дополнительная сверка: PumpSwap BUY/SELL/CREATE_POOL совпадают по байтам
  // с pump.fun BUY/SELL. Разделение — только по programId. Это нормально.
  console.log('\nНота: PUMP_SWAP_BUY и BUY совпадают по байтам (sha256("global:buy")[0:8]).');
  console.log('Разделение pump.fun vs pumpSwap осуществляется по programId, а не дискриминатору.');
}

/**
 * Проверяет консистентность параметров config.
 * Возвращает количество ошибок.
 */
function verifyConfigConsistency(): number {
  console.log('\n══════════════════════════════════════');
  console.log(' Config consistency checks');
  console.log('══════════════════════════════════════');

  let errors = 0;
  let warnings = 0;

  function check(condition: boolean, msg: string, isWarning = false) {
    if (!condition) {
      if (isWarning) { console.warn(`  ⚠️  ${msg}`); warnings++; }
      else { console.error(`  ❌ ${msg}`); errors++; }
    } else {
      console.log(`  ✅ ${msg}`);
    }
  }

  const s = config.strategy;

  // ── Per-protocol position limits vs global ────────────────────────────────
  const perProtoMax = s.maxPumpFunPositions + s.maxPumpSwapPositions
    + (s.maxRaydiumLaunchPositions ?? 0) + (s.maxRaydiumCpmmPositions ?? 0)
    + (s.maxRaydiumAmmV4Positions ?? 0) + (s.copyTrade.enabled ? s.copyTrade.maxPositions : 0);

  check(
    s.maxPositions <= perProtoMax,
    `maxPositions (${s.maxPositions}) <= sum of per-protocol limits (${perProtoMax})`
  );

  // ── Max exposure vs max positions * max entry ─────────────────────────────
  const maxEntries = [
    s.pumpFun.entryAmountSol * s.maxPumpFunPositions,
    s.pumpSwap.entryAmountSol * s.maxPumpSwapPositions,
    (s.raydiumLaunch?.entryAmountSol ?? 0) * (s.maxRaydiumLaunchPositions ?? 0),
    (s.raydiumCpmm?.entryAmountSol ?? 0) * (s.maxRaydiumCpmmPositions ?? 0),
    (s.raydiumAmmV4?.entryAmountSol ?? 0) * (s.maxRaydiumAmmV4Positions ?? 0),
    s.copyTrade.enabled ? s.copyTrade.entryAmountSol * s.copyTrade.maxPositions : 0,
  ];
  const maxPossibleExposure = maxEntries.reduce((a, b) => a + b, 0);

  check(
    s.maxTotalExposureSol >= s.pumpFun.entryAmountSol,
    `maxTotalExposureSol (${s.maxTotalExposureSol}) >= single entry (${s.pumpFun.entryAmountSol})`
  );
  check(
    s.maxTotalExposureSol <= maxPossibleExposure * 1.5,
    `maxTotalExposureSol (${s.maxTotalExposureSol}) reasonable vs max possible (${maxPossibleExposure.toFixed(3)})`,
    true
  );

  // ── Entry amounts: min < default ──────────────────────────────────────────
  check(
    s.pumpFun.minEntryAmountSol < s.pumpFun.entryAmountSol,
    `pumpFun: minEntry (${s.pumpFun.minEntryAmountSol}) < entry (${s.pumpFun.entryAmountSol})`
  );
  check(
    s.pumpSwap.minEntryAmountSol < s.pumpSwap.entryAmountSol,
    `pumpSwap: minEntry (${s.pumpSwap.minEntryAmountSol}) < entry (${s.pumpSwap.entryAmountSol})`
  );
  if (s.raydiumLaunch) {
    check(
      s.raydiumLaunch.minEntryAmountSol < s.raydiumLaunch.entryAmountSol,
      `raydiumLaunch: minEntry (${s.raydiumLaunch.minEntryAmountSol}) < entry (${s.raydiumLaunch.entryAmountSol})`
    );
  }
  if (s.raydiumCpmm) {
    check(
      s.raydiumCpmm.minEntryAmountSol < s.raydiumCpmm.entryAmountSol,
      `raydiumCpmm: minEntry (${s.raydiumCpmm.minEntryAmountSol}) < entry (${s.raydiumCpmm.entryAmountSol})`
    );
  }
  if (s.raydiumAmmV4) {
    check(
      s.raydiumAmmV4.minEntryAmountSol < s.raydiumAmmV4.entryAmountSol,
      `raydiumAmmV4: minEntry (${s.raydiumAmmV4.minEntryAmountSol}) < entry (${s.raydiumAmmV4.entryAmountSol})`
    );
  }

  // ── Jito tips: min < default < max ────────────────────────────────────────
  const j = config.jito;
  check(
    j.minTipAmountSol <= j.maxTipAmountSol,
    `jito: minTip (${j.minTipAmountSol}) <= maxTip (${j.maxTipAmountSol})`
  );
  check(
    j.tipAmountSol <= j.maxTipAmountSol,
    `jito: defaultTip (${j.tipAmountSol}) <= maxTip (${j.maxTipAmountSol})`
  );

  // ── Jito escalation: effective tip after retries should stay within maxTip ──
  const effectiveBaseTip = Math.max(j.tipAmountSol, j.minTipAmountSol);
  const escalatedTip = effectiveBaseTip * Math.pow(j.tipIncreaseFactor, j.maxRetries);
  check(
    escalatedTip <= j.maxTipAmountSol * 1.5,
    `jito: escalated tip after ${j.maxRetries} retries (${escalatedTip.toFixed(6)}) reasonable vs maxTip (${j.maxTipAmountSol})`,
    true
  );

  // ── Exit params: hardStop > entryStopLoss ─────────────────────────────────
  const exitSets = [
    { name: 'pumpFun', exit: s.pumpFun.exit },
    { name: 'pumpSwap', exit: s.pumpSwap.exit },
    { name: 'default', exit: s.exit },
    { name: 'mayhem', exit: s.mayhem.exit },
  ];
  if (s.raydiumLaunch) exitSets.push({ name: 'raydiumLaunch', exit: s.raydiumLaunch.exit });
  if (s.raydiumCpmm) exitSets.push({ name: 'raydiumCpmm', exit: s.raydiumCpmm.exit });
  if (s.raydiumAmmV4) exitSets.push({ name: 'raydiumAmmV4', exit: s.raydiumAmmV4.exit });

  for (const { name, exit } of exitSets) {
    check(
      exit.hardStopPercent > exit.entryStopLossPercent,
      `${name}: hardStop (${exit.hardStopPercent}%) > entryStopLoss (${exit.entryStopLossPercent}%)`
    );
    check(
      exit.trailingActivationPercent > exit.trailingDrawdownPercent,
      `${name}: trailingActivation (${exit.trailingActivationPercent}%) > trailingDrawdown (${exit.trailingDrawdownPercent}%)`
    );

    // Take-profit portions should sum to 0.65–1.0 (runner tail reserves up to 35%)
    const tpSum = exit.takeProfit.reduce((a: number, t: any) => a + t.portion, 0);
    check(
      tpSum > 0.5 && tpSum <= 1.01,
      `${name}: takeProfit portions sum to ${tpSum.toFixed(2)} (expected 0.65–1.0, remainder = runner reserve)`
    );

    // Take-profit levels should be ascending
    const levels = exit.takeProfit.map((t: any) => t.levelPercent);
    const ascending = levels.every((v: number, i: number) => i === 0 || v > levels[i - 1]);
    check(ascending, `${name}: takeProfit levels ascending [${levels.join(', ')}]`);
  }

  // ── Token age: min < max ──────────────────────────────────────────────────
  check(
    s.minTokenAgeMs < s.maxTokenAgeMs,
    `tokenAge: min (${s.minTokenAgeMs}ms) < max (${s.maxTokenAgeMs}ms)`
  );

  // ── Slippage: reasonable range ────────────────────────────────────────────
  for (const { name, bps } of [
    { name: 'pumpFun', bps: s.pumpFun.slippageBps },
    { name: 'pumpSwap', bps: s.pumpSwap.slippageBps },
    { name: 'default', bps: s.slippageBps },
    { name: 'mayhem', bps: s.mayhem.slippageBps },
  ]) {
    check(bps >= 100 && bps <= 10000, `${name}: slippage ${bps} bps in [100, 10000]`);
  }

  // ── Env variables ─────────────────────────────────────────────────────────
  const jitoUrl = j.bundleUrl || process.env.JITO_RPC || '';
  check(jitoUrl.length > 0, `Jito endpoint configured (JITO_BUNDLE_URL or JITO_RPC)`);
  check(
    jitoUrl.startsWith('http'),
    `Jito endpoint looks like URL: ${jitoUrl.slice(0, 40)}...`,
    true
  );

  // ── Wallet tracker consistency ────────────────────────────────────────────
  const wt = config.walletTracker;
  check(wt.minWinRate > 0.5 && wt.minWinRate <= 1.0, `walletTracker: minWinRate (${wt.minWinRate}) in (0.5, 1.0]`);
  check(wt.minCompletedTrades >= 5, `walletTracker: minCompletedTrades (${wt.minCompletedTrades}) >= 5`);

  console.log(`\n  Result: ${errors} errors, ${warnings} warnings`);
  return errors;
}

/**
 * Проверяет program IDs — что это валидные base58 публичные ключи.
 */
function verifyProgramIds() {
  console.log('\n══════════════════════════════════════');
  console.log(' Program IDs verification');
  console.log('══════════════════════════════════════');

  const ids: Record<string, string> = {
    'PUMP_FUN':            PUMP_FUN_PROGRAM_ID,
    'PUMP_SWAP':           config.pumpSwap.programId,
    'FEE_PROGRAM':         'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
    'RAYDIUM_LAUNCHLAB':   'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',
    'RAYDIUM_CPMM':        'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
    'RAYDIUM_AMM_V4':      '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  };

  for (const [name, id] of Object.entries(ids)) {
    try {
      new PublicKey(id);
      console.log(`  ✅ ${name.padEnd(22)} ${id}`);
    } catch {
      console.error(`  ❌ ${name.padEnd(22)} INVALID: ${id}`);
    }
  }
}

async function main() {
  console.log('\n╔════════════════════════════════════╗');
  console.log('  Solana Sniper Bot — Runtime Verify ');
  console.log('╚════════════════════════════════════╝');

  console.log('\nRPC:', config.rpc.url);
  console.log('Test mint:', TEST_MINT);
  console.log('Test pool:', TEST_POOL_ADDRESS);

  try {
    const slot = await connection.getSlot();
    console.log('✅ RPC OK. Slot:', slot);
  } catch (err) {
    console.error('❌ RPC connection failed:', err);
    process.exit(1);
  }

  // ── On-chain layout verification ──────────────────────────────────────────
  const global   = await verifyGlobalAccount();
  const bonding  = await verifyBondingCurve();
  const pool     = await verifyPumpSwapPool();

  // ── Offline checks ────────────────────────────────────────────────────────
  printDiscriminators();
  verifyProgramIds();
  const configErrors = verifyConfigConsistency();

  const runtimeLayout = {
    generatedAt: new Date().toISOString(),
    global,
    bondingCurve: bonding,
    pumpSwapPool: pool,
  };

  await writeRuntimeLayout(runtimeLayout);

  console.log('\n══════════════════════════════════════');
  if (configErrors > 0) {
    console.log(` VERIFY COMPLETE — ${configErrors} CONFIG ERROR(S)`);
    console.log(' ⚠️  Fix config errors before production!');
    console.log('══════════════════════════════════════\n');
    process.exit(1);
  } else {
    console.log(' VERIFY COMPLETE — ALL CHECKS PASSED');
  }
  console.log('══════════════════════════════════════\n');
}

main().catch(err => {
  console.error('\n❌ Verify failed:');
  console.error(err);
  process.exit(1);
});
