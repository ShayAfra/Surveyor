# Discovery Manual Validation Checklist

Use this checklist to sanity-check the discovery pipeline against real-world company structures.
For each pattern, manually run the company through discovery and confirm the pipeline produces the expected outcome.

---

## Pattern 1 — Standard official `/careers`

**Example structure:** `company.com/careers` returns HTML with job listings directly on the page.

Expected pipeline behavior:
- Homepage fetch succeeds and homepage links include `/careers`.
- Candidate is generated from homepage link (source: `HOMEPAGE_LINK`).
- Verification classifies it as a `LISTINGS_SURFACE` (multiple job entries present, strong listing language).
- Resolver accepts it directly (`resolution_method: DIRECT_VERIFIED`).
- `careers_url` is persisted. Extraction begins on this URL.

Pass condition: `careers_url` is set to `company.com/careers`, `ats_type` is determined, extraction completes, company finalizes as `MATCHES_FOUND` or `NO_MATCH_SCAN_COMPLETED`.

---

## Pattern 2 — Nonstandard official careers path

**Example structure:** `company.com/about/join-the-team` or `company.com/opportunities`.

Expected pipeline behavior:
- Homepage fetch succeeds. Homepage parser finds an anchor with a careers signal keyword (`opportunities`, `join`, etc.).
- Candidate is generated from homepage link.
- Verification classifies it as a `CAREERS_LANDING` or `LISTINGS_SURFACE` depending on content.
- If landing page, resolver follows a strong CTA link to the actual listings page.
- If no CTA resolves, `resolution_method` is `UNRESOLVED`, company finalizes as `UNVERIFIED` with `LISTINGS_SURFACE_UNRESOLVED`.

Pass condition: pipeline does not fall back to URL guessing for a nonstandard path that is already linked from the homepage. Guessed paths like `/careers` are demoted and not selected over the homepage-derived candidate.

---

## Pattern 3 — Homepage links directly to Greenhouse

**Example structure:** `company.com` has a "Careers" nav link pointing to `https://boards.greenhouse.io/companyname`.

Expected pipeline behavior:
- Homepage parser extracts the Greenhouse link as a candidate (source: `HOMEPAGE_LINK`, `host_type: SUPPORTED_ATS`).
- Candidate is ranked above any guessed official domain URL.
- Verification confirms it as a `LISTINGS_SURFACE` (Greenhouse ATS markers present).
- `careers_url` is set to the Greenhouse URL. `ats_type` is `GREENHOUSE`. Extraction uses the Greenhouse extractor.

Pass condition: `ats_type = GREENHOUSE`, `extractor_used = GREENHOUSE`, `careers_url` points to `boards.greenhouse.io/…`, company does not end as `UNVERIFIED`.

---

## Pattern 4 — ATS embedded via iframe or script

**Example structure:** `company.com/careers` page embeds Lever or Ashby jobs via an iframe or a script tag (e.g., `<script src="https://jobs.lever.co/embed/...">` or `<iframe src="https://jobs.ashbyhq.com/...">`).

Expected pipeline behavior:
- Homepage links to `company.com/careers` (or a URL guess hits it).
- Candidate is generated. Verification classifies the page as a `CAREERS_LANDING` (has careers content but no directly enumerable listing links in static HTML).
- Resolver extracts the iframe `src` or script-embedded ATS URL as a high confidence next hop.
- Resolved ATS URL is verified as a `LISTINGS_SURFACE`.
- `resolution_method` is `EMBEDDED_ATS`. `careers_url` is the official page; `listings_url` is the ATS embed URL.
- `ats_type` reflects the embedded platform. Extraction starts from `listings_url`.

Pass condition: the embedded ATS is detected and used as the listings surface, not the outer landing page.

---

## Pattern 5 — Careers landing page with "View openings" button

**Example structure:** `company.com/careers` is a culture/branding page with a prominent "View all openings" or "See open roles" button that links to `company.com/careers/jobs` or a supported ATS URL.

Expected pipeline behavior:
- Candidate generated from URL guess or homepage link.
- Verification classifies it as `CAREERS_LANDING` (strong careers intent, CTA present, no direct job listings enumerable).
- Resolver follows the strong CTA link.
- Target page is re-verified. If it is a `LISTINGS_SURFACE`, it is accepted.
- `resolution_method` is `FOLLOW_CTA`.

Pass condition: `careers_url` is the landing page, `listings_url` is the resolved jobs page, extraction starts from the jobs page, company does not end as `UNVERIFIED`.

---

## Pattern 6 — JS-gated listings that justify Playwright

**Example structure:** `company.com/careers/jobs` loads a React shell with empty server-rendered job content. The page has DOM placeholders but no static job listings in the HTML.

Expected pipeline behavior:
- Candidate is generated and verified as a `CAREERS_LANDING` or weak `LISTINGS_SURFACE` (placeholder evidence found, no static listings).
- Resolver detects JS gating evidence: present DOM structure for jobs, empty server-rendered content, script-loaded ATS config.
- `resolution_method` is `PLAYWRIGHT_REQUIRED`.
- Discovery returns the candidate with `page_kind` and `resolution_method` set; does not invoke Playwright itself.
- Worker extraction orchestration sees `PLAYWRIGHT_REQUIRED` evidence and triggers Playwright fallback under the conditions in Step D5.2.
- `extractor_used` is updated to `PLAYWRIGHT` before fallback executes.

Pass condition: Playwright fallback activates only because discovery provided a high-confidence JS gating signal, not speculatively. If Playwright succeeds, company finalizes normally. If Playwright fails, company finalizes as `UNVERIFIED` with `PLAYWRIGHT_FAILED`.

---

## Pattern 7 — Weak generic page that must remain unverified

**Example structure:** `company.com/careers` returns a generic corporate page about company values with a single off-topic mention of "career growth", no job listings, no CTA, no ATS markers.

Expected pipeline behavior:
- Candidate is generated (URL guess or homepage link).
- Verification rejects it: weak or no hiring signals, no listings content, no strong CTA, no ATS markers.
- No other candidates pass verification.
- Discovery returns `careers_url: null`.
- Worker orchestration finalizes company as `UNVERIFIED`, `failure_code: CAREERS_PAGE_UNVERIFIED` or `CAREERS_NOT_FOUND`.

Pass condition: company ends as `UNVERIFIED`. The weak page is never persisted as `careers_url`. The pipeline does not treat official-domain HTML as sufficient.

---

## How to use this checklist

1. Pick one or more of the patterns above.
2. Find or construct a real company matching that structure.
3. Run the company through discovery manually or via a single-company test run.
4. Check the trace events (`careers_url_attempts`, `careers_url_selected`, `finalization_outcome`) to confirm the pipeline took the expected path.
5. Check the persisted DB row for `careers_url`, `ats_type`, `extractor_used`, `failure_code`, and final `status`.
6. Compare against the pass conditions above.

If any pattern diverges, file it as a discovery regression before merging the related change.
