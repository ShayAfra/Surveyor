# Surveyor Core Scanner Modularization Plan

## Purpose

This document defines a small behavior preserving modularization pass for the current Surveyor Core Scanner.

The goal is not to redesign Surveyor.

The goal is to make the existing scanner easier to audit, test, and extend before the Pre Agent Expansion Readiness pass.

This modularization pass should reduce file level tangling while preserving the current lifecycle, API contracts, database schema, persisted statuses, worker ownership model, trace behavior, and scanner outcomes.

## Authority

The current Core Scanner documents remain authoritative:

1. `CLAUDE.md`
2. `operatingContext.md`

This document does not replace those files.

This document is only a refactor plan for improving code organization before the readiness checklist.

If this document conflicts with the existing Core Scanner lifecycle or decision docs, the existing Core Scanner docs win.

## Regression Safety Net Prerequisite

Modularization may only begin after all four of these pass cleanly:

```bash
npm test --workspace=apps/api
npm test --workspace=apps/web
npm run build --workspace=apps/api
npm run build --workspace=apps/web
```

The regression safety sprint added backend lifecycle tests, API contract tests, trace tests, role spec tests, matching tests, and CSV export tests. All of these must remain green throughout the modularization pass.

### Test protection rule

During modularization, do not weaken, delete, skip, or bypass regression tests to make refactors pass.

If a test fails after a modularization change, treat it as a possible behavior change until proven otherwise. Investigate the failure before continuing.

### roleSpec guardrail

Do not change `roleSpec` behavior during modularization.

Specifically, do not reintroduce raw role prepending, title deduping, relaxed validation, or any LLM behavior changes. If any of these need revisiting, handle them as a separate explicit behavior change with its own review — not as a side effect of modularization.

### DB_PATH guardrail

Do not change `DB_PATH=":memory:"` handling during modularization.

The test database must remain true in-memory SQLite or an explicitly approved isolated temp database. Do not allow tests to create `apps/api/:memory:` as a file path on disk.

## Git checkpoint requirement

Start modularization from a clean committed checkpoint.

Do not mix unrelated cleanup, docs cleanup, test sprint changes, or product work into modularization commits. Each modularization slice should be independently reviewable and revertable.

## CTO framing

The current scanner is behavior sensitive.

Discovery, extraction confidence, company finalization, worker ownership, and trace evidence are the trust layer of the product. These areas should not be casually rewritten.

The purpose of modularization is to make the scanner easier to reason about, not to make it more abstract.

A successful modularization pass should allow a future agent or human reviewer to answer these questions faster:

1. Where is run creation handled?
2. Where is run detail assembled?
3. Where is the worker loop?
4. Where is company claiming?
5. Where does each pipeline stage begin and end?
6. Where is company finalization committed?
7. Where are trace events constructed and written?
8. Where are scanner outcomes decided?

## Non goals

Do not build or modify these in this pass:

1. Accounts
2. Login
3. Resume upload
4. User profile memory
5. Application packet agent
6. Saved companies
7. Continuous monitoring
8. Application tracking
9. Referral intelligence
10. Agent runs
11. Job detail ingestion
12. Product dashboard redesign
13. New scanner behavior
14. New discovery strategy
15. New extraction strategy
16. New persisted statuses
17. New final company states
18. New API response contract

## Core rule

Every step in this plan must be behavior preserving.

The expected result after each step is:

1. The app still runs.
2. Existing tests still pass.
3. API response shapes are unchanged.
4. Database schema is unchanged.
5. Persisted status values are unchanged.
6. Worker ownership rules are unchanged.
7. Trace event write interface is unchanged.
8. Company finalization behavior is unchanged.
9. Uncertainty still becomes `UNVERIFIED`.
10. `NO_MATCH_SCAN_COMPLETED` still only means extraction completed confidently and no jobs matched.

## Current responsibility map

The audit found the following responsibility layout.

