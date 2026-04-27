// src/utils/metrics.ts
//
// Минимальный in-memory сборщик метрик + HTTP endpoint (Prometheus-совместимый).
// Экспортирует `metrics.inc(name, by=1)` и `metrics.set(name, value)`.
//
// Запускается из entry point: `startMetricsServer(port)` — создаёт http.Server
// на /metrics. Отключён, если config.metrics.enabled === false.

import * as http from 'http';
import { logger } from './logger';

type Numberish = number;

const counters: Map<string, Numberish> = new Map();
const gauges: Map<string, Numberish> = new Map();
const histograms: Map<string, number[]> = new Map();

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export const metrics = {
  inc(name: string, by: number = 1): void {
    const key = sanitize(name);
    counters.set(key, (counters.get(key) ?? 0) + by);
  },
  set(name: string, value: number): void {
    gauges.set(sanitize(name), value);
  },
  observe(name: string, value: number): void {
    const key = sanitize(name);
    let arr = histograms.get(key);
    if (!arr) { arr = []; histograms.set(key, arr); }
    arr.push(value);
    if (arr.length > 10000) arr.splice(0, arr.length - 5000);
  },
  snapshot(): { counters: Record<string, number>; gauges: Record<string, number>; histograms: Record<string, { count: number; p50: number; p95: number; p99: number }> } {
    const hSnap: Record<string, { count: number; p50: number; p95: number; p99: number }> = {};
    for (const [k, arr] of histograms) {
      const sorted = [...arr].sort((a, b) => a - b);
      hSnap[k] = { count: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99) };
    }
    return {
      counters: Object.fromEntries(counters),
      gauges: Object.fromEntries(gauges),
      histograms: hSnap,
    };
  },
};

export function renderPrometheus(): string {
  const lines: string[] = [];
  for (const [k, v] of counters) {
    lines.push(`# TYPE sniper_${k} counter`);
    lines.push(`sniper_${k} ${v}`);
  }
  for (const [k, v] of gauges) {
    lines.push(`# TYPE sniper_${k} gauge`);
    lines.push(`sniper_${k} ${v}`);
  }
  for (const [k, arr] of histograms) {
    const sorted = [...arr].sort((a, b) => a - b);
    lines.push(`# TYPE sniper_${k} summary`);
    lines.push(`sniper_${k}{quantile="0.5"} ${percentile(sorted, 50)}`);
    lines.push(`sniper_${k}{quantile="0.95"} ${percentile(sorted, 95)}`);
    lines.push(`sniper_${k}{quantile="0.99"} ${percentile(sorted, 99)}`);
    lines.push(`sniper_${k}_count ${sorted.length}`);
  }
  return lines.join('\n') + '\n';
}

let server: http.Server | null = null;

export function startMetricsServer(port: number): void {
  if (server) return;
  server = http.createServer((req, res) => {
    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(renderPrometheus());
      return;
    }
    if (req.url === '/snapshot') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const snap = metrics.snapshot();
      res.end(JSON.stringify(snap));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  server.listen(port, '127.0.0.1', () => {
    logger.info(`[metrics] listening on http://127.0.0.1:${port}/metrics`);
  });
  server.on('error', (err: any) => {
    logger.warn(`[metrics] server error: ${err?.message ?? err}`);
  });
}

export function stopMetricsServer(): void {
  if (server) {
    server.close();
    server = null;
  }
}
