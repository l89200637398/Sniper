import { useEffect, useState, memo, useCallback } from 'react';
import { useStore, useShallow } from '../store';
import { useTrendStore } from '../store/trends';
import { api } from '../lib/api';
import { PositionCard } from '../components/PositionCard';
import { SystemStatus } from '../components/SystemStatus';
import { PnLChart } from '../components/PnLChart';

function PushLogsButton() {
  const [pushing, setPushing] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const handlePush = useCallback(async () => {
    setPushing(true);
    setResult(null);
    try {
      const data = await api.pushLogsToGit();
      setResult({ ok: data.ok, message: data.message ?? (data.ok ? 'Done' : (data.error ?? 'Error')) });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setResult({ ok: false, message: msg });
    } finally {
      setPushing(false);
      setTimeout(() => setResult(null), 6000);
    }
  }, []);

  return (
    <div className="flex items-center gap-2">
      {result && (
        <span className={`text-xs ${result.ok ? 'text-green-400' : 'text-red-400'}`}>
          {result.message}
        </span>
      )}
      <button
        onClick={handlePush}
        disabled={pushing}
        className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 rounded-lg text-sm transition disabled:opacity-50"
      >
        {pushing ? 'Pushing...' : 'Push Logs'}
      </button>
    </div>
  );
}

interface Trade {
  mint?: string;
  protocol?: string;
  exit_amount_sol: number;
  entry_amount_sol: number;
  pnl_percent?: number;
  exit_reason?: string;
  closed_at?: string;
}

