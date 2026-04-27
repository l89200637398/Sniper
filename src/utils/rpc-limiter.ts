// src/utils/rpc-limiter.ts
import pLimit from 'p-limit';

// Ограничение параллельных RPC-запросов
export const rpcLimiter = pLimit(20); // было 10

export function withRpcLimit<T>(fn: () => Promise<T>): Promise<T> {
  return rpcLimiter(fn);
}