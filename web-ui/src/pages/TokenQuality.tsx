import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useTokenStore } from '../store/tokens';

// ── Helpers ──────────────────────────────────────────────────────────────

function ago(ts: number): string {
  const d = Date.now() - ts;
  if (d < 1000)       return 'now';
  if (d < 60_000)     return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000)  return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function scoreColor(score: number): string {
  if (score >= 70) return 'text-green-400';
  if (score >= 40) return 'text-yellow-400';
  return 'text-red-400';
}

function scoreBg(score: number): string {
  if (score >= 70) return 'bg-green-950/50 border-green-800';
  if (score >= 40) return 'bg-yellow-950/50 border-yellow-800';
  return 'bg-red-950/50 border-red-800';
}

const RISK_STYLE: Record<string, string> = {
  low:     'bg-green-950 text-green-300',
  medium:  'bg-yellow-950 text-yellow-300',
  high:    'bg-red-950 text-red-300',
  unknown: 'bg-zinc-800 text-zinc-400',
};

const PROTOCOL_LABEL: Record<string, string> = {
  'pump.fun':  'Pump.fun',
  pumpswap:    'PumpSwap',
  raydium:     'Raydium',
  launchlab:   'LaunchLab',
  cpmm:        'CPMM',
  ammv4:       'AMM v4',
  jupiter:     'Jupiter',
};

const PROTOCOL_STYLE: Record<string, string> = {
  'pump.fun':  'bg-fuchsia-950 text-fuchsia-300',
  pumpswap:    'bg-purple-950 text-purple-300',
  raydium:     'bg-blue-950 text-blue-300',
  launchlab:   'bg-blue-950 text-blue-300',
  cpmm:        'bg-cyan-950 text-cyan-300',
  ammv4:       'bg-indigo-950 text-indigo-300',
  jupiter:     'bg-orange-950 text-orange-300',
};

type ProtocolFilter = 'all' | string;
type EntryFilter = 'all' | 'yes' | 'no';
type ScoreRange = 'all' | 'high' | 'mid' | 'low';

// ── Component ────────────────────────────────────────────────────────────

