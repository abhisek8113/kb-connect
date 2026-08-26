const BASE = 'http://127.0.0.1:4000';
const login = async (u, p) => (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json());
const get = async (path, t) => { const r = await fetch(BASE + path, { headers: { authorization: 'Bearer ' + t } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
let pass = 0, fail = 0; const check = (n, c, extra) => { console.log((c ? '✅' : '❌') + ' ' + n + (extra ? '  → ' + extra : '')); c ? pass++ : fail++; };

const arjun = await login('arjun', 'Student@123');
const divya = await login('divya', 'Student@123');
const priya = await login('priya', 'Tutor@12345');
const admin = await login('admin', 'Admin@12345');
const karan = await login('karan', 'Student@123');

const me = await get('/api/ai/me', arjun.access);
check('student gets own AI insight', me.status === 200 && typeof me.body.readiness_score !== 'undefined', `readiness ${me.body.readiness_score}% risk=${me.body.risk_level}`);
check('weak topics detected (Trigonometry)', (me.body.weak_topics || []).some(w => w.topic === 'Trigonometry'), (me.body.weak_topics || []).map(w => w.topic + ' ' + w.accuracy + '%').join(', '));
check('study plan generated', (me.body.study_plan || []).length > 0, `${(me.body.study_plan || []).length} steps; first: ${me.body.study_plan?.[0]?.topic}`);
check('signals have explanations', !!me.body.signals?.mockAverage?.explanation, me.body.signals?.mockAverage?.explanation);
check('silly-mistake rate computed', me.body.silly_rate > 0, `silly_rate=${me.body.silly_rate}`);

const dv = await get('/api/ai/me', divya.access);
check('Divya readiness > Arjun', dv.body.readiness_score > me.body.readiness_score, `Divya ${dv.body.readiness_score} vs Arjun ${me.body.readiness_score}`);

const g = await get('/api/ai/me/gamification', arjun.access);
check('gamification points + leaderboard', g.status === 200 && typeof g.body.points === 'number' && Array.isArray(g.body.leaderboard), `pts=${g.body.points} lvl=${g.body.level} board=${g.body.leaderboard.length}`);

const ts = await get('/api/ai/students', priya.access);
const names = ts.body.map(s => s.name);
check('tutor Priya sees Arjun & Divya', names.includes('Arjun R') && names.includes('Divya S'), names.join(', '));
check('tutor Priya does NOT see Karan', !names.includes('Karan M'));

const cross = await get('/api/ai/students/' + karan.user.id, priya.access);
check('tutor blocked from unmapped student insight (403)', cross.status === 403);

const cop = await get('/api/ai/copilot', priya.access);
check('Copilot weekly summary', cop.status === 200 && cop.body.students.length === 2, cop.body.students.map(s => s.headline).join(' | '));
check('Copilot ranks needy first', cop.body.students[0].detail.readiness <= cop.body.students[1].detail.readiness);

const ov = await get('/api/ai/overview', admin.access);
check('admin overview', ov.status === 200 && Array.isArray(ov.body.at_risk), `avg readiness ${ov.body.avg_readiness}`);

const blob = JSON.stringify([me.body, ts.body, cop.body, ov.body]);
check('no phone numbers in AI payloads', !blob.includes('phone') && !/\b\d{10}\b/.test(blob));

// student cannot reach tutor/admin AI endpoints
const forbid = await get('/api/ai/overview', arjun.access);
check('student blocked from admin overview (403)', forbid.status === 403);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
