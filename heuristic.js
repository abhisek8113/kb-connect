// ============================================================================
// HeuristicProvider — the default, 100% free/offline AI engine.
// Transparent, explainable scoring: every number the student/tutor sees comes
// with a plain-language reason. Implements the AiProvider interface so an LLM
// provider can be swapped in later without touching callers.
// ============================================================================

const clamp01 = x => Math.max(0, Math.min(1, x));
const pct = x => Math.round(x * 100);

// Component weights for the exam-readiness score (sum = 1).
const WEIGHTS = {
  mockAverage:     0.35,
  topicMastery:    0.25,
  assignments:     0.15,
  attendance:      0.10,
  studyConsistency:0.10,
  sillyControl:    0.05,
};

export const HeuristicProvider = {
  name: 'heuristic',

  // data → insight (pure function; persistence happens in engine.js)
  analyzeStudent(data) {
    const { mocks, topics, attendanceRate, assignments, study, mistakes } = data;

    // ── Component 1: recent mock average ──────────────────────────────────
    const recentMocks = mocks.slice(0, 4);
    const mockAvg = recentMocks.length
      ? recentMocks.reduce((a, m) => a + (+m.pct), 0) / recentMocks.length / 100 : 0.5;

    // Mock trend (improving/declining) from up to 4 recent mocks (oldest→newest).
    let trend = 0;
    if (recentMocks.length >= 2) {
      const chron = [...recentMocks].reverse().map(m => +m.pct);
      trend = (chron[chron.length - 1] - chron[0]) / 100; // -1..1
    }

    // ── Component 2: topic mastery ────────────────────────────────────────
    const attempted = topics.filter(t => t.total > 0);
    const topicMastery = attempted.length
      ? attempted.reduce((a, t) => a + t.accuracy, 0) / attempted.length : 0.5;

    // ── Component 3: assignments ──────────────────────────────────────────
    const assignmentScore = clamp01(assignments.completion * (0.6 + 0.4 * assignments.onTimeRate));

    // ── Component 4: attendance ───────────────────────────────────────────
    const attendanceScore = clamp01(attendanceRate);

    // ── Component 5: study consistency ────────────────────────────────────
    // Target ~7h (420 min) / 2 weeks; reward positive trend.
    const studyBase = clamp01(study.recent / 420);
    const studyTrend = study.prior > 0 ? clamp01(0.5 + (study.recent - study.prior) / (2 * study.prior)) : 0.5;
    const studyConsistency = clamp01(0.7 * studyBase + 0.3 * studyTrend);

    // ── Component 6: silly-mistake control ────────────────────────────────
    const totalMistakes = (mistakes.conceptual || 0) + (mistakes.silly || 0) + (mistakes.calculation || 0) + (mistakes.time || 0);
    const sillyRate = totalMistakes ? (mistakes.silly || 0) / totalMistakes : 0;
    const sillyControl = clamp01(1 - sillyRate);

    // ── Weighted readiness score with per-component explanations ──────────
    const components = { mockAverage: mockAvg, topicMastery, assignments: assignmentScore,
      attendance: attendanceScore, studyConsistency, sillyControl };
    let readiness = 0;
    const signals = {};
    for (const [k, w] of Object.entries(WEIGHTS)) {
      const contribution = w * components[k] * 100;
      readiness += contribution;
      signals[k] = {
        value: pct(components[k]),
        weight: w,
        contribution: Math.round(contribution * 10) / 10,
        explanation: explain(k, components[k], data),
      };
    }
    // Trend nudge: a clear decline caps optimism, a clear rise adds a little.
    readiness = clamp01((readiness + trend * 8) / 100) * 100;
    readiness = Math.round(readiness);

    // ── Risk level ────────────────────────────────────────────────────────
    let risk = readiness >= 70 ? 'low' : readiness >= 50 ? 'medium' : 'high';
    if (attendanceRate < 0.6 || trend < -0.15) risk = risk === 'low' ? 'medium' : 'high';

    // ── Weak topics (accuracy < 0.6), ranked by impact ────────────────────
    const weakTopics = attempted
      .filter(t => t.accuracy < 0.6)
      .map(t => ({
        topic: t.topic, subject: t.subject,
        accuracy: pct(t.accuracy),
        weight: Math.round(t.total * (1 - t.accuracy)),
        why: `Scored ${t.correct}/${t.total} (${pct(t.accuracy)}%) across mocks in ${t.topic}.`,
      }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 6);

    // ── Personalized study plan ───────────────────────────────────────────
    const plan = [];
    for (const w of weakTopics.slice(0, 4)) {
      plan.push({
        topic: `${w.subject} · ${w.topic}`,
        action: `Re-learn the core concept, then do 15 targeted problems on ${w.topic}.`,
        target: `Raise accuracy from ${w.accuracy}% to 75%+`,
        why: w.why,
      });
    }
    if (sillyRate > 0.3) plan.push({
      topic: 'Exam technique · silly mistakes',
      action: 'Use a 2-minute answer-review checklist; redo last mock flagging avoidable errors.',
      target: `Cut silly-mistake share from ${pct(sillyRate)}% to under 15%`,
      why: `${pct(sillyRate)}% of recent mistakes were avoidable (silly), not conceptual.`,
    });
    if (studyBase < 0.5) plan.push({
      topic: 'Study routine',
      action: 'Schedule 4 × 45-min focused sessions this week.',
      target: 'Reach ~7 hours of study over the next 2 weeks',
      why: `Only ${study.recent} min of study logged in the last 14 days.`,
    });
    if (assignments.completion < 0.8) plan.push({
      topic: 'Assignments',
      action: 'Clear pending assignments before the next class.',
      target: 'Completion 90%+, all on time',
      why: `Assignment completion is ${pct(assignments.completion)}%.`,
    });

    // ── Summary ───────────────────────────────────────────────────────────
    const trendWord = trend > 0.05 ? 'improving' : trend < -0.05 ? 'declining' : 'steady';
    const summary =
      `Exam readiness ${readiness}% (${risk} risk), trend ${trendWord}. ` +
      (weakTopics.length
        ? `Weakest concepts: ${weakTopics.slice(0, 3).map(w => w.topic).join(', ')}. `
        : 'No major concept gaps detected. ') +
      (sillyRate > 0.3 ? `A high ${pct(sillyRate)}% of errors are avoidable. ` : '') +
      (attendanceRate < 0.7 ? `Attendance is low (${pct(attendanceRate)}%). ` : '');

    return {
      provider: this.name,
      readiness_score: readiness,
      risk_level: risk,
      weak_topics: weakTopics,
      silly_rate: Math.round(sillyRate * 100) / 100,
      signals: { ...signals, trend: { value: Math.round(trend * 100), explanation: `Recent mock trend is ${trendWord}.` } },
      summary: summary.trim(),
      study_plan: plan,
    };
  },

  // Tutor Copilot: one-line "who needs what" headline + structured detail.
  weeklyHeadline(insight, data) {
    const name = data.student.full_name;
    if (insight.risk_level === 'high') {
      const t = insight.weak_topics[0];
      return `🔴 ${name} needs urgent help${t ? ` with ${t.subject} · ${t.topic}` : ''} — readiness ${insight.readiness_score}%.`;
    }
    if (insight.risk_level === 'medium') {
      const t = insight.weak_topics[0];
      return `🟡 ${name} is at moderate risk${t ? `; focus on ${t.topic}` : ''} — readiness ${insight.readiness_score}%.`;
    }
    return `🟢 ${name} is on track — readiness ${insight.readiness_score}%.`;
  },
};

function explain(component, v, data) {
  const P = pct(v);
  switch (component) {
    case 'mockAverage': return `Recent mock average is ${P}% (weight 35%).`;
    case 'topicMastery': return `Mean accuracy across attempted topics is ${P}% (weight 25%).`;
    case 'assignments': return `Assignment completion ${pct(data.assignments.completion)}% × timeliness (weight 15%).`;
    case 'attendance': return `Attendance rate ${pct(data.attendanceRate)}% over 60 days (weight 10%).`;
    case 'studyConsistency': return `Study time & trend — ${data.study.recent} min in 14 days (weight 10%).`;
    case 'sillyControl': return `${P}% of errors were conceptual rather than avoidable (weight 5%).`;
    default: return '';
  }
}
