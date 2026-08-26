# API reference

Base URL: `/api`. All authenticated requests send `Authorization: Bearer <access>`.
Responses are JSON. Permission failures return `403`; unauthenticated `401`.

## Auth

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/login` | `{username,password}` | → `{access, refresh, user}`. Rate-limited. |
| POST | `/auth/refresh` | `{refresh}` | Rotates refresh, returns new `{access, refresh}`. |
| POST | `/auth/logout` | `{refresh?}` | Revokes the refresh token. |
| GET | `/auth/me` | — | Current user (no phone/email). |

## Messages (all roles)

| Method | Path | Notes |
|---|---|---|
| GET | `/messages/contacts` | Privacy-filtered peers (`peersOf`). No phone/email. |
| GET | `/messages/conversations` | Conversations the caller may see. |
| POST | `/messages/dm/:peerId` | Open/create a DM. **403** if not permitted. |
| GET | `/messages/conversations/:id/messages` | Messages, if the caller may access it. |
| POST | `/messages/conversations/:id/messages` | REST fallback send (same checks). Admin is monitor-only in DMs they aren't part of. |

Real-time equivalents run over Socket.IO (below).

## Meetings (all roles)

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/meetings/dm/:peerId` | `{kind:'audio'|'video'}` | → `{room, domain, token}`. **403** if not permitted. |
| POST | `/meetings/batch/:batch` | `{kind}` | Batch/class room; tutor-of-batch or admin. |
| POST | `/meetings/monitor/:meetingId` | — | **Admin only**: join to observe; no ring. |

## Notifications (all roles)

| Method | Path | Notes |
|---|---|---|
| GET | `/notifications` | Latest 100 for the caller. |
| GET | `/notifications/unread-count` | `{count}`. |
| POST | `/notifications/:id/read` · `/notifications/read-all` | Mark read. |
| GET/PUT | `/notifications/prefs` | `{dnd, mute_messages}` — DND silences call alerts. |

## Admin (role = admin only)

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/admin/users` | List / create tutor or student. |
| PATCH/DELETE | `/admin/users/:id` | Update / deactivate (revokes tokens). |
| GET | `/admin/mappings` | All tutor⇄student assignments. |
| POST | `/admin/mappings` | `{tutor_id, student_id}` — grants comms. |
| DELETE | `/admin/mappings/:id` | Revokes comms immediately. |
| GET | `/admin/conversations` | All conversations (monitoring). |
| GET | `/admin/conversations/:id/messages` | Full transcript. |
| GET | `/admin/conversations/:id/export?format=csv\|json` | Export chat log. |
| GET | `/admin/meetings` | Meeting history w/ participants + duration. |
| GET | `/admin/calls` | Call history (answered/declined/missed/cancelled). |
| GET | `/admin/activity?action=` | Activity & login logs. |
| POST | `/admin/announce` | `{audience, batch?, user_id?, title, body}`. |

## Socket.IO events

Handshake: `io(url, { auth: { token: <access> } })`. Rejected if invalid/inactive.

**Client → server** (each takes an ack callback `(res)=>…`):

| Event | Payload | Server checks |
|---|---|---|
| `conv:join` | `conversationId` | `canAccessConversation` |
| `message:send` | `{peerId?, conversationId?, body}` | comms/access; admin monitor-only |
| `call:ring` | `{peerId, kind}` | `canCommunicate`; alerts only the peer |
| `call:accept` / `call:decline` | `{callId}` | must be the callee |
| `call:cancel` | `{callId}` | must be the caller |
| `call:hangup` | `{callId}` | must be a participant; records duration |

**Server → client**:

| Event | Sent to | Meaning |
|---|---|---|
| `message` | conversation room | new message |
| `notification` | recipient | any in-app notification |
| `call:incoming` | **assigned peer only** | ring (unless DND) |
| `call:active` | admins | a call started (silent monitor) |
| `call:accepted` / `declined` / `cancelled` / `ended` / `timeout` | the other party | call state |
| `call:update` | admins | monitor updates (outcome, duration) |
| `presence` | admins | user online/offline |
