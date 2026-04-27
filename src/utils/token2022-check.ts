import { Connection, PublicKey } from '@solana/web3.js';
import { withRpcLimit } from './rpc-limiter';
import { logger } from './logger';

const DANGEROUS_EXTENSIONS = new Set([
  'TransferFeeConfig',
  'PermanentDelegate',
  'TransferHook',
  'ConfidentialTransferMint',
  'DefaultAccountState',
]);

const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

const extensionCache = new Map<string, { dangerous: string[]; ts: number }>();
const CACHE_TTL_MS = 300_000;

export async function checkToken2022Extensions(
  connection: Connection,
  mint: PublicKey,
): Promise<{ isDangerous: boolean; extensions: string[] }> {
  const mintStr = mint.toBase58();
  const cached = extensionCache.get(mintStr);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { isDangerous: cached.dangerous.length > 0, extensions: cached.dangerous };
  }

  try {
    const info = await withRpcLimit(() => connection.getAccountInfo(mint, 'processed'));
    if (!info) return { isDangerous: false, extensions: [] };

    if (!info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      extensionCache.set(mintStr, { dangerous: [], ts: Date.now() });
      return { isDangerous: false, extensions: [] };
    }

    const dangerous: string[] = [];
    const data = info.data;

    if (data.length > 166) {
      const extensionData = data.slice(166);
      let offset = 0;
      while (offset + 4 <= extensionData.length) {
        const extType = extensionData.readUInt16LE(offset);
        const extLen = extensionData.readUInt16LE(offset + 2);

        const extName = EXTENSION_TYPE_MAP[extType];
        if (extName && DANGEROUS_EXTENSIONS.has(extName)) {
          dangerous.push(extName);
        }
        offset += 4 + extLen;
        if (extLen === 0) break;
      }
    }

    extensionCache.set(mintStr, { dangerous, ts: Date.now() });
    if (dangerous.length > 0) {
      logger.info(`[token2022] ${mintStr.slice(0, 8)} dangerous extensions: ${dangerous.join(', ')}`);
    }
    return { isDangerous: dangerous.length > 0, extensions: dangerous };
  } catch (err) {
    logger.debug(`[token2022] Check failed for ${mintStr.slice(0, 8)}: ${err}`);
    return { isDangerous: false, extensions: [] };
  }
}

const EXTENSION_TYPE_MAP: Record<number, string> = {
  1: 'TransferFeeConfig',
  3: 'MintCloseAuthority',
  4: 'ConfidentialTransferMint',
  6: 'DefaultAccountState',
  7: 'ImmutableOwner',
  9: 'MemoTransfer',
  10: 'NonTransferable',
  12: 'InterestBearingConfig',
  14: 'PermanentDelegate',
  16: 'TransferHook',
  18: 'MetadataPointer',
  19: 'TokenMetadata',
};
