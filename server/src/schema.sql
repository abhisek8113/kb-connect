-- ============================================================================
-- Kongu Brilliance Connect — PostgreSQL schema
-- Privacy model is enforced in the APPLICATION (server-side RBAC) AND mirrored
-- here with foreign keys + a mapping table that is the single source of truth
-- for "who may talk to whom". No phone numbers are ever sent to the client:
-- the `phone` column exists for admin records only and is never selected into
-- any tutor/student-facing query or any chat/meeting payload.
-- ============================================================================

create extension if not exists "pgcrypto";      -- gen_random_uuid()

-- ── Identity ────────────────────────────────────────────────────────────────
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  role          text not null check (role in ('admin','tutor','student')),
  full_name     text not null,
  username      text not null unique,           -- login id (never a phone number)
  email         text unique,
  phone         text,                           -- admin-only PII, never exposed to peers
  password_hash text not null,
  -- tutor fields
  subject       text,
  -- student fields
  std           text,                            -- class / standard
  board         text,
  batch         text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_users_role on users(role);
create index if not exists idx_users_batch on users(batch);

-- Refresh-token store (rotation + revocation). Access tokens stay stateless.
create table if not exists refresh_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  text not null,                    -- sha256 of the token, never the raw token
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_refresh_user on refresh_tokens(user_id);

-- ── The authorisation graph: tutor ⇄ student mappings ───────────────────────
-- This table is the ONLY thing that grants chat/call rights between a tutor and
-- a student. Admin CRUDs it. Every messaging/meeting permission check joins it.
create table if not exists mappings (
  id          uuid primary key default gen_random_uuid(),
  tutor_id    uuid not null references users(id) on delete cascade,
  student_id  uuid not null references users(id) on delete cascade,
  assigned_by uuid references users(id),        -- admin who created it
  created_at  timestamptz not null default now(),
  unique (tutor_id, student_id)
);
create index if not exists idx_map_tutor on mappings(tutor_id);
create index if not exists idx_map_student on mappings(student_id);

-- ── Conversations & messages ────────────────────────────────────────────────
-- A conversation is either a private DM (exactly two members, tied to a mapping
-- or to admin) or a batch channel. Membership is derived, not free-form.
create table if not exists conversations (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('dm','batch')),
  -- for dm: the canonical member pair (sorted) so a pair maps to one row
  member_a    uuid references users(id) on delete cascade,
  member_b    uuid references users(id) on delete cascade,
  -- for batch:
  batch       text,
  created_at  timestamptz not null default now(),
  unique (member_a, member_b),
  unique (batch)
);

create table if not exists messages (
  id             uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_id      uuid not null references users(id) on delete cascade,
  kind           text not null default 'text' check (kind in ('text','file','system')),
  body           text,
  file_name      text,
  file_size      bigint,
  file_url       text,                          -- object-storage key, not a public URL
  created_at     timestamptz not null default now(),
  read_at        timestamptz
);
create index if not exists idx_msg_conv on messages(conversation_id, created_at);

-- ── Meetings (Jitsi) & call signalling logs ─────────────────────────────────
create table if not exists meetings (
  id            uuid primary key default gen_random_uuid(),
  room          text not null unique,           -- opaque room name, no PII
  kind          text not null default 'video' check (kind in ('audio','video')),
  started_by    uuid not null references users(id),
  conversation_id uuid references conversations(id) on delete set null,
  batch         text,                            -- for class meetings
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  duration_secs integer
);
create index if not exists idx_meet_started on meetings(started_at);

create table if not exists meeting_participants (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references meetings(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  joined_at   timestamptz not null default now(),
  left_at     timestamptz,
  unique (meeting_id, user_id)
);

-- Every ring/accept/decline/missed is logged for admin history + missed-call UX.
create table if not exists call_logs (
  id           uuid primary key default gen_random_uuid(),
  caller_id    uuid not null references users(id) on delete cascade,
  callee_id    uuid not null references users(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  kind         text not null default 'video' check (kind in ('audio','video')),
  outcome      text not null check (outcome in ('answered','declined','missed','cancelled')),
  meeting_id   uuid references meetings(id) on delete set null,
  rang_at      timestamptz not null default now(),
  answered_at  timestamptz,
  ended_at     timestamptz,
  duration_secs integer
);
create index if not exists idx_call_caller on call_logs(caller_id, rang_at);
create index if not exists idx_call_callee on call_logs(callee_id, rang_at);

-- ── Notifications (in-app, role-aware) ──────────────────────────────────────
create table if not exists notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,   -- recipient
  type        text not null check (type in
                ('message','incoming_call','missed_call','assignment','meeting_reminder','announcement','system')),
  title       text not null,
  body        text,
  data        jsonb not null default '{}',       -- ids only, never phone/email
  is_read     boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists idx_notif_user on notifications(user_id, is_read, created_at);

-- Per-user notification preferences (DND / mute categories).
create table if not exists notification_prefs (
  user_id       uuid primary key references users(id) on delete cascade,
  dnd           boolean not null default false,   -- silence incoming-call alerts
  mute_messages boolean not null default false,
  updated_at    timestamptz not null default now()
);

-- ── Audit / activity + login logs ───────────────────────────────────────────
create table if not exists activity_logs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references users(id) on delete set null,
  action      text not null,                     -- 'login','logout','assign_mapping', etc.
  entity      text,                              -- affected table/row type
  entity_id   uuid,
  ip          inet,
  user_agent  text,
  meta        jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists idx_activity_user on activity_logs(user_id, created_at);
create index if not exists idx_activity_action on activity_logs(action, created_at);

-- ── Teaching modules (kept minimal; referenced by APIs & notifications) ──────
create table if not exists assignments (
  id          uuid primary key default gen_random_uuid(),
  tutor_id    uuid not null references users(id) on delete cascade,
  title       text not null,
  description text,
  batch       text,
  due_at      timestamptz,
  created_at  timestamptz not null default now()
);

create table if not exists attendance (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null references users(id) on delete cascade,
  tutor_id    uuid not null references users(id) on delete cascade,
  status      text not null check (status in ('present','absent','late')),
  on_date     date not null default current_date,
  created_at  timestamptz not null default now(),
  unique (student_id, on_date)
);
