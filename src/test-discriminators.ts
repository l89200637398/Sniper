/**
 * test-discriminators.ts
 *
 * Верифицирует все discriminators проекта против Anchor IDL.
 * Запуск: npx ts-node src/test-discriminators.ts
 */

import { createHash } from 'crypto';
import { DISCRIMINATOR } from './constants';

function anchorDisc(instructionName: string): Buffer {
  return createHash('sha256')
    .update(`global:${instructionName}`)
    .digest()
    .subarray(0, 8);
}

console.log('\n🔍 Discriminator verification\n');

// ── PumpSwap (pump_amm IDL) — all verified ────────────────────────────────────
const pumpswapTests = [
  { label: 'PumpSwap CREATE_POOL', key: 'PUMP_SWAP_CREATE_POOL', idl: 'create_pool' },
  { label: 'PumpSwap BUY',         key: 'PUMP_SWAP_BUY',         idl: 'buy'         },
  { label: 'PumpSwap SELL',        key: 'PUMP_SWAP_SELL',        idl: 'sell'        },
];

console.log('── PumpSwap (pump_amm IDL) ─────────────────────────────────────────────');
let allPass = true;
for (const t of pumpswapTests) {
  const stored   = (DISCRIMINATOR as any)[t.key] as Buffer;
  const expected = anchorDisc(t.idl);
  const ok       = stored.equals(expected);
  if (!ok) allPass = false;
  console.log(`  ${ok ? '✅' : '❌'} ${t.label}: ${stored.toString('hex')} (global:${t.idl})`);
}

// ── pump.fun (bonding curve IDL) ──────────────────────────────────────────────
console.log('\n── pump.fun (bonding curve IDL, same Anchor names) ─────────────────────');
// pump.fun and PumpSwap SHARE the same BUY/SELL discriminators
// because both use Anchor with "buy"/"sell" instruction names.
// Routing is purely by programId in client.ts — this is CORRECT.
const buyOk  = DISCRIMINATOR.BUY.equals(anchorDisc('buy'));
const sellOk = DISCRIMINATOR.SELL.equals(anchorDisc('sell'));
if (!buyOk || !sellOk) allPass = false;
console.log(`  ${buyOk  ? '✅' : '❌'} pump.fun BUY:  ${DISCRIMINATOR.BUY.toString('hex')} (= pumpswap BUY, routing by programId)`);
console.log(`  ${sellOk ? '✅' : '❌'} pump.fun SELL: ${DISCRIMINATOR.SELL.toString('hex')} (= pumpswap SELL, routing by programId)`);
console.log(`  ℹ️  pump.fun BUY_EXACT_SOL_IN: ${DISCRIMINATOR.BUY_EXACT_SOL_IN.toString('hex')} (non-standard, from idl/pump.json)`);

// ── Important note ─────────────────────────────────────────────────────────────
console.log('\n── Key insight ─────────────────────────────────────────────────────────');
console.log('  pump.fun and PumpSwap share identical buy/sell discriminator bytes.');
console.log('  Separation is ONLY by programId (checked first in client.ts).');
console.log('  This means: if programId check fails, wrong handler fires.');
console.log('  Verify in client.ts: pump.fun branch checks this.PUMP_PROGRAM first,');
console.log('  PumpSwap branch checks this.PUMP_SWAP. ✅ This is correct.\n');

if (allPass) {
  console.log('✅ All discriminators verified against IDL.\n');
} else {
  console.log('❌ Some discriminators failed. Check constants.ts.\n');
  process.exit(1);
}
