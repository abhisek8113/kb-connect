# Deployment

Two pieces deploy separately: **the app** (Node + Postgres) and **Jitsi Meet**
(video). Keeping them separate lets video scale on its own box.

## 1. App + database (docker-compose)

```bash
# from repo root
export JWT_ACCESS_SECRET=$(openssl rand -hex 48)
export JWT_REFRESH_SECRET=$(openssl rand -hex 48)
export JITSI_APP_SECRET=$(openssl rand -hex 48)
export JITSI_DOMAIN=meet.kongubrilliance.com
export CORS_ORIGINS=https://connect.kongubrilliance.com
export DB_PASSWORD=$(openssl rand -hex 16)

docker compose up -d --build
# migrate + seed run automatically on first boot (see compose `command`)
```

Put **nginx or Caddy** in front for TLS and to proxy both HTTP and WebSocket:

```nginx
server {
  server_name connect.kongubrilliance.com;
  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # WebSocket
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
# add TLS with certbot / Caddy auto-HTTPS
```

## 2. Self-hosted Jitsi Meet with JWT auth

Use the official `docker-jitsi-meet`:

```bash
git clone https://github.com/jitsi/docker-jitsi-meet && cd docker-jitsi-meet
cp env.example .env && ./gen-passwords.sh
```

In `.env` enable token auth so **only app-issued JWTs may join** (this is what
keeps rooms private and phone-free — no PSTN dial-in):

```
ENABLE_AUTH=1
AUTH_TYPE=jwt
JWT_APP_ID=kbconnect                 # must equal server JITSI_APP_ID
JWT_APP_SECRET=<same as JITSI_APP_SECRET>
ENABLE_GUESTS=0
```

Then `docker compose up -d`, point `meet.kongubrilliance.com` at it with TLS, and
set the app's `JITSI_DOMAIN` to that host. Disable/omit Jigasi (SIP/telephony) so
there is no dial-in path and therefore no phone number anywhere.

## 3. Scaling notes
- The app is stateless except for the in-memory `online`/presence map. To run
  more than one app instance, add the Socket.IO **Redis adapter** so rooms and
  presence span instances.
- Postgres: enable connection pooling (pgbouncer) beyond a few hundred users.
- Jitsi scales by adding videobridges (JVB) behind the same Prosody.

## 4. Backups & ops
- `pg_dump` on a schedule; keep `activity_logs` and `call_logs` for audit.
- Health check: `GET /api/health`.
- Logs go to stdout — ship with your platform's log driver.

## 5. Migrating from the current static site
Your existing `index.html` marketing site stays as-is. Link its "Login" buttons
to `https://connect.kongubrilliance.com`. Import existing students/tutors by
inserting into `users` + `mappings` (or via the admin UI). No phone numbers are
required for accounts — usernames are the login id.
