# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## First-time setup

```bash
npm install
npm run setup:playwright   # installs Chromium for the Playwright fallback extractor
```

Copy `.env.example` to `.env` (or create `.env` at repo root) with at minimum:

```
OPENAI_API_KEY=...
# OPENAI_MODEL defaults to gpt-4o-mini if unset
```

## Authoritative project rules

Surveyor has two layers:

1. **Core Scanner** — the verification engine (runs, companies, discovery, extraction, matching, job details). Must stay conservative, deterministic after role spec generation, evidence-based, and explicit about uncertainty.
2. **Agent Workflow** — the action/preparation layer built on top: accounts, profile/resume memory, job fit analysis, application packet generation, saved companies/searches, and related future capabilities. This layer must never change scanner truth (it reads scanner evidence; it does not reinterpret `run_companies`/`job_rows` outcomes).

Document authority, most to least specific:

1. The user's current explicit request
2. This `CLAUDE.md` — authoritative for current Core Scanner behavior
3. `operatingContext.md` — authoritative for current Core Scanner behavior
4. Current repository code
5. `agentReadiness.md` — completed scanner readiness context
6. `expansionContext.md` — durable context for the Agent Workflow direction and its boundaries relative to the scanner
7. `roadmap.md`, `decisiondoc.md`, `endtoendlifecycle.md` — original Core Scanner MVP contract
8. `agentExpansionRoadmap.md` — broad future planning reference (not all of it is built yet — check code before assuming a feature is live)

`decisiondoc.md` describes the original narrow MVP (no accounts, no saved profiles). That scope has since been deliberately extended: accounts, profiles, fit analysis, application packets, and saved companies/searches are valid parts of the Agent Workflow layer, not automatic scope violations. Don't cite `decisiondoc.md` alone to justify rejecting an accounts/profile/agent-layer request. Conversely, do not treat any of these as pre-approved — every feature, including ones already implemented, is only extended or modified when the user's current request explicitly calls for it.

Never expand scope beyond what the user explicitly requests (e.g. no continuous monitoring, application tracking, or referral intelligence unless asked). Never let the agent layer weaken scanner boundaries (see `expansionContext.md` for the full scanner boundary list).

For implementation work:

1. Do exactly the requested task.
2. Do not expand scope.
3. Do not refactor outside the task unless required.
4. Do not anticipate future roadmap steps.
5. Keep the app runnable after every change.
6. Prefer the smallest safe change.
7. Before modifying code, identify the relevant files and the current behavior.
8. After modifying code, run the narrowest relevant build or test command.
9. Do not introduce new persisted statuses, enum values, API response shapes, database columns, or user-facing states unless the user's explicit request requires them and they do not violate the scanner contract.

Canonical persisted run statuses:

CREATED
READY
RUNNING
COMPLETED
FAILED_ROLE_SPEC

Canonical persisted company statuses:

PENDING
IN_PROGRESS
MATCHES_FOUND
NO_MATCH_SCAN_COMPLETED
UNVERIFIED
CANCELLED

Never use DONE as a run status. Use COMPLETED.

`FitAnalysisStatus` (`COMPLETED`/`FAILED`) and `ApplicationPacketStatus` (`COMPLETED`/`FAILED`) are separate, local status enums scoped to `job_fit_analyses` and `application_packets` respectively — they are not scanner run/company statuses and must not be confused with the canonical lists above.

## Commands

```bash
# Build all packages (shared → api)
npm run build

# Build web app separately (runs Vite after tsc)
npm run build:web

# Run API server (requires .env at repo root)
npm run start --workspace=apps/api

# Run tests (API — uses vitest)
npm test --workspace=apps/api

# Run tests (web — uses vitest)
npm test --workspace=apps/web

# Run a single test file
npx vitest run apps/api/src/lib/__tests__/roleSpec.test.ts

# Verify SQLite persistence setup
npm run verify:persistence --workspace=apps/api

# Web dev server
npm run dev --workspace=apps/web
```

TypeScript is compiled project-by-project. `npm run build` from the root calls `tsc -b` which respects project references (shared must be built before api/web).

## Architecture

This is an npm workspaces monorepo with three packages:

- **`packages/shared`** — shared TypeScript types and enums (`RoleSpec`, `RunResponse`, `CompanyStatus`, `AtsType`, `ProfileItemType`, `FitAnalysisStatus`, `ApplicationPacketStatus`, etc.) consumed by both api and web.
- **`apps/api`** — Express + better-sqlite3 backend. Runs as a single process: HTTP server + background worker loop.
- **`apps/web`** — React 19 + Vite + react-router-dom frontend.

### API internals

**Worker loop** (`apps/api/src/worker/`): polls SQLite every 500 ms for work. Each tick does:

