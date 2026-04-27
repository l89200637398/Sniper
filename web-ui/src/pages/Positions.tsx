import { useStore } from '../store';
import { api } from '../lib/api';

export function Positions() {
  const positions = useStore(s => s.positions);
  const positionList = Object.values(positions);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Positions ({positionList.length})</h1>
        {positionList.length > 0 && (
          <button onClick={() => { if (confirm('Close ALL positions?')) api.closeAll(); }}
            className="px-4 py-2 bg-red-600 rounded-lg text-sm">Close All</button>
        )}
      </div>

      {positionList.length === 0 ? (
        <div className="bg-zinc-900 rounded-xl p-8 text-center text-zinc-500">
          No open positions. Positions appear here in real-time when the bot opens trades.
        </div>
      ) : (
        <div className="bg-zinc-900 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-800 text-zinc-400">
              <tr>
                <th className="px-3 py-2 text-left">Mint</th>
                <th className="px-3 py-2 text-left">Protocol</th>
                <th className="px-3 py-2 text-right">Entry</th>
                <th className="px-3 py-2 text-right">PnL %</th>
                <th className="px-3 py-2 text-right">Age</th>
                <th className="px-3 py-2 text-left">Signals</th>
                <th className="px-3 py-2 text-center">Action</th>
              </tr>
            </thead>
            <tbody>
              {positionList.map(p => (
                <tr key={p.mint} className="border-t border-zinc-800 hover:bg-zinc-800/50">
                  <td className="px-3 py-2 font-mono text-xs">
                    <a href={`https://solscan.io/token/${p.mint}`} target="_blank" rel="noreferrer"
                      className="text-blue-400 hover:underline">{p.mint.slice(0, 12)}...</a>
                    {p.runnerTail && <span className="ml-1 text-yellow-400 text-xs">R</span>}
                  </td>
                  <td className="px-3 py-2 text-zinc-400">{p.protocol}</td>
                  <td className="px-3 py-2 text-right font-mono">{(p.entryAmountSol ?? 0).toFixed(3)}</td>
                  <td className={`px-3 py-2 text-right font-mono ${(p.pnlPercent ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {(p.pnlPercent ?? 0) >= 0 ? '+' : ''}{(p.pnlPercent ?? 0).toFixed(1)}%
                  </td>
                  <td className="px-3 py-2 text-right text-zinc-400">
                    {Math.round((Date.now() - p.openedAt) / 1000)}s
                  </td>
                  <td className="px-3 py-2 text-zinc-500 text-xs">
                    {p.exitSignals?.join(', ') || '-'}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <button onClick={() => api.sellNow(p.mint)}
                      className="px-2 py-1 bg-red-700 hover:bg-red-600 rounded text-xs">Sell</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
