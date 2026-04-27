import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { useStore } from '../store';

interface TradeLog {
  id: number;
  mint: string;
  protocol: string;
  entry_amount_sol: number;
  exit_amount_sol: number;
  pnl_percent: number;
  exit_reason: string;
  sell_path: string;
  opened_at: number;
  closed_at: number;
}

export function Logs() {
  const [trades, setTrades] = useState<TradeLog[]>([]);
  const [loading, setLoading] = useState(true);
  const recentTrades = useStore(s => s.recentTrades);

  const loadTrades = useCallback(async () => {
    try {
      const data: any = await api.getTrades({ limit: '50' });
      setTrades(data.trades ?? []);
    } catch {} finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTrades();
    const interval = setInterval(loadTrades, 10000);
    return () => clearInterval(interval);
  }, [loadTrades]);

  const formatTime = (ts: number) => {
    if (!ts) return '-';
    return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Trade Logs</h1>
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          Auto-refresh 10s
        </div>
      </div>

      {recentTrades.length > 0 && (
        <div className="bg-zinc-900 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-2">Live (this session)</h2>
          <div className="space-y-1">
            {recentTrades.slice(0, 5).map((t) => (
              <div key={`${t.mint}-${t.timestamp}`} className="flex items-center justify-between text-xs font-mono py-1 border-b border-zinc-800">
                <span className="text-zinc-300">{t.mint.slice(0, 12)}...</span>
                <span className="text-zinc-500">{t.protocol}</span>
                <span className="text-zinc-400">{t.reason}</span>
                <span className={(t.pnlSol ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}>
                  {(t.pnlSol ?? 0) >= 0 ? '+' : ''}{(t.pnlSol ?? 0).toFixed(4)} SOL
                </span>
                <span className="text-zinc-500">{((t.durationMs ?? 0) / 1000).toFixed(1)}s</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-zinc-900 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-800 text-zinc-400">
            <tr>
              <th className="px-3 py-2 text-left">Time</th>
              <th className="px-3 py-2 text-left">Mint</th>
              <th className="px-3 py-2 text-left">Protocol</th>
              <th className="px-3 py-2 text-left">Reason</th>
              <th className="px-3 py-2 text-right">Entry</th>
              <th className="px-3 py-2 text-right">Exit</th>
              <th className="px-3 py-2 text-right">PnL %</th>
              <th className="px-3 py-2 text-left">Sell Path</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-zinc-500">Loading...</td></tr>
            ) : trades.length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-zinc-500">No trades recorded yet</td></tr>
            ) : trades.map(t => (
              <tr key={t.id} className="border-t border-zinc-800 hover:bg-zinc-800/50">
                <td className="px-3 py-2 text-zinc-400 text-xs">{formatTime(t.closed_at)}</td>
                <td className="px-3 py-2 font-mono text-xs">
                  <a href={`https://solscan.io/token/${t.mint}`} target="_blank" rel="noreferrer"
                    className="text-blue-400 hover:underline">{t.mint.slice(0, 8)}...</a>
                </td>
                <td className="px-3 py-2 text-zinc-400">{t.protocol}</td>
                <td className="px-3 py-2 text-zinc-400">{t.exit_reason}</td>
                <td className="px-3 py-2 text-right font-mono">{t.entry_amount_sol?.toFixed(3)}</td>
                <td className="px-3 py-2 text-right font-mono">{t.exit_amount_sol?.toFixed(4)}</td>
                <td className={`px-3 py-2 text-right font-mono ${(t.pnl_percent ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {(t.pnl_percent ?? 0) >= 0 ? '+' : ''}{(t.pnl_percent ?? 0).toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-zinc-500 text-xs">{t.sell_path || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
