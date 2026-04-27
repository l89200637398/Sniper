// scripts/shadow-run.ts
//
// Shadow trading — виртуальные агенты на реальном gRPC потоке.
// Используется при остановленном боевом снайпере.
//
// Usage:
//   npx ts-node scripts/shadow-run.ts              # все 3 профиля
//   npx ts-node scripts/shadow-run.ts balanced      # только один профиль
//   npx ts-node scripts/shadow-run.ts conservative aggressive

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { ShadowEngine } from '../src/shadow/engine';
import { PROFILES } from '../src/shadow/profiles';
import { logger } from '../src/utils/logger';

const args = process.argv.slice(2);
const selectedProfiles = args.length > 0
  ? PROFILES.filter(p => args.includes(p.name))
  : PROFILES;

if (selectedProfiles.length === 0) {
  console.error(`Unknown profile(s): ${args.join(', ')}. Available: ${PROFILES.map(p => p.name).join(', ')}`);
  process.exit(1);
}

console.log(`\n  Shadow Trading — ${selectedProfiles.map(p => p.label).join(', ')}\n`);

const engine = new ShadowEngine(selectedProfiles);

// ── Web server ──────────────────────────────────────────────────────────────

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true, credentials: true },
});

app.use(express.json());

app.get('/api/shadow/status', (_req, res) => {
  res.json(engine.getStatus());
});

app.get('/api/shadow/trades', (req, res) => {
  const limit = Number(req.query.limit) || 50;
  res.json(engine.getTrades(limit));
});

app.get('/api/shadow/report', (_req, res) => {
  res.json(engine.getReport());
});

app.post('/api/shadow/stop', async (_req, res) => {
  try {
    const report = await engine.stop();
    const reportPath = path.resolve(__dirname, '../data/shadow-report.json');
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    logger.info(`[shadow] Report saved to ${reportPath}`);
    res.json({ ok: true, report });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/shadow/export-logs', async (_req, res) => {
  try {
    const { execSync } = require('child_process');
    const root = path.resolve(__dirname, '..');
    const logsExportDir = path.resolve(root, 'logs-export');
    fs.mkdirSync(logsExportDir, { recursive: true });

    const report = engine.getReport();
    const reportPath = path.resolve(root, 'data/shadow-report.json');
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    const snapshotPath = path.resolve(root, 'data/shadow-snapshots.json');
    const snapshots = engine.getStatus();
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshots, null, 2));

    const logsDir = path.resolve(root, 'logs');
    const archivePath = path.resolve(logsExportDir, 'all-logs.tar.gz');

    // Collect ALL log files: bot-*, events-*, trades-*, shadow-* (rotated: .log, .log.1, etc.)
    const logFiles = fs.existsSync(logsDir)
      ? fs.readdirSync(logsDir).filter(f => f.includes('.log'))
      : [];

    if (logFiles.length > 0) {
      execSync(
        `tar czf "${archivePath}" ${logFiles.map(f => `"${f}"`).join(' ')}`,
        { cwd: logsDir, timeout: 60000 },
      );
    }

    const dbPath = path.resolve(root, 'data/sniper.db');
    const dbExport = path.resolve(logsExportDir, 'sniper.db');
    if (fs.existsSync(dbPath)) {
      fs.copyFileSync(dbPath, dbExport);
    }

    const posPath = path.resolve(root, 'data/positions.json');
    const posExport = path.resolve(logsExportDir, 'positions.json');
    if (fs.existsSync(posPath)) {
      fs.copyFileSync(posPath, posExport);
    }

    // Run WR analysis SQL and save results
    const wrSqlPath = path.resolve(root, 'scripts/analyze-wr.sql');
    const wrReportPath = path.resolve(logsExportDir, 'wr-analysis.txt');
    if (fs.existsSync(dbPath) && fs.existsSync(wrSqlPath)) {
      try {
        const wrOutput = execSync(
          `sqlite3 "${dbPath}" < "${wrSqlPath}"`,
          { cwd: root, timeout: 30000, encoding: 'utf8' },
        );
        fs.writeFileSync(wrReportPath, wrOutput);
        logger.info(`[shadow] WR analysis: ${wrOutput.split('\n').length} lines`);
      } catch (wrErr) {
        logger.warn(`[shadow] WR analysis failed: ${wrErr}`);
      }
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const gitFiles = [
      'data/shadow-report.json',
      'data/shadow-snapshots.json',
      'logs-export/all-logs.tar.gz',
      'logs-export/sniper.db',
      'logs-export/positions.json',
      'logs-export/wr-analysis.txt',
    ].filter(f => fs.existsSync(path.resolve(root, f)));

    execSync(`git add -f ${gitFiles.join(' ')}`, { cwd: root });
    execSync(`git commit -m "chore: shadow export ${ts}"`, { cwd: root });
    execSync(`git push origin HEAD`, { cwd: root, timeout: 60000 });

    logger.info(`[shadow] Export pushed to git (${gitFiles.length} files)`);
    res.json({ ok: true, pushed: true, files: gitFiles });
  } catch (err) {
    logger.error(`[shadow] export-logs error: ${err}`);
    res.status(500).json({ error: String(err) });
  }
});

