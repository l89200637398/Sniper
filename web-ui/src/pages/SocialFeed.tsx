import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useSocialStore, type LiveSocialSignal } from '../store/social';

// ── Types (minimal client-side views, match api.ts return shapes) ──────────

type FeedSignal = Awaited<ReturnType<typeof api.getSocialFeed>>[number];
type Mention    = Awaited<ReturnType<typeof api.getSocialMentions>>[number];
type Status     = Awaited<ReturnType<typeof api.getSocialStatus>>[number];

// ── Helpers ────────────────────────────────────────────────────────────────

function ago(ts: number): string {
  const d = Date.now() - ts;
  if (d < 1000)       return 'now';
  if (d < 60_000)     return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000)  return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function short(s: string | undefined, n = 10): string {
  if (!s) return '';
  if (s.length <= n + 2) return s;
  return `${s.slice(0, n)}…`;
}

const SOURCE_COLOR: Record<string, string> = {
  dexscreener: 'bg-blue-900 text-blue-200',
  twitter:     'bg-sky-900 text-sky-200',
  telegram:    'bg-teal-900 text-teal-200',
  birdeye:     'bg-amber-900 text-amber-200',
  pumpfun:     'bg-fuchsia-900 text-fuchsia-200',
  reddit:      'bg-orange-900 text-orange-200',
};

