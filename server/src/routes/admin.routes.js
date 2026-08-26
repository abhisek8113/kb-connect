import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { hashPassword } from '../auth/password.js';
import { authenticate } from '../auth/middleware.js';
import { requireRole } from '../rbac.js';
import { logActivity } from '../services/audit.js';
import { asyncH, parse, publicUser } from '../util/http.js';

export const adminRouter = Router();
adminRouter.use(authenticate, requireRole('admin'));   // whole surface is admin-only

// ── User CRUD (tutors & students) ───────────────────────────────────────────
const userSchema = z.object({
  role: z.enum(['tutor', 'student']),
  full_name: z.string().min(1),
  username: z.string().min(3),
  password: z.string().min(8),
  email: z.string().email().optional().nullable(),
  phone: z.string().optional().nullable(),        // stored for records, never exposed to peers
  subject: z.string().optional().nullable(),
  std: z.string().optional().nullable(),
  board: z.string().optional().nullable(),
  batch: z.string().optional().nullable(),
});

adminRouter.get('/users', asyncH(async (req, res) => {
  const role = req.query.role;
  const rows = role
    ? (await query('select * from users where role=$1 order by full_name', [role])).rows
    : (await query("select * from users where role<>'admin' order by role, full_name")).rows;
  // Admin view MAY include phone (they own the records) — but we still omit hashes.
  res.json(rows.map(u => ({ ...publicUser(u), username: u.username, email: u.email, phone: u.phone, is_active: u.is_active })));
}));

adminRouter.post('/users', asyncH(async (req, res) => {
  const b = parse(userSchema, req.body, res); if (!b) return;
  const hash = await hashPassword(b.password);
  const { rows } = await query(
    `insert into users (role, full_name, username, email, phone, subject, std, board, batch, password_hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [b.role, b.full_name, b.username, b.email || null, b.phone || null,
     b.subject || null, b.std || null, b.board || null, b.batch || null, hash]);
  await logActivity({ userId: req.user.id, action: 'create_user', entity: 'users', entityId: rows[0].id, ip: req.ip });
  res.status(201).json(publicUser(rows[0]));
}));

adminRouter.patch('/users/:id', asyncH(async (req, res) => {
  const b = parse(userSchema.partial(), req.body, res); if (!b) return;
  const fields = [], vals = [];
  for (const [k, v] of Object.entries(b)) {
    if (k === 'password') { fields.push(`password_hash=$${vals.length + 1}`); vals.push(await hashPassword(v)); }
    else { fields.push(`${k}=$${vals.length + 1}`); vals.push(v); }
  }
  if (!fields.length) return res.json({ ok: true });
  vals.push(req.params.id);
  const { rows } = await query(
    `update users set ${fields.join(', ')}, updated_at=now() where id=$${vals.length} returning *`, vals);
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  await logActivity({ userId: req.user.id, action: 'update_user', entity: 'users', entityId: req.params.id, ip: req.ip });
  res.json(publicUser(rows[0]));
}));

// Deactivate (soft delete) — keeps history, immediately cuts access.
adminRouter.delete('/users/:id', asyncH(async (req, res) => {
  await query('update users set is_active=false, updated_at=now() where id=$1', [req.params.id]);
  await query('update refresh_tokens set revoked_at=now() where user_id=$1 and revoked_at is null', [req.params.id]);
  await logActivity({ userId: req.user.id, action: 'deactivate_user', entity: 'users', entityId: req.params.id, ip: req.ip });
  res.json({ ok: true });
}));

// ── Tutor ⇄ student mappings ────────────────────────────────────────────────
const mapSchema = z.object({ tutor_id: z.string().uuid(), student_id: z.string().uuid() });

adminRouter.get('/mappings', asyncH(async (req, res) => {
  const { rows } = await query(
    `select m.id, m.tutor_id, m.student_id, t.full_name tutor_name, s.full_name student_name,
            s.batch, m.created_at
     from mappings m join users t on t.id=m.tutor_id join users s on s.id=m.student_id
     order by m.created_at desc`);
  res.json(rows);
}));

adminRouter.post('/mappings', asyncH(async (req, res) => {
  const b = parse(mapSchema, req.body, res); if (!b) return;
  const t = (await query("select role from users where id=$1", [b.tutor_id])).rows[0];
  const s = (await query("select role from users where id=$1", [b.student_id])).rows[0];
  if (t?.role !== 'tutor' || s?.role !== 'student')
    return res.status(400).json({ error: 'tutor_id must be a tutor and student_id a student' });
  const { rows } = await query(
    `insert into mappings (tutor_id, student_id, assigned_by) values ($1,$2,$3)
     on conflict (tutor_id, student_id) do nothing returning *`,
    [b.tutor_id, b.student_id, req.user.id]);
  await logActivity({ userId: req.user.id, action: 'assign_mapping', entity: 'mappings',
    entityId: rows[0]?.id, meta: b, ip: req.ip });
  res.status(201).json(rows[0] || { ok: true, note: 'already mapped' });
}));

adminRouter.delete('/mappings/:id', asyncH(async (req, res) => {
  await query('delete from mappings where id=$1', [req.params.id]);
  await logActivity({ userId: req.user.id, action: 'remove_mapping', entity: 'mappings', entityId: req.params.id, ip: req.ip });
  res.json({ ok: true });
}));

// ── Monitoring: all conversations, all messages, meeting history ────────────
adminRouter.get('/conversations', asyncH(async (req, res) => {
  const { rows } = await query(
    `select c.*, a.full_name member_a_name, b.full_name member_b_name,
            (select count(*) from messages m where m.conversation_id=c.id) msg_count,
            (select max(created_at) from messages m where m.conversation_id=c.id) last_at
     from conversations c
     left join users a on a.id=c.member_a left join users b on b.id=c.member_b
     order by last_at desc nulls last`);
  res.json(rows);
}));

adminRouter.get('/conversations/:id/messages', asyncH(async (req, res) => {
  const { rows } = await query(
    `select m.*, u.full_name sender_name, u.role sender_role
     from messages m join users u on u.id=m.sender_id
     where m.conversation_id=$1 order by m.created_at asc`, [req.params.id]);
  res.json(rows);
}));

// Export a conversation's chat log as JSON or CSV.
adminRouter.get('/conversations/:id/export', asyncH(async (req, res) => {
  const { rows } = await query(
    `select m.created_at, u.full_name sender, u.role, m.kind, m.body, m.file_name
     from messages m join users u on u.id=m.sender_id
     where m.conversation_id=$1 order by m.created_at asc`, [req.params.id]);
  await logActivity({ userId: req.user.id, action: 'export_chat', entity: 'conversations', entityId: req.params.id, ip: req.ip });
  if (req.query.format === 'csv') {
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['timestamp,sender,role,kind,body,file']
      .concat(rows.map(r => [r.created_at.toISOString(), r.sender, r.role, r.kind, r.body, r.file_name].map(esc).join(',')))
      .join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="chat-${req.params.id}.csv"`);
    return res.send(csv);
  }
  res.json(rows);
}));

