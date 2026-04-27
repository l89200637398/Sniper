const RANDOM_CHAR_REGEX = /^[a-zA-Z0-9]{15,}$/;
const REPEATED_CHAR_REGEX = /(.)\1{4,}/;
const ALL_CAPS_MIN = 20;
const COPYCAT_NAMES = new Set([
  'bonk', 'pepe', 'shib', 'doge', 'floki', 'wojak', 'brett', 'mog',
  'popcat', 'wif', 'myro', 'bome', 'slerf', 'wen', 'jup', 'w',
  'trump', 'melania', 'barron', 'biden', 'elon', 'solana',
]);

export interface MetadataQuality {
  score: number;
  flags: string[];
}

export function analyzeMetadataQuality(name?: string, symbol?: string, uri?: string): MetadataQuality {
  let score = 0;
  const flags: string[] = [];

  if (!name || name.trim().length === 0) {
    score -= 15;
    flags.push('NO_NAME');
    return { score, flags };
  }

  const trimmed = name.trim();

  if (RANDOM_CHAR_REGEX.test(trimmed)) {
    score -= 20;
    flags.push('RANDOM_NAME');
  }

  if (REPEATED_CHAR_REGEX.test(trimmed)) {
    score -= 10;
    flags.push('REPEATED_CHARS');
  }

  if (trimmed.length >= ALL_CAPS_MIN && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)) {
    score -= 5;
    flags.push('ALL_CAPS_LONG');
  }

  if (trimmed.length < 2) {
    score -= 10;
    flags.push('TOO_SHORT');
  }

  const lower = trimmed.toLowerCase();
  for (const copycat of COPYCAT_NAMES) {
    if (lower === copycat || lower.includes(copycat)) {
      score -= 8;
      flags.push(`COPYCAT_${copycat.toUpperCase()}`);
      break;
    }
  }

  if (symbol) {
    const sym = symbol.trim();
    if (sym.length > 10) {
      score -= 5;
      flags.push('LONG_SYMBOL');
    }
    if (RANDOM_CHAR_REGEX.test(sym) && sym.length > 8) {
      score -= 10;
      flags.push('RANDOM_SYMBOL');
    }
  }

  if (!uri || uri.trim().length === 0) {
    score -= 5;
    flags.push('NO_URI');
  }

  if (flags.length === 0) {
    score += 5;
    flags.push('CLEAN_META');
  }

  return { score, flags };
}
