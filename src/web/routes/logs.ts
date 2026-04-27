// src/web/routes/logs.ts — incremental log export + git push endpoint
//
// POST /api/logs/push-to-git
//   - Reads last export timestamp from data/last-log-export.json
//   - Copies only new/changed files into logs-export/
//   - Creates a gzip-compressed tar archive split into ≤49 MB chunks
//   - git add -f / commit / push with retry (up to 4 attempts, exp. backoff)
//   - Updates data/last-log-export.json on success
//   - Protected by a mutex to prevent concurrent pushes

import { Router } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger';

const execAsync = promisify(exec);

// ── Paths ─────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '../../../');
const DATA_DIR = path.join(ROOT, 'data');
const LOGS_DIR = path.join(ROOT, 'logs');
const EXPORT_DIR = path.join(ROOT, 'logs-export');
const TIMESTAMP_FILE = path.join(DATA_DIR, 'last-log-export.json');

// ── Mutex ──────────────────────────────────────────────────────────────────

let pushInProgress = false;

// ── Helpers ────────────────────────────────────────────────────────────────

interface ExportState {
  lastExportTs: number; // epoch ms; 0 = first run (export everything)
}

function readExportState(): ExportState {
  try {
    const raw = fs.readFileSync(TIMESTAMP_FILE, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && 'lastExportTs' in parsed) {
      return { lastExportTs: Number((parsed as Record<string, unknown>).lastExportTs) || 0 };
    }
  } catch {
    // file missing or corrupt — treat as first run
  }
  return { lastExportTs: 0 };
}

function writeExportState(state: ExportState): void {
  fs.writeFileSync(TIMESTAMP_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/** Returns true when a file's mtime is after the given timestamp (or ts is 0). */
function isNewerThan(filePath: string, tsMs: number): boolean {
  if (tsMs === 0) return true;
  try {
    const stat = fs.statSync(filePath);
    return stat.mtimeMs > tsMs;
  } catch {
    return false;
  }
}

/** Expand glob-like patterns and return matched absolute paths. */
function globFiles(dir: string, pattern: RegExp): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter(f => pattern.test(f))
      .map(f => path.join(dir, f));
  } catch {
    return [];
  }
}

/** Copy lines from a log file that were logged after the given timestamp.
 *  Uses streaming to avoid V8 string size limits on large files.
 *  If tsMs === 0, copies the whole file directly (no parsing). */
