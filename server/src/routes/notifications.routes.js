import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { authenticate } from '../auth/middleware.js';
import { asyncH, parse } from '../util/http.js';

export const notificationsRouter = Router();
notificationsRouter.use(authenticate);

notificationsRouter.get('/', asyncH(async (req, res) => {
  const { rows } = await query(
    `select * from notifications where user_id=$1 order by created_at desc limit 100`, [req.user.id]);
  res.json(rows);
}));

notificationsRouter.get('/unread-count', asyncH(async (req, res) => {
  const { rows } = await query(
    `select count(*)::int c from notifications where user_id=$1 and is_read=false`, [req.user.id]);
  res.json({ count: rows[0].c });
}));

notificationsRouter.post('/:id/read', asyncH(async (req, res) => {
  await query('update notifications set is_read=true where id=$1 and user_id=$2', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

notificationsRouter.post('/read-all', asyncH(async (req, res) => {
  await query('update notifications set is_read=true where user_id=$1 and is_read=false', [req.user.id]);
  res.json({ ok: true });
}));

// Notification preferences: DND (silence calls) + mute messages.
const prefSchema = z.object({ dnd: z.boolean().optional(), mute_messages: z.boolean().optional() });
notificationsRouter.get('/prefs', asyncH(async (req, res) => {
  const { rows } = await query('select dnd, mute_messages from notification_prefs where user_id=$1', [req.user.id]);
  res.json(rows[0] || { dnd: false, mute_messages: false });
}));
notificationsRouter.put('/prefs', asyncH(async (req, res) => {
  const b = parse(prefSchema, req.body, res); if (!b) return;
  const { rows } = await query(
    `insert into notification_prefs (user_id, dnd, mute_messages) values ($1, coalesce($2,false), coalesce($3,false))
     on conflict (user_id) do update set
        dnd = coalesce($2, notification_prefs.dnd),
        mute_messages = coalesce($3, notification_prefs.mute_messages),
        updated_at = now()
     returning dnd, mute_messages`,
    [req.user.id, b.dnd ?? null, b.mute_messages ?? null]);
  res.json(rows[0]);
}));
