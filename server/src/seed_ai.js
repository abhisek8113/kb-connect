// Seeds realistic performance data for the demo students so the AI has signals
// to reason over. Idempotent-ish: safe to re-run (uses deterministic keys).
import { pool, query } from './db.js';
import { runForAll } from './ai/engine.js';

const uid = async (username) => (await query('select id, batch from users where username=$1', [username])).rows[0];

async function topic(subject, name) {
  return (await query(
    `insert into topics (subject, name) values ($1,$2)
     on conflict (subject, name) do update set name=excluded.name returning id`, [subject, name])).rows[0].id;
}

async function mock(title, subject, batch, tutorId, maxScore, daysAgo) {
  return (await query(
    `insert into mock_tests (title, subject, batch, tutor_id, max_score, held_on)
     values ($1,$2,$3,$4,$5, current_date - ($6||' days')::interval) returning id`,
    [title, subject, batch, tutorId, maxScore, daysAgo])).rows[0].id;
}

async function result(mockId, studentId, score, max, topicScores) {
  const r = (await query(
    `insert into mock_results (mock_test_id, student_id, score, max_score) values ($1,$2,$3,$4)
     on conflict (mock_test_id, student_id) do update set score=excluded.score returning id`,
    [mockId, studentId, score, max])).rows[0].id;
  for (const t of topicScores)
    await query(
      `insert into mock_topic_scores (mock_result_id, topic_id, correct, total, silly_mistakes)
       values ($1,$2,$3,$4,$5)`, [r, t.topic, t.correct, t.total, t.silly || 0]);
  return r;
}