| Responsibility       | Current location                                 | Current isolation                                                |
| -------------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| API run creation     | `server.ts`                                      | Tangled with route setup, validation, SQL, and transaction logic |
| GET run detail       | `server.ts`                                      | Tangled with route setup and response assembly                   |
| Worker loop          | `startWorkerLoop.ts`                             | Cleanly isolated                                                 |
| Role spec generation | `roleSpec.ts`, `runRoleSpecInitialization.ts`    | Mostly clean                                                     |
| Company claiming     | `claimNextCompany.ts`                            | Cleanly isolated                                                 |
| Discovery            | `discovery.ts`, `processClaimedCompany.ts`       | Tangled at orchestration layer                                   |
| Platform detection   | `platform.ts`, `processClaimedCompany.ts`        | Core detection clean, orchestration tangled                      |
| Extractor selection  | `extraction.ts`, `processClaimedCompany.ts`      | Tangled at orchestration layer                                   |
| Extraction           | `extraction.ts`, `processClaimedCompany.ts`      | Tangled at orchestration layer                                   |
| Matching             | `matching.ts`                                    | Cleanly isolated                                                 |
| Company finalization | `finalizeCompany.ts`, `processClaimedCompany.ts` | Mostly clean, outcome wiring still in caller                     |
| Run completion       | `tryCompleteRun.ts`                              | Cleanly isolated                                                 |
| Trace events         | `trace.ts`, scattered call sites                 | Write interface clean, event construction scattered              |
| Restart recovery     | `restartRecovery.ts`                             | Cleanly isolated                                                 |

## Modularization strategy

The safest plan is to modularize from the outside inward.

Do the lowest risk extraction first.

Do not start by rewriting discovery or extraction internals.

The order should be:

1. Extract API route and service boundaries from `server.ts`. POST `/api/runs` and GET `/api/runs/:runId` may be combined into a single API route extraction pass if the baseline is green and both routes can be moved without behavioral risk.
2. Extract run detail response assembly helpers.
3. Centralize trace event names and builder helpers without changing `writeTraceEvent`. This step is optional — see trace centralization note below.
4. Extract pipeline stage wrappers from `processClaimedCompany.ts`.
5. Only after wrappers exist, consider small cleanup inside `processClaimedCompany.ts`.
6. Leave discovery and extraction internals mostly intact until after the Pre Agent Expansion Readiness pass.

## Files that should mostly stay as is

These files already match the documented lifecycle reasonably well and should not be refactored unless a direct import path update is needed:

1. `startWorkerLoop.ts`
2. `claimNextCompany.ts`
3. `runRoleSpecInitialization.ts`
4. `tryCompleteRun.ts`
5. `restartRecovery.ts`
6. `matching.ts`
7. `roleSpec.ts`

These files may be touched only if needed to update imports or keep tests passing.

## Files that are safe to modularize

These are the safest targets:

1. `server.ts`
2. Run creation logic currently inside `server.ts`
3. Run detail response assembly currently inside `server.ts`
4. Trace event construction call sites
5. Stage orchestration currently inside `processClaimedCompany.ts`

## Files that are behavior sensitive

These should not be broadly rewritten in this pass:

1. `discovery.ts`
2. `extraction.ts`
3. `finalizeCompany.ts`
4. `processClaimedCompany.ts`

The goal for these files is to wrap and clarify boundaries, not to change discovery, extraction, fallback, matching, or finalization semantics.

# Step 0: Baseline verification

## Goal

Make sure the current app state is known before refactoring.

## Instructions

Before making any changes, run all four of these commands and record their results:

```bash
npm test --workspace=apps/api
npm test --workspace=apps/web
npm run build --workspace=apps/api
npm run build --workspace=apps/web
```

All four must pass before implementation begins. If any command fails, do not proceed with modularization. Investigate and resolve the failure first.

## Acceptance criteria

1. Current baseline result is recorded for all four commands.
2. Any pre existing failing tests are noted.
3. No code changes are made in this step.

## Suggested prompt

```text
Read the current Surveyor codebase.

Task:
Establish a baseline before modularization.

Do not modify code.

Run the following four commands and record their results:
1. npm test --workspace=apps/api
2. npm test --workspace=apps/web
3. npm run build --workspace=apps/api
4. npm run build --workspace=apps/web

Return:
1. Commands run
2. Results for each command
3. Any pre existing failures
4. Whether all four pass and it is safe to begin behavior preserving modularization

Do not suggest product changes.
Do not refactor anything.
```

# Step 1: Extract API run creation from server.ts

## Goal

Move POST `/api/runs` logic out of `server.ts` while preserving behavior exactly.

## Reason

The API currently mixes route setup, validation, SQL preparation, transaction logic, and response handling in one file. This makes the scanner harder to audit.

## Target boundary

Create a small route or service module such as:

1. `apps/api/src/routes/runs.ts`
2. `apps/api/src/services/createRun.ts`

Exact names can follow the current project convention.

## Required behavior preservation

