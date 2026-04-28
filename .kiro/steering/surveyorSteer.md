---
inclusion: always
---
<!------------------------------------------------------------------------------------
   Add rules to this file or a short description and have Kiro refine them for you.
   
   Learn about inclusion modes: https://kiro.dev/docs/steering/#inclusion-modes
-------------------------------------------------------------------------------------> 
# Surveyor Steering File

## Purpose
Surveyor is a focused MVP job search utility for an individual user. It accepts a target role, an include adjacent roles toggle, and an ordered list of up to 10 companies. It checks only official company careers surfaces and associated ATS systems, then classifies each company into exactly one final bucket. :contentReference[oaicite:0]{index=0} :contentReference[oaicite:1]{index=1}

## Authoritative project sources
Treat these as the highest authority, in this order when behavior is unclear:
1. `decision-doc.txt`
2. `EndtoendlifecycleSurveyor.txt`
3. `Roadmap.txt`

If code conflicts with these documents and the current task is intended to align the implementation, follow the documents unless the user explicitly says the docs are outdated. :contentReference[oaicite:2]{index=2} :contentReference[oaicite:3]{index=3} :contentReference[oaicite:4]{index=4}

## Non negotiable working rules
- Do exactly what the current task asks. Do not expand scope.
- Do not refactor unrelated code.
- Do not anticipate future phases unless the task explicitly requires it.
- Leave the app in a runnable state after every change.
- If a step introduces a schema, type, contract, status, transition, or naming rule, that contract becomes authoritative.
- Preserve existing behavior unless the task explicitly changes it.
- Prefer minimal, targeted edits over broad cleanup.
- Do not add polish, abstraction, or architecture changes unless required by the current step.
- Do not replace deterministic logic with model based logic.
- Fail closed, not open.

## Product boundary
- This is not a broad crawler.
- This is not a continuous monitoring system.
- This is not a market intelligence platform.
- This is a narrow MVP that helps a user check a short list of companies for relevant jobs in a trustworthy way. :contentReference[oaicite:5]{index=5}

## Input contract
Accepted run input:
- raw role string
- include adjacent roles toggle
- ordered company list

Hard rules:
- company list cap is 10
- display order must be preserved exactly as entered
- trimming is allowed during validation
- empty entries after trimming must be rejected, not silently dropped :contentReference[oaicite:6]{index=6} :contentReference[oaicite:7]{index=7} :contentReference[oaicite:8]{index=8}

## Matching boundary
- The LLM is used exactly once per run to generate a structured role spec.
- All actual job matching after role spec generation must be deterministic.
- Deterministic matching means normalization, inclusion lists, exclusion lists, and simple token or phrase rules.
- No probabilistic matching for job classification. :contentReference[oaicite:9]{index=9} :contentReference[oaicite:10]{index=10}

## Allowed sources
- Only official company careers surfaces and associated ATS systems are authoritative.
- Job boards are not authoritative sources.
- Discovery may use search only to locate an official company careers entry point.
- Discovery must not treat third party job boards as the source of truth. :contentReference[oaicite:11]{index=11} :contentReference[oaicite:12]{index=12}

## Persisted statuses
Use only these persisted run statuses:
- CREATED
- READY
- RUNNING
- COMPLETED
- FAILED_ROLE_SPEC

Use only these persisted company statuses:
- PENDING
- IN_PROGRESS
- MATCHES_FOUND
- NO_MATCH_SCAN_COMPLETED
- UNVERIFIED
- CANCELLED

Do not invent synonyms or alternate status values. :contentReference[oaicite:13]{index=13} :contentReference[oaicite:14]{index=14}

## Final company outcome rule
Each company must end in exactly one user facing result bucket:
- MATCHES_FOUND
- NO_MATCH_SCAN_COMPLETED
- UNVERIFIED

CANCELLED is a real persisted state used when role spec generation fails for the run. In the UI it should be handled transparently, not hidden. :contentReference[oaicite:15]{index=15} :contentReference[oaicite:16]{index=16}

## Completion and uncertainty rule
If scan completion is uncertain, the company must be UNVERIFIED.
Never downgrade uncertainty to NO_MATCH_SCAN_COMPLETED.
NO_MATCH_SCAN_COMPLETED is allowed only when extraction completed successfully and zero matches were found. :contentReference[oaicite:17]{index=17} :contentReference[oaicite:18]{index=18} :contentReference[oaicite:19]{index=19}

## State ownership
API owns only run creation.
Worker owns all transitions after creation.

API is allowed to:
- validate input
- insert run row in CREATED
- insert run_companies rows in PENDING
- return run_id

Worker owns:
- CREATED to READY
- CREATED to FAILED_ROLE_SPEC
- READY to RUNNING
- RUNNING to COMPLETED
- all company claiming and finalization transitions

Do not split ownership between API handlers and worker logic. :contentReference[oaicite:20]{index=20} :contentReference[oaicite:21]{index=21}

## Database source of truth
- SQLite is the source of truth for run state, company state, evidence fields, failure fields, and queued work.
- The database, not memory, determines what is pending, active, or final.
- No in memory queue is allowed for authoritative work state. :contentReference[oaicite:22]{index=22} :contentReference[oaicite:23]{index=23} :contentReference[oaicite:24]{index=24}