1. `processRoleSpecInitialization` — calls OpenAI to turn a raw role string into a structured `RoleSpec` (include/exclude title lists + seniority).
2. `tryCompleteRunsForReadyOrRunning` — marks a run COMPLETED when all its companies are finished.
3. `tryClaimNextCompany` — claims one PENDING company, then fires `processClaimedCompany` asynchronously.

**Company pipeline** (`processClaimedCompany.ts`): orchestrates each company through five stages:

1. **Discovery** (`lib/discovery.ts`) — finds the company's careers URL via HTTP + search. Resolves to a `listings_url` (strong surface) or stops with a failure code.
2. **Platform detection** (`lib/platform.ts`) — classifies the ATS (`AtsType`: Greenhouse, Lever, Ashby, SmartRecruiters, or UNKNOWN).
3. **Extraction** (`lib/extraction.ts`) — scrapes job listings using the matched ATS extractor or `GENERIC_HTTP`. Falls back to Playwright when the initial extractor fails and conditions allow.
4. **Matching** (`lib/matching.ts`) — deterministic title matching against the `RoleSpec`.
5. **Finalization** (`lib/finalizeCompany.ts`) — writes final status (`MATCHES_FOUND`, `NO_MATCH_SCAN_COMPLETED`, `UNVERIFIED`, etc.) to SQLite.

Job detail ingestion (`lib/jobDetailIngestion.ts`, wired via `worker/`) fetches full descriptions for matched jobs into `job_details` after matching, independent of company final status — a job detail fetch failure is still durable evidence and must not change the company's final status.

**Ownership guard**: each claimed company gets a `worker_token` UUID. Every ownership sensitive write to a claimed company row checks `status = IN_PROGRESS AND worker_token = ?`. If that check fails, the current company pipeline aborts immediately.

**Tracing** (`lib/trace.ts`) — every stage emits structured events to the `trace_events` table with `event_type`, `message`, and a JSON payload. Used for debugging, not for control flow.

**Database** (`db/schema.ts`) — SQLite stores four kinds of data: durable scanner evidence (runs, companies, job rows, job details, trace events), authentication and ownership data (users, sessions, and the `user_id` that scopes runs to their owner), user-owned context (profile, profile items, resume), and generated agent outputs plus saved targets (job fit analyses, application packets, saved companies, saved searches). Schema is created with `CREATE TABLE IF NOT EXISTS` on startup; `runs.user_id` is added via a guarded `ALTER TABLE` (checked with `PRAGMA table_info`) since SQLite has no `ADD COLUMN IF NOT EXISTS`.

**Auth** (`lib/auth.ts`) — session-cookie auth (scrypt password hashing, opaque session ids in a `sessions` table, `surveyor_session` httpOnly cookie). `requireAuth` middleware rejects with 401 and attaches `req.userId`. Product data routes require authentication and scope reads and writes to the requesting user. Authentication routes manage signup, login, logout, and current session state separately. When the first user signs up, any pre-existing `user_id`-less runs are backfilled to that user in the same transaction (no fake placeholder owner).

### API areas

Routes live in `apps/api/src/routes/`, one file per area: authentication (signup/login/logout/current user), scanner runs (create a run, fetch run detail), job details (stored description or fetch-failure evidence for a matched job), profile and resume memory (profile fields, profile items, resume text), fit analysis (generate/list/get/delete a job fit analysis), application packets (generate/list/get/delete an application packet, optionally from a fit analysis), and saved targets (saved companies, saved searches, and starting a run from a saved search). Product data routes require authentication and scope reads and writes to the requesting user. Authentication routes manage signup, login, logout, and current session state separately.

### Key design constraints

- The worker loop is purely poll-based — no in-memory queue, no pub/sub. All state lives in SQLite.
- `listings_url` is `null` unless the resolver confirmed a strong listings surface (`DIRECT_VERIFIED`, `ATS_RESOLVED`, `CTA_RESOLVED`). Never fall back to `careers_url` as a substitute.
- Extraction only begins when `extractionStartUrl` is non-null. Weak or unresolved surfaces exit early as `UNVERIFIED`.
- Role spec always prepends the raw role string as the first `include_title` (deduplicated).
- Company processing concurrency is capped at 2; company lists are capped at 10 per run — do not change these without an explicit request.
- Once a company is finalized for a run, it is never reprocessed for that run. Restart recovery only resets stale `IN_PROGRESS` rows to `PENDING`; it must not touch final companies.
- The agent layer (fit analysis, application packets) reads durable scanner evidence (`job_details`, `job_rows`) — it does not fetch job descriptions ad hoc and does not reinterpret or alter scanner statuses.
