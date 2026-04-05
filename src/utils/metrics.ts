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

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

export const metrics = {
  inc(name: string, by: number = 1): void {
    const key = sanitize(name);
    counters.set(key, (counters.get(key) ?? 0) + by);
  },
  set(name: string, value: number): void {
    gauges.set(sanitize(name), value);
  },
  snapshot(): { counters: Record<string, number>; gauges: Record<string, number> } {
    return {
      counters: Object.fromEntries(counters),
      gauges: Object.fromEntries(gauges),
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
      res.end(JSON.stringify(metrics.snapshot()));
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