## Queue and concurrency rules
- Companies are queued when `run_companies.status = 'PENDING'`
- Claiming must be transactional
- Concurrency is limited to 2
- Each claim must write a unique `worker_token`
- `worker_token` is required for safe reclaim, debugging, and future multi worker support :contentReference[oaicite:25]{index=25} :contentReference[oaicite:26]{index=26}

## Role spec safety
Role spec generation must be:
- exactly once per run
- restart safe
- timeout recoverable

Hard rules:
- no company may begin processing without valid `role_spec_json`
- use `role_spec_started_at` to prevent duplicate generation and allow reclaim if generation stalls
- on any role spec failure, fail the run as `FAILED_ROLE_SPEC` and mark all pending companies `CANCELLED` with failure fields populated :contentReference[oaicite:27]{index=27} :contentReference[oaicite:28]{index=28} :contentReference[oaicite:29]{index=29}

## Company eligibility for processing
A company may be claimed only if all are true:
- run status is READY or RUNNING
- company status is PENDING
- run has valid role_spec_json

This rule is authoritative. :contentReference[oaicite:30]{index=30}

## Discovery rules
- Discovery exists to find the authoritative careers entry point on the official company domain.
- Discovery must stop once it finds a careers URL that is plausible and allowed.
- Deterministic URL guesses come first.
- Search based discovery is allowed only to find an official careers candidate.
- If only job boards or aggregators are found, discovery fails.
- If discovery cannot find an allowed careers URL, finalize as UNVERIFIED with `CAREERS_NOT_FOUND`. :contentReference[oaicite:31]{index=31} :contentReference[oaicite:32]{index=32}

## Platform detection rules
Platform detection must be deterministic.
Allowed ATS enum values:
- GREENHOUSE
- LEVER
- ASHBY
- SMARTRECRUITERS
- UNKNOWN

UNKNOWN is a valid persisted value and must be written explicitly when detection fails. Do not substitute null for UNKNOWN after detection. :contentReference[oaicite:33]{index=33} :contentReference[oaicite:34]{index=34}

## Extraction rules
- Prefer supported platform specific extractors when available.
- Use conservative generic HTTP extraction when platform is UNKNOWN.
- Use Playwright only under explicitly allowed fallback conditions.
- Respect caps, timeouts, page limits, request limits, and blocking detection.
- If extraction hits limits before confident completion, return `completed: false`
- If blocked, return `completed: false`
- If Playwright fails or times out, return `completed: false`

Any `completed: false` result must force UNVERIFIED later. :contentReference[oaicite:35]{index=35} :contentReference[oaicite:36]{index=36}

## Finalization order
Apply this exact order:
1. no careers URL → UNVERIFIED
2. extraction not completed → UNVERIFIED
3. matches > 0 → MATCHES_FOUND
4. else → NO_MATCH_SCAN_COMPLETED

Do not reorder this logic. :contentReference[oaicite:37]{index=37} :contentReference[oaicite:38]{index=38}

## Atomic persistence rules
Matched job inserts and company finalization must occur in the same transaction.
Do not persist matched jobs outside the company finalization transaction.
This prevents duplicate job inserts after restart recovery. :contentReference[oaicite:39]{index=39}

## Restart safety
On startup before normal claiming:
- stale `IN_PROGRESS` companies for active runs must be reset to `PENDING`
- `started_at` must be cleared
- `worker_token` must be cleared
- final states must never be touched
- stale role spec attempts must be reclaimable by clearing `role_spec_started_at` for eligible CREATED runs

Do not create duplicate company rows during recovery. :contentReference[oaicite:40]{index=40} :contentReference[oaicite:41]{index=41} :contentReference[oaicite:42]{index=42}

## UI contract
- UI renders persisted backend state only.
- UI must not invent states, infer completion, or synthesize results.
- Company display order must be stable using `input_index ASC`
- Lists are derived from persisted company statuses only
- `GET /api/runs/:runId` must match the shared `RunDetailResponse` contract exactly. :contentReference[oaicite:43]{index=43} :contentReference[oaicite:44]{index=44} :contentReference[oaicite:45]{index=45}

## Naming contract
Respect this exact naming split:
- request: `includeAdjacent`
- database: `include_adjacent`
- response: `include_adjacent`

Do not normalize these into one naming style across all layers. :contentReference[oaicite:46]{index=46}

## Time standard
All timestamps are unix milliseconds using `Date.now()`. :contentReference[oaicite:47]{index=47}

## Trace and diagnostics
Trace events are required.
Important system transitions and decisions must go through the single trace writing interface.
Do not replace durable trace requirements with ad hoc console logging. :contentReference[oaicite:48]{index=48} :contentReference[oaicite:49]{index=49} :contentReference[oaicite:50]{index=50}

## Implementation style for this repo
- Prefer simple, explicit code over clever abstractions.
- Keep logic close to the contract it implements.
- When editing code, preserve existing API and DB contracts unless the task explicitly changes them.
- When unsure, implement the narrowest change that satisfies the current roadmap step.
- Do not silently fix upstream ambiguity by inventing new behavior.
- Ask whether a behavior is authoritative in the docs before changing it mentally.

## What not to do
- Do not add extra statuses
- Do not add extra ATS enum values
- Do not start scanning inline in POST /runs
- Do not allow company processing before role spec exists
- Do not treat job boards as authoritative
- Do not treat uncertain scans as No Match
- Do not move state ownership from worker to API
- Do not use model based job matching
- Do not refactor unrelated parts of the codebase
- Do not drift ahead of the current ste