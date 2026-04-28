# Discovery Hardening Roadmap for Surveyor

## How to Execute This Roadmap

Each step is designed to be executed by a fresh Cursor agent.

Rules:

1. Do exactly what the step says.
2. Do not expand scope beyond the step.
3. Do not refactor unrelated modules unless the step explicitly requires it.
4. Each step must leave the app in a runnable state.
5. Existing lifecycle, status, and persistence contracts remain authoritative unless this roadmap explicitly adds to them.
6. Discovery must remain deterministic.
7. No LLM may be introduced anywhere in discovery, verification, candidate ranking, job surface resolution, platform detection, or extraction selection.
8. Search remains DuckDuckGo HTML only, HTTP only, deterministic parsing only. :contentReference[oaicite:0]{index=0}
9. If certainty is insufficient at any point, the company must still end as `UNVERIFIED`, not `NO_MATCH_SCAN_COMPLETED`. :contentReference[oaicite:1]{index=1} :contentReference[oaicite:2]{index=2}

Time Standard:

- ALL timestamps are unix milliseconds using `Date.now()`

Important design intent:

- This roadmap hardens the discovery path without changing the product’s user facing result buckets.
- `MATCHES_FOUND`, `NO_MATCH_SCAN_COMPLETED`, and `UNVERIFIED` remain the only user facing end states for successful run processing. `CANCELLED` remains valid for role spec failure. :contentReference[oaicite:3]{index=3} :contentReference[oaicite:4]{index=4}

---

# PHASE D0: LOCK THE NEW DISCOVERY MODEL

## Step D0.1: Replace the Discovery Design Contract in the Roadmap

Update the existing internal roadmap or create a dedicated discovery design section that makes the following model authoritative:

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

Definitions:

### Candidate

A URL that may represent:

- a careers landing page
- a job listings page
- a supported ATS page
- a weak page that must later be rejected

### Verified candidate

A candidate that passes deterministic careers page verification and is safe to continue evaluating.

### Listings surface

The specific page or ATS endpoint from which job listings can actually be enumerated.
A careers landing page is not automatically a listings surface.

### Discovery success

Discovery succeeds only when the system resolves a verified and allowed listings surface or a verified careers surface with strong evidence that it is the authoritative entry point for listings.

### Discovery failure

Discovery fails when:

- no allowed candidate can be found
- candidates are found but none can be verified strongly enough
- a careers landing page is found but the listings surface cannot be resolved with sufficient confidence

Rules:

- Discovery may use official company domains and supported ATS surfaces only. Job boards are not authoritative sources. :contentReference[oaicite:5]{index=5}
- Discovery must stay deterministic and reproducible. :contentReference[oaicite:6]{index=6}
- Search is candidate generation only, never final truth on its own.
- A candidate may not become `careers_url` unless it passes verification.
- A careers landing page may not be treated as a completed listings surface unless listing access is actually resolved.

Acceptance criteria:

- The roadmap now explicitly distinguishes candidate generation from candidate verification.
- The roadmap now explicitly distinguishes careers landing pages from listings surfaces.
- Cursor has an authoritative design contract to follow before code changes begin.

---

## Step D0.2: Lock Internal Discovery Types and Result Shapes

Add or update internal types in the API codebase for discovery only. These types do not change public API contracts unless explicitly stated.

Create authoritative internal types for:

### `DiscoveryCandidate`

Fields:

- `url: string`
- `source_type: 'HOMEPAGE_LINK' | 'URL_GUESS' | 'SEARCH_RESULT' | 'ATS_LINK' | 'EMBEDDED_ATS'`
- `source_url: string | null`
- `allowed: boolean`
- `host_type: 'OFFICIAL_DOMAIN' | 'SUPPORTED_ATS' | 'OTHER'`

### `VerifiedCandidate`

Fields:

- `url: string`
- `source_type`
- `host_type`
- `page_kind: 'LISTINGS_SURFACE' | 'CAREERS_LANDING'`
- `verification_reasons: string[]`

### `ResolvedJobSurface`

Fields:

- `careers_url: string`
- `listings_url: string | null`
- `selected_source_type: 'OFFICIAL_DOMAIN' | 'SUPPORTED_ATS'`
- `page_kind: 'LISTINGS_SURFACE' | 'CAREERS_LANDING'`
- `resolution_method: 'DIRECT_VERIFIED' | 'FOLLOW_CTA' | 'ATS_LINK' | 'EMBEDDED_ATS' | 'PLAYWRIGHT_REQUIRED' | 'UNRESOLVED'`
- `verification_reasons: string[]`
- `attempted_urls: string[]`

Rules:

- These are internal discovery pipeline types, not shared response contracts.
- Existing `RunDetailResponse` remains authoritative unless later steps explicitly add evidence fields. :contentReference[oaicite:7]{index=7}
- Do not change existing persisted status enums.
- Do not change `AtsType`.

Acceptance criteria:

- Internal discovery pipeline has explicit typed stages.
- Cursor no longer has to infer what a “candidate” versus “selected careers url” means.

---

# PHASE D1: HOMEPAGE FIRST DISCOVERY

## Step D1.1: Add Homepage Identification Before Candidate Guessing

Modify discovery so that it first identifies the likely official homepage for the company before trying path guesses.

Required behavior:

1. Derive the likely base official domain from the company name using the current deterministic logic.
2. Fetch the homepage for:
   - `https://{domain}`
   - `https://www.{domain}`
3. Follow redirects.
4. Record the final resolved homepage URL if successful.
5. Use the homepage HTML as an input source for candidate generation if it is fetchable.

Rules:

- This step does not yet decide the final careers URL.
- This step only establishes a better source of candidate links than blind path guessing alone.
- If homepage fetch fails, discovery may continue using URL guesses and search fallback.
- Do not use Playwright here.

Acceptance criteria:

- Discovery can inspect homepage HTML before relying on blind path guesses.
- Final resolved homepage URL is available to downstream candidate generation.

---

## Step D1.2: Generate Candidates From Homepage Links

Extend discovery to parse the official homepage HTML for high confidence candidate links.

Look for anchor links containing signals such as:

- careers
- jobs
- job openings
- open roles
- join us
- work with us
- opportunities
- hiring

Also extract:

- supported ATS links
- iframes with supported ATS hosts
- script tags with supported ATS hosts or ATS config URLs

Rules:

- Only normalize and return candidate URLs.
- Do not yet accept any candidate as the final careers URL in this step.
- Preserve source metadata for each candidate.
- Deduplicate by normalized final URL string.
- Keep the candidate list ordered by source strength:
  1. ATS links from homepage
  2. explicit careers or jobs links from homepage
  3. embedded ATS iframe or script sources

Acceptance criteria:

- Discovery can build candidates from homepage nav/footer/content.
- Supported ATS links found on homepage are first class candidates.

---

## Step D1.3: Keep URL Guessing, But Demote It

Retain URL guessing, but treat it as lower priority than homepage derived candidates.

Allowed guesses may include patterns such as:

- `/careers`
- `/jobs`
- `/careers/jobs`
- `/jobs/careers`
- `/careers-home`
- `/join-us`
- `/work-with-us`
- `/company/careers`

Rules:

- Add guessed URLs only after homepage derived candidates.
- Guessed URLs remain candidates only. They are not auto accepted.
- Keep them deterministic and limited.
- Do not expand into a large brute force path list.

Acceptance criteria:

- Guessing still exists for coverage.
- Guessing is no longer the primary truth source.

---

## Step D1.4: Keep Search Fallback, But Make It Candidate Generation Only

Retain the existing DuckDuckGo HTML search adapter, but explicitly limit it to candidate generation.

Search should run only after:

1. homepage candidate generation completes
2. URL guess candidate generation completes
3. no higher priority verified candidate has already been accepted

Query shape should remain deterministic and careers focused.

Rules:

- Search results must be parsed and normalized as candidates only.
- Search results must never bypass verification.
- Search remains limited to official company domains and supported ATS domains by allowlist rules. :contentReference[oaicite:8]{index=8} :contentReference[oaicite:9]{index=9}
- No new search provider may be introduced.

Acceptance criteria:

- Search remains in the system, but only as fallback candidate generation.
- Cursor cannot accidentally treat a search result as final truth.

---

# PHASE D2: STRICT CANDIDATE VERIFICATION

## Step D2.1: Replace Weak “Plausible Page” Acceptance With Strong Verification

