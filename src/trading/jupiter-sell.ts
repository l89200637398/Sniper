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
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import { logger } from '../utils/logger';
import { sendJitoBundle } from '../jito/bundle';
// EV-FIX: Jupiter tx is now sent via Jito bundle (private mempool) by default.
// Sending high-slippage txs (up to 50%) to public mempool = guaranteed MEV sandwich.
// Jito bundle keeps the tx private until it's included in a block.
// Fallback to public RPC only if Jito fails (better than not selling at all).

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_API_KEY = process.env.JUPITER_API_KEY ?? '';
// api.jup.ag requires API key; lite-api.jup.ag/v6 is the free public tier
const JUPITER_BASE = process.env.JUPITER_API_BASE
  ?? (JUPITER_API_KEY ? 'https://api.jup.ag' : 'https://lite-api.jup.ag/v6');

export { JUPITER_BASE as jupiterBase };

let lastSwapCallMs = 0;
const SWAP_MIN_INTERVAL_MS = 1100;
export async function waitForJupiterSwapSlot(): Promise<void> {
  const elapsed = Date.now() - lastSwapCallMs;
  if (elapsed < SWAP_MIN_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, SWAP_MIN_INTERVAL_MS - elapsed));
  }
  lastSwapCallMs = Date.now();
}

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

  // 2. Swap transaction (rate-limited: Jupiter /swap = 1 RPS)
  await waitForJupiterSwapSlot();
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

  // 3. Deserialize + validate + sign
  const txBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  validateJupiterTx(tx, payer.publicKey, mintStr, WSOL_MINT);
  tx.sign([payer]);

  // EV-FIX: Try Jito first (private), fallback to public RPC.
  // High-slippage Jupiter txs in public mempool = free money for sandwich bots.
  try {
    const txId = await sendJitoBundle(tx, payer, 1.0, true);
    logger.info(`[jupiter-sell] TX sent via Jito: ${txId.slice(0, 8)}... for ${mintStr.slice(0, 8)} (${outAmountSol.toFixed(6)} SOL expected)`);
    return txId;
  } catch (jitoErr) {
    logger.warn(`[jupiter-sell] Jito failed, falling back to public RPC (MEV risk!):`, jitoErr);
    const serialized = tx.serialize();
    const txId = await connection.sendRawTransaction(serialized, {
      skipPreflight: true,
      maxRetries: 2,
    });
    logger.info(`[jupiter-sell] TX sent via public RPC (fallback): ${txId.slice(0, 8)}... for ${mintStr.slice(0, 8)} (${outAmountSol.toFixed(6)} SOL expected)`);
    return txId;
  }
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
    await waitForJupiterSwapSlot();
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
    validateJupiterTx(tx, payer.publicKey, mintStr, WSOL_MINT);
    tx.sign([payer]);
    // EV-FIX: Jito first, same as main path
    try {
      const txId = await sendJitoBundle(tx, payer, 1.0, true);
      logger.info(`[jupiter-sell] Pre-warmed TX sent via Jito: ${txId.slice(0, 8)}...`);
      return txId;
    } catch {
      const txId = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
      logger.info(`[jupiter-sell] Pre-warmed TX sent via public RPC (fallback): ${txId.slice(0, 8)}...`);
      return txId;
    }
  } catch (err) {
    logger.warn('[jupiter-sell] Pre-warmed sell failed, falling back:', err);
    return sellTokenJupiter(connection, mintStr, payer, amountRaw, slippageBps);
  }
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
    throw new Error('[jupiter-sell] TX does not include payer — possible malicious response');
  }
  if (!keyStrs.includes(expectedInputMint)) {
    throw new Error(`[jupiter-sell] TX missing inputMint ${expectedInputMint.slice(0, 8)} — possible malicious response`);
  }
  if (!keyStrs.includes(expectedOutputMint)) {
    throw new Error(`[jupiter-sell] TX missing outputMint ${expectedOutputMint.slice(0, 8)} — possible malicious response`);
  }
}

const JUPITER_PUBLIC_FALLBACK = 'https://lite-api.jup.ag/v6';

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
    signal: AbortSignal.timeout(2000),
  });

  if (!response.ok) {
    // 401/403: API key missing or invalid → retry on free public endpoint
    if ((response.status === 401 || response.status === 403) && !url.startsWith(JUPITER_PUBLIC_FALLBACK)) {
      const publicUrl = url.replace(JUPITER_BASE, JUPITER_PUBLIC_FALLBACK);
      logger.warn(`Jupiter ${response.status} on ${JUPITER_BASE}, retrying on public endpoint`);
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
