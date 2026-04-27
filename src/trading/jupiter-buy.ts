// src/trading/jupiter-buy.ts
//
// Jupiter buy — fallback для токенов с неизвестным протоколом.
// Используется когда detectProtocol() вернул 'unknown': gRPC поймал mint,
// но ни pump.fun bonding curve, ни pumpswap pool, ни raydium найти не удалось.
//
// Активируется только при strategy.jupiterFallback.enabled = true (opt-in).
// Продажа идёт через существующий 4-chain sell fallback (Jito→RPC→bloXroute→Jupiter).
//
// API: Metis V6 (api.jup.ag) — тот же эндпоинт что и в jupiter-sell.ts.

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import { logger } from '../utils/logger';
import { sendJitoBundle } from '../jito/bundle';
import { waitForJupiterSwapSlot } from './jupiter-sell';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_API_KEY = process.env.JUPITER_API_KEY ?? '';
const JUPITER_BASE = process.env.JUPITER_API_BASE
  ?? (JUPITER_API_KEY ? 'https://api.jup.ag' : 'https://lite-api.jup.ag/v6');

export interface JupiterBuyResult {
  txId: string;
  /** Количество токенов в raw units (без деления на decimals). */
  tokensOutRaw: bigint;
  /** Фактически потрачено lamports (= запрошенный input, ExactIn). */
  solSpentLamports: bigint;
}

/**
 * Покупка токена через Jupiter (WSOL → token).
 * Транзакция отправляется через Jito bundle (private mempool),
 * при ошибке — fallback на public RPC.
 */
export async function buyTokenJupiter(
  connection: Connection,
  mintStr: string,
  payer: Keypair,
  solAmountLamports: bigint,
  slippageBps: number = 2000,
): Promise<JupiterBuyResult> {
  const mintShort = mintStr.slice(0, 8);

  // 1. Quote: WSOL → token (ExactIn на SOL-сторону)
  const quoteResponse = await jupFetch(
    `${JUPITER_BASE}/quote?` +
    `inputMint=${WSOL_MINT}` +
    `&outputMint=${mintStr}` +
    `&amount=${solAmountLamports.toString()}` +
    `&slippageBps=${slippageBps}` +
    `&swapMode=ExactIn` +
    `&onlyDirectRoutes=false` +
    `&asLegacyTransaction=false`
  );

  if (!quoteResponse?.outAmount) {
    throw new Error(`[jupiter-buy] No quote for ${mintShort}`);
  }

  logger.info(
    `[jupiter-buy] Quote: ${solAmountLamports} lamports → ${quoteResponse.outAmount} raw tokens ` +
    `via ${quoteResponse.routePlan?.length ?? '?'} hops for ${mintShort}`
  );

  // 2. Build swap transaction (rate-limited: Jupiter /swap = 1 RPS)
  await waitForJupiterSwapSlot();
  const swapResponse = await jupFetch(`${JUPITER_BASE}/swap`, {
    method: 'POST',
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: payer.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: true,
      prioritizationFeeLamports: 'auto',
    }),
  });

  if (!swapResponse?.swapTransaction) {
    throw new Error(`[jupiter-buy] No swap transaction for ${mintShort}`);
  }

  // 3. Deserialize + validate + sign
  const tx = VersionedTransaction.deserialize(
    Buffer.from(swapResponse.swapTransaction, 'base64')
  );
  validateJupiterTx(tx, payer.publicKey, WSOL_MINT, mintStr);
  tx.sign([payer]);

  let txId: string;
  try {
    txId = await sendJitoBundle(tx, payer, 1.0, true);
    logger.info(`[jupiter-buy] TX via Jito: ${txId.slice(0, 8)}... for ${mintShort}`);
  } catch (jitoErr) {
    logger.warn(`[jupiter-buy] Jito failed for ${mintShort}, public RPC fallback:`, jitoErr);
    txId = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 2,
    });
    logger.info(`[jupiter-buy] TX via public RPC: ${txId.slice(0, 8)}... for ${mintShort}`);
  }

  return {
    txId,
    tokensOutRaw: BigInt(quoteResponse.outAmount),
    solSpentLamports: solAmountLamports,
  };
}

function validateJupiterTx(
  tx: VersionedTransaction,
  payerKey: PublicKey,
  expectedInputMint: string,
  expectedOutputMint: string,
): void {
  const keys = tx.message.getAccountKeys();
  const keyStrs: string[] = [];
  for (let i = 0; i < keys.length; i++) keyStrs.push(keys.get(i)!.toBase58());

  if (!keyStrs.includes(payerKey.toBase58())) {
    throw new Error('[jupiter-buy] TX does not include payer — possible malicious response');
  }
  if (!keyStrs.includes(expectedInputMint)) {
    throw new Error(`[jupiter-buy] TX missing inputMint ${expectedInputMint.slice(0, 8)} — possible malicious response`);
  }
  if (!keyStrs.includes(expectedOutputMint)) {
    throw new Error(`[jupiter-buy] TX missing outputMint ${expectedOutputMint.slice(0, 8)} — possible malicious response`);
  }
}

const JUPITER_PUBLIC_FALLBACK = 'https://lite-api.jup.ag/v6';

async function jupFetch(url: string, init?: RequestInit): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(JUPITER_API_KEY ? { 'x-api-key': JUPITER_API_KEY } : {}),
  };
  const response = await fetch(url, {
    ...init,
    headers: {
      ...headers,
      ...(init?.headers as Record<string, string> ?? {}),
    },
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) {
    if ((response.status === 401 || response.status === 403) && !url.startsWith(JUPITER_PUBLIC_FALLBACK)) {
      const publicUrl = url.replace(JUPITER_BASE, JUPITER_PUBLIC_FALLBACK);
      logger.warn(`Jupiter ${response.status}, retrying on public endpoint`);
      const pubResponse = await fetch(publicUrl, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> ?? {}) },
        signal: AbortSignal.timeout(3000),
      });
      if (!pubResponse.ok) {
        const text = await pubResponse.text().catch(() => '');
        throw new Error(`Jupiter API ${pubResponse.status} (public fallback): ${text}`);
      }
      return pubResponse.json();
    }
    const text = await response.text().catch(() => '');
    throw new Error(`Jupiter API ${response.status}: ${text}`);
  }
  return response.json();
}
