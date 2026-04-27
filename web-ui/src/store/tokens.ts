// Live token scoring store.
//
// Ring-buffer of recently scored tokens, fed by Socket.IO `token:scored`
// events and initial REST fetch. Kept separate from main store to avoid
// unnecessary re-renders on Dashboard/Positions pages.

import { create } from 'zustand';
import type { ScoredToken } from '../lib/api';

const MAX_BUFFER = 200;

interface TokenQualityState {
  tokens: ScoredToken[];
  append: (t: ScoredToken) => void;
  setInitial: (list: ScoredToken[]) => void;
  clear: () => void;
}

export const useTokenStore = create<TokenQualityState>((set) => ({
  tokens: [],
  append: (t) => set((state) => ({
    tokens: [t, ...state.tokens].slice(0, MAX_BUFFER),
  })),
  setInitial: (list) => set((state) => {
    // Merge: keep live tokens (already prepended), add REST tokens that
    // are not already present (by mint+timestamp dedup).
    const seen = new Set(state.tokens.map(t => `${t.mint}:${t.timestamp}`));
    const fresh = list.filter(t => !seen.has(`${t.mint}:${t.timestamp}`));
    return { tokens: [...state.tokens, ...fresh].slice(0, MAX_BUFFER) };
  }),
  clear: () => set({ tokens: [] }),
}));
