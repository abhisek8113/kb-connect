/* ============================================================================
   KB Connect — front-end. Talks to the REST API + Socket.IO. All permission
   decisions are made server-side; this client only renders what it's allowed.
   ============================================================================ */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const api = {
  token: null, refresh: null, user: null,
  async call(path, opts = {}) {
    const r = await fetch('/api' + path, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: 'Bearer ' + this.token } : {}), ...(opts.headers || {}) },
    });
    if (r.status === 401 && this.refresh && path !== '/auth/refresh') {
      if (await this.doRefresh()) return this.call(path, opts);
    }
    return r;
  },
  async doRefresh() {
    const r = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh: this.refresh }) });
    if (!r.ok) { logout(); return false; }
    const d = await r.json(); this.token = d.access; this.refresh = d.refresh; save(); return true;
  },
};
const COLORS = ['#F5C842', '#00E5A0', '#6366F1', '#A5B4FC', '#F97316', '#EF4444', '#22c55e', '#06B6D4'];
const colorFor = id => COLORS[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const initials = n => String(n || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let socket = null, contacts = [], current = null, dnd = false;
const state = { activeCallId: null };

function save() { try { localStorage.setItem('kb_tok', JSON.stringify({ t: api.token, r: api.refresh, u: api.user })); } catch {} }
function load() { try { const d = JSON.parse(localStorage.getItem('kb_tok')); if (d) { api.token = d.t; api.refresh = d.r; api.user = d.u; } } catch {} }

/* ── Auth ─────────────────────────────────────────────── */
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginErr').textContent = '';
  const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: $('#u').value.trim(), password: $('#p').value }) });
  if (!r.ok) { $('#loginErr').textContent = 'Invalid username or password.'; return; }
  const d = await r.json(); api.token = d.access; api.refresh = d.refresh; api.user = d.user; save();
  await start();
});
$('#logout').addEventListener('click', logout);
function logout() { try { localStorage.removeItem('kb_tok'); } catch {} if (socket) socket.disconnect(); location.reload(); }

/* ── Boot ─────────────────────────────────────────────── */
async function start() {
  $('#loginWrap').classList.add('hidden');
  $('#app').classList.remove('hidden');
  const u = api.user;
  $('#rolePill').textContent = u.role;
  $('#meName').textContent = u.name;
  $('#meAv').textContent = initials(u.name);
  $('#meAv').style.background = colorFor(u.id);
  buildNav();
  connectSocket();
  await loadContacts();
  await refreshBadge();
  // DND state
  const prefs = await (await api.call('/notifications/prefs')).json();
  dnd = !!prefs.dnd; $('#dndSwitch').classList.toggle('on', dnd);
}

$('#dndSwitch').addEventListener('click', async () => {
  dnd = !dnd; $('#dndSwitch').classList.toggle('on', dnd);
  await api.call('/notifications/prefs', { method: 'PUT', body: JSON.stringify({ dnd }) });
  toast(dnd ? '🔕 Do Not Disturb on' : '🔔 Alerts on', dnd ? 'Incoming call alerts silenced' : 'You will be alerted for calls');
});

function buildNav() {
  const nav = $('#nav'); nav.innerHTML = '';
  const item = (label, fn, active) => { const b = document.createElement('button'); b.innerHTML = label; if (active) b.classList.add('active'); b.onclick = () => { [...nav.children].forEach(c => c.classList.remove('active')); b.classList.add('active'); fn(); }; nav.appendChild(b); };
  item('💬 Messages', showMessages, true);
  if (api.user.role === 'student') {
    item('📊 My progress', () => studentDashboard());
    item('🏆 Rewards', () => studentRewards());
  }
  if (api.user.role === 'tutor') {
    item('📊 Student insights', () => tutorInsights());
    item('🤖 Tutor Copilot', () => tutorCopilot());
  }
  if (api.user.role === 'admin') {
    item('👥 Users', () => adminUsers());
    item('🔗 Assign tutors', () => adminMappings());
    item('🤖 AI overview', () => adminAI());
    item('🛡️ Monitor chats', () => adminMonitor());
    item('📞 Call history', () => adminCalls());
    item('🎥 Meetings', () => adminMeetings());
    item('📜 Activity logs', () => adminActivity());
    item('📢 Announce', () => adminAnnounce());
  }
}

