import { useEffect, useState, memo, useCallback } from 'react';
import { useStore, useShallow } from '../store';
import { useTrendStore } from '../store/trends';
import { api } from '../lib/api';
import { PositionCard } from '../components/PositionCard';
import { SystemStatus } from '../components/SystemStatus';
import { PnLChart } from '../components/PnLChart';

// ── Helpers ──────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (!ms) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function pnlColor(v: number): string {
  return v >= 0 ? 'text-green-400' : 'text-red-400';
}

function pnlSign(v: number): string {
  return v >= 0 ? '+' : '';
}

function humanizeReason(reason: string): string {
  return reason.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ── Push Logs Button ─────────────────────────────────────────────────────

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

// ── Event Counts Bar with Skip Breakdown ─────────────────────────────────

const EventCountsBar = memo(function EventCountsBar() {
  const eventCounts = useStore(useShallow(s => s.eventCounts));
  const isRunning = useStore(s => s.status.isRunning);
  const [expanded, setExpanded] = useState(false);

  if (!isRunning && eventCounts.detected === 0) return null;

  const skipReasons = eventCounts.skipReasons ?? {};
  const sortedReasons = Object.entries(skipReasons).sort((a, b) => b[1] - a[1]);
  const maxCount = sortedReasons.length > 0 ? sortedReasons[0][1] : 0;
  const hasReasons = sortedReasons.length > 0;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg">
      <div className="p-3 flex flex-wrap gap-4 text-sm items-center">
        <div>
          <span className="text-zinc-500 mr-1.5">Detected</span>
          <span className="font-mono text-white">{eventCounts.detected}</span>
        </div>
        <div>
          <span className="text-zinc-500 mr-1.5">Entered</span>
          <span className="font-mono text-green-400">{eventCounts.entered}</span>
        </div>
        <div>
          <span className="text-zinc-500 mr-1.5">Exited</span>
          <span className="font-mono text-yellow-400">{eventCounts.exited}</span>
        </div>
        <div
          className={`${hasReasons ? 'cursor-pointer hover:bg-zinc-800 -m-1 p-1 rounded transition' : ''}`}
          onClick={() => hasReasons && setExpanded(!expanded)}
        >
          <span className="text-zinc-500 mr-1.5">Skipped</span>
          <span className="font-mono text-zinc-400">{eventCounts.skipped}</span>
          {hasReasons && (
            <span className="ml-1 text-zinc-600 text-xs">{expanded ? '▲' : '▼'}</span>
          )}
        </div>
        {eventCounts.detected > 0 && (
          <div className="ml-auto">
            <span className="text-zinc-500 mr-1.5">Hit Rate</span>
            <span className="font-mono text-blue-400">
              {((eventCounts.entered / eventCounts.detected) * 100).toFixed(1)}%
            </span>
          </div>
        )}
      </div>

      {expanded && sortedReasons.length > 0 && (
        <div className="border-t border-zinc-800 p-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
          {sortedReasons.map(([reason, count]) => (
            <div key={reason} className="flex items-center gap-2 text-xs">
              <span className="text-zinc-500 w-44 truncate" title={reason}>
                {humanizeReason(reason)}
              </span>
              <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-zinc-600 rounded-full"
                  style={{ width: `${(count / maxCount) * 100}%` }}
                />
              </div>
              <span className="font-mono text-zinc-400 w-10 text-right">{count}</span>
              <span className="text-zinc-600 w-10 text-right">
                {eventCounts.skipped > 0 ? `${((count / eventCounts.skipped) * 100).toFixed(0)}%` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

// ── Stats Cards ──────────────────────────────────────────────────────────

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
  const exposure = useStore(s => s.exposure);
  const startBalance = useStore(s => s.startBalance);
  const recentTrades = useStore(s => s.recentTrades);

  const posCount = Object.keys(positions).length;
  const winRate = stats.total ? ((stats.wins / stats.total) * 100) : 0;
  const sessionPnl = startBalance > 0 ? (balanceSol ?? 0) - startBalance : 0;

  // Protocol breakdown from recent trades
  const protocolStats: Record<string, { total: number; wins: number; pnlSol: number }> = {};
  for (const t of recentTrades) {
    const proto = t.protocol || 'unknown';
    if (!protocolStats[proto]) protocolStats[proto] = { total: 0, wins: 0, pnlSol: 0 };
    protocolStats[proto].total++;
    if (t.pnlSol > 0) protocolStats[proto].wins++;
    protocolStats[proto].pnlSol += t.pnlSol;
  }
  const protoEntries = Object.entries(protocolStats).sort((a, b) => b[1].total - a[1].total);

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-5 gap-3">
      {/* Balance + Start */}
      <div className="bg-zinc-900 rounded-xl p-4 space-y-2">
        <div>
          <div className="text-xs text-zinc-500 mb-1">Balance</div>
          <div className="text-xl font-bold text-white">{(balanceSol ?? 0).toFixed(3)} SOL</div>
        </div>
        {startBalance > 0 && (
          <div className="border-t border-zinc-800 pt-1">
            <div className="text-[10px] text-zinc-500">Start: {startBalance.toFixed(3)} SOL</div>
            <div className={`text-xs font-mono ${pnlColor(sessionPnl)}`}>
              {pnlSign(sessionPnl)}{sessionPnl.toFixed(4)} SOL
            </div>
          </div>
        )}
      </div>

      {/* Positions + Exposure */}
      <div className="bg-zinc-900 rounded-xl p-4 space-y-2">
        <div>
          <div className="text-xs text-zinc-500 mb-1">Positions</div>
          <div className="text-xl font-bold text-white">{posCount}</div>
        </div>
        <div className="border-t border-zinc-800 pt-1">
          <div className="text-[10px] text-zinc-500">Exposure</div>
          <div className="text-xs font-mono text-white">{(exposure ?? 0).toFixed(4)} SOL</div>
        </div>
      </div>

      {/* Win Rate + Trades */}
      <div className="bg-zinc-900 rounded-xl p-4 space-y-2">
        <div>
          <div className="text-xs text-zinc-500 mb-1">Win Rate</div>
          <div className={`text-xl font-bold ${winRate >= 50 ? 'text-green-400' : stats.total > 0 ? 'text-red-400' : 'text-white'}`}>
            {stats.total > 0 ? `${winRate.toFixed(0)}%` : '-'}
          </div>
        </div>
        <div className="border-t border-zinc-800 pt-1">
          <div className="text-[10px] text-zinc-500">Trades: {stats.wins}W / {stats.total - stats.wins}L ({stats.total})</div>
        </div>
      </div>

      {/* Total PnL + Trends/Mode */}
      <div className="bg-zinc-900 rounded-xl p-4 space-y-2">
        <div>
          <div className="text-xs text-zinc-500 mb-1">Total PnL</div>
          <div className={`text-xl font-bold ${pnlColor(stats?.totalPnlSol ?? 0)}`}>
            {pnlSign(stats?.totalPnlSol ?? 0)}{(stats?.totalPnlSol ?? 0).toFixed(3)} SOL
          </div>
        </div>
        <div className="border-t border-zinc-800 pt-1 flex items-center gap-2">
          <span className="text-[10px] text-zinc-500">Trends: {trendCount}</span>
          {defensiveMode && <span className="text-[10px] text-yellow-400 font-semibold">DEFENSIVE</span>}
        </div>
      </div>

      {/* Protocol Breakdown */}
      <div className="bg-zinc-900 rounded-xl p-4 col-span-2 md:col-span-4 xl:col-span-1">
        <div className="text-xs text-zinc-500 mb-2">By Protocol</div>
        {protoEntries.length === 0 ? (
          <div className="text-zinc-600 text-xs">No trades yet</div>
        ) : (
          <div className="space-y-1.5">
            {protoEntries.map(([proto, s]) => {
              const wr = s.total > 0 ? (s.wins / s.total) * 100 : 0;
              return (
                <div key={proto} className="flex items-center justify-between text-xs">
                  <span className="text-zinc-400 w-20 truncate">{proto}</span>
                  <span className="font-mono text-zinc-500">{s.total}t</span>
                  <span className={`font-mono w-10 text-right ${wr >= 50 ? 'text-green-400' : s.total > 0 ? 'text-red-400' : 'text-zinc-500'}`}>
                    {s.total > 0 ? `${wr.toFixed(0)}%` : '-'}
                  </span>
                  <span className={`font-mono w-16 text-right ${pnlColor(s.pnlSol)}`}>
                    {pnlSign(s.pnlSol)}{s.pnlSol.toFixed(3)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});

// ── Recent Trades Table ──────────────────────────────────────────────────

const RecentTradesTable = memo(function RecentTradesTable() {
  const recentTrades = useStore(s => s.recentTrades);
  if (recentTrades.length === 0) return null;

  return (
    <div>
      <h2 className="text-sm font-medium text-zinc-400 mb-3">Recent Trades ({recentTrades.length})</h2>
      <div className="bg-zinc-900 rounded-xl overflow-hidden overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-zinc-800 text-zinc-400">
            <tr>
              <th className="px-3 py-2 text-left">Mint</th>
              <th className="px-3 py-2 text-left">Protocol</th>
              <th className="px-3 py-2 text-left">Reason</th>
              <th className="px-3 py-2 text-right">Entry</th>
              <th className="px-3 py-2 text-right">Exit</th>
              <th className="px-3 py-2 text-right">PnL %</th>
              <th className="px-3 py-2 text-right">PnL SOL</th>
              <th className="px-3 py-2 text-right">Duration</th>
            </tr>
          </thead>
          <tbody>
            {recentTrades.slice(0, 30).map((t) => (
              <tr key={`${t.mint}-${t.timestamp}`} className="border-t border-zinc-800 hover:bg-zinc-800/30">
                <td className="px-3 py-2 font-mono text-xs">
                  <a href={`https://solscan.io/token/${t.mint}`} target="_blank" rel="noreferrer"
                     className="text-blue-400 hover:underline">{t.mint.slice(0, 8)}...</a>
                </td>
                <td className="px-3 py-2 text-zinc-400 text-xs">{t.protocol}</td>
                <td className="px-3 py-2 text-zinc-400 text-xs">{t.reason}</td>
                <td className="px-3 py-2 text-right font-mono text-xs">{(t.entryAmountSol ?? 0).toFixed(4)}</td>
                <td className="px-3 py-2 text-right font-mono text-xs">{(t.finalSolReceived ?? 0).toFixed(4)}</td>
                <td className={`px-3 py-2 text-right font-mono text-xs ${pnlColor(t.pnlPercent ?? 0)}`}>
                  {pnlSign(t.pnlPercent ?? 0)}{(t.pnlPercent ?? 0).toFixed(1)}%
                </td>
                <td className={`px-3 py-2 text-right font-mono text-xs ${pnlColor(t.pnlSol ?? 0)}`}>
                  {pnlSign(t.pnlSol ?? 0)}{(t.pnlSol ?? 0).toFixed(4)}
                </td>
                <td className="px-3 py-2 text-right text-zinc-400 text-xs font-mono">
                  {formatDuration(t.durationMs ?? 0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
});

// ── Positions List ───────────────────────────────────────────────────────

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

// ── Dashboard ────────────────────────────────────────────────────────────

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
          for (const t of trades.slice(0, 30).reverse()) {
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
    <div className="space-y-4">
      {/* Top bar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <div className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${isRunning ? 'bg-green-400 animate-pulse' : 'bg-zinc-600'}`} />
            <span className={`text-sm ${isRunning ? 'text-green-400' : 'text-zinc-500'}`}>
              {isRunning ? 'Running' : 'Stopped'}
            </span>
          </div>
        </div>
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

      {/* Event Counts with Skip Breakdown */}
      <EventCountsBar />

      {/* Stats Cards */}
      {loading ? (
        <div className="text-zinc-500 text-sm animate-pulse">Loading dashboard...</div>
      ) : (
        <StatsCards />
      )}

      {/* Equity Curve */}
      <div className="bg-zinc-900 rounded-xl p-4">
        <h2 className="text-sm font-medium text-zinc-400 mb-3">Equity Curve (live)</h2>
        <PnLChart />
      </div>

      {/* Positions */}
      <PositionsList />

      {/* Recent Trades */}
      <RecentTradesTable />

      {/* System Status */}
      <SystemStatus />
    </div>
  );
}
