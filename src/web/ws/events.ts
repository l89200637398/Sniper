import type { Server } from 'socket.io';
import type { Sniper } from '../../core/sniper';
import { db } from '../../db/sqlite';
import { logger } from '../../utils/logger';

let statsInterval: ReturnType<typeof setInterval> | null = null;

export function stopSocketHandlers(): void {
  if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
}

export function registerSocketHandlers(io: Server, sniper: Sniper) {
  sniper.on('position:open',   (d) => io.emit('position:open', d));
  sniper.on('position:update', (d) => io.emit('position:update', d));
  sniper.on('position:close',  (d) => {
    io.emit('position:close', d);
    io.emit('trade:close', d);
  });
  sniper.on('system:status',   (d) => io.emit('system:status', d));

  sniper.onSocialSignal((s) => io.emit('social:signal', s));
  sniper.onSocialAlpha((s) => io.emit('social:alpha', s));

  sniper.on('token:scored', (data: any) => {
    io.emit('token:scored', data);
  });

  sniper.onTrendEvent('trend:confirmed', (mint, metrics) =>
    io.emit('trend:confirmed', { mint, metrics }));
  sniper.onTrendEvent('trend:strengthening', (mint, metrics) =>
    io.emit('trend:strengthening', { mint, metrics }));
  sniper.onTrendEvent('trend:weakening', (mint, metrics) =>
    io.emit('trend:weakening', { mint, metrics }));

  statsInterval = setInterval(async () => {
    try {
      const sol = await sniper.getWalletBalance();
      const stats = db.prepare(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN exit_amount_sol > entry_amount_sol THEN 1 ELSE 0 END) as wins,
               SUM(exit_amount_sol - entry_amount_sol) as totalPnlSol
        FROM trades
      `).get() as any;
      io.emit('balance:update', { sol });
      io.emit('stats:update', {
        total: stats?.total ?? 0,
        wins: stats?.wins ?? 0,
        totalPnlSol: stats?.totalPnlSol ?? 0,
      });
      io.emit('trend:update', {
        trackedCount: sniper.getTrendTrackedCount(),
        tracked: sniper.getTrendTrackedMints(),
      });
      io.emit('eventCounts:update', sniper.getEventCounts());
      io.emit('exposure:update', {
        exposure: sniper.getExposure(),
        startBalance: sniper.getStartBalance(),
      });
    } catch {}
  }, 5000);

  io.on('connection', (socket) => {
    const ip = socket.handshake.address;
    logger.info(`[ws] connect id=${socket.id} ip=${ip}`);

    socket.emit('snapshot', {
      positions: sniper.getOpenPositions(),
      isRunning: sniper.isRunning(),
      defensiveMode: sniper.isDefensiveMode(),
      trendTracked: sniper.getTrendTrackedMints(),
      eventCounts: sniper.getEventCounts(),
      exposure: sniper.getExposure(),
      startBalance: sniper.getStartBalance(),
    });

    socket.on('sell:now', ({ mint }) => {
      logger.info(`[ws] sell:now mint=${mint} id=${socket.id}`);
      sniper.requestSell(mint, 'manual_ui');
    });
    socket.on('bot:start', () => {
      logger.info(`[ws] bot:start id=${socket.id}`);
      sniper.start().catch(() => {});
    });
    socket.on('bot:stop', () => {
      logger.info(`[ws] bot:stop id=${socket.id}`);
      sniper.stop().catch(() => {});
    });
    socket.on('disconnect', (reason) => {
      logger.info(`[ws] disconnect id=${socket.id} reason=${reason}`);
    });
    socket.on('error', (err) => {
      logger.error(`[ws] error id=${socket.id}: ${String(err)}`);
    });
  });
}
