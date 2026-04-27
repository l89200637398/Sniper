// src/social/parsers/telegram.ts
//
// Public-channel scraper Telegram — вытягивает последние посты через
// публичный preview-виджет https://t.me/s/{channel}. БЕЗ MTProto, БЕЗ
// api_id / api_hash / session. Работает только с публичными каналами
// (у которых есть @username); приватные (invite-only, URL вида t.me/+xxx)
// физически невидимы для не-участников, и мы их молча пропускаем.
//
// ENV (все опциональны):
//   TG_ALPHA_CHANNELS  — CSV каналов. Поддерживается:
//                         "foo", "@foo", "https://t.me/foo"
//                        Если не задан — используется DEFAULT_CHANNELS ниже.
//   TG_SCRAPE_UA       — User-Agent (default: обычный Chrome).
//
// Частота опроса задаётся в sniper.ts (30s — щадящий режим для t.me).
// Все parsers изолированы per-channel: ошибка одного канала не блокирует
// остальные (см. фокус try/catch внутри цикла).

import axios from 'axios';
import type { SocialSignal } from '../models/signal';
import { scoreSentiment, extractTickers, extractMints } from '../nlp/sentiment';
import { logger } from '../../utils/logger';

// ── Defaults ─────────────────────────────────────────────────────────────────
//
// Список активен, если TG_ALPHA_CHANNELS пустой. Меняется либо правкой
// здесь + rebuild, либо через env без рестарта deploy-пайплайна.

const DEFAULT_CHANNELS: string[] = [
  // Исходный набор (микс pump.fun + протокол-агностичные)
  'dexscreener_updates',
  'solanaAlphasignal',
  'shitcoingemsalert',
  'solpompeleeshuzzz',
  'signalsolanaby4am',
  'trending',
  'solana_whales_tracker',
  'raydiumprotocol',
  // Публичный аналог waterfall-бота (invite-link которого MTProto-only)
  'newsolanapools',
  // Расширение покрытия (все протоколы / общая аналитика). Если канал
  // окажется приватным/удалённым — парсер логирует WARN раз и пропускает
  // его, не блокируя остальные.
  'pumpdotfun',
  'birdeye_so',
  'solanafloor',
];

const DEFAULT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const HTTP_TIMEOUT_MS  = 10_000;
const HTTP_MAX_BYTES   = 3_000_000;   // preview страница обычно 200–500кб
const MESSAGES_WINDOW  = 20;          // t.me/s отдаёт ~20 последних постов
const SEEN_BUFFER_LIMIT = 2000;       // LRU: channel:mid → был ли обработан

// ── Нормализация каналов ─────────────────────────────────────────────────────

/**
 * Приводит один элемент TG_ALPHA_CHANNELS к "чистому" slug'у.
 * Возвращает null если это приватный invite-link или мусор.
 */
function normalizeChannel(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  // Отсекаем приватные каналы — их невозможно читать без MTProto
  // (https://t.me/+xxx и https://t.me/joinchat/xxx).
  if (/^https?:\/\/t\.me\/(\+|joinchat\/)/i.test(s)) return null;
  if (s.startsWith('+')) return null;

  // Извлекаем slug из URL / @username / голой строки.
  const m = s.match(/^(?:https?:\/\/t\.me\/|@)?([A-Za-z0-9_]{3,64})$/);
  return m ? m[1] : null;
}

// ── HTML parsing helpers ─────────────────────────────────────────────────────

interface ScrapedPost {
  msgId: string;
  text: string;
  timestamp: number;
}

/**
 * Достаёт содержимое div'а, открывающийся тег которого содержит `markerClass`.
 * Учитывает вложенные <div> — возвращает HTML внутри балансирующего </div>.
 * null если не нашёл / не сбалансировал.
 */
