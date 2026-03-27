import { PublicKey } from '@solana/web3.js';

const PSWAP   = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const WSOL    = new PublicKey('So11111111111111111111111111111111111111112');
const token   = new PublicKey('G17Ec5aWaoSwRmmcwyWZwWDumUiCt23ZPUa4Rxzj8uNA');
const creator = new PublicKey('DWyVoYzwvNsFudUp3ga8cf82pFkyeQySS3en1DwBFY3m');
const PUMP    = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const EXPECTED = '2PNsAzfwSVWZzSKWSqs2W7ztpXcKUt4U8jaRtaBUgtSs';

const u16le = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const [authToken] = PublicKey.findProgramAddressSync([Buffer.from('pool-authority'), token.toBuffer()], PUMP);
const [authWsol]  = PublicKey.findProgramAddressSync([Buffer.from('pool-authority'), WSOL.toBuffer()], PUMP);

const combos: [string, PublicKey, PublicKey, PublicKey][] = [
  ['DWyVoYz,    base=wSOL,  quote=token', creator,   WSOL,  token],
  ['DWyVoYz,    base=token, quote=wSOL',  creator,   token, WSOL],
  ['auth(token), base=wSOL,  quote=token', authToken, WSOL,  token],
  ['auth(token), base=token, quote=wSOL',  authToken, token, WSOL],
  ['auth(wSOL),  base=wSOL,  quote=token', authWsol,  WSOL,  token],
  ['auth(wSOL),  base=token, quote=wSOL',  authWsol,  token, WSOL],
];

console.log('Expected: ' + EXPECTED + '\n');
for (const [label, c, base, quote] of combos) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), u16le(0), c.toBuffer(), base.toBuffer(), quote.toBuffer()],
    PSWAP,
  );
  const match = pda.toBase58() === EXPECTED;
  console.log(`${match ? '✅ MATCH' : '      '} [${label}] -> ${pda.toBase58()}`);
}