/* ── AI: shared UI bits ───────────────────────────────── */
const riskColor = r => ({ high: 'var(--danger)', medium: '#F97316', low: 'var(--teal)' }[r] || 'var(--muted)');
const riskLabel = r => ({ high: '🔴 High risk', medium: '🟡 Medium risk', low: '🟢 On track' }[r] || r);
function gauge(score, risk) {
  const c = riskColor(risk), deg = Math.round(score * 3.6);
  return `<div style="width:150px;height:150px;border-radius:50%;background:conic-gradient(${c} ${deg}deg,var(--border) ${deg}deg);display:flex;align-items:center;justify-content:center;margin:0 auto">
    <div style="width:116px;height:116px;border-radius:50%;background:var(--panel);display:flex;flex-direction:column;align-items:center;justify-content:center">
      <div style="font-size:34px;font-weight:800;color:${c}">${score}</div>
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Readiness</div>
    </div></div>`;
}
function signalsTable(signals) {
  const keys = ['mockAverage', 'topicMastery', 'assignments', 'attendance', 'studyConsistency', 'sillyControl'];
  const nice = { mockAverage: 'Mock average', topicMastery: 'Topic mastery', assignments: 'Assignments', attendance: 'Attendance', studyConsistency: 'Study consistency', sillyControl: 'Silly-mistake control' };
  return `<table><thead><tr><th>Factor</th><th>Score</th><th>Weight</th><th>Contribution</th><th>Why</th></tr></thead><tbody>${
    keys.filter(k => signals[k]).map(k => `<tr><td>${nice[k]}</td><td>${signals[k].value}%</td><td>${Math.round(signals[k].weight * 100)}%</td><td>+${signals[k].contribution}</td><td style="color:var(--muted);font-size:12px">${esc(signals[k].explanation)}</td></tr>`).join('')
  }</tbody></table>`;
}
function weakList(w) {
  return w.length ? w.map(t => `<div style="padding:8px 0;border-bottom:1px solid var(--border)"><b>${esc(t.subject)} · ${esc(t.topic)}</b> <span style="color:${t.accuracy < 40 ? 'var(--danger)' : '#F97316'};font-weight:700">${t.accuracy}%</span><div style="color:var(--muted);font-size:12px">${esc(t.why)}</div></div>`).join('') : '<div style="color:var(--muted)">No major concept gaps 🎉</div>';
}
function planList(p) {
  return p.length ? p.map((s, i) => `<div class="card" style="margin-bottom:10px"><b>${i + 1}. ${esc(s.topic)}</b><div style="margin:4px 0">${esc(s.action)}</div><div style="font-size:12px;color:var(--teal)">🎯 ${esc(s.target)}</div><div style="font-size:11.5px;color:var(--muted);margin-top:3px">${esc(s.why)}</div></div>`).join('') : '<div style="color:var(--muted)">No actions needed right now.</div>';
}

/* ── Student dashboard ────────────────────────────────── */
async function studentDashboard() {
  const i = await (await api.call('/ai/me')).json();
  showAdmin(`<h2>📊 My progress</h2>
    <div class="card" style="display:flex;gap:24px;align-items:center;flex-wrap:wrap">
      ${gauge(i.readiness_score, i.risk_level)}
      <div style="flex:1;min-width:240px">
        <div style="font-weight:800;color:${riskColor(i.risk_level)};font-size:15px">${riskLabel(i.risk_level)}</div>
        <p style="color:var(--muted);line-height:1.5">${esc(i.summary || '')}</p>
        <div style="font-size:11px;color:var(--muted)">Powered by the ${esc(i.provider)} engine · updated ${new Date(i.generated_at).toLocaleString()}</div>
      </div>
    </div>
    <div class="card"><h3 style="margin-top:0">Why this score</h3>${signalsTable(i.signals || {})}</div>
    <div class="card"><h3 style="margin-top:0">Weak concepts</h3>${weakList(i.weak_topics || [])}</div>
    <h3>Your personalized study plan</h3>${planList(i.study_plan || [])}`);
}

