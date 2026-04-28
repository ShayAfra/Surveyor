# Surveyor Full Build Roadmap (A → Z)

## How to Execute This Roadmap

Each step is designed to be executed by a fresh Cursor agent.
Rules:

- Do exactly what the step says. Do not expand scope.
- Do not refactor outside the step unless required.
- Do not anticipate future steps.
- Each step must leave the app in a runnable state.
- If a step introduces schema or contracts, they are authoritative.
  Time Standard:
- ALL timestamps are unix milliseconds (use Date.now())

---

# PHASE 0: FOUNDATION (BOOT + SHARED CONTRACTS)

## Step 0.1: Initialize Monorepo Structure

Create:

- apps/api
- apps/web
- packages/shared
  Add:
- TypeScript config shared across repo
- workspace setup

---

## Step 0.2: Define Shared Types and Constants

Create:
packages/shared/src/constants.ts
RunStatus:

- CREATED
- READY
- RUNNING
- COMPLETED
- FAILED_ROLE_SPEC
  CompanyStatus:
- PENDING
- IN_PROGRESS
- MATCHES_FOUND
- NO_MATCH_SCAN_COMPLETED
- UNVERIFIED
- CANCELLED
  AtsType (authoritative enum):
- GREENHOUSE
- LEVER
- ASHBY
- SMARTRECRUITERS
- UNKNOWN
  Create:
  packages/shared/src/types.ts
  Define:
  RoleSpec (STRICT SHAPE):
  {
  include_titles: string[]
  exclude_titles: string[]
  seniority: "any" | "junior" | "mid" | "senior"
  }
  {
  RunResponse:
  id: string
  status: RunStatus
  role_raw: string
  include_adjacent: boolean
  error_code: string | null
  error_message: string | null
  }
  {
  RunCompanyResponse:
  id: string
  company_name: string
  status: CompanyStatus
  input_index: number
  failure_code: string | null
  failure_reason: string | null
  careers_url: string | null
  ats_type: AtsType | null
  extractor_used: string | null
  listings_scanned: number | null
  pages_visited: number | null
  }
  {
  JobRowResponse:
  id: string
  run_id: string
  company_id: string
  title: string
  location: string | null
  url: string
  match_reason: string
  }
  {
  RunDetailResponse:
  run: RunResponse
  companies: RunCompanyResponse[]
  matched_jobs: JobRowResponse[]
  }
  These response types are authoritative API contracts.
  Rules:
- GET /api/runs/:runId must return exactly RunDetailResponse
- run.error_code and run.error_message are required response fields
- ats_type must be one of AtsType or null
- do not introduce alternative values for ats_type
  Naming contract (authoritative):
- Request uses: includeAdjacent (camelCase)
- DB uses: include_adjacent (snake_case)
- Response uses: include_adjacent

---

## Step 0.3: Boot API Server

apps/api/src/server.ts

- Express or Fastify
- Port 3000
- GET /health → { ok: true }

---

## Step 0.4: Boot Web App

- React + Vite
- Port 5173
- Render basic page

---

## Step 0.5: Connect Web → API

- Use proxy OR base URL
- Must successfully call /health

---

# PHASE 1: CORE PERSISTENCE LAYER

## Step 1.1: Add SQLite Connection

apps/api/src/db/db.ts
Requirements:

- File-based DB
- Path from env DB_PATH
- Default: apps/api/data/surveyor.sqlite
- Ensure directory exists
- Single shared connection

---

## Step 1.2: Create Schema

runs:

- id TEXT PRIMARY KEY
- created_at INTEGER
- status TEXT
- role_raw TEXT
- include_adjacent INTEGER
- role_spec_json TEXT
- role_spec_started_at INTEGER
- company_count INTEGER
- error_code TEXT
- error_message TEXT
  run_companies:
- id TEXT PRIMARY KEY
- run_id TEXT
- company_name TEXT
- input_index INTEGER
- status TEXT
- created_at INTEGER
- started_at INTEGER
- finished_at INTEGER
- worker_token TEXT
- careers_url TEXT
- ats_type TEXT
- extractor_used TEXT
- listings_scanned INTEGER
- pages_visited INTEGER
- failure_code TEXT
- failure_reason TEXT
  job_rows:
- id TEXT PRIMARY KEY
- run_id TEXT
- company_id TEXT
- title TEXT
- location TEXT
- url TEXT
- match_reason TEXT
  Indexes (REQUIRED):
- idx_run_companies_run_id
- idx_run_companies_status
- idx_runs_status
  Rules:
- company_count must equal the number of inserted run_companies rows
  at creation time
- schema must exactly match lifecycle persistence requirements

---

## Step 1.3: Verify Persistence

- Insert test row
- Restart server
- Confirm persistence

---

# PHASE 2: RUN CREATION API

## Step 2.1: POST /api/runs

