// src/social/models/signal.ts
//
// Унифицированная модель социального сигнала. Каждый парсер (DexScreener,
// Twitter, Telegram, …) эмитит объекты этого типа в SocialManager, который
// дедуплицирует и сохраняет их в SQLite (social_signals).

export type SignalSource =
  | 'twitter'
  | 'telegram'
  | 'dexscreener'
  | 'birdeye'
  | 'pumpfun'
  | 'reddit';

export interface SocialSignal {
  /** Источник сигнала. */
  source: SignalSource;
  /** Solana mint address, если удалось извлечь. */
  mint?: string;
  /** Тикер без знака $ (например, 'WIF'). */
  ticker?: string;
  /** Sentiment score в диапазоне [-1, +1]. 0 = нейтрально. */
  sentiment: number;
  /** Исходный текст (твит / сообщение / название пары). Храним для отладки и
   *  последующего переанализа (напр. sentiment upgrade). Может быть
   *  обрезан до ~500 символов. */
  rawText: string;
  /** Имя/handle автора (для Twitter/Telegram). */
  author?: string;
  /** Followers / подписчиков — важно для веса сигнала. */
  followers?: number;
  /** Ссылка на исходный пост/пару. */
  url?: string;
  /** Время события (ms since epoch). Берём из источника, а не Date.now(). */
  timestamp: number;
  /** Alpha-флаг: сигнал попал под ручной whitelist (см. src/social/watchlist.ts).
   *  Ставится в SocialManager.ingest(); может быть undefined для старых записей. */
  alpha?: boolean;
}

/** Ключ для дедупликации одного и того же сигнала между polling-циклами. */
export function signalKey(s: SocialSignal): string {
  // url — самый стабильный идентификатор поста. Фолбэк — source+text+author.
  if (s.url) return `${s.source}:${s.url}`;
  return `${s.source}:${s.author ?? ''}:${s.rawText.slice(0, 120)}`;
}