function SourceBadge({ source }: { source: string }) {
  const cls = SOURCE_COLOR[source] ?? 'bg-zinc-800 text-zinc-300';
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${cls}`}>
      {source}
    </span>
  );
}

function sentimentColor(s: number): string {
  if (s >= 0.2)  return 'text-green-400';
  if (s <= -0.2) return 'text-red-400';
  return 'text-zinc-500';
}

function sentimentLabel(s: number): string {
  if (s >= 0.2)  return `+${(s ?? 0).toFixed(2)}`;
  if (s <= -0.2) return (s ?? 0).toFixed(2);
  return '0';
}

const WINDOW_OPTS: { label: string; ms: number }[] = [
  { label: '15m', ms: 15 * 60_000 },
  { label: '1h',  ms: 60 * 60_000 },
  { label: '6h',  ms: 6 * 60 * 60_000 },
  { label: '24h', ms: 24 * 60 * 60_000 },
];

/** Dedup key that matches backend signalKey() reasonably well. */
function dedupKey(s: { url?: string; source: string; author?: string; rawText?: string; timestamp: number }): string {
  if (s.url) return `${s.source}:${s.url}`;
  return `${s.source}:${s.author ?? ''}:${(s.rawText ?? '').slice(0, 120)}:${s.timestamp}`;
}

// ── Component ─────────────────────────────────────────────────────────────

export function SocialFeed() {
  const [initial, setInitial] = useState<FeedSignal[] | null>(null);
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [status, setStatus] = useState<Status[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [windowMs, setWindowMs] = useState<number>(60 * 60_000);
  const [copied, setCopied] = useState<string | null>(null);
  const [alphaOnly, setAlphaOnly] = useState<boolean>(false);

  const liveSignals = useSocialStore(s => s.signals);

  // Initial REST load + 30s polling for mentions & status.
  const loadMentions = async () => {
    try { setMentions(await api.getSocialMentions(windowMs, 20)); }
    catch (e: any) { setError(e?.message ?? 'Failed to load mentions'); }
  };
  const loadStatus = async () => {
    try { setStatus(await api.getSocialStatus()); } catch { /* non-critical */ }
  };
  const loadInitial = async () => {
    try { setInitial(await api.getSocialFeed(50)); }
    catch (e: any) { setError(e?.message ?? 'Failed to load feed'); }
  };

  useEffect(() => {
    loadInitial();
    loadStatus();
  }, []);

  useEffect(() => {
    loadMentions();
    const id = setInterval(() => { loadMentions(); loadStatus(); }, 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowMs]);

  // Combined feed: live signals take priority, supplement from REST initial.
  const feed = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<FeedSignal | LiveSocialSignal> = [];
    const push = (s: FeedSignal | LiveSocialSignal) => {
      const k = dedupKey(s);
      if (seen.has(k)) return;
      seen.add(k);
      out.push(s);
    };
    for (const s of liveSignals) push(s);
    for (const s of initial ?? []) push(s);
    // Newest first by timestamp.
    out.sort((a, b) => b.timestamp - a.timestamp);
    const filtered = alphaOnly ? out.filter(s => s.alpha) : out;
    return filtered.slice(0, 100);
  }, [liveSignals, initial, alphaOnly]);

  const alphaTotal = useMemo(() => {
    const seen = new Set<string>();
    let n = 0;
    const tally = (s: FeedSignal | LiveSocialSignal) => {
      if (!s.alpha) return;
      const k = dedupKey(s);
      if (seen.has(k)) return;
      seen.add(k);
      n++;
    };
    for (const s of liveSignals) tally(s);
    for (const s of initial ?? []) tally(s);
    return n;
  }, [liveSignals, initial]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied(c => (c === text ? null : c)), 1200);
    } catch { /* clipboard unavailable over http — silent fail */ }
  };

  if (initial === null && !error) {
    return <div className="text-zinc-400">Loading social feed…</div>;
  }

  return (
    <div className="space-y-4 max-w-7xl">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold">Social Feed</h1>
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          <span>
            {feed.length} signals in view  ·  {initial?.length ?? 0} from DB  ·  {liveSignals.length} live
          </span>
          <button
            onClick={() => setAlphaOnly(v => !v)}
            className={`px-2 py-0.5 rounded border text-[11px] ${
              alphaOnly
                ? 'bg-yellow-900/40 border-yellow-600 text-yellow-200'
                : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-yellow-200 hover:border-yellow-700'
            }`}
            title="Filter to whitelisted (alpha) signals only"
          >
            {alphaOnly ? '★ Alpha only' : `☆ Alpha (${alphaTotal})`}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-950/40 border border-red-900 text-red-300 rounded-lg px-3 py-2 text-sm">
          {error}
        </div>
      )}

      {/* Source status chips */}
      {status.length > 0 && (
        <div className="bg-zinc-900 rounded-xl p-3 flex flex-wrap gap-2 text-[11px]">
          <span className="text-zinc-500 uppercase tracking-wider">Sources:</span>
          {status.map(s => (
            <span
              key={s.name}
              title={s.lastError ? `Error: ${s.lastError}` : `last yield: ${s.lastYield ?? '-'} / new: ${s.lastNew ?? '-'}`}
              className={`px-2 py-0.5 rounded ${
                s.lastError
                  ? 'bg-red-950 text-red-300'
                  : s.running
                  ? 'bg-emerald-950 text-emerald-300'
                  : 'bg-zinc-800 text-zinc-500'
              }`}
            >
              {s.name}
              {s.lastRunAt ? ` · ${ago(s.lastRunAt)}` : ''}
              {s.lastNew !== undefined ? ` · +${s.lastNew}` : ''}
            </span>
          ))}
          {status.length === 0 && (
            <span className="text-zinc-500">No sources registered</span>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* ── Left column: Top Mentions ──────────────────────────────────── */}
        <div className="bg-zinc-900 rounded-xl p-4 space-y-3 lg:col-span-1">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
              Top Mentions
            </h2>
            <div className="flex gap-1 text-[10px]">
              {WINDOW_OPTS.map(o => (
                <button
                  key={o.ms}
                  onClick={() => setWindowMs(o.ms)}
                  className={`px-1.5 py-0.5 rounded ${
                    windowMs === o.ms ? 'bg-zinc-700 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-white'
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          {mentions.length === 0 ? (
            <p className="text-xs text-zinc-600">
              No mentions in the selected window. Bot must be running for signals to accumulate.
            </p>
          ) : (
            <div className="space-y-1">
              {mentions.map(m => (
                <button
                  key={m.key}
                  onClick={() => copy(m.key)}
                  className="w-full flex items-center justify-between gap-2 px-2 py-1 rounded hover:bg-zinc-950/40 text-left"
                  title={m.key}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-xs text-zinc-300 truncate">
                      {m.keyType === 'mint' ? short(m.key, 10) : `$${m.key}`}
                      {copied === m.key && <span className="ml-1 text-green-400">✓</span>}
                    </span>
                    <div className="flex gap-1">
                      {m.sources.slice(0, 3).map(s => (
                        <SourceBadge key={s} source={s} />
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-[11px] whitespace-nowrap">
                    <span className={`font-mono ${sentimentColor(m.avgSentiment)}`}>
                      {sentimentLabel(m.avgSentiment)}
                    </span>
                    <span className="font-mono text-white bg-zinc-800 rounded px-1.5 min-w-[28px] text-center">
                      {m.count}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ── Right columns: Live Feed ──────────────────────────────────── */}
        <div className="bg-zinc-900 rounded-xl p-4 space-y-2 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
              Live Feed
            </h2>
            <span className="text-[10px] text-zinc-600">newest first · max 100</span>
          </div>

          {feed.length === 0 ? (
            <p className="text-xs text-zinc-600">
              No signals yet. Start the bot and wait ~60s for the first DexScreener poll.
            </p>
          ) : (
            <div className="space-y-1 max-h-[70vh] overflow-y-auto pr-1">
              {feed.map(s => {
                const keyStr = dedupKey(s);
                const identifier = s.mint ?? (s.ticker ? `$${s.ticker}` : '—');
                return (
                  <div
                    key={keyStr}
                    className={`flex items-start gap-2 px-2 py-1.5 rounded border text-xs ${
                      s.alpha
                        ? 'border-yellow-600/70 bg-yellow-950/20 hover:bg-yellow-950/30'
                        : 'border-zinc-800 hover:bg-zinc-950/40'
                    }`}
                  >
                    {s.alpha && (
                      <span
                        className="text-yellow-400 text-[11px] shrink-0"
                        title="Alpha hit — mint/ticker/author in ALPHA_* whitelist"
                      >
                        ★
                      </span>
                    )}
                    <SourceBadge source={s.source} />
                    <button
                      onClick={() => copy(s.mint ?? s.ticker ?? '')}
                      title={s.mint ?? s.ticker ?? ''}
                      className="font-mono text-zinc-300 hover:text-white shrink-0"
                    >
                      {s.mint ? short(s.mint, 8) : identifier}
                      {copied === (s.mint ?? s.ticker) && <span className="ml-1 text-green-400">✓</span>}
                    </button>
                    <span className={`font-mono shrink-0 ${sentimentColor(s.sentiment)}`}>
                      {sentimentLabel(s.sentiment)}
                    </span>
                    <span
                      className="flex-1 min-w-0 truncate text-zinc-400"
                      title={s.rawText}
                    >
                      {s.rawText || '—'}
                    </span>
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="shrink-0 text-zinc-500 hover:text-white text-[11px]"
                      onClick={e => { if (!s.url) e.preventDefault(); }}
                    >
                      ↗
                    </a>
                    <span className="shrink-0 text-zinc-600 font-mono text-[10px] w-12 text-right">
                      {ago(s.timestamp)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <p className="text-[11px] text-zinc-600">
        Live via Socket.IO. Mentions poll every 30s. Sources list shows last poll
        time per parser. DexScreener is free; Twitter/Telegram parsers activate
        when their env vars are set. Alpha (★) marks signals whose mint/ticker/
        author matches ALPHA_TICKERS / ALPHA_MINTS / ALPHA_AUTHORS in .env.
      </p>
    </div>
  );
}