Request body:
{
role: string
includeAdjacent: boolean
companies: string[]
}
Validation (authoritative, MUST reject on failure):

- role must be non-empty after trimming
- companies must have length between 1 and 10
- each company string must be trimmed
- after trimming, NO company entry may be empty
- if any company entry is empty after trimming → reject request with
  4xx
- do NOT silently drop or modify entries beyond trimming
  Transaction:

1. insert run (CREATED)
2. insert companies (PENDING with input_index preserving original
   order)
   Rules:

- POST /api/runs must only validate and durably create state
- it must not generate role spec inline
- it must not start worker processing inline
- API must never update run or company statuses after creation
- every successful POST must result in exactly N run_companies rows
  where N = companies.length
  Return:
  { runId: string }

---

## Step 2.2: GET /api/runs/:runId

Return EXACT shape:
RunDetailResponse
Return requirements:

- companies must include persisted evidence fields
- matched_jobs must include all matched job rows accumulated so far
  for the run
  Ordering:
- companies ORDER BY input_index ASC
- matched_jobs ORDER BY company input_index ASC, id ASC

---

# PHASE 3: WORKER SYSTEM

## Step 3.1: Worker Loop + Temporary Trace Interface

Create the worker loop that runs on server start and loops every
~500ms.
Also create:
apps/api/src/lib/trace.ts
This file must expose a single function used by all trace emission
points before the durable trace_events table exists.
Function contract:
writeTraceEvent({
run_id,
run_company_id,
event_type,
message,
payload_json,
created_at
})
Field rules:

- run_id: string
- run_company_id: string | null
- event_type: string
- message: string
- payload_json: string | null
- created_at: number
  Requirements:
- created_at must use Date.now()
- payload_json must be a JSON string or null
- this is the ONLY trace write interface used by the app
- all Phase 3 trace emission points must call this function
- implementation for now may append newline delimited JSON to a local
  debug log file or log structured JSON to stdout
- the temporary implementation must preserve the exact event shape
  that Step 5.2 will later store in SQLite
- do not write trace events directly at call sites using ad hoc
  console logs
  Rules:
- the worker loop must use the database as the source of truth for
  work state
- no in memory queue is allowed
- temporary trace capture is required because Phase 3 emits trace
  events before Step 5.2 creates the durable table
- Step 5.2 must keep the same writeTraceEvent function signature and
  replace only its internals

---

## Step 3.2: Run Initialization (Role Spec Gate, EXACTLY ONCE, STALE-

SAFE)
Define:
ROLE_SPEC_TIMEOUT_MS = 30000
Transaction:

1. SELECT id FROM runs
   WHERE status = 'CREATED'
   AND role_spec_json IS NULL
   AND (
   role_spec_started_at IS NULL
   OR role_spec_started_at < (Date.now() - ROLE_SPEC_TIMEOUT_MS)
   )
   ORDER BY created_at ASC, id ASC
   LIMIT 1
2. Compute now_ms = Date.now()
3. UPDATE runs
   SET role_spec_started_at = now_ms
   WHERE id = ?
   AND status = 'CREATED'
   AND role_spec_json IS NULL
   AND (
   role_spec_started_at IS NULL
   OR role_spec_started_at < (now_ms - ROLE_SPEC_TIMEOUT_MS)
   )
   Only proceed if UPDATE affected 1 row
   Then:
   Generate RoleSpec (stub)
   If invalid (API error, timeout, invalid JSON, or schema validation
   failure):

- Compute now_ms = Date.now()
- UPDATE runs
  SET status = 'FAILED_ROLE_SPEC',
  error_code = 'ROLE_SPEC_FAILED',
  error_message = 'role spec generation failed',
  role_spec_started_at = NULL
  WHERE id = ?
- UPDATE run_companies
  SET status = 'CANCELLED',
  finished_at = now_ms,
  failure_code = 'ROLE_SPEC_FAILED',
  failure_reason = 'role spec generation failed',
  worker_token = NULL
  WHERE run_id = ?
  AND status = 'PENDING'
- Immediately after the failed persistence writes, emit exactly one
  run scoped trace event:
  writeTraceEvent({
  run_id,
  run_company_id: null,
  event_type: 'role_spec_failure',
  message: 'role spec generation failed',
  payload_json: JSON.stringify({
  error_code: 'ROLE_SPEC_FAILED'
  }),
  created_at: Date.now()
  })
  Rules:
- This is a terminal failure for the run
- No company may proceed to processing
- All companies must be marked CANCELLED with failure fields populated
- Emit role_spec_failure only after the failure state is durably
  persisted
  If valid:
- store JSON string in role_spec_json
- UPDATE runs
  SET status = 'READY',
  role_spec_started_at = NULL
  WHERE id = ?
- Immediately after the success persistence write, emit exactly one
  run scoped trace event:
  writeTraceEvent({
  run_id,
  run_company_id: null,
  event_type: 'role_spec_success',
  message: 'role spec generation succeeded',
  payload_json: JSON.stringify({
  role_spec_json
  }),
  created_at: Date.now()
  })
  Rules:
- Emit role_spec_success only after READY and role_spec_json are
  durably persisted
- Do not emit both success and failure for the same initialization
  attempt

---

## Step 3.3: Claiming Logic (CRITICAL, ATOMIC)

Eligibility rule is authoritative:

- run.status IN ('READY','RUNNING')
- company.status = 'PENDING'
- role_spec_json IS NOT NULL
  ALL steps below MUST occur in the SAME transaction.
  Transaction:

1. SELECT run_companies.id, run_companies.run_id
   FROM run_companies
   JOIN runs ON runs.id = run_companies.run_id
   WHERE run_companies.status = 'PENDING'
   AND runs.status IN ('READY','RUNNING')
   AND runs.role_spec_json IS NOT NULL
   ORDER BY runs.created_at ASC,
   run_companies.input_index ASC,
   run_companies.id ASC
   LIMIT 1
2. Compute:
   now_ms = Date.now()
   worker_token_value = generated UUID string
3. UPDATE run_companies
   SET status = 'IN_PROGRESS',
   started_at = now_ms,
   worker_token = ? WHERE id = ?
   AND status = 'PENDING'
   -- MUST bind worker_token_value
   Only proceed if UPDATE affected 1 row
4. UPDATE runs
   SET status = 'RUNNING'
   WHERE id = ?
   AND status = 'READY'
   Notes:

- Step 3 MUST assign the generated worker_token_value, not reuse or
  reference the column
- worker_token must uniquely identify this claim attempt
- Step 4 must be executed in the SAME transaction as the claim
- Step 4 may affect 0 or 1 row
- Claim success is authoritative
- RUNNING transition happens only after successful claim
- Claim ordering is authoritative and must follow:
  runs.created_at ASC → run_companies.input_index ASC →
  run_companies.id ASC
- This guarantees deterministic and reproducible queue behavior across
  runs and within a run
- This ordering must NOT be changed or inferred differently by
  implementation
- This ordering must NOT be changed or inferred differently by
  implementation

---

## Step 3.4: Concurrency Limit

Before claiming:

- COUNT companies WHERE status = IN_PROGRESS
- if >= 2 → skip loop

---

## Step 3.5: Company Processing (REAL PIPELINE ORCHESTRATION)

This step orchestrates the full pipeline for a claimed company.
Preconditions:

- company row is IN_PROGRESS
- worker_token is owned by this worker
  Execution order (authoritative):

1. Discovery (Step 6.2)
   If discovery fails:

- proceed directly to Step 6.7 finalization

2. Platform Detection (Step 6.3)
3. Extraction (Step 6.4)
4. Matching (Step 6.5)
5. Finalization (Step 6.6 + 6.7)
   Rules:

- All modules must operate on the SAME claimed row
- worker_token must be used in ALL persistence writes
- no step may run if ownership is lost
- pipeline must stop immediately if any ownership check fails
- finalization_outcome must be emitted only after successful commit
  After successful finalization:
- run Step 3.6 completion check

---

## Step 3.6: Run Completion (FINAL STATE CHECK, CRASH-SAFE)

A run is complete when ALL companies are in a final state.
Final states:

- MATCHES_FOUND
- NO_MATCH_SCAN_COMPLETED
- UNVERIFIED
- CANCELLED
  Check:
  SELECT COUNT(\*) FROM run_companies
  WHERE run_id = ?
  AND status NOT IN (
  'MATCHES_FOUND',
  'NO_MATCH_SCAN_COMPLETED',
  'UNVERIFIED',
  'CANCELLED'
  )
  If result = 0:
  UPDATE runs
  SET status = 'COMPLETED'
  WHERE id = ?
  AND status IN ('RUNNING','READY')
  If the UPDATE affected 1 row:
- emit exactly one run scoped trace event:
  writeTraceEvent({
  run_id,
  run_company_id: null,
  event_type: 'run_completed',
  message: 'run transitioned to COMPLETED',
  payload_json: null,
  created_at: Date.now()
  })
  Rules:
- This check must run after each company finalization
- This check must ALSO run once per worker loop iteration for any runs
  in READY or RUNNING
- This ensures completion is reached even after crashes or restarts
- A run must only transition to COMPLETED once
- Once COMPLETED, the run must never be updated again
- run_completed must be emitted only when the UPDATE that transitions
  the run to COMPLETED affected 1 row

---

# PHASE 4: UI

## Step 4.1: Run Form

Inputs:

- role
- companies textarea
- toggle

---

## Step 4.2: Submit Flow

- POST /api/runs
- navigate to /runs/:id

---

## Step 4.3: Polling

- every 1 second
- call GET endpoint

---

## Step 4.4: Rendering

Rules:

