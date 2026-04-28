# Extraction Completion Hardening Roadmap (Confidence Based Completion Enforcement)

## How to Execute This Roadmap

Each step is designed to be executed by a fresh Cursor agent.

Rules:

- Do exactly what the step says. Do not expand scope.
- Do not refactor unrelated modules.
- Do not change API response shapes or user-facing statuses.
- Keep extraction deterministic.
- The app must remain runnable after each step.
- Preserve all existing lifecycle, worker, and persistence rules.

Time Standard:

- ALL timestamps use Date.now() (unix ms)

Critical product rule (authoritative):

- If completion is uncertain → MUST be UNVERIFIED
- NO_MATCH_SCAN_COMPLETED is ONLY valid when:
  - extraction.completed = true
  - AND we have high confidence we actually enumerated the listings surface

This roadmap only tightens the definition of `completed`.
It does NOT redesign discovery or extraction architecture.

---

# PROBLEM STATEMENT

The current system marks extraction as completed when `jobs.length > 0`.

This is incorrect.

A careers landing page or partial page may contain:

- a single CTA link
- a navigation link
- a small number of job-like anchors

These are not sufficient evidence that:

- we reached the true listings surface
- listings were meaningfully enumerated

This leads to false confidence and incorrect final states such as:

- NO_MATCH_SCAN_COMPLETED when it should be UNVERIFIED

The system must become more conservative without becoming arbitrarily strict.

The solution is not to use a blunt minimum count as the sole rule.
The solution is to make completion depend on confidence that the current page is a real listings surface.

---

# DESIGN INTENT

We are introducing a stricter, deterministic definition of extraction completion.

New principle:

Extraction is complete ONLY when there is strong evidence that:

1. we are on a true listings surface
2. listings were meaningfully enumerated

This confidence must come from page structure and extractor context, not just raw parsed link count.

Important nuance:

- Generic pages require stronger listing count evidence
- Supported ATS pages may still be confident listings surfaces even with low parsed count, if the page clearly exposes ATS listing structure

Otherwise:

- extraction.completed MUST be false
- final state MUST become UNVERIFIED

---

# PHASE E1: DEFINE CONFIDENCE BASED COMPLETION SIGNALS

## Step E1.1: Introduce Completion Confidence Helper

Add a deterministic helper inside the extraction module:

`isConfidentListingsSurface(html, url, jobs, extractor_used) → boolean`

This helper becomes the authoritative source of truth for whether extraction is complete.

Rules:

- Must be deterministic
- Must NOT use LLM
- Must NOT rely on weak signals like a single generic job-like link
- Must be explainable through explicit code checks
- Must support different thresholds for generic pages vs supported ATS pages

Acceptance criteria:

- Completion is no longer based directly on `jobs.length > 0`
- The code now has one authoritative helper for completion confidence

---

## Step E1.2: Add Generic Listings Surface Confidence Rules

Inside `isConfidentListingsSurface`, implement rules for generic non-ATS pages.

Define:

- `MIN_CONFIDENT_LISTINGS = 3`

For generic pages, confidence requires:

- strong structural evidence of repeated listing-like content
- AND `jobs.length >= MIN_CONFIDENT_LISTINGS`

Structural evidence may include deterministic signals such as:

- repeated job-card or listing-like blocks
- repeated anchors pointing to likely job detail paths
- repeated listing containers or patterns in HTML
- clear listing language paired with repeated listing structure

Rules:

- `MIN_CONFIDENT_LISTINGS` is a supporting threshold, not the global source of truth
- Generic pages may not be marked complete based on a single job-like link
- Generic pages may not be marked complete based on weak listing language alone

Acceptance criteria:

- A generic landing page with 1 or 2 weak links is not complete
- A generic page with repeated listing structure and sufficient parsed jobs may be complete

---

## Step E1.3: Add ATS Aware Confidence Rules

Inside `isConfidentListingsSurface`, add a separate confidence path for supported ATS pages.

