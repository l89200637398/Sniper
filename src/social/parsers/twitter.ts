// src/social/parsers/twitter.ts
//
// Twitter (X) parser через RapidAPI. Провайдер по умолчанию:
//   "Twitter API" (host: twitter-api45.p.rapidapi.com, alexanderxbx)
//   Free tier: ~500 req/мес, rate limit 60 req/min.
//
// Эндпоинты:
//   GET /search.php    — поиск по ключевым словам (параметры: query, search_type, cursor)
//   GET /timeline.php  — timeline пользователя (параметры: screenname, cursor)
//
// Отличие от twitter241 (GraphQL): плоский JSON-ответ.
// Формат ответа /search.php:
//   {
//     timeline: [
//       { tweet_id, text, created_at, favorites, views, quotes, author?, user_info?, ... }
//     ],
//     next_cursor, prev_cursor
//   }
//
// Парсер устойчив к разным названиям полей автора:
//   - author.screen_name / user_info.screen_name / screen_name (top-level)
//   - followers_count / sub_count / followers
//
// ENV:
//   RAPIDAPI_KEY              — ключ RapidAPI (обязателен)
//   TWITTER_RAPIDAPI_HOST     — host (default: twitter-api45.p.rapidapi.com)
//   TWITTER_RAPIDAPI_PATH     — path (default: /search.php)
//   TWITTER_SEARCH_QUERIES    — CSV запросов (default: "solana pump.fun")
//   TWITTER_SEARCH_TYPE       — Top | Latest | Photos | Videos | People (default: Top)
//   TWITTER_ALPHA_SCREENNAMES — CSV screennames для мониторинга timeline (опц.)
//
// Если RAPIDAPI_KEY не задан — fetchTwitter() выбрасывает исключение;
// регистрация в sniper.ts должна делаться по check-before-register.

import axios from 'axios';
import type { SocialSignal } from '../models/signal';
import { scoreSentiment, extractTickers, extractMints } from '../nlp/sentiment';
import { logger } from '../../utils/logger';

const HTTP_TIMEOUT_MS = 10_000;
const HTTP_MAX_BYTES  = 2_000_000;

// ── Response shape (flat JSON, twitter-api45) ────────────────────────────────
//
// Все поля опциональные — формат провайдера может меняться, парсер устойчив.

interface AuthorInfo {
  screen_name?: string;
  name?: string;
  followers_count?: number;
  sub_count?: number;   // альтернативное имя у некоторых провайдеров
}

interface ApiTweet {
  tweet_id?: string;
  id_str?: string;
  id?: string;
  text?: string;
  full_text?: string;
  created_at?: string;

  // Варианты нахождения автора в ответе:
  author?: AuthorInfo;
  user_info?: AuthorInfo;
  user?: AuthorInfo;
  screen_name?: string;
  name?: string;
  followers_count?: number;

  favorites?: number;
  bookmarks?: number;
  views?: string | number;
  quotes?: number;
  retweets?: number;
}

interface SearchResponse {
  timeline?: ApiTweet[];
  tweets?: ApiTweet[];           // fallback field name
  results?: ApiTweet[];          // fallback field name
  next_cursor?: string;
  prev_cursor?: string;
}

/** Достаёт массив твитов из ответа (поддержка 3 названий полей). */
function extractTweets(resp: SearchResponse): ApiTweet[] {
  if (Array.isArray(resp?.timeline)) return resp.timeline;
  if (Array.isArray(resp?.tweets))   return resp.tweets;
  if (Array.isArray(resp?.results))  return resp.results;
  return [];
}

