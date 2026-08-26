import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { config } from '../config.js';
import { authenticate } from '../auth/middleware.js';
import { canCommunicate, canAccessConversation } from '../rbac.js';
import { roomForPair, roomForBatch, jitsiToken } from '../services/jitsi.js';
import { logActivity } from '../services/audit.js';
import { asyncH, parse } from '../util/http.js';

export const meetingsRouter = Router();
meetingsRouter.use(authenticate);

// Start / join a 1:1 meeting with a permitted peer. Tutors & admin are
// moderators. Returns a room + a room-scoped Jitsi JWT (no phone numbers).
const startSchema = z.object({ kind: z.enum(['audio', 'video']).default('video') });

meetingsRouter.post('/dm/:peerId', asyncH(async (req, res) => {
  const b = parse(startSchema, req.body, res); if (!b) return;
  if (!(await canCommunicate(req.user, req.params.peerId)))
    return res.status(403).json({ error: 'not permitted to call this user' });
  const room = roomForPair(req.user.id, req.params.peerId);
  const moderator = req.user.role !== 'student';
  const { rows } = await query(
    `insert into meetings (room, kind, started_by) values ($1,$2,$3)
     on conflict (room) do update set kind=excluded.kind returning *`,
    [room, b.kind, req.user.id]);
  await logActivity({ userId: req.user.id, action: 'start_meeting', entity: 'meetings', entityId: rows[0].id, ip: req.ip });
  res.json({
    room, domain: config.jitsi.domain, kind: b.kind,
    token: jitsiToken({ user: req.user, room, moderator }),
  });
}));

// Batch (class) meeting — tutor of that batch or admin only.
meetingsRouter.post('/batch/:batch', asyncH(async (req, res) => {
  const b = parse(startSchema, req.body, res); if (!b) return;
  const conv = { kind: 'batch', batch: req.params.batch };
  if (!(await canAccessConversation(req.user, conv)))
    return res.status(403).json({ error: 'forbidden' });
  const room = roomForBatch(req.params.batch);
  const moderator = req.user.role !== 'student';
  const { rows } = await query(
    `insert into meetings (room, kind, started_by, batch) values ($1,$2,$3,$4)
     on conflict (room) do update set kind=excluded.kind returning *`,
    [room, b.kind, req.user.id, req.params.batch]);
  await logActivity({ userId: req.user.id, action: 'start_batch_meeting', entity: 'meetings', entityId: rows[0].id, ip: req.ip });
  res.json({ room, domain: config.jitsi.domain, kind: b.kind, token: jitsiToken({ user: req.user, room, moderator }) });
}));

// Admin monitor join — read/observe any room without ringing anyone.
meetingsRouter.post('/monitor/:meetingId', asyncH(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const mt = (await query('select * from meetings where id=$1', [req.params.meetingId])).rows[0];
  if (!mt) return res.status(404).json({ error: 'not found' });
  await logActivity({ userId: req.user.id, action: 'monitor_meeting', entity: 'meetings', entityId: mt.id, ip: req.ip });
  res.json({ room: mt.room, domain: config.jitsi.domain, token: jitsiToken({ user: req.user, room: mt.room, moderator: true }) });
}));
