import { query } from '../db.js';

// Central notification creator. Persists the notification AND pushes it in
// real time to the recipient's sockets if they are online. `data` carries only
// ids/labels — never phone numbers or emails. Respects DND / mute prefs.
export function makeNotifier(io, online /* Map<userId, Set<socketId>> */) {
  return async function notify({ userId, type, title, body, data = {} }) {
    // Preference gate
    const prefs = (await query('select dnd, mute_messages from notification_prefs where user_id=$1', [userId])).rows[0]
      || { dnd: false, mute_messages: false };
    if (type === 'incoming_call' && prefs.dnd) {
      // DND: do not ring, but the missed-call path will still record it.
      return { suppressed: true };
    }
    if (type === 'message' && prefs.mute_messages) {
      // Persist silently (badge count) but do not emit a toast.
      const row = await insert(userId, type, title, body, data);
      return { suppressed: true, notification: row };
    }
    const row = await insert(userId, type, title, body, data);
    const sockets = online.get(userId);
    if (sockets) for (const sid of sockets) io.to(sid).emit('notification', row);
    return { notification: row };
  };

  async function insert(userId, type, title, body, data) {
    const { rows } = await query(
      `insert into notifications (user_id, type, title, body, data)
       values ($1,$2,$3,$4,$5) returning *`,
      [userId, type, title, body || null, JSON.stringify(data)]);
    return rows[0];
  }
}