async function studentRewards() {
  const g = await (await api.call('/ai/me/gamification')).json();
  showAdmin(`<h2>🏆 Rewards</h2>
    <div class="card" style="display:flex;gap:26px;flex-wrap:wrap">
      <div style="text-align:center"><div style="font-size:30px;font-weight:800;color:var(--gold)">${g.points}</div><div style="font-size:11px;color:var(--muted)">POINTS</div></div>
      <div style="text-align:center"><div style="font-size:30px;font-weight:800;color:var(--teal)">Lv ${g.level}</div><div style="font-size:11px;color:var(--muted)">LEVEL</div></div>
      <div style="text-align:center"><div style="font-size:30px;font-weight:800;color:#F97316">🔥 ${g.streak_days}</div><div style="font-size:11px;color:var(--muted)">DAY STREAK</div></div>
    </div>
    <div class="card"><h3 style="margin-top:0">Badges</h3>${(g.badges || []).length ? g.badges.map(b => `<span style="display:inline-block;background:var(--panel2);border:1px solid var(--border);border-radius:20px;padding:6px 12px;margin:4px;font-size:12.5px">🏅 ${esc(b.label)}</span>`).join('') : '<span style="color:var(--muted)">No badges yet — keep going!</span>'}</div>
    <div class="card"><h3 style="margin-top:0">Class leaderboard</h3><table><thead><tr><th>#</th><th>Student</th><th>Points</th></tr></thead><tbody>${
      (g.leaderboard || []).map((r, idx) => `<tr><td>${idx + 1}</td><td>${esc(r.name)}</td><td>${r.points}</td></tr>`).join('')
    }</tbody></table></div>`);
}

/* ── Tutor: student insights ──────────────────────────── */
async function tutorInsights() {
  const list = await (await api.call('/ai/students')).json();
  showAdmin(`<h2>📊 Student insights</h2>
    <div class="card"><table><thead><tr><th>Student</th><th>Batch</th><th>Readiness</th><th>Risk</th><th>Weak concepts</th><th></th></tr></thead>
    <tbody>${list.map(s => `<tr><td>${esc(s.name)}</td><td>${esc(s.batch || '')}</td>
      <td><b style="color:${riskColor(s.risk_level)}">${s.readiness_score ?? '—'}${s.readiness_score != null ? '%' : ''}</b></td>
      <td>${s.risk_level ? riskLabel(s.risk_level) : '—'}</td>
      <td style="font-size:12px;color:var(--muted)">${(s.weak_topics || []).slice(0, 3).map(w => esc(w.topic)).join(', ') || '—'}</td>
      <td><button class="btn btn-ghost btn-sm" data-si="${s.id}">Open</button></td></tr>`).join('')}</tbody></table></div>
    <div id="siDetail"></div>`);
  document.querySelectorAll('[data-si]').forEach(b => b.onclick = async () => {
    const d = await (await api.call('/ai/students/' + b.dataset.si)).json();
    const i = d.insight;
    $('#siDetail').innerHTML = `<div class="card"><h3 style="margin-top:0">${esc(d.student.full_name)} — ${esc(d.student.std || '')}</h3>
      <div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap">${gauge(i.readiness_score, i.risk_level)}
      <div style="flex:1;min-width:220px"><div style="font-weight:800;color:${riskColor(i.risk_level)}">${riskLabel(i.risk_level)}</div><p style="color:var(--muted)">${esc(i.summary || '')}</p></div></div>
      <h4>Why this score</h4>${signalsTable(i.signals || {})}
      <h4>Weak concepts</h4>${weakList(i.weak_topics || [])}
      <h4>Suggested plan</h4>${planList(i.study_plan || [])}</div>`;
    $('#siDetail').scrollIntoView({ behavior: 'smooth' });
  });
}

async function tutorCopilot() {
  showAdmin(`<h2>🤖 Tutor Copilot</h2><div class="card" style="color:var(--muted)">Summarizing your students' week…</div>`);
  const c = await (await api.call('/ai/copilot')).json();
  showAdmin(`<h2>🤖 Tutor Copilot</h2>
    <div class="card" style="color:var(--muted)">Week of ${c.weekStart}. Students who need the most help are listed first — you stay in charge, this just tells you where to look.</div>
    ${c.students.map(s => `<div class="card" style="border-left:3px solid ${riskColor(s.detail.risk)}">
      <div style="font-weight:800;font-size:14.5px">${esc(s.headline)}</div>
      <div style="display:flex;gap:20px;flex-wrap:wrap;margin-top:8px;font-size:12.5px;color:var(--muted)">
        <span>Readiness <b style="color:${riskColor(s.detail.risk)}">${s.detail.readiness}%</b></span>
        <span>Attendance ${s.detail.attendance}%</span>
        <span>Study ${s.detail.study_minutes_14d} min / 14d</span>
      </div>
      ${s.detail.weak_topics?.length ? `<div style="margin-top:6px;font-size:12.5px">Focus: ${s.detail.weak_topics.map(w => esc(w.subject + '·' + w.topic + ' ' + w.accuracy + '%')).join(', ')}</div>` : ''}
      ${s.detail.top_action ? `<div style="margin-top:6px;font-size:12.5px;color:var(--teal)">▶ ${esc(s.detail.top_action.action)}</div>` : ''}
    </div>`).join('')}`);
}

