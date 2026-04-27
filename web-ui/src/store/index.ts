import { create } from 'zustand';
import { useShallow } from 'zustand/shallow';
import { socket } from '../lib/socket';
import { useSocialStore, type LiveSocialSignal } from './social';
import { useTokenStore } from './tokens';
import { useTrendStore } from './trends';

export interface Position {
  mint: string;
  protocol: string;
  entryPrice: number;
  currentPrice: number;
  pnlPercent: number;
  amount: number;
  entryAmountSol: number;
  openedAt: number;
  ageMs: number;
  runnerTail: boolean;
  exitSignals: string[];
}

export interface TradeEvent {
  mint: string;
  protocol: string;
  reason: string;
  pnlSol: number;
  pnlPercent: number;
  entryAmountSol: number;
  finalSolReceived: number;
  durationMs: number;
  timestamp: number;
}

export interface SystemStatus {
  geyser: 'ok' | 'reconnecting' | 'down';
  jito: 'ok' | 'rate-limited' | 'down';
  rpcLatencyMs: number;
  isRunning: boolean;
  defensiveMode: boolean;
}

interface AppState {
  positions: Record<string, Position>;
  balanceSol: number;
  stats: { total: number; wins: number; totalPnlSol: number };
  recentTrades: TradeEvent[];
  status: SystemStatus;
  wsConnected: boolean;
  authFailed: boolean;
  setPositions: (positions: Position[]) => void;
  updatePosition: (position: Position) => void;
  removePosition: (mint: string) => void;
  setBalance: (sol: number) => void;
  setStats: (stats: { total: number; wins: number; totalPnlSol: number }) => void;
  addTrade: (trade: TradeEvent) => void;
  setStatus: (status: Partial<SystemStatus>) => void;
  setWsConnected: (connected: boolean) => void;
  setAuthFailed: (failed: boolean) => void;
}

export const useStore = create<AppState>((set) => ({
  positions: {},
  balanceSol: 0,
  stats: { total: 0, wins: 0, totalPnlSol: 0 },
  recentTrades: [],
  status: { geyser: 'ok', jito: 'ok', rpcLatencyMs: 0, isRunning: false, defensiveMode: false },
  wsConnected: false,
  authFailed: false,

  setPositions: (list) => set({ positions: Object.fromEntries(list.map(p => [p.mint, p])) }),
  updatePosition: (p) => set(s => ({ positions: { ...s.positions, [p.mint]: p } })),
  removePosition: (mint) => set(s => {
    const next = { ...s.positions };
    delete next[mint];
    return { positions: next };
  }),
  setBalance: (sol) => set({ balanceSol: sol }),
  setStats: (stats) => set({ stats }),
  addTrade: (trade) => set(s => ({ recentTrades: [trade, ...s.recentTrades].slice(0, 100) })),
  setStatus: (partial) => set(s => ({ status: { ...s.status, ...partial } })),
  setWsConnected: (connected) => set({ wsConnected: connected }),
  setAuthFailed: (failed) => set({ authFailed: failed }),
}));

export { useShallow };

export function bindSocketToStore() {
  socket.on('connect', () => {
    useStore.getState().setWsConnected(true);
  });
  socket.on('disconnect', () => {
    useStore.getState().setWsConnected(false);
  });
  socket.on('connect_error', () => {
    useStore.getState().setWsConnected(false);
  });

  socket.on('snapshot', (d: any) => {
    useStore.getState().setPositions(d.positions);
    useStore.getState().setStatus({ isRunning: d.isRunning, defensiveMode: d.defensiveMode });
  });
  socket.on('position:open', (p: Position) => useStore.getState().updatePosition(p));
  socket.on('position:update', (p: Position) => useStore.getState().updatePosition(p));
  socket.on('position:close', (p: Position) => useStore.getState().removePosition(p.mint));
  socket.on('balance:update', (d: { sol: number }) => useStore.getState().setBalance(d.sol));
  socket.on('stats:update', (d: { total: number; wins: number; totalPnlSol: number }) => {
    useStore.getState().setStats(d);
  });
  socket.on('trade:close', (d: any) => {
    useStore.getState().addTrade({
      mint: d.mint,
      protocol: d.protocol ?? '',
      reason: d.reason ?? d.exitReason ?? '',
      pnlSol: d.pnlSol ?? (d.finalSolReceived ?? 0) - (d.entryAmountSol ?? 0),
      pnlPercent: d.pnlPercent ?? 0,
      entryAmountSol: d.entryAmountSol ?? 0,
      finalSolReceived: d.finalSolReceived ?? d.totalSolReceived ?? 0,
      durationMs: d.durationMs ?? 0,
      timestamp: Date.now(),
    });
  });

  socket.on('system:status', (d: any) => {
    useStore.getState().setStatus({ isRunning: d.isRunning, defensiveMode: d.defensiveMode });
  });

  socket.on('social:signal', (s: LiveSocialSignal) => {
    useSocialStore.getState().append(s);
  });

  socket.on('token:scored', (data: any) => {
    useTokenStore.getState().append(data);
  });

  socket.on('social:alpha', (s: LiveSocialSignal) => {
    useSocialStore.getState().append({ ...s, alpha: true });
  });

  socket.on('trend:confirmed', (d: any) => {
    useTrendStore.getState().addEvent({ mint: d.mint, metrics: d.metrics, event: 'confirmed', timestamp: Date.now() });
  });
  socket.on('trend:strengthening', (d: any) => {
    useTrendStore.getState().addEvent({ mint: d.mint, metrics: d.metrics, event: 'strengthening', timestamp: Date.now() });
  });
  socket.on('trend:weakening', (d: any) => {
    useTrendStore.getState().addEvent({ mint: d.mint, metrics: d.metrics, event: 'weakening', timestamp: Date.now() });
  });
  socket.on('trend:update', (d: any) => {
    useTrendStore.getState().setTracked(d.trackedCount ?? 0, d.tracked ?? []);
  });
}