Replace the current acceptance logic that treats `2xx + HTML` as sufficient.

Create a deterministic verification helper such as:
`verifyCareersCandidate(url, html, finalUrl)`

This helper must classify candidates into:

- verified listings surface
- verified careers landing page
- reject

Verification signals may include:

### Strong listings surface signals

- final URL path strongly job related
- page contains multiple likely job detail links
- page contains job cards or listing containers
- supported ATS markers
- page contains “search jobs”, “open positions”, “job openings”, “apply now”, or equivalent strong listing language

### Careers landing page signals

- page strongly identifies itself as careers, hiring, or join us
- page contains a strong CTA to view jobs or open roles
- page contains ATS outbound links or embedded ATS markers
- page is clearly recruiting focused but does not itself enumerate listings

### Reject signals

- generic corporate page with weak or no hiring signals
- pages that happen to include the word “careers” but are not the recruiting entry point
- pages that are HTML but provide no strong recruiting evidence

Rules:

- `2xx + HTML` is necessary but not sufficient.
- A candidate must not be accepted merely because it is on the official domain.
- Weak candidates must remain rejected even if they came from URL guessing or search.
- Verification must be deterministic and explainable.

Acceptance criteria:

- A generic page like a weak `company.com/careers` page is rejected unless the content actually supports careers intent.
- Discovery no longer stops at the first official domain page that returns HTML.

---

## Step D2.2: Add Candidate Ranking After Verification

Once candidates are verified or rejected, rank accepted candidates in this priority order:

1. verified supported ATS listings surface
2. verified official domain listings surface
3. verified official domain careers landing page with strong CTA or ATS resolution path
4. verified supported ATS careers landing page
5. all others rejected

Rules:

- Verified ATS listing pages outrank weak official domain pages.
- Search derived ATS candidates may outrank guessed official domain URLs if verification is stronger.
- The ranking logic must be deterministic and documented in code comments.

Acceptance criteria:

- Candidate selection now prefers stronger evidence, not just earlier discovery order.
- Reddit style weak acceptance bugs are much harder to reproduce.

---

# PHASE D3: LISTINGS SURFACE RESOLUTION

## Step D3.1: Add a Listings Surface Resolver

Create a resolver stage that runs only after candidate verification.

Input:

- a verified candidate

Output:

- a resolved job surface result

Required behavior:

- If the verified candidate is already a listings surface, accept it directly.
- If the verified candidate is a careers landing page, attempt to resolve the actual listings surface.

Resolver behaviors may include:

1. follow strong CTA links like:
   - view openings
   - open roles
   - search jobs
   - see all jobs
2. follow supported ATS outbound links
3. extract iframe `src` values pointing to supported ATS hosts
4. extract script hosted ATS config or embedded ATS URLs
5. re verify the resolved target page before accepting it

Rules:

- Resolver must remain deterministic.
- Resolver may follow only a small bounded number of high confidence next hops.
- Resolver must not crawl broadly.
- Resolver must not use Playwright yet in this step.
- If the candidate is a careers landing page but no strong listings surface can be resolved, return unresolved rather than faking success.

Acceptance criteria:

- The system can move from a careers landing page to the actual jobs surface when the path is explicit.
- Landing pages are no longer assumed to be the listings surface by default.

---

## Step D3.2: Add JS Gating Detection for Resolver Output

When the resolver finds strong evidence that listings exist but are not retrievable through simple HTTP, it must mark the candidate as requiring interactive resolution.

Examples of evidence:

- a verified careers page with a “search jobs” UI but no HTTP visible listings
- supported ATS scripts or embeds that require client rendering
- clear DOM placeholders for jobs with empty server rendered content
- CTA flows that appear to require script execution

Rules:

- This step does not yet run Playwright.
- It only records that Playwright is justified later.
- This must be a high confidence signal, not a guess.
- If JS gating is only speculative, do not mark it as justified.

Acceptance criteria:

- Discovery and resolution can distinguish between:
  - no listings found
  - listings surface unresolved
  - listings likely exist but require JS interaction

---

# PHASE D4: PIPELINE INTEGRATION

## Step D4.1: Update `discoverCareersUrl` to Return Resolved Surfaces, Not Weak Page Picks

