# Implementation Plan: Extraction Completion

## Overview

Tighten the extraction completion gate so `completed = true` requires confident enumeration evidence. All changes are surgical edits to existing functions in `extraction.ts`, `processClaimedCompany.ts`, and `finalizeCompany.ts`, plus a focused test file. No new modules, no schema changes, no API contract changes.

## Tasks

- [x] 1. Add `MIN_CONFIDENT_LISTINGS` constant and tighten `isConfidentListingsSurface`
  - [x] 1.1 Add `MIN_CONFIDENT_LISTINGS = 3` exported constant in `apps/api/src/lib/extraction.ts` near existing constants
    - _Requirements: 3.1_
  - [x] 1.2 Modify `isConfidentListingsSurface` in `apps/api/src/lib/extraction.ts`
    - Change generic threshold from `jobs.length >= 2` to `jobs.length >= MIN_CONFIDENT_LISTINGS`
    - In the named ATS extractor path, require `htmlHasAtsListingShellForExtractor(html, extractor_used)` — the `jobs.length > 0` guard at the top already ensures enumeration; no additional change needed for ATS board URL path
    - Ensure the function remains exported (it already is)
    - _Requirements: 1.1, 1.2, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 4.1, 4.2_

- [x] 2. Add weak-extraction failure details to `extractJobsHttp` and `extractJobsWithPlaywright`
  - [x] 2.1 Modify `extractJobsHttp` in `apps/api/src/lib/extraction.ts`
    - After the `isConfidentListingsSurface` call, when `completed === false && jobs.length > 0`, return with `failure_code` (`INSUFFICIENT_LISTINGS` for generic, `NOT_CONFIDENT_SURFACE` for ATS) and `failure_reason`
    - Existing failure paths (`BLOCKED`, `CAP_REACHED`, `FETCH_FAILED`, `NO_LISTINGS_PARSED`, `HTTP_NO_LISTINGS`) remain unchanged — they return before the confidence check
    - _Requirements: 5.1, 5.2, 5.3, 5.4_
  - [x] 2.2 Modify `extractJobsWithPlaywright` in `apps/api/src/lib/extraction.ts`
    - Same weak-extraction failure detail pattern as `extractJobsHttp` — after the confidence check, populate `failure_code`/`failure_reason` when `completed === false && jobs.length > 0`
    - _Requirements: 5.1, 5.2, 5.3, 6.3_

- [x] 3. Change Playwright fallback gate in `shouldAttemptPlaywrightFallback`
  - Modify `shouldAttemptPlaywrightFallback` in `apps/api/src/lib/extraction.ts`
  - Change `if (result.jobs.length > 0) return false;` to `if (result.completed) return false;`
  - Condition A and Condition B logic below the gate remains unchanged
  - _Requirements: 6.1, 6.2_

- [x] 4. Checkpoint — verify extraction.ts changes compile
  - Run diagnostics on `apps/api/src/lib/extraction.ts` and ensure no type errors. If minor ambiguity arises, make the most conservative choice within the approved design and continue.

- [x] 5. Add `completion_reason` to finalization trace
  - [x] 5.1 Add `deriveCompletionReason` function in `apps/api/src/worker/processClaimedCompany.ts`
    - Accepts `ExtractJobsResult`, returns a deterministic `completion_reason` string
    - `completed=true` → `"CONFIDENT_SURFACE"`; `completed=false` with `failure_code` → returns the `failure_code`; `completed=false`, no `failure_code`, `jobs.length=0` → `"NO_LISTINGS_PARSED"`; fallback → `"NOT_CONFIDENT_SURFACE"`
    - No new exports from `extraction.ts` — operates solely on `ExtractJobsResult` fields
    - _Requirements: 8.1, 8.2, 8.3, 8.4_
  - [x] 5.2 Extend `FinalizePersistInput` type in `apps/api/src/lib/finalizeCompany.ts`
    - Add `completion_reason: string` required field
    - _Requirements: 8.1_
  - [x] 5.3 Modify `persistFinalizeCompany` in `apps/api/src/lib/finalizeCompany.ts`
    - Destructure `completion_reason` from input and add it to the `finalization_outcome` trace `payload_json`
    - _Requirements: 8.1_
  - [x] 5.4 Update all `finalizeAndCompleteRun` call sites in `apps/api/src/worker/processClaimedCompany.ts`
    - Compute `completion_reason` via `deriveCompletionReason` for the extraction-reached path
    - For early-exit paths (discovery failure, listings surface unresolved), derive `completion_reason` from the failure code already present
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [x] 6. Checkpoint — verify full compilation across extraction.ts, finalizeCompany.ts, processClaimedCompany.ts
  - Run diagnostics on all three files. If minor ambiguity arises, make the most conservative choice within the approved design and continue.

- [x] 7. Write focused Vitest unit tests
  - Create `apps/api/src/lib/__tests__/extraction-completion.test.ts`
  - [x] 7.1 `isConfidentListingsSurface` tests
    - 0 jobs → `false` for every extractor type
    - 1 job on generic surface → `false` (below threshold)
    - 2 jobs on generic surface → `false` (below threshold)
    - 3 jobs on generic surface → `true` (meets threshold)
    - ATS board URL + 1 job → `true`
    - Named ATS extractor + shell HTML + 1 job → `true`
    - Named ATS extractor + no shell HTML + 5 jobs → `false`
    - _Requirements: 1.1, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 4.1, 4.2_
  - [x] 7.2 `shouldAttemptPlaywrightFallback` tests
    - `completed=true` → returns `false` (fallback blocked)
    - `completed=false` with `jobs.length > 0` does not block on job count alone
    - Existing Condition A and Condition B still apply after gate change
    - _Requirements: 6.1, 6.2, 6.3_
  - [x] 7.3 `completion_reason` integration tests — verify `completion_reason` appears correctly in finalization trace payloads by testing the observable behavior of the extraction → finalization path (deriveCompletionReason is private and tested indirectly)
    - _Requirements: 8.1, 8.2, 8.3, 8.4_
  - [x] 7.4 Regression tests
    - `computeFinalStatus` with `completed=false` → `UNVERIFIED`
    - `computeFinalStatus` with `completed=true`, `matchCount=0` → `NO_MATCH_SCAN_COMPLETED`
    - _Requirements: 7.1, 7.2_

- [x] 8. Final checkpoint — ensure all tests pass
  - Run `vitest --run` in `apps/api`, verify all tests pass. If minor ambiguity arises, make the most conservative choice within the approved design and continue.

## Notes

- All code is TypeScript, all changes in `apps/api/src/`
- No new modules — `deriveCompletionReason` is a private function in `processClaimedCompany.ts`, tested indirectly through surrounding behavior
- `isConfidentListingsSurface` is already exported; tests import it directly
- Existing failure paths (`BLOCKED`, `CAP_REACHED`, `FETCH_FAILED`, `PLAYWRIGHT_FAILED`) are not modified
- No database schema changes — `completion_reason` lives only in trace `payload_json`
- Checkpoint tasks should not pause for user input unless something is genuinely broken — make the most conservative choice within the approved design and continue
