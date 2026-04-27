import { memo } from 'react';
import { useStore } from '../store';
import { useTrendStore } from '../store/trends';

export const SystemStatus = memo(function SystemStatus() {
  const wsConnected = useStore(s => s.wsConnected);
  const geyser = useStore(s => s.status.geyser);
  const jito = useStore(s => s.status.jito);
  const rpcLatencyMs = useStore(s => s.status.rpcLatencyMs);
  const isRunning = useStore(s => s.status.isRunning);
  const defensiveMode = useStore(s => s.status.defensiveMode);
  const trendCount = useTrendStore(s => s.trackedCount);

  const dot = (ok: boolean) =>
    <span className={`inline-block w-2 h-2 rounded-full ${ok ? 'bg-green-500' : 'bg-red-500'}`} />;
  const rpcColor = rpcLatencyMs < 200 ? 'text-green-400' : rpcLatencyMs < 500 ? 'text-yellow-400' : 'text-red-400';

  return (
    <div className="bg-zinc-900 rounded-xl p-4">
      <h2 className="text-sm font-medium text-zinc-400 mb-3">System Status</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 text-xs">
        <div className="flex items-center gap-2">{dot(wsConnected)} WS: {wsConnected ? 'OK' : 'down'}</div>
        <div className="flex items-center gap-2">{dot(geyser === 'ok')} Geyser: {geyser}</div>
        <div className="flex items-center gap-2">{dot(jito === 'ok')} Jito: {jito}</div>
        <div className="flex items-center gap-2">{dot(rpcLatencyMs < 500)} RPC: <span className={rpcColor}>{rpcLatencyMs}ms</span></div>
        <div className="flex items-center gap-2">{dot(isRunning)} Bot: {isRunning ? 'running' : 'stopped'}</div>
        <div className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${defensiveMode ? 'bg-yellow-500' : 'bg-zinc-600'}`} />
          Mode: {defensiveMode ? <span className="text-yellow-400">defensive</span> : 'normal'}
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-blue-500" />
          Trends: {trendCount}
        </div>
      </div>
    </div>
  );
});
