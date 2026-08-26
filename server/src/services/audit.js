import { query } from '../db.js';

export async function logActivity({ userId, action, entity, entityId, ip, userAgent, meta }) {
  try {
    await query(
      `insert into activity_logs (user_id, action, entity, entity_id, ip, user_agent, meta)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [userId || null, action, entity || null, entityId || null,
       ip || null, userAgent || null, meta ? JSON.stringify(meta) : '{}']);
  } catch (e) {
    // Never let audit failure break the request; surface to stderr for ops.
    console.error('audit log failed:', e.message);
  }
}