/* ── Admin: AI overview ───────────────────────────────── */
async function adminAI() {
  showAdmin(`<h2>🤖 AI overview</h2><div class="card" style="color:var(--muted)">Loading…</div>`);
  const o = await (await api.call('/ai/overview')).json();
  const dist = Object.fromEntries((o.distribution || []).map(d => [d.risk_level, d.c]));
  showAdmin(`<h2>🤖 AI overview</h2>
    <div class="card" style="display:flex;gap:26px;flex-wrap:wrap">
      <div style="text-align:center"><div style="font-size:30px;font-weight:800;color:var(--gold)">${o.avg_readiness ?? '—'}%</div><div style="font-size:11px;color:var(--muted)">AVG READINESS</div></div>
      <div style="text-align:center"><div style="font-size:30px;font-weight:800;color:var(--danger)">${dist.high || 0}</div><div style="font-size:11px;color:var(--muted)">HIGH RISK</div></div>
      <div style="text-align:center"><div style="font-size:30px;font-weight:800;color:#F97316">${dist.medium || 0}</div><div style="font-size:11px;color:var(--muted)">MEDIUM</div></div>
      <div style="text-align:center"><div style="font-size:30px;font-weight:800;color:var(--teal)">${dist.low || 0}</div><div style="font-size:11px;color:var(--muted)">ON TRACK</div></div>
      <button class="btn btn-teal btn-sm" id="ai-run" style="align-self:center">Recompute all</button>
    </div>
    <div class="card"><h3 style="margin-top:0">Students needing attention</h3><table><thead><tr><th>Student</th><th>Batch</th><th>Readiness</th><th>Risk</th></tr></thead>
    <tbody>${(o.at_risk || []).map(s => `<tr><td>${esc(s.name)}</td><td>${esc(s.batch || '')}</td><td><b style="color:${riskColor(s.risk_level)}">${s.readiness_score}%</b></td><td>${riskLabel(s.risk_level)}</td></tr>`).join('') || '<tr><td colspan=4>Everyone on track 🎉</td></tr>'}</tbody></table></div>`);
  $('#ai-run').onclick = async () => { const r = await (await api.call('/ai/run', { method: 'POST' })).json(); toast('🤖 Recomputed', r.recomputed + ' students'); adminAI(); };
}

function showMessages() {
  $('#adminView').classList.add('hidden');
  $('#listPane').classList.remove('hidden');
  $('#chatPane').classList.remove('hidden');
  renderContacts();
}
function showAdmin(html) {
  $('#listPane').classList.add('hidden');
  $('#chatPane').classList.add('hidden');
  const v = $('#adminView'); v.classList.remove('hidden'); v.innerHTML = html;
}

/* ── Contacts & conversations ─────────────────────────── */
async function loadContacts() {
  contacts = await (await api.call('/messages/contacts')).json();
  renderContacts();
}
$('#search').addEventListener('input', renderContacts);
function renderContacts() {
  const q = $('#search').value.toLowerCase();
  const box = $('#convs'); box.innerHTML = '';
  const list = contacts.filter(c => c.name.toLowerCase().includes(q));
  if (!list.length) { box.innerHTML = '<div class="empty" style="height:auto;padding:30px">No contacts yet.</div>'; return; }
  const label = document.createElement('div'); label.className = 'seclabel';
  label.textContent = api.user.role === 'student' ? 'Your tutors' : api.user.role === 'tutor' ? 'Your students & admin' : 'Everyone';
  box.appendChild(label);
  list.forEach(c => {
    const el = document.createElement('div'); el.className = 'conv';
    el.innerHTML = `<div class="avatar" style="background:${colorFor(c.id)}">${initials(c.name)}</div>
      <div style="min-width:0;flex:1"><div class="nm">${esc(c.name)} <span class="tag">PRIVATE</span></div>
      <div class="pre">${esc(c.subject || c.std || c.role)}</div></div>`;
    el.onclick = () => openChat(c, el);
    box.appendChild(el);
  });
}

