/**
 * find_pool.ts — находит реальный PumpSwap pool для любого токена
 * Запуск: npx ts-node src/find_pool.ts <mint>
 */
import { Connection, PublicKey } from '@solana/web3.js';
import dotenv from 'dotenv';
dotenv.config();
import { config } from './config';

const PSWAP = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const PUMP  = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const WSOL  = new PublicKey('So11111111111111111111111111111111111111112');

function encodeU16LE(n: number): Buffer {
  const b = Buffer.alloc(2); b.writeUInt16LE(n); return b;
}

async function main() {
  const mintStr = process.argv[2];
  if (!mintStr) { console.error('Usage: npx ts-node src/find_pool.ts <mint>'); process.exit(1); }
  const mint = new PublicKey(mintStr);
  const connection = new Connection(config.rpc.url, 'processed');

  console.log(`\nSearching PumpSwap pool for: ${mint.toBase58()}\n`);

  const [authToken] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool-authority'), mint.toBuffer()], PUMP,
  );
  console.log(`pumpAuthority(token): ${authToken.toBase58()}`);

  // Try all 4 seed combinations
  const combos = [
    { label: 'base=TOKEN, quote=wSOL', base: mint, quote: WSOL },
    { label: 'base=wSOL,  quote=TOKEN', base: WSOL, quote: mint },
  ];
  for (const { label, base, quote } of combos) {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('pool'), encodeU16LE(0), authToken.toBuffer(), base.toBuffer(), quote.toBuffer()],
      PSWAP,
    );
    const acc = await connection.getAccountInfo(pda).catch(() => null);
    const found = acc ? `✅ FOUND (${acc.data.length} bytes)` : '❌ not found';
    console.log(`  ${label}: ${pda.toBase58()}  ${found}`);
    if (acc) {
      const baseMint  = new PublicKey(acc.data.subarray(43, 75));
      const quoteMint = new PublicKey(acc.data.subarray(75, 107));
      const creator   = new PublicKey(acc.data.subarray(11, 43));
      console.log(`     creator:   ${creator.toBase58()}`);
      console.log(`     baseMint:  ${baseMint.toBase58()}`);
      console.log(`     quoteMint: ${quoteMint.toBase58()}`);
    }
  }

  // getProgramAccounts — NO dataSize filter, search by mint bytes at offset 43 and 75
  console.log('\n─── getProgramAccounts (no size filter) ─────────────────');
  for (const { label, offset } of [
    { label: 'mint at offset 43 (baseMint)',  offset: 43 },
    { label: 'mint at offset 75 (quoteMint)', offset: 75 },
  ]) {
    try {
      const accounts = await connection.getProgramAccounts(PSWAP, {
        commitment: 'confirmed',
        filters: [{ memcmp: { offset, bytes: mint.toBase58() } }],
      });
      if (accounts.length > 0) {
        for (const { pubkey, account } of accounts) {
          const baseMint  = new PublicKey(account.data.subarray(43, 75));
          const quoteMint = new PublicKey(account.data.subarray(75, 107));
          const creator   = new PublicKey(account.data.subarray(11, 43));
          console.log(`✅ [${label}] pool: ${pubkey.toBase58()} (${account.data.length} bytes)`);
          console.log(`   creator:   ${creator.toBase58()}`);
          console.log(`   baseMint:  ${baseMint.toBase58()}`);
          console.log(`   quoteMint: ${quoteMint.toBase58()}`);
        }
      } else {
        console.log(`   [${label}] → not found`);
      }
    } catch(e: any) {
      console.log(`   [${label}] → gPA error: ${e.message}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