function extractDivContent(chunk: string, markerClass: string): string | null {
  const markerIdx = chunk.indexOf(markerClass);
  if (markerIdx < 0) return null;

  // Откат до '<div' слева от маркера.
  const openIdx = chunk.lastIndexOf('<div', markerIdx);
  if (openIdx < 0) return null;
  const openEnd = chunk.indexOf('>', markerIdx);
  if (openEnd < 0) return null;

  let depth = 1;
  let pos = openEnd + 1;
  while (depth > 0 && pos < chunk.length) {
    const nextOpen  = chunk.indexOf('<div', pos);
    const nextClose = chunk.indexOf('</div>', pos);
    if (nextClose < 0) return null;
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth++;
      pos = nextOpen + 4;
    } else {
      depth--;
      if (depth === 0) return chunk.slice(openEnd + 1, nextClose);
      pos = nextClose + 6;
    }
  }
  return null;
}

/** HTML → plain text: <br> и <p> → \n, остальные теги удаляются, entities декодируются. */
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(parseInt(n, 10)); } catch { return ''; }
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Вытягивает все посты из HTML-страницы канала. */
function parseChannelHtml(html: string, channel: string): ScrapedPost[] {
  const out: ScrapedPost[] = [];

  // Каждое сообщение — блок, начинающийся с <div class="tgme_widget_message "
  // (пробел в конце класса важен, чтобы не цеплять *_wrap / *_text и т.п.).
  // Первый split-chunk — шапка страницы, его отбрасываем проверкой data-post.
  const chunks = html.split('<div class="tgme_widget_message ');

  for (const chunk of chunks) {
    const postMatch = chunk.match(/^[^>]*data-post="([^/"]+)\/(\d+)"/);
    if (!postMatch) continue;
    const msgId = postMatch[2];

    // Timestamp — ближайший <time datetime="...">.
    const timeMatch = chunk.match(/<time[^>]+datetime="([^"]+)"/);
    const ts = timeMatch ? Date.parse(timeMatch[1]) : NaN;
    const timestamp = Number.isFinite(ts) ? ts : Date.now();

    // Текст поста — div с классом tgme_widget_message_text.
    const rawHtml = extractDivContent(chunk, 'tgme_widget_message_text');
    if (!rawHtml) continue;
    const text = htmlToText(rawHtml);
    if (!text) continue;

    out.push({ msgId, text, timestamp });
    if (out.length >= MESSAGES_WINDOW) break;
  }

  // t.me/s отдаёт посты в хронологическом порядке (старые → новые). Нам
  // удобнее обрабатывать от старых к новым тоже (dedup seen естественным
  // образом вытесняет устаревшие записи).
  void channel;
  return out;
}

/** Количество подписчиков канала — из <div class="tgme_page_extra"> (когда есть). */
function parseSubscribers(html: string): number | undefined {
  // Формат "12 345 subscribers" / "1.2K subscribers" / "123 members".
  const m = html.match(/class="tgme_header_counter"[^>]*>\s*([\d.,\sKkMm]+)\s*(subscribers?|members?)/);
  if (!m) return undefined;
  const raw = m[1].replace(/\s|,/g, '').toLowerCase();
  const num = parseFloat(raw);
  if (!Number.isFinite(num)) return undefined;
  if (raw.endsWith('k')) return Math.round(num * 1_000);
  if (raw.endsWith('m')) return Math.round(num * 1_000_000);
  return Math.round(num);
}

// ── Fetcher factory ──────────────────────────────────────────────────────────

/**
 * Создаёт fetcher для SocialManager. Синхронная фабрика (в отличие от
 * старого MTProto): никакого handshake не требуется, первый HTTP
 * идёт при первом тике polling'а.
 *
 * Возвращает null ТОЛЬКО если после нормализации не осталось ни одного
 * валидного канала. Иначе — всегда активен.
 */
