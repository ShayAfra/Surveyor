# Surveyor Operating Context

## Purpose

This file is the lean everyday operating context for Surveyor implementation work.

It exists to reduce prompt cost, preserve the active Core Scanner contract, prevent scope drift, and keep the future AI agent direction visible without making it active implementation scope.

Surveyor currently has one active product:

Core Scanner.

Future agent features are planning context only unless the user explicitly asks to implement them.

## Authority order

When instructions conflict, use this priority order:

1. The user’s current explicit request
2. This file
3. CLAUDE.md
4. Current repository code
5. Future planning documents
6. Archived documents

Future planning documents do not override the current Core Scanner contract.

Archived documents are historical reference only. Do not treat them as active task queues unless the user explicitly asks to use them.

## Normal Claude Code usage

For normal implementation work, load:

1. CLAUDE.md
2. docs/surveyor-operating-context.md

For modularization work, also load:

1. docs/core-scanner-modularization-plan.md

For pre agent readiness work, also load:

1. docs/pre-agent-expansion-readiness.md

For future product planning, use:

1. Surveyor Product North Star and Expansion Plan.md
2. Surveyor Agent Expansion Roadmap.md

For future agent implementation, use the Agent Expansion Roadmap only after the readiness gate has passed.

Do not load archived docs unless explicitly requested.

## Everyday implementation rules

Claude Code MUST:

1. Do exactly the requested task.
2. Keep changes scoped.
3. Use the smallest safe change.
4. Keep the app runnable.
5. Preserve current scanner behavior unless the task explicitly changes it.
6. Identify the files that own the relevant behavior before editing.
7. Run the narrowest relevant build or test command after editing.
8. Report conflicts instead of silently inventing a new design.

Claude Code MUST NOT:

1. Expand the task.
2. Refactor unrelated code unless required for the requested task.
3. Anticipate future phases.
4. Add scaffolding for future features unless explicitly requested.
5. Add new persisted statuses unless explicitly requested.
6. Add new enum values unless explicitly requested.
7. Add new API response shapes unless explicitly requested.
8. Add new database columns unless explicitly requested.
9. Add new user facing states unless explicitly requested.
10. Add new pipeline branches unless explicitly requested.

## Active product scope

Surveyor is currently the Core Scanner.

The Core Scanner accepts:

1. role
2. includeAdjacent
3. ordered company list capped at ten companies

The scanner checks official company careers surfaces or clearly associated ATS systems.

Each company must finish in one canonical company status.

The scanner is not currently:

1. An account based dashboard
2. A resume memory system
3. A saved company tracker
4. A saved search system
5. A continuous monitoring system
6. An application packet generator
7. A referral intelligence system
8. A full AI job search agent

Do not implement any of those unless explicitly requested.

## Product promise

The Core Scanner answers this question:

Given this role and this short list of companies, can Surveyor check the companies’ official careers surfaces and tell me whether there are relevant openings, no relevant openings, or whether the scan could not be verified?

The scanner must favor trust over coverage.

A confident no match is allowed only when extraction completed confidently.

If discovery, extraction, completion, source authority, platform support, or scan coverage is uncertain, the company MUST become UNVERIFIED.

## Active input contract

A run accepts exactly these inputs:

1. role

Type: string

Meaning: raw role entered by the user

Validation: must be non empty after trimming

2. includeAdjacent

Type: boolean

Meaning: whether adjacent roles should be included when generating the role specification

Request naming: includeAdjacent

Database naming: include_adjacent

Response naming: include_adjacent

3. companies

Type: string array

Meaning: company names entered by the user

Validation rules:

1. Must contain at least one company.
2. Must contain no more than ten companies.
3. Each company must be trimmed.
4. No company may be empty after trimming.
5. Empty companies must cause a 4xx validation error.
6. The API must not silently drop empty companies.
7. Original display order must be preserved using input_index.

The ten company cap is part of the active contract.

Do not increase it unless explicitly requested.

## Canonical run statuses

Only these persisted run statuses are allowed:

1. CREATED
2. READY
3. RUNNING
4. COMPLETED
5. FAILED_ROLE_SPEC

Do not use DONE.

Do not introduce SUCCESS, FAILED, ERROR, PARTIAL, SCANNING, FINISHED, COMPLETE, or any other alternate run status unless explicitly requested.