async function openChat(peer, el) {
  [...$('#convs').children].forEach(c => c.classList?.remove('active')); el?.classList.add('active');
  current = peer;
  $('#chatEmpty').classList.add('hidden'); $('#chatActive').classList.remove('hidden');
  $('#peerName').textContent = peer.name;
  $('#peerSub').textContent = peer.subject || peer.std || peer.role;
  $('#peerAv').textContent = initials(peer.name); $('#peerAv').style.background = colorFor(peer.id);
  const conv = await (await api.call('/messages/dm/' + peer.id, { method: 'POST' })).json();
  current.convId = conv.id;
  socket.emit('conv:join', conv.id, () => {});
  const msgs = await (await api.call('/messages/conversations/' + conv.id + '/messages')).json();
  $('#msgs').innerHTML = ''; msgs.forEach(addMsg); scrollMsgs();
}

function addMsg(m) {
  const mine = m.sender_id === api.user.id;
  const el = document.createElement('div');
  el.className = 'msg ' + (m.kind === 'system' ? 'system' : mine ? 'mine' : 'theirs');
  el.innerHTML = m.kind === 'system' ? esc(m.body)
    : `${esc(m.body)}<div class="meta">${mine ? 'You' : esc(m.sender_name || '')} · ${new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>`;
  $('#msgs').appendChild(el);
}
const scrollMsgs = () => { const m = $('#msgs'); m.scrollTop = m.scrollHeight; };

$('#send').addEventListener('click', sendMsg);
$('#input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); } });
function sendMsg() {
  const body = $('#input').value.trim(); if (!body || !current) return;
  $('#input').value = '';
  socket.emit('message:send', { peerId: current.id, conversationId: current.convId, body }, (res) => {
    if (res?.error) toast('⚠️ Not sent', res.error);
  });
}

/* ── Calls ────────────────────────────────────────────── */
$('#btnAudio').addEventListener('click', () => startCall('audio'));
$('#btnVideo').addEventListener('click', () => startCall('video'));
function startCall(kind) {
  if (!current) return;
  socket.emit('call:ring', { peerId: current.id, kind }, (res) => {
    if (res?.error) { toast('⚠️ Cannot call', res.error); return; }
    state.activeCallId = res.callId;
    toast('📞 Calling…', current.name + ' is being alerted');
    // Caller opens the Jitsi room after starting the ring.
    joinMeeting(current.id, kind, true);
  });
}
$('#callAccept').addEventListener('click', async () => {
  const c = state.incoming; if (!c) return;
  socket.emit('call:accept', { callId: c.callId }, () => {});
  hideIncoming();
  joinMeeting(c.from.id, c.kind, false);
});
$('#callDecline').addEventListener('click', () => {
  const c = state.incoming; if (!c) return;
  socket.emit('call:decline', { callId: c.callId }, () => {});
  hideIncoming();
});
function showIncoming(c) {
  state.incoming = c;
  $('#callAv').textContent = initials(c.from.name); $('#callAv').style.background = colorFor(c.from.id);
  $('#callName').textContent = c.from.name;
  $('#callInfo').textContent = `Incoming ${c.kind} call`;
  $('#callModal').classList.remove('hidden');
}
function hideIncoming() { $('#callModal').classList.add('hidden'); state.incoming = null; }

// Load Jitsi external_api.js lazily from the meeting response's domain.
let jitsiApiLoaded = null;
function loadJitsi(domain) {
  if (jitsiApiLoaded) return jitsiApiLoaded;
  jitsiApiLoaded = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://${domain}/external_api.js`; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
  return jitsiApiLoaded;
}
let jitsi = null;
async function joinMeeting(peerId, kind, isCaller) {
  const meet = await (await api.call('/meetings/dm/' + peerId, { method: 'POST', body: JSON.stringify({ kind }) })).json();
  if (meet.error) { toast('⚠️ Meeting failed', meet.error); return; }
  try { await loadJitsi(meet.domain); } catch { toast('⚠️ Jitsi unreachable', 'Check JITSI_DOMAIN'); return; }
  $('#jitsiOverlay').classList.remove('hidden');
  $('#jitsi').innerHTML = '';
  jitsi = new window.JitsiMeetExternalAPI(meet.domain, {
    roomName: meet.room, parentNode: $('#jitsi'), jwt: meet.token,
    configOverwrite: { startWithVideoMuted: kind === 'audio', prejoinPageEnabled: false },
    userInfo: { displayName: api.user.name },
  });
  jitsi.addEventListener('readyToClose', endMeeting);
}
$('#endCall').addEventListener('click', endMeeting);
function endMeeting() {
  if (state.activeCallId) socket.emit('call:hangup', { callId: state.activeCallId }, () => {});
  state.activeCallId = null;
  if (jitsi) { try { jitsi.dispose(); } catch {} jitsi = null; }
  $('#jitsiOverlay').classList.add('hidden');
}

/* ── Socket.IO ────────────────────────────────────────── */
function connectSocket() {
  socket = io({ auth: { token: api.token } });
  socket.on('message', (m) => {
    if (current && m.conversation_id === current.convId) { addMsg(m); scrollMsgs(); }
  });
  socket.on('call:incoming', (c) => { if (!dnd) showIncoming(c); });
  socket.on('call:accepted', () => toast('✅ Answered', 'Connecting…'));
  socket.on('call:declined', () => { toast('🚫 Declined', current?.name + ' declined'); endMeeting(); });
  socket.on('call:cancelled', () => hideIncoming());
  socket.on('call:ended', () => endMeeting());
  socket.on('call:timeout', () => { toast('📵 No answer', 'Call not answered'); endMeeting(); });
  socket.on('notification', (n) => {
    refreshBadge();
    if (n.type === 'incoming_call' && dnd) return;
    if (n.type !== 'message' || !(current && n.data?.conversationId === current.convId))
      toast(iconFor(n.type) + ' ' + n.title, n.body || '');
  });
  // Admin live monitoring (no intrusive ring)
  socket.on('call:active', (c) => { if (api.user.role === 'admin') console.info('[monitor] active call', c); });
}
const iconFor = t => ({ message: '💬', incoming_call: '📞', missed_call: '📵', assignment: '📝', meeting_reminder: '⏰', announcement: '📢' }[t] || '🔔');

async function refreshBadge() {
  const d = await (await api.call('/notifications/unread-count')).json();
  const b = $('#badge'); if (d.count > 0) { b.textContent = d.count; b.classList.remove('hidden'); } else b.classList.add('hidden');
}
$('#bell').addEventListener('click', async () => {
  const list = await (await api.call('/notifications')).json();
  await api.call('/notifications/read-all', { method: 'POST' }); refreshBadge();
  showAdmin(`<h2>🔔 Notifications</h2><div class="card">${
    list.length ? list.map(n => `<div style="padding:10px 0;border-bottom:1px solid var(--border)"><b>${iconFor(n.type)} ${esc(n.title)}</b><div style="color:var(--muted);font-size:12.5px">${esc(n.body || '')} · ${new Date(n.created_at).toLocaleString()}</div></div>`).join('') : 'No notifications.'
  }</div>`);
});

/* ── Toast ────────────────────────────────────────────── */
let toastT;
function toast(t, b) { $('#toastT').textContent = t; $('#toastB').textContent = b || ''; const el = $('#toast'); el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 4000); }