Modify the pure discovery helper so it now returns a resolved result based on:

1. homepage derived candidates
2. guessed candidates
3. search derived candidates
4. verification
5. listings surface resolution

Authoritative return shape:

- `careers_url: string | null`
- `listings_url: string | null`
- `attempted_urls: string[]`
- `selected_source_type: 'OFFICIAL_DOMAIN' | 'SUPPORTED_ATS' | null`
- `page_kind: 'LISTINGS_SURFACE' | 'CAREERS_LANDING' | null`
- `resolution_method: 'DIRECT_VERIFIED' | 'FOLLOW_CTA' | 'ATS_LINK' | 'EMBEDDED_ATS' | 'PLAYWRIGHT_REQUIRED' | 'UNRESOLVED' | null`
- `verification_reasons: string[]`

Rules:

- `careers_url` is the verified careers entry point.
- `listings_url` is the resolved listings surface when known.
- If only a careers landing page is verified and no listings surface is resolved, the helper must say so explicitly.
- Do not mutate DB state in this helper. :contentReference[oaicite:10]{index=10}

Acceptance criteria:

- The pure helper now models discovery truthfully.
- Worker orchestration can make better final decisions from richer discovery output.

---

## Step D4.2: Update Worker Discovery Orchestration to Persist Only Verified Results

Update the worker side orchestration around discovery.

Required behavior:

1. Emit `careers_url_attempts` exactly once with all attempted URLs. :contentReference[oaicite:11]{index=11}
2. Persist `careers_url` only if the selected result is verified.
3. If `listings_url` exists and your current schema has no place for it, keep it in memory for downstream extraction for now.
4. Emit `careers_url_selected` only for verified accepted results.
5. Include selection metadata in the trace payload:
   - `careers_url`
   - `listings_url`
   - `selected_source_type`
   - `page_kind`
   - `resolution_method`
   - `verification_reasons`

Rules:

- No unverified candidate may be persisted as `careers_url`.
- If discovery cannot produce a verified result, return failure so finalization can become `UNVERIFIED` with `CAREERS_NOT_FOUND` or a more specific code added later.
- Ownership checks with `worker_token` remain required on persistence writes. :contentReference[oaicite:12]{index=12}

Acceptance criteria:

- The DB only stores vetted discovery outcomes.
- Trace events now explain why a URL was selected, not just what URL won.

---

# PHASE D5: EXTRACTION ENTRYPOINT HARDENING

## Step D5.1: Make Extraction Start From the Resolved Listings Surface When Available

Modify the extraction entrypoint selection logic.

Required behavior:

- If discovery resolved a `listings_url`, extraction starts from `listings_url`.
- Otherwise extraction starts from `careers_url` only if that page was verified as a listings surface or a sufficiently strong careers surface for the chosen extractor path.
- Platform detection should evaluate the actual extraction start URL, not a weaker upstream landing page whenever possible.

Rules:

- Do not change the authoritative extractor selection enum values. :contentReference[oaicite:13]{index=13}
- Do not weaken the finalization rules.
- Keep extraction conservative.

Acceptance criteria:

- Extraction is less likely to begin on the wrong page.
- Platform detection gets better signal because it is run on the actual surface that should contain jobs.

---

## Step D5.2: Tighten the Rule for Playwright Justification

Keep Playwright fallback within the existing product constraints, but make justification clearer.

Playwright is allowed only if one of these is true:

1. the platform is supported and HTTP extraction failed to retrieve listings
2. the resolved discovery or resolver stage found strong evidence that listings exist but are JS rendered

Rules:

- This remains consistent with the current roadmap. :contentReference[oaicite:14]{index=14}
- Discovery alone must not invoke Playwright directly.
- Discovery may only annotate that interactive resolution is justified.
- Extraction orchestration decides whether to actually execute Playwright fallback.

Acceptance criteria:

- Button click and JS gated jobs cases now have a disciplined escalation path.
- Cursor cannot casually start using Playwright across discovery.

---

# PHASE D6: FAILURE CODES, EVIDENCE, AND TRACE

## Step D6.1: Improve Discovery Failure Specificity Without Changing User Facing Buckets

Keep the same user facing end states, but improve internal failure reasons.

Add or normalize discovery related failure codes such as:

- `CAREERS_NOT_FOUND`
- `CAREERS_PAGE_UNVERIFIED`
- `LISTINGS_SURFACE_UNRESOLVED`
- `JS_REQUIRED_UNRESOLVED`

Rules:

- These are failure detail fields, not new company statuses.
- `UNVERIFIED` remains the final company status when discovery or extraction certainty is insufficient. :contentReference[oaicite:15]{index=15} :contentReference[oaicite:16]{index=16}
- Do not introduce new user facing buckets.

Acceptance criteria:

- The UI and CSV exports can later tell the user why the company was unverified more precisely.

---

## Step D6.2: Add Richer Trace Payloads for Discovery and Resolution

Without changing the trace write interface, enrich the payloads used by:

- `careers_url_attempts`
- `careers_url_selected`
- `finalization_outcome`

Include structured data where available:

- candidate sources
- rejection reasons
- selected verification reasons
- page kind
- resolution method
- whether JS gating evidence was found

Rules:

- Keep the existing `writeTraceEvent` function signature unchanged. :contentReference[oaicite:17]{index=17}
- Do not create a second trace API.
- Trace payloads must remain JSON strings or null.

Acceptance criteria:

- A future debugging session can explain exactly why a page was rejected or selected.

---

# PHASE D7: FOCUSED VALIDATION

## Step D7.1: Add Deterministic Unit Coverage for Discovery Heuristics

Add focused tests for:

1. homepage contains explicit careers link
2. homepage contains explicit ATS link
3. guessed URL returns generic HTML and must be rejected
4. verified careers landing page with CTA resolves to listings surface
5. supported ATS page outranks weaker official domain page
6. search result candidate must still pass verification
7. JS evidence present but unresolved leads to conservative unresolved output

Rules:

- Tests should be deterministic and fixture driven where possible.
- Do not build a giant end to end browser test suite here.

Acceptance criteria:

- Discovery behavior is reproducible and guarded against regression.

---

## Step D7.2: Add a Manual Validation Checklist for Known Patterns

Create a short developer checklist documenting manual validation cases such as:

1. company with standard official `/careers`
2. company with nonstandard official careers path
3. company whose homepage links directly to Greenhouse
4. company with ATS embedded via iframe or script
5. company with careers landing page and “View openings” button
6. company with JS gated listings that justify Playwright
7. company with weak generic page that must remain unverified

Rules:

- Keep this checklist short.
- It exists to make future Cursor implementation validation less hand wavy.

Acceptance criteria:

- Discovery can be sanity checked against real world structure patterns without inventing new architecture later.

---

# FINAL DEFINITION OF DONE FOR THIS ROADMAP

This roadmap is complete when all of the following are true:

1. Discovery no longer accepts a URL merely because it is official domain HTML.
2. Homepage parsing is a first class discovery source.
3. Supported ATS links are first class discovery candidates.
4. Search remains fallback candidate generation only.
5. Candidate verification is explicit and deterministic.
6. Careers landing pages are distinguished from actual listings surfaces.
7. The resolver can follow strong CTAs or ATS embeds to reach listings surfaces.
8. JS gated listings can be identified as requiring interactive fallback without discovery itself turning into a browser crawler.
9. Worker persistence stores only verified discovery outputs.
10. Finalization remains conservative, meaning unresolved certainty still becomes `UNVERIFIED`. :contentReference[oaicite:18]{index=18} :contentReference[oaicite:19]{index=19}
11. Existing run ownership, status, worker token, and finalization rules remain intact unless explicitly extended here. :contentReference[oaicite:20]{index=20} :contentReference[oaicite:21]{index=21}

---

# Suggested Cursor Execution Order

Use one fresh Cursor agent per step in this exact order:

1. Step D0.1
2. Step D0.2
3. Step D1.1
4. Step D1.2
5. Step D1.3
6. Step D1.4
7. Step D2.1
8. Step D2.2
9. Step D3.1
10. Step D3.2
11. Step D4.1
12. Step D4.2
13. Step D5.1
14. Step D5.2
15. Step D6.1
16. Step D6.2
17. Step D7.1
18. Step D7.2

If a step requires a tiny compatibility adjustment from a previous step, allow only the minimum necessary change and do not drift ahead.
