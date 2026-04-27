// Token-bucket rate limiter для Jito RPS
// Jito лимит: 10 RPS. Целимся в 10 RPS, допуская редкие burst до 11.
// Token bucket: 10 токенов/сек, burst capacity 10 (1 секунда буфера).

const JITO_MAX_RPS     = 10;
const BUCKET_CAPACITY  = 10;
const REFILL_INTERVAL  = 1000 / JITO_MAX_RPS; // 100мс

let tokens     = BUCKET_CAPACITY;
let lastRefill = Date.now();

function refillTokens(): void {
  const now = Date.now();
  const elapsed = now - lastRefill;
  const newTokens = elapsed / REFILL_INTERVAL;
  if (newTokens >= 1) {
    tokens = Math.min(BUCKET_CAPACITY, tokens + newTokens);
    lastRefill = now;
  }
}

export function acquireJitoToken(): Promise<void> {
  refillTokens();
  if (tokens >= 1) {
    tokens -= 1;
    return Promise.resolve();
  }
  const waitMs = Math.ceil(REFILL_INTERVAL * (1 - tokens));
  return new Promise(resolve => setTimeout(() => {
    refillTokens();
    tokens = Math.max(0, tokens - 1);
    resolve();
  }, waitMs));
}