## Canonical company statuses

Only these persisted company statuses are allowed:

1. PENDING
2. IN_PROGRESS
3. MATCHES_FOUND
4. NO_MATCH_SCAN_COMPLETED
5. UNVERIFIED
6. CANCELLED

Do not introduce alternate company statuses unless explicitly requested.

## User facing result buckets

Result buckets are derived from company.status.

1. MATCHES_FOUND appears in Matches.
2. NO_MATCH_SCAN_COMPLETED appears in No Match.
3. UNVERIFIED appears in Unverified.
4. CANCELLED appears in Unverified or a terminal role spec failure display.

The UI must not invent buckets that do not exist in persisted backend state.

## Current architecture

Surveyor currently uses:

1. Node backend
2. React frontend
3. SQLite persistence
4. Worker loop inside the backend process
5. npm workspaces monorepo structure

Current package structure:

1. packages/shared

Shared TypeScript types and constants.

2. apps/api

Express backend, SQLite access, API endpoints, worker loop, extraction logic, matching logic, trace logic.

3. apps/web

React and Vite frontend.

SQLite is the source of truth for queued and active work.

Backend persisted state is the source of truth for everything shown in the UI.

The UI must not infer state that is not persisted by the backend.

## API ownership boundary

The API owns run creation only.

POST /api/runs MAY:

1. Validate the request.
2. Insert the run row with status CREATED.
3. Insert one run_companies row per company with status PENDING.
4. Preserve company order through input_index.
5. Return the runId.

POST /api/runs MUST NOT:

1. Call the LLM.
2. Generate role_spec_json inline.
3. Start discovery inline.
4. Start extraction inline.
5. Start matching inline.
6. Mark companies IN_PROGRESS inline.
7. Update runs beyond durable creation.
8. Perform scanner work directly.

Every successful POST /api/runs creates a new run_id.

There is no deduplication across runs in the current scanner.

## GET run detail contract

GET /api/runs/:runId returns persisted backend state for the frontend.

It MUST include:

1. Run metadata
2. Ordered company rows
3. Matched job rows accumulated so far

Ordering rules:

1. Companies ordered by input_index ascending
2. Matched jobs ordered by company input_index ascending, then job row id ascending

The endpoint must return persisted evidence fields, not recomputed guesses.

The shared response model must preserve these categories:

1. Run id, status, role_raw, include_adjacent, error_code, error_message
2. Company id, company_name, status, input_index, failure fields, careers_url, ats_type, extractor_used, listings_scanned, pages_visited
3. Job id, run_id, company_id, title, location, url, match_reason

Do not remove run error fields.

Do not remove company evidence fields.

Do not introduce alternate response shapes unless explicitly requested.

## Worker ownership boundary

The worker owns all run initialization and processing transitions after creation.

The worker owns these run transitions:

1. CREATED to READY
2. CREATED to FAILED_ROLE_SPEC
3. READY to RUNNING
4. RUNNING to COMPLETED

The worker owns these company transitions:

1. PENDING to IN_PROGRESS
2. PENDING to CANCELLED if role specification generation fails
3. IN_PROGRESS to MATCHES_FOUND
4. IN_PROGRESS to NO_MATCH_SCAN_COMPLETED
5. IN_PROGRESS to UNVERIFIED

The API must not own these transitions.

The UI must not own these transitions.

A frontend refresh, polling interval, or route change must not change backend processing state.

## Worker queue model

The worker uses SQLite as the source of truth for work state.

There is no in memory queue.

A company is queued when run_companies.status is PENDING and its run is eligible.

A company is eligible to be claimed only when all of these are true:

1. The run status is READY or RUNNING.
2. The company status is PENDING.
3. The run has valid role_spec_json.

If any condition is false, the company must not be claimed.

## Claiming and ownership

Company claiming must be transactional.

When a company is claimed:

1. Status changes from PENDING to IN_PROGRESS.
2. started_at is set.
3. worker_token is set to a generated UUID.
4. The run may transition from READY to RUNNING in the same transaction.

The worker_token identifies the claim attempt.

Every persistence write during company processing must verify:

1. The company row is still IN_PROGRESS.
2. The worker_token matches the current worker token.

If ownership is lost, the pipeline must stop immediately and must not persist partial results.

Claiming must not create duplicate company rows.

Finalization must update the existing claimed row only.

