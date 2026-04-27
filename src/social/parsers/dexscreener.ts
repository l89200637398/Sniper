// src/social/parsers/dexscreener.ts
//
// DexScreener "boosts" parser. Бесплатный API без ключа.
//
// Boost — это оплаченная промо-позиция токена на DexScreener. Это более
// точный прокси "социального внимания", чем volume-trending (который в
// основном показывает уже распамплённые монеты). Если кто-то платит за
// boost конкретного токена — значит этот токен активно продвигают, и
// это потенциальный хайп на ранней стадии.
//
// Endpoints:
//   GET /token-boosts/latest/v1  — последние boost-ы (свежие)
//   GET /token-boosts/top/v1     — токены с наибольшим числом активных boost-ов
//
// Ответ — массив объектов:
//   { chainId, tokenAddress, amount, totalAmount, url, description?, icon?, links?[] }

import axios from 'axios';
import type { SocialSignal } from '../models/signal';
import { scoreSentiment } from '../nlp/sentiment';

const LATEST_URL = 'https://api.dexscreener.com/token-boosts/latest/v1';
const HTTP_TIMEOUT_MS  = 5000;
const HTTP_MAX_BYTES   = 100_000;

interface BoostEntry {
  chainId?: string;
  tokenAddress?: string;
  amount?: number;
  totalAmount?: number;
  url?: string;
  description?: string;
}

/**
 * Получить последние DexScreener-boosts, отфильтрованные по Solana.
 * Возвращает массив SocialSignal, где mint = tokenAddress.
 *
 * Вызывается SocialManager с интервалом ~60s (см. регистрацию в sniper.ts).
 */
export async function fetchDexscreenerBoosts(): Promise<SocialSignal[]> {
  const resp = await axios.get<BoostEntry[]>(LATEST_URL, {
    timeout: HTTP_TIMEOUT_MS,
    maxContentLength: HTTP_MAX_BYTES,
    headers: { 'User-Agent': 'sniper-bot/3.0' },
  });

  const data = Array.isArray(resp.data) ? resp.data : [];
  const now = Date.now();
  const out: SocialSignal[] = [];

  for (const b of data) {
    if (b.chainId !== 'solana') continue;
    if (!b.tokenAddress || typeof b.tokenAddress !== 'string') continue;
    // Грубая валидация base58-длины (Solana mint = 32-44 символа).
    if (b.tokenAddress.length < 32 || b.tokenAddress.length > 44) continue;

    const rawText = (b.description ?? '').trim();
    // Sentiment берём из описания (если есть). Обычно там маркетинговый
    // текст вида "Moon shot 🚀 100x gem" — ловим бычьи слова.
    const sentiment = rawText ? scoreSentiment(rawText) : 0;

    out.push({
      source: 'dexscreener',
      mint: b.tokenAddress,
      // Ticker не приходит в boost endpoint — оставляем undefined. UI
      // отобразит по mint.slice(0,8).
      ticker: undefined,
      sentiment,
      rawText: rawText.slice(0, 300),
      // "author" здесь смысла не имеет, но пишем 'dexscreener' для
      // согласованности UI.
      author: 'dexscreener',
      followers: undefined,
      // url — стабильный публичный идентификатор, используется для dedup.
      url: b.url ?? `https://dexscreener.com/solana/${b.tokenAddress}`,
      timestamp: now,
    });
  }

  return out;
}
