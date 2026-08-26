import { verifyAccess } from './jwt.js';
import { query } from '../db.js';

// Express: authenticate via Bearer access token. Loads a fresh, minimal user
// record so a deactivated account is rejected immediately even with a valid JWT.
export async function authenticate(req, res, next) {
  try {
    const hdr = req.headers.authorization || '';
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'missing token' });
    const claims = verifyAccess(token);
    const { rows } = await query(
      'select id, role, full_name, batch, is_active from users where id=$1', [claims.sub]);
    const u = rows[0];
    if (!u || !u.is_active) return res.status(401).json({ error: 'inactive or unknown user' });
    req.user = u;
    next();
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
}

// Socket.IO: same check during handshake.
export async function authenticateSocket(socket, next) {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('missing token'));
    const claims = verifyAccess(token);
    const { rows } = await query(
      'select id, role, full_name, batch, is_active from users where id=$1', [claims.sub]);
    const u = rows[0];
    if (!u || !u.is_active) return next(new Error('inactive or unknown user'));
    socket.user = u;
    next();
  } catch {
    next(new Error('invalid token'));
  }
}