const StatsCards = memo(function StatsCards() {
  const balanceSol = useStore(s => s.balanceSol);
  const positions = useStore(s => s.positions);
  const stats = useStore(useShallow(s => s.stats));
  const defensiveMode = useStore(s => s.status.defensiveMode);
  const trendCount = useTrendStore(s => s.trackedCount);

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
      <div className="bg-zinc-900 rounded-xl p-4">
        <div className="text-xs text-zinc-500 mb-1">Balance</div>
        <div className="text-xl font-bold text-white">{balanceSol.toFixed(3)} SOL</div>
      </div>
      <div className="bg-zinc-900 rounded-xl p-4">
        <div className="text-xs text-zinc-500 mb-1">Positions</div>
        <div className="text-xl font-bold text-white">{Object.keys(positions).length}</div>
      </div>
      <div className="bg-zinc-900 rounded-xl p-4">
        <div className="text-xs text-zinc-500 mb-1">Win Rate</div>
        <div className="text-xl font-bold text-white">{stats.total ? ((stats.wins / stats.total) * 100).toFixed(0) : 0}%</div>
      </div>
      <div className="bg-zinc-900 rounded-xl p-4">
        <div className="text-xs text-zinc-500 mb-1">Total PnL</div>
        <div className={`text-xl font-bold ${stats.totalPnlSol >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {(stats.totalPnlSol ?? 0) >= 0 ? '+' : ''}{(stats.totalPnlSol ?? 0).toFixed(3)} SOL
        </div>
      </div>
      <div className="bg-zinc-900 rounded-xl p-4">
        <div className="text-xs text-zinc-500 mb-1">Trades</div>
        <div className="text-xl font-bold text-white">{stats.total}</div>
      </div>
      <div className="bg-zinc-900 rounded-xl p-4">
        <div className="text-xs text-zinc-500 mb-1">Trends / Mode</div>
        <div className="text-xl font-bold text-white">
          {trendCount}
          {defensiveMode && <span className="ml-2 text-xs text-yellow-400 font-normal">DEF</span>}
        </div>
      </div>
    </div>
  );
});

const RecentTradesTable = memo(function RecentTradesTable() {
  const recentTrades = useStore(s => s.recentTrades);
  if (recentTrades.length === 0) return null;

  return (
    <div>
      <h2 className="text-sm font-medium text-zinc-400 mb-3">Recent Trades (live)</h2>
      <div className="bg-zinc-900 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-800 text-zinc-400">
            <tr>
              <th className="px-3 py-2 text-left">Mint</th>
              <th className="px-3 py-2 text-left">Reason</th>
              <th className="px-3 py-2 text-right">PnL</th>
              <th className="px-3 py-2 text-right">Duration</th>
            </tr>
          </thead>
          <tbody>
            {recentTrades.slice(0, 10).map((t) => (
              <tr key={`${t.mint}-${t.timestamp}`} className="border-t border-zinc-800">
                <td className="px-3 py-2 font-mono text-xs">{t.mint.slice(0, 8)}...</td>
                <td className="px-3 py-2 text-zinc-400">{t.reason}</td>
                <td className={`px-3 py-2 text-right font-mono ${t.pnlSol >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {t.pnlSol >= 0 ? '+' : ''}{t.pnlSol.toFixed(4)}
                </td>
                <td className="px-3 py-2 text-right text-zinc-400">{(t.durationMs / 1000).toFixed(1)}s</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
});

const PositionsList = memo(function PositionsList() {
  const positions = useStore(s => s.positions);
  const positionList = Object.values(positions);

  return (
    <div>
      <h2 className="text-sm font-medium text-zinc-400 mb-3">Active Positions ({positionList.length})</h2>
      {positionList.length === 0
        ? <div className="text-zinc-600 text-sm">No open positions</div>
        : <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {positionList.map(p => <PositionCard key={p.mint} position={p} />)}
          </div>
      }
    </div>
  );
});

export function Dashboard() {
  const isRunning = useStore(s => s.status.isRunning);
  const setBalance = useStore(s => s.setBalance);
  const setStats = useStore(s => s.setStats);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [walletData, tradeData] = await Promise.allSettled([
        api.getWallet(),
        api.getTrades({ limit: '200' }),
      ]);
      if (walletData.status === 'fulfilled') setBalance((walletData.value as any).balanceSol);
      if (tradeData.status === 'fulfilled') {
        const d = tradeData.value as any;
        const total = d.total;
        const trades = d.trades as Trade[];
        const wins = trades.filter(t => t.exit_amount_sol > t.entry_amount_sol).length;
        const totalPnlSol = trades.reduce((s, t) => s + (t.exit_amount_sol - t.entry_amount_sol), 0);
        setStats({ total, wins, totalPnlSol });
        const store = useStore.getState();
        if (store.recentTrades.length === 0 && trades.length > 0) {
          for (const t of trades.slice(0, 20).reverse()) {
            store.addTrade({
              mint: t.mint ?? '',
              protocol: t.protocol ?? '',
              reason: t.exit_reason ?? '',
              pnlSol: t.exit_amount_sol - t.entry_amount_sol,
              pnlPercent: t.pnl_percent ?? ((t.exit_amount_sol - t.entry_amount_sol) / t.entry_amount_sol * 100),
              entryAmountSol: t.entry_amount_sol,
              finalSolReceived: t.exit_amount_sol,
              durationMs: 0,
              timestamp: t.closed_at ? new Date(t.closed_at).getTime() : Date.now(),
            });
          }
        }
      }
      if (walletData.status === 'rejected' && tradeData.status === 'rejected') {
        setError('Failed to load initial data');
      }
    } catch {
      setError('Failed to load dashboard data');
    } finally {
      setLoading(false);
    }
  }, [setBalance, setStats]);

  useEffect(() => { loadInitial(); }, [loadInitial]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <div className="flex gap-2 items-center flex-wrap">
          <PushLogsButton />
          {isRunning
            ? <button onClick={() => api.stop()} className="px-4 py-2 bg-red-600 rounded-lg text-sm hover:bg-red-500 transition">Stop Bot</button>
            : <button onClick={() => api.start()} className="px-4 py-2 bg-green-600 rounded-lg text-sm hover:bg-green-500 transition">Start Bot</button>
          }
          <button onClick={() => { if (confirm('Close ALL positions?')) api.closeAll(); }}
            className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 rounded-lg text-sm transition">Close All</button>
        </div>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3 flex items-center justify-between">
          <span className="text-red-400 text-sm">{error}</span>
          <button onClick={loadInitial} className="text-xs bg-red-700 hover:bg-red-600 px-3 py-1 rounded">Retry</button>
        </div>
      )}

      {loading ? (
        <div className="text-zinc-500 text-sm animate-pulse">Loading dashboard...</div>
      ) : (
        <StatsCards />
      )}

      <div className="bg-zinc-900 rounded-xl p-4">
        <h2 className="text-sm font-medium text-zinc-400 mb-3">Equity Curve (live)</h2>
        <PnLChart />
      </div>

      <PositionsList />
      <RecentTradesTable />
      <SystemStatus />
    </div>
  );
}