/* ── Admin views ──────────────────────────────────────── */
async function adminUsers() {
  const users = await (await api.call('/admin/users')).json();
  showAdmin(`<h2>👥 Users</h2>
    <div class="card"><h3 style="margin-top:0">Add tutor or student</h3>
      <div class="formgrid">
        <select id="nu-role"><option value="student">Student</option><option value="tutor">Tutor</option></select>
        <input id="nu-name" placeholder="Full name">
        <input id="nu-username" placeholder="Username (login)">
        <input id="nu-password" placeholder="Password (min 8)" type="text">
        <input id="nu-subject" placeholder="Subject (tutor)">
        <input id="nu-std" placeholder="Class (student)">
        <input id="nu-batch" placeholder="Batch e.g. B-10A">
      </div>
      <button class="btn btn-teal btn-sm" id="nu-add">Create user</button>
    </div>
    <div class="card"><table><thead><tr><th>Name</th><th>Role</th><th>Username</th><th>Batch</th><th></th></tr></thead>
      <tbody>${users.map(u => `<tr><td>${esc(u.name)}</td><td>${u.role}</td><td>${esc(u.username || '')}</td><td>${esc(u.batch || '')}</td>
        <td class="row-actions"><button class="btn btn-danger btn-sm" data-del="${u.id}">Deactivate</button></td></tr>`).join('')}</tbody></table></div>`);
  $('#nu-add').onclick = async () => {
    const body = { role: $('#nu-role').value, full_name: $('#nu-name').value, username: $('#nu-username').value,
      password: $('#nu-password').value, subject: $('#nu-subject').value || null, std: $('#nu-std').value || null, batch: $('#nu-batch').value || null };
    const r = await api.call('/admin/users', { method: 'POST', body: JSON.stringify(body) });
    if (r.ok) { toast('✅ Created', body.full_name); adminUsers(); } else toast('⚠️ Failed', (await r.json()).error);
  };
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    await api.call('/admin/users/' + b.dataset.del, { method: 'DELETE' }); toast('User deactivated', ''); adminUsers();
  });
}

