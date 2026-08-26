import { query } from '../db.js';
import { provider } from './index.js';
import { gatherStudentData } from './data.js';

// Run the AI for one student: gather → analyze → persist insight + history +
// gamification. Safe to call often (upserts). Returns the insight.
export async function runForStudent(studentId) {
  const data = await gatherStudentData(studentId);
  const insight = await provider.analyzeStudent(data);

  await query(
    `insert into ai_insights (student_id, provider, readiness_score, risk_level, weak_topics, silly_rate, signals, summary, study_plan, generated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     on conflict (student_id) do update set
       provider=excluded.provider, readiness_score=excluded.readiness_score, risk_level=excluded.risk_level,
       weak_topics=excluded.weak_topics, silly_rate=excluded.silly_rate, signals=excluded.signals,
       summary=excluded.summary, study_plan=excluded.study_plan, generated_at=now()`,
    [studentId, insight.provider, insight.readiness_score, insight.risk_level,
     JSON.stringify(insight.weak_topics), insight.silly_rate, JSON.stringify(insight.signals),
     insight.summary, JSON.stringify(insight.study_plan)]);

  await query(
    `insert into ai_insight_history (student_id, readiness_score, risk_level) values ($1,$2,$3)`,
    [studentId, insight.readiness_score, insight.risk_level]);

  await updateGamification(studentId, insight, data);
  return { insight, data };
}

// Recompute for every student (background runner / cron).
export async function runForAll() {
  const students = (await query("select id from users where role='student' and is_active")).rows;
  let n = 0;
  for (const s of students) { try { await runForStudent(s.id); n++; } catch (e) { console.error('AI run failed for', s.id, e.message); } }
  return n;
}

// Tutor Copilot: build/refresh this week's per-student summaries for a tutor.
export async function buildCopilotForTutor(tutorId) {
  const students = (await query(
    `select s.id from mappings m join users s on s.id=m.student_id where m.tutor_id=$1`, [tutorId])).rows;
  const weekStart = mondayOf(new Date());
  const out = [];
  for (const s of students) {
    const { insight, data } = await runForStudent(s.id);
    const headline = provider.weeklyHeadline(insight, data);
    const detail = {
      readiness: insight.readiness_score, risk: insight.risk_level,
      weak_topics: insight.weak_topics.slice(0, 3),
      top_action: insight.study_plan[0] || null,
      attendance: Math.round(data.attendanceRate * 100),
      study_minutes_14d: data.study.recent,
    };
    await query(
      `insert into copilot_summaries (student_id, tutor_id, week_start, headline, detail)
       values ($1,$2,$3,$4,$5)
       on conflict (student_id, week_start) do update set headline=excluded.headline, detail=excluded.detail, generated_at=now()`,
      [s.id, tutorId, weekStart, headline, JSON.stringify(detail)]);
    out.push({ student_id: s.id, name: data.student.full_name, headline, detail });
  }
  // Sort so the students needing the most help surface first.
  const order = { high: 0, medium: 1, low: 2 };
  out.sort((a, b) => order[a.detail.risk] - order[b.detail.risk] || a.detail.readiness - b.detail.readiness);
  return { weekStart, students: out };
}

// ── Gamification: points, level, streak, badges ────────────────────────────
async function updateGamification(studentId, insight, data) {
  const g = (await query('select * from gamification where student_id=$1', [studentId])).rows[0]
    || (await query('insert into gamification (student_id) values ($1) returning *', [studentId])).rows[0];

  // Points model (transparent): readiness + study + assignment completion.
  const points = Math.round(insight.readiness_score * 2
    + Math.min(data.study.recent, 600) / 10
    + data.assignments.completion * 50);
  const level = 1 + Math.floor(points / 250);

  // Streak: increment if studied recently, else reset.
  const today = new Date();
  const last = g.last_active ? new Date(g.last_active) : null;
  let streak = g.streak_days;
  if (data.study.recent > 0) {
    const days = last ? Math.round((today - last) / 86400000) : 99;
    streak = days <= 1 ? streak + 1 : 1;
  }

  await query(
    `update gamification set points=$2, level=$3, streak_days=$4, last_active=current_date, updated_at=now() where student_id=$1`,
    [studentId, points, level, streak]);

  // Award badges.
  const award = async (code, label) => query(
    `insert into badges (student_id, code, label) values ($1,$2,$3) on conflict (student_id, code) do nothing`,
    [studentId, code, label]);
  if (streak >= 7) await award('streak_7', '7-day study streak');
  if (insight.readiness_score >= 85) await award('exam_ready', 'Exam-ready (85%+)');
  if (data.assignments.completion >= 1) await award('all_assignments', 'All assignments done');
  if ((data.mocks[0]?.pct || 0) >= 95) await award('centum_club', 'Centum club (95%+ mock)');
}

function mondayOf(d) {
  const x = new Date(d); const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day); return x.toISOString().slice(0, 10);
}
