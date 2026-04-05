// src/infra/bloxroute.ts
//
// Параллельная отправка sell через bloXroute Trader API (бесплатный тариф).
// Отправляет уже подписанную сериализованную транзакцию через bloXroute BDN
// параллельно с основным RPC/Jito каналом.
//
// Используется как fire-and-forget: если bloXroute приземлит TX раньше — отлично,
// если нет — основной канал всё равно работает.
// Портировано из HISTORY_DEV_SNIPER.

import { logger } from '../utils/logger';

const BLOXROUTE_ENDPOINT = process.env.BLOXROUTE_ENDPOINT ?? 'https://ny.solana.dex.blxrbdn.com/api/v2/submit';
const AUTH_HEADER = process.env.BLOXROUTE_AUTH_HEADER ?? '';

/**
 * Отправляет подписанную транзакцию через bloXroute Trader API.
 * Не бросает исключений — логирует ошибки и возвращает null при неудаче.
 */
export async function sendViaBloXroute(serializedTx: Buffer | Uint8Array): Promise<string | null> {
  if (!AUTH_HEADER) {
    logger.debug('[bloxroute] BLOXROUTE_AUTH_HEADER not set, skipping');
    return null;
  }

  try {
    const base64Tx = Buffer.from(serializedTx).toString('base64');

    const response = await fetch(BLOXROUTE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': AUTH_HEADER,
      },
      body: JSON.stringify({
        transaction: { content: base64Tx },
        skipPreFlight: true,
        frontRunningProtection: false,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'no body');
      logger.debug(`[bloxroute] Submit failed (${response.status}): ${text}`);
      return null;
    }

    const data = await response.json() as { signature?: string };
    if (data.signature) {
      logger.info(`[bloxroute] TX submitted: ${data.signature.slice(0, 8)}...`);
      return data.signature;
    }

    logger.debug(`[bloxroute] No signature in response: ${JSON.stringify(data)}`);
    return null;
  } catch (err: any) {
    logger.debug(`[bloxroute] Submit error: ${err?.message ?? err}`);
    return null;
  }
}

export function isBloXrouteEnabled(): boolean {
  return !!AUTH_HEADER;
}
