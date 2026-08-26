// ============================================================================
// Server-side RBAC — the ONLY place permissions are decided.
// The client is never trusted. Every route and every socket event calls into
// these helpers. All of them hit the `mappings` table so that a tutor/student
// relationship is authoritative and revocable by admin in real time.
// ============================================================================
import { query } from './db.js';

export const ROLES = ['admin', 'tutor', 'student'];

// Is there an admin-created tutor⇄student mapping between these two users?
export async function areMapped(tutorId, studentId) {
  const { rows } = await query(
    'select 1 from mappings where tutor_id=$1 and student_id=$2 limit 1',
    [tutorId, studentId]
  );
  return rows.length > 0;
}

// The set of user ids a given user is allowed to communicate with (1:1).
// admin  -> everyone
// tutor  -> their assigned students (+ admins)
// student-> their assigned tutors  (+ admins)
export async function peersOf(user) {
  if (user.role === 'admin') {
    const { rows } = await query(
      "select id from users where id <> $1 and is_active", [user.id]);
    return rows.map(r => r.id);
  }
  const admins = (await query("select id from users where role='admin' and is_active")).rows.map(r => r.id);
  if (user.role === 'tutor') {
    const { rows } = await query('select student_id id from mappings where tutor_id=$1', [user.id]);
    return [...rows.map(r => r.id), ...admins];
  }
  // student
  const { rows } = await query('select tutor_id id from mappings where student_id=$1', [user.id]);
  return [...rows.map(r => r.id), ...admins];
}

// May `user` communicate 1:1 with `otherId`? (chat DM or place/receive a call)
export async function canCommunicate(user, otherId) {
  if (user.id === otherId) return false;
  if (user.role === 'admin') return true;

  const other = (await query('select id, role, is_active from users where id=$1', [otherId])).rows[0];
  if (!other || !other.is_active) return false;
  if (other.role === 'admin') return true;                 // anyone may reach admin
  if (user.role === 'tutor'   && other.role === 'student') return areMapped(user.id, otherId);
  if (user.role === 'student' && other.role === 'tutor')   return areMapped(otherId, user.id);
  return false;                                            // student↔student, tutor↔tutor: never
}

// May `user` see a conversation? Admin: always (monitoring). Others: membership.
export async function canAccessConversation(user, conv) {
  if (user.role === 'admin') return true;
  if (conv.kind === 'dm') return conv.member_a === user.id || conv.member_b === user.id;
  if (conv.kind === 'batch') {
    if (user.role === 'tutor')   // tutor teaches that batch if any mapped student is in it
      return (await query(
        `select 1 from mappings m join users s on s.id=m.student_id
         where m.tutor_id=$1 and s.batch=$2 limit 1`, [user.id, conv.batch])).rows.length > 0;
    if (user.role === 'student') return user.batch === conv.batch;
  }
  return false;
}

// Express guard factory: require one of the given roles.
export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'forbidden' });
  next();
};
