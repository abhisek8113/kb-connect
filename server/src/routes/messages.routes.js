import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { authenticate } from '../auth/middleware.js';
import { canCommunicate, canAccessConversation, peersOf } from '../rbac.js';
import { getOrCreateDm } from '../services/conversations.js';
import { asyncH, parse, publicUser } from '../util/http.js';

export const messagesRouter = Router();
messagesRouter.use(authenticate);

// My contacts (privacy-filtered). Students see only their tutor(s)+admin, etc.
messagesRouter.get('/contacts', asyncH(async (req, res) => {
  const ids = await peersOf(req.user);
  if (!ids.length) return res.json([]);
  const { rows } = await query(
    `select * from users where id = any($1) and is_active order by role, full_name`, [ids]);
  res.json(rows.map(publicUser));   // NO phone/email
}));

// My conversation list.
messagesRouter.get('/conversations', asyncH(async (req, res) => {
  const { rows } = await query(
    `select c.*, (select json_build_object('body',body,'kind',kind,'created_at',created_at)
                  from messages m where m.conversation_id=c.id order by created_at desc limit 1) last
     from conversations c
     where ($1='admin')
        or (c.kind='dm' and ($2 = c.member_a or $2 = c.member_b))
        or (c.kind='batch' and c.batch = $3)
     order by (select max(created_at) from messages m where m.conversation_id=c.id) desc nulls last`,
    [req.user.role, req.user.id, req.user.batch]);
  res.json(rows);
}));

// Open/create a DM with a specific peer (permission-checked).
messagesRouter.post('/dm/:peerId', asyncH(async (req, res) => {
  if (!(await canCommunicate(req.user, req.params.peerId)))
    return res.status(403).json({ error: 'not permitted to message this user' });
  const conv = await getOrCreateDm(req.user.id, req.params.peerId);
  res.json(conv);
}));

// Fetch messages in a conversation I'm allowed to see.
messagesRouter.get('/conversations/:id/messages', asyncH(async (req, res) => {
  const conv = (await query('select * from conversations where id=$1', [req.params.id])).rows[0];
  if (!conv) return res.status(404).json({ error: 'not found' });
  if (!(await canAccessConversation(req.user, conv))) return res.status(403).json({ error: 'forbidden' });
  const { rows } = await query(
    `select m.id, m.sender_id, u.full_name sender_name, u.role sender_role,
            m.kind, m.body, m.file_name, m.file_size, m.created_at, m.read_at
     from messages m join users u on u.id=m.sender_id
     where m.conversation_id=$1 order by m.created_at asc limit 500`, [req.params.id]);
  res.json(rows);
}));

// NOTE: sending a message goes through Socket.IO (see sockets/) for real-time
// delivery + notifications. This REST endpoint is a fallback for clients
// without a live socket; it performs the SAME server-side permission check.
const sendSchema = z.object({ body: z.string().min(1).max(4000) });
messagesRouter.post('/conversations/:id/messages', asyncH(async (req, res) => {
  const b = parse(sendSchema, req.body, res); if (!b) return;
  const conv = (await query('select * from conversations where id=$1', [req.params.id])).rows[0];
  if (!conv) return res.status(404).json({ error: 'not found' });
  if (req.user.role !== 'admin' && !(await canAccessConversation(req.user, conv)))
    return res.status(403).json({ error: 'forbidden' });
  // Admin is monitor-only on DMs they are not a member of (cannot inject messages).
  if (req.user.role === 'admin' && conv.kind === 'dm'
      && conv.member_a !== req.user.id && conv.member_b !== req.user.id)
    return res.status(403).json({ error: 'admin is monitor-only in this conversation' });
  const { rows } = await query(
    `insert into messages (conversation_id, sender_id, body) values ($1,$2,$3) returning *`,
    [req.params.id, req.user.id, b.body]);
  req.app.get('io').to('conv:' + req.params.id).emit('message', rows[0]);
  res.status(201).json(rows[0]);
}));