For supported ATS extractor paths, confidence may be true when:

- the page clearly exposes ATS listing container or ATS job board structure
- AND the page is clearly operating on a true ATS listings surface
- AND either:
  - `jobs.length >= 1`
  - OR there is strong ATS listing structure that indicates real enumeration surface even if parsed results are imperfect

Examples of acceptable ATS structural evidence:

- Greenhouse board container or rendered board structure
- Lever postings container or clear Lever job list structure
- Ashby or SmartRecruiters listing container patterns
- supported ATS job board specific repeated HTML sections

Rules:

- ATS pages must not be forced through the generic `MIN_CONFIDENT_LISTINGS = 3` rule
- ATS embed markers alone are not automatically enough if the page is still only a landing page
- The helper must distinguish between:
  - a true ATS listings surface
  - a company landing page that merely references ATS

Acceptance criteria:

- A true ATS listings surface can still be considered complete with a low parsed job count when structure is strong
- A careers page that merely points to ATS is not considered complete under this ATS path

---

# PHASE E2: CHANGE COMPLETION LOGIC

## Step E2.1: Replace Current Success Logic With Confidence Logic

In `extractJobsHttp` and any shared extraction success path:

Replace this behavior:

OLD:

- if jobs.length > 0 → completed = true

NEW:

- completed = isConfidentListingsSurface(html, url, jobs, extractor_used)

Rules:

- Do not remove existing failure conditions such as BLOCKED, CAP_REACHED, FETCH_FAILED, etc.
- Only change the success condition
- Keep `jobs`, `listings_scanned`, and `pages_visited` behavior intact unless required by this step

Acceptance criteria:

- Extraction no longer returns `completed = true` solely because one job-like link was found
- Weak pages now return `completed = false`

---

## Step E2.2: Add Explicit Incomplete Failure Reason For Weak Evidence

When extraction has parsed some job-like entries but `isConfidentListingsSurface(...)` returns false, return:

- `completed = false`
- `failure_code = 'INSUFFICIENT_LISTINGS_EVIDENCE'`
- `failure_reason = 'could not confidently verify listings surface from extracted HTML'`

Rules:

- This should be used for weak or partial extraction cases
- Existing zero-listing failure behavior may remain where more specific and still valid
- Do not collapse all incomplete states into one generic reason

Acceptance criteria:

- Weak extraction no longer fails silently into vague completion behavior
- Debugging can distinguish “some links found but not enough confidence” from “nothing found at all”

---

# PHASE E3: PLAYWRIGHT FALLBACK CORRECTION

## Step E3.1: Gate Fallback On Confidence, Not Just Job Count

Modify `shouldAttemptPlaywrightFallback`.

Currently:

- fallback is blocked when `result.jobs.length > 0`

Replace that logic.

New rule:

- fallback must be blocked only when we are already confident we are on a real listings surface
- fallback may still be allowed when some job-like entries were parsed but confidence is false

Authoritative behavior:

- If `isConfidentListingsSurface(...) === true` → do NOT fallback
- If `isConfidentListingsSurface(...) === false` → fallback may still be allowed if existing fallback conditions are met

Rules:

- Do not allow fallback endlessly
- Keep existing supported ATS and JS evidence conditions
- Do not trigger fallback merely because parsing is imperfect if confidence is already high

Acceptance criteria:

- Weak partial parsing no longer blocks Playwright fallback
- Strong confident listings surfaces do not waste time on redundant fallback

---

## Step E3.2: Preserve ATS Specific Fallback Discipline

For supported ATS pages:

- if confidence is already true, do not fallback
- if confidence is false, fallback may proceed under existing ATS fallback rules

Rules:

- ATS pages should not degrade into unnecessary Playwright work when already confident
- ATS pages with weak partial parsing should still be recoverable through fallback when justified

Acceptance criteria:

- Valid ATS flows are not accidentally blocked
- False partial success no longer prevents escalation

---