- Lists are derived strictly from company.status
- Preserve input order within lists using input_index
- While run is active, PENDING and IN_PROGRESS remain visible in
  original order
  Final state rendering:
- MATCHES_FOUND → Matches list, using matched_jobs for the job rows
- NO_MATCH_SCAN_COMPLETED → No Match list
- UNVERIFIED → Unverified list
- CANCELLED → must be shown in Unverified list with failure_reason
  displayed
  Run-level rendering:
- if run.status = 'FAILED_ROLE_SPEC':
- display a terminal error state for the run
- do NOT display Matches / No Match / Unverified lists as normal
  results
- display failure message using run.error_message
- companies may still be rendered for transparency, but must show
  CANCELLED status and failure_reason
  Rules:
- UI must not invent new states or groupings
- UI must reflect backend persisted state exactly
- CANCELLED is a real persisted state and must not be ignored

---

# PHASE 5: SYSTEM HARDENING

## Step 5.1: Restart Recovery

Define:
STALE_IN_PROGRESS_THRESHOLD_MS = 120000
On startup (must run before normal claiming begins):
Compute now_ms = Date.now()
-- Only consider runs that are active
-- Active = READY or RUNNING

1. SELECT id FROM runs
   WHERE status IN ('READY','RUNNING')
2. For those run*ids:
   SELECT id, run_id
   FROM run_companies
   WHERE status = 'IN_PROGRESS'
   AND run_id IN (/* active run ids \_/)
   AND started_at IS NOT NULL
   AND started_at < (now_ms - STALE_IN_PROGRESS_THRESHOLD_MS)
3. Reset those stale rows:
   UPDATE run*companies
   SET status = 'PENDING',
   started_at = NULL,
   worker_token = NULL
   WHERE status = 'IN_PROGRESS'
   AND run_id IN (/* active run ids \_/)
   AND started_at IS NOT NULL
   AND started_at < (now_ms - STALE_IN_PROGRESS_THRESHOLD_MS)
4. For each row identified in Step 2 that was actually reset by Step
   3, emit exactly one company scoped trace event:
   writeTraceEvent({
   run_id,
   run_company_id,
   event_type: 'restart_recovery_reclaim',
   message: 'stale in progress company reset to PENDING',
   payload_json: null,
   created_at: Date.now()
   })
   Rules:

- Do NOT modify rows already in final states
- Do NOT modify MATCHES_FOUND, NO_MATCH_SCAN_COMPLETED, UNVERIFIED,
  CANCELLED
- reclaim must clear worker_token before the company is eligible to be
  claimed again
- reclaim must never create a new company row
- reclaim applies ONLY to companies belonging to runs in READY or
  RUNNING
- restart_recovery_reclaim must be emitted only for rows actually
  reset to PENDING
  Also:
  UPDATE runs
  SET role_spec_started_at = NULL
  WHERE status = 'CREATED'
  AND role_spec_json IS NULL
  AND role_spec_started_at IS NOT NULL

---

## Step 5.2: Durable Trace Events Table + Replace Temporary Trace

Storage
Create the SQLite table:
trace_events:

- id TEXT PRIMARY KEY
- run_id TEXT NOT NULL
- run_company_id TEXT NULL
- event_type TEXT NOT NULL
- message TEXT NOT NULL
- payload_json TEXT NULL
- created_at INTEGER NOT NULL
  Requirements:
- id MUST be generated inside writeTraceEvent as a new UUID for each
  inserted event
- created_at must use Date.now()
- run_completed is run scoped and must set run_company_id = NULL
- company scoped events must include run_company_id
- payload_json must contain structured JSON text when structured data
  is available
  Modify:
  apps/api/src/lib/trace.ts
  Replace the temporary implementation of writeTraceEvent with a SQLite
  insert into trace_events.
  Function signature must remain EXACTLY the same:
  writeTraceEvent({
  run_id,
  run_company_id,
  event_type,
  message,
  payload_json,
  created_at
  })
  Rules:
- do not change call sites
- do not create a second trace writing API
- Step 3 and later phases must continue calling the same
  writeTraceEvent function
- writeTraceEvent MUST internally generate the id field before
  inserting
- only the internals of writeTraceEvent are allowed to change in this
  step

---

# PHASE D0: DISCOVERY DESIGN CONTRACT (AUTHORITATIVE)

## Discovery Model

Discovery is no longer:
1. guess some URLs
2. if those fail, search
3. accept the first allowed HTML page

Discovery is now a gated deterministic pipeline with these stages:
1. Company homepage identification
2. Candidate generation
3. Candidate verification
4. Listings surface resolution
5. Platform detection
6. Extraction
7. Finalization

---

## Definitions

### Candidate

A URL that may represent:
- a careers landing page
- a job listings page
- a supported ATS page
- a weak page that must later be rejected

A candidate is not accepted as `careers_url` until it passes verification.

### Verified Candidate

A candidate that passes deterministic careers page verification and is safe to continue evaluating.

Verification is based on content signals only. A 2xx HTML response from an official domain is necessary but not sufficient. A candidate must present strong careers or listings intent to be considered verified.

### Listings Surface

The specific page or ATS endpoint from which job listings can actually be enumerated.

A careers landing page is **not** automatically a listings surface.

### Discovery Success

Discovery succeeds only when the system resolves a verified and allowed listings surface, or a verified careers surface with strong evidence that it is the authoritative entry point for listings.

### Discovery Failure

Discovery fails when:
- no allowed candidate can be found
- candidates are found but none can be verified strongly enough
- a careers landing page is found but the listings surface cannot be resolved with sufficient confidence

---

## Discovery Rules (AUTHORITATIVE)

- Discovery may use official company domains and supported ATS surfaces only. Job boards are not authoritative sources.
- Discovery must stay deterministic and reproducible. No LLM. No randomness.
- Search is candidate generation only, never final truth on its own.
- A candidate may not become `careers_url` unless it passes verification.
- A careers landing page may not be treated as a completed listings surface unless listing access is actually resolved.
- If certainty is insufficient at any step, the company must end as `UNVERIFIED`, not `NO_MATCH_SCAN_COMPLETED`.

---

## Candidate Generation vs. Candidate Verification

These are distinct pipeline stages and must not be conflated:

**Candidate generation** produces a set of URLs that are plausible starting points. Sources include:
- links extracted from the official company homepage
- deterministic URL path guesses on the official domain
- search results filtered to allowed domains

**Candidate verification** takes each candidate URL, fetches it, and applies deterministic signal-based classification:
- verified listings surface
- verified careers landing page
- rejected (insufficient evidence)

A candidate becomes a verified candidate only after passing this explicit verification step.

---

## Careers Landing Pages vs. Listings Surfaces

These are distinct concepts and must not be conflated:

**Careers landing page**: A page that establishes the company's recruiting entry point. It may describe culture, link to jobs, or embed an ATS. It does not itself enumerate job listings.

**Listings surface**: The specific page or ATS endpoint where individual job postings are enumerated and can be extracted.

When discovery finds a verified careers landing page, the pipeline must still attempt to resolve the actual listings surface before extraction can begin. Discovery is not complete until a listings surface is resolved or the attempt has conclusively failed.

---

# PHASE 6: REAL PIPELINE

## Step 6.1: Role Spec Generation Module (LOCKED CONTRACT, NO DRIFT)

Create:
apps/api/src/lib/roleSpec.ts
Define EXACT function:
generateRoleSpec({
role_raw,
include_adjacent
}) → RoleSpec
RoleSpec MUST match shared type EXACTLY:
{
include_titles: string[]
exclude_titles: string[]
seniority: "any" | "junior" | "mid" | "senior"
}
Implementation requirements (authoritative):

- This function is the ONLY place where the LLM is called
- It must perform EXACTLY ONE LLM call per invocation
- It must return ONLY valid RoleSpec or throw a controlled error
  Validation (MANDATORY, fail closed):
  After LLM response:

1. Parse JSON
2. Validate structure:

- include_titles exists and is array of non-empty strings
- exclude_titles exists and is array of non-empty strings
- seniority is one of allowed enum values

3. Trim all strings
4. Reject if:

- any field missing
- any string empty after trimming
- any unexpected keys (strict mode)
  Error handling (authoritative):
  On ANY failure (API error, timeout, invalid JSON, validation failure):
- THROW a normalized error object:
  {
  code: 'ROLE_SPEC_FAILED',
  message: 'role spec generation failed'
  }
  Rules:
- Do NOT return partial data
- Do NOT silently fix malformed output
- Do NOT retry internally
- Caller (Step 3.2) handles failure → FAILED_ROLE_SPEC
  Output rules:
- Returned RoleSpec must be fully validated and safe for deterministic
  matching
- No additional fields allowed
- No post-processing outside this module
  This function is the single boundary between LLM and deterministic
  system.

---

## Step 6.2: Discovery Module (ROW-SCOPED ORCHESTRATION + LOCKED

SEARCH ADAPTER)
Create:
apps/api/src/lib/discovery.ts
Split responsibilities explicitly:

1. PURE HELPER (NO DB ACCESS)
   Function:
   discoverCareersUrl(companyName) → {
   careers_url: string | null
   attempted_urls: string[]
   selected_source_type: 'OFFICIAL_DOMAIN' | 'SUPPORTED_ATS' | null
   }
   Rules:

- MUST be pure (no DB access, no trace writes)
- MUST NOT know about run_id, run_company_id, or worker_token
- MUST ONLY perform deterministic discovery logic

---

2. ORCHESTRATOR (CALLED FROM WORKER, OWNS PERSISTENCE)
   Function (inline inside Step 3.5 pipeline, NOT exported separately):
   runDiscoveryForCompany({
   run_id,
   run_company_id,
   company_name,
   worker_token
   })
   Execution (authoritative):
1. Call:
   result = discoverCareersUrl(company_name)
1. Immediately emit careers_url_attempts (ALWAYS, success or failure):
   writeTraceEvent({
   run_id,
   run_company_id,
   event_type: 'careers_url_attempts',
   message: 'careers url attempts completed',
   payload_json: JSON.stringify({
   attempted_urls: result.attempted_urls
   }),
   created_at: Date.now()
   })
1. If careers_url FOUND:
   UPDATE run_companies
   SET careers_url = ?
   WHERE id = ?
   AND status = 'IN_PROGRESS'
   AND worker_token = ?
   Then emit:
   writeTraceEvent({
   run_id,
   run_company_id,
   event_type: 'careers_url_selected',
   message: 'careers url selected',
   payload_json: JSON.stringify({
   careers_url: result.careers_url,
   selected_source_type: result.selected_source_type
   }),
   created_at: Date.now()
   })
   RETURN success to pipeline

---

4. If careers_url NOT found:
   DO NOT emit careers_url_selected
   RETURN failure to pipeline so Step 6.7 finalizes as:
   status = UNVERIFIED
   failure_code = 'CAREERS_NOT_FOUND'

---

### SEARCH ADAPTER (MANDATORY, NO DRIFT)

Create:
apps/api/src/lib/search.ts
Function:
searchCareersCandidates(query) → string[]
Implementation (authoritative):

- Use DuckDuckGo HTML endpoint
- HTTP only
- deterministic parsing
- no LLM
- no headless browser
- no fallback providers

---

### HARD RULES

- discoverCareersUrl is PURE and side effect free
- ALL persistence and trace writes happen ONLY in worker orchestration
- careers_url_attempts MUST always be emitted exactly once per
  discovery attempt
- careers_url must be persisted BEFORE platform detection
- worker_token ownership MUST be enforced on UPDATE
- discovery must be deterministic and reproducible

---

## Step 6.3: Platform Detection (LOCKED ENUM, NO FALLBACK BRANCHES)

Define authoritative enum:
AtsType =

- GREENHOUSE
- LEVER
- ASHBY
- SMARTRECRUITERS
- UNKNOWN
  Function:
  detectPlatform(html, url) → AtsType
  Rules:
- No LLM
- deterministic only
- MUST return one of the five enum values above
- UNKNOWN is a VALID persisted value
  Persistence:
  UPDATE run_companies
  SET ats_type = ?
  WHERE id = ?
  AND status = 'IN_PROGRESS'
  AND worker_token = ?
  Trace:
  writeTraceEvent({
  run_id,
  run_company_id,
  event_type: 'platform_detected',
  message: 'platform detection completed',
  payload_json: JSON.stringify({
  detected_platform: detectedPlatform
  }),
  created_at: Date.now()
  })
  Rules:
- ats_type must always be written (never left unset after detection)
- UNKNOWN must be written explicitly when detection fails
- do not store NULL as a substitute for UNKNOWN

---

## Step 6.4: Extraction Module (EXTRACTOR SELECTION REQUIRED, NO DRIFT

ON FALLBACK)
Extractor selection must be explicit and persisted.
Define:
extractor_used values:

- 'GREENHOUSE'
- 'LEVER'
- 'ASHBY'
- 'SMARTRECRUITERS'
- 'GENERIC_HTTP'
- 'PLAYWRIGHT'
  Selection rules:
- If ats_type is a supported ATS → use matching extractor
- If ats_type = UNKNOWN → use GENERIC_HTTP
- If HTTP extraction fails due to JS → fallback to PLAYWRIGHT (see
  fallback rules below)

---

### INITIAL EXTRACTOR SELECTION (MANDATORY PERSISTENCE)

Before extraction begins:
UPDATE run_companies
SET extractor_used = ?
WHERE id = ?
AND status = 'IN_PROGRESS'
AND worker_token = ?
Then emit:
writeTraceEvent({
run_id,
run_company_id,
event_type: 'extractor_selected',
message: 'extractor selected',
payload_json: JSON.stringify({
extractor_used
}),
created_at: Date.now()
})
Rules:

- extractor_used MUST be persisted BEFORE extraction runs
- extractor_selected MUST reflect the persisted value
- do not delay extractor selection until after extraction

---

### EXTRACTION EXECUTION

Call:
extractJobs(url, platform, extractor_used) → {
jobs: Job[]
completed: boolean
listings_scanned: number
pages_visited: number
failure_code?: string
failure_reason?: string
}

---

### PLAYWRIGHT FALLBACK (NO AMBIGUITY, AUTHORITATIVE)

If the worker determines Playwright fallback is required:
Conditions:

- HTTP extractor failed to retrieve listings for a supported ATS
  OR
- ats_type = UNKNOWN AND there is evidence listings exist but are JS
  rendered
  Then:

1. UPDATE run_companies
   SET extractor_used = 'PLAYWRIGHT'
   WHERE id = ?
   AND status = 'IN_PROGRESS'
   AND worker_token = ?
   Only proceed if UPDATE affected 1 row
2. Emit a second extractor_selected trace event:
   writeTraceEvent({
   run_id,
   run_company_id,
   event_type: 'extractor_selected',
   message: 'extractor selected',
   payload_json: JSON.stringify({
   extractor_used: 'PLAYWRIGHT'
   }),
   created_at: Date.now()
   })
3. Execute extraction using Playwright

---

### HARD RULES

- The persisted extractor_used MUST always reflect the extractor that
  actually performed the final extraction attempt
- If Playwright runs, the final persisted extractor_used MUST be
  'PLAYWRIGHT'
- Do NOT leave extractor_used as GENERIC_HTTP or an ATS extractor if
  Playwright executed
- Fallback must respect worker_token ownership
- If ownership is lost, fallback must not execute

---

## Step 6.5: Matching Module

Function:
matchJobs(jobs, roleSpec) → matchedJobs[]
Rules:

- normalize strings
- exclusion first
- inclusion second

---

## Step 6.6: Persist Jobs + Finalize Company (ATOMIC, CRASH-SAFE)

This step REPLACES separate non-atomic job persistence.
Matched job persistence and company finalization MUST occur in the
SAME transaction so restart recovery cannot cause duplicate matched
job inserts for the same company.
Preparation before transaction:

- compute computed_status using Step 6.7 finalization order
- compute now_ms = Date.now()
  Transaction rules:
- only the currently claimed company row may be mutated
- the worker must use the exact worker_token generated at claim time
- if the company row is no longer owned by this worker, do not insert
  any job rows
  Transaction:

1. Verify ownership by selecting the claimed row:
   SELECT id
   FROM run_companies
   WHERE id = ?
   AND status = 'IN_PROGRESS'
   AND worker_token = ?
   Only proceed if exactly 1 row is returned
2. If computed_status = 'MATCHES_FOUND':
   insert matched jobs into job_rows for this company within the SAME
   transaction
   Job row insert contract:

- insert only rows for the current run_id and company_id
- each inserted row must include:
- id
- run_id
- company_id
- title
- location
- url
- match_reason

3. Finalize the same company row within the SAME transaction:
   UPDATE run_companies
   SET status = computed_status,
   finished_at = now_ms,
   careers_url = value,
   ats_type = value,
   extractor_used = value,
   listings_scanned = value,
   pages_visited = value,
   failure_code = value,
   failure_reason = value,
   worker_token = NULL
   WHERE id = ?
   AND status = 'IN_PROGRESS'
   AND worker_token = ?
   Only treat finalization as successful if UPDATE affected 1 row
4. Commit transaction only if:

- ownership verification succeeded
- all required job_rows inserts succeeded
- the finalization UPDATE affected 1 row
  If any part fails:
- rollback the entire transaction
- do not leave partially inserted matched jobs for that company
  Rules:
- this transaction is authoritative for crash safety
- restart recovery must never be able to reprocess a company after
  matched jobs were committed but before the company was finalized
- once finalized, the company row must never be reprocessed for that
  run
- do not insert matched jobs outside this transaction

---

## Step 6.7: Finalization Logic

Apply EXACT order:

1. no careers URL → UNVERIFIED
2. extraction not completed → UNVERIFIED
3. matches > 0 → MATCHES_FOUND
4. else → NO_MATCH_SCAN_COMPLETED
   Finalization contract:

- Step 6.6 is authoritative
- computed_status from this step must be passed into Step 6.6
- matched job insertion and company finalization are a single atomic
  unit
- after a successful Step 6.6 commit, emit finalization_outcome trace
  event
- after successful company finalization, run the Step 3.6 completion
  check
  MANDATORY TRACE EVENT CONTRACT:
  After the Step 6.6 transaction COMMIT succeeds, emit exactly one
  company scoped trace event:
  After the Step 6.6 transaction COMMIT succeeds, emit exactly one
  company scoped trace event:
  writeTraceEvent({
  run_id,
  run_company_id,
  event_type: 'finalization_outcome',
  message: 'company finalized',
  payload_json: JSON.stringify({
  computed_status,
  listings_scanned,
  pages_visited,
  failure_code,
  failure_reason
  }),
  created_at: Date.now()
  })
  Rules:
- finalization_outcome MUST be emitted only AFTER the transaction
  commits successfully
- payload_json MUST include ALL fields above, even if some are null
- computed_status MUST match the persisted run_companies.status
- listings_scanned and pages_visited MUST match persisted values
- failure_code and failure_reason MUST be present when status =
  UNVERIFIED
- no additional or missing fields are allowed in payload_json
- do not emit multiple finalization_outcome events for the same
  company
  Additional rules:
- finalization must update the existing claimed row only
- if the worker no longer owns the row, it must stop and must not
  persist jobs
- once finalized, the company row must never be reprocessed for that
  run

---

# PHASE 7: UX COMPLETION

## Step 7.1: Display Evidence

- careers_url
- listings_scanned
- failure_reason

---

## Step 7.2: CSV Export

Expose CSV export in the completed run view only.
Required exports:

- Matches CSV
- No Match CSV
- Unverified CSV
- Combined CSV
  Data contract:
- export data must be derived strictly from persisted backend state
- exports must use the same run detail data model already returned by
  GET /api/runs/:runId
- do not invent fields not already persisted or returned by the API
  Required row content:
  Matches CSV:
- company_name
- input_index
- company_status
- careers_url
- ats_type
- extractor_used
- listings_scanned
- pages_visited
- failure_code
- failure_reason
- job_title
- job_location
- job_url
- match_reason
  No Match CSV:
- company_name
- input_index
- company_status
- careers_url
- ats_type
- extractor_used
- listings_scanned
- pages_visited
- failure_code
- failure_reason
  Unverified CSV:
- company_name
- input_index
- company_status
- careers_url
- ats_type
- extractor_used
- listings_scanned
- pages_visited
- failure_code
- failure_reason
  Combined CSV:
- all company level columns above
- plus job_title
- plus job_location
- plus job_url
- plus match_reason
  Rules:
- one CSV export button must exist for each required export
- the UI must show these export buttons only when run.status =
  'COMPLETED'
- display ordering in CSV must preserve company input order using
  input_index ASC
- Matches CSV and Combined CSV must order matched job rows by company
  input_index ASC, then job row id ASC
- companies with no matched jobs must still appear in the appropriate
  non-match export

---

# PHASE 8: SAFETY + LIMITS (FULLY SPECIFIED, AUTHORITATIVE)

## Step 8.1: Extraction Limits (ENFORCED IN EXTRACTORS)

Define constants (hardcoded or config):

- MAX_LISTINGS_PER_COMPANY = 200
- MAX_PAGES_PER_COMPANY = 20
- MAX_TIME_PER_COMPANY_MS = 30000
- REQUEST_TIMEOUT_MS = 5000
  All extractors MUST enforce ALL limits.
  Behavior:
  During extraction:
- Track:
- listings_scanned
- pages_visited
- elapsed time
  If ANY limit is hit BEFORE extraction is confidently complete:
  Return:
  {
  jobs,
  completed: false,
  listings_scanned,
  pages_visited,
  failure_code: 'CAP_REACHED',
  failure_reason: 'extraction limit reached'
  }
  Rules:
- completed MUST be false when limits are hit
- This MUST force UNVERIFIED later
- NEVER assume completion when limits are hit

---

## Step 8.2: Blocking Detection (MANDATORY SIGNAL HANDLING)

During HTTP or Playwright extraction:
Detect blocking signals:

- HTTP 403
- HTTP 429
- CAPTCHA pages
- Access denied pages
- Unexpected auth walls
  If detected:
  Return:
  {
  jobs: [],
  completed: false,
  listings_scanned,
  pages_visited,
  failure_code: 'BLOCKED',
  failure_reason: 'request blocked or captcha encountered'
  }
  Rules:
- completed MUST be false
- This MUST force UNVERIFIED
- Do NOT retry indefinitely
- Do NOT fallback endlessly

---

## Step 8.3: Playwright Fallback (STRICT CONDITIONS ONLY)

Playwright may be used ONLY if:
Condition A:

- ats_type is supported (GREENHOUSE, LEVER, etc.)
- HTTP extraction failed to retrieve listings
  OR
  Condition B:
- ats_type = UNKNOWN
- There is strong evidence listings exist BUT are JS rendered
  Rules:
- Playwright MUST respect:
- MAX_TIME_PER_COMPANY_MS
- MAX_PAGES_PER_COMPANY
  If Playwright succeeds:
- Return normal extraction result
  If Playwright fails OR times out:
  Return:
  {
  jobs,
  completed: false,
  listings_scanned,
  pages_visited,
  failure_code: 'PLAYWRIGHT_FAILED',
  failure_reason: 'playwright extraction failed or timed out'
  }

---

## Step 8.4: Final Outcome Enforcement

These rules are ABSOLUTE:

- If completed = false → MUST be UNVERIFIED
- NEVER downgrade uncertainty to NO_MATCH_SCAN_COMPLETED
- NO_MATCH_SCAN_COMPLETED is ONLY allowed when:
- completed = true
- AND matched_jobs.length = 0
  This rule overrides all other interpretations.

# FINAL DEFINITION OF DONE

Complete when:

- Run persists immediately
- Role spec gates execution
- Worker processes deterministically
- Companies finalize correctly
- UI reflects true state
- Restart is safe
- Matching is deterministic
- No state drift between API, DB, UI
