# Surveyor Pre Agent Expansion Readiness Pass

## Purpose

This document defines the final practical readiness pass before Surveyor moves from the Core Scanner MVP into the Agent Expansion phase.

The goal is not to redesign Surveyor.

The goal is to confirm that the Core Scanner is reliable enough to become the trusted data source for future AI agent features.

Future agent features may include:

1. Accounts
2. Resume and profile memory
3. Job detail understanding
4. Application packet generation
5. Saved companies
6. Continuous monitoring
7. Application tracking
8. Future referral intelligence as a parking lot item only

This pass must protect the current scanner architecture.

The Core Scanner must remain conservative, deterministic after role spec generation, and evidence based.

## Current scope rule

The following documents are authoritative for the Core Scanner:

1. CLAUDE.md
2. operatingContext.md
3. modularizationPlan.md

Do not rewrite these documents as part of this pass.

Do not add future agent features into the Core Scanner.

This pass only answers:

Is the scanner stable enough to support the next phase?

## Regression safety net prerequisite

Before starting Gate 1, all four commands must pass:

```bash
npm test --workspace=apps/api
npm test --workspace=apps/web
npm run build --workspace=apps/api
npm run build --workspace=apps/web
```

The regression safety net and modularization pass are already complete. Do not weaken, delete, skip, or bypass any regression tests to make readiness fixes pass. If a regression test fails after a change, treat it as a possible behavior change until proven otherwise.

Do not start Gate 1 until all four commands pass cleanly.

## Definition of ready

Surveyor is ready for Agent Expansion when all of the following are true:

1. Discovery does not select unrelated or non authoritative pages.
2. Extraction completion is strict.
3. Uncertain scans become UNVERIFIED.
4. NO_MATCH_SCAN_COMPLETED only happens after confident completed extraction.
5. Runs and companies finalize correctly.
6. Trace events explain the scanner decision path.
7. Matched jobs can store or attempt to store full job description text.
8. Job detail failure does not change company final status.
9. No accounts, profile memory, monitoring, or application packet agent logic has been added yet.

## Non goals

Do not build these in this pass:

1. Accounts
2. Login
3. Resume upload
4. Profile memory
5. Application packet generation
6. Continuous monitoring
7. Saved companies
8. Application tracking
9. Social graph
10. Referral intelligence
11. Browser automation for applications
12. Big dashboard redesign
13. New product strategy docs

# Gate 1: Scanner readiness audit

## Step 1.1: Create a safety branch

Create a new branch.

Suggested branch name:

pre-agent-readiness

## Step 1.2: Run an audit only

Use this prompt in Claude Code, Codex, Cursor, or Kiro.

Prompt:

Read the current Surveyor codebase and the authoritative docs.

Authoritative docs:

1. CLAUDE.md
2. operatingContext.md
3. modularizationPlan.md

Task:
Perform a scanner readiness audit before Agent Expansion.

Do not modify code.

Check these areas:

1. Discovery correctness

Confirm that discovery only accepts official company careers surfaces or clearly associated supported ATS surfaces.

Confirm that job boards or aggregators are not treated as authoritative sources.

Confirm that Reddit style cases do not incorrectly choose unrelated pages such as product catalog pages.

Confirm that a careers landing page with ATS signals is not automatically treated as a completed listings surface unless listings are actually enumerable.

2. Extraction confidence

Confirm that extraction does not treat one or two weak job like links as completed extraction.

Confirm that caps, timeouts, unsupported platforms, blocked pages, JavaScript failures, and incomplete enumeration force completed false.

Confirm that completed false always leads to UNVERIFIED.

Confirm that NO_MATCH_SCAN_COMPLETED only happens when extraction completed confidently and matched jobs length is zero.

3. Reddit edge case

Check the current behavior for Reddit or the closest available complex careers page test.

Confirm:

1. The selected careers URL is correct.
2. The listings source is correct.
3. Jobs are not assigned the wrong location.
4. The Gen AI Platform role and Amsterdam Product Catalog role are not mixed together.
5. The UI output matches persisted backend state.
6. The trace explains what happened.

7. Trace clarity

Confirm that trace events are enough to explain the result without guessing.

Expected trace coverage:

1. role_spec_success or role_spec_failure
2. careers_url_attempts
3. careers_url_selected when a URL is selected
4. platform_detected
5. extractor_selected
6. extractor_attempt_started if implemented
7. extractor_attempt_finished if implemented
8. finalization_outcome
9. run_completed

10. Lifecycle reliability

Confirm:

1. POST /runs only creates persisted state.
2. Worker owns transitions after creation.
3. Role spec generation gates company processing.
4. Companies are claimed transactionally.
5. Worker token ownership is enforced.
6. Finalization updates the existing claimed row only.
7. Finalized companies are never reprocessed.
8. Runs complete when all companies are final.
9. Restart recovery does not touch final companies.

Return a pass or fail table.

For every fail, include:

1. File path
2. Function name
3. Reason it fails
4. Smallest safe fix
5. Whether it blocks Agent Expansion

Do not suggest broad refactors.
Do not add future agent features.
Do not change the product scope.

## Step 1.3: Classify audit findings

Use this blocker rule.

Blocking issues:

1. Wrong careers URL selection
2. Unrelated page selected as authoritative
3. False NO_MATCH_SCAN_COMPLETED
4. Weak extraction treated as completed
5. Uncertain extraction not becoming UNVERIFIED
6. Company finalization not reliable
7. Run completion not reliable
8. Trace missing enough information to debug scanner decisions
9. Reddit style title, location, or listing mixup still present

Non blocking issues:

1. Trace wording could be clearer but still explains the result
2. UI formatting could be cleaner
3. CSV could include more fields later
4. Minor cleanup
5. Cosmetic naming issues

## Gate 1 exit rule

If there are scanner blockers, do not start job detail ingestion yet.

Move to Gate 2.

If there are no scanner blockers, move to Gate 3.

# Gate 2: Fix scanner blockers only

## Step 2.1: Implement only blocking fixes

Use this prompt.

Prompt:

Apply only the blocking fixes from the scanner readiness audit.

Constraints:

1. Do not refactor unrelated code.
2. Do not change the current MVP product scope.
3. Do not add accounts.
4. Do not add resume features.
5. Do not add agent features.
6. Do not change persisted status values.
7. Do not introduce new final company states.
8. Preserve the rule that uncertainty becomes UNVERIFIED.
9. Preserve deterministic matching.
10. Preserve official careers surface policy.
11. Keep the app runnable after the change.
12. Do not weaken, delete, skip, or bypass regression tests to make blocking fixes pass. If a regression test fails after a fix, treat it as a possible behavior change until proven otherwise.

Required behavior:

1. Discovery must not accept unrelated pages as authoritative careers surfaces.
2. ATS references on a landing page must not automatically prove completed listings enumeration.
3. Extraction must only return completed true when the listings surface was confidently enumerated.
4. completed false must always finalize as UNVERIFIED.
5. NO_MATCH_SCAN_COMPLETED must only happen when extraction completed true and matched jobs length is zero.
6. Trace events must be clear enough to explain why each company finalized.

Add or update tests for each bug fixed.

Return:

1. Files changed
2. Behavior changed
3. Tests added
4. Commands to run
5. Remaining risks

## Step 2.2: Minimum scanner acceptance scenarios

The scanner is accepted only if these scenarios behave correctly.

Scenario 1: Clear match

Input:
A company with a reachable careers page and a matching role.

Expected:

1. Company finalizes as MATCHES_FOUND.
2. Matched jobs are persisted.
3. listings_scanned is greater than zero.
4. finalization_outcome trace exists.

Scenario 2: Clear no match

Input:
A company with a reachable careers page where extraction completes confidently but no jobs match.

Expected:

1. Company finalizes as NO_MATCH_SCAN_COMPLETED.
2. failure_code is null.
3. failure_reason is null.
4. finalization_outcome trace exists.

Scenario 3: Uncertain extraction

Input:
A page with weak job like links, blocked content, unsupported content, cap reached, or incomplete enumeration.

Expected:

1. Company finalizes as UNVERIFIED.
2. failure_code is populated.
3. failure_reason is populated.
4. The system does not call this NO_MATCH_SCAN_COMPLETED.

Scenario 4: Discovery failure

Input:
A company where no official careers surface or clearly associated ATS surface can be found.

Expected:

1. Company finalizes as UNVERIFIED.
2. failure_code is CAREERS_NOT_FOUND.
3. careers_url_selected is not emitted.
4. finalization_outcome trace exists.

Scenario 5: Reddit style edge case

Input:
Reddit or the closest available complex careers page test.

Expected:

1. The system does not confuse unrelated pages with the careers surface.
2. The system does not mix titles and locations from different postings.
3. The system does not produce NO_MATCH_SCAN_COMPLETED unless extraction completed confidently.
4. The trace makes the selected URL and extractor decision understandable.

## Gate 2 exit rule

After scanner blockers are fixed, repeat Gate 1 audit.

If blocker issues remain, stop and fix those first.

If no blocker issues remain, move to Gate 3.

# Gate 3: Minimal job detail ingestion

## Positioning note

Minimal job detail ingestion is not Agent Expansion itself.

It is the final scanner-adjacent prerequisite before Agent Expansion begins. Future agent features — particularly the Application Packet Agent — require full job description text or a recorded fetch failure per matched job. Without this layer, agent features would have to implement their own ad hoc fetching, which creates duplication and because future agent features should rely on stored job detail evidence, not fetch job descriptions ad hoc during agent execution.

This gate completes the scanner's output contract. Agent Expansion starts after Gate 4 passes.

## Why this matters

The future Application Packet Agent cannot work well with only:

1. Job title
2. Location
3. URL
4. Match reason

It needs the full job description or at least a recorded attempt to fetch it.

This pass adds the smallest useful job detail layer.

## Important rule

Job detail ingestion must not decide company status.

Company status is still controlled only by discovery, extraction, matching, and finalization.

If job detail fetching fails, the matched job should still exist.

A job detail failure must not change a company from MATCHES_FOUND to UNVERIFIED.

## Step 3.1: Add minimal schema

Add a new table.

Table:

job_details

Fields:

1. id TEXT PRIMARY KEY
2. run_id TEXT NOT NULL
3. company_id TEXT NOT NULL
4. job_row_id TEXT NOT NULL
5. job_url TEXT NOT NULL
6. description_text TEXT NULL
7. fetched_at INTEGER NULL
8. failure_code TEXT NULL
9. failure_reason TEXT NULL
10. created_at INTEGER NOT NULL

Indexes:

1. idx_job_details_run_id
2. idx_job_details_company_id

Uniqueness:

There must be a UNIQUE constraint or unique index on job_row_id so at most one job_details row exists per job_row_id.

Do not rely on a normal index for this rule. The schema must enforce uniqueness at the database level.

Reason:
This keeps job_rows stable, prevents duplicate detail rows on repeated ingestion passes, and leaves room for a later durable job_posts table.

## Step 3.2: Add a job detail fetcher

Create:

apps/api/src/lib/jobDetails.ts

Function:

fetchJobDetailText(jobUrl)

Return shape:

{
description_text: string | null,
failure_code: string | null,
failure_reason: string | null
}

Rules:

1. HTTP only.
2. No LLM.
3. No Playwright in this first slice.
4. Use the existing request timeout pattern if available.
5. Remove script, style, nav, footer, and obvious boilerplate when practical.
6. Normalize whitespace.
7. Cap stored text length.
8. Return failure fields instead of throwing uncontrolled errors.

Suggested failure codes:

1. JOB_DETAIL_FETCH_FAILED
2. JOB_DETAIL_EMPTY
3. JOB_DETAIL_BLOCKED
4. JOB_DETAIL_TIMEOUT

## Step 3.3: Wire ingestion after matched job persistence

After matched job rows are created and the company finalization transaction has successfully committed:

1. Query matched job rows for that company.
2. For each matched job, check whether a job_details row already exists for that job_row_id.
3. If a job_details row already exists, skip fetching and inserting for that job.
4. If none exists, fetch the job detail.
5. Insert one job_details row.
6. Store either description_text or failure fields.
7. Do not change company status if fetching fails.

Idempotency rule:
Running job detail ingestion more than once must not create duplicate job_details rows. If a job_details row already exists for a job_row_id, skip fetching and inserting for that job. The UNIQUE constraint on job_row_id enforces this at the database level as a final guard.

Important:
Do not fetch job details inside the company finalization transaction.

Reason:
Company finalization should stay fast, atomic, and scanner focused.