// Meeting history with participants, timestamps, duration.
adminRouter.get('/meetings', asyncH(async (req, res) => {
  const { rows } = await query(
    `select mt.id, mt.kind, mt.started_at, mt.ended_at, mt.duration_secs, mt.batch,
            starter.full_name started_by,
            coalesce(json_agg(json_build_object('name', pu.full_name, 'role', pu.role,
              'joined_at', mp.joined_at, 'left_at', mp.left_at))
              filter (where pu.id is not null), '[]') participants
     from meetings mt
     join users starter on starter.id=mt.started_by
     left join meeting_participants mp on mp.meeting_id=mt.id
     left join users pu on pu.id=mp.user_id
     group by mt.id, starter.full_name order by mt.started_at desc limit 500`);
  res.json(rows);
}));

// Call history (answered/declined/missed/cancelled) with duration.
adminRouter.get('/calls', asyncH(async (req, res) => {
  const { rows } = await query(
    `select cl.*, cr.full_name caller_name, ce.full_name callee_name
     from call_logs cl join users cr on cr.id=cl.caller_id join users ce on ce.id=cl.callee_id
     order by cl.rang_at desc limit 500`);
  res.json(rows);
}));

// Activity & login logs.
adminRouter.get('/activity', asyncH(async (req, res) => {
  const action = req.query.action;
  const { rows } = await query(
    `select al.*, u.full_name, u.role from activity_logs al left join users u on u.id=al.user_id
     ${action ? 'where al.action=$1' : ''} order by al.created_at desc limit 500`,
    action ? [action] : []);
  res.json(rows);
}));

// Admin broadcast / targeted announcement (creates notifications).
const announceSchema = z.object({
  title: z.string().min(1), body: z.string().optional(),
  audience: z.enum(['all', 'tutors', 'students', 'batch', 'user']),
  batch: z.string().optional(), user_id: z.string().uuid().optional(),
});
adminRouter.post('/announce', asyncH(async (req, res) => {
  const b = parse(announceSchema, req.body, res); if (!b) return;
  let recipients = [];
  if (b.audience === 'all') recipients = (await query("select id from users where role<>'admin' and is_active")).rows;
  else if (b.audience === 'tutors') recipients = (await query("select id from users where role='tutor' and is_active")).rows;
  else if (b.audience === 'students') recipients = (await query("select id from users where role='student' and is_active")).rows;
  else if (b.audience === 'batch') recipients = (await query("select id from users where batch=$1 and is_active", [b.batch])).rows;
  else if (b.audience === 'user') recipients = (await query('select id from users where id=$1', [b.user_id])).rows;
  const notify = req.app.get('notify');
  for (const r of recipients) await notify({ userId: r.id, type: 'announcement', title: b.title, body: b.body || '' });
  await logActivity({ userId: req.user.id, action: 'announce', meta: { audience: b.audience, count: recipients.length }, ip: req.ip });
  res.json({ sent: recipients.length });
}));
