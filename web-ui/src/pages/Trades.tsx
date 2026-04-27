import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { api } from '../lib/api';
import { socket } from '../lib/socket';

interface Trade {
  id: number;
  mint: string;
  protocol: string;
  entry_price: number;
  exit_price: number;
  entry_amount_sol: number;
  exit_amount_sol: number;
  pnl_percent: number;
  exit_reason: string;
  sell_path: string;
  opened_at: number;
  closed_at: number;
  is_copy_trade: number;
  duration_ms?: number;
  token_score?: number;
}

const EXIT_REASONS = [
  'stop_loss', 'trailing_stop', 'hard_stop', 'velocity_drop', 'time_stop',
  'stagnation', 'break_even', 'tp_all', 'tp_partial', 'dead_volume',
  'whale_sell', 'creator_sell', 'early_exit', 'manual', 'rpc_error',
];

export function Trades() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ protocol: '', limit: '100', pnl: '', reason: '' });
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const loadTrades = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { limit: filterRef.current.limit };
      if (filterRef.current.protocol) params.protocol = filterRef.current.protocol;
      const data = (await api.getTrades(params)) as {
        trades: Trade[];
        total: number;
      };
      setTrades(data.trades || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTrades();
  }, [filter.protocol, filter.limit, loadTrades]);

  useEffect(() => {
    const onTradeClose = () => { loadTrades(); };
    socket.on('trade:close', onTradeClose);
    return () => { socket.off('trade:close', onTradeClose); };
  }, [loadTrades]);

  const filteredTrades = useMemo(() => {
    let result = trades;
    if (filter.pnl === 'win') result = result.filter(t => t.exit_amount_sol > t.entry_amount_sol);
    else if (filter.pnl === 'loss') result = result.filter(t => t.exit_amount_sol <= t.entry_amount_sol);
    if (filter.reason) result = result.filter(t => t.exit_reason === filter.reason);
    return result;
  }, [trades, filter.pnl, filter.reason]);

  const summary = useMemo(() => {
    const wins = filteredTrades.filter(t => t.exit_amount_sol > t.entry_amount_sol).length;
    const totalPnl = filteredTrades.reduce((s, t) => s + (t.exit_amount_sol - t.entry_amount_sol), 0);
    return { count: filteredTrades.length, wins, wr: filteredTrades.length ? (wins / filteredTrades.length * 100) : 0, totalPnl };
  }, [filteredTrades]);

  const formatDate = (ts: number) => new Date(ts).toLocaleString();
  const formatDuration = (ms: number) => {
    if (!ms) return '-';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
        <h1 className="text-2xl font-bold">Trade History</h1>
        <div className="flex flex-wrap gap-2">
          <select value={filter.protocol} onChange={(e) => setFilter({ ...filter, protocol: e.target.value })}
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm">
            <option value="">All protocols</option>
            <option value="pump.fun">Pump.fun</option>
            <option value="pumpswap">PumpSwap</option>
            <option value="raydium-launch">Raydium Launch</option>
            <option value="raydium-cpmm">Raydium CPMM</option>
            <option value="raydium-ammv4">Raydium AMMv4</option>
          </select>
          <select value={filter.pnl} onChange={(e) => setFilter({ ...filter, pnl: e.target.value })}
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm">
            <option value="">All PnL</option>
            <option value="win">Wins only</option>
            <option value="loss">Losses only</option>
          </select>
          <select value={filter.reason} onChange={(e) => setFilter({ ...filter, reason: e.target.value })}
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm">
            <option value="">All reasons</option>
            {EXIT_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <select value={filter.limit} onChange={(e) => setFilter({ ...filter, limit: e.target.value })}
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm">
            <option value="50">50</option>
            <option value="100">100</option>
            <option value="200">200</option>
          </select>
          <button onClick={loadTrades} className="bg-zinc-700 hover:bg-zinc-600 px-3 py-1 rounded text-sm transition">Refresh</button>
        </div>
      </div>

      {/* Summary bar */}
      <div className="flex flex-wrap gap-4 text-xs text-zinc-400">
        <span>Showing: <span className="text-white">{summary.count}</span> trades</span>
        <span>WR: <span className="text-white">{summary.wr.toFixed(0)}%</span> ({summary.wins}/{summary.count})</span>
        <span>PnL: <span className={summary.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}>
          {summary.totalPnl >= 0 ? '+' : ''}{summary.totalPnl.toFixed(4)} SOL
        </span></span>
      </div>

      {loading ? (
        <div className="text-zinc-400 animate-pulse">Loading...</div>
      ) : filteredTrades.length === 0 ? (
        <div className="text-zinc-500">No trades match filters.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-zinc-500 border-b border-zinc-800">
              <tr>
                <th className="text-left py-2">Mint</th>
                <th className="text-left">Protocol</th>
                <th className="text-right">Entry SOL</th>
                <th className="text-right">Exit SOL</th>
                <th className="text-right">PnL %</th>
                <th className="text-left">Reason</th>
                <th className="text-right">Duration</th>
                <th className="text-left">Closed</th>
              </tr>
            </thead>
            <tbody>
              {filteredTrades.map((trade) => (
                <tr key={trade.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                  <td className="py-2 font-mono text-xs">
                    <a href={`https://solscan.io/token/${trade.mint}`} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">
                      {trade.mint.slice(0, 8)}...
                    </a>
                    {trade.is_copy_trade ? <span className="ml-1 text-yellow-400" title="Copy-trade">C</span> : null}
                  </td>
                  <td className="text-zinc-400">{trade.protocol}</td>
                  <td className="text-right font-mono">{trade.entry_amount_sol.toFixed(4)}</td>
                  <td className="text-right font-mono">{trade.exit_amount_sol.toFixed(4)}</td>
                  <td className={`text-right font-mono ${trade.pnl_percent >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {trade.pnl_percent >= 0 ? '+' : ''}{trade.pnl_percent.toFixed(1)}%
                  </td>
                  <td className="text-zinc-400">{trade.exit_reason}</td>
                  <td className="text-right text-zinc-500">{formatDuration(trade.duration_ms ?? 0)}</td>
                  <td className="text-zinc-500">{formatDate(trade.closed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}