## Step 3.4: Add API visibility

Keep GET /api/runs/:runId lightweight.

Add these fields to matched job output in the run detail response:

1. job_detail_available: boolean
2. job_detail_failure_code: string or null
3. job_detail_failure_reason: string or null

Do not include full job_description_text in GET run detail by default. Full description text is potentially large and is not needed by the run list or status UI.

Expose full description text through a dedicated endpoint:

GET /api/jobs/:jobRowId/detail

Return:

1. job_row_id
2. job_url
3. description_text
4. failure_code
5. failure_reason
6. fetched_at

## Step 3.5: Implementation prompt

Prompt:

Add minimal job detail ingestion for matched jobs.

Constraints:

1. Do not add accounts.
2. Do not add resume upload.
3. Do not add profile memory.
4. Do not add application packet generation.
5. Do not use the LLM.
6. Do not change company finalization rules.
7. Do not make job detail fetch failure affect MATCHES_FOUND.
8. Do not fetch job details inside the company finalization transaction.
9. Do not refactor the scanner pipeline broadly.

Implementation requirements:

1. Add a job_details table with indexes.
2. Enforce at most one job_details row per job_row_id.
3. Add a job detail fetching module.
4. Fetch and store descriptions for matched job rows after successful company finalization.
5. Store failure_code and failure_reason when description fetching fails.
6. Prevent duplicate job_details rows for the same job_row_id.
7. Expose job detail availability through the API.
8. Add tests for success and failure cases.

Acceptance criteria:

1. A matched job can have a stored job detail row.
2. A failed detail fetch stores failure fields.
3. Company status remains MATCHES_FOUND even if job detail fetch fails.
4. Existing scanner results still render.
5. Existing CSV export still works or is intentionally unchanged.
6. No agent features are added.

Return:

1. Files changed
2. Schema changes
3. New tests
4. Commands to run
5. Known limitations

## Gate 3 exit rule

Job detail ingestion is accepted if:

1. Matched jobs get job_details rows.
2. Detail fetch failures are stored.
3. Company final status is not affected.
4. Existing scanner behavior remains unchanged.
5. Tests pass.

# Gate 4: Final readiness verification

## Step 4.1: Manual run

Run the app manually.

Check:

1. Start backend.
2. Start frontend.
3. Submit a run with one or two companies.
4. Use a role likely to produce at least one match.
5. Confirm the UI shows the correct company state.
6. Confirm the matched job has job detail availability or a detail failure reason.
7. Confirm CSV export still works if the run is completed.

## Step 4.2: Database inspection

Check:

1. runs has the correct final status.
2. run_companies has final company statuses.
3. job_rows has matched jobs when matches exist.
4. job_details has one row per matched job detail attempt.
5. trace_events explains the scanner result.

## Step 4.3: Final verification prompt

Prompt:

Perform a final readiness verification.

Do not modify code unless there is a clear blocking bug.

Check:

1. Scanner uses UNVERIFIED whenever completion is uncertain.
2. NO_MATCH_SCAN_COMPLETED only happens after confident completed extraction.
3. Runs complete correctly.
4. Companies finalize exactly once.
5. Trace events explain discovery, platform detection, extractor choice, and finalization.
6. Job detail ingestion stores descriptions or failure reasons for matched jobs.
7. Job detail failures do not affect company final status.
8. No accounts, resume memory, application packet generation, monitoring, or referral features were introduced.

Return:

1. Pass or fail
2. Remaining blockers if any
3. Non blocking cleanup items if any
4. Whether Surveyor is ready to start Agent Expansion

# Final ready state

Surveyor is ready to start Agent Expansion when:

1. The scanner no longer produces false confident results.
2. Discovery does not select unrelated pages.
3. Extraction confidence is strict.
4. Runs and companies finalize reliably.
5. Trace events explain outcomes.
6. Matched jobs can have job description text or a recorded detail fetch failure.
7. The app still preserves the Core Scanner MVP rules.
8. No future agent features have been prematurely mixed into the scanner.

At that point, the next phase can start:

1. Data platform and ownership foundation
2. Accounts
3. Profile and resume memory
4. Application Packet Agent
5. Saved companies and searches
6. Continuous monitoring
7. Application tracking
8. Referral intelligence remains parked
