// Live social signals store (Phase 3).
//
// Держим отдельно от основного useStore чтобы частые append-ы (каждые
// ~60s из DexScreener, чаще из Twitter/Telegram) не триггерили re-render
// Dashboard/Positions/etc. Подписчики — только страница SocialFeed.
//
// Ring-buffer на 200 элементов: старые выкидываем с хвоста. Этого
// достаточно для "last seen while tab was open" — история больше 200
// читается через REST getSocialFeed().

import { create } from 'zustand';

export interface LiveSocialSignal {
  source: string;
  mint?: string;
  ticker?: string;
  sentiment: number;
  rawText: string;
  author?: string;
  followers?: number;
  url?: string;
  timestamp: number;
  alpha?: boolean;
}

const MAX_BUFFER = 200;

interface SocialState {
  signals: LiveSocialSignal[];
  append: (s: LiveSocialSignal) => void;
  clear: () => void;
}

export const useSocialStore = create<SocialState>((set) => ({
  signals: [],
  append: (s) => set((state) => ({
    // Prepend — самый свежий сверху. trim по MAX_BUFFER.
    signals: [s, ...state.signals].slice(0, MAX_BUFFER),
  })),
  clear: () => set({ signals: [] }),
}));