// Stub routes for web-ui pages that expect sniper API
app.get('/api/wallet', (_req, res) => res.json({ balance: 0, address: '' }));
app.get('/api/positions', (_req, res) => res.json({ positions: [] }));
app.get('/api/control/status', (_req, res) => res.json({ isRunning: false, geyser: 'shadow', mode: 'shadow' }));
app.post('/api/login', (_req, res) => res.json({ token: 'shadow-mode' }));

// Static files
const distPath = path.resolve(__dirname, '../web-ui/dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('/{*path}', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.send('<h1>Shadow Trading Running</h1><p>Web UI not built. Run: cd web-ui && npm run build</p>');
  });
}

// Socket.IO
engine.on('shadow:update', (data: any) => io.emit('shadow:update', data));
engine.on('shadow:trade', (data: any) => io.emit('shadow:trade', data));
engine.on('shadow:started', () => io.emit('shadow:started'));
engine.on('shadow:stopped', (report: any) => io.emit('shadow:stopped', report));

io.on('connection', (socket) => {
  logger.debug(`[shadow] WS client connected: ${socket.id}`);
  socket.emit('shadow:update', engine.getStatus());
});

const port = Number(process.env.WEB_PORT ?? 3001);
httpServer.listen(port, () => {
  console.log(`  Web UI: http://localhost:${port}/shadow`);
  console.log(`  API:    http://localhost:${port}/api/shadow/status`);
  console.log(`\n  Press Ctrl+C to stop and generate report.\n`);
});

// ── Start engine ────────────────────────────────────────────────────────────

engine.start().catch(err => {
  logger.error('[shadow] Failed to start:', err);
  process.exit(1);
});

// ── Graceful shutdown ───────────────────────────────────────────────────────

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('\n  Stopping shadow trading...\n');

  try {
    const report = await engine.stop();

    const reportPath = path.resolve(__dirname, '../data/shadow-report.json');
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    console.log('='.repeat(58));
    console.log('  SHADOW TRADING REPORT');
    console.log('='.repeat(58));
    for (const p of report.profiles) {
      const pnlColor = p.totalPnlSol >= 0 ? '\x1b[32m' : '\x1b[31m';
      console.log(`\n  ${p.name.toUpperCase()} (${p.label})`);
      console.log(`    Balance:  ${p.balance.toFixed(4)} / ${p.startBalance.toFixed(1)} SOL`);
      console.log(`    Trades:   ${p.closedTrades} (WR: ${p.winRate.toFixed(0)}%)`);
      console.log(`    PnL:      ${pnlColor}${p.totalPnlSol >= 0 ? '+' : ''}${p.totalPnlSol.toFixed(4)} SOL\x1b[0m`);
    }
    console.log(`\n  Events: ${report.eventCounts.detected} detected, ${report.eventCounts.entered} entered, ${report.eventCounts.exited} exited, ${report.eventCounts.skipped} skipped`);

    if (report.protocolBreakdown) {
      console.log('\n  Protocol breakdown:');
      for (const [proto, data] of Object.entries(report.protocolBreakdown)) {
        const d = data as any;
        console.log(`    ${proto}: ${d.count} trades, ${d.wins} wins, ${d.pnlSol >= 0 ? '+' : ''}${d.pnlSol.toFixed(4)} SOL`);
      }
    }

    console.log(`\n  Report saved: ${reportPath}`);
    console.log('='.repeat(58) + '\n');
  } catch (err) {
    logger.error('[shadow] Error during shutdown:', err);
  }

  httpServer.close();
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('uncaughtException', (err) => {
  logger.error(`[shadow] UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
  shutdown().catch(() => {});
});

process.on('unhandledRejection', (reason) => {
  logger.error(`[shadow] UNHANDLED REJECTION: ${reason}`);
});
