// src/social/nlp/sentiment.ts
//
// Лёгкий keyword-based sentiment scoring и extractors для тикеров/mints.
// Никаких ML-моделей — только списки слов и регулярки. Этого достаточно,
// чтобы отделить явный hype ("🚀 moon lfg") от явного FUD ("rug scam avoid").
// Всё между ними будет около 0 — и это нормально: sentiment — вспомогательный
// сигнал, а не основной driver торговли.

// ── Словари ──────────────────────────────────────────────────────────────────

// Позитивные маркеры. Вес 1, регистро-независимые. Эмодзи матчатся буквально.
const POSITIVE = [
  'moon', 'mooning', 'pump', 'pumping', 'bullish', 'bull',
  'gem', 'alpha', 'lfg', 'wagmi', 'gmi',
  'buy', 'buying', 'aped', 'aping', 'ape',
  'early', 'huge', 'massive', 'parabolic', 'launch', 'launching',
  'ath', '100x', '10x', '50x', 'send', 'sending',
  'breakout', 'runner', 'runners', 'green',
  '🚀', '💎', '🔥', '🌙', '📈', '✅',
];

// Негативные маркеры. Вес 1.
const NEGATIVE = [
  'rug', 'rugged', 'rugpull', 'scam', 'scammer',
  'dump', 'dumping', 'dumped',
  'sell', 'selling', 'exit', 'exited',
  'avoid', 'honeypot', 'bearish', 'bear',
  'dead', 'dying', 'died',
  'drained', 'drain', 'hack', 'hacked', 'exploit',
  'warning', 'beware', 'fake',
  '⚠️', '🚨', '❌', '📉', '💀',
];

// Множители — перевешивают одиночные слова. Вес 2.
const STRONG_POSITIVE = ['100x', 'parabolic', '🚀🚀🚀'];
const STRONG_NEGATIVE = ['rugpull', 'honeypot', '⚠️', 'drained'];

// Собираем в Set для быстрой проверки.
const POS_SET = new Set(POSITIVE.map(s => s.toLowerCase()));
const NEG_SET = new Set(NEGATIVE.map(s => s.toLowerCase()));
const STRONG_POS = new Set(STRONG_POSITIVE.map(s => s.toLowerCase()));
const STRONG_NEG = new Set(STRONG_NEGATIVE.map(s => s.toLowerCase()));

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Вычисляет sentiment в диапазоне [-1, +1].
 *
 *   +1  → явный bullish hype
 *   0   → нейтрально / не удалось извлечь сигнал
 *   -1  → явный FUD / rug warning
 *
 * Формула: (pos - neg) / max(3, pos + neg). Делитель ≥ 3 чтобы одно слово
 * не давало сразу ±1 — нужно несколько маркеров для насыщения.
 */
export function scoreSentiment(text: string): number {
  if (!text) return 0;

  // Сначала "сильные" фразы — считаем до разбивки на токены (чтобы "🚀🚀🚀"
  // поймался даже если без пробелов).
  const lower = text.toLowerCase();
  let pos = 0;
  let neg = 0;

  for (const phrase of STRONG_POS) {
    if (lower.includes(phrase)) pos += 2;
  }
  for (const phrase of STRONG_NEG) {
    if (lower.includes(phrase)) neg += 2;
  }

  // Токенизация: слова + индивидуальные эмодзи. Удаляем пунктуацию по краям.
  const tokens = tokenize(lower);
  for (const t of tokens) {
    if (POS_SET.has(t)) pos += 1;
    else if (NEG_SET.has(t)) neg += 1;
  }

  if (pos === 0 && neg === 0) return 0;
  const denom = Math.max(3, pos + neg);
  const score = (pos - neg) / denom;
  // Clamp (на случай если STRONG дали счёт выше denom)
  return Math.max(-1, Math.min(1, score));
}

/**
 * Извлекает $TICKER паттерны из текста. Возвращает тикеры без знака $,
 * в верхнем регистре, дедуплицированно. Фильтрует 2-10 символов.
 *
 * Примеры:
 *   "$WIF to the moon $BONK"  →  ['WIF', 'BONK']
 *   "$$$ money"               →  []
 */
export function extractTickers(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  // $ + 2..10 буквенно-цифровых символов (первый — буква).
  const re = /\$([A-Za-z][A-Za-z0-9]{1,9})(?![A-Za-z0-9])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    found.add(m[1].toUpperCase());
  }
  return [...found];
}

/**
 * Извлекает Solana mint-адреса (base58, 32-44 символа) из текста.
 * Алфавит base58 не содержит 0, O, I, l. Это грубый фильтр, финальная
 * валидация — на стороне PublicKey.
 */
export function extractMints(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  // base58: [1-9A-HJ-NP-Za-km-z]{32,44}
  const re = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Чтобы не ловить любую base58-подобную строку (хэши транз. тоже сюда
    // попадают, 64-88 символов — уже отсекается длиной), возвращаем как есть.
    found.add(m[0]);
  }
  return [...found];
}

// ── internals ────────────────────────────────────────────────────────────────

/**
 * Токенизация: разбивает строку на слова и отдельные эмодзи.
 * Эмодзи могут быть в любом месте (в том числе прилипшие к словам),
 * поэтому идём посимвольно с учётом surrogate pairs.
 */
function tokenize(s: string): string[] {
  const out: string[] = [];
  let buf = '';
  // Используем Array.from чтобы корректно обработать суррогатные пары эмодзи.
  const chars = Array.from(s);
  for (const ch of chars) {
    if (/[a-z0-9]/.test(ch)) {
      buf += ch;
    } else {
      if (buf) { out.push(buf); buf = ''; }
      // Эмодзи / спец-символ: оставляем только если это полезный знак.
      // Любой non-ASCII код-пойнт считаем потенциальным эмодзи.
      if (ch.codePointAt(0)! > 127) out.push(ch);
    }
  }
  if (buf) out.push(buf);
  return out;
}
