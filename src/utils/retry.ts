/**
 * Повторяет асинхронную функцию с экспоненциальной задержкой.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  delay = 200
): Promise<T> {
  let lastError: any;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
      }
    }
  }
  throw lastError;
}