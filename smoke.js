// End-to-end smoke test: auth, RBAC privacy, admin monitoring, notifications.
const BASE = process.env.BASE || 'http://127.0.0.1:4000';
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const login = async (u, p) => j(await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: u, password: p }) }));
const auth = (t) => ({ 'authorization': 'Bearer ' + t, 'content-type': 'application/json' });

let pass = 0, fail = 0;
const check = (name, cond) => { console.log((cond ? '✅' : '❌') + ' ' + name); cond ? pass++ : fail++; };

const admin = await login('admin', 'Admin@12345');
const priya = await login('priya', 'Tutor@12345');
const karthik = await login('karthik', 'Tutor@12345');
const arjun = await login('arjun', 'Student@123');
const karan = await login('karan', 'Student@123');
check('admin login', admin.status === 200 && admin.body.access);
check('tutor login', priya.status === 200);
check('student login', arjun.status === 200);
check('login never returns phone', !JSON.stringify(admin.body.user).includes('phone'));
check('bad password rejected', (await login('arjun', 'wrong')).status === 401);

// Contacts privacy
const priyaContacts = await j(await fetch(BASE + '/api/messages/contacts', { headers: auth(priya.body.access) }));
const names = priyaContacts.body.map(u => u.name);
check('tutor Priya sees Arjun (assigned)', names.includes('Arjun R'));
check('tutor Priya sees Divya (assigned)', names.includes('Divya S'));
check('tutor Priya does NOT see Karan (other tutor)', !names.includes('Karan M'));
check('contacts expose no phone', !JSON.stringify(priyaContacts.body).includes('phone'));

const arjunContacts = await j(await fetch(BASE + '/api/messages/contacts', { headers: auth(arjun.body.access) }));
const an = arjunContacts.body.map(u => u.name);
check('student Arjun sees Priya (his tutor)', an.includes("Priya Ma'am"));
check('student Arjun does NOT see Karthik', !an.includes('Karthik Sir'));
check('student Arjun does NOT see other student Divya', !an.includes('Divya S'));

// RBAC: student cannot hit admin surface
const forbidden = await fetch(BASE + '/api/admin/users', { headers: auth(arjun.body.access) });
check('student blocked from admin API (403)', forbidden.status === 403);

// Messaging permission: Karthik cannot DM Arjun (not mapped)
const dmBad = await fetch(BASE + '/api/messages/dm/' + arjun.body.user.id, { method: 'POST', headers: auth(karthik.body.access) });
check('unmapped tutor cannot open DM with Arjun (403)', dmBad.status === 403);
// Priya CAN DM Arjun
const dmOk = await j(await fetch(BASE + '/api/messages/dm/' + arjun.body.user.id, { method: 'POST', headers: auth(priya.body.access) }));
check('mapped tutor CAN open DM with Arjun', dmOk.status === 200 && dmOk.body.id);

// Send a message via REST, admin can read it (monitoring), student cannot read others'
await fetch(BASE + '/api/messages/conversations/' + dmOk.body.id + '/messages', {
  method: 'POST', headers: auth(priya.body.access), body: JSON.stringify({ body: 'Hello Arjun, homework?' }) });
const adminRead = await j(await fetch(BASE + '/api/admin/conversations/' + dmOk.body.id + '/messages', { headers: auth(admin.body.access) }));
check('admin can read any conversation (monitoring)', adminRead.status === 200 && adminRead.body.length >= 1);
const karanRead = await fetch(BASE + '/api/messages/conversations/' + dmOk.body.id + '/messages', { headers: auth(karan.body.access) });
check('unrelated student blocked from that conversation (403)', karanRead.status === 403);

// Meeting: Priya starts a call with Arjun -> gets a Jitsi room + token, no phone
const meet = await j(await fetch(BASE + '/api/meetings/dm/' + arjun.body.user.id, {
  method: 'POST', headers: auth(priya.body.access), body: JSON.stringify({ kind: 'video' }) }));
check('tutor starts meeting, gets room+token', meet.status === 200 && meet.body.room && meet.body.token);
check('meeting payload has no phone', !JSON.stringify(meet.body).includes('phone'));

// Notification prefs (DND)
const dnd = await j(await fetch(BASE + '/api/notifications/prefs', {
  method: 'PUT', headers: auth(priya.body.access), body: JSON.stringify({ dnd: true }) }));
check('tutor can enable DND', dnd.status === 200 && dnd.body.dnd === true);

// Admin monitoring endpoints
const convs = await j(await fetch(BASE + '/api/admin/conversations', { headers: auth(admin.body.access) }));
check('admin lists all conversations', convs.status === 200 && convs.body.length >= 1);
const activity = await j(await fetch(BASE + '/api/admin/activity', { headers: auth(admin.body.access) }));
check('admin sees activity/login logs', activity.status === 200 && activity.body.some(a => a.action === 'login'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