/** Возвращает первое определённое значение. */
function firstDefined<T>(...vals: Array<T | undefined>): T | undefined {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

/** Достаёт username из одного из возможных мест. */
function extractScreenName(t: ApiTweet): string | undefined {
  return firstDefined(
    t.author?.screen_name,
    t.user_info?.screen_name,
    t.user?.screen_name,
    t.screen_name,
  );
}

/** Достаёт followers count. */
function extractFollowers(t: ApiTweet): number | undefined {
  const val = firstDefined(
    t.author?.followers_count,
    t.user_info?.followers_count,
    t.user?.followers_count,
    t.author?.sub_count,
    t.user_info?.sub_count,
    t.user?.sub_count,
    t.followers_count,
  );
  return typeof val === 'number' ? val : undefined;
}

/** Достаёт tweet_id из одного из возможных полей. */
function extractTweetId(t: ApiTweet): string | undefined {
  return firstDefined(t.tweet_id, t.id_str, t.id);
}

/** Достаёт текст твита (text имеет приоритет над full_text). */
function extractText(t: ApiTweet): string {
  return (t.text ?? t.full_text ?? '').trim();
}

/** Парсит "Wed Jun 07 19:00:00 +0000 2023" или ISO → ms. */
function parseTweetTs(raw: unknown): number {
  if (typeof raw === 'string') {
    const n = Date.parse(raw);
    if (!Number.isNaN(n)) return n;
  }
  return Date.now();
}

const SPAM_PATTERNS = [
  /@iscan/i, /iScanLive/i, /scan.*signal.*buy/i, /target.*\$\d+.*K/i,
  /growth.*expected.*buy/i, /buy.*recommended.*#Solana/i,
  /no problem.*i'm in.*#Solana/i, /signal.*expects.*\$\d+/i,
  /airdrop.*claim.*free/i, /send.*SOL.*get.*back/i,
  /presale.*live.*hurry/i, /whitelist.*spot.*left/i,
];

function isSpamTweet(text: string): boolean {
  return SPAM_PATTERNS.some(p => p.test(text));
}

function toSignal(t: ApiTweet): SocialSignal | null {
  const text = extractText(t);
  if (!text) return null;

  if (isSpamTweet(text)) return null;

  const tickers = extractTickers(text);
  const mints   = extractMints(text);
  if (tickers.length === 0 && mints.length === 0) return null;

  const username  = extractScreenName(t) ?? 'unknown';
  const followers = extractFollowers(t);
  const tweetId   = extractTweetId(t);
  const url       = tweetId ? `https://x.com/${username}/status/${tweetId}` : undefined;

  return {
    source:    'twitter',
    mint:      mints[0],
    ticker:    mints.length === 0 ? tickers[0] : undefined,
    sentiment: scoreSentiment(text),
    rawText:   text.slice(0, 500),
    author:    username,
    followers,
    url,
    timestamp: parseTweetTs(t.created_at),
  };
}

/**
 * Возвращает функцию-fetcher для SocialManager. Throws, если RAPIDAPI_KEY
 * отсутствует — caller (sniper.ts) должен проверить env до вызова.
 */
export function createTwitterFetcher(): () => Promise<SocialSignal[]> {
  const apiKey = process.env.RAPIDAPI_KEY ?? '';
  if (!apiKey) {
    throw new Error('RAPIDAPI_KEY is not set');
  }

  const host = process.env.TWITTER_RAPIDAPI_HOST ?? 'twitter-api45.p.rapidapi.com';
  const searchPath = process.env.TWITTER_RAPIDAPI_PATH ?? '/search.php';
  const queriesRaw = process.env.TWITTER_SEARCH_QUERIES ?? 'solana memecoin launch,pump.fun gem early,pumpswap new token,raydium launch sol';
  const searchType = process.env.TWITTER_SEARCH_TYPE ?? 'Latest';
  const screennamesRaw = process.env.TWITTER_ALPHA_SCREENNAMES ?? 'pumpdotfun,RaydiumProtocol,MustStopMurad,blaboratory,DegenSpartanBSC';

  const queries = queriesRaw.split(',').map(q => q.trim()).filter(Boolean);
  const screennames = screennamesRaw.split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean);

  if (queries.length === 0 && screennames.length === 0) {
    throw new Error('TWITTER_SEARCH_QUERIES or TWITTER_ALPHA_SCREENNAMES must be set');
  }

  const searchUrl   = `https://${host}${searchPath}`;
  const timelineUrl = `https://${host}/timeline.php`;
  const headers = {
    'x-rapidapi-key':  apiKey,
    'x-rapidapi-host': host,
    'User-Agent':      'sniper-bot/3.0',
  };

  logger.info(`[tw] registered (host=${host}, queries=${queries.length}, screennames=${screennames.length}, type=${searchType})`);

  return async function fetchTwitter(): Promise<SocialSignal[]> {
    const out: SocialSignal[] = [];

    // 1. Search queries
    for (const query of queries) {
      try {
        const resp = await axios.get<SearchResponse>(searchUrl, {
          headers,
          params: { query, search_type: searchType },
          timeout: HTTP_TIMEOUT_MS,
          maxContentLength: HTTP_MAX_BYTES,
        });

        for (const t of extractTweets(resp.data)) {
          const s = toSignal(t);
          if (s) out.push(s);
        }
      } catch (err) {
        const status = (err as any)?.response?.status;
        logger.warn(`[tw] search "${query}" failed (status=${status}): ${(err as Error).message}`);
      }
    }

    // 2. Timeline of alpha screennames (опц.)
    for (const screenname of screennames) {
      try {
        const resp = await axios.get<SearchResponse>(timelineUrl, {
          headers,
          params: { screenname },
          timeout: HTTP_TIMEOUT_MS,
          maxContentLength: HTTP_MAX_BYTES,
        });

        for (const t of extractTweets(resp.data)) {
          const s = toSignal(t);
          if (s) {
            // Для timeline гарантированно знаем автора — переопределим, если
            // в объекте он не указан.
            if (!s.author || s.author === 'unknown') s.author = screenname;
            out.push(s);
          }
        }
      } catch (err) {
        const status = (err as any)?.response?.status;
        logger.warn(`[tw] timeline "@${screenname}" failed (status=${status}): ${(err as Error).message}`);
      }
    }

    return out;
  };
}