# PHASE E4: FINALIZATION ALIGNMENT

## Step E4.1: Keep Finalization Logic, But Verify Behavior Against New Completion Rules

No structural rewrite to finalization is required.

But verify the end-to-end effect:

If extraction.completed = false
→ final status MUST be UNVERIFIED

If extraction.completed = true and matchCount = 0
→ final status MAY be NO_MATCH_SCAN_COMPLETED

Rules:

- Do not change existing finalization order
- Do not change user-facing statuses
- This step is about behavioral alignment only

Acceptance criteria:

- Weak extraction results now land in UNVERIFIED
- NO_MATCH_SCAN_COMPLETED only occurs when completion confidence is genuinely high

---

# PHASE E5: TRACE AND DEBUGGING

## Step E5.1: Include Completion Confidence Context In Trace Payloads

When emitting `finalization_outcome`, ensure payload includes:

- `listings_scanned`
- `pages_visited`
- `failure_code`
- `failure_reason`

If practical within current call structure, also include:

- `completed`

Rules:

- Do not change trace function signature
- Only enrich `payload_json`
- Preserve existing event names

Acceptance criteria:

- Debugging clearly shows whether incomplete extraction came from weak evidence
- The new `INSUFFICIENT_LISTINGS_EVIDENCE` state is visible in traces

---

# PHASE E6: VALIDATION

## Step E6.1: Add Deterministic Tests For Generic Confidence Rules

Add tests for generic pages:

Case 1:

- generic page, 1 weak job-like link
- expected → completed = false

Case 2:

- generic page, 2 weak links
- expected → completed = false

Case 3:

- generic page, repeated listing structure and `jobs.length >= 3`
- expected → completed = true

Acceptance criteria:

- Generic pages are held to a conservative but explainable standard

---

## Step E6.2: Add Deterministic Tests For ATS Confidence Rules

Add tests for ATS pages:

Case 1:

- true ATS listings surface, low parsed count, strong ATS listing structure
- expected → completed = true

Case 2:

- company careers landing page with ATS embed marker only
- expected → completed = false

Case 3:

- ATS page with weak partial parsing and low confidence
- expected → completed = false and fallback remains eligible

Acceptance criteria:

- ATS flows do not regress into false negatives
- ATS reference pages do not get treated as completed listings surfaces

---

## Step E6.3: Add Deterministic Tests For Fallback Guard

Add tests for fallback:

Case 1:

- some jobs parsed, confidence false
- expected → fallback can still be attempted when other conditions are met

Case 2:

- some jobs parsed, confidence true
- expected → fallback blocked

Case 3:

- ATS page with low parsed count but strong structure
- expected → no unnecessary fallback

Acceptance criteria:

- Fallback behavior is driven by confidence rather than raw job count

---

# FINAL DEFINITION OF DONE

This roadmap is complete when:

1. Extraction is no longer considered complete based on a single job-like link
2. Completion is driven by `isConfidentListingsSurface(...)`, not raw count alone
3. Generic pages require stronger structural and count evidence
4. Supported ATS pages can still complete with low parsed count when the listings surface is clearly real
5. Weak extraction results correctly return `completed = false`
6. `INSUFFICIENT_LISTINGS_EVIDENCE` exists as a specific incomplete reason
7. Playwright fallback is blocked only when confidence is already high
8. Weak partial parsing no longer prevents recovery
9. Final states correctly favor UNVERIFIED when confidence is low
10. NO_MATCH_SCAN_COMPLETED only occurs when a true listings surface was scanned with confidence

---

# Suggested Execution Order

Use a fresh Cursor agent per step:

1. Step E1.1
2. Step E1.2
3. Step E1.3
4. Step E2.1
5. Step E2.2
6. Step E3.1
7. Step E3.2
8. Step E4.1
9. Step E5.1
10. Step E6.1
11. Step E6.2
12. Step E6.3

If a step requires a small compatibility adjustment to previous logic, keep it minimal and do not expand scope.
