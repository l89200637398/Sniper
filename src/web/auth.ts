import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import type { Request, Response, NextFunction } from 'express';

const SECRET = process.env.JWT_SECRET!;
const PASSWORD_HASH = process.env.WEB_PASSWORD_HASH!;

export async function loginHandler(req: Request, res: Response) {
  const { password } = req.body;
  if (!password || !(await bcrypt.compare(password, PASSWORD_HASH))) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = jwt.sign({ role: 'admin' }, SECRET, { expiresIn: '7d' });
  // Secure cookie only over HTTPS — opt-in via WEB_COOKIE_SECURE=true.
  // Default off so bare-IP HTTP deployments work; the browser silently drops
  // Secure cookies on http:// which used to break login on the VPS.
  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.WEB_COOKIE_SECURE === 'true',
    sameSite: 'strict',
    maxAge: 7 * 86400_000,
  });
  res.json({ ok: true });
}

export function authenticateJWT(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.token ?? req.headers.authorization?.split(' ')[1];
  try {
    jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

export function verifyToken(token: string): boolean {
  try { jwt.verify(token, SECRET); return true; } catch { return false; }
}
