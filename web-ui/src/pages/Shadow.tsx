import { useEffect, useState, useCallback, useRef } from 'react';
import { socket } from '../lib/socket';

// ── Types ─────────────────────────────────────────────────────────────────

interface ShadowPosition {
  mint: string;
  protocol: string;
  entryPrice: number;
  currentPrice: number;
  pnlPercent: number;
  entrySol: number;
  durationMs: number;
  isScalp?: boolean;
}

interface ShadowProfile {
  name: string;
  label: string;
  balance: number;
  startBalance: number;
  openPositions: number;
  closedTrades: number;
  wins: number;
  winRate: number;
  totalPnlSol: number;
  exposure: number;
  positions: ShadowPosition[];
}

interface ShadowStatus {
  running: boolean;
  startedAt: number;
  uptimeMs: number;
  profiles: ShadowProfile[];
  eventCounts: { detected: number; entered: number; exited: number; skipped: number };
}

interface TradeLogEntry {
  profile: string;
  mint: string;
  protocol: string;
  entrySol: number;
  exitSol: number;
  entryPrice: number;
  exitPrice: number;
  pnlPct: number;
  pnlSol: number;
  exitReason: string;
  durationMs: number;
  openedAt: number;
  closedAt: number;
  feesSol: number;
  isScalp?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────

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

const PROFILE_COLORS: Record<string, string> = {
  conservative: 'border-blue-600/50',
  balanced: 'border-yellow-600/50',
  aggressive: 'border-red-600/50',
};

const PROFILE_DOT_COLORS: Record<string, string> = {
  conservative: 'bg-blue-400',
  balanced: 'bg-yellow-400',
  aggressive: 'bg-red-400',
};

function profileBorderColor(name: string): string {
  const lower = name.toLowerCase();
  return PROFILE_COLORS[lower] ?? 'border-zinc-700';
}

function profileDotColor(name: string): string {
  const lower = name.toLowerCase();
  return PROFILE_DOT_COLORS[lower] ?? 'bg-zinc-400';
}

function shortMint(mint: string): string {
  return mint.length > 8 ? mint.slice(0, 8) : mint;
}

// ── Component ─────────────────────────────────────────────────────────────

export function Shadow() {
  const [status, setStatus] = useState<ShadowStatus | null>(null);
  const [trades, setTrades] = useState<TradeLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Fetch helpers ─────────────────────────────────────────────────────

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/shadow/status', { credentials: 'include' });
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const data: ShadowStatus = await res.json();
      setStatus(data);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to fetch shadow status');
    }
  }, []);

  const fetchTrades = useCallback(async () => {
    try {
      const res = await fetch('/api/shadow/trades?limit=50', { credentials: 'include' });
      if (!res.ok) return;
      const data: TradeLogEntry[] = await res.json();
      setTrades(data);
    } catch {
      // non-critical
    }
  }, []);

  const handleStop = useCallback(async () => {
    if (!confirm('Stop shadow trading?')) return;
    setStopping(true);
    try {
      const res = await fetch('/api/shadow/stop', {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`Stop failed: ${res.status}`);
      await fetchStatus();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to stop');
    } finally {
      setStopping(false);
    }
  }, [fetchStatus]);

  const handlePushToGit = useCallback(async () => {
    setPushing(true);
    setPushResult(null);
    try {
      const res = await fetch('/api/shadow/export-logs', {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`Push failed: ${res.status}`);
      const data = await res.json();
      if (data.ok) {
        setPushResult('Report pushed to git');
      } else {
        throw new Error(data.error ?? 'Unknown error');
      }
    } catch (e: any) {
      setError(e?.message ?? 'Failed to push report to git');
    } finally {
      setPushing(false);
      setTimeout(() => setPushResult(null), 5000);
    }
  }, []);

  // ── Initial load + polling ────────────────────────────────────────────

  useEffect(() => {
    let mounted = true;

    const init = async () => {
      setLoading(true);
      await Promise.all([fetchStatus(), fetchTrades()]);
      if (mounted) setLoading(false);
    };
    init();

    pollRef.current = setInterval(() => {
      fetchStatus();
      fetchTrades();
    }, 2000);

    return () => {
      mounted = false;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchStatus, fetchTrades]);

  // ── Socket.IO ─────────────────────────────────────────────────────────

  useEffect(() => {
    const onUpdate = (data: ShadowStatus) => {
      setStatus(data);
    };

    const onTrade = (data: TradeLogEntry & { type: 'open' | 'close' }) => {
      if (data.type === 'close') {
        setTrades(prev => {
          const next = [data, ...prev];
          return next.slice(0, 50);
        });
      }
    };

    socket.on('shadow:update', onUpdate);
    socket.on('shadow:trade', onTrade);

    return () => {
      socket.off('shadow:update', onUpdate);
      socket.off('shadow:trade', onTrade);
    };
  }, []);

  // ── Loading state ─────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Shadow Trading</h1>
        <div className="text-zinc-400 animate-pulse">Loading shadow status...</div>
      </div>
    );
  }

  // ── Not running state ─────────────────────────────────────────────────

  const isRunning = status?.running ?? false;
  const profiles = status?.profiles ?? [];
  const eventCounts = status?.eventCounts ?? { detected: 0, entered: 0, exited: 0, skipped: 0 };

  // Collect all open positions across profiles
  const allOpenPositions: Array<ShadowPosition & { profile: string }> = [];
  for (const p of profiles) {
    for (const pos of p.positions) {
      allOpenPositions.push({ ...pos, profile: p.name });
    }
  }

  return (
    <div className="space-y-4">
      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">Shadow Trading</h1>
          <div className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${isRunning ? 'bg-green-400 animate-pulse' : 'bg-zinc-600'}`} />
            <span className={`text-sm ${isRunning ? 'text-green-400' : 'text-zinc-500'}`}>
              {isRunning ? 'Running' : 'Stopped'}
            </span>
          </div>
          {isRunning && status?.uptimeMs != null && (
            <span className="text-xs text-zinc-500 font-mono">{formatDuration(status.uptimeMs)}</span>
          )}
        </div>
        <div className="flex gap-2 items-center">
          {pushResult && (
            <span className="text-xs text-green-400">{pushResult}</span>
          )}
          <button
            onClick={handlePushToGit}
            disabled={pushing}
            className="bg-zinc-700 hover:bg-zinc-600 px-3 py-1 rounded text-sm transition disabled:opacity-50"
          >
            {pushing ? 'Pushing...' : 'Push to Git'}
          </button>
          {isRunning && (
            <button
              onClick={handleStop}
              disabled={stopping}
              className="bg-red-600 hover:bg-red-500 px-3 py-1 rounded text-sm transition disabled:opacity-50"
            >
              {stopping ? 'Stopping...' : 'Stop'}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-lg p-3 flex items-center justify-between">
          <span className="text-red-400 text-sm">{error}</span>
          <button
            onClick={() => { setError(null); fetchStatus(); }}
            className="text-xs bg-red-700 hover:bg-red-600 px-3 py-1 rounded"
          >
            Retry
          </button>
        </div>
      )}

      {!isRunning && !loading && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center text-zinc-500">
          Shadow engine is not running. Start it from the server to begin virtual trading.
        </div>
      )}

      {/* ── Event Counts bar ─────────────────────────────────────────────── */}
      {(isRunning || eventCounts.detected > 0) && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 flex flex-wrap gap-4 text-sm">
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
          <div>
            <span className="text-zinc-500 mr-1.5">Skipped</span>
            <span className="font-mono text-zinc-400">{eventCounts.skipped}</span>
          </div>
        </div>
      )}

      {/* ── Profile cards ────────────────────────────────────────────────── */}
      {profiles.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {profiles.map(p => (
            <div
              key={p.name}
              className={`bg-zinc-900 border ${profileBorderColor(p.name)} rounded-lg p-4 space-y-3`}
            >
              <div className="flex items-center gap-2">
                <span className={`w-2.5 h-2.5 rounded-full ${profileDotColor(p.name)}`} />
                <span className="font-semibold text-white">{p.name}</span>
                <span className="text-xs text-zinc-500">{p.label}</span>
              </div>

              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <div>
                  <div className="text-zinc-500 text-xs">Balance</div>
                  <div className="font-mono text-white">{p.balance.toFixed(4)} SOL</div>
                </div>
                <div>
                  <div className="text-zinc-500 text-xs">Start</div>
                  <div className="font-mono text-zinc-400">{p.startBalance.toFixed(4)} SOL</div>
                </div>
                <div>
                  <div className="text-zinc-500 text-xs">Open</div>
                  <div className="font-mono text-white">{p.openPositions}</div>
                </div>
                <div>
                  <div className="text-zinc-500 text-xs">Closed</div>
                  <div className="font-mono text-white">{p.closedTrades}</div>
                </div>
                <div>
                  <div className="text-zinc-500 text-xs">Win Rate</div>
                  <div className={`font-mono ${p.winRate >= 50 ? 'text-green-400' : p.closedTrades > 0 ? 'text-red-400' : 'text-zinc-400'}`}>
                    {p.closedTrades > 0 ? `${p.winRate.toFixed(1)}%` : '-'}
                  </div>
                </div>
                <div>
                  <div className="text-zinc-500 text-xs">Exposure</div>
                  <div className="font-mono text-white">{p.exposure.toFixed(4)} SOL</div>
                </div>
              </div>

              <div className="border-t border-zinc-800 pt-2">
                <div className="text-zinc-500 text-xs">Total PnL</div>
                <div className={`font-mono text-lg font-bold ${pnlColor(p.totalPnlSol)}`}>
                  {pnlSign(p.totalPnlSol)}{p.totalPnlSol.toFixed(4)} SOL
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Open Positions ───────────────────────────────────────────────── */}
      {allOpenPositions.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-zinc-400 mb-3">
            Open Positions ({allOpenPositions.length})
          </h2>
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-zinc-500 border-b border-zinc-800">
                  <th className="px-3 py-2 text-left">Profile</th>
                  <th className="px-3 py-2 text-left">Mint</th>
                  <th className="px-3 py-2 text-left">Protocol</th>
                  <th className="px-3 py-2 text-right">Entry SOL</th>
                  <th className="px-3 py-2 text-right">PnL %</th>
                  <th className="px-3 py-2 text-right">Duration</th>
                </tr>
              </thead>
              <tbody>
                {allOpenPositions.map((pos, i) => (
                  <tr key={`${pos.profile}-${pos.mint}-${i}`} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full ${profileDotColor(pos.profile)}`} />
                        <span className="text-zinc-300 text-xs">{pos.profile}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      <a
                        href={`https://solscan.io/token/${pos.mint}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-400 hover:underline"
                      >
                        {shortMint(pos.mint)}...
                      </a>
                    </td>
                    <td className="px-3 py-2 text-zinc-400">
                      {pos.protocol}
                      {pos.isScalp && <span className="ml-1.5 text-[10px] font-semibold bg-cyan-600/30 text-cyan-300 px-1 py-0.5 rounded">SCALP</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{pos.entrySol.toFixed(4)}</td>
                    <td className={`px-3 py-2 text-right font-mono ${pnlColor(pos.pnlPercent)}`}>
                      {pnlSign(pos.pnlPercent)}{pos.pnlPercent.toFixed(1)}%
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-400 font-mono">
                      {formatDuration(pos.durationMs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Trade History ────────────────────────────────────────────────── */}
      <div>
        <h2 className="text-sm font-medium text-zinc-400 mb-3">
          Trade History ({trades.length})
        </h2>
        {trades.length === 0 ? (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 text-center text-zinc-500 text-sm">
            No closed trades yet.
          </div>
        ) : (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-zinc-500 border-b border-zinc-800">
                  <th className="px-3 py-2 text-left">Profile</th>
                  <th className="px-3 py-2 text-left">Mint</th>
                  <th className="px-3 py-2 text-left">Protocol</th>
                  <th className="px-3 py-2 text-right">Entry</th>
                  <th className="px-3 py-2 text-right">Exit</th>
                  <th className="px-3 py-2 text-right">PnL %</th>
                  <th className="px-3 py-2 text-left">Reason</th>
                  <th className="px-3 py-2 text-right">Duration</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t, i) => (
                  <tr key={`${t.profile}-${t.mint}-${t.closedAt}-${i}`} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full ${profileDotColor(t.profile)}`} />
                        <span className="text-zinc-300 text-xs">{t.profile}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      <a
                        href={`https://solscan.io/token/${t.mint}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-400 hover:underline"
                      >
                        {shortMint(t.mint)}...
                      </a>
                    </td>
                    <td className="px-3 py-2 text-zinc-400">
                      {t.protocol}
                      {t.isScalp && <span className="ml-1.5 text-[10px] font-semibold bg-cyan-600/30 text-cyan-300 px-1 py-0.5 rounded">SCALP</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{t.entrySol.toFixed(4)}</td>
                    <td className="px-3 py-2 text-right font-mono">{t.exitSol.toFixed(4)}</td>
                    <td className={`px-3 py-2 text-right font-mono ${pnlColor(t.pnlPct)}`}>
                      {pnlSign(t.pnlPct)}{t.pnlPct.toFixed(1)}%
                    </td>
                    <td className="px-3 py-2 text-zinc-400 text-xs">{t.exitReason}</td>
                    <td className="px-3 py-2 text-right text-zinc-400 font-mono">
                      {formatDuration(t.durationMs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
