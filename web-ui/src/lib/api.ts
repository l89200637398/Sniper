import { useStore } from '../store';

export interface ScoredToken {
  mint: string;
  protocol: string;
  score: number;
  shouldEnter: boolean;
  reasons: string[];
  entryMultiplier: number;
  rugcheckRisk: 'low' | 'medium' | 'high' | 'unknown';
  socialScore: number;
  timestamp: number;
}

const BASE = import.meta.env.VITE_API_URL ?? '';

async function request<T>(method: string, path: string, body?: any): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    useStore.getState().setAuthFailed(true);
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    let msg: string;
    try { msg = (await res.json()).error ?? res.statusText; }
    catch { msg = res.statusText; }
    throw new Error(msg);
  }
  return res.json();
}

export const api = {
  login: (password: string) => request('POST', '/login', { password }),
  start: () => request('POST', '/control/start'),
  stop: () => request('POST', '/control/stop'),
  sellNow: (mint: string) => request('POST', `/control/sell/${mint}`),
  closeAll: () => request('POST', '/control/close-all'),
  getConfig: () => request('GET', '/config'),
  setConfig: (changes: { path: string; value: any }[]) => request('PUT', '/config', { changes }),
  rollback: () => request('POST', '/config/rollback'),
  getTrades: (params?: Record<string, any>) => request('GET', `/trades?${new URLSearchParams(params)}`),
  getWallet: () => request('GET', '/wallet'),
  getPositions: () => request('GET', '/positions'),
  getBlacklist: () =>
    request<{ tokens: string[]; creators: string[]; stats: { tokens: number; creators: number } }>(
      'GET',
      '/blacklist',
    ),
  blacklistMint: (mint: string) => request('POST', `/blacklist/token/${mint}`),
  unblacklistMint: (mint: string) => request('DELETE', `/blacklist/token/${mint}`),
  blacklistCreator: (addr: string) => request('POST', `/blacklist/creator/${addr}`),
  unblacklistCreator: (addr: string) => request('DELETE', `/blacklist/creator/${addr}`),
  // Copy-trade / wallet tracker
  getTrackedWallets: () =>
    request<
      Array<{
        address: string;
        completedTrades: number;
        wins: number;
        winRate: number;
        tier: 0 | 1 | 2;
        recentLosses: number;
        lastSeen: number;
        openTrades: number;
      }>
    >('GET', '/wallets'),
  addTrackedWallet: (address: string) => request('POST', '/wallets', { address }),
  removeTrackedWallet: (address: string) => request('DELETE', `/wallets/${address}`),
  setTrackedWalletTier: (address: string, tier: 0 | 1 | 2) =>
    request('POST', `/wallets/${address}/tier`, { tier }),
  // Social signals (Phase 3)
  getSocialFeed: (limit = 50, alphaOnly = false) =>
    request<
      Array<{
        id: number;
        source: 'twitter' | 'telegram' | 'dexscreener' | 'birdeye' | 'pumpfun' | 'reddit';
        mint?: string;
        ticker?: string;
        sentiment: number;
        rawText: string;
        author?: string;
        followers?: number;
        url?: string;
        timestamp: number;
        createdAt: number;
        alpha?: boolean;
      }>
    >('GET', `/social/feed?limit=${limit}${alphaOnly ? '&alpha=1' : ''}`),
  getSocialMentions: (windowMs = 60 * 60 * 1000, limit = 20) =>
    request<
      Array<{
        key: string;
        keyType: 'mint' | 'ticker';
        count: number;
        avgSentiment: number;
        sources: string[];
        lastTimestamp: number;
      }>
    >('GET', `/social/mentions?window=${windowMs}&limit=${limit}`),
  // Token quality
  getRecentTokens: () =>
    request<{ tokens: ScoredToken[] }>('GET', '/tokens/recent'),
  getSocialStatus: () =>
    request<
      Array<{
        name: string;
        intervalMs: number;
        running: boolean;
        lastRunAt?: number;
        lastYield?: number;
        lastNew?: number;
        lastError?: string;
      }>
    >('GET', '/social/status'),
};
