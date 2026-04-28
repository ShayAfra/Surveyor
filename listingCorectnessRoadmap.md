# Resolver Correctness Roadmap (Fix False Confidence + Early Exit)

## How to Execute This Roadmap

Each step is designed to be executed by a fresh Cursor agent.

Rules:

- Do exactly what the step says. Do not expand scope.
- Do not refactor unrelated modules.
- Do not introduce new crawling strategies.
- Do not change API contracts, DB schema, or status enums.
- Keep discovery deterministic (no LLMs, no randomness).
- The app must remain runnable after each step.
- Follow existing lifecycle and worker ownership rules.

Time Standard:

- ALL timestamps use Date.now()

---

# PROBLEM THIS ROADMAP SOLVES

The system produces falsely confident results when it has NOT actually reached a reliable listings surface.

Observed failure chain:

- A careers page with ATS embed signals is classified as LISTINGS_SURFACE
- Resolver exits early (DIRECT_VERIFIED fast path)
- listings_url remains null
- Extraction runs on the wrong page (careers container)
- Extraction finds minimal or irrelevant links
- extraction.completed = true
- matchCount = 0
- Final status = NO_MATCH_SCAN_COMPLETED

This violates a core product rule:

If listing enumeration is uncertain, the outcome MUST be UNVERIFIED.

This roadmap restores that guarantee without expanding system scope.

---

# DESIGN INTENT

We are NOT improving coverage.

We are ONLY restoring correctness and trust.

The system must:

- stop treating weak signals as proof of listings
- stop exiting resolution too early
- stop marking extraction as complete when it is not trustworthy
- stop producing confident “No Match” outcomes without real enumeration

No new crawling strategies.
No broad resolver expansion.
No UI changes.

---

# PHASE C1: FIX LISTINGS SURFACE MISCLASSIFICATION

## Step C1.1: Introduce Internal Listings Strength Classification

Modify verification logic to internally distinguish:

- STRONG_LISTINGS_SURFACE
- WEAK_LISTINGS_SURFACE
- CAREERS_LANDING

Rules:

A page is STRONG_LISTINGS_SURFACE only if:

- it contains direct enumerated job listings
- AND signals indicate server-rendered or directly accessible listings

A page is WEAK_LISTINGS_SURFACE if:

- it meets listing threshold
- BUT includes ANY of:
  - ATS embed markers (greenhouse embed, lever embed, etc.)
  - script-driven job board indicators
  - iframe-based listings
  - indirect listing evidence without clear enumeration

Critical rule:
ATS embed signals MUST NOT alone qualify a page as STRONG_LISTINGS_SURFACE.

Implementation constraints:

- Do NOT change external PageKind enum
- This is an internal distinction used only by resolver

Acceptance criteria:

- Pages like redditinc.com/careers are classified as WEAK_LISTINGS_SURFACE
- Direct ATS pages (e.g. boards.greenhouse.io) still classify as strong

---

## Step C1.2: Preserve Existing External Contracts

Ensure:

- Existing return values (LISTINGS_SURFACE, CAREERS_LANDING) remain unchanged externally
- Internal strength classification does NOT leak into API or DB

Acceptance criteria:

- No contract drift
- No schema changes
- No response shape changes

---

# PHASE C2: FIX RESOLVER EARLY EXIT

## Step C2.1: Modify Resolver Fast Path

Update resolveListingsSurface behavior:

Current:

- LISTINGS_SURFACE → immediate return (DIRECT_VERIFIED)

New:

- STRONG_LISTINGS_SURFACE → allow fast path (unchanged)
- WEAK_LISTINGS_SURFACE → DO NOT fast path

Rules:

- Weak surfaces must continue through resolver logic
- Treat weak surfaces as unresolved, similar to CAREERS_LANDING

Acceptance criteria:

- redditinc.com/careers no longer exits early
- listings_url is no longer always null for weak surfaces
- resolution does not stop prematurely

---

## Step C2.2: Prevent False DIRECT_VERIFIED Classification

Update resolver output rules:

DIRECT_VERIFIED may ONLY be used if:

- page is STRONG_LISTINGS_SURFACE

If page is weak:

- DO NOT return DIRECT_VERIFIED
- mark resolution as unresolved or indirect

Acceptance criteria:

- DIRECT_VERIFIED implies high confidence only
- weak surfaces never produce DIRECT_VERIFIED

