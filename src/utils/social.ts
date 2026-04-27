// src/utils/social.ts
//
// Проверка социальных сигналов токена.
// Читает Metaplex metadata → URI → JSON → ищет twitter/telegram/website.
//
// Используется в sniper.ts для динамического размера входа:
//   score >= 2 → entryAmountSol × 2.0, без задержки minTokenAgeMs
//   score  = 0 → entryAmountSol × 0.6

import { Connection, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import { logger } from './logger';

const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

export interface SocialSignal {
  hasWebsite: boolean;
  hasTwitter: boolean;
  hasTelegram: boolean;
  hasDiscord: boolean;
  score: number;            // 0-4: количество найденных каналов
  uri?: string;             // metadata URI
  twitter?: string;         // ссылка или хэндл
  telegram?: string;
  website?: string;
  fetchTimeMs: number;      // сколько заняла проверка
}

const EMPTY_SIGNAL: SocialSignal = {
  hasWebsite: false, hasTwitter: false, hasTelegram: false, hasDiscord: false,
  score: 0, fetchTimeMs: 0,
};

// Кэш результатов (mint → signal). TTL = 5 мин.
const cache = new Map<string, { signal: SocialSignal; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Получает метадату Metaplex для mint.
 * PDA: ["metadata", METADATA_PROGRAM_ID, mint]
 */
function getMetadataPDA(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID
  );
  return pda;
}

/**
 * Парсит URI из raw Metaplex metadata account data.
 *
 * Borsh layout (v1):
 *   key:              1 byte
 *   update_authority: 32 bytes
 *   mint:             32 bytes
 *   name:             4 (len) + 32 bytes
 *   symbol:           4 (len) + 14 bytes  (10 chars + padding)
 *   uri:              4 (len) + 200 bytes
 *
 * URI offset = 1 + 32 + 32 + 4 + 32 + 4 + 14 + 4 = 123
 * URI max length = 200 bytes
 */
function parseUriFromMetadata(data: Buffer): string | null {
  try {
    const URI_OFFSET = 1 + 32 + 32; // key + update_authority + mint

    // Name: 4 byte length prefix + string
    if (data.length < URI_OFFSET + 4) return null;
    const nameLen = data.readUInt32LE(URI_OFFSET);
    const nameEnd = URI_OFFSET + 4 + nameLen;

    // Symbol: 4 byte length prefix + string
    if (data.length < nameEnd + 4) return null;
    const symbolLen = data.readUInt32LE(nameEnd);
    const symbolEnd = nameEnd + 4 + symbolLen;

    // URI: 4 byte length prefix + string
    if (data.length < symbolEnd + 4) return null;
    const uriLen = data.readUInt32LE(symbolEnd);
    if (uriLen === 0 || uriLen > 250) return null;

    const uriStart = symbolEnd + 4;
    if (data.length < uriStart + uriLen) return null;

    const uri = data.slice(uriStart, uriStart + uriLen).toString('utf8').replace(/\0+$/g, '').trim();
    return uri.startsWith('http') ? uri : null;
  } catch {
    return null;
  }
}

/**
 * Скачивает JSON по URI и ищет социальные ссылки.
 * Pump.fun токены обычно хранят метадату на IPFS/CF-IPFS.
 *
 * Типичная структура:
 * { name, symbol, description, image, showName,
 *   twitter: "https://x.com/...",
 *   telegram: "https://t.me/...",
 *   website: "https://..." }
 */
async function fetchSocialFromUri(uri: string): Promise<Partial<SocialSignal>> {
  try {
    const resp = await axios.get(uri, { timeout: 2000, maxContentLength: 50_000 });
    const json = resp.data;
    if (!json || typeof json !== 'object') return {};

    // ── v2.5.2: Metadata size check ──
    // Мусорные токены генерируют крошечный JSON (<200 байт) с фейковыми ссылками.
    // Нормальный проект: name + symbol + description + image + links = 500+ байт.
    const rawSize = JSON.stringify(json).length;
    if (rawSize < 200) {
      return {}; // score останется 0 даже если ссылки есть
    }

    const result: Partial<SocialSignal> = {};

    // Twitter / X
    const twitter = json.twitter || json.twitter_url || json.x;
    if (twitter && typeof twitter === 'string' && twitter.length > 3) {
      result.hasTwitter = true;
      result.twitter = twitter;
    }

    // Telegram
    const telegram = json.telegram || json.telegram_url || json.tg;
    if (telegram && typeof telegram === 'string' && telegram.length > 3) {
      result.hasTelegram = true;
      result.telegram = telegram;
    }

    // Website
    const website = json.website || json.external_url || json.url;
    if (website && typeof website === 'string' && website.startsWith('http')) {
      result.hasWebsite = true;
      result.website = website;
    }

    // Discord
    const discord = json.discord || json.discord_url;
    if (discord && typeof discord === 'string' && discord.length > 3) {
      result.hasDiscord = true;
    }

    return result;
  } catch {
    return {};
  }
}

/**
 * Основная функция: проверяет социальные сигналы для токена.
 * Возвращает результат за ~200-500 мс (RPC + HTTP).
 *
 * Используется параллельно с другими проверками в onNewToken.
 */
export async function checkSocialSignals(
  connection: Connection,
  mint: PublicKey
): Promise<SocialSignal> {
  const key = mint.toBase58();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.signal;
  }

  const t0 = Date.now();

  try {
    // 1. Читаем Metaplex metadata account
    const metadataPDA = getMetadataPDA(mint);
    const acc = await connection.getAccountInfo(metadataPDA, 'processed');
    if (!acc || !acc.data) {
      const signal = { ...EMPTY_SIGNAL, fetchTimeMs: Date.now() - t0 };
      logger.debug(`[social] ${key.slice(0,8)}: NO METADATA PDA (${signal.fetchTimeMs}ms)`);
      cache.set(key, { signal, ts: Date.now() });
      return signal;
    }

    // 2. Парсим URI
    const uri = parseUriFromMetadata(acc.data);
    if (!uri) {
      const signal = { ...EMPTY_SIGNAL, fetchTimeMs: Date.now() - t0 };
      logger.debug(`[social] ${key.slice(0,8)}: NO URI in metadata (${signal.fetchTimeMs}ms)`);
      cache.set(key, { signal, ts: Date.now() });
      return signal;
    }

    // 3. Скачиваем JSON и ищем ссылки
    const social = await fetchSocialFromUri(uri);

    const signal: SocialSignal = {
      hasWebsite:  social.hasWebsite  ?? false,
      hasTwitter:  social.hasTwitter  ?? false,
      hasTelegram: social.hasTelegram ?? false,
      hasDiscord:  social.hasDiscord  ?? false,
      score: [social.hasWebsite, social.hasTwitter, social.hasTelegram, social.hasDiscord]
        .filter(Boolean).length,
      uri,
      twitter:   social.twitter,
      telegram:  social.telegram,
      website:   social.website,
      fetchTimeMs: Date.now() - t0,
    };

    logger.debug(`[social] ${key.slice(0,8)}: score=${signal.score} tw=${signal.hasTwitter} tg=${signal.hasTelegram} web=${signal.hasWebsite} uri=${uri?.slice(0,50)} (${signal.fetchTimeMs}ms)`);
    cache.set(key, { signal, ts: Date.now() });
    return signal;
  } catch (err) {
    logger.debug(`[social] Error checking ${key.slice(0,8)}:`, err);
    const signal = { ...EMPTY_SIGNAL, fetchTimeMs: Date.now() - t0 };
    cache.set(key, { signal, ts: Date.now() });
    return signal;
  }
}