The extracted code must preserve:

1. Request body shape:
   1. `role`
   2. `includeAdjacent`
   3. `companies`
2. Validation rules:
   1. role must be non-empty after trimming
   2. companies length must be between 1 and 10
   3. each company string must be trimmed
   4. empty company entries after trimming must reject the request
   5. entries must not be silently dropped
3. Transaction behavior:
   1. insert one `runs` row
   2. insert exactly one `run_companies` row per company
   3. preserve `input_index`
   4. run status starts as `CREATED`
   5. company status starts as `PENDING`
4. Response shape:
   1. `{ runId: string }`
5. Lifecycle rule:
   1. POST `/api/runs` must not generate role spec
   2. POST `/api/runs` must not start scanning
   3. POST `/api/runs` must not update run or company statuses after creation

## Acceptance criteria

1. `server.ts` still registers the route.
2. Run creation behavior is unchanged.
3. API response shape is unchanged.
4. No database schema change.
5. No status value change.
6. Existing tests pass or the same pre existing failures remain.

## Implementation prompt

```text
Refactor only POST /api/runs out of server.ts.

Goal:
Move run creation logic into a dedicated route or service module while preserving behavior exactly.

Constraints:
1. Do not change the request body contract.
2. Do not change the response shape.
3. Do not change validation behavior.
4. Do not change database schema.
5. Do not change persisted status values.
6. Do not generate role spec inline.
7. Do not start worker processing inline.
8. Do not modify worker code.
9. Do not add product features.
10. Keep the app runnable.

Requirements:
1. Extract the run creation code from server.ts.
2. Preserve the transaction behavior exactly.
3. Preserve company input order through input_index.
4. Preserve the 10 company cap.
5. Preserve rejection of empty trimmed company entries.
6. Update imports only as needed.
7. Add or update tests only if existing test structure supports it.

Return:
1. Files changed
2. Behavior preserved
3. Commands to run
4. Any risks or uncertainty
```

# Step 2: Extract GET run detail from server.ts

## Goal

Move GET `/api/runs/:runId` logic out of `server.ts` while preserving the exact `RunDetailResponse`.

## Reason

Run detail assembly is an important API contract and should be easy to inspect before adding future job detail or agent facing data.

## Target boundary

Create a module such as:

1. `apps/api/src/services/getRunDetail.ts`
2. `apps/api/src/routes/runs.ts`
3. `apps/api/src/mappers/runDetailMapper.ts`

Exact names can follow the current project convention.

## Required behavior preservation

The extracted code must preserve:

1. Response shape exactly:
   1. `run`
   2. `companies`
   3. `matched_jobs`
2. Company ordering:
   1. `input_index ASC`
3. Matched jobs ordering:
   1. company `input_index ASC`
   2. job row id ASC
4. Required fields:
   1. run error fields
   2. company evidence fields
   3. matched job fields
5. Status and ATS enum values exactly as persisted.

## Acceptance criteria

1. GET `/api/runs/:runId` still returns the same shape.
2. Ordering is unchanged.
3. No response fields are removed.
4. No new fields are added in this pass.
5. Existing scanner UI still renders.

## Implementation prompt

```text
Refactor only GET /api/runs/:runId out of server.ts.

Goal:
Move run detail retrieval and response assembly into a dedicated module while preserving the API contract exactly.

Constraints:
1. Do not change RunDetailResponse shape.
2. Do not add fields.
3. Do not remove fields.
4. Do not change ordering.
5. Do not change database schema.
6. Do not change status values.
7. Do not modify worker behavior.
8. Do not add job detail ingestion yet.
9. Do not add accounts or agent features.

Requirements:
1. Extract GET run detail logic from server.ts.
2. Preserve companies ordered by input_index ASC.
3. Preserve matched_jobs ordered by company input_index ASC, then id ASC.
4. Keep server.ts responsible only for registering routes and starting the app as much as practical.
5. Add or update tests only if existing test structure supports it.

Return:
1. Files changed
2. Behavior preserved
3. Commands to run
4. Any risks or uncertainty
```

# Step 3: Centralize trace event names and builders (optional)

## Goal

Reduce scattered trace event construction while preserving the existing `writeTraceEvent` interface and payload contents.

This step is optional. Only perform it if event names, payload contents, run scoped versus company scoped behavior, and timing can be preserved exactly. If there is any uncertainty about preserving exact trace behavior, leave the trace call sites alone and skip this step.

## Reason

