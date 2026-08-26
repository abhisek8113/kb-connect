-- ============================================================================
-- KB Connect — AI teaching-assistant & analytics schema (extends schema.sql).
-- All raw signals the AI reasons over live here. The AI itself stores its
-- output in `ai_insights` (+ study_plans, exam_readiness). No PII is used by
-- the AI — it reasons over performance data keyed by user id only.
-- ============================================================================

-- Concept / topic catalogue (the vocabulary of "weak concepts").
create table if not exists topics (
  id       uuid primary key default gen_random_uuid(),
  subject  text not null,
  name     text not null,
  unique (subject, name)
);

-- Mock tests and per-student results, with a per-topic breakdown that powers
-- weak-concept detection and silly-mistake analysis.
create table if not exists mock_tests (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  subject     text not null,
  batch       text,
  tutor_id    uuid references users(id) on delete set null,
  max_score   integer not null default 100,
  held_on     date not null default current_date,
  created_at  timestamptz not null default now()
);

create table if not exists mock_results (
  id            uuid primary key default gen_random_uuid(),
  mock_test_id  uuid not null references mock_tests(id) on delete cascade,
  student_id    uuid not null references users(id) on delete cascade,
  score         numeric not null,
  max_score     integer not null,
  created_at    timestamptz not null default now(),
  unique (mock_test_id, student_id)
);

-- Per-topic performance within a mock result. silly_mistakes = questions the
-- student knew but lost marks on (tagged by tutor or auto from review).
create table if not exists mock_topic_scores (
  id             uuid primary key default gen_random_uuid(),
  mock_result_id uuid not null references mock_results(id) on delete cascade,
  topic_id       uuid not null references topics(id) on delete cascade,
  correct        integer not null default 0,
  total          integer not null default 0,
  silly_mistakes integer not null default 0
);
create index if not exists idx_mts_result on mock_topic_scores(mock_result_id);
create index if not exists idx_mts_topic on mock_topic_scores(topic_id);

-- Assignment submissions (assignments table exists in schema.sql).
create table if not exists assignment_submissions (
  id            uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references assignments(id) on delete cascade,
  student_id    uuid not null references users(id) on delete cascade,
  status        text not null default 'submitted' check (status in ('submitted','missed','late')),
  score         numeric,
  max_score     integer default 100,
  submitted_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (assignment_id, student_id)
);

-- Study-time tracking (minutes per subject per day).
create table if not exists study_sessions (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null references users(id) on delete cascade,
  subject     text,
  minutes     integer not null,
  on_date     date not null default current_date,
  created_at  timestamptz not null default now()
);
create index if not exists idx_study_student on study_sessions(student_id, on_date);

-- Structured mistake log (drives "silly mistake" vs "conceptual gap").
create table if not exists mistake_logs (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null references users(id) on delete cascade,
  topic_id    uuid references topics(id) on delete set null,
  kind        text not null check (kind in ('conceptual','silly','calculation','time')),
  note        text,
  on_date     date not null default current_date,
  created_at  timestamptz not null default now()
);
create index if not exists idx_mistake_student on mistake_logs(student_id, on_date);

-- ── AI output ───────────────────────────────────────────────────────────────
-- One current insight row per student (upserted by the engine), plus a history
-- table for trend charts.
create table if not exists ai_insights (
  student_id       uuid primary key references users(id) on delete cascade,
  provider         text not null default 'heuristic',
  readiness_score  numeric not null default 0,      -- 0..100
  risk_level       text not null default 'low' check (risk_level in ('low','medium','high')),
  weak_topics      jsonb not null default '[]',      -- [{topic, subject, accuracy, weight, why}]
  silly_rate       numeric not null default 0,       -- 0..1
  signals          jsonb not null default '{}',      -- component scores + explanations
  summary          text,                             -- human-readable
  study_plan       jsonb not null default '[]',      -- [{topic, action, target, why}]
  generated_at     timestamptz not null default now()
);

create table if not exists ai_insight_history (
  id              uuid primary key default gen_random_uuid(),
  student_id      uuid not null references users(id) on delete cascade,
  readiness_score numeric not null,
  risk_level      text not null,
  generated_at    timestamptz not null default now()
);
create index if not exists idx_aih_student on ai_insight_history(student_id, generated_at);

-- Tutor Copilot weekly summaries (one per student per week).
create table if not exists copilot_summaries (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null references users(id) on delete cascade,
  tutor_id     uuid references users(id) on delete set null,
  week_start   date not null,
  headline     text not null,                        -- "who needs what"
  detail       jsonb not null default '{}',
  generated_at timestamptz not null default now(),
  unique (student_id, week_start)
);

-- ── Gamification ────────────────────────────────────────────────────────────
create table if not exists gamification (
  student_id  uuid primary key references users(id) on delete cascade,
  points      integer not null default 0,
  level       integer not null default 1,
  streak_days integer not null default 0,
  last_active date,
  updated_at  timestamptz not null default now()
);

create table if not exists badges (
  id         uuid primary key default gen_random_uuid(),
  student_id uuid not null references users(id) on delete cascade,
  code       text not null,               -- 'streak_7','centum','comeback','consistent'
  label      text not null,
  earned_at  timestamptz not null default now(),
  unique (student_id, code)
);