async function adminMappings() {
  const [users, maps] = await Promise.all([
    (await api.call('/admin/users')).json(), (await api.call('/admin/mappings')).json()]);
  const tutors = users.filter(u => u.role === 'tutor'), students = users.filter(u => u.role === 'student');
  showAdmin(`<h2>🔗 Assign tutor ⇄ student</h2>
    <div class="card"><div class="formgrid">
      <select id="m-tutor">${tutors.map(t => `<option value="${t.id}">${esc(t.name)} (${esc(t.subject || '')})</option>`).join('')}</select>
      <select id="m-student">${students.map(s => `<option value="${s.id}">${esc(s.name)} (${esc(s.batch || '')})</option>`).join('')}</select>
      <button class="btn btn-teal btn-sm" id="m-add">Assign</button>
    </div></div>
    <div class="card"><table><thead><tr><th>Tutor</th><th>Student</th><th>Batch</th><th>Assigned</th><th></th></tr></thead>
      <tbody>${maps.map(m => `<tr><td>${esc(m.tutor_name)}</td><td>${esc(m.student_name)}</td><td>${esc(m.batch || '')}</td>
        <td>${new Date(m.created_at).toLocaleDateString()}</td>
        <td><button class="btn btn-danger btn-sm" data-unmap="${m.id}">Remove</button></td></tr>`).join('')}</tbody></table></div>`);
  $('#m-add').onclick = async () => {
    const r = await api.call('/admin/mappings', { method: 'POST', body: JSON.stringify({ tutor_id: $('#m-tutor').value, student_id: $('#m-student').value }) });
    if (r.ok) { toast('✅ Assigned', 'They can now message & call'); adminMappings(); } else toast('⚠️ Failed', (await r.json()).error);
  };
  document.querySelectorAll('[data-unmap]').forEach(b => b.onclick = async () => {
    await api.call('/admin/mappings/' + b.dataset.unmap, { method: 'DELETE' }); toast('Mapping removed', ''); adminMappings();
  });
}

async function adminMonitor() {
  const convs = await (await api.call('/admin/conversations')).json();
  showAdmin(`<h2>🛡️ Monitor conversations</h2>
    <div class="card"><table><thead><tr><th>Participants</th><th>Type</th><th>Messages</th><th>Last</th><th></th></tr></thead>
    <tbody>${convs.map(c => `<tr><td>${esc(c.member_a_name || '')} ${c.member_b_name ? '⇄ ' + esc(c.member_b_name) : (c.batch ? 'Batch ' + esc(c.batch) : '')}</td>
      <td>${c.kind}</td><td>${c.msg_count}</td><td>${c.last_at ? new Date(c.last_at).toLocaleString() : '—'}</td>
      <td class="row-actions"><button class="btn btn-ghost btn-sm" data-view="${c.id}">View</button>
      <a class="btn btn-ghost btn-sm" href="/api/admin/conversations/${c.id}/export?format=csv" target="_blank" onclick="event.stopPropagation()">Export</a></td></tr>`).join('')}</tbody></table></div>
    <div class="card hidden" id="monMsgs"></div>`);
  document.querySelectorAll('[data-view]').forEach(b => b.onclick = async () => {
    const msgs = await (await api.call('/admin/conversations/' + b.dataset.view + '/messages')).json();
    const box = $('#monMsgs'); box.classList.remove('hidden');
    box.innerHTML = `<h3 style="margin-top:0">Transcript</h3>${msgs.map(m => `<div style="padding:6px 0"><b>${esc(m.sender_name)}</b> <span style="color:var(--muted);font-size:11px">(${m.sender_role}) ${new Date(m.created_at).toLocaleString()}</span><br>${esc(m.body || '')}</div>`).join('') || 'No messages.'}`;
    box.scrollIntoView({ behavior: 'smooth' });
  });
  // Note the export link needs auth; browsers send no header on <a>. Use fetch+blob instead:
  document.querySelectorAll('a[href*="/export"]').forEach(a => a.onclick = async (e) => {
    e.preventDefault(); e.stopPropagation();
    const r = await api.call(a.getAttribute('href').replace('/api', ''));
    const blob = await r.blob(); const url = URL.createObjectURL(blob);
    const dl = document.createElement('a'); dl.href = url; dl.download = 'chat.csv'; dl.click(); URL.revokeObjectURL(url);
  });
}