export function createTelegramFetcher(): (() => Promise<SocialSignal[]>) | null {
  const raw = process.env.TG_ALPHA_CHANNELS?.trim();
  const rawList = raw && raw.length > 0
    ? raw.split(',')
    : DEFAULT_CHANNELS;

  const normalized: string[] = [];
  const skipped: string[] = [];
  for (const r of rawList) {
    const n = normalizeChannel(r);
    if (n) normalized.push(n);
    else if (r.trim()) skipped.push(r.trim());
  }

  if (skipped.length > 0) {
    logger.warn(
      `[tg] ${skipped.length} channel(s) skipped (private invite link or bad format): ${skipped.join(', ')}`,
    );
  }

  if (normalized.length === 0) {
    logger.warn('[tg] no public channels configured — parser disabled');
    return null;
  }

  const channels = [...new Set(normalized)];   // дедуп
  const ua = process.env.TG_SCRAPE_UA?.trim() || DEFAULT_UA;

  logger.info(`[tg] scraper registered — ${channels.length} public channel(s): ${channels.join(', ')}`);

  // ── Dedup ────────────────────────────────────────────────────────────────
  const seen = new Set<string>();
  const markSeen = (key: string) => {
    if (seen.size >= SEEN_BUFFER_LIMIT) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    seen.add(key);
  };

  // ── Followers cache (subscribers count из шапки канала) ─────────────────
  const SUBS_TTL = 6 * 60 * 60 * 1000;  // 6 часов достаточно
  const subsCache = new Map<string, { count: number; ts: number }>();

  async function fetchHtml(channel: string): Promise<string | null> {
    try {
      const resp = await axios.get<string>(`https://t.me/s/${channel}`, {
        timeout: HTTP_TIMEOUT_MS,
        maxContentLength: HTTP_MAX_BYTES,
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        // Некоторые каналы редиректят 301→302; axios по умолчанию следует,
        // но ограничим чтоб не уйти в луп.
        maxRedirects: 3,
        // Не бросаем на 4xx — хотим обработать 404 (канал удалён/скрыт).
        validateStatus: s => s >= 200 && s < 500,
        responseType: 'text',
        transformResponse: [(d) => d],   // не парсить как JSON
      });
      if (resp.status !== 200) {
        logger.warn(`[tg] ${channel} HTTP ${resp.status} — channel unavailable`);
        return null;
      }
      return resp.data;
    } catch (err) {
      logger.warn(`[tg] ${channel} fetch failed: ${(err as Error).message}`);
      return null;
    }
  }

  return async function fetchTelegram(): Promise<SocialSignal[]> {
    const out: SocialSignal[] = [];

    for (const channel of channels) {
      const html = await fetchHtml(channel);
      if (!html) continue;

      // Followers (обновляем раз в 6ч)
      let followers: number | undefined;
      const cached = subsCache.get(channel);
      if (cached && Date.now() - cached.ts < SUBS_TTL) {
        followers = cached.count;
      } else {
        const subs = parseSubscribers(html);
        if (subs !== undefined) {
          subsCache.set(channel, { count: subs, ts: Date.now() });
          followers = subs;
        }
      }

      // Посты
      const posts = parseChannelHtml(html, channel);
      for (const p of posts) {
        const key = `${channel}:${p.msgId}`;
        if (seen.has(key)) continue;
        markSeen(key);

        const tickers = extractTickers(p.text);
        const mints   = extractMints(p.text);

        // Шумовой фильтр: только посты с тикером или mint'ом — остальные
        // (gn/анонсы продуктов/картинки) не полезны для снайпера.
        if (tickers.length === 0 && mints.length === 0) continue;

        out.push({
          source: 'telegram',
          mint:   mints[0],
          ticker: mints.length === 0 ? tickers[0] : undefined,
          sentiment: scoreSentiment(p.text),
          rawText: p.text.slice(0, 500),
          author: `@${channel}`,
          followers,
          url: `https://t.me/${channel}/${p.msgId}`,
          timestamp: p.timestamp,
        });
      }
    }

    return out;
  };
}
