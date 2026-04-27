import { Router } from 'express';
import { runtimeConfig } from '../../config';
import { db, recordConfigChange } from '../../db/sqlite';

const SENSITIVE_PATHS = [
  'wallet.privateKey',
  'rpc.url',
  'geyser.endpoint',
  'geyser.token',
  'telegram.botToken',
];

const CONFIG_WHITELIST_PREFIXES = [
  'strategy.',
  'trend.',
  'walletTracker.',
  'jito.tipAmountSol',
  'jito.maxTipAmountSol',
  'jito.minTipAmountSol',
  'compute.',
];

export function configRouter() {
  const router = Router();

  router.get('/', (_, res) => {
    const all = runtimeConfig.getAll();
    const safe = JSON.parse(JSON.stringify(all));
    for (const p of SENSITIVE_PATHS) {
      const parts = p.split('.');
      let obj = safe;
      for (let i = 0; i < parts.length - 1; i++) {
        if (obj && typeof obj === 'object') obj = obj[parts[i]];
      }
      if (obj && typeof obj === 'object') {
        const key = parts[parts.length - 1];
        if (key in obj) obj[key] = '***REDACTED***';
      }
    }
    res.json(safe);
  });

  router.put('/', (req, res) => {
    const changes: { path: string; value: any }[] = req.body.changes || [];
    const errors: string[] = [];
    const applied: string[] = [];

    for (const { path, value } of changes) {
      if (!CONFIG_WHITELIST_PREFIXES.some(prefix => path.startsWith(prefix))) {
        errors.push(`${path}: not allowed (outside whitelist)`);
        continue;
      }
      try {
        const old = runtimeConfig.get(path);
        runtimeConfig.set(path, value);
        recordConfigChange(path, old, value);
        applied.push(path);
      } catch (e: any) { errors.push(`${path}: ${e.message}`); }
    }
    res.json({ applied, errors });
  });

  router.post('/rollback', (_, res) => {
    const last = db.prepare(`SELECT * FROM config_history ORDER BY changed_at DESC LIMIT 50`).all() as any[];
    for (const row of last) runtimeConfig.set(row.path, JSON.parse(row.old_value));
    res.json({ ok: true, rolledBack: last.length });
  });

  return router;
}
