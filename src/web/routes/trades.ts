import { Router } from 'express';
import { db } from '../../db/sqlite';

export function tradesRouter() {
  const router = Router();
  router.get('/', (req, res) => {
    const { protocol, limit = '100', offset = '0' } = req.query;
    let sql = `SELECT * FROM trades WHERE 1=1`;
    const params: any[] = [];
    if (protocol) { sql += ` AND protocol = ?`; params.push(protocol); }
    sql += ` ORDER BY closed_at DESC LIMIT ? OFFSET ?`;
    params.push(Number(limit), Number(offset));

    const trades = db.prepare(sql).all(...params);
    const total = (db.prepare(`SELECT COUNT(*) as n FROM trades`).get() as any).n;
    res.json({ trades, total });
  });
  router.get('/stats', (_, res) => {
    const stats = db.prepare(`
      SELECT COUNT(*) as total, 
             SUM(CASE WHEN exit_amount_sol > entry_amount_sol THEN 1 ELSE 0 END) as wins,
             AVG(pnl_percent) as avgPnl, SUM(exit_amount_sol - entry_amount_sol) as totalPnlSol
      FROM trades
    `).get();
    res.json(stats);
  });
  return router;
}
