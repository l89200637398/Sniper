import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { authenticateJWT, loginHandler } from './auth';
import { registerRoutes } from './routes';
import { registerSocketHandlers } from './ws/events';
import type { Sniper } from '../core/sniper';
import { logger } from '../utils/logger';

export function createWebServer(sniper: Sniper) {
  const app = express();
  // Trust loopback proxies only. Lets express-rate-limit see the real client IP
  // via X-Forwarded-For when a same-host reverse proxy (nginx/caddy on :80)
  // forwards to us on :3001. Safe: only 127.0.0.1 is trusted, not arbitrary hops.
  app.set('trust proxy', 'loopback');

  const httpServer = createServer(app);
  // Socket.IO CORS: if WEB_ORIGIN is set, lock to that origin; otherwise
  // reflect the request origin (true). Safe for our deploy because the JWT
  // cookie is sameSite=strict + httpOnly — cross-origin WS handshakes can't
  // carry the auth cookie, so they fail auth regardless of CORS.
  const io = new Server(httpServer, {
    cors: { origin: process.env.WEB_ORIGIN ?? true, credentials: true },
  });

  app.use(express.json());
  app.use(cookieParser());
  app.use(rateLimit({ windowMs: 60_000, max: 300 }));

  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) {
      const start = Date.now();
      res.on('finish', () => {
        logger.info(`[web] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
      });
    }
    next();
  });

  app.post('/api/login', loginHandler);
  app.use('/api', authenticateJWT);
  registerRoutes(app, sniper);

  io.use((socket, next) => {
    // `??` fallback doesn't trigger on empty string (which the client sends if
    // it can't read the httpOnly cookie from JS). Use `||` so we properly fall
    // through to the cookie header sent with the WS handshake.
    const token = socket.handshake.auth.token
      || socket.request.headers.cookie?.match(/token=([^;]+)/)?.[1];
    if (!token) return next(new Error('Unauthorized'));
    const verified = require('./auth').verifyToken(token);
    if (!verified) return next(new Error('Invalid token'));
    next();
  });
  registerSocketHandlers(io, sniper);

  if (process.env.NODE_ENV === 'production') {
    const distPath = path.resolve(__dirname, '../../web-ui/dist');
    app.use(express.static(distPath));
    // Fallback для SPA: все GET-запросы, не начинающиеся с /api и /socket.io, отдаём index.html
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/socket.io')) {
        res.sendFile(path.join(distPath, 'index.html'));
      } else {
        next();
      }
    });
  }

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error(`[web] Error: ${err?.message ?? String(err)}`);
    res.status(500).json({ error: 'Internal server error' });
  });

  const port = Number(process.env.WEB_PORT ?? 3001);
  httpServer.listen(port, () => logger.info(`Web UI listening on http://localhost:${port}`));
  return { app, io, httpServer };
}