## Concurrency rule

Company processing concurrency is limited to two.

Before claiming work, the worker should count currently IN_PROGRESS companies.

If the count is greater than or equal to two, the worker skips claiming during that loop tick.

Do not increase concurrency unless explicitly requested.

## Role specification boundary

The LLM is used once per run to convert role and includeAdjacent into a structured RoleSpec.

This is the only model based interpretation step in the current scanner.

RoleSpec shape:

include_titles: string array

exclude_titles: string array

seniority: any, junior, mid, or senior

Role spec generation MUST:

1. Happen in the worker, not the API.
2. Happen before any company scanning begins.
3. Be persisted in runs.role_spec_json.
4. Be validated before use.
5. Fail closed if output is invalid.
6. Not return partial data.
7. Not silently fix malformed model output outside validation rules.
8. Not perform hidden retries unless explicitly requested.
9. Produce a trace event after success or failure is durably persisted.

The role spec module is the single boundary between the LLM and the deterministic scanner.

Matching after role specification generation must be deterministic.

## Role specification failure

If role specification generation fails for any reason:

1. The run becomes FAILED_ROLE_SPEC.
2. error_code should be ROLE_SPEC_FAILED.
3. error_message should be role spec generation failed.
4. All PENDING companies for that run become CANCELLED.
5. CANCELLED companies should receive failure_code ROLE_SPEC_FAILED.
6. CANCELLED companies should receive failure_reason role spec generation failed.
7. No company in that run may proceed to discovery, extraction, or matching.
8. role_spec_failure trace event is emitted only after the failure state is durably persisted.

Role spec failure is the only current failure type that aborts the entire run.

Company level failures must not abort the entire run.

## Discovery policy

Discovery determines the authoritative careers entry point for a company.

Discovery may accept only:

1. Official company careers surfaces
2. Supported ATS pages clearly associated with the company

Job boards are not authoritative sources.

Search may be used only to locate the official careers entry point.

Search results must still pass the allowed source rule.

If search results only return job boards or aggregators, discovery fails.

When discovery succeeds:

1. careers_url must be persisted.
2. Attempted URLs should be traceable.
3. Selected source type should be traceable when available.

When discovery fails:

1. The company finalizes as UNVERIFIED.
2. failure_code should be CAREERS_NOT_FOUND when applicable.
3. The pipeline must not proceed to platform detection or extraction.

## Platform detection

Platform detection is deterministic.

It must not use the LLM.

Canonical AtsType values:

1. GREENHOUSE
2. LEVER
3. ASHBY
4. SMARTRECRUITERS
5. UNKNOWN

UNKNOWN is a valid persisted value.

Do not store null as a substitute for UNKNOWN after detection has run.

Do not invent additional ATS enum values unless explicitly requested.

When platform detection completes:

1. ats_type must be persisted.
2. platform_detected trace event must be emitted.
3. The scanner must choose the appropriate extractor.

## Extractor selection

Extractor selection must be explicit and persisted.

Canonical extractor_used values:

1. GREENHOUSE
2. LEVER
3. ASHBY
4. SMARTRECRUITERS
5. GENERIC_HTTP
6. PLAYWRIGHT

Selection rules:

1. If ats_type is a supported ATS, use the matching extractor.
2. If ats_type is UNKNOWN, use GENERIC_HTTP.
3. If HTTP extraction fails because listings appear to be JavaScript rendered, Playwright may be used only when fallback conditions are met.

extractor_used must be persisted before extraction begins.

extractor_selected trace event must reflect the persisted value.

If Playwright executes, the final persisted extractor_used must be PLAYWRIGHT.

Do not leave extractor_used as GENERIC_HTTP or an ATS extractor if Playwright performed the final extraction attempt.

## Extraction contract

Extraction enumerates job postings and returns normalized job data.

Each extractor must return:

1. jobs
2. completed
3. listings_scanned
4. pages_visited
5. failure_code when applicable
6. failure_reason when applicable

Each job should include:

1. title
2. location text when available
3. job URL

The extracted job list is not itself a match.

Matching happens later.

## Extraction limits and blocking

Extractors must enforce strict limits.

Expected limits include:

1. Maximum listings per company
2. Maximum pages per company
3. Maximum total time per company
4. Per request timeout
5. Per domain pacing

If a cap is reached before the extractor can confidently assert completion:

1. completed must be false.
2. failure_code should be CAP_REACHED.
3. failure_reason should explain that the extraction limit was reached.
4. Final company status must be UNVERIFIED.

Blocking signals include:

1. HTTP 403
2. HTTP 429
3. CAPTCHA pages
4. Access denied pages
5. Unexpected authentication walls

If blocking is detected:

1. completed must be false.
2. failure_code should be BLOCKED.
3. failure_reason should explain that the request was blocked or a CAPTCHA was encountered.
4. Final company status must be UNVERIFIED.

Do not retry indefinitely.

Do not create fallback loops.

Do not downgrade uncertainty to NO_MATCH_SCAN_COMPLETED.

## Playwright fallback

Playwright is allowed only as a fallback extractor.

Playwright may be used when:

1. The ATS is supported but HTTP extraction failed to retrieve listings.
2. The ATS is UNKNOWN and there is strong evidence that listings exist but are JavaScript rendered.

Playwright must respect extraction limits.

If Playwright cannot complete within limits:

1. completed must be false.
2. failure_code should be PLAYWRIGHT_FAILED when applicable.
3. failure_reason should explain that Playwright extraction failed or timed out.
4. The company must finalize as UNVERIFIED.

Playwright must not become a default crawler for every unknown site.

## Matching contract

Matching happens after extraction.

Matching must be deterministic.

The LLM must not decide whether a job is a match.

Matching should:

1. Normalize job titles.
2. Apply exclusions first.
3. Apply inclusions second.
4. Apply seniority rules from the RoleSpec.
5. Produce deterministic match_reason for matched jobs.

Normalization should include:

1. Lowercasing
2. Trimming
3. Collapsing whitespace
4. Handling obvious punctuation variants

A job is a match only if it passes exclusion rules and satisfies inclusion rules.

Exclusion wins over inclusion.

Match reasons should be short, explainable, and deterministic.

Do not use probabilistic model judgment for matching.

## Finalization logic

A company is finalized only after the pipeline conclusively succeeds or fails.

Finalization order is authoritative:

1. If discovery failed, status is UNVERIFIED.
2. Else if extraction did not complete, status is UNVERIFIED.
3. Else if extraction completed and matched_jobs.length is greater than zero, status is MATCHES_FOUND.
4. Else if extraction completed and matched_jobs.length is zero, status is NO_MATCH_SCAN_COMPLETED.

The uncertainty rule is absolute:

If completion is uncertain, the outcome is UNVERIFIED.

Never convert uncertainty into NO_MATCH_SCAN_COMPLETED.

When finalizing, persist:

1. status
2. finished_at
3. careers_url
4. ats_type
5. extractor_used
6. listings_scanned
7. pages_visited
8. failure_code when applicable
9. failure_reason when applicable
10. worker_token cleared to null

Once a company reaches a final state, it must never be reprocessed for that run.

## Job row persistence

Matched job rows must be persisted only for MATCHES_FOUND companies.

Matched job persistence and company finalization should happen atomically.

The system must not commit matched jobs for a company and then leave that company IN_PROGRESS.

The system must not allow restart recovery to reprocess a company after job rows were committed but before the company was finalized.

Do not insert matched jobs outside the finalization transaction.

## Run completion

A run is complete when every company in that run is in one of these final states:

1. MATCHES_FOUND
2. NO_MATCH_SCAN_COMPLETED
3. UNVERIFIED
4. CANCELLED

When all companies are final:

1. The worker sets the run status to COMPLETED.
2. run_completed trace event is emitted only if the update actually transitioned the run to COMPLETED.
3. The run must not be updated again after COMPLETED unless explicitly requested.

Completion checks should run:

1. After each successful company finalization.
2. Periodically inside the worker loop for READY or RUNNING runs.

## Trace events

Trace events are durable implementation evidence.

They are not optional.

Trace events must use one shared writeTraceEvent interface.

Do not write ad hoc trace console logs at random call sites.

Each trace event must include:

1. run_id
2. run_company_id when company scoped
3. event_type
4. message
5. payload_json when structured data is available
6. created_at

Trace events should be emitted for at least:

1. role_spec_success
2. role_spec_failure
3. careers_url_attempts
4. careers_url_selected
5. platform_detected
6. extractor_selected
7. finalization_outcome
8. restart_recovery_reclaim
9. run_completed

