import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { verifyPassword } from '../auth/password.js';
import { signAccess, newRefreshToken, hashRefresh } from '../auth/jwt.js';
import { authenticate } from '../auth/middleware.js';
import { config } from '../config.js';
import { logActivity } from '../services/audit.js';
import { asyncH, parse, publicUser } from '../util/http.js';

export const authRouter = Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

authRouter.post('/login', asyncH(async (req, res) => {
  const body = parse(loginSchema, req.body, res); if (!body) return;
  const { rows } = await query('select * from users where username=$1', [body.username]);
  const user = rows[0];
  // Constant-ish response regardless of which factor failed (no user enumeration).
  if (!user || !user.is_active || !(await verifyPassword(body.password, user.password_hash))) {
    await logActivity({ action: 'login_failed', meta: { username: body.username },
      ip: req.ip, userAgent: req.headers['user-agent'] });
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const access = signAccess(user);
  const { raw, hash } = newRefreshToken();
  await query(
    `insert into refresh_tokens (user_id, token_hash, expires_at, user_agent)
     values ($1,$2, now() + ($3 || ' seconds')::interval, $4)`,
    [user.id, hash, config.jwt.refreshTtl, req.headers['user-agent'] || null]);
  await logActivity({ userId: user.id, action: 'login', ip: req.ip, userAgent: req.headers['user-agent'] });
  res.json({ access, refresh: raw, user: publicUser(user) });
}));

authRouter.post('/refresh', asyncH(async (req, res) => {
  const raw = req.body?.refresh;
  if (!raw) return res.status(400).json({ error: 'missing refresh' });
  const hash = hashRefresh(raw);
  const { rows } = await query(
    'select rt.*, u.role, u.full_name, u.batch, u.is_active from refresh_tokens rt join users u on u.id=rt.user_id where token_hash=$1',
    [hash]);
  const t = rows[0];
  if (!t || t.revoked_at || new Date(t.expires_at) < new Date() || !t.is_active) {
    return res.status(401).json({ error: 'invalid refresh' });
  }
  // Rotate: revoke the old, issue a new pair.
  const next = newRefreshToken();
  await query('update refresh_tokens set revoked_at=now() where id=$1', [t.id]);
  await query(
    `insert into refresh_tokens (user_id, token_hash, expires_at, user_agent)
     values ($1,$2, now() + ($3 || ' seconds')::interval, $4)`,
    [t.user_id, next.hash, config.jwt.refreshTtl, req.headers['user-agent'] || null]);
  const access = signAccess({ id: t.user_id, role: t.role, full_name: t.full_name, batch: t.batch });
  res.json({ access, refresh: next.raw });
}));

authRouter.post('/logout', authenticate, asyncH(async (req, res) => {
  if (req.body?.refresh) {
    await query('update refresh_tokens set revoked_at=now() where token_hash=$1', [hashRefresh(req.body.refresh)]);
  }
  await logActivity({ userId: req.user.id, action: 'logout', ip: req.ip });
  res.json({ ok: true });
}));

authRouter.get('/me', authenticate, asyncH(async (req, res) => {
  res.json({ user: publicUser(req.user) });
}));
