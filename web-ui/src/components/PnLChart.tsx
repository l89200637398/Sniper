import { useEffect, useRef, memo } from 'react';
import { createChart, ColorType, AreaSeries } from 'lightweight-charts';
import type { UTCTimestamp, ISeriesApi } from 'lightweight-charts';
import { api } from '../lib/api';
import { socket } from '../lib/socket';

export const PnLChart = memo(function PnLChart() {
  const ref = useRef<HTMLDivElement>(null);
  const cumulativeRef = useRef(0);
  const lastTimeRef = useRef(0);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      layout: { background: { color: '#18181b', type: ColorType.Solid }, textColor: '#a1a1aa' },
      grid: { vertLines: { color: '#27272a' }, horzLines: { color: '#27272a' } },
      width: ref.current.clientWidth,
      height: 220,
    });
    const series = chart.addSeries(AreaSeries, {
      lineColor: '#22c55e',
      topColor: '#22c55e33',
      bottomColor: 'transparent',
      lineWidth: 2,
    });
    seriesRef.current = series;

    api.getTrades({ limit: '500' }).then((data: any) => {
      const sorted = (data.trades as any[])
        .filter((t: any) => t.closed_at && t.closed_at > 0)
        .sort((a: any, b: any) => a.closed_at - b.closed_at);

      let lastTime = 0;
      let cumulative = 0;
      const points: { time: UTCTimestamp; value: number }[] = [];
      for (const t of sorted) {
        let time = Math.floor(t.closed_at / 1000);
        if (time <= lastTime) time = lastTime + 1;
        lastTime = time;
        cumulative += (t.exit_amount_sol ?? 0) - (t.entry_amount_sol ?? 0);
        points.push({ time: time as UTCTimestamp, value: cumulative });
      }
      cumulativeRef.current = cumulative;
      lastTimeRef.current = lastTime;
      if (points.length > 0) {
        series.setData(points);
        chart.timeScale().fitContent();
      }
    }).catch(() => {});

    const onTradeClose = (d: any) => {
      const pnl = (d.pnlSol ?? (d.finalSolReceived ?? 0) - (d.entryAmountSol ?? 0));
      cumulativeRef.current += pnl;
      let time = Math.floor(Date.now() / 1000);
      if (time <= lastTimeRef.current) time = lastTimeRef.current + 1;
      lastTimeRef.current = time;
      seriesRef.current?.update({ time: time as UTCTimestamp, value: cumulativeRef.current });
    };
    socket.on('trade:close', onTradeClose);

    const ro = new ResizeObserver(() => chart.applyOptions({ width: ref.current!.clientWidth }));
    ro.observe(ref.current);
    return () => { chart.remove(); ro.disconnect(); socket.off('trade:close', onTradeClose); };
  }, []);

  return <div ref={ref} />;
});