---

# PHASE C3: PROPAGATE RESOLUTION UNCERTAINTY

## Step C3.1: Extend Resolution Method Semantics (Internal Only)

Allow resolver to internally represent:

- DIRECT_VERIFIED (strong only)
- UNRESOLVED
- INDIRECT (weak surface)

Rules:

- Do NOT change persisted schema
- These values are used in-memory to guide downstream logic

Acceptance criteria:

- downstream steps can distinguish strong vs weak resolution
- no DB changes required

---

## Step C3.2: Ensure listings_url Reflects True Resolution

Rules:

- listings_url must only be null if:
  - page is STRONG_LISTINGS_SURFACE
  - OR resolution genuinely failed

- For weak surfaces:
  - listings_url should not falsely imply resolution completeness

Acceptance criteria:

- listings_url is no longer misleading
- downstream logic does not assume equivalence between careers_url and listings_url

---

# PHASE C4: FIX EXTRACTION COMPLETION SIGNAL

## Step C4.1: Tighten Completion Criteria

Modify extraction completion logic:

Current:

- jobs.length > 0 → completed = true

New requirement:

completed = true ONLY if:

- listings were confidently enumerated
- AND extraction context is trustworthy

If extraction runs on:

- WEAK_LISTINGS_SURFACE
- OR UNRESOLVED surface

Then:

- completed MUST be false unless strong enumeration evidence exists

Acceptance criteria:

- 1 incidental link no longer produces completed = true
- extraction confidence aligns with actual enumeration quality

---

## Step C4.2: Prevent False Positive Listings Counts

Rules:

- listings_scanned must reflect actual job listings
- navigation links, CTA links, or partial anchors must not count as listings

Acceptance criteria:

- listings_scanned = 1 from a container page no longer qualifies as meaningful enumeration

---

# PHASE C5: ENFORCE FINALIZATION CORRECTNESS

## Step C5.1: Enforce Uncertainty Rule

Ensure finalization respects:

IF ANY of the following:

- resolution is weak or unresolved
- extraction context is weak
- extraction completion is uncertain

THEN:

- status MUST be UNVERIFIED

Acceptance criteria:

- weak resolution cannot lead to NO_MATCH_SCAN_COMPLETED
- system never claims “No Match” without strong enumeration

---

## Step C5.2: Preserve Existing Finalization Order

Do NOT modify finalization logic ordering:

1. no careers URL → UNVERIFIED
2. extraction not completed → UNVERIFIED
3. matches > 0 → MATCHES_FOUND
4. else → NO_MATCH_SCAN_COMPLETED

Instead:

- ensure upstream correctness forces proper inputs into this logic

Acceptance criteria:

- no change to finalization code structure
- correctness achieved via upstream fixes

---

# PHASE C6: INTEGRATION SAFETY

## Step C6.1: Preserve Worker Lifecycle

Ensure:

- no changes to worker claiming
- no changes to concurrency model
- no changes to trace structure

Acceptance criteria:

- lifecycle behavior unchanged
- only correctness improved

---

## Step C6.2: Preserve Trace Semantics

Ensure existing trace events still emit:

- careers_url_selected
- platform_detected
- extractor_selected
- finalization_outcome

But now reflect corrected behavior.

Acceptance criteria:

- traces show realistic resolution paths
- no misleading DIRECT_VERIFIED for weak pages

---

# FINAL DEFINITION OF DONE

This roadmap is complete when:

1. Weak listing surfaces no longer trigger resolver fast path
2. DIRECT_VERIFIED is only used for strong listings surfaces
3. listings_url is not misleading
4. extraction.completed reflects real confidence, not incidental parsing
5. listings_scanned reflects real job enumeration
6. Weak or unresolved cases cannot produce NO_MATCH_SCAN_COMPLETED
7. Reddit-type case no longer results in:
   - listings_scanned = 1
   - completed = true
   - NO_MATCH_SCAN_COMPLETED
8. Instead, it results in:
   - UNVERIFIED

---

# Suggested Cursor Execution Order

1. Step C1.1
2. Step C1.2
3. Step C2.1
4. Step C2.2
5. Step C3.1
6. Step C3.2
7. Step C4.1
8. Step C4.2
9. Step C5.1
10. Step C5.2
11. Step C6.1
12. Step C6.2
