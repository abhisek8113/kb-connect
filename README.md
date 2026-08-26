# Kongu Brilliance Connect

Secure, in-portal chat, video and notifications for a tuition management system —
built so that **no phone numbers are ever exposed** and **no communication happens
outside the portal**. Roles: **admin**, **tutor**, **student**. Video runs on
**Jitsi Meet**; real-time messaging and Teams-style call alerts run on **Socket.IO**.

The permission model is enforced **server-side** on every request and every socket
event — the browser is never trusted.

## What it does

- **Admin** — full CRUD over tutors and students, assigns tutor⇄student mappings,
  monitors (read-only) every conversation, exports chat logs (CSV/JSON), views
  meeting history (participants, timestamps, duration), call history
  (answered/declined/missed), and activity/login logs, and sends announcements.
  Admin can join any active meeting to monitor **without ringing anyone**.
- **Tutor** — sees and communicates with **only their assigned students** (plus
  admin). Starts calls, chats, shares files, records attendance. A DND toggle
  silences incoming-call alerts.
- **Student** — sees and communicates with **only their assigned tutor(s)** (plus
  admin). Never sees other students.
- **Real-time, role-aware alerts** — when a tutor calls, only the assigned student
  is alerted (accept/decline). When a student calls, only their assigned tutor is.
  Missed calls are logged; new messages, assignments and meeting reminders raise
  notifications. No notification ever contains personal contact info.
- **AI teaching assistant** (free/open-source by default, modular provider) —
  analyzes mocks, assignments, attendance, study time and mistakes to detect
  weak concepts and silly mistakes, generate personalized study plans, an
  explainable **exam-readiness score**, gamification, and a **Tutor Copilot**
  weekly brief telling each tutor exactly who needs what. Runs in the background;
  tutors see only their students. See [`docs/AI.md`](docs/AI.md).

## Quick start (local)

```bash
# 1. Postgres (any instance). With docker:
docker run -d --name kbpg -e POSTGRES_USER=kb -e POSTGRES_PASSWORD=kb \
  -e POSTGRES_DB=kbconnect -p 5432:5432 postgres:16-alpine

cd server
cp .env.example .env          # then edit secrets
npm install
npm run migrate               # apply schema (core + AI)
npm run seed                  # demo users (change passwords!)
npm run seed:ai               # demo performance data + first AI run
npm start                     # http://localhost:4000
```

Open http://localhost:4000 and sign in with a seeded account:

| Role    | Username | Password       |
|---------|----------|----------------|
| Admin   | `admin`  | `Admin@12345`  |
| Tutor   | `priya`  | `Tutor@12345`  |
| Student | `arjun`  | `Student@123`  |

> Delete/rotate these before any real deployment.

## Run the tests

```bash
cd server
npm start &            # in one shell
npm run smoke          # REST: auth, RBAC privacy, monitoring, no-phone
node test/socket.js    # real-time: call signalling privacy, missed calls, chat
node test/ai.js        # AI: weak-concept detection, readiness, copilot, RBAC
```

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components, data model, flows
- [`docs/API.md`](docs/API.md) — every REST endpoint + socket event
- [`docs/SECURITY.md`](docs/SECURITY.md) — the security model and checklist
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — production + self-hosted Jitsi

## Layout

```
server/   Node + Express + Socket.IO API, Postgres schema, tests
web/      Static front-end (login + admin/tutor/student portals)
docs/     Architecture, API, security, deployment
```
