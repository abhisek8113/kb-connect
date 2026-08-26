import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { config } from '../config.js';

// Access token: short-lived, stateless. Carries the minimum claims the RBAC
// layer needs. NEVER put phone/email in a token.
export function signAccess(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, name: user.full_name, batch: user.batch || null },
    config.jwt.accessSecret,
    { expiresIn: config.jwt.accessTtl, issuer: 'kbconnect' }
  );
}

export function verifyAccess(token) {
  return jwt.verify(token, config.jwt.accessSecret, { issuer: 'kbconnect' });
}

// Refresh token: opaque random string. We store only its SHA-256 so a DB leak
// cannot be replayed. Rotation happens on every refresh.
export function newRefreshToken() {
  const raw = crypto.randomBytes(48).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

export const hashRefresh = (raw) =>
  crypto.createHash('sha256').update(raw).digest('hex');