export function TokenQuality() {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [protocolFilter, setProtocolFilter] = useState<ProtocolFilter>('all');
  const [entryFilter, setEntryFilter] = useState<EntryFilter>('all');
  const [scoreRange, setScoreRange] = useState<ScoreRange>('all');
  const [copied, setCopied] = useState<string | null>(null);

  const liveTokens = useTokenStore(s => s.tokens);
  const setInitial = useTokenStore(s => s.setInitial);

  // Initial REST load
  useEffect(() => {
    api.getRecentTokens()
      .then(data => {
        setInitial(data.tokens ?? []);
        setLoaded(true);
      })
      .catch((e: any) => {
        setError(e?.message ?? 'Failed to load tokens');
        setLoaded(true);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Collect unique protocols for filter dropdown
  const protocols = useMemo(() => {
    const set = new Set<string>();
    for (const t of liveTokens) set.add(t.protocol);
    return Array.from(set).sort();
  }, [liveTokens]);

  // Filtered view
  const filtered = useMemo(() => {
    return liveTokens.filter(t => {
      if (protocolFilter !== 'all' && t.protocol !== protocolFilter) return false;
      if (entryFilter === 'yes' && !t.shouldEnter) return false;
      if (entryFilter === 'no' && t.shouldEnter) return false;
      if (scoreRange === 'high' && t.score < 70) return false;
      if (scoreRange === 'mid' && (t.score < 40 || t.score >= 70)) return false;
      if (scoreRange === 'low' && t.score >= 40) return false;
      return true;
    });
  }, [liveTokens, protocolFilter, entryFilter, scoreRange]);

  // Stats
  const stats = useMemo(() => {
    const total = liveTokens.length;
    const entered = liveTokens.filter(t => t.shouldEnter).length;
    const avgScore = total > 0 ? liveTokens.reduce((s, t) => s + t.score, 0) / total : 0;
    return { total, entered, avgScore };
  }, [liveTokens]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied(c => (c === text ? null : c)), 1200);
    } catch { /* clipboard unavailable */ }
  };

  if (!loaded && !error) {
    return <div className="text-zinc-400">Loading token quality data...</div>;
  }

  return (
    <div className="space-y-4 max-w-7xl">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold">Token Quality</h1>
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          <span>
            {stats.total} scored  |  {stats.entered} entered  |  avg {(stats.avgScore ?? 0).toFixed(0)} pts
          </span>
        </div>
      </div>

      {error && (
        <div className="bg-red-950/40 border border-red-900 text-red-300 rounded-lg px-3 py-2 text-sm">
          {error}
        </div>
      )}

      {/* Filters */}
      <div className="bg-zinc-900 rounded-xl p-3 flex flex-wrap items-center gap-3 text-xs">
        <span className="text-zinc-500 uppercase tracking-wider">Filters:</span>

        {/* Protocol filter */}
        <select
          value={protocolFilter}
          onChange={e => setProtocolFilter(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 text-zinc-300 rounded px-2 py-1 text-xs"
        >
          <option value="all">All Protocols</option>
          {protocols.map(p => (
            <option key={p} value={p}>{PROTOCOL_LABEL[p] ?? p}</option>
          ))}
        </select>

        {/* Score range */}
        <div className="flex gap-1">
          {([
            { key: 'all', label: 'All Scores' },
            { key: 'high', label: '70+' },
            { key: 'mid', label: '40-69' },
            { key: 'low', label: '<40' },
          ] as { key: ScoreRange; label: string }[]).map(o => (
            <button
              key={o.key}
              onClick={() => setScoreRange(o.key)}
              className={`px-2 py-0.5 rounded ${
                scoreRange === o.key
                  ? 'bg-zinc-700 text-white'
                  : 'bg-zinc-800 text-zinc-400 hover:text-white'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>

        {/* Entry filter */}
        <div className="flex gap-1">
          {([
            { key: 'all', label: 'All' },
            { key: 'yes', label: 'Entered' },
            { key: 'no', label: 'Skipped' },
          ] as { key: EntryFilter; label: string }[]).map(o => (
            <button
              key={o.key}
              onClick={() => setEntryFilter(o.key)}
              className={`px-2 py-0.5 rounded ${
                entryFilter === o.key
                  ? 'bg-zinc-700 text-white'
                  : 'bg-zinc-800 text-zinc-400 hover:text-white'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>

        <span className="text-zinc-600 ml-auto">
          {filtered.length} / {stats.total} shown
        </span>
      </div>

      {/* Table */}
      <div className="bg-zinc-900 rounded-xl overflow-hidden">
        {filtered.length === 0 ? (
          <div className="px-4 py-8 text-center text-zinc-600 text-sm">
            {stats.total === 0
              ? 'No scored tokens yet. Start the bot and wait for token events.'
              : 'No tokens match the current filters.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-800 text-zinc-400 text-xs uppercase tracking-wider">
                <tr>
                  <th className="px-3 py-2 text-left">Mint</th>
                  <th className="px-3 py-2 text-left">Protocol</th>
                  <th className="px-3 py-2 text-center">Score</th>
                  <th className="px-3 py-2 text-center">Entry</th>
                  <th className="px-3 py-2 text-left">Reasons</th>
                  <th className="px-3 py-2 text-center">Rugcheck</th>
                  <th className="px-3 py-2 text-center">Social</th>
                  <th className="px-3 py-2 text-right">Time</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t, idx) => (
                  <tr
                    key={`${t.mint}-${t.timestamp}-${idx}`}
                    className="border-t border-zinc-800 hover:bg-zinc-950/40"
                  >
                    {/* Mint */}
                    <td className="px-3 py-2">
                      <button
                        onClick={() => copy(t.mint)}
                        className="font-mono text-xs text-zinc-300 hover:text-white"
                        title={t.mint}
                      >
                        {t.mint.slice(0, 8)}...
                        {copied === t.mint && (
                          <span className="ml-1 text-green-400">copied</span>
                        )}
                      </button>
                    </td>

                    {/* Protocol */}
                    <td className="px-3 py-2">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${
                          PROTOCOL_STYLE[t.protocol] ?? 'bg-zinc-800 text-zinc-300'
                        }`}
                      >
                        {PROTOCOL_LABEL[t.protocol] ?? t.protocol}
                      </span>
                    </td>

                    {/* Score */}
                    <td className="px-3 py-2 text-center">
                      <span
                        className={`inline-block px-2 py-0.5 rounded border text-xs font-bold ${scoreBg(t.score)} ${scoreColor(t.score)}`}
                      >
                        {t.score}
                      </span>
                    </td>

                    {/* Entry */}
                    <td className="px-3 py-2 text-center">
                      {t.shouldEnter ? (
                        <span className="text-green-400 font-bold" title={`Multiplier: ${t.entryMultiplier}x`}>
                          {t.entryMultiplier !== 1.0 ? `${t.entryMultiplier}x` : 'Y'}
                        </span>
                      ) : (
                        <span className="text-red-400">N</span>
                      )}
                    </td>

                    {/* Reasons */}
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1 max-w-xs">
                        {t.reasons.slice(0, 6).map((r, i) => {
                          const isNeg = r.startsWith('-') || r.includes('(-');
                          return (
                            <span
                              key={`${r}-${i}`}
                              className={`px-1 py-0.5 rounded text-[10px] font-mono ${
                                isNeg
                                  ? 'bg-red-950/60 text-red-300'
                                  : 'bg-zinc-800 text-zinc-300'
                              }`}
                            >
                              {r}
                            </span>
                          );
                        })}
                        {t.reasons.length > 6 && (
                          <span className="text-[10px] text-zinc-500">
                            +{t.reasons.length - 6}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Rugcheck */}
                    <td className="px-3 py-2 text-center">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                          RISK_STYLE[t.rugcheckRisk] ?? RISK_STYLE.unknown
                        }`}
                      >
                        {t.rugcheckRisk}
                      </span>
                    </td>

                    {/* Social Score */}
                    <td className="px-3 py-2 text-center font-mono text-xs">
                      <span className={t.socialScore > 0 ? 'text-blue-400' : 'text-zinc-600'}>
                        {t.socialScore}
                      </span>
                    </td>

                    {/* Time */}
                    <td className="px-3 py-2 text-right text-zinc-500 font-mono text-[11px] whitespace-nowrap">
                      {ago(t.timestamp)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-[11px] text-zinc-600">
        Live via Socket.IO (token:scored). Score range: 0-100 (green 70+, yellow 40-69, red &lt;40).
        Entry multiplier: 1.5x for high confidence, 1.0x normal, 0.5x low confidence.
        Reasons show scoring rule hits from token-scorer v4.
      </p>
    </div>
  );
}
