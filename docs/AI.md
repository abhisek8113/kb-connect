# AI teaching-assistant layer

An explainable, **free/open-source-by-default** analytics engine that turns each
student's raw activity into weak-concept detection, personalized study plans,
risk flags, a predictive exam-readiness score, gamification, and a **Tutor
Copilot** weekly brief. It runs **in the background** and is **modular** — swap
in an LLM later without changing any caller.

## Design principles
- **Free by default.** The default `heuristic` provider is pure math + templates
  — no external API, no cost, runs offline. Nothing about the core system
  depends on a paid service.
- **Explainable.** Every score ships with its components, weights, contributions
  and a plain-language reason. No black box; "the human stays in charge."
- **Deterministic numbers.** Even with an LLM provider, the *scores* come from
  the heuristic engine; the LLM only rewrites prose. It can't invent a readiness %.
- **Privacy-preserving.** The AI reasons over performance data keyed by user id.
  No phone/email ever enters a prompt, an insight, or a dashboard.
- **RBAC-respecting.** Tutors' AI views are filtered by the same `mappings`
  table — a tutor only ever sees their assigned students.

## What it analyzes (signals)
Mocks + per-topic accuracy, silly-vs-conceptual mistakes, assignment completion
& timeliness, attendance, and study time (with 2-week trend). See `ai/data.js`.

## What it produces
- **Exam-readiness score (0–100)** — weighted composite:
  mock average 35%, topic mastery 25%, assignments 15%, attendance 10%,
  study consistency 10%, silly-mistake control 5%, nudged by mock trend. Each
  factor's contribution and reason are returned in `signals`.
- **Risk level** — low / medium / high (escalated on low attendance or decline).
- **Weak concepts** — topics under 60% accuracy, ranked by impact, each with why.
- **Personalized study plan** — concrete actions, targets and reasons.
- **Gamification** — points, level, streak, badges, class leaderboard.
- **Tutor Copilot** — per-student weekly headline ("who needs what"), needy first.

## Modular provider
`AI_PROVIDER=heuristic` (default) or `llm`. The LLM provider (`ai/providers/llm.js`)
targets any OpenAI-compatible endpoint — including **free local** ones:

```
AI_PROVIDER=llm
LLM_BASE_URL=http://localhost:11434/v1   # Ollama (llama3), LM Studio, vLLM…
LLM_MODEL=llama3
LLM_API_KEY=                             # blank for local
```

To add a brand-new provider, implement `analyzeStudent(data)` and
`weeklyHeadline(insight, data)`, and register it in `ai/index.js`.

## Running it
- Background: the server recomputes all students every `AI_INTERVAL_MS`
  (default 30 min). For scale, move `runForAll()` to a cron/worker.
- On demand: admin `POST /api/ai/run`; per student `POST /api/ai/students/:id/refresh`.
- Insights are also lazily recomputed when older than 6h on read.

## APIs
See [`API.md`](API.md) → `/api/ai/*`: `me`, `me/gamification`, `me/trend`
(student); `students`, `students/:id`, `copilot` (tutor); `overview`, `run`
(admin). All enforce role + mapping server-side.

## Seed
`npm run seed:ai` loads realistic demo performance data (Arjun weak in
Trigonometry with many silly mistakes; Divya strong; Karan weak in Mechanics)
and runs the engine so dashboards have data immediately.
