import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type BlacklistData = {
  tokens: string[];
  creators: string[];
  stats: { tokens: number; creators: number };
};

function short(addr: string): string {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-4)}`;
}

export function Blacklist() {
  const [data, setData] = useState<BlacklistData | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [creatorInput, setCreatorInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const reload = async () => {
    setError(null);
    try {
      const d = await api.getBlacklist();
      setData(d);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load blacklist');
    }
  };

  useEffect(() => {
    reload();
  }, []);

  const addToken = async () => {
    const mint = tokenInput.trim();
    if (!mint) return;
    setBusy(true);
    setError(null);
    try {
      await api.blacklistMint(mint);
      setTokenInput('');
      await reload();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to blacklist token');
    } finally {
      setBusy(false);
    }
  };

  const removeToken = async (mint: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.unblacklistMint(mint);
      await reload();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to unblacklist token');
    } finally {
      setBusy(false);
    }
  };

  const addCreator = async () => {
    const addr = creatorInput.trim();
    if (!addr) return;
    setBusy(true);
    setError(null);
    try {
      await api.blacklistCreator(addr);
      setCreatorInput('');
      await reload();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to blacklist creator');
    } finally {
      setBusy(false);
    }
  };

  const removeCreator = async (addr: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.unblacklistCreator(addr);
      await reload();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to unblacklist creator');
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
      /* clipboard API may be unavailable over plain http; ignore silently */
    }
  };

  if (!data) {
    return (
      <div className="text-zinc-400">
        {error ? <span className="text-red-400">Error: {error}</span> : 'Loading blacklist…'}
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Blacklist</h1>
        <div className="flex gap-2 text-xs">
          <span className="px-2 py-1 rounded bg-zinc-800 text-zinc-300">
            Tokens: <span className="text-white font-mono">{data.stats.tokens}</span>
          </span>
          <span className="px-2 py-1 rounded bg-zinc-800 text-zinc-300">
            Creators: <span className="text-white font-mono">{data.stats.creators}</span>
          </span>
        </div>
      </div>

      {error && (
        <div className="bg-red-950/40 border border-red-900 text-red-300 rounded-lg px-3 py-2 text-sm">
          {error}
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        {/* Tokens */}
        <section className="bg-zinc-900 rounded-xl p-4 space-y-3">
          <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Tokens (mints)</h2>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Mint address"
              value={tokenInput}
              onChange={e => setTokenInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') addToken();
              }}
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm font-mono text-white"
            />
            <button
              onClick={addToken}
              disabled={busy || !tokenInput.trim()}
              className="px-3 py-1 bg-green-600 hover:bg-green-500 disabled:opacity-40 rounded text-sm"
            >
              Add
            </button>
          </div>
          {data.tokens.length === 0 ? (
            <p className="text-xs text-zinc-600">No blacklisted tokens.</p>
          ) : (
            <ul className="space-y-1 max-h-[60vh] overflow-auto">
              {data.tokens.map(mint => (
                <li
                  key={mint}
                  className="flex items-center justify-between gap-2 bg-zinc-950 rounded px-2 py-1"
                >
                  <button
                    onClick={() => copy(mint)}
                    title={mint}
                    className="text-xs font-mono text-zinc-300 hover:text-white truncate"
                  >
                    {short(mint)}
                    {copied === mint && <span className="ml-1 text-green-400">✓</span>}
                  </button>
                  <button
                    onClick={() => removeToken(mint)}
                    disabled={busy}
                    className="text-xs text-red-400 hover:text-red-300 disabled:opacity-40"
                  >
                    remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Creators */}
        <section className="bg-zinc-900 rounded-xl p-4 space-y-3">
          <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Creators (wallets)</h2>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Creator address"
              value={creatorInput}
              onChange={e => setCreatorInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') addCreator();
              }}
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm font-mono text-white"
            />
            <button
              onClick={addCreator}
              disabled={busy || !creatorInput.trim()}
              className="px-3 py-1 bg-green-600 hover:bg-green-500 disabled:opacity-40 rounded text-sm"
            >
              Add
            </button>
          </div>
          {data.creators.length === 0 ? (
            <p className="text-xs text-zinc-600">No blacklisted creators.</p>
          ) : (
            <ul className="space-y-1 max-h-[60vh] overflow-auto">
              {data.creators.map(addr => (
                <li
                  key={addr}
                  className="flex items-center justify-between gap-2 bg-zinc-950 rounded px-2 py-1"
                >
                  <button
                    onClick={() => copy(addr)}
                    title={addr}
                    className="text-xs font-mono text-zinc-300 hover:text-white truncate"
                  >
                    {short(addr)}
                    {copied === addr && <span className="ml-1 text-green-400">✓</span>}
                  </button>
                  <button
                    onClick={() => removeCreator(addr)}
                    disabled={busy}
                    className="text-xs text-red-400 hover:text-red-300 disabled:opacity-40"
                  >
                    remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <p className="text-xs text-zinc-600">
        Tokens and creators are held in memory. Entries do not persist across restarts yet.
      </p>
    </div>
  );
}
