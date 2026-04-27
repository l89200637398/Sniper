import { memo } from 'react';
import { api } from '../lib/api';
import type { Position } from '../store';

export const PositionCard = memo(function PositionCard({ position }: { position: Position }) {
  const pnlPercent = position.pnlPercent ?? 0;
  const pnlColor = pnlPercent >= 0 ? 'text-green-400' : 'text-red-400';
  const ageMin = Math.floor((position.ageMs ?? 0) / 60_000);

  return (
    <div className={`bg-zinc-900 border rounded-xl p-4 space-y-2
      ${position.runnerTail ? 'border-yellow-500/40' : 'border-zinc-800'}`}>
      <div className="flex justify-between items-start">
        <div>
          <a href={`https://solscan.io/token/${position.mint}`} target="_blank" rel="noreferrer"
             className="text-xs font-mono text-blue-400 hover:underline">
            {position.mint.slice(0,8)}...
          </a>
          <div className="text-xs text-zinc-500">{position.protocol} · {ageMin}m ago</div>
        </div>
        <div className={`text-lg font-bold ${pnlColor}`}>
          {pnlPercent >= 0 ? '+' : ''}{pnlPercent.toFixed(1)}%
          {position.runnerTail && <span className="ml-1 text-yellow-400 text-xs">R</span>}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1 text-xs text-zinc-400">
        <span>Entry: {(position.entryPrice ?? 0).toFixed(8)}</span>
        <span>Now: {(position.currentPrice ?? 0).toFixed(8)}</span>
        <span>Amount: {(position.amount ?? 0).toFixed(0)}</span>
        <span>In: {(position.entryAmountSol ?? 0).toFixed(3)} SOL</span>
      </div>
      <div className="flex gap-2 pt-1">
        <button
          onClick={() => { if (confirm(`Sell ${position.mint.slice(0,8)}?`)) api.sellNow(position.mint); }}
          className="flex-1 py-1.5 bg-red-600/80 hover:bg-red-600 rounded text-xs"
        >
          Sell Now
        </button>
        <a href={`https://dexscreener.com/solana/${position.mint}`} target="_blank" rel="noreferrer"
           className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-xs">
          Chart
        </a>
      </div>
    </div>
  );
});
