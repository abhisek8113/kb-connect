import { pool, query } from './db.js';
import { hashPassword } from './auth/password.js';

// Idempotent demo seed: 1 admin, 2 tutors, 3 students, mappings, prefs.
// Passwords are provided in plain here ONLY for a first local login; change them.
async function upsertUser(u) {
  const hash = await hashPassword(u.password);
  const { rows } = await query(
    `insert into users (role, full_name, username, email, phone, subject, std, board, batch, password_hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (username) do update set full_name=excluded.full_name returning id`,
    [u.role, u.full_name, u.username, u.email || null, u.phone || null,
     u.subject || null, u.std || null, u.board || null, u.batch || null, hash]);
  return rows[0].id;
}

try {
  const admin = await upsertUser({ role: 'admin', full_name: 'Admin Office', username: 'admin', password: 'Admin@12345', phone: '9000000000' });
  const t1 = await upsertUser({ role: 'tutor', full_name: "Priya Ma'am", username: 'priya', password: 'Tutor@12345', subject: 'Maths', batch: 'B-10A' });
  const t2 = await upsertUser({ role: 'tutor', full_name: 'Karthik Sir', username: 'karthik', password: 'Tutor@12345', subject: 'Physics', batch: 'B-12S' });
  const s1 = await upsertUser({ role: 'student', full_name: 'Arjun R', username: 'arjun', password: 'Student@123', std: 'Class 10', board: 'CBSE', batch: 'B-10A' });
  const s2 = await upsertUser({ role: 'student', full_name: 'Divya S', username: 'divya', password: 'Student@123', std: 'Class 10', board: 'CBSE', batch: 'B-10A' });
  const s3 = await upsertUser({ role: 'student', full_name: 'Karan M', username: 'karan', password: 'Student@123', std: 'Class 12', board: 'State', batch: 'B-12S' });

  const map = async (tutor, student) => query(
    `insert into mappings (tutor_id, student_id, assigned_by) values ($1,$2,$3)
     on conflict (tutor_id, student_id) do nothing`, [tutor, student, admin]);
  await map(t1, s1); await map(t1, s2); await map(t2, s3);

  for (const id of [admin, t1, t2, s1, s2, s3])
    await query(`insert into notification_prefs (user_id) values ($1) on conflict do nothing`, [id]);

  console.log('✅ seeded. Logins: admin/Admin@12345  priya/Tutor@12345  arjun/Student@123');
} catch (e) {
  console.error('seed failed:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
