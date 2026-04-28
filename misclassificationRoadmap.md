# Discovery Classification Correction Roadmap

## How to Execute This Roadmap

Each step is designed to be executed by a fresh Cursor agent.

Rules:

- Do exactly what the step says. Do not expand scope.
- Do not refactor unrelated code.
- Do not modify DB schema, API contracts, or statuses.
- Do not introduce LLMs or non-deterministic behavior.
- Each step must leave the app in a runnable state.
- This roadmap ONLY fixes classification logic. It does not redesign discovery or extraction.

Time Standard:

- ALL timestamps use Date.now()

---

# PROBLEM STATEMENT (AUTHORITATIVE)

The system currently misclassifies careers pages that contain ATS embed indicators (such as Greenhouse markers) as LISTINGS_SURFACE.

This is incorrect.

These signals only indicate that job listings exist somewhere behind the page (via embed, script, or external system). They do NOT guarantee that:

- the page itself contains enumeratable job listings
- the extractor can reliably scan listings from this page

Because of this misclassification:

- the resolver exits early (DIRECT_VERIFIED path)
- listings_url is never resolved
- extraction runs on the wrong page
- weak extraction results can falsely mark the scan as complete

This leads to false confidence and incorrect NO_MATCH_SCAN_COMPLETED outcomes instead of UNVERIFIED.

---

# DESIGN GOAL

Tighten the classification boundary between:

- LISTINGS_SURFACE
- CAREERS_LANDING

Specifically:

A page must only be classified as LISTINGS_SURFACE if:

- it contains directly enumerable job listings in server-rendered HTML
- AND those listings are sufficient for deterministic extraction

A page that:

- references ATS systems
- embeds job boards via JS
- links to external listings
- or requires interaction

must be classified as CAREERS_LANDING, not LISTINGS_SURFACE.

---

# PHASE C1: REMOVE FALSE POSITIVE LISTINGS SIGNALS

## Step C1.1: Adjust ATS Embed Signal Behavior

Locate:

- verifyCareersCandidate in discovery.ts

Current behavior:

- ATS embed markers (e.g. greenhouse embed) contribute strongly to listingScore
- This can independently satisfy LISTING_THRESHOLD

Required change:

ATS embed indicators MUST NOT independently qualify a page as LISTINGS_SURFACE.

Instead:

- treat ATS embed markers as evidence of CAREERS_LANDING
- or reduce their contribution so they cannot reach LISTING_THRESHOLD alone

Authoritative rule:

If a signal only indicates:
"jobs exist somewhere behind this page"

Then it MUST NOT contribute enough weight to classify as LISTINGS_SURFACE.

Implementation constraints:

- Do not remove ATS detection entirely
- Reassign or reduce scoring so it supports landing classification instead

Acceptance criteria:

- A page with only ATS embed signals no longer becomes LISTINGS_SURFACE
- It must instead classify as CAREERS_LANDING or fail classification

---

## Step C1.2: Require Strong Listing Evidence for LISTINGS_SURFACE

Modify classification rules in verifyCareersCandidate:

LISTINGS_SURFACE must require stronger evidence.

At least one of the following MUST be true:

- multiple valid job detail links that match extraction constraints
- clear listing structures that can be parsed deterministically
- server-rendered job listings (not just references)

Weak signals that must NOT be sufficient:

- generic job-related language
- CTA phrases ("view jobs", "open roles")
- ATS embed scripts or markers
- indirect references to job systems

Acceptance criteria:

- LISTINGS_SURFACE classification is only possible when listings are actually present in usable form
- Careers pages with only indirect signals fall below threshold

---

# PHASE C2: STRENGTHEN CAREERS_LANDING CLASSIFICATION

## Step C2.1: Promote ATS Signals to Careers Landing Evidence

Update CAREERS_LANDING scoring logic:

Signals that indicate:

- ATS embed
- job system references
- outbound ATS links
- "view openings" style CTAs

Should contribute to CAREERS_LANDING classification instead of LISTINGS_SURFACE.

Authoritative behavior:

If the page shows strong evidence that:

- it is a recruiting entry point
- but listings are not directly enumerable

Then it MUST classify as CAREERS_LANDING.

Acceptance criteria:

- Pages like redditinc.com/careers classify as CAREERS_LANDING
- These pages trigger resolver logic instead of fast exit

---

# PHASE C3: PROTECT AGAINST MISCLASSIFICATION EDGE CASES

## Step C3.1: Prevent Listing Classification from Mixed Weak Signals

Add a safeguard:

LISTINGS_SURFACE must not be reached through accumulation of weak signals.

Example of weak combination:

- ATS embed marker
- generic job language
- low-quality or non-extractable links

These must NOT combine to exceed LISTING_THRESHOLD.

Implementation guidance:

- require at least one “hard” listing signal
- or gate LISTINGS_SURFACE behind a boolean condition like:
  "hasExtractableListings = true"

Acceptance criteria:

- LISTINGS_SURFACE cannot be reached through weak signal stacking
- Only real listing evidence enables that classification

---

# PHASE C4: VALIDATION

## Step C4.1: Validate Against Known Failure Case

Test case: Reddit

Expected behavior after fix:

- page_kind = CAREERS_LANDING
- resolver does NOT take DIRECT_VERIFIED fast path
- resolver attempts to find listings surface or marks unresolved
- extraction does NOT run prematurely on careers page

Final outcome expectation:

- either listings surface is resolved and processed
- OR company ends as UNVERIFIED (not NO_MATCH_SCAN_COMPLETED)

Acceptance criteria:

- Reddit no longer produces false completed scan
- classification is corrected upstream

---

## Step C4.2: Validate Against True Listings Surfaces

Test with:

- direct Greenhouse board URL
- direct Lever board URL
- simple HTML listings page

Expected behavior:

- still classified as LISTINGS_SURFACE
- no regression in correct detection

Acceptance criteria:

- Real listings pages still pass classification
- Only false positives are removed

---

# FINAL DEFINITION OF DONE

This roadmap is complete when:

1. ATS embed markers no longer cause LISTINGS_SURFACE classification on their own
2. Careers pages with embedded or linked job systems classify as CAREERS_LANDING
3. Resolver is no longer bypassed due to false LISTINGS_SURFACE classification
4. Extraction is no longer run on careers landing pages by mistake
5. False NO_MATCH_SCAN_COMPLETED outcomes are reduced
6. Existing correct LISTINGS_SURFACE cases still work

---

# EXECUTION ORDER

1. Step C1.1
2. Step C1.2
3. Step C2.1
4. Step C3.1
5. Step C4.1
6. Step C4.2

Run each step in a fresh Cursor agent.

Do not combine steps.
Do not skip validation.