async function copyLinesAfter(filePath: string, destPath: string, tsMs: number): Promise<boolean> {
  if (tsMs === 0) {
    fs.copyFileSync(filePath, destPath);
    return true;
  }
  const readline = await import('readline');
  return new Promise<boolean>((resolve) => {
    try {
      const input = fs.createReadStream(filePath, { encoding: 'utf8' });
      const output = fs.createWriteStream(destPath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input, crlfDelay: Infinity });
      let wrote = false;
      rl.on('line', (line: string) => {
        if (!line.trim()) return;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const t = Number(parsed.time);
          if (Number.isFinite(t) && t <= tsMs) return;
        } catch {
          // keep non-JSON lines
        }
        output.write(line + '\n');
        wrote = true;
      });
      rl.on('close', () => {
        output.end();
        resolve(wrote);
      });
      rl.on('error', () => {
        output.end();
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

/** Sleep for ms milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Run a shell command with a generous timeout (120 s). */
async function run(cmd: string): Promise<void> {
  const { stderr } = await execAsync(cmd, { cwd: ROOT, timeout: 120_000 });
  if (stderr && stderr.trim()) {
    logger.warn(`[logs/push-to-git] stderr: ${stderr.trim()}`);
  }
}

// ── Main export logic ──────────────────────────────────────────────────────

async function performPush(): Promise<{ message: string; files: string[] }> {
  const { lastExportTs } = readExportState();
  const nowMs = Date.now();
  const exportLabel = new Date(nowMs).toISOString().replace(/[:.]/g, '-');

  logger.info(`[logs/push-to-git] starting incremental export (lastTs=${lastExportTs})`);

  // 1. Prepare logs-export/ directory
  fs.mkdirSync(EXPORT_DIR, { recursive: true });

  // 1a. Clean up previous tar/split archives
  const prevArchives = globFiles(EXPORT_DIR, /^logs-export.*\.(tar\.gz|part\d+)$/);
  for (const f of prevArchives) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  // Also clean any .split chunk files from previous runs
  const prevSplits = globFiles(EXPORT_DIR, /^chunk-/);
  for (const f of prevSplits) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }

  const exportedFiles: string[] = [];

  // 2. Always export sniper.db
  const dbSrc = path.join(DATA_DIR, 'sniper.db');
  if (fs.existsSync(dbSrc)) {
    fs.copyFileSync(dbSrc, path.join(EXPORT_DIR, 'sniper.db'));
    exportedFiles.push('sniper.db');
  }

  // 3. shadow-report.json + shadow-snapshots.json (always)
  for (const name of ['shadow-report.json', 'shadow-snapshots.json']) {
    const src = path.join(DATA_DIR, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(EXPORT_DIR, name));
      exportedFiles.push(name);
    }
  }

  // 4. shadow.log — lines after lastExportTs (streamed to avoid V8 string limit)
  const shadowLogSrc = path.join(LOGS_DIR, 'shadow.log');
  if (fs.existsSync(shadowLogSrc)) {
    const wrote = await copyLinesAfter(shadowLogSrc, path.join(EXPORT_DIR, 'shadow.log'), lastExportTs);
    if (wrote) exportedFiles.push('shadow.log');
  }

  // 5. bot-*.log and events-*.log — only files modified since lastExportTs
  for (const pattern of [/^bot-.*\.log$/, /^events-.*\.log$/]) {
    for (const filePath of globFiles(LOGS_DIR, pattern)) {
      if (isNewerThan(filePath, lastExportTs)) {
        const name = path.basename(filePath);
        fs.copyFileSync(filePath, path.join(EXPORT_DIR, name));
        exportedFiles.push(name);
      }
    }
  }

  // 6. trades.*.jsonl — always
  for (const filePath of globFiles(LOGS_DIR, /^trades\..*\.jsonl$/)) {
    const name = path.basename(filePath);
    fs.copyFileSync(filePath, path.join(EXPORT_DIR, name));
    exportedFiles.push(name);
  }
  // Also grab trades.jsonl (non-rotated)
  const tradesJsonl = path.join(LOGS_DIR, 'trades.jsonl');
  if (fs.existsSync(tradesJsonl)) {
    fs.copyFileSync(tradesJsonl, path.join(EXPORT_DIR, 'trades.jsonl'));
    exportedFiles.push('trades.jsonl');
  }

  // 7. Create tar.gz of logs-export/ then split into ≤49 MB chunks
  const archiveName = `logs-export-${exportLabel}.tar.gz`;
  const archivePath = path.join(ROOT, archiveName);

  // tar: exclude the archive itself and the split chunks
  await run(
    `tar -czf "${archivePath}" --exclude="*.tar.gz" --exclude="chunk-*" -C "${EXPORT_DIR}" .`,
  );

  // Split into 49 MB chunks inside EXPORT_DIR; prefix: chunk-
  await run(
    `split -b 49M "${archivePath}" "${path.join(EXPORT_DIR, 'chunk-')}"`,
  );

  // Remove the full archive (only keep chunks)
  try { fs.unlinkSync(archivePath); } catch { /* ignore */ }

  // 8. git add -f + commit + push (4 attempts with exp. backoff)
  await run(`git add -f "${EXPORT_DIR}"`);

  const commitMsg = `chore: incremental log export ${exportLabel}`;
  // Check if there is anything staged
  let stagedOutput = '';
  try {
    const { stdout } = await execAsync(`git diff --cached --name-only`, { cwd: ROOT });
    stagedOutput = stdout.trim();
  } catch { /* ignore */ }

  if (!stagedOutput) {
    // Nothing new — update timestamp and return early
    writeExportState({ lastExportTs: nowMs });
    return { message: 'No new files to push (up to date)', files: exportedFiles };
  }

  await run(`git commit -m "${commitMsg}"`);

  const delays = [2000, 4000, 8000, 16000];
  let lastPushError: Error | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await run('git push');
      lastPushError = null;
      break;
    } catch (err: unknown) {
      lastPushError = err instanceof Error ? err : new Error(String(err));
      logger.warn(`[logs/push-to-git] push attempt ${attempt + 1} failed: ${lastPushError.message}`);
      if (attempt < 3) await sleep(delays[attempt]);
    }
  }

  if (lastPushError) {
    throw new Error(`git push failed after 4 attempts: ${lastPushError.message}`);
  }

  // 9. Persist updated timestamp
  writeExportState({ lastExportTs: nowMs });

  logger.info(`[logs/push-to-git] done — exported ${exportedFiles.length} file(s)`);
  return { message: `Exported ${exportedFiles.length} file(s), pushed to git`, files: exportedFiles };
}

// ── Router ─────────────────────────────────────────────────────────────────

export function logsRouter() {
  const router = Router();

  router.post('/push-to-git', async (_req, res) => {
    if (pushInProgress) {
      return res.status(409).json({ ok: false, error: 'Push already in progress' });
    }
    pushInProgress = true;
    try {
      const result = await performPush();
      res.json({ ok: true, ...result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[logs/push-to-git] error: ${msg}`);
      res.status(500).json({ ok: false, error: msg });
    } finally {
      pushInProgress = false;
    }
  });

  // GET /api/logs/push-status — lightweight status check
  router.get('/push-status', (_req, res) => {
    const state = readExportState();
    res.json({
      inProgress: pushInProgress,
      lastExportTs: state.lastExportTs,
      lastExportIso: state.lastExportTs
        ? new Date(state.lastExportTs).toISOString()
        : null,
    });
  });

  return router;
}
