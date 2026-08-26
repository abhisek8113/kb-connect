# Security model

The design goals, restated as controls: **no phone numbers exposed**, **no
communication outside the portal**, **strict role-based access enforced on the
server**.

## Identity & sessions
- Passwords hashed with **bcrypt** (cost 12, configurable). Never stored or logged in plain.
- **Access token**: short-lived (15 min) stateless JWT. Carries only `sub, role,
  name, batch` — never phone/email.
- **Refresh token**: opaque 48-byte random; only its **SHA-256** is stored, so a
  DB leak can't be replayed. **Rotated** on every refresh; revoked on logout and
  on account deactivation.
- Login errors are generic (no user enumeration). Login endpoint is rate-limited
  (20 / 15 min); the whole API is rate-limited (300 / min).

## Authorization (server-side, always)
- Every REST route and every socket event calls the RBAC helpers in `rbac.js`.
  **The client is never trusted** — hiding a button is UX, not security.
- The `mappings` table is the only thing that grants tutor↔student comms.
  Removing a mapping cuts chat + calls instantly.
- Cross-role leakage is impossible by construction: student↔student and
  tutor↔tutor `canCommunicate` returns false; `peersOf` never returns them.
- Admin is monitor-only in DMs it isn't a member of — it can read/export but
  **cannot inject messages** into a private tutor↔student chat.

## No PII leakage
- `publicUser()` is the only projection sent to non-admin clients; it omits
  `phone`, `email`, `password_hash`.
- Jitsi rooms are SHA-256 hashes, not names; Jitsi JWTs carry a display name
  only. Notifications carry ids/labels, never contact info.
- Calls never reveal a phone number — signalling is by user id over the socket.

## Transport & headers
- `helmet` sets secure headers; run strictly behind **HTTPS/WSS** in production
  (terminate TLS at nginx/Caddy). Set `CORS_ORIGINS` to your exact portal origin.
- `express.json` capped at 1 MB. File uploads (when enabled) should go to object
  storage with signed, expiring URLs — never public links.

## Auditing
- `activity_logs` records logins (success/fail), logouts, user CRUD, mapping
  changes, meeting starts, monitor joins, and chat exports — with actor, ip, ua.
- `call_logs` records every ring and its outcome + duration.

## Production checklist
- [ ] Strong `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JITSI_APP_SECRET`
      (`openssl rand -hex 48`). The server refuses to boot in prod with defaults.
- [ ] `NODE_ENV=production` (hides error details, enforces secret checks).
- [ ] TLS everywhere; HSTS at the proxy.
- [ ] Rotate/replace all seeded demo passwords; delete demo users.
- [ ] Restrict Postgres to the app network; least-privilege DB role.
- [ ] Configure Jitsi with JWT auth (`prosody`), lobby, and no dial-in (no PSTN,
      so no phone numbers can appear).
- [ ] Back up Postgres; set log retention for `activity_logs`.
- [ ] Consider per-account 2FA for admin.