Trace events are how scanner decisions are explained. The write interface is already clean, but event construction is scattered across the worker and lib files.

This step should make trace usage easier to inspect without changing what is emitted.

## Target boundary

Create a module such as:

1. `apps/api/src/lib/traceEvents.ts`
2. `apps/api/src/lib/traceBuilders.ts`

Exact names can follow the current project convention.

## Required behavior preservation

Do not change:

1. `writeTraceEvent` function signature
2. `trace_events` table schema
3. event names
4. payload field names
5. payload contents
6. run scoped versus company scoped behavior
7. created_at behavior
8. timing rule that finalization trace is emitted only after commit

## Recommended helper shape

Helpers can be simple functions that return event objects compatible with `writeTraceEvent`.

Example shape:

```ts
buildFinalizationOutcomeTrace(...)
buildExtractorSelectedTrace(...)
buildPlatformDetectedTrace(...)
buildCareersUrlAttemptsTrace(...)
buildCareersUrlSelectedTrace(...)
```

The helpers should not write directly unless the codebase convention makes that cleaner.

The key rule is that `writeTraceEvent` remains the only persistence boundary.

## Acceptance criteria

1. `writeTraceEvent` remains the sole trace write interface.
2. Event names are unchanged.
3. Payload contents are unchanged.
4. Existing trace tests or manual trace inspection still pass.
5. No scanner behavior changes.
6. If exact preservation is uncertain, skip this step entirely rather than risk trace drift.

## Implementation prompt

```text
Centralize trace event names and builder helpers without changing emitted trace behavior.

Important: this step is optional. Only proceed if you can confirm that event names, payload contents, run scoped versus company scoped behavior, and timing are preserved exactly. If uncertain, leave trace call sites unchanged and skip this step.

Constraints:
1. Do not change writeTraceEvent signature.
2. Do not create a second trace write API.
3. Do not change trace_events schema.
4. Do not change event_type values.
5. Do not change payload_json field names or contents.
6. Do not change when events are emitted.
7. Do not change run scoped versus company scoped behavior.
8. Do not change scanner behavior.

Requirements:
1. Add a small trace event helper module.
2. Move repeated event_type strings and payload construction into helpers where safe.
3. Preserve all existing trace payloads exactly.
4. Keep writeTraceEvent as the only function that writes trace events.
5. Update imports and call sites only as needed.

Return:
1. Files changed
2. Events touched
3. Confirmation that payloads are unchanged
4. Commands to run
5. Any risks or uncertainty
```

# Step 4: Extract pipeline stage wrappers from processClaimedCompany.ts

## Goal

Make `processClaimedCompany.ts` a thin orchestrator without changing scanner behavior.

## Reason

The audit identified `processClaimedCompany.ts` as the biggest modularization target. It currently carries orchestration plus stage level persistence and trace details.

The safest approach is to extract wrappers around existing behavior, not rewrite discovery or extraction internals.

## Target stage wrappers

Create modules or local helper files for these stage boundaries:

1. `runDiscoveryStage`
2. `runPlatformDetectionStage`
3. `runExtractorSelectionStage`
4. `runExtractionStage`
5. `runMatchingAndFinalizationStage`

Exact names can follow the current project convention.

## Important boundary rule

These wrappers should preserve the current inputs and outputs of the pipeline.

They should not change:

1. discovery ranking
2. allowed source logic
3. platform detection rules
4. extractor selection rules
5. Playwright fallback eligibility
6. extraction confidence rules
7. caps
8. timeouts
9. parsed job filtering
10. matching rules
11. finalization rules
12. failure codes
13. trace payloads
14. status values

## Recommended final shape

`processClaimedCompany.ts` should read like:

```ts
export async function processClaimedCompany(claimedCompany) {
  // Load required row and role spec
  // Run discovery stage
  // If discovery failed, finalize
  // Run platform detection stage
  // Run extraction stage
  // Run matching and finalization stage
  // Run completion check
}
```

This is only conceptual.

Do not force this exact code if it fights the existing structure.

## Acceptance criteria

1. `processClaimedCompany.ts` becomes easier to read.
2. Existing stage behavior is unchanged.
3. Worker token ownership checks are preserved.
4. Finalization still updates the existing claimed row only.
5. Completion check still runs after successful finalization.
6. Trace events are still emitted at the same lifecycle points.
7. Existing tests pass or the same pre existing failures remain.

## Implementation prompt

