import { query } from '../db.js';

// Gather every raw signal the AI reasons over for one student.
// Returns plain numbers/arrays — NO personal contact info is ever included.
export async function gatherStudentData(studentId) {
  const student = (await query(
    'select id, full_name, std, board, batch from users where id=$1', [studentId])).rows[0];

  // Recent mocks (last 8) with overall pct.
  const mocks = (await query(
    `select mr.id, mt.subject, mt.held_on, mr.score, mr.max_score,
            round(100.0*mr.score/nullif(mr.max_score,0),1) pct
     from mock_results mr join mock_tests mt on mt.id=mr.mock_test_id
     where mr.student_id=$1 order by mt.held_on desc limit 8`, [studentId])).rows;

  // Per-topic accuracy + silly mistakes aggregated across all mocks.
  const topicRows = (await query(
    `select t.id topic_id, t.name topic, t.subject,
            sum(mts.correct) correct, sum(mts.total) total, sum(mts.silly_mistakes) silly
     from mock_topic_scores mts
     join mock_results mr on mr.id=mts.mock_result_id
     join topics t on t.id=mts.topic_id
     where mr.student_id=$1
     group by t.id, t.name, t.subject`, [studentId])).rows;
  const topics = topicRows.map(r => ({
    topic_id: r.topic_id, topic: r.topic, subject: r.subject,
    correct: +r.correct, total: +r.total,
    accuracy: r.total > 0 ? +r.correct / +r.total : 0,
    silly: +r.silly,
  }));

  // Attendance (last 60 days).
  const att = (await query(
    `select status, count(*)::int c from attendance
     where student_id=$1 and on_date > current_date - interval '60 days' group by status`, [studentId])).rows;
  const attMap = Object.fromEntries(att.map(r => [r.status, r.c]));
  const attTotal = (attMap.present || 0) + (attMap.absent || 0) + (attMap.late || 0);
  const attendanceRate = attTotal ? (attMap.present || 0) / attTotal : 1;

  // Assignments: assigned to the student's batch vs. submitted.
  const assignedCount = (await query(
    `select count(*)::int c from assignments a where a.batch=$1`, [student.batch])).rows[0].c;
  const subs = (await query(
    `select status, count(*)::int c,
            avg(case when status='submitted' then 1 else 0 end)::float ontime
     from assignment_submissions where student_id=$1 group by status`, [studentId])).rows;
  const submitted = subs.filter(s => s.status !== 'missed').reduce((a, s) => a + s.c, 0);
  const onTime = subs.filter(s => s.status === 'submitted').reduce((a, s) => a + s.c, 0);
  const completion = assignedCount ? Math.min(1, submitted / assignedCount) : 1;
  const onTimeRate = submitted ? onTime / submitted : 1;

  // Study minutes: last 14 days vs prior 14.
  const study = (await query(
    `select
       coalesce(sum(minutes) filter (where on_date > current_date - interval '14 days'),0)::int recent,
       coalesce(sum(minutes) filter (where on_date <= current_date - interval '14 days'
                                       and on_date > current_date - interval '28 days'),0)::int prior
     from study_sessions where student_id=$1`, [studentId])).rows[0];

  // Mistakes by kind (last 60 days).
  const mis = (await query(
    `select kind, count(*)::int c from mistake_logs
     where student_id=$1 and on_date > current_date - interval '60 days' group by kind`, [studentId])).rows;
  const mistakes = Object.fromEntries(mis.map(r => [r.kind, r.c]));

  return {
    student, mocks, topics,
    attendanceRate, attendanceCounts: attMap,
    assignments: { assignedCount, submitted, completion, onTimeRate },
    study: { recent: +study.recent, prior: +study.prior },
    mistakes,
  };
}