async function adminCalls() {
  const calls = await (await api.call('/admin/calls')).json();
  showAdmin(`<h2>📞 Call history</h2><div class="card"><table>
    <thead><tr><th>Caller</th><th>Callee</th><th>Type</th><th>Outcome</th><th>Duration</th><th>When</th></tr></thead>
    <tbody>${calls.map(c => `<tr><td>${esc(c.caller_name)}</td><td>${esc(c.callee_name)}</td><td>${c.kind}</td>
      <td>${outcomeBadge(c.outcome)}</td><td>${c.duration_secs ? c.duration_secs + 's' : '—'}</td>
      <td>${new Date(c.rang_at).toLocaleString()}</td></tr>`).join('') || '<tr><td colspan=6>No calls yet.</td></tr>'}</tbody></table></div>`);
}
const outcomeBadge = o => ({ answered: '✅ Answered', declined: '🚫 Declined', missed: '📵 Missed', cancelled: '↩️ Cancelled' }[o] || o);

async function adminMeetings() {
  const mts = await (await api.call('/admin/meetings')).json();
  showAdmin(`<h2>🎥 Meeting history</h2><div class="card"><table>
    <thead><tr><th>Started by</th><th>Type</th><th>Participants</th><th>Started</th><th>Duration</th></tr></thead>
    <tbody>${mts.map(m => `<tr><td>${esc(m.started_by)}</td><td>${m.kind}</td>
      <td>${(m.participants || []).map(p => esc(p.name)).join(', ') || '—'}</td>
      <td>${new Date(m.started_at).toLocaleString()}</td><td>${m.duration_secs ? Math.round(m.duration_secs / 60) + 'm' : '—'}</td></tr>`).join('') || '<tr><td colspan=5>No meetings yet.</td></tr>'}</tbody></table></div>`);
}

async function adminActivity() {
  const logs = await (await api.call('/admin/activity')).json();
  showAdmin(`<h2>📜 Activity &amp; login logs</h2><div class="card"><table>
    <thead><tr><th>User</th><th>Action</th><th>Entity</th><th>When</th></tr></thead>
    <tbody>${logs.map(l => `<tr><td>${esc(l.full_name || 'system')} <span style="color:var(--muted)">${l.role || ''}</span></td>
      <td>${esc(l.action)}</td><td>${esc(l.entity || '')}</td><td>${new Date(l.created_at).toLocaleString()}</td></tr>`).join('')}</tbody></table></div>`);
}

function adminAnnounce() {
  showAdmin(`<h2>📢 Send announcement</h2><div class="card">
    <div class="formgrid">
      <select id="an-aud"><option value="all">Everyone</option><option value="tutors">All tutors</option><option value="students">All students</option><option value="batch">A batch</option></select>
      <input id="an-batch" placeholder="Batch (if selected)">
    </div>
    <input id="an-title" placeholder="Title" style="width:100%;padding:9px 11px;border-radius:9px;border:1px solid var(--border);background:var(--panel2);color:var(--text);margin-bottom:8px">
    <textarea id="an-body" placeholder="Message" style="width:100%;height:80px;padding:9px 11px;border-radius:9px;border:1px solid var(--border);background:var(--panel2);color:var(--text)"></textarea>
    <div style="margin-top:10px"><button class="btn btn-teal btn-sm" id="an-send">Send</button></div>
  </div>`);
  $('#an-send').onclick = async () => {
    const body = { audience: $('#an-aud').value, batch: $('#an-batch').value || undefined, title: $('#an-title').value, body: $('#an-body').value };
    const r = await api.call('/admin/announce', { method: 'POST', body: JSON.stringify(body) });
    if (r.ok) { const d = await r.json(); toast('📢 Sent', `Delivered to ${d.sent} people`); } else toast('⚠️ Failed', (await r.json()).error);
  };
}

/* ── Init ─────────────────────────────────────────────── */
load();
if (api.token) { api.call('/auth/me').then(async r => { if (r.ok) { api.user = (await r.json()).user; save(); start(); } else logout(); }); }