Trace events must be emitted only after the related durable state change succeeds when the event describes a state transition.

## Restart recovery

The app must be restart safe.

On startup, before normal claiming begins:

1. Find active runs with status READY or RUNNING.
2. Find IN_PROGRESS companies in those runs whose started_at is older than the stale threshold.
3. Reset stale IN_PROGRESS companies to PENDING.
4. Clear started_at.
5. Clear worker_token.
6. Emit restart_recovery_reclaim for rows actually reset.

Restart recovery MUST NOT:

1. Modify MATCHES_FOUND.
2. Modify NO_MATCH_SCAN_COMPLETED.
3. Modify UNVERIFIED.
4. Modify CANCELLED.
5. Create new company rows.
6. Reprocess final companies.

Stale role specification attempts should be recoverable through role_spec_started_at.

If a run is CREATED, role_spec_json is null, and role_spec_started_at is stale or stuck, the system should allow role spec generation to be attempted safely according to current timeout logic.

## UI contract

The UI renders backend persisted state only.

The UI must not invent state.

The UI must not infer final outcomes from incomplete local assumptions.

The UI should:

1. Submit POST /api/runs.
2. Navigate to /runs/:runId.
3. Poll GET /api/runs/:runId.
4. Render companies in stable input order.
5. Keep PENDING and IN_PROGRESS rows visible while the run is active.
6. Derive result sections strictly from company.status.
7. Show failure_reason when available.
8. Show careers_url when available.
9. Show evidence fields when useful.

When run.status is FAILED_ROLE_SPEC:

1. Show a terminal run error.
2. Use run.error_message.
3. Do not render normal Matches, No Match, and Unverified lists as if scanning happened.
4. Companies may be shown for transparency, but they should show CANCELLED and the role spec failure reason.

CANCELLED is a real status and must not be ignored.

## CSV export contract

CSV export is part of the completed run view.

Export buttons should show only when run.status is COMPLETED.

Required exports:

1. Matches CSV
2. No Match CSV
3. Unverified CSV
4. Combined CSV

Exports must be derived from persisted backend state.

Exports must not invent fields.

Ordering must preserve company input order using input_index ascending.

Matches exports include company evidence fields plus matched job fields.

No Match and Unverified exports include company evidence and failure fields.

Combined export includes all company rows and job fields when matched jobs exist.

Companies with no matched jobs must still appear in the appropriate non match export.

## Module responsibility boundaries

Preserve these boundaries unless explicitly asked to modularize:

1. API run creation

Validates input and durably creates run state only.

2. GET run detail

Returns persisted run, company, and matched job state.

3. Worker loop

Owns polling, role spec initialization, claiming, processing, completion checks, and restart recovery.

4. Role spec generation

The only LLM boundary in the current scanner.

5. Discovery

Finds the official careers URL or supported ATS URL.

6. Platform detection

Performs deterministic ATS classification.

7. Extractor selection

Chooses the extractor and persists extractor_used.

8. Extraction

Retrieves job postings and completion evidence.

9. Matching

Performs deterministic title matching against RoleSpec.

10. Company finalization

Computes and persists the final company outcome.

11. Trace events

Provide durable debugging and evidence of key decisions.

12. Restart recovery

Reclaims stale active work without duplicating finalized work.

13. UI

Renders persisted backend state only.

14. CSV export

Exports completed run data from persisted backend state only.

Do not blur API, worker, extraction, matching, finalization, and UI responsibilities.

## Hard scanner rules

These are hard constraints:

1. API creates runs only.
2. Worker owns state transitions after creation.
3. Database is the source of truth for queued and active work.
4. Backend persisted state is the source of truth for UI display.
5. UI never invents state.
6. Matching is deterministic.
7. LLM use is limited to RoleSpec generation in the current scanner.
8. No company may start processing without valid role_spec_json.
9. Only official company careers surfaces and associated ATS systems are authoritative.
10. Job boards are not authoritative sources.
11. Company list is capped at ten companies per run.
12. Concurrency is limited to two.
13. Once finalized, a company is never reprocessed for that run.
14. If scan completion is uncertain, the company is UNVERIFIED.
15. NO_MATCH_SCAN_COMPLETED is allowed only when extraction completed and zero matches were found.
16. Trace events must exist.
17. Restart recovery must reset stale IN_PROGRESS work safely.
18. Restart recovery must not touch final companies.
19. Future agent functionality must not be added unless explicitly requested.

