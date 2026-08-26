# Architecture

## Components

```
                         ┌─────────────────────────────┐
   Browser (portal)      │   Node app (Express + IO)    │
 ┌──────────────────┐    │                             │        ┌────────────┐
 │ login → role SPA │◀──▶│  REST API  ─────────────────┼──────▶ │ PostgreSQL │
 │ chat / calls     │ WS │  Socket.IO (chat + signals) │        └────────────┘
 │ incoming-call UI │◀──▶│  RBAC (server-side)         │
 └────────┬─────────┘    │  Jitsi JWT minting          │
          │ media        └──────────────┬──────────────┘
          ▼                             │ issues room-scoped JWT
   ┌──────────────┐                     ▼
   │  Jitsi Meet  │◀──────── joins room (audio/video), no PII
   └──────────────┘
```

- **Front-end** (`web/`) — a small static SPA. It renders only what the API
  returns; it holds no permission logic of its own. Media (audio/video) flows
  browser→Jitsi directly; the app server only mints a room-scoped token.
- **App server** (`server/`) — Express REST + Socket.IO on one HTTP server. It
  owns identity, permissions, chat persistence, call signalling and Jitsi JWTs.
- **PostgreSQL** — users, the tutor⇄student mapping graph, conversations,
  messages, meetings, call logs, notifications, and audit logs.
- **Jitsi Meet** — self-hosted video. Rooms are opaque hashes; access requires a
  JWT the app mints only for permitted participants.

## The authorization graph

The single source of truth for "who may talk to whom" is the **`mappings`**
table (tutor_id, student_id), which only admin can change. Every permission
decision joins it:

- `canCommunicate(user, other)` — may these two hold a 1:1 chat or call?
  - admin ↔ anyone: yes
  - tutor ↔ student: only if mapped
  - student ↔ tutor: only if mapped
  - anyone ↔ admin: yes
  - student ↔ student, tutor ↔ tutor: **never**
- `canAccessConversation(user, conv)` — admin: always (monitoring); members:
  their own DMs; batch channels: the student in that batch or a tutor teaching a
  mapped student in it.
- `peersOf(user)` — the privacy-filtered contact list the client is allowed to
  see. This is why a student's UI can only ever render their own tutor.

Because these run on every request, **revoking a mapping instantly cuts off chat
and calls** — no cached client state can bypass it.

## Data model (tables)

`users` · `refresh_tokens` · `mappings` · `conversations` · `messages` ·
`meetings` · `meeting_participants` · `call_logs` · `notifications` ·
`notification_prefs` · `activity_logs` · `assignments` · `attendance`.

Phone numbers live only in `users.phone`, are readable **only** by admin
endpoints, and are never selected into any peer-facing query, chat/meeting
payload, token, or notification. See `util/http.js#publicUser`.

## Key flows

### Login
`POST /auth/login` → bcrypt verify → issue short-lived **access JWT** + opaque
**refresh token** (only its SHA-256 is stored). Access tokens are stateless;
refresh tokens rotate on every use and can be revoked (logout, deactivate).

### Sending a message
Client emits `message:send` → server re-checks `canAccessConversation` →
persists → emits `message` to everyone in `conv:<id>` → creates `notification`
rows for offline/other recipients (respecting mute prefs).

### Placing a call (Teams-style)
Caller emits `call:ring {peerId}` → server checks `canCommunicate` → writes a
`call_logs` row (`outcome='missed'`) → emits `call:incoming` **only to the
assigned peer's** personal room → emits `call:active` to admins (silent monitor)
→ starts a 35s missed-call timer. Callee `call:accept`/`call:decline`; caller
`call:cancel`; either `call:hangup` (records duration). DND suppresses the ring
but the missed-call is still logged.

### Joining video
`POST /meetings/dm/:peerId` → permission check → deterministic opaque room name →
room-scoped Jitsi JWT (tutor/admin = moderator). Client loads
`https://<jitsi>/external_api.js` and joins. No names-as-rooms, no phone numbers.
