// src/trading/jupiter-sell.ts
//
// Jupiter sell fallback.
// Используется как ПОСЛЕДНЯЯ попытка продажи после того как все попытки
// через прямые DEX-инструкции (pump.fun/PumpSwap/Raydium) провалились.
//
// Jupiter агрегирует все DEX и находит лучший маршрут автоматически.
// Это решает проблему SELL_ALL_FAILED — даже если пул мигрировал,
// ликвидность сместилась, или bonding curve изменился.
//
// API: Metis V6 через api.jup.ag
// Портировано из HISTORY_DEV_SNIPER.

import {
  Connection,
  Keypair,
  VersionedTransaction,
} from '@solana/web3.js';
import { logger } from '../utils/logger';
// Note: bloXroute submission is NOT used for Jupiter tx because bloXroute requires
// a SystemProgram.transfer tip instruction inside the tx, but Jupiter returns an
// already-built tx we can't mutate. RPC is the primary (and only) path here.

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_API_KEY = process.env.JUPITER_API_KEY ?? '';
const JUPITER_BASE = process.env.JUPITER_API_BASE ?? 'https://api.jup.ag';

export function isJupiterEnabled(): boolean {
  // API key опционален для публичного тарифа, но наличие сигнализирует намерение использовать
  return true;
}

/**
 * Продажа токена через Jupiter Metis V6 API.
 * Используется как fallback после неудачных прямых sell-ов.
 */
export async function sellTokenJupiter(
  connection: Connection,
  mintStr: string,
  payer: Keypair,
  amountRaw: bigint,
  slippageBps: number = 3000,
): Promise<string> {
  const owner = payer.publicKey.toBase58();

  logger.info(`[jupiter-sell] Attempting Jupiter sell for ${mintStr.slice(0, 8)}... amount=${amountRaw}, slippage=${slippageBps}bps`);

  // 1. Quote
  const quoteResponse = await fetchWithApiKey(
    `${JUPITER_BASE}/quote?` +
    `inputMint=${mintStr}` +
    `&outputMint=${WSOL_MINT}` +
    `&amount=${amountRaw.toString()}` +
    `&slippageBps=${slippageBps}` +
    `&swapMode=ExactIn` +
    `&onlyDirectRoutes=false` +
    `&asLegacyTransaction=false`
  );

  if (!quoteResponse || !quoteResponse.outAmount) {
    throw new Error(`[jupiter-sell] No quote available for ${mintStr.slice(0, 8)}`);
  }

  const outAmountSol = Number(quoteResponse.outAmount) / 1e9;
  logger.info(`[jupiter-sell] Quote: ${amountRaw} tokens → ${outAmountSol.toFixed(6)} SOL via ${quoteResponse.routePlan?.length ?? '?'} hops`);

  // 2. Swap transaction
  const swapResponse = await fetchWithApiKey(
    `${JUPITER_BASE}/swap`,
    {
      method: 'POST',
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: owner,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: true,
        prioritizationFeeLamports: 'auto',
      }),
    }
  );

  if (!swapResponse?.swapTransaction) {
    throw new Error(`[jupiter-sell] No swap transaction returned for ${mintStr.slice(0, 8)}`);
  }

  // 3. Sign + send via primary RPC
  const txBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([payer]);

  const serialized = tx.serialize();

  const txId = await connection.sendRawTransaction(serialized, {
    skipPreflight: true,
    maxRetries: 2,
  });

  logger.info(`[jupiter-sell] TX sent: ${txId.slice(0, 8)}... for ${mintStr.slice(0, 8)} (${outAmountSol.toFixed(6)} SOL expected)`);
  return txId;
}

/**
 * Pre-warm Jupiter quote (brainstorm v4).
 * Called speculatively while position is open to cache the quote.
 * Returns outAmountSol or null if unavailable.
 */
export async function getJupiterQuote(
  mintStr: string,
  amountRaw: bigint,
  slippageBps: number = 3000,
): Promise<{ outAmountSol: number; quoteResponse: any } | null> {
  try {
    const quoteResponse = await fetchWithApiKey(
      `${JUPITER_BASE}/quote?` +
      `inputMint=${mintStr}` +
      `&outputMint=${WSOL_MINT}` +
      `&amount=${amountRaw.toString()}` +
      `&slippageBps=${slippageBps}` +
      `&swapMode=ExactIn` +
      `&onlyDirectRoutes=false` +
      `&asLegacyTransaction=false`
    );
    if (!quoteResponse?.outAmount) return null;
    return { outAmountSol: Number(quoteResponse.outAmount) / 1e9, quoteResponse };
  } catch {
    return null;
  }
}

/**
 * Execute Jupiter sell using a pre-warmed quote (brainstorm v4).
 * Falls back to full sellTokenJupiter if quote is stale.
 */
export async function sellTokenJupiterWithQuote(
  connection: Connection,
  mintStr: string,
  payer: Keypair,
  amountRaw: bigint,
  preWarmedQuote: any,
  slippageBps: number = 3000,
): Promise<string> {
  const owner = payer.publicKey.toBase58();
  logger.info(`[jupiter-sell] Using pre-warmed quote for ${mintStr.slice(0, 8)}...`);

  try {
    const swapResponse = await fetchWithApiKey(
      `${JUPITER_BASE}/swap`,
      {
        method: 'POST',
        body: JSON.stringify({
          quoteResponse: preWarmedQuote,
          userPublicKey: owner,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          dynamicSlippage: true,
          prioritizationFeeLamports: 'auto',
        }),
      }
    );

    if (!swapResponse?.swapTransaction) {
      logger.warn('[jupiter-sell] Pre-warmed quote expired, falling back to full flow');
      return sellTokenJupiter(connection, mintStr, payer, amountRaw, slippageBps);
    }

    const txBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([payer]);
    const txId = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
    logger.info(`[jupiter-sell] Pre-warmed TX sent: ${txId.slice(0, 8)}...`);
    return txId;
  } catch (err) {
    logger.warn('[jupiter-sell] Pre-warmed sell failed, falling back:', err);
    return sellTokenJupiter(connection, mintStr, payer, amountRaw, slippageBps);
  }
}

async function fetchWithApiKey(url: string, init?: RequestInit): Promise<any> {
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
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Jupiter API ${response.status}: ${text}`);
  }

  return response.json();
}