## Future product direction

Surveyor may later evolve into a private AI assisted job search workflow.

Future Surveyor may include:

1. User accounts
2. User profile memory
3. Resume memory
4. Saved role preferences
5. Saved companies
6. Saved searches
7. Job detail ingestion
8. Job description analysis
9. Application packet generation
10. Resume tailoring
11. Cover letter drafting
12. Company specific application preparation
13. Application tracking
14. Continuous monitoring of saved companies
15. Notifications when relevant jobs appear
16. Agent workflows that coordinate multiple job search steps
17. Future referral intelligence as a parking lot item only

These are not active implementation scope.

Do not implement these during scanner work unless explicitly requested.

Do not add database tables for accounts, profiles, resumes, saved companies, saved searches, applications, monitoring, notifications, or referrals unless explicitly requested.

Do not refactor the current scanner around future agent assumptions unless explicitly requested.

Do not add authentication unless explicitly requested.

Do not turn the current scanner into a background monitoring agent unless explicitly requested.

## Scanner to agent relationship

The current scanner is the verification engine.

The future agent layer is the action engine.

The scanner answers:

Are there verified relevant openings at these target companies?

The future agent layer answers:

Given who the user is, which openings are worth acting on, what is missing, and what application materials should the user prepare?

The future agent must not:

1. Change scanner finalization rules.
2. Change scanner result buckets.
3. Treat uncertain scans as verified opportunities.
4. Convert UNVERIFIED into NO_MATCH_SCAN_COMPLETED.
5. Use job boards as authoritative sources unless the product contract is explicitly changed.
6. Hide uncertainty from the user.
7. Submit applications automatically.
8. Contact recruiters automatically.
9. Invent user background.

## Agent expansion gate

Do not begin Agent Expansion until:

1. Scanner bugs are tightened.
2. Discovery and extraction confidence are reliable.
3. Lifecycle and finalization are reliable.
4. Trace events explain scanner decisions.
5. Job detail ingestion exists or is being intentionally added as the bridge into agent work.

If these are not true, finish scanner readiness first.

Job detail ingestion is the bridge from scanner to agent work because application packet generation needs full job description text, not only title, location, URL, and match reason.

Job detail ingestion, when intentionally added, must not change scanner final company status.

## Future agent concepts

Future agent expansion may eventually support:

1. Accounts
2. Private user profile memory
3. Resume storage or resume text storage
4. Job detail ingestion
5. Agent run persistence
6. Application Packet Agent
7. Saved companies
8. Saved searches
9. Continuous Monitoring Agent
10. Application tracking
11. Privacy and safety hardening

These are not active implementation instructions.

Do not copy phase details from the Agent Expansion Roadmap into normal scanner tasks.

Use the roadmap only after the readiness gate is passed or when the user explicitly asks for planning.

## Referral intelligence boundary

Referral intelligence is parked.

Do not design or implement:

1. Social graph
2. Mutual connections
3. Private contact input
4. User networking
5. Referral systems
6. Public profiles
7. Social feeds
8. Referral request automation

Preserve only enough architectural awareness to avoid blocking possible future referral intelligence later.

Future compatible choices:

1. Companies may eventually become normalized entities.
2. Applications may eventually be tied to companies and jobs.
3. User accounts should remain private by default if added later.
4. Relationship data should not be required by the core product.

No referral source is approved now.

No referral behavior should be implemented now.

## Product spine for future planning

The long term product spine is:

1. Verified opportunities
2. Grounded fit analysis
3. Truthful application materials
4. User controlled next actions

A future feature is aligned when it helps the user find a real opportunity, understand fit, prepare truthful materials, or manage the application process.

A future feature is not aligned when it mainly creates social engagement, broad browsing, vanity metrics, uncontrolled AI generated text, or networking complexity.

## Final operating principle

Surveyor moves in two layers.

Layer 1 is the Core Scanner.

It is stable, conservative, deterministic, evidence based, and narrow.

Layer 2 is the Future Agent Workflow.

It is broader, user aware, account based, application aware, and eventually more autonomous.

Do not mix the two layers prematurely.

Finish and protect the scanner foundation first.

Use the agent direction as product context, not as permission to contaminate the current implementation.
