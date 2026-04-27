import { create } from 'zustand';

export interface TrendEntry {
  mint: string;
  metrics: {
    pnlPercent?: number;
    volume?: number;
    buyCount?: number;
    strength?: number;
    [key: string]: any;
  };
  event: 'confirmed' | 'strengthening' | 'weakening';
  timestamp: number;
}

export interface TrendState {
  trackedCount: number;
  tracked: string[];
  events: TrendEntry[];
  setTracked: (count: number, mints: string[]) => void;
  addEvent: (entry: TrendEntry) => void;
  clear: () => void;
}

const MAX_EVENTS = 100;

export const useTrendStore = create<TrendState>((set) => ({
  trackedCount: 0,
  tracked: [],
  events: [],
  setTracked: (count, mints) => set({ trackedCount: count, tracked: mints }),
  addEvent: (entry) => set((s) => ({
    events: [entry, ...s.events].slice(0, MAX_EVENTS),
  })),
  clear: () => set({ trackedCount: 0, tracked: [], events: [] }),
}));