try {
  const priya = await uid('priya');   // Maths, B-10A
  const karthik = await uid('karthik'); // Physics, B-12S
  const arjun = await uid('arjun');   // B-10A, mapped to priya
  const divya = await uid('divya');   // B-10A, mapped to priya
  const karan = await uid('karan');   // B-12S, mapped to karthik

  const algebra = await topic('Maths', 'Algebra');
  const geometry = await topic('Maths', 'Geometry');
  const trig = await topic('Maths', 'Trigonometry');
  const mech = await topic('Physics', 'Mechanics');
  const optics = await topic('Physics', 'Optics');

  // ARJUN — struggling in Trigonometry, lots of silly mistakes, declining.
  const m1 = await mock('Maths Unit Test 1', 'Maths', 'B-10A', priya.id, 100, 40);
  const m2 = await mock('Maths Unit Test 2', 'Maths', 'B-10A', priya.id, 100, 20);
  const m3 = await mock('Maths Model Exam', 'Maths', 'B-10A', priya.id, 100, 5);
  await result(m1, arjun.id, 72, 100, [{ topic: algebra, correct: 8, total: 10 }, { topic: geometry, correct: 7, total: 10 }, { topic: trig, correct: 4, total: 10, silly: 3 }]);
  await result(m2, arjun.id, 64, 100, [{ topic: algebra, correct: 7, total: 10 }, { topic: geometry, correct: 6, total: 10 }, { topic: trig, correct: 3, total: 10, silly: 4 }]);
  await result(m3, arjun.id, 58, 100, [{ topic: algebra, correct: 7, total: 10 }, { topic: geometry, correct: 5, total: 10, silly: 2 }, { topic: trig, correct: 3, total: 10, silly: 4 }]);

  // DIVYA — strong and improving.
  await result(await mock('Maths Unit Test 1b', 'Maths', 'B-10A', priya.id, 100, 40), divya.id, 80, 100, [{ topic: algebra, correct: 9, total: 10 }, { topic: trig, correct: 7, total: 10 }]);
  await result(await mock('Maths Model Exam b', 'Maths', 'B-10A', priya.id, 100, 5), divya.id, 93, 100, [{ topic: algebra, correct: 10, total: 10 }, { topic: trig, correct: 9, total: 10, silly: 1 }]);

  // KARAN — weak in Mechanics (Karthik's student).
  await result(await mock('Physics Unit Test', 'Physics', 'B-12S', karthik.id, 100, 15), karan.id, 55, 100, [{ topic: mech, correct: 4, total: 12, silly: 2 }, { topic: optics, correct: 8, total: 10 }]);

  // Attendance
  const att = async (sid, tid, present, absent, late) => {
    for (let i = 0; i < present; i++) await query(`insert into attendance (student_id, tutor_id, status, on_date) values ($1,$2,'present', current_date - ($3||' days')::interval) on conflict do nothing`, [sid, tid, i]);
    for (let i = 0; i < absent; i++) await query(`insert into attendance (student_id, tutor_id, status, on_date) values ($1,$2,'absent', current_date - ($3||' days')::interval) on conflict do nothing`, [sid, tid, present + i]);
    for (let i = 0; i < late; i++) await query(`insert into attendance (student_id, tutor_id, status, on_date) values ($1,$2,'late', current_date - ($3||' days')::interval) on conflict do nothing`, [sid, tid, present + absent + i]);
  };
  await att(arjun.id, priya.id, 18, 6, 3);   // ~66% attendance
  await att(divya.id, priya.id, 26, 1, 1);
  await att(karan.id, karthik.id, 20, 4, 2);

  // Assignments (batch-scoped) + submissions
  const asg = async (tutorId, batch, title, daysAgo) => (await query(
    `insert into assignments (tutor_id, title, batch, due_at) values ($1,$2,$3, now() - ($4||' days')::interval) returning id`,
    [tutorId, title, batch, daysAgo])).rows[0].id;
  const a1 = await asg(priya.id, 'B-10A', 'Algebra worksheet 5', 10);
  const a2 = await asg(priya.id, 'B-10A', 'Trigonometry problems', 3);
  const sub = async (aid, sid, status) => query(
    `insert into assignment_submissions (assignment_id, student_id, status, submitted_at)
     values ($1,$2,$3, now()) on conflict do nothing`, [aid, sid, status]);
  await sub(a1, arjun.id, 'submitted'); await sub(a2, arjun.id, 'missed');   // 50% completion
  await sub(a1, divya.id, 'submitted'); await sub(a2, divya.id, 'submitted');

  // Study sessions (minutes over last weeks)
  const study = async (sid, subj, mins, daysAgo) => query(
    `insert into study_sessions (student_id, subject, minutes, on_date) values ($1,$2,$3, current_date - ($4||' days')::interval)`, [sid, subj, mins, daysAgo]);
  for (const d of [1, 3, 5, 9, 12]) await study(arjun.id, 'Maths', 35, d);   // low-ish
  for (const d of [1, 2, 3, 4, 6, 8, 10, 12]) await study(divya.id, 'Maths', 55, d); // consistent
  for (const d of [2, 6, 11]) await study(karan.id, 'Physics', 40, d);

  // Mistake logs — Arjun makes many silly mistakes
  const mis = async (sid, topicId, kind, n) => { for (let i = 0; i < n; i++) await query(`insert into mistake_logs (student_id, topic_id, kind, on_date) values ($1,$2,$3, current_date - ($4||' days')::interval)`, [sid, topicId, kind, i]); };
  await mis(arjun.id, trig, 'silly', 7); await mis(arjun.id, trig, 'conceptual', 3); await mis(arjun.id, geometry, 'calculation', 2);
  await mis(divya.id, trig, 'silly', 1); await mis(divya.id, algebra, 'conceptual', 1);
  await mis(karan.id, mech, 'conceptual', 4); await mis(karan.id, mech, 'silly', 2);

  // Run the AI over everyone so dashboards have data immediately.
  const n = await runForAll();
  console.log(`✅ AI seed complete. Insights generated for ${n} students.`);
} catch (e) {
  console.error('AI seed failed:', e.message); console.error(e.stack); process.exitCode = 1;
} finally {
  await pool.end();
}
