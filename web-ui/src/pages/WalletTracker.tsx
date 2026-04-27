import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';

type TrackedWallet = {
  address: string;
  completedTrades: number;
  wins: number;
  winRate: number;
  tier: 0 | 1 | 2;
  recentLosses: number;
  lastSeen: number;
  openTrades: number;
};

type TierFilter = 'all' | 't1' | 't2' | 'none';

function short(addr: string): string {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-4)}`;
}

function ago(ts: number): string {
  if (!ts) return '—';
  const d = Date.now() - ts;
  if (d < 60_000) return `${Math.floor(d / 1000)}s`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  return `${Math.floor(d / 86_400_000)}d`;
}

function tierBadge(tier: 0 | 1 | 2) {
  if (tier === 1)
    return <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-700 text-white">T1</span>;
  if (tier === 2)
    return <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-yellow-700 text-white">T2</span>;
  return <span className="px-1.5 py-0.5 rounded text-[10px] text-zinc-500 bg-zinc-800">—</span>;
}

export function WalletTracker() {
  const [wallets, setWallets] = useState<TrackedWallet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<TierFilter>('all');
  const [addInput, setAddInput] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const reload = async () => {
    setError(null);
    try {
      const data = await api.getTrackedWallets();
      setWallets(data);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load wallets');
    }
  };

  useEffect(() => {
    reload();
    // Polling — copy-trade data changes continuously in the background
    const id = setInterval(reload, 10_000);
    return () => clearInterval(id);
  }, []);

  const filtered = useMemo(() => {
    if (!wallets) return [];
    const arr = wallets.filter(w => {
      if (filter === 't1') return w.tier === 1;
      if (filter === 't2') return w.tier === 2;
      if (filter === 'none') return w.tier === 0;
      return true;
    });
    // Sort: eligible tiers first, then by WR desc, then by completedTrades desc
    return arr.sort((a, b) => {
      if (a.tier !== b.tier) {
        // T1 (1) before T2 (2) before None (0): treat 0 as 3 for ordering
        const ta = a.tier === 0 ? 3 : a.tier;
        const tb = b.tier === 0 ? 3 : b.tier;
        return ta - tb;
      }
      if (a.winRate !== b.winRate) return b.winRate - a.winRate;
      return b.completedTrades - a.completedTrades;
    });
  }, [wallets, filter]);

  const counts = useMemo(() => {
    if (!wallets) return { total: 0, t1: 0, t2: 0, none: 0 };
    let t1 = 0, t2 = 0, none = 0;
    for (const w of wallets) {
      if (w.tier === 1) t1++;
      else if (w.tier === 2) t2++;
      else none++;
    }
    return { total: wallets.length, t1, t2, none };
  }, [wallets]);

  const handleAdd = async () => {
    const addr = addInput.trim();
    if (!addr) return;
    setBusy(true);
    setError(null);
    try {
      await api.addTrackedWallet(addr);
      setAddInput('');
      await reload();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to add wallet');
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (addr: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.removeTrackedWallet(addr);
      await reload();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to remove wallet');
    } finally {
      setBusy(false);
    }
  };

  const handleTier = async (addr: string, tier: 0 | 1 | 2) => {
    setBusy(true);
    setError(null);
    try {
      await api.setTrackedWalletTier(addr, tier);
      await reload();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to set tier');
    } finally {
      setBusy(false);
    }
  };

  const copy = async (addr: string) => {
    try {
      await navigator.clipboard.writeText(addr);
      setCopied(addr);
      setTimeout(() => setCopied(c => (c === addr ? null : c)), 1200);
    } catch {
      /* clipboard unavailable over http — silent fail */
    }
  };

  if (!wallets) {
    return (
      <div className="text-zinc-400">
        {error ? <span className="text-red-400">Error: {error}</span> : 'Loading tracker…'}
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold">Copy-Trade Wallets</h1>
        <div className="flex gap-2 text-xs">
          <span className="px-2 py-1 rounded bg-zinc-800 text-zinc-300">
            Total: <span className="text-white font-mono">{counts.total}</span>
          </span>
          <span className="px-2 py-1 rounded bg-green-950 text-green-300">
            T1: <span className="font-mono">{counts.t1}</span>
          </span>
          <span className="px-2 py-1 rounded bg-yellow-950 text-yellow-300">
            T2: <span className="font-mono">{counts.t2}</span>
          </span>
          <span className="px-2 py-1 rounded bg-zinc-800 text-zinc-400">
            None: <span className="font-mono">{counts.none}</span>
          </span>
        </div>
      </div>

      {error && (
        <div className="bg-red-950/40 border border-red-900 text-red-300 rounded-lg px-3 py-2 text-sm">
          {error}
        </div>
      )}

      {/* Add wallet */}
      <div className="bg-zinc-900 rounded-xl p-4 space-y-2">
        <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Add wallet</h2>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Wallet address"
            value={addInput}
            onChange={e => setAddInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleAdd();
            }}
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm font-mono text-white"
          />
          <button
            onClick={handleAdd}
            disabled={busy || !addInput.trim()}
            className="px-3 py-1 bg-green-600 hover:bg-green-500 disabled:opacity-40 rounded text-sm"
          >
            Add
          </button>
        </div>
        <p className="text-[11px] text-zinc-600">
          Wallets are also auto-discovered from the Geyser stream. Manually added wallets start with 0 trades —
          promote to T1/T2 to copy-trade from them immediately.
        </p>
      </div>

      {/* Filter */}
      <div className="flex gap-1 text-xs">
        {(['all', 't1', 't2', 'none'] as TierFilter[]).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1 rounded ${
              filter === f
                ? 'bg-zinc-700 text-white'
                : 'bg-zinc-900 text-zinc-400 hover:text-white'
            }`}
          >
            {f === 'all' ? 'All' : f === 'none' ? 'Untiered' : f.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-zinc-900 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-950 text-zinc-500 text-xs uppercase">
            <tr>
              <th className="text-left px-3 py-2 font-semibold">Wallet</th>
              <th className="text-right px-3 py-2 font-semibold">Tier</th>
              <th className="text-right px-3 py-2 font-semibold">Trades</th>
              <th className="text-right px-3 py-2 font-semibold">WR</th>
              <th className="text-right px-3 py-2 font-semibold">Open</th>
              <th className="text-right px-3 py-2 font-semibold">Losses</th>
              <th className="text-right px-3 py-2 font-semibold">Last seen</th>
              <th className="text-right px-3 py-2 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-zinc-600 text-xs">
                  {wallets.length === 0 ? 'No tracked wallets yet.' : 'No wallets match this filter.'}
                </td>
              </tr>
            ) : (
              filtered.map(w => (
                <tr key={w.address} className="border-t border-zinc-800 hover:bg-zinc-950/40">
                  <td className="px-3 py-2">
                    <button
                      onClick={() => copy(w.address)}
                      title={w.address}
                      className="font-mono text-xs text-zinc-300 hover:text-white"
                    >
                      {short(w.address)}
                      {copied === w.address && <span className="ml-1 text-green-400">✓</span>}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-right">{tierBadge(w.tier)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-zinc-300">
                    {w.wins}/{w.completedTrades}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    <span
                      className={
                        w.winRate >= 0.6
                          ? 'text-green-400'
                          : w.winRate >= 0.5
                          ? 'text-yellow-400'
                          : 'text-zinc-500'
                      }
                    >
                      {(w.winRate * 100).toFixed(0)}%
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-zinc-400">
                    {w.openTrades}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    <span className={w.recentLosses >= 3 ? 'text-red-400' : 'text-zinc-500'}>
                      {w.recentLosses}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-zinc-500">
                    {ago(w.lastSeen)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex gap-1 justify-end">
                      <button
                        onClick={() => handleTier(w.address, 1)}
                        disabled={busy || w.tier === 1}
                        title="Promote to T1"
                        className="px-1.5 py-0.5 rounded text-[10px] bg-green-900 hover:bg-green-800 disabled:opacity-30 text-green-200"
                      >
                        T1
                      </button>
                      <button
                        onClick={() => handleTier(w.address, 2)}
                        disabled={busy || w.tier === 2}
                        title="Set to T2"
                        className="px-1.5 py-0.5 rounded text-[10px] bg-yellow-900 hover:bg-yellow-800 disabled:opacity-30 text-yellow-200"
                      >
                        T2
                      </button>
                      <button
                        onClick={() => handleTier(w.address, 0)}
                        disabled={busy || w.tier === 0}
                        title="Clear tier"
                        className="px-1.5 py-0.5 rounded text-[10px] bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 text-zinc-300"
                      >
                        —
                      </button>
                      <button
                        onClick={() => handleRemove(w.address)}
                        disabled={busy}
                        title="Remove from tracker"
                        className="px-1.5 py-0.5 rounded text-[10px] bg-red-900 hover:bg-red-800 disabled:opacity-30 text-red-200"
                      >
                        ✕
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-zinc-600">
        Auto-refreshes every 10s. Manual tier override may be revised by the tracker on the wallet's next
        sell if win-rate doesn't match — it's a hint, not a lock.
      </p>
    </div>
  );
}