```text
Refactor processClaimedCompany.ts into a thinner orchestrator by extracting pipeline stage wrappers.

Goal:
Improve module boundaries without changing scanner behavior.

Constraints:
1. Do not change discovery behavior.
2. Do not change allowed source logic.
3. Do not change platform detection behavior.
4. Do not change extractor selection behavior.
5. Do not change Playwright fallback eligibility.
6. Do not change extraction confidence rules.
7. Do not change caps or timeouts.
8. Do not change matching rules.
9. Do not change company finalization rules.
10. Do not change failure codes.
11. Do not change persisted status values.
12. Do not change trace event names or payloads.
13. Do not change API contracts.
14. Do not add agent features.
15. Do not add job detail ingestion.

Requirements:
1. Identify cohesive blocks inside processClaimedCompany.ts.
2. Extract them into small stage wrapper modules or helper functions.
3. Preserve current inputs and outputs.
4. Preserve worker_token ownership checks.
5. Preserve finalization timing.
6. Preserve run completion check timing.
7. Keep the app runnable.
8. Add or update tests only if existing test structure supports it.

Return:
1. Files changed
2. Stage wrappers created
3. Behavior preservation notes
4. Commands to run
5. Any risks or uncertainty
```

# Step 5: Verify modularization did not change behavior

## Goal

Confirm that modularization did not accidentally change scanner behavior.

## Verification areas

Check:

1. POST `/api/runs`
2. GET `/api/runs/:runId`
3. Worker loop startup
4. Role spec initialization
5. Company claiming
6. Discovery call path
7. Platform detection call path
8. Extractor selection call path
9. Extraction call path
10. Matching call path
11. Company finalization
12. Run completion
13. Trace events
14. Restart recovery

## Final verification prompt

```text
Perform a post modularization verification audit.

Do not modify code unless there is a clear behavior regression caused by the modularization.

Check:
1. POST /api/runs still only creates persisted state and returns runId.
2. GET /api/runs/:runId returns the exact same response shape and ordering.
3. Worker loop still owns all transitions after creation.
4. Role spec still gates company processing.
5. Company claiming is still transactional.
6. Worker token ownership is still enforced.
7. Discovery behavior is unchanged.
8. Platform detection behavior is unchanged.
9. Extractor selection and fallback behavior are unchanged.
10. Extraction confidence behavior is unchanged.
11. Matching behavior is unchanged.
12. Finalization rules are unchanged.
13. Run completion still works.
14. Trace event names and payloads are unchanged.
15. Restart recovery behavior is unchanged.

Return:
1. Pass or fail
2. Any behavior regressions found
3. Any files that still feel too tangled
4. Whether it is safe to move to the Pre Agent Expansion Readiness Checklist
```

# Stop conditions

Stop immediately if a refactor causes any of these:

1. API response shape changes.
2. Database schema changes.
3. Persisted status values change.
4. Worker lifecycle ownership changes.
5. Company finalization behavior changes.
6. Discovery selects different URLs without an intentional bug fix.
7. Extraction confidence behavior changes.
8. `UNVERIFIED` behavior changes.
9. Trace event payloads change unexpectedly.
10. Tests fail in a new way that is not understood.

If a stop condition occurs, revert the last modularization slice and reassess.

# Recommended tool usage

## Codex

Use Codex for:

1. Read only audits
2. Post change verification
3. Finding accidental behavior drift
4. Comparing before and after structure

Codex should be used like a reviewer.

## Claude Code or Cursor

Use Claude Code or Cursor for:

1. Mechanical extraction
2. Moving route logic into modules
3. Moving helper functions
4. Updating imports
5. Running local tests if available

Claude or Cursor should be given one bounded implementation slice at a time.

## Best workflow

1. Codex audits.
2. Claude or Cursor implements one step.
3. Codex verifies the step.
4. Repeat.
5. Move to Pre Agent Expansion Readiness only after post modularization verification passes.

# Final done state

This modularization pass is complete when:

1. API route logic is less tangled.
2. Run detail assembly is easier to inspect.
3. Trace event construction is less scattered.
4. `processClaimedCompany.ts` is thinner and easier to follow.
5. Discovery and extraction internals have not been broadly rewritten.
6. Worker lifecycle behavior is unchanged.
7. Finalization behavior is unchanged.
8. Trace behavior is unchanged.
9. The app remains runnable.
10. Codex or another reviewer confirms it is safe to move to the Pre Agent Expansion Readiness Checklist.
