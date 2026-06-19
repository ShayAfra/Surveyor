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

Surveyor is currently the Core Scanner MVP. Do not add accounts, agents, saved profiles, continuous monitoring, application tracking, referral intelligence, or product expansion features unless explicitly requested.

The authoritative project documents are:

1. roadmap.md
2. decisiondoc.md
3. endtoendlifecycle.md

When these documents conflict with code comments, generated summaries, README text, or this CLAUDE.md file, the authoritative documents win.

For implementation work:

1. Do exactly the requested task.
2. Do not expand scope.
3. Do not refactor outside the task unless required.
4. Do not anticipate future roadmap steps.
5. Keep the app runnable after every change.
6. Prefer the smallest safe change.
7. Before modifying code, identify the relevant files and the current behavior.
8. After modifying code, run the narrowest relevant build or test command.
9. Do not introduce new persisted statuses, enum values, API response shapes, database columns, or user facing states unless the authoritative docs require them.

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

## Commands

```bash
# Build all packages (shared → api)
npm run build

# Build web app separately (runs Vite after tsc)
npm run build:web

# Run API server (requires .env at repo root)
npm run start --workspace=apps/api

# Run tests (API only — uses vitest)
npm test --workspace=apps/api

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

- **`packages/shared`** — shared TypeScript types (`RoleSpec`, `RunResponse`, `CompanyStatus`, `AtsType`, etc.) consumed by both api and web.
- **`apps/api`** — Express + better-sqlite3 backend. Runs as a single process: HTTP server + background worker loop.
- **`apps/web`** — React 19 + Vite + react-router-dom frontend.

### API internals

**Worker loop** (`apps/api/src/worker/`): polls SQLite every 500 ms for work. Each tick does:

1. `processRoleSpecInitialization` — calls OpenAI to turn a raw role string into a structured `RoleSpec` (include/exclude title lists + seniority).
2. `tryCompleteRunsForReadyOrRunning` — marks a run DONE when all its companies are finished.
3. `tryClaimNextCompany` — claims one PENDING company, then fires `processClaimedCompany` asynchronously.

**Company pipeline** (`processClaimedCompany.ts`): orchestrates each company through five stages:

1. **Discovery** (`lib/discovery.ts`) — finds the company's careers URL via HTTP + search. Resolves to a `listings_url` (strong surface) or stops with a failure code.
2. **Platform detection** (`lib/platform.ts`) — classifies the ATS (`AtsType`: Greenhouse, Lever, Ashby, SmartRecruiters, or UNKNOWN).
3. **Extraction** (`lib/extraction.ts`) — scrapes job listings using the matched ATS extractor or `GENERIC_HTTP`. Falls back to Playwright when the initial extractor fails and conditions allow.
4. **Matching** (`lib/matching.ts`) — deterministic title matching against the `RoleSpec`.
5. **Finalization** (`lib/finalizeCompany.ts`) — writes final status (`MATCHES_FOUND`, `NO_MATCH_SCAN_COMPLETED`, `UNVERIFIED`, etc.) to SQLite.

**Ownership guard**: each claimed company gets a `worker_token` UUID. Every DB write checks `status = IN_PROGRESS AND worker_token = ?` — if it fails (another tick or restart took over) the current pipeline aborts immediately.

**Tracing** (`lib/trace.ts`) — every stage emits structured events to the `trace_events` table with `event_type`, `message`, and a JSON payload. Used for debugging, not for control flow.

**Database** (`db/schema.ts`) — four tables: `runs`, `run_companies`, `job_rows`, `trace_events`. Schema is created with `CREATE TABLE IF NOT EXISTS` on startup.

### API endpoints

| Method | Path               | Description                                                              |
| ------ | ------------------ | ------------------------------------------------------------------------ |
| `POST` | `/api/runs`        | Create a run (1–10 companies, a role string, and `includeAdjacent` flag) |
| `GET`  | `/api/runs/:runId` | Full run detail: run metadata + companies + matched jobs                 |

### Key design constraints

- The worker loop is purely poll-based — no in-memory queue, no pub/sub. All state lives in SQLite.
- `listings_url` is `null` unless the resolver confirmed a strong listings surface (`DIRECT_VERIFIED`, `ATS_RESOLVED`, `CTA_RESOLVED`). Never fall back to `careers_url` as a substitute.
- Extraction only begins when `extractionStartUrl` is non-null. Weak or unresolved surfaces exit early as `UNVERIFIED`.
- Role spec always prepends the raw role string as the first `include_title` (deduplicated).
