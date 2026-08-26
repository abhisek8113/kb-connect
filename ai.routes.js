import { Router } from 'express';
import { query } from '../db.js';
import { authenticate } from '../auth/middleware.js';
import { requireRole, areMapped } from '../rbac.js';
import { runForStudent, runForAll, buildCopilotForTutor } from '../ai/engine.js';
import { asyncH } from '../util/http.js';

export const aiRouter = Router();
aiRouter.use(authenticate);

// helper: fetch (recomputing if stale/missing) a student's insight
async function getInsight(studentId, { recompute = false } = {}) {
  let row = (await query('select * from ai_insights where student_id=$1', [studentId])).rows[0];
  const stale = row && (Date.now() - new Date(row.generated_at).getTime()) > 6 * 3600 * 1000;
  if (!row || stale || recompute) { await runForStudent(studentId); row = (await query('select * from ai_insights where student_id=$1', [studentId])).rows[0]; }
  return row;
}

// ── STUDENT: my own dashboard ───────────────────────────────────────────────
aiRouter.get('/me', requireRole('student'), asyncH(async (req, res) => {
  const insight = await getInsight(req.user.id);
  res.json(insight);
}));

aiRouter.get('/me/gamification', requireRole('student'), asyncH(async (req, res) => {
  const g = (await query('select * from gamification where student_id=$1', [req.user.id])).rows[0] || { points: 0, level: 1, streak_days: 0 };
  const badges = (await query('select code, label, earned_at from badges where student_id=$1 order by earned_at desc', [req.user.id])).rows;
  // Leaderboard within the student's own batch only (privacy: names of batchmates
  // are visible in a class ranking, never any contact info).
  const board = (await query(
    `select u.full_name name, g.points from gamification g join users u on u.id=g.student_id
     where u.batch=$1 order by g.points desc limit 10`, [req.user.batch])).rows;
  res.json({ ...g, badges, leaderboard: board });
}));

aiRouter.get('/me/trend', requireRole('student'), asyncH(async (req, res) => {
  const { rows } = await query(
    `select readiness_score, risk_level, generated_at from ai_insight_history
     where student_id=$1 order by generated_at desc limit 20`, [req.user.id]);
  res.json(rows.reverse());
}));

// ── TUTOR: only assigned students ───────────────────────────────────────────
aiRouter.get('/students', requireRole('tutor', 'admin'), asyncH(async (req, res) => {
  const rows = req.user.role === 'admin'
    ? (await query(
        `select s.id, s.full_name name, s.batch, i.readiness_score, i.risk_level, i.weak_topics, i.generated_at
         from users s left join ai_insights i on i.student_id=s.id where s.role='student' and s.is_active
         order by (i.risk_level='high') desc, i.readiness_score asc nulls first`)).rows
    : (await query(
        `select s.id, s.full_name name, s.batch, i.readiness_score, i.risk_level, i.weak_topics, i.generated_at
         from mappings m join users s on s.id=m.student_id
         left join ai_insights i on i.student_id=s.id
         where m.tutor_id=$1 and s.is_active
         order by (i.risk_level='high') desc, i.readiness_score asc nulls first`, [req.user.id])).rows;
  res.json(rows);
}));

// One student's full insight — tutor must be mapped (or admin).
aiRouter.get('/students/:id', requireRole('tutor', 'admin'), asyncH(async (req, res) => {
  if (req.user.role === 'tutor' && !(await areMapped(req.user.id, req.params.id)))
    return res.status(403).json({ error: 'not your student' });
  const insight = await getInsight(req.params.id);
  const student = (await query('select full_name, std, board, batch from users where id=$1', [req.params.id])).rows[0];
  res.json({ student, insight });
}));

aiRouter.post('/students/:id/refresh', requireRole('tutor', 'admin'), asyncH(async (req, res) => {
  if (req.user.role === 'tutor' && !(await areMapped(req.user.id, req.params.id)))
    return res.status(403).json({ error: 'not your student' });
  res.json(await getInsight(req.params.id, { recompute: true }));
}));

// ── TUTOR COPILOT: weekly "who needs what" ──────────────────────────────────
aiRouter.get('/copilot', requireRole('tutor'), asyncH(async (req, res) => {
  res.json(await buildCopilotForTutor(req.user.id));
}));

// ── ADMIN: overview + trigger a full recompute ──────────────────────────────
aiRouter.get('/overview', requireRole('admin'), asyncH(async (req, res) => {
  const dist = (await query(
    `select risk_level, count(*)::int c from ai_insights group by risk_level`)).rows;
  const avg = (await query('select round(avg(readiness_score),1) a from ai_insights')).rows[0].a;
  const atRisk = (await query(
    `select s.full_name name, s.batch, i.readiness_score, i.risk_level
     from ai_insights i join users s on s.id=i.student_id
     where i.risk_level in ('high','medium') order by i.readiness_score asc limit 25`)).rows;
  res.json({ distribution: dist, avg_readiness: avg, at_risk: atRisk });
}));

aiRouter.post('/run', requireRole('admin'), asyncH(async (req, res) => {
  const n = await runForAll();
  res.json({ recomputed: n });
}));
