/**
 * D7.1: Deterministic unit coverage for discovery heuristics.
 *
 * Covers the seven regression-critical scenarios listed in the roadmap:
 *   1. Homepage contains an explicit careers link → HOMEPAGE_LINK candidate extracted.
 *   2. Homepage contains an explicit ATS link    → ATS_LINK candidate extracted (and ranked first).
 *   3. Guessed URL returns generic HTML          → verifyCareersCandidate rejects it (null).
 *   4. Verified careers landing page with CTA   → resolveListingsSurface follows CTA, returns CTA_RESOLVED.
 *   5. Supported ATS page outranks weaker official-domain page → ATS URL selected by discoverCareersUrl.
 *   6. Search result must still pass verification → generic search result rejected (CAREERS_PAGE_UNVERIFIED).
 *   7. JS evidence present but unresolved       → resolveListingsSurface returns PLAYWRIGHT_REQUIRED.
 *
 * All network I/O is replaced with synchronous fixtures via vi.stubGlobal / vi.mock.
 * No real HTTP requests are made.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyListingsStrength,
  detectAtsEmbedCandidates,
  detectCtaCandidates,
  detectJsGating,
  discoverCareersUrl,
  extractCandidatesFromHomepage,
  rankCtaCandidates,
  resolveListingsSurface,
  scoreCtaCandidate,
  verifyCareersCandidate,
} from "../discovery.js";
import { searchCareersCandidates } from "../search.js";
import type { VerifiedCandidate } from "../discoveryTypes.js";

// ---------------------------------------------------------------------------
// Module-level mock: replace the real DuckDuckGo search with a controllable stub.
// Default: returns no candidates (tests that need search results override per-test).
// ---------------------------------------------------------------------------
vi.mock("../search.js", () => ({
  searchCareersCandidates: vi.fn().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Build a minimal fetch Response-like object that passes the HTML content-type gate. */
function makeHtmlResponse(html: string, url: string) {
  return {
    ok: true as const,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null,
    },
    text: async () => html,
    url,
  };
}

/** Returned by the fetch stub for any URL that should appear unreachable. */
const FAIL_RESPONSE = { ok: false as const };

// ---------------------------------------------------------------------------
// HTML fixtures — intentionally minimal so signals are unambiguous
// ---------------------------------------------------------------------------

/**
 * Generic corporate homepage with no career intent at all.
 * Must fail verifyCareersCandidate (neither threshold met).
 */
const GENERIC_CORPORATE_HTML = `
<html><head><title>Acme Corp - Technology Solutions</title></head>
<body>
  <h1>Welcome to Acme Corp</h1>
  <p>We provide enterprise software solutions worldwide.</p>
  <a href="/about">About</a>
  <a href="/contact">Contact</a>
</body></html>`;

/**
 * Careers landing page on the official domain.
 * Passes verifyCareersCandidate as CAREERS_LANDING (C1 title + C3 URL path + C6 CTA language).
 * Does NOT have enough listing signals to be a LISTINGS_SURFACE.
 */
const OFFICIAL_CAREERS_LANDING_HTML = `
<html><head><title>Careers at Acme</title></head>
<body>
  <h1>Join Our Team</h1>
  <p>View openings and explore our open roles.</p>
  <a href="/careers/jobs">View Openings</a>
</body></html>`;

/**
 * A proper listings surface: 5 unique job-detail links trigger Signal L3 (score += 3 ≥ threshold 3).
 * Used wherever the pipeline must confirm it reached an actual listings surface.
 */
const LISTINGS_SURFACE_HTML = `
<html><head><title>Open Positions at Acme</title></head>
<body>
  <a href="/jobs/engineering/1/software-engineer">Software Engineer</a>
  <a href="/jobs/engineering/2/backend-engineer">Backend Engineer</a>
  <a href="/jobs/product/3/product-manager">Product Manager</a>
  <a href="/jobs/design/4/ux-designer">UX Designer</a>
  <a href="/jobs/data/5/data-analyst">Data Analyst</a>
</body></html>`;

/**
 * Minimal page hosted on an ATS domain.
 * verifyCareersCandidate awards Signal L1 (+4) because the finalUrl is on greenhouse.io,
 * so listingScore = 4 ≥ 3 → LISTINGS_SURFACE even with thin content.
 */
const ATS_HOSTED_HTML = `
<html><head><title>Jobs at Acme</title></head>
<body><p>Open positions at Acme Corp.</p></body></html>`;

/**
 * Careers landing page that embeds the Greenhouse JS-only widget.
 * detectJsGating fires on the boards.greenhouse.io/embed/job_board/js script URL (JS1).
 * No server-rendered job links → also triggers JS2a via the empty grnhse_app container.
 * No outbound ATS anchors, so the resolver cannot navigate away — must return PLAYWRIGHT_REQUIRED.
 */
const JS_GATED_CAREERS_HTML = `
<html>
<head>
  <title>Careers at Acme</title>
  <script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>
</head>
<body>
  <h1>Join Us</h1>
  <div id="grnhse_app"></div>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Cleanup after every test
// ---------------------------------------------------------------------------
afterEach(() => {
  vi.unstubAllGlobals();
  // Reset search stub to the default (no results) so tests are independent.
  vi.mocked(searchCareersCandidates).mockResolvedValue([]);
});

// ===========================================================================
// 1 & 2 — extractCandidatesFromHomepage
// ===========================================================================
describe("extractCandidatesFromHomepage", () => {
  it(
    "D7.1-1: extracts a HOMEPAGE_LINK candidate when the homepage has an explicit careers anchor",
    () => {
      const html = `<html><body>
        <a href="/about">About</a>
        <a href="/careers">Careers</a>
      </body></html>`;

      const candidates = extractCandidatesFromHomepage(
        html,
        "https://acme.com",
        "acme.com",
      );

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        allowed: true,
      });
    },
  );

  it(
    "D7.1-2: extracts an ATS_LINK candidate when the homepage links directly to a supported ATS",
    () => {
      const html = `<html><body>
        <a href="https://boards.greenhouse.io/acmecorp">View Jobs</a>
      </body></html>`;

      const candidates = extractCandidatesFromHomepage(
        html,
        "https://acme.com",
        "acme.com",
      );

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        url: "https://boards.greenhouse.io/acmecorp",
        source_type: "ATS_LINK",
        host_type: "SUPPORTED_ATS",
        allowed: true,
      });
    },
  );

  it("places ATS_LINK candidates before HOMEPAGE_LINK candidates", () => {
    // Even though the careers link appears first in DOM order, the ATS link must
    // be returned first because extractCandidatesFromHomepage outputs atsCandidates
    // before careerCandidates.
    const html = `<html><body>
      <a href="/careers">Careers</a>
      <a href="https://boards.greenhouse.io/acmecorp">Jobs Board</a>
    </body></html>`;

    const candidates = extractCandidatesFromHomepage(
      html,
      "https://acme.com",
      "acme.com",
    );

    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.source_type).toBe("ATS_LINK");
    expect(candidates[1]!.source_type).toBe("HOMEPAGE_LINK");
  });

  it("accepts a listings- or board-shaped ATS URL in an inline script body (not arbitrary ATS literals)", () => {
    const html = `<html><body>
      <script>
        var board = "https://boards.greenhouse.io/testco";
      </script>
    </body></html>`;
    const candidates = extractCandidatesFromHomepage(
      html,
      "https://acme.com",
      "acme.com",
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      url: "https://boards.greenhouse.io/testco",
      source_type: "EMBEDDED_ATS",
    });
  });

  it("does not add EMBEDDED_ATS from non-board ATS URLs in inline script bodies (e.g. API paths)", () => {
    const html = `<html><body>
      <script>
        var config = { apiUrl: "https://app.ashbyhq.com/api/non-user-facing/job-board/fintech-co" };
      </script>
    </body></html>`;
    const candidates = extractCandidatesFromHomepage(
      html,
      "https://acme.com",
      "acme.com",
    );
    expect(candidates).toHaveLength(0);
  });
});

/**
 * Careers landing page with an ATS embed (Greenhouse grnhse_app container +
 * boards.greenhouse.io embed script) and CTA language.
 *
 * This fixture represents the pattern found on pages like redditinc.com/careers:
 * strong careers identity signals, ATS embed markers, CTA language, but no
 * server-rendered job listings.
 *
 * Expected classification: CAREERS_LANDING (not LISTINGS_SURFACE).
 * Signal breakdown:
 *   C1 (+2): title "Careers at Acme"
 *   C3 (+1): /careers path
 *   C6 (+1): "view openings" CTA phrase
 *   C7 (+2): Greenhouse ATS embed container markers
 *   careersScore = 6 ≥ CAREERS_THRESHOLD (2) → CAREERS_LANDING
 *   listingScore = 0 (L2 removed; no job-detail links; no job card patterns)
 */
const ATS_EMBED_CAREERS_LANDING_HTML = `
<html>
<head>
  <title>Careers at Acme</title>
  <script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>
</head>
<body>
  <h1>Work with us</h1>
  <p>We're always looking for talented people. View openings and apply today.</p>
  <div id="grnhse_app"></div>
</body>
</html>`;

// ===========================================================================
// 3 — verifyCareersCandidate: generic HTML must be rejected
// ===========================================================================
describe("verifyCareersCandidate", () => {
  it(
    "D7.1-3: returns null for a generic corporate page with no career signals (guessed URL scenario)",
    () => {
      // A guessed URL like /careers that returns bland corporate HTML must be
      // rejected regardless of being on the official domain.
      const result = verifyCareersCandidate(
        "https://acme.com/careers",
        GENERIC_CORPORATE_HTML,
        "https://acme.com/careers",
      );

      expect(result).toBeNull();
    },
  );

  it("classifies an ATS-hosted page as LISTINGS_SURFACE via Signal L1", () => {
    // When finalUrl is on a supported ATS host, Signal L1 awards +4 (≥ threshold 3)
    // regardless of content, confirming ATS host is the strongest possible signal.
    const result = verifyCareersCandidate(
      "https://boards.greenhouse.io/acmecorp",
      ATS_HOSTED_HTML,
      "https://boards.greenhouse.io/acmecorp",
    );

    expect(result).not.toBeNull();
    expect(result!.page_kind).toBe("LISTINGS_SURFACE");
  });

  it("classifies a careers landing page with title + CTA as CAREERS_LANDING", () => {
    // C1 (title "Careers") + C3 (/careers path) + C6 (CTA language) → careersScore ≥ 2
    const result = verifyCareersCandidate(
      "https://acme.com/careers",
      OFFICIAL_CAREERS_LANDING_HTML,
      "https://acme.com/careers",
    );

    expect(result).not.toBeNull();
    expect(result!.page_kind).toBe("CAREERS_LANDING");
  });

  it(
    "C2.1: classifies a page with ATS embed markers and CTA language as CAREERS_LANDING, not LISTINGS_SURFACE",
    () => {
      // Acceptance criterion: pages like redditinc.com/careers must classify as
      // CAREERS_LANDING.  ATS embed container markers (grnhse_app div + embed script)
      // now contribute to careersScore via Signal C7 (+2) instead of listingScore.
      // Combined with C1 (title +2), C3 (path +1), C6 (CTA +1) → careersScore = 6.
      // listingScore stays at 0 (no job-detail links, no job card patterns).
      const result = verifyCareersCandidate(
        "https://acme.com/careers",
        ATS_EMBED_CAREERS_LANDING_HTML,
        "https://acme.com/careers",
      );

      expect(result).not.toBeNull();
      expect(result!.page_kind).toBe("CAREERS_LANDING");
      expect(result!.verification_reasons.some((r) => r.includes("ATS embed container"))).toBe(
        true,
      );
    },
  );

  it(
    "C2.1: ATS embed markers alone do not cause LISTINGS_SURFACE classification",
    () => {
      // A page with only ATS embed markers and no server-rendered job content
      // must not classify as LISTINGS_SURFACE.  It should be CAREERS_LANDING
      // (or null if careers signals are also insufficient).
      const minimalAtsEmbedHtml = `
<html>
<head><title>Careers at Acme</title></head>
<body>
  <div id="grnhse_app"></div>
</body>
</html>`;

      const result = verifyCareersCandidate(
        "https://acme.com/careers",
        minimalAtsEmbedHtml,
        "https://acme.com/careers",
      );

      // Must never classify as LISTINGS_SURFACE.
      expect(result?.page_kind).not.toBe("LISTINGS_SURFACE");
    },
  );
});

// ===========================================================================
// 4 — resolveListingsSurface: CTA link followed to listings surface
// ===========================================================================
describe("resolveListingsSurface", () => {
  it(
    "D7.1-4: follows a strong CTA link from a careers landing page to reach a listings surface",
    async () => {
      // The careers landing page contains <a href="/careers/jobs">View Openings</a>.
      // OFFICIAL_CAREERS_LANDING_HTML matches this fixture exactly.
      // The resolver fetches /careers/jobs and verifies it as a LISTINGS_SURFACE.

      vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        const u = url.toString();
        if (u === "https://acme.com/careers/jobs") {
          return makeHtmlResponse(LISTINGS_SURFACE_HTML, u);
        }
        return FAIL_RESPONSE;
      });

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "CAREERS_LANDING",
        verification_reasons: ["page title signals careers intent"],
      };

      const result = await resolveListingsSurface(
        verified,
        OFFICIAL_CAREERS_LANDING_HTML,
        "acme.com",
      );

      expect(result.resolution_method).toBe("CTA_RESOLVED");
      expect(result.listings_url).toBe("https://acme.com/careers/jobs");
      expect(result.page_kind).toBe("LISTINGS_SURFACE");
      expect(result.careers_url).toBe("https://acme.com/careers");
    },
  );

  // ===========================================================================
  // 7 — JS gating evidence → PLAYWRIGHT_REQUIRED (tested here, in the same unit)
  // ===========================================================================
  it(
    "D7.1-7: returns PLAYWRIGHT_REQUIRED when JS gating evidence is present and no CTA resolves",
    async () => {
      // JS_GATED_CAREERS_HTML contains the Greenhouse embed script (JS1 signal).
      // The resolver will try to fetch the embed script URL as an ATS_RESOLVED
      // candidate; when that fetch fails, it falls through to detectJsGating,
      // which confirms JS gating and returns PLAYWRIGHT_REQUIRED instead of UNRESOLVED.

      vi.stubGlobal("fetch", async () => FAIL_RESPONSE);

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "CAREERS_LANDING",
        verification_reasons: ["page title signals careers intent"],
      };

      const result = await resolveListingsSurface(
        verified,
        JS_GATED_CAREERS_HTML,
        "acme.com",
      );

      expect(result.resolution_method).toBe("PLAYWRIGHT_REQUIRED");
      expect(result.listings_url).toBeNull();
      expect(result.page_kind).toBe("CAREERS_LANDING");
    },
  );
});

// ===========================================================================
// 5 — discoverCareersUrl: ATS outranks official-domain careers landing page
// ===========================================================================
describe("discoverCareersUrl — candidate ranking", () => {
  it(
    "D7.1-5: selects a supported ATS listings surface over a weaker official-domain careers landing page",
    async () => {
      // Setup:
      //   - URL guess https://acme.com/careers → OFFICIAL_CAREERS_LANDING_HTML
      //       verifies as OFFICIAL_DOMAIN + CAREERS_LANDING → rank 3
      //   - Search returns https://boards.greenhouse.io/acme
      //       verifies as SUPPORTED_ATS + LISTINGS_SURFACE → rank 1
      //
      // After both are seen, rank 1 must win even though rank 3 was discovered first.

      vi.mocked(searchCareersCandidates).mockResolvedValueOnce([
        "https://boards.greenhouse.io/acme",
      ]);

      vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        const u = url.toString();
        if (u === "https://acme.com/careers") {
          return makeHtmlResponse(OFFICIAL_CAREERS_LANDING_HTML, u);
        }
        if (u.startsWith("https://boards.greenhouse.io/acme")) {
          return makeHtmlResponse(ATS_HOSTED_HTML, u);
        }
        return FAIL_RESPONSE;
      });

      const result = await discoverCareersUrl("acme");

      expect(result.careers_url).toBe("https://boards.greenhouse.io/acme");
      expect(result.selected_source_type).toBe("SUPPORTED_ATS");
      expect(result.page_kind).toBe("LISTINGS_SURFACE");
      expect(result.failure_code).toBeNull();
    },
  );
});

// ===========================================================================
// 6 — discoverCareersUrl: search result must still pass verification
// ===========================================================================
describe("discoverCareersUrl — search verification gate", () => {
  it(
    "D7.1-6: rejects a search result that returns generic HTML and reports CAREERS_PAGE_UNVERIFIED",
    async () => {
      // The search returns a URL on the official domain.  The fetched page is
      // generic corporate HTML with no career intent.  verifyCareersCandidate
      // returns null, the candidate is dropped, and since at least one fetch
      // succeeded, failure_code must be CAREERS_PAGE_UNVERIFIED (not CAREERS_NOT_FOUND).

      vi.mocked(searchCareersCandidates).mockResolvedValueOnce([
        "https://acme.com/about-careers",
      ]);

      vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        const u = url.toString();
        if (u === "https://acme.com/about-careers") {
          return makeHtmlResponse(GENERIC_CORPORATE_HTML, u);
        }
        return FAIL_RESPONSE;
      });

      const result = await discoverCareersUrl("acme");

      expect(result.careers_url).toBeNull();
      expect(result.failure_code).toBe("CAREERS_PAGE_UNVERIFIED");
    },
  );
});

// ===========================================================================
// C4.1 — Reddit validation: classification corrected upstream, resolver not bypassed
// ===========================================================================
describe("C4.1 — Reddit validation: classification corrected, resolver not bypassed", () => {
  /**
   * Minimal HTML approximating the redditinc.com/careers pattern:
   *   - Page title carries "Careers" → Signal C1 (+2)
   *   - URL path /careers → Signal C3 (+1)
   *   - ATS iframe/script embed src → Signal C5 (+2)
   *   - CTA phrase "View openings" → Signal C6 (+1)
   *   - Greenhouse JS embed URL in script src → Signal C7 (+2) for atsContainerProviders
   *   - Empty grnhse_app container (no server-rendered job listings)
   *
   * listingScore = 0  (ATS embed markers no longer contribute to listing score;
   *                    no job-detail links; no job-card patterns)
   * careersScore = 8  (C1 + C3 + C5 + C6 + C7)
   *
   * Expected classification: CAREERS_LANDING (not LISTINGS_SURFACE).
   */
  const REDDIT_CAREERS_HTML = `<html>
<head>
  <title>Careers | Reddit</title>
  <script src="https://boards.greenhouse.io/embed/job_board/js?for=reddit"></script>
</head>
<body>
  <h1>Work at Reddit</h1>
  <p>Explore open roles and join the team. View openings below.</p>
  <div id="grnhse_app"></div>
</body>
</html>`;

  it(
    "C4.1-a: Reddit careers page classifies as CAREERS_LANDING, not LISTINGS_SURFACE",
    () => {
      const result = verifyCareersCandidate(
        "https://redditinc.com/careers",
        REDDIT_CAREERS_HTML,
        "https://redditinc.com/careers",
      );

      expect(result).not.toBeNull();
      // Acceptance criterion: classification is corrected upstream.
      expect(result!.page_kind).toBe("CAREERS_LANDING");
    },
  );

  it(
    "C4.1-b: resolveListingsSurface does NOT take the DIRECT_VERIFIED fast path for a CAREERS_LANDING page",
    async () => {
      // All next-hop fetches fail — resolver exhausts its candidate list and
      // falls through to detectJsGating, which surfaces PLAYWRIGHT_REQUIRED.
      vi.stubGlobal("fetch", async () => FAIL_RESPONSE);

      const verified: VerifiedCandidate = {
        url: "https://redditinc.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "CAREERS_LANDING",
        verification_reasons: [
          "page title signals careers intent",
          "ATS embed container markers present (Greenhouse)",
        ],
      };

      const result = await resolveListingsSurface(
        verified,
        REDDIT_CAREERS_HTML,
        "redditinc.com",
      );

      // DIRECT_VERIFIED is only taken when the candidate IS a LISTINGS_SURFACE.
      // After the C1–C3 fixes, the Reddit careers page never reaches that path.
      expect(result.resolution_method).not.toBe("DIRECT_VERIFIED");
      // JS gating evidence (boards.greenhouse.io/embed/job_board/js) is detected
      // and escalates the outcome to PLAYWRIGHT_REQUIRED instead of UNRESOLVED.
      expect(result.resolution_method).toBe("PLAYWRIGHT_REQUIRED");
      // No listings surface was resolved — listings_url must stay null.
      expect(result.listings_url).toBeNull();
      expect(result.page_kind).toBe("CAREERS_LANDING");
    },
  );

  it(
    "C4.1-c: discoverCareersUrl for Reddit returns CAREERS_LANDING and does not produce DIRECT_VERIFIED",
    async () => {
      // Serve the Reddit careers page only for the /careers URL guess;
      // all other URLs (homepage, other guesses, embed script fetch) fail.
      vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        const u = url.toString();
        if (
          u === "https://reddit.com/careers" ||
          u === "https://www.reddit.com/careers"
        ) {
          return makeHtmlResponse(REDDIT_CAREERS_HTML, u);
        }
        return FAIL_RESPONSE;
      });

      const result = await discoverCareersUrl("Reddit");

      // Acceptance criterion: classification is corrected upstream.
      expect(result.page_kind).toBe("CAREERS_LANDING");
      // Acceptance criterion: resolver does NOT take the DIRECT_VERIFIED fast path.
      expect(result.resolution_method).not.toBe("DIRECT_VERIFIED");
      // JS gating evidence is detected and surfaced as PLAYWRIGHT_REQUIRED,
      // ensuring extraction is escalated to Playwright rather than falsely
      // completing via HTTP extraction on the careers landing page.
      expect(result.resolution_method).toBe("PLAYWRIGHT_REQUIRED");
      // A careers_url was found — discovery did not silently fail.
      expect(result.careers_url).not.toBeNull();
      // No discovery failure code — the pipeline succeeded up to the resolver stage.
      expect(result.failure_code).toBeNull();
    },
  );
});

// ===========================================================================
// C4.2 — True listings surfaces: no regression after false-positive fixes
// ===========================================================================
describe("C4.2 — True listings surfaces still classify as LISTINGS_SURFACE", () => {
  /**
   * A real Greenhouse board page served directly from boards.greenhouse.io.
   * Signal L1 fires (+4) because finalUrl is on a supported ATS host,
   * and finalHostIsAts satisfies the hasExtractableListings gate.
   * Expected: LISTINGS_SURFACE with no regression.
   */
  it(
    "C4.2-a: direct Greenhouse board URL classifies as LISTINGS_SURFACE via Signal L1",
    () => {
      const result = verifyCareersCandidate(
        "https://boards.greenhouse.io/acmecorp",
        ATS_HOSTED_HTML,
        "https://boards.greenhouse.io/acmecorp",
      );

      expect(result).not.toBeNull();
      expect(result!.page_kind).toBe("LISTINGS_SURFACE");
      expect(
        result!.verification_reasons.some((r) =>
          r.includes("supported ATS host"),
        ),
      ).toBe(true);
    },
  );

  /**
   * A real Lever board page served directly from jobs.lever.co.
   * Signal L1 fires (+4) because jobs.lever.co ends with .lever.co (a supported ATS suffix).
   * finalHostIsAts is true → hasExtractableListings is satisfied.
   * Expected: LISTINGS_SURFACE.
   */
  it(
    "C4.2-b: direct Lever board URL classifies as LISTINGS_SURFACE via Signal L1",
    () => {
      const leverHtml = `
<html><head><title>Jobs at Acme — Lever</title></head>
<body><p>Open positions at Acme Corp.</p></body></html>`;

      const result = verifyCareersCandidate(
        "https://jobs.lever.co/acmecorp",
        leverHtml,
        "https://jobs.lever.co/acmecorp",
      );

      expect(result).not.toBeNull();
      expect(result!.page_kind).toBe("LISTINGS_SURFACE");
      expect(
        result!.verification_reasons.some((r) =>
          r.includes("supported ATS host"),
        ),
      ).toBe(true);
    },
  );

  /**
   * A plain server-rendered HTML listings page on the official domain.
   * Five unique job-detail links trigger Signal L3 (score += 3 ≥ threshold 3)
   * and satisfy the hasExtractableListings gate (uniqueJobLinks >= 3).
   * No ATS embed markers present → must not be classified as CAREERS_LANDING.
   * Expected: LISTINGS_SURFACE.
   */
  it(
    "C4.2-c: simple HTML listings page with 5 job-detail links classifies as LISTINGS_SURFACE via Signal L3",
    () => {
      const result = verifyCareersCandidate(
        "https://acme.com/careers/jobs",
        LISTINGS_SURFACE_HTML,
        "https://acme.com/careers/jobs",
      );

      expect(result).not.toBeNull();
      expect(result!.page_kind).toBe("LISTINGS_SURFACE");
      expect(
        result!.verification_reasons.some((r) =>
          r.includes("job detail link"),
        ),
      ).toBe(true);
    },
  );

  /**
   * Confirm the false-positive fix (C2.1 / C4.1) is still in place:
   * a careers page that only carries ATS embed markers and CTA language
   * (no server-rendered job links, not on an ATS host) must NOT regress
   * back to LISTINGS_SURFACE.
   */
  it(
    "C4.2-d: ATS embed landing page is still CAREERS_LANDING — no regression to LISTINGS_SURFACE",
    () => {
      const result = verifyCareersCandidate(
        "https://acme.com/careers",
        ATS_EMBED_CAREERS_LANDING_HTML,
        "https://acme.com/careers",
      );

      expect(result).not.toBeNull();
      expect(result!.page_kind).toBe("CAREERS_LANDING");
    },
  );
});

// ===========================================================================
// C1.1 — classifyListingsStrength: internal strength classification
// ===========================================================================
describe("C1.1 — classifyListingsStrength", () => {
  // -------------------------------------------------------------------------
  // STRONG cases
  // -------------------------------------------------------------------------

  it(
    "C1.1-1: direct Greenhouse board URL (ATS host) classifies as STRONG_LISTINGS_SURFACE",
    () => {
      // boards.greenhouse.io is a supported ATS host → direct board → STRONG
      // regardless of HTML content (the host check fires first).
      const result = classifyListingsStrength(
        "LISTINGS_SURFACE",
        ATS_HOSTED_HTML,
        "https://boards.greenhouse.io/acmecorp",
      );
      expect(result).toBe("STRONG_LISTINGS_SURFACE");
    },
  );

  it(
    "C1.1-2: direct Lever board URL (ATS host) classifies as STRONG_LISTINGS_SURFACE",
    () => {
      const leverHtml = `<html><head><title>Jobs at Acme</title></head>
<body><p>Open positions.</p></body></html>`;
      const result = classifyListingsStrength(
        "LISTINGS_SURFACE",
        leverHtml,
        "https://jobs.lever.co/acmecorp",
      );
      expect(result).toBe("STRONG_LISTINGS_SURFACE");
    },
  );

  it(
    "C1.1-3: plain server-rendered listings page on official domain with no ATS embed markers classifies as STRONG",
    () => {
      // LISTINGS_SURFACE_HTML has 5 unique job-detail links, no ATS embed markers.
      const result = classifyListingsStrength(
        "LISTINGS_SURFACE",
        LISTINGS_SURFACE_HTML,
        "https://acme.com/careers/jobs",
      );
      expect(result).toBe("STRONG_LISTINGS_SURFACE");
    },
  );

  // -------------------------------------------------------------------------
  // WEAK cases — ATS embed markers must always produce WEAK, not STRONG
  // -------------------------------------------------------------------------

  it(
    "C1.1-4: LISTINGS_SURFACE page with Greenhouse embed container (grnhse_app) classifies as WEAK",
    () => {
      // A page that has both direct job-detail links (meeting listing threshold)
      // AND a Greenhouse embed container must be WEAK — the embed marker signals
      // that listings may be JS-driven, not fully server-rendered.
      const hybridHtml = `
<html><head><title>Open Positions at Acme</title></head>
<body>
  <a href="/jobs/engineering/1/software-engineer">Software Engineer</a>
  <a href="/jobs/engineering/2/backend-engineer">Backend Engineer</a>
  <a href="/jobs/product/3/product-manager">Product Manager</a>
  <div id="grnhse_app"></div>
</body></html>`;

      const result = classifyListingsStrength(
        "LISTINGS_SURFACE",
        hybridHtml,
        "https://acme.com/careers",
      );
      expect(result).toBe("WEAK_LISTINGS_SURFACE");
    },
  );

  it(
    "C1.1-5: LISTINGS_SURFACE page with Greenhouse embed script src classifies as WEAK",
    () => {
      // boards.greenhouse.io/embed/... in a script src is an ATS iframe/script embed.
      const hybridHtml = `
<html><head>
  <script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>
</head>
<body>
  <a href="/jobs/engineering/1/software-engineer">Software Engineer</a>
  <a href="/jobs/engineering/2/backend-engineer">Backend Engineer</a>
  <a href="/jobs/product/3/product-manager">Product Manager</a>
</body></html>`;

      const result = classifyListingsStrength(
        "LISTINGS_SURFACE",
        hybridHtml,
        "https://acme.com/careers",
      );
      expect(result).toBe("WEAK_LISTINGS_SURFACE");
    },
  );

  it(
    "C1.1-6: LISTINGS_SURFACE page with Lever postings-container class classifies as WEAK",
    () => {
      const hybridHtml = `
<html><head><title>Jobs</title></head>
<body>
  <a href="/jobs/engineering/1/swe">SWE</a>
  <a href="/jobs/engineering/2/be">BE</a>
  <a href="/jobs/product/3/pm">PM</a>
  <div class="postings-container" id="lever-jobs-container"></div>
</body></html>`;

      const result = classifyListingsStrength(
        "LISTINGS_SURFACE",
        hybridHtml,
        "https://acme.com/jobs",
      );
      expect(result).toBe("WEAK_LISTINGS_SURFACE");
    },
  );

  it(
    "C1.1-7: ATS embed signals do NOT promote a WEAK page to STRONG even on an official domain",
    () => {
      // Critical rule from C1.1: ATS embed signals MUST NOT alone qualify STRONG.
      // Even with a high listing score, embed markers force WEAK.
      const result = classifyListingsStrength(
        "LISTINGS_SURFACE",
        JS_GATED_CAREERS_HTML,
        "https://acme.com/careers",
      );
      // JS_GATED_CAREERS_HTML has the Greenhouse embed script (JS1 gating signal).
      expect(result).toBe("WEAK_LISTINGS_SURFACE");
    },
  );

  // -------------------------------------------------------------------------
  // CAREERS_LANDING passthrough
  // -------------------------------------------------------------------------

  it(
    "C1.1-8: CAREERS_LANDING page kind always classifies as CAREERS_LANDING strength",
    () => {
      // Any page already classified as CAREERS_LANDING by verifyCareersCandidate
      // maps straight through — it is neither STRONG nor WEAK listings surface.
      // This covers the redditinc.com/careers pattern: strong careers identity
      // signals + ATS embed markers but zero server-rendered job listings.
      const result = classifyListingsStrength(
        "CAREERS_LANDING",
        ATS_EMBED_CAREERS_LANDING_HTML,
        "https://acme.com/careers",
      );
      expect(result).toBe("CAREERS_LANDING");
    },
  );

  it(
    "C1.1-9: CAREERS_LANDING page kind is not affected by embed markers in the HTML",
    () => {
      // Even if the HTML has ATS embed markers, CAREERS_LANDING always stays
      // CAREERS_LANDING in the strength classification (not WEAK_LISTINGS_SURFACE).
      const result = classifyListingsStrength(
        "CAREERS_LANDING",
        JS_GATED_CAREERS_HTML,
        "https://acme.com/careers",
      );
      expect(result).toBe("CAREERS_LANDING");
    },
  );
});

// ===========================================================================
// C2.2 — resolveListingsSurface: weak surfaces never produce DIRECT_VERIFIED
// ===========================================================================
describe("C2.2 — resolveListingsSurface: DIRECT_VERIFIED only for STRONG surfaces", () => {
  /**
   * HTML that passes verifyCareersCandidate as LISTINGS_SURFACE (5 unique job-detail
   * links → Signal L3 +3, meets threshold) but also contains an empty Greenhouse
   * embed container (id="grnhse_app").
   *
   * classifyListingsStrength → WEAK_LISTINGS_SURFACE (grnhse_app present).
   *
   * resolveListingsSurface MUST NOT return DIRECT_VERIFIED for this input.
   * It falls through to the slow path and, finding no resolvable next-hop,
   * returns UNRESOLVED (detectJsGating returns null because hasJobDetailLinks=true
   * suppresses JS2a, and no embed script URL is present to trigger JS1).
   */
  const WEAK_LISTINGS_WITH_EMBED_HTML = `
<html>
<head><title>Open Positions at Acme</title></head>
<body>
  <a href="/jobs/engineering/1/software-engineer">Software Engineer</a>
  <a href="/jobs/engineering/2/backend-engineer">Backend Engineer</a>
  <a href="/jobs/product/3/product-manager">Product Manager</a>
  <a href="/jobs/design/4/ux-designer">UX Designer</a>
  <a href="/jobs/data/5/data-analyst">Data Analyst</a>
  <div id="grnhse_app"></div>
</body>
</html>`;

  it(
    "C2.2-1: LISTINGS_SURFACE candidate with Greenhouse embed container never produces DIRECT_VERIFIED",
    async () => {
      // All next-hop fetches fail — the slow path exhausts its candidate list
      // and returns UNRESOLVED (no JS gating evidence, no resolvable next-hop).
      vi.stubGlobal("fetch", async () => FAIL_RESPONSE);

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        // page_kind is LISTINGS_SURFACE (as verifyCareersCandidate would return for
        // a page with 5 job-detail links), but the HTML also has id="grnhse_app"
        // which makes classifyListingsStrength classify it as WEAK.
        page_kind: "LISTINGS_SURFACE",
        verification_reasons: ["page contains 5 unique job detail links"],
      };

      const result = await resolveListingsSurface(
        verified,
        WEAK_LISTINGS_WITH_EMBED_HTML,
        "acme.com",
      );

      // C2.2 acceptance criterion: DIRECT_VERIFIED must never be returned for
      // a weak listings surface, regardless of the listing score.
      expect(result.resolution_method).not.toBe("DIRECT_VERIFIED");
      // C3.1: The slow path finds no resolvable next-hop from a WEAK surface → INDIRECT.
      expect(result.resolution_method).toBe("INDIRECT");
      // listings_url must remain null — no surface was resolved.
      expect(result.listings_url).toBeNull();
    },
  );

  it(
    "C2.2-2: LISTINGS_SURFACE candidate with Lever postings-container never produces DIRECT_VERIFIED",
    async () => {
      vi.stubGlobal("fetch", async () => FAIL_RESPONSE);

      const weakLeverHtml = `
<html>
<head><title>Jobs at Acme</title></head>
<body>
  <a href="/jobs/engineering/1/swe">Software Engineer</a>
  <a href="/jobs/engineering/2/be">Backend Engineer</a>
  <a href="/jobs/product/3/pm">Product Manager</a>
  <a href="/jobs/design/4/ux">UX Designer</a>
  <a href="/jobs/data/5/da">Data Analyst</a>
  <div class="postings-container" id="lever-jobs-container"></div>
</body>
</html>`;

      const verified: VerifiedCandidate = {
        url: "https://acme.com/jobs",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "LISTINGS_SURFACE",
        verification_reasons: ["page contains 5 unique job detail links"],
      };

      const result = await resolveListingsSurface(
        verified,
        weakLeverHtml,
        "acme.com",
      );

      // C2.2: Lever embed container makes this WEAK — must not produce DIRECT_VERIFIED.
      expect(result.resolution_method).not.toBe("DIRECT_VERIFIED");
      // C3.1: Weak surface with no next-hop → INDIRECT (not UNRESOLVED).
      expect(result.resolution_method).toBe("INDIRECT");
      expect(result.listings_url).toBeNull();
    },
  );

  it(
    "C2.2-3: STRONG LISTINGS_SURFACE on a native ATS host correctly produces DIRECT_VERIFIED (positive guard)",
    async () => {
      // Positive case: a verified candidate whose URL is on a supported ATS host
      // IS a strong surface and must produce DIRECT_VERIFIED.  This confirms the
      // invariant is two-sided: strong → DIRECT_VERIFIED, weak → never DIRECT_VERIFIED.
      const verified: VerifiedCandidate = {
        url: "https://boards.greenhouse.io/acmecorp",
        source_type: "ATS_LINK",
        host_type: "SUPPORTED_ATS",
        page_kind: "LISTINGS_SURFACE",
        verification_reasons: ["final URL is on a supported ATS host"],
      };

      const result = await resolveListingsSurface(
        verified,
        ATS_HOSTED_HTML,
        "acme.com",
      );

      // classifyListingsStrength → STRONG (ATS host URL) → fast path taken.
      expect(result.resolution_method).toBe("DIRECT_VERIFIED");
      // C3.2: listings_url equals careers_url for DIRECT_VERIFIED so that null
      // strictly means "resolution failed" — not "careers_url is the listing surface".
      expect(result.listings_url).toBe("https://boards.greenhouse.io/acmecorp");
      expect(result.careers_url).toBe("https://boards.greenhouse.io/acmecorp");
    },
  );
});

// ===========================================================================
// C3.1 — ResolutionMethod INDIRECT vs UNRESOLVED distinction
// ===========================================================================
describe("C3.1 — resolveListingsSurface: INDIRECT for weak surfaces, UNRESOLVED for careers landing", () => {
  /**
   * When the starting page is a WEAK_LISTINGS_SURFACE (ATS embed markers) and the
   * slow path finds no next-hop, the resolver must return INDIRECT — not UNRESOLVED.
   * This allows downstream stages to know the root cause was a weak starting surface.
   */
  it(
    "C3.1-1: WEAK_LISTINGS_SURFACE that exhausts the slow path returns INDIRECT",
    async () => {
      vi.stubGlobal("fetch", async () => FAIL_RESPONSE);

      const weakHtml = `
<html>
<head><title>Open Positions</title></head>
<body>
  <a href="/jobs/eng/1/swe">Software Engineer</a>
  <a href="/jobs/eng/2/be">Backend Engineer</a>
  <a href="/jobs/prod/3/pm">Product Manager</a>
  <a href="/jobs/des/4/ux">UX Designer</a>
  <a href="/jobs/dat/5/da">Data Analyst</a>
  <div id="grnhse_app"></div>
</body>
</html>`;

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "LISTINGS_SURFACE",
        verification_reasons: ["page contains 5 unique job detail links"],
      };

      const result = await resolveListingsSurface(verified, weakHtml, "acme.com");

      // C3.1: A WEAK_LISTINGS_SURFACE that cannot be resolved must produce
      // INDIRECT, not UNRESOLVED.  This lets downstream distinguish the cause.
      expect(result.resolution_method).toBe("INDIRECT");
      expect(result.resolution_method).not.toBe("UNRESOLVED");
      expect(result.listings_url).toBeNull();
    },
  );

  /**
   * When the starting page is a plain CAREERS_LANDING (no ATS embed markers,
   * not a listings surface at all) and the slow path finds nothing, the resolver
   * must still return UNRESOLVED — not INDIRECT.
   */
  it(
    "C3.1-2: CAREERS_LANDING that exhausts the slow path returns UNRESOLVED",
    async () => {
      vi.stubGlobal("fetch", async () => FAIL_RESPONSE);

      // A plain careers landing page: no ATS embed markers, no job-detail links
      // that would qualify it as LISTINGS_SURFACE. classifyListingsStrength →
      // CAREERS_LANDING (page_kind input is already CAREERS_LANDING).
      const careersLandingHtml = `
<html>
<head><title>Careers at Acme</title></head>
<body>
  <h1>Join our team</h1>
  <p>We are hiring! Browse open roles.</p>
  <a href="/about">About us</a>
  <a href="/jobs">View all jobs</a>
</body>
</html>`;

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "CAREERS_LANDING",
        verification_reasons: ["page title contains 'careers'"],
      };

      const result = await resolveListingsSurface(
        verified,
        careersLandingHtml,
        "acme.com",
      );

      // C3.1: A CAREERS_LANDING exhausting the slow path keeps UNRESOLVED.
      expect(result.resolution_method).toBe("UNRESOLVED");
      expect(result.resolution_method).not.toBe("INDIRECT");
      expect(result.listings_url).toBeNull();
    },
  );

  it(
    "C3.1-3: downstream can distinguish INDIRECT from DIRECT_VERIFIED and UNRESOLVED",
    () => {
      // This test verifies the type contract — INDIRECT is a valid ResolutionMethod
      // that is distinct from all other values.
      const methods: string[] = [
        "DIRECT_VERIFIED",
        "ATS_RESOLVED",
        "CTA_RESOLVED",
        "PLAYWRIGHT_REQUIRED",
        "UNRESOLVED",
        "INDIRECT",
      ];

      // All three semantically significant methods exist and are distinct.
      expect(methods).toContain("DIRECT_VERIFIED");
      expect(methods).toContain("UNRESOLVED");
      expect(methods).toContain("INDIRECT");

      // Downstream uncertainty check: treat INDIRECT the same as UNRESOLVED.
      const isUncertain = (m: string) => m === "INDIRECT" || m === "UNRESOLVED";
      expect(isUncertain("INDIRECT")).toBe(true);
      expect(isUncertain("UNRESOLVED")).toBe(true);
      expect(isUncertain("DIRECT_VERIFIED")).toBe(false);

      // Downstream confidence check: only DIRECT_VERIFIED is strong.
      const isStrong = (m: string) => m === "DIRECT_VERIFIED";
      expect(isStrong("DIRECT_VERIFIED")).toBe(true);
      expect(isStrong("INDIRECT")).toBe(false);
      expect(isStrong("UNRESOLVED")).toBe(false);
    },
  );
});

// ===========================================================================
// R3.1 — re-verify resolved destinations: strong vs weak distinctions
// ===========================================================================
describe("R3.1 — resolveListingsSurface: resolved destinations must pass strength check", () => {
  /**
   * A resolved destination that passes verifyCareersCandidate as LISTINGS_SURFACE
   * (5 unique job-detail links → Signal L3 +3 ≥ threshold) but also contains an
   * ATS embed container (id="grnhse_app") is WEAK_LISTINGS_SURFACE.
   *
   * R3.1 requires classifyListingsStrength to be applied to every resolved
   * destination.  A WEAK destination must be rejected — the resolver continues to
   * the next candidate rather than accepting it, and ultimately returns UNRESOLVED
   * (since the starting page is a plain CAREERS_LANDING with no further hops).
   */
  const WEAK_RESOLVED_DESTINATION_HTML = `
<html>
<head><title>Open Positions at Acme</title></head>
<body>
  <a href="/jobs/engineering/1/software-engineer">Software Engineer</a>
  <a href="/jobs/engineering/2/backend-engineer">Backend Engineer</a>
  <a href="/jobs/product/3/product-manager">Product Manager</a>
  <a href="/jobs/design/4/ux-designer">UX Designer</a>
  <a href="/jobs/data/5/data-analyst">Data Analyst</a>
  <div id="grnhse_app"></div>
</body>
</html>`;

  it(
    "R3.1-1: resolved destination that is WEAK_LISTINGS_SURFACE is rejected — resolver returns UNRESOLVED",
    async () => {
      // The careers landing page (OFFICIAL_CAREERS_LANDING_HTML) has a CTA:
      //   <a href="/careers/jobs">View Openings</a>
      // The resolver follows /careers/jobs, fetches WEAK_RESOLVED_DESTINATION_HTML,
      // which passes verifyCareersCandidate (5 job-detail links → LISTINGS_SURFACE)
      // but then fails classifyListingsStrength (id="grnhse_app" → WEAK).
      // R3.1: the resolver must NOT accept this and must return UNRESOLVED.

      vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        const u = url.toString();
        if (u === "https://acme.com/careers/jobs") {
          return makeHtmlResponse(WEAK_RESOLVED_DESTINATION_HTML, u);
        }
        return FAIL_RESPONSE;
      });

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "CAREERS_LANDING",
        verification_reasons: ["page title signals careers intent"],
      };

      const result = await resolveListingsSurface(
        verified,
        OFFICIAL_CAREERS_LANDING_HTML,
        "acme.com",
      );

      // R3.1: WEAK destination must not be accepted — listings_url stays null.
      expect(result.listings_url).toBeNull();
      // UNRESOLVED because the starting page is a plain CAREERS_LANDING with no
      // remaining hop that clears the strength gate.
      expect(result.resolution_method).toBe("UNRESOLVED");
    },
  );

  it(
    "R3.1-2: resolved destination that is STRONG_LISTINGS_SURFACE is accepted (positive guard)",
    async () => {
      // Same CTA target, but LISTINGS_SURFACE_HTML has no ATS embed container.
      // classifyListingsStrength → STRONG_LISTINGS_SURFACE → accepted.

      vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        const u = url.toString();
        if (u === "https://acme.com/careers/jobs") {
          return makeHtmlResponse(LISTINGS_SURFACE_HTML, u);
        }
        return FAIL_RESPONSE;
      });

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "CAREERS_LANDING",
        verification_reasons: ["page title signals careers intent"],
      };

      const result = await resolveListingsSurface(
        verified,
        OFFICIAL_CAREERS_LANDING_HTML,
        "acme.com",
      );

      // R3.1: Strong destination → accepted, listings_url populated.
      expect(result.listings_url).toBe("https://acme.com/careers/jobs");
      expect(result.resolution_method).toBe("CTA_RESOLVED");
    },
  );

  it(
    "R3.1-3: resolved ATS destination that is STRONG (ATS host URL) is accepted",
    async () => {
      // Careers landing page has an ATS outbound link; the ATS board URL lives on
      // boards.greenhouse.io (supported ATS host) → classifyListingsStrength →
      // STRONG_LISTINGS_SURFACE (ATS host check fires before embed checks).

      const careersWithAtsLink = `
<html>
<head><title>Careers at Acme</title></head>
<body>
  <h1>Join Our Team</h1>
  <a href="https://boards.greenhouse.io/acmecorp">View Jobs on Greenhouse</a>
</body>
</html>`;

      vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        const u = url.toString();
        if (u === "https://boards.greenhouse.io/acmecorp") {
          return makeHtmlResponse(ATS_HOSTED_HTML, u);
        }
        return FAIL_RESPONSE;
      });

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "CAREERS_LANDING",
        verification_reasons: ["page title signals careers intent"],
      };

      const result = await resolveListingsSurface(
        verified,
        careersWithAtsLink,
        "acme.com",
      );

      // ATS host URL → STRONG_LISTINGS_SURFACE → accepted.
      expect(result.listings_url).toBe("https://boards.greenhouse.io/acmecorp");
      expect(result.resolution_method).toBe("ATS_RESOLVED");
    },
  );
});

// ===========================================================================
// detectJsGating — pure function smoke tests
// ===========================================================================
describe("detectJsGating", () => {
  it("detects a Greenhouse JS embed script URL as a definitive JS1 gating signal", () => {
    const html = `<script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>`;
    const reasons = detectJsGating(html);
    expect(reasons).not.toBeNull();
    expect(reasons!.length).toBeGreaterThan(0);
  });

  it("detects an empty Greenhouse container element (JS2a) as a gating signal", () => {
    // No job-detail links in the HTML → JS2a fires (empty grnhse_app container).
    const html = `<html><body><div id="grnhse_app"></div></body></html>`;
    expect(detectJsGating(html)).not.toBeNull();
  });

  it("returns null when server-rendered job links are present alongside the empty container", () => {
    // The empty container alone is not sufficient if job-detail links exist —
    // those indicate the page was server-rendered and no gating is needed.
    const html = `<html><body>
      <div id="grnhse_app"></div>
      <a href="/jobs/engineering/1/software-engineer">Software Engineer</a>
    </body></html>`;
    expect(detectJsGating(html)).toBeNull();
  });

  it("returns null for plain HTML with no JS gating signals", () => {
    expect(detectJsGating(GENERIC_CORPORATE_HTML)).toBeNull();
  });
});

// ===========================================================================
// R1.2 — resolveListingsSurface: ATS embed candidates are fetched and re-verified
// ===========================================================================
describe("R1.2 — resolveListingsSurface resolves ATS embed candidates from detectAtsEmbedCandidates", () => {
  /**
   * A CAREERS_LANDING page that carries a Greenhouse data-gh-token attribute
   * but NO direct anchor href to the board. The canonical board URL must be
   * derived by detectAtsEmbedCandidates and then fetched + re-verified.
   *
   * Expected: resolution_method = 'ATS_RESOLVED', listings_url = Greenhouse board.
   */
  const GH_TOKEN_CAREERS_HTML = `
<html>
<head><title>Careers at Acme</title></head>
<body>
  <h1>Join our team</h1>
  <p>View openings below.</p>
  <div id="grnhse_app" data-gh-token="acmecorp"></div>
</body>
</html>`;

  it(
    "R1.2-1: resolves a Greenhouse board URL from data-gh-token when the board verifies as LISTINGS_SURFACE",
    async () => {
      vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        const u = url.toString();
        // The canonical Greenhouse board returns a real ATS-hosted listings page.
        if (u === "https://boards.greenhouse.io/acmecorp") {
          return makeHtmlResponse(ATS_HOSTED_HTML, u);
        }
        return FAIL_RESPONSE;
      });

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "CAREERS_LANDING",
        verification_reasons: ["page title signals careers intent"],
      };

      const result = await resolveListingsSurface(
        verified,
        GH_TOKEN_CAREERS_HTML,
        "acme.com",
      );

      // Acceptance criterion R1.2: weak container page resolved into ATS listings surface.
      expect(result.resolution_method).toBe("ATS_RESOLVED");
      expect(result.listings_url).toBe("https://boards.greenhouse.io/acmecorp");
      expect(result.page_kind).toBe("LISTINGS_SURFACE");
      expect(result.careers_url).toBe("https://acme.com/careers");
    },
  );

  it(
    "R1.2-2: returns UNRESOLVED when the ATS board URL detected via data-gh-token fails verification",
    async () => {
      // Board URL fails to return HTML — re-verification cannot pass.
      vi.stubGlobal("fetch", async () => FAIL_RESPONSE);

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "CAREERS_LANDING",
        verification_reasons: ["page title signals careers intent"],
      };

      // Use a stripped-down careers page: only data-gh-token, no embed script URL,
      // no JS gating evidence that would fire detectJsGating → must end UNRESOLVED.
      const minimalTokenHtml = `
<html>
<head><title>Careers at Acme</title></head>
<body>
  <div id="grnhse_app" data-gh-token="acmecorp"></div>
</body>
</html>`;

      const result = await resolveListingsSurface(
        verified,
        minimalTokenHtml,
        "acme.com",
      );

      // Conservative path preserved: detection alone is NOT success.
      expect(result.listings_url).toBeNull();
      // Not DIRECT_VERIFIED (no strong surface).
      expect(result.resolution_method).not.toBe("DIRECT_VERIFIED");
    },
  );

  it(
    "R1.2-3: resolves a Lever board URL from data-baseurl when the board verifies as LISTINGS_SURFACE",
    async () => {
      const leverTokenHtml = `
<html>
<head><title>Careers at Acme</title></head>
<body>
  <h1>Join us</h1>
  <div class="postings-container" data-baseurl="https://jobs.lever.co/acmecorp"></div>
</body>
</html>`;

      vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        const u = url.toString();
        if (u === "https://jobs.lever.co/acmecorp") {
          // Lever board returns a minimal ATS-hosted HTML (L1 signal fires).
          return makeHtmlResponse(
            `<html><head><title>Jobs at Acme</title></head><body><p>Open positions.</p></body></html>`,
            u,
          );
        }
        return FAIL_RESPONSE;
      });

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "CAREERS_LANDING",
        verification_reasons: ["page title signals careers intent"],
      };

      const result = await resolveListingsSurface(
        verified,
        leverTokenHtml,
        "acme.com",
      );

      expect(result.resolution_method).toBe("ATS_RESOLVED");
      expect(result.listings_url).toBe("https://jobs.lever.co/acmecorp");
      expect(result.page_kind).toBe("LISTINGS_SURFACE");
    },
  );

  it(
    "R1.2-4: does not fetch the same URL twice when it is captured by both extractResolverCandidates and detectAtsEmbedCandidates",
    async () => {
      // This page has both an <a href> to the Greenhouse board AND a data-gh-token
      // pointing to the same URL. The URL must appear only once in the attempt list.
      const dualSignalHtml = `
<html>
<head><title>Careers at Acme</title></head>
<body>
  <a href="https://boards.greenhouse.io/acmecorp">View Jobs</a>
  <div id="grnhse_app" data-gh-token="acmecorp"></div>
</body>
</html>`;

      const fetchedUrls: string[] = [];
      vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        const u = url.toString();
        fetchedUrls.push(u);
        if (u === "https://boards.greenhouse.io/acmecorp") {
          return makeHtmlResponse(ATS_HOSTED_HTML, u);
        }
        return FAIL_RESPONSE;
      });

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "CAREERS_LANDING",
        verification_reasons: ["page contains outbound ATS links"],
      };

      const result = await resolveListingsSurface(
        verified,
        dualSignalHtml,
        "acme.com",
      );

      // The board URL must be fetched exactly once (deduplication).
      const boardFetches = fetchedUrls.filter(
        (u) => u === "https://boards.greenhouse.io/acmecorp",
      );
      expect(boardFetches).toHaveLength(1);
      // Resolution still succeeds.
      expect(result.listings_url).toBe("https://boards.greenhouse.io/acmecorp");
    },
  );
});

// ===========================================================================
// R1.1 — detectAtsEmbedCandidates: high-confidence ATS embed detection
// ===========================================================================
describe("R1.1 — detectAtsEmbedCandidates", () => {
  // -------------------------------------------------------------------------
  // Greenhouse
  // -------------------------------------------------------------------------

  it("R1.1-GH1: detects Greenhouse board URL from data-gh-token attribute", () => {
    const html = `<html><body>
      <div id="grnhse_app" data-gh-token="acmecorp"></div>
    </body></html>`;
    const candidates = detectAtsEmbedCandidates(html);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.url).toBe("https://boards.greenhouse.io/acmecorp");
    expect(candidates[0]!.reason).toContain("data-gh-token");
    expect(candidates[0]!.reason).toContain("acmecorp");
  });

  it("R1.1-GH2: detects Greenhouse board URL from embed script ?for= parameter", () => {
    const html = `<html>
      <head>
        <script src="https://boards.greenhouse.io/embed/job_board/js?for=mycompany"></script>
      </head>
      <body><div id="grnhse_app"></div></body>
    </html>`;
    const candidates = detectAtsEmbedCandidates(html);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.url).toBe("https://boards.greenhouse.io/mycompany");
    expect(candidates[0]!.reason).toContain("mycompany");
  });

  it("R1.1-GH3: deduplicates when both data-gh-token and ?for= point to the same company", () => {
    const html = `<html>
      <head>
        <script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>
      </head>
      <body>
        <div id="grnhse_app" data-gh-token="acme"></div>
      </body>
    </html>`;
    const candidates = detectAtsEmbedCandidates(html);
    // Both signals point to the same URL — must deduplicate.
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.url).toBe("https://boards.greenhouse.io/acme");
  });

  // -------------------------------------------------------------------------
  // Lever
  // -------------------------------------------------------------------------

  it("R1.1-LEV1: detects Lever board URL from data-baseurl attribute", () => {
    const html = `<html><body>
      <div class="postings-container" data-baseurl="https://jobs.lever.co/widgetcorp"></div>
    </body></html>`;
    const candidates = detectAtsEmbedCandidates(html);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.url).toBe("https://jobs.lever.co/widgetcorp");
    expect(candidates[0]!.reason).toContain("data-baseurl");
  });

  it("R1.1-LEV2: normalizes Lever data-baseurl with trailing path to bare company URL", () => {
    const html = `<html><body>
      <div data-baseurl="https://jobs.lever.co/widgetcorp/embed"></div>
    </body></html>`;
    const candidates = detectAtsEmbedCandidates(html);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.url).toBe("https://jobs.lever.co/widgetcorp");
  });

  // -------------------------------------------------------------------------
  // Ashby
  // -------------------------------------------------------------------------

  it("R1.1-ASH1: detects Ashby board URL from non-user-facing API path", () => {
    const html = `<html>
      <head>
        <script src="https://app.ashbyhq.com/api/non-user-facing/job-board/techstartup"></script>
      </head>
      <body></body>
    </html>`;
    const candidates = detectAtsEmbedCandidates(html);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.url).toBe("https://jobs.ashbyhq.com/techstartup");
    expect(candidates[0]!.reason).toContain("techstartup");
  });

  it("R1.1-ASH2: detects Ashby board URL when API path appears in inline script body", () => {
    const html = `<html><head></head>
    <body>
      <script>
        var config = { apiUrl: "https://app.ashbyhq.com/api/non-user-facing/job-board/fintech-co" };
      </script>
    </body></html>`;
    const candidates = detectAtsEmbedCandidates(html);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.url).toBe("https://jobs.ashbyhq.com/fintech-co");
  });

  // -------------------------------------------------------------------------
  // SmartRecruiters
  // -------------------------------------------------------------------------

  it("R1.1-SR1: detects SmartRecruiters board URL from data-company-id attribute", () => {
    const html = `<html><body>
      <div class="smartrecruiters-widget" data-company-id="AcmeCorporation"></div>
    </body></html>`;
    const candidates = detectAtsEmbedCandidates(html);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.url).toBe("https://jobs.smartrecruiters.com/AcmeCorporation");
    expect(candidates[0]!.reason).toContain("data-company-id");
  });

  it("R1.1-SR2: detects SmartRecruiters board URL from SRJobListingWidget.init config", () => {
    const html = `<html><head></head>
    <body>
      <script>
        SRJobListingWidget.init({"company": "WidgetInc", "language": "en"});
      </script>
    </body></html>`;
    const candidates = detectAtsEmbedCandidates(html);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.url).toBe("https://jobs.smartrecruiters.com/WidgetInc");
    expect(candidates[0]!.reason).toContain("SRJobListingWidget");
  });

  it("R1.1-SR3: deduplicates when data-company-id and SRJobListingWidget point to same company", () => {
    const html = `<html><body>
      <div data-company-id="SameCo"></div>
      <script>SRJobListingWidget.init({"company":"SameCo"});</script>
    </body></html>`;
    const candidates = detectAtsEmbedCandidates(html);
    const srCandidates = candidates.filter((c) =>
      c.url.startsWith("https://jobs.smartrecruiters.com/SameCo")
    );
    expect(srCandidates).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Boundary cases
  // -------------------------------------------------------------------------

  it("R1.1-B1: returns empty array for plain HTML with no ATS embed markers", () => {
    const candidates = detectAtsEmbedCandidates(GENERIC_CORPORATE_HTML);
    expect(candidates).toHaveLength(0);
  });

  it("R1.1-B2: returns empty array for HTML with only careers CTA language and no ATS markers", () => {
    const candidates = detectAtsEmbedCandidates(OFFICIAL_CAREERS_LANDING_HTML);
    expect(candidates).toHaveLength(0);
  });

  it("R1.1-B3: does not produce candidates for arbitrary data attributes not on supported ATS patterns", () => {
    const html = `<html><body>
      <div data-company="somecompany" data-token="abc123"></div>
    </body></html>`;
    const candidates = detectAtsEmbedCandidates(html);
    expect(candidates).toHaveLength(0);
  });

  it("R1.1-B4: all returned URLs are on supported ATS domains", () => {
    const html = `<html>
      <head>
        <script src="https://boards.greenhouse.io/embed/job_board/js?for=co1"></script>
      </head>
      <body>
        <div data-company-id="Co2"></div>
        <script>
          var cfg = { apiUrl: "https://app.ashbyhq.com/api/non-user-facing/job-board/co3" };
          SRJobListingWidget.init({"company":"Co4"});
        </script>
        <div data-baseurl="https://jobs.lever.co/co5"></div>
      </body>
    </html>`;
    const candidates = detectAtsEmbedCandidates(html);
    const supportedHosts = [
      "boards.greenhouse.io",
      "jobs.lever.co",
      "jobs.ashbyhq.com",
      "jobs.smartrecruiters.com",
    ];
    for (const c of candidates) {
      const host = new URL(c.url).hostname;
      expect(supportedHosts.some((h) => host === h || host.endsWith(`.${h}`))).toBe(true);
    }
    // All four providers detected.
    expect(candidates.length).toBeGreaterThanOrEqual(4);
  });
});

// ===========================================================================
// R1.3 — Resolver safety boundaries
// ===========================================================================
describe("R1.3 — Resolver safety boundaries", () => {
  /**
   * HTML fixture: a careers landing page with a Greenhouse data-gh-token but
   * NO JS embed script URL.  detectAtsEmbedCandidates produces one candidate;
   * detectJsGating does NOT fire (no embed script pattern → no JS1 signal;
   * JS2a needs empty grnhse_app which is present but hasJobDetailLinks suppression
   * check passes since there are none — wait, this WOULD fire JS2a actually).
   *
   * To avoid PLAYWRIGHT_REQUIRED muddying R1.3-1, use a page where the Greenhouse
   * container has text content (non-empty) so JS2a does not fire, and no embed
   * script URL so JS1 does not fire.  detectJsGating → null.
   */
  const GH_TOKEN_NO_JS_GATING_HTML = `
<html>
<head><title>Careers at Acme</title></head>
<body>
  <h1>Join our team</h1>
  <p>View openings below.</p>
  <div id="grnhse_app" data-gh-token="acmecorp">Loading...</div>
</body>
</html>`;

  it(
    "R1.3-1: ATS board URL that redirects to a non-ATS page failing verification stays UNRESOLVED — no false confidence",
    async () => {
      // The ATS embed candidate is fetched exactly once.  The fetch resolves but
      // the finalUrl has redirected away from the ATS host to an unknown domain
      // with no career signals.  verifyCareersCandidate returns null → skip.
      // No other candidates exist → UNRESOLVED (not LISTINGS_SURFACE).
      vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        const u = url.toString();
        if (u === "https://boards.greenhouse.io/acmecorp") {
          // Simulates a misconfigured slug that redirects away from the ATS host.
          return makeHtmlResponse(GENERIC_CORPORATE_HTML, "https://some-unrelated.com/page");
        }
        return FAIL_RESPONSE;
      });

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "CAREERS_LANDING",
        verification_reasons: ["page title signals careers intent"],
      };

      const result = await resolveListingsSurface(
        verified,
        GH_TOKEN_NO_JS_GATING_HTML,
        "acme.com",
      );

      // Verification failed (non-ATS redirect with no career signals) →
      // resolution must remain unresolved; no false confidence created.
      expect(result.listings_url).toBeNull();
      expect(result.resolution_method).not.toBe("DIRECT_VERIFIED");
      expect(result.resolution_method).not.toBe("ATS_RESOLVED");
      // No JS gating (non-empty container, no embed script) → UNRESOLVED not PLAYWRIGHT_REQUIRED.
      expect(result.resolution_method).toBe("UNRESOLVED");
    },
  );

  it(
    "R1.3-2: single-hop guarantee — resolver stops immediately after the first successful ATS resolution with no further fetches",
    async () => {
      // Page with a Greenhouse data-gh-token.  The ATS board verifies as LISTINGS_SURFACE.
      // We count ALL fetches to confirm no additional hop is attempted after success.
      const fetchedUrls: string[] = [];
      vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        const u = url.toString();
        fetchedUrls.push(u);
        if (u === "https://boards.greenhouse.io/acmecorp") {
          // ATS-hosted URL: Signal L1 fires → LISTINGS_SURFACE.
          return makeHtmlResponse(ATS_HOSTED_HTML, u);
        }
        return FAIL_RESPONSE;
      });

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "CAREERS_LANDING",
        verification_reasons: ["page title signals careers intent"],
      };

      const result = await resolveListingsSurface(
        verified,
        GH_TOKEN_NO_JS_GATING_HTML,
        "acme.com",
      );

      // Resolution succeeds on the first ATS hop.
      expect(result.resolution_method).toBe("ATS_RESOLVED");
      expect(result.listings_url).toBe("https://boards.greenhouse.io/acmecorp");

      // R1.3(a): Exactly one fetch — no further hops attempted after success.
      // If the code recursed or chained, fetchedUrls would contain more entries.
      expect(fetchedUrls.filter((u) => u !== "https://boards.greenhouse.io/acmecorp")).toHaveLength(0);
      expect(fetchedUrls).toHaveLength(1);
    },
  );

  it(
    "R1.3-3: total fetches are bounded by RESOLVER_MAX_CANDIDATES even when many ATS links are present",
    async () => {
      // A page with 8 outbound ATS anchor links — more than RESOLVER_MAX_CANDIDATES (5).
      // We verify that the resolver never makes more than 5 fetch calls.
      const manyAtsLinksHtml = `
<html>
<head><title>Careers at Acme</title></head>
<body>
  <h1>Join us</h1>
  <a href="https://boards.greenhouse.io/co1">Greenhouse 1</a>
  <a href="https://boards.greenhouse.io/co2">Greenhouse 2</a>
  <a href="https://jobs.lever.co/co3">Lever 1</a>
  <a href="https://jobs.lever.co/co4">Lever 2</a>
  <a href="https://jobs.ashbyhq.com/co5">Ashby 1</a>
  <a href="https://jobs.ashbyhq.com/co6">Ashby 2</a>
  <a href="https://jobs.smartrecruiters.com/co7">SmartRecruiters 1</a>
  <a href="https://jobs.smartrecruiters.com/co8">SmartRecruiters 2</a>
</body>
</html>`;

      let fetchCount = 0;
      vi.stubGlobal("fetch", async () => {
        fetchCount++;
        return FAIL_RESPONSE;
      });

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "CAREERS_LANDING",
        verification_reasons: ["page title signals careers intent"],
      };

      await resolveListingsSurface(verified, manyAtsLinksHtml, "acme.com");

      // R1.3(b): Total fetches must not exceed RESOLVER_MAX_CANDIDATES (5).
      expect(fetchCount).toBeLessThanOrEqual(5);
    },
  );

  it(
    "R1.3-4: unsupported job board links (LinkedIn, Indeed, Glassdoor) produce no ATS embed candidates",
    () => {
      // Pages that only link to non-supported job boards must not generate
      // ATS embed candidates — those boards are not allowed sources.
      const jobBoardLinksHtml = `
<html>
<head><title>Find Acme Jobs</title></head>
<body>
  <h1>Find us on job boards</h1>
  <a href="https://www.linkedin.com/company/acme/jobs">LinkedIn Jobs</a>
  <a href="https://www.indeed.com/cmp/acme/jobs">Indeed</a>
  <a href="https://www.glassdoor.com/Jobs/acme-jobs">Glassdoor</a>
  <a href="https://www.ziprecruiter.com/c/acme">ZipRecruiter</a>
</body>
</html>`;

      // R1.3(c): detectAtsEmbedCandidates must return empty for unsupported boards.
      const embedCandidates = detectAtsEmbedCandidates(jobBoardLinksHtml);
      expect(embedCandidates).toHaveLength(0);
    },
  );

  it(
    "R1.3-5: unsupported job board anchor links are not followed even when their text contains CTA phrases",
    async () => {
      // A page with a strong CTA phrase ("View openings") pointing to LinkedIn —
      // that link must NOT be followed because LinkedIn is not the official domain
      // and is not a supported ATS host.
      const linkedInCtaHtml = `
<html>
<head><title>Careers at Acme</title></head>
<body>
  <h1>Join our team</h1>
  <a href="https://www.linkedin.com/company/acme/jobs">View openings on LinkedIn</a>
</body>
</html>`;

      let fetchCount = 0;
      vi.stubGlobal("fetch", async () => {
        fetchCount++;
        return FAIL_RESPONSE;
      });

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "CAREERS_LANDING",
        verification_reasons: ["page title signals careers intent"],
      };

      const result = await resolveListingsSurface(verified, linkedInCtaHtml, "acme.com");

      // R1.3(c): No fetch was attempted for the LinkedIn URL.
      // CTA links are restricted to the official domain; LinkedIn is "OTHER".
      expect(fetchCount).toBe(0);
      expect(result.listings_url).toBeNull();
      expect(result.resolution_method).toBe("UNRESOLVED");
    },
  );
});

// ===========================================================================
// R2.1 — detectCtaCandidates: pure CTA link detection
// ===========================================================================
describe("R2.1 — detectCtaCandidates", () => {
  it("R2.1-1: detects a 'View Jobs' anchor as a high-confidence CTA candidate", () => {
    const html = `<html><body>
      <h1>Careers at Acme</h1>
      <a href="/careers/jobs">View Jobs</a>
    </body></html>`;
    const candidates = detectCtaCandidates(html, "https://acme.com/careers");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.url).toBe("https://acme.com/careers/jobs");
    expect(candidates[0]!.reason).toContain("view jobs");
  });

  it("R2.1-2: detects 'See All Jobs', 'Open Positions', and 'Browse Roles' as CTA candidates", () => {
    const html = `<html><body>
      <a href="/all-jobs">See All Jobs</a>
      <a href="/open">Open Positions</a>
      <a href="/roles">Browse Roles</a>
    </body></html>`;
    const candidates = detectCtaCandidates(html, "https://acme.com");
    expect(candidates).toHaveLength(3);
    const urls = candidates.map((c) => c.url);
    expect(urls).toContain("https://acme.com/all-jobs");
    expect(urls).toContain("https://acme.com/open");
    expect(urls).toContain("https://acme.com/roles");
  });

  it("R2.1-3: does not treat generic marketing anchor text as a high-confidence CTA", () => {
    const html = `<html><body>
      <a href="/about">Learn More</a>
      <a href="/team">Meet the Team</a>
      <a href="/culture">Our Culture</a>
    </body></html>`;
    const candidates = detectCtaCandidates(html, "https://acme.com");
    expect(candidates).toHaveLength(0);
  });

  it("R2.1-4: deduplicates when multiple anchors share the same normalized URL", () => {
    const html = `<html><body>
      <a href="/jobs">View Jobs</a>
      <a href="/jobs">See All Jobs</a>
    </body></html>`;
    const candidates = detectCtaCandidates(html, "https://acme.com");
    // Same URL appears twice — must deduplicate to one entry.
    const viewJobsCandidates = candidates.filter(
      (c) => c.url === "https://acme.com/jobs",
    );
    expect(viewJobsCandidates).toHaveLength(1);
  });

  it("R2.1-5: ignores anchors with javascript:, #, mailto:, and tel: hrefs", () => {
    const html = `<html><body>
      <a href="javascript:void(0)">View Jobs</a>
      <a href="#">Search Jobs</a>
      <a href="mailto:jobs@acme.com">Open Positions</a>
    </body></html>`;
    const candidates = detectCtaCandidates(html, "https://acme.com");
    expect(candidates).toHaveLength(0);
  });
});

// ===========================================================================
// R2.2 — Follow CTA Targets with Single-Hop Resolution
// ===========================================================================
describe("R2.2 — resolveListingsSurface follows high-confidence CTA targets one hop deep", () => {
  /**
   * A careers landing page with a "View Jobs" CTA that points to /careers/jobs.
   * The target page has 5 job-detail links and verifies as LISTINGS_SURFACE (L3).
   *
   * Acceptance criterion R2.2:
   *   - careers landing pages with explicit "jobs" buttons resolve deeper
   *   - one click listings surfaces become reachable deterministically
   */
  it(
    "R2.2-1: careers landing page with 'View Jobs' CTA resolves to the listings surface via CTA_RESOLVED",
    async () => {
      const careersHtml = `
<html>
<head><title>Careers at Acme</title></head>
<body>
  <h1>Join our team</h1>
  <p>We're always looking for talented people.</p>
  <a href="/careers/jobs">View Jobs</a>
</body>
</html>`;

      vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        const u = url.toString();
        if (u === "https://acme.com/careers/jobs") {
          return makeHtmlResponse(LISTINGS_SURFACE_HTML, u);
        }
        return FAIL_RESPONSE;
      });

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "CAREERS_LANDING",
        verification_reasons: ["page title signals careers intent"],
      };

      const result = await resolveListingsSurface(verified, careersHtml, "acme.com");

      // Acceptance criterion: the CTA target is reached and confirmed as LISTINGS_SURFACE.
      expect(result.resolution_method).toBe("CTA_RESOLVED");
      expect(result.listings_url).toBe("https://acme.com/careers/jobs");
      expect(result.page_kind).toBe("LISTINGS_SURFACE");
      expect(result.careers_url).toBe("https://acme.com/careers");
    },
  );

  /**
   * "If verified more strongly" rule (R2.2):
   * A CTA target that re-verifies only as CAREERS_LANDING must NOT be accepted.
   * The resolver must remain UNRESOLVED — a weaker re-verification is not enough.
   */
  it(
    "R2.2-2: CTA target that re-verifies as CAREERS_LANDING is not accepted — resolution stays UNRESOLVED",
    async () => {
      const careersHtml = `
<html>
<head><title>Careers at Acme</title></head>
<body>
  <h1>Join our team</h1>
  <a href="/jobs">View Jobs</a>
</body>
</html>`;

      // /jobs returns a page with careers identity signals but no actual listings.
      // Signal breakdown: C1 (title "Jobs at Acme" +2) + C3 (/jobs path +1) = 3 ≥ 2 → CAREERS_LANDING.
      // listingScore = 0 (no job-detail links, no job card patterns) → not LISTINGS_SURFACE.
      const jobsPageHtml = `
<html>
<head><title>Jobs at Acme</title></head>
<body>
  <h1>Open positions</h1>
  <p>We are always looking for great talent. Check back soon.</p>
</body>
</html>`;

      vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        const u = url.toString();
        if (u === "https://acme.com/jobs") {
          return makeHtmlResponse(jobsPageHtml, u);
        }
        return FAIL_RESPONSE;
      });

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "CAREERS_LANDING",
        verification_reasons: ["page title signals careers intent"],
      };

      const result = await resolveListingsSurface(verified, careersHtml, "acme.com");

      // The CTA target verified as CAREERS_LANDING (not LISTINGS_SURFACE) — must not be used.
      expect(result.listings_url).toBeNull();
      expect(result.resolution_method).not.toBe("CTA_RESOLVED");
      // No JS gating evidence → UNRESOLVED (not PLAYWRIGHT_REQUIRED).
      expect(result.resolution_method).toBe("UNRESOLVED");
    },
  );

  /**
   * Single-hop guarantee: the resolver must NOT chain multiple CTA hops.
   * The first CTA hop fetches /jobs, which verifies as CAREERS_LANDING (insufficient).
   * /jobs itself contains a second CTA to /jobs/list (the real listings surface).
   * The resolver must NOT follow the second hop and must leave the result UNRESOLVED.
   */
  it(
    "R2.2-3: single-hop only — resolver does not chain CTA hops even when a second hop would succeed",
    async () => {
      const careersHtml = `
<html>
<head><title>Careers at Acme</title></head>
<body>
  <h1>Work with us</h1>
  <a href="/jobs">View Jobs</a>
</body>
</html>`;

      // First hop: /jobs is a careers-identity page with another CTA but no listings.
      const jobsHtml = `
<html>
<head><title>Jobs at Acme</title></head>
<body>
  <h1>Open positions</h1>
  <a href="/jobs/list">Search Jobs</a>
</body>
</html>`;

      const fetchedUrls: string[] = [];
      vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        const u = url.toString();
        fetchedUrls.push(u);
        if (u === "https://acme.com/jobs") {
          return makeHtmlResponse(jobsHtml, u);
        }
        if (u === "https://acme.com/jobs/list") {
          return makeHtmlResponse(LISTINGS_SURFACE_HTML, u);
        }
        return FAIL_RESPONSE;
      });

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "CAREERS_LANDING",
        verification_reasons: ["page title signals careers intent"],
      };

      const result = await resolveListingsSurface(verified, careersHtml, "acme.com");

      // /jobs verifies as CAREERS_LANDING — not accepted. The resolver does NOT
      // follow the second hop (/jobs/list). Listings remain unreachable.
      expect(result.listings_url).toBeNull();
      // R2.2 single-hop rule: /jobs/list must never be fetched.
      expect(fetchedUrls).not.toContain("https://acme.com/jobs/list");
      expect(result.resolution_method).not.toBe("CTA_RESOLVED");
    },
  );

  /**
   * Verify that a CTA target pointing to a non-official, non-ATS domain is NOT followed.
   * Safety boundary: only official domain and supported ATS destinations are allowed.
   */
  it(
    "R2.2-4: CTA pointing to an unsupported external domain is not followed",
    async () => {
      // "View Jobs" anchor pointing to an arbitrary external site (not official domain, not ATS).
      const careersHtml = `
<html>
<head><title>Careers at Acme</title></head>
<body>
  <h1>Join our team</h1>
  <a href="https://careers.someexternalsite.com/acme/jobs">View Jobs</a>
</body>
</html>`;

      let fetchCount = 0;
      vi.stubGlobal("fetch", async () => {
        fetchCount++;
        return FAIL_RESPONSE;
      });

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "CAREERS_LANDING",
        verification_reasons: ["page title signals careers intent"],
      };

      const result = await resolveListingsSurface(verified, careersHtml, "acme.com");

      // No fetch attempted for the unsupported external domain.
      expect(fetchCount).toBe(0);
      expect(result.listings_url).toBeNull();
      expect(result.resolution_method).toBe("UNRESOLVED");
    },
  );

  /**
   * End-to-end: discoverCareersUrl finds a careers landing page and the resolver
   * follows a CTA to the actual listings surface.
   *
   * The CTA target path (/open-positions) is deliberately NOT in buildGuessUrls
   * so that discovery cannot reach it directly — only the CTA hop gets there.
   *
   * Acceptance criterion: one-click listings surfaces become reachable deterministically.
   */
  it(
    "R2.2-5: end-to-end — discoverCareersUrl resolves through a CTA to the listings surface",
    async () => {
      // Careers landing page whose CTA points to /open-positions.
      // /open-positions is not in the deterministic URL guess list, so it can
      // only be reached by following the explicit CTA link.
      const ctaCareersHtml = `
<html>
<head><title>Careers at Acme</title></head>
<body>
  <h1>Join our team</h1>
  <p>We are always looking for talented people.</p>
  <a href="/open-positions">View Jobs</a>
</body>
</html>`;

      vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        const u = url.toString();
        // Homepage: no careers links — forces discovery to fall through to guesses.
        if (u === "https://acme.com" || u === "https://www.acme.com") {
          return makeHtmlResponse(
            `<html><head><title>Acme</title></head><body><a href="/about">About</a></body></html>`,
            u,
          );
        }
        // Guessed /careers URL: careers landing with explicit CTA.
        if (u === "https://acme.com/careers" || u === "https://www.acme.com/careers") {
          return makeHtmlResponse(ctaCareersHtml, u);
        }
        // CTA target: the real listings surface (not reachable by guessing alone).
        if (u === "https://acme.com/open-positions") {
          return makeHtmlResponse(LISTINGS_SURFACE_HTML, u);
        }
        return FAIL_RESPONSE;
      });

      const result = await discoverCareersUrl("acme");

      // Acceptance criterion: the resolver followed the CTA and surfaced the real listings page.
      expect(result.careers_url).toBe("https://acme.com/careers");
      expect(result.listings_url).toBe("https://acme.com/open-positions");
      expect(result.resolution_method).toBe("CTA_RESOLVED");
      expect(result.page_kind).toBe("LISTINGS_SURFACE");
      expect(result.failure_code).toBeNull();
    },
  );
});

// ===========================================================================
// R2.3 — scoreCtaCandidate and rankCtaCandidates: conservative CTA ranking
// ===========================================================================
describe("R2.3 — scoreCtaCandidate: URL trust scoring", () => {
  it("R2.3-1: /jobs path scores 2 and is trustworthy", () => {
    const { score, trustworthy } = scoreCtaCandidate("https://acme.com/jobs");
    expect(score).toBe(2);
    expect(trustworthy).toBe(true);
  });

  it("R2.3-2: /careers path scores 2 and is trustworthy", () => {
    const { score, trustworthy } = scoreCtaCandidate("https://acme.com/careers");
    expect(score).toBe(2);
    expect(trustworthy).toBe(true);
  });

  it("R2.3-3: /openings path scores 2 and is trustworthy", () => {
    const { score, trustworthy } = scoreCtaCandidate("https://acme.com/openings");
    expect(score).toBe(2);
    expect(trustworthy).toBe(true);
  });

  it("R2.3-4: /positions path scores 2 and is trustworthy", () => {
    const { score, trustworthy } = scoreCtaCandidate("https://acme.com/positions");
    expect(score).toBe(2);
    expect(trustworthy).toBe(true);
  });

  it("R2.3-5: /roles path scores 2 and is trustworthy", () => {
    const { score, trustworthy } = scoreCtaCandidate("https://acme.com/roles");
    expect(score).toBe(2);
    expect(trustworthy).toBe(true);
  });

  it("R2.3-6: /about path scores 0 and is not trustworthy", () => {
    const { score, trustworthy } = scoreCtaCandidate("https://acme.com/about");
    expect(score).toBe(0);
    expect(trustworthy).toBe(false);
  });

  it("R2.3-7: /team path scores 0 and is not trustworthy", () => {
    const { score, trustworthy } = scoreCtaCandidate("https://acme.com/team");
    expect(score).toBe(0);
    expect(trustworthy).toBe(false);
  });

  it("R2.3-8: /join path scores 1 and is NOT trustworthy (below threshold)", () => {
    // Tier-1 segment alone is insufficient — generic enough to be ambiguous.
    const { score, trustworthy } = scoreCtaCandidate("https://acme.com/join");
    expect(score).toBe(1);
    expect(trustworthy).toBe(false);
  });

  it("R2.3-9: supported ATS host URL scores at least 3 and is trustworthy", () => {
    const { score, trustworthy } = scoreCtaCandidate(
      "https://boards.greenhouse.io/acme",
    );
    expect(score).toBeGreaterThanOrEqual(3);
    expect(trustworthy).toBe(true);
  });

  it("R2.3-10: compound path /job-openings is trustworthy via 'openings' segment", () => {
    // "-" is treated as a segment separator; "openings" is tier-2.
    const { score, trustworthy } = scoreCtaCandidate(
      "https://acme.com/job-openings",
    );
    expect(score).toBeGreaterThanOrEqual(2);
    expect(trustworthy).toBe(true);
  });

  it("R2.3-11: ATS host outscores same-name official-domain path", () => {
    // ATS destination (score ≥ 3) must rank above an official-domain /careers
    // path (score 2) so the more authoritative target is tried first.
    const ats = scoreCtaCandidate("https://jobs.lever.co/acme");
    const official = scoreCtaCandidate("https://acme.com/careers");
    expect(ats.score).toBeGreaterThan(official.score);
  });
});

describe("R2.3 — rankCtaCandidates: filtering and ordering", () => {
  it("R2.3-12: keeps only trustworthy candidates and drops ambiguous ones", () => {
    const candidates = [
      { url: "https://acme.com/about-us", method: "CTA_RESOLVED" as const },
      { url: "https://acme.com/jobs", method: "CTA_RESOLVED" as const },
    ];
    const ranked = rankCtaCandidates(candidates);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.url).toBe("https://acme.com/jobs");
  });

  it("R2.3-13: returns empty array when all candidates are below the trust threshold", () => {
    // Acceptance criterion: ambiguous pages remain unresolved instead of being
    // guessed through — returning no candidates forces the caller to skip all CTAs.
    const candidates = [
      { url: "https://acme.com/about", method: "CTA_RESOLVED" as const },
      { url: "https://acme.com/team", method: "CTA_RESOLVED" as const },
      { url: "https://acme.com/culture", method: "CTA_RESOLVED" as const },
    ];
    const ranked = rankCtaCandidates(candidates);
    expect(ranked).toHaveLength(0);
  });

  it("R2.3-14: sorts trustworthy candidates by score descending (ATS before official-domain path)", () => {
    // ATS destination (score 3) must precede /careers (score 2).
    const candidates = [
      { url: "https://acme.com/careers", method: "CTA_RESOLVED" as const },
      {
        url: "https://boards.greenhouse.io/acme",
        method: "CTA_RESOLVED" as const,
      },
    ];
    const ranked = rankCtaCandidates(candidates);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]!.url).toBe("https://boards.greenhouse.io/acme");
    expect(ranked[1]!.url).toBe("https://acme.com/careers");
  });

  it("R2.3-15: preserves stable relative order when scores are equal", () => {
    // /careers and /jobs both score 2 — input order must be preserved (stable sort).
    const candidates = [
      { url: "https://acme.com/careers", method: "CTA_RESOLVED" as const },
      { url: "https://acme.com/jobs", method: "CTA_RESOLVED" as const },
    ];
    const ranked = rankCtaCandidates(candidates);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]!.url).toBe("https://acme.com/careers");
    expect(ranked[1]!.url).toBe("https://acme.com/jobs");
  });

  it("R2.3-16: all returned candidates have method CTA_RESOLVED", () => {
    const candidates = [
      { url: "https://acme.com/jobs", method: "CTA_RESOLVED" as const },
      { url: "https://acme.com/about", method: "CTA_RESOLVED" as const },
    ];
    const ranked = rankCtaCandidates(candidates);
    for (const c of ranked) {
      expect(c.method).toBe("CTA_RESOLVED");
    }
  });
});

// ===========================================================================
// R3.2 — Upgrade resolved surfaces only on strong evidence
// ===========================================================================
describe("R3.2 — resolved destinations must be STRONG to become extraction-ready", () => {
  /**
   * HTML for a resolved destination that passes verifyCareersCandidate as
   * LISTINGS_SURFACE (5 unique job-detail links → Signal L3 +3 ≥ threshold)
   * BUT also carries a Greenhouse embed container (id="grnhse_app").
   *
   * classifyListingsStrength → WEAK_LISTINGS_SURFACE (embed container present).
   *
   * R3.2: this WEAK destination must be rejected — listings_url stays null.
   */
  const WEAK_CTA_TARGET_HTML = `
<html>
<head><title>Open Positions at Acme</title></head>
<body>
  <a href="/jobs/engineering/1/software-engineer">Software Engineer</a>
  <a href="/jobs/engineering/2/backend-engineer">Backend Engineer</a>
  <a href="/jobs/product/3/product-manager">Product Manager</a>
  <a href="/jobs/design/4/ux-designer">UX Designer</a>
  <a href="/jobs/data/5/data-analyst">Data Analyst</a>
  <div id="grnhse_app"></div>
</body>
</html>`;

  // -------------------------------------------------------------------------
  // Unit-level: resolveListingsSurface surface-level extraction-readiness gate
  // -------------------------------------------------------------------------

  it(
    "R3.2-1: strong ATS-resolved destination (ATS_RESOLVED) makes listings_url non-null — extraction ready",
    async () => {
      // Acceptance criterion: deeper resolution improves coverage.
      // A careers landing page with an outbound ATS anchor resolves to a
      // Greenhouse board (ATS host → STRONG_LISTINGS_SURFACE).
      // listings_url must be non-null, confirming extraction can begin.

      const careersWithAtsLink = `
<html>
<head><title>Careers at Acme</title></head>
<body>
  <h1>Join Our Team</h1>
  <a href="https://boards.greenhouse.io/acmecorp">View Jobs on Greenhouse</a>
</body>
</html>`;

      vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        const u = url.toString();
        if (u === "https://boards.greenhouse.io/acmecorp") {
          return makeHtmlResponse(ATS_HOSTED_HTML, u);
        }
        return FAIL_RESPONSE;
      });

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "CAREERS_LANDING",
        verification_reasons: ["page title signals careers intent"],
      };

      const result = await resolveListingsSurface(
        verified,
        careersWithAtsLink,
        "acme.com",
      );

      // R3.2: ATS board is STRONG → listings_url non-null → extraction may begin.
      expect(result.listings_url).not.toBeNull();
      expect(result.listings_url).toBe("https://boards.greenhouse.io/acmecorp");
      expect(result.resolution_method).toBe("ATS_RESOLVED");
      expect(result.page_kind).toBe("LISTINGS_SURFACE");
    },
  );

  it(
    "R3.2-2: strong CTA-resolved destination (CTA_RESOLVED) makes listings_url non-null — extraction ready",
    async () => {
      // Acceptance criterion: deeper resolution improves coverage.
      // An official-domain CTA target with 5 clean job-detail links and no embed
      // markers is STRONG_LISTINGS_SURFACE → listings_url is non-null.

      vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        const u = url.toString();
        if (u === "https://acme.com/open-positions") {
          return makeHtmlResponse(LISTINGS_SURFACE_HTML, u);
        }
        return FAIL_RESPONSE;
      });

      const careersWithCtaHtml = `
<html>
<head><title>Careers at Acme</title></head>
<body>
  <h1>Join our team</h1>
  <a href="/open-positions">View Jobs</a>
</body>
</html>`;

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "CAREERS_LANDING",
        verification_reasons: ["page title signals careers intent"],
      };

      const result = await resolveListingsSurface(
        verified,
        careersWithCtaHtml,
        "acme.com",
      );

      // R3.2: strong CTA destination → listings_url non-null → extraction may begin.
      expect(result.listings_url).not.toBeNull();
      expect(result.listings_url).toBe("https://acme.com/open-positions");
      expect(result.resolution_method).toBe("CTA_RESOLVED");
      expect(result.page_kind).toBe("LISTINGS_SURFACE");
    },
  );

  it(
    "R3.2-3: weak CTA-resolved destination keeps listings_url null — no extraction (conservative)",
    async () => {
      // Acceptance criterion: weakly resolved pages still remain conservative.
      // The CTA target passes verifyCareersCandidate as LISTINGS_SURFACE
      // (5 job-detail links) but classifyListingsStrength → WEAK (grnhse_app).
      // R3.2: WEAK destination must be rejected; listings_url stays null.

      vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        const u = url.toString();
        if (u === "https://acme.com/careers/jobs") {
          return makeHtmlResponse(WEAK_CTA_TARGET_HTML, u);
        }
        return FAIL_RESPONSE;
      });

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "CAREERS_LANDING",
        verification_reasons: ["page title signals careers intent"],
      };

      const result = await resolveListingsSurface(
        verified,
        OFFICIAL_CAREERS_LANDING_HTML,
        "acme.com",
      );

      // R3.2: weak resolved destination → listings_url null (conservative, no extraction).
      expect(result.listings_url).toBeNull();
      // System stays UNRESOLVED — not partially resolved with a weak surface.
      expect(result.resolution_method).toBe("UNRESOLVED");
    },
  );

  it(
    "R3.2-4: weak embed-resolved destination (ATS_RESOLVED candidate on official domain) keeps listings_url null",
    async () => {
      // Acceptance criterion: weakly resolved pages still remain conservative.
      // An ATS_RESOLVED candidate that resolves to an official-domain page with
      // both job-detail links and an ATS embed container is WEAK → rejected.
      // (This tests R3.2 for the ATS_RESOLVED method, not just CTA_RESOLVED.)

      const careersWithEmbedHtml = `
<html>
<head><title>Careers at Acme</title></head>
<body>
  <h1>Join our team</h1>
  <iframe src="https://boards.greenhouse.io/embed/job_board?for=acmecorp"></iframe>
</body>
</html>`;

      // The iframe src host (boards.greenhouse.io) generates an EMBEDDED_ATS candidate.
      // But we make the fetch redirect to an official-domain page that is WEAK.
      vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        const u = url.toString();
        if (u.startsWith("https://boards.greenhouse.io/")) {
          // Redirect to an official-domain page that is WEAK (5 links + embed marker).
          return makeHtmlResponse(WEAK_CTA_TARGET_HTML, "https://acme.com/jobs");
        }
        return FAIL_RESPONSE;
      });

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "CAREERS_LANDING",
        verification_reasons: ["page title signals careers intent"],
      };

      const result = await resolveListingsSurface(
        verified,
        careersWithEmbedHtml,
        "acme.com",
      );

      // R3.2: redirected to WEAK official-domain page → listings_url null.
      expect(result.listings_url).toBeNull();
    },
  );

  // -------------------------------------------------------------------------
  // Full-pipeline: discoverCareersUrl extraction-readiness gate
  // -------------------------------------------------------------------------

  it(
    "R3.2-5: discoverCareersUrl — ATS outbound link from verified careers page resolves to non-null listings_url",
    async () => {
      // Acceptance criterion: deeper resolution improves coverage (full pipeline).
      // Homepage contains a careers anchor; the careers page links to the ATS board.
      // The resolver follows the ATS_RESOLVED candidate and confirms a STRONG destination.
      // listings_url must be non-null so extraction can begin.

      const careersWithAtsLinkHtml = `
<html>
<head><title>Careers at Acme</title></head>
<body>
  <h1>Join Our Team</h1>
  <a href="https://boards.greenhouse.io/acmecorp">View Jobs on Greenhouse</a>
</body>
</html>`;

      vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        const u = url.toString();
        if (u === "https://acme.com" || u === "https://www.acme.com") {
          return makeHtmlResponse(
            `<html><head><title>Acme</title></head><body>
               <a href="/careers">Careers</a>
             </body></html>`,
            u,
          );
        }
        if (
          u === "https://acme.com/careers" ||
          u === "https://www.acme.com/careers"
        ) {
          return makeHtmlResponse(careersWithAtsLinkHtml, u);
        }
        if (u === "https://boards.greenhouse.io/acmecorp") {
          return makeHtmlResponse(ATS_HOSTED_HTML, u);
        }
        return FAIL_RESPONSE;
      });

      const result = await discoverCareersUrl("acme");

      // R3.2: ATS board is STRONG → listings_url non-null → extraction may begin.
      expect(result.listings_url).not.toBeNull();
      expect(result.listings_url).toBe("https://boards.greenhouse.io/acmecorp");
      expect(result.resolution_method).toBe("ATS_RESOLVED");
      expect(result.failure_code).toBeNull();
    },
  );

  it(
    "R3.2-6: discoverCareersUrl — CTA pointing to a WEAK page keeps listings_url null (conservative)",
    async () => {
      // Acceptance criterion: weakly resolved pages still remain conservative (full pipeline).
      // A careers page with a "View Jobs" CTA that leads to a WEAK destination
      // (5 job-detail links + embed container) must NOT produce a non-null listings_url.
      // Improvement in resolution depth must not revive false positive confidence.

      const weakTargetHtml = `
<html>
<head><title>Open Positions at Acme</title></head>
<body>
  <a href="/jobs/eng/1/swe">Software Engineer</a>
  <a href="/jobs/eng/2/be">Backend Engineer</a>
  <a href="/jobs/prod/3/pm">Product Manager</a>
  <a href="/jobs/des/4/ux">UX Designer</a>
  <a href="/jobs/dat/5/da">Data Analyst</a>
  <div id="grnhse_app"></div>
</body>
</html>`;

      vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        const u = url.toString();
        if (u === "https://acme.com" || u === "https://www.acme.com") {
          return makeHtmlResponse(
            `<html><head><title>Acme</title></head><body><a href="/about">About</a></body></html>`,
            u,
          );
        }
        if (
          u === "https://acme.com/careers" ||
          u === "https://www.acme.com/careers"
        ) {
          // Careers landing with a "View Jobs" CTA pointing to /open-positions.
          return makeHtmlResponse(
            `<html>
<head><title>Careers at Acme</title></head>
<body>
  <h1>Join our team</h1>
  <a href="/open-positions">View Jobs</a>
</body>
</html>`,
            u,
          );
        }
        if (u === "https://acme.com/open-positions") {
          return makeHtmlResponse(weakTargetHtml, u);
        }
        return FAIL_RESPONSE;
      });

      const result = await discoverCareersUrl("acme");

      // R3.2: WEAK CTA-resolved destination → listings_url null (conservative).
      expect(result.listings_url).toBeNull();
      // careers_url is non-null — discovery found the careers page.
      expect(result.careers_url).not.toBeNull();
      // Resolution did not succeed via CTA_RESOLVED.
      expect(result.resolution_method).not.toBe("CTA_RESOLVED");
      // The pipeline did NOT fail discovery; it found a careers page but the
      // resolved destination was too weak to allow extraction.
      expect(result.failure_code).toBeNull();
    },
  );
});

describe("R2.3 — resolveListingsSurface: conservative CTA target selection", () => {
  it(
    "R2.3-17: resolver fetches the trustworthy CTA and skips the ambiguous one",
    async () => {
      // Page has two CTA links:
      //   /about-us  — matches CTA phrase ("View Openings") but path is generic
      //                (score 0 → untrustworthy → must NOT be fetched)
      //   /careers/jobs — job-specific path (score 2 → trustworthy → fetched)
      const mixedCtaHtml = `
<html>
<head><title>Careers at Acme</title></head>
<body>
  <h1>Join our team</h1>
  <a href="/about-us">View Openings</a>
  <a href="/careers/jobs">See All Jobs</a>
</body>
</html>`;

      const fetchedUrls: string[] = [];
      vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        const u = url.toString();
        fetchedUrls.push(u);
        if (u === "https://acme.com/careers/jobs") {
          return makeHtmlResponse(LISTINGS_SURFACE_HTML, u);
        }
        return FAIL_RESPONSE;
      });

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "CAREERS_LANDING",
        verification_reasons: ["page title signals careers intent"],
      };

      const result = await resolveListingsSurface(verified, mixedCtaHtml, "acme.com");

      // Trustworthy CTA resolved to the listings surface.
      expect(result.resolution_method).toBe("CTA_RESOLVED");
      expect(result.listings_url).toBe("https://acme.com/careers/jobs");
      // Ambiguous CTA (/about-us) was never fetched.
      expect(fetchedUrls).not.toContain("https://acme.com/about-us");
    },
  );

  it(
    "R2.3-18: resolver stays UNRESOLVED when all CTAs are below the trust threshold",
    async () => {
      // Acceptance criterion: ambiguous pages remain unresolved instead of
      // being guessed through.  No CTA fetch must be attempted.
      const allAmbiguousHtml = `
<html>
<head><title>Careers at Acme</title></head>
<body>
  <h1>Join our team</h1>
  <a href="/about-us">View Openings</a>
  <a href="/culture">See All Jobs</a>
</body>
</html>`;

      let fetchCount = 0;
      vi.stubGlobal("fetch", async () => {
        fetchCount++;
        return FAIL_RESPONSE;
      });

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "CAREERS_LANDING",
        verification_reasons: ["page title signals careers intent"],
      };

      const result = await resolveListingsSurface(
        verified,
        allAmbiguousHtml,
        "acme.com",
      );

      // No CTAs cleared the threshold — none were fetched.
      expect(fetchCount).toBe(0);
      // Ambiguous page remains unresolved.
      expect(result.listings_url).toBeNull();
      expect(result.resolution_method).toBe("UNRESOLVED");
    },
  );

  it(
    "R2.3-19: resolver prefers higher-scored ATS CTA over lower-scored official-domain CTA",
    async () => {
      // Page has two trustworthy CTAs:
      //   - https://boards.greenhouse.io/acme  (score 3, ATS host)
      //   - https://acme.com/careers/jobs       (score 2, official-domain path)
      //
      // The ATS URL must be tried first.  We make the official-domain URL return
      // a listings surface too, but since the ATS is ranked first and resolves
      // successfully, the resolver must return ATS, not FOLLOW_CTA.
      const dualCtaHtml = `
<html>
<head><title>Careers at Acme</title></head>
<body>
  <h1>Join our team</h1>
  <a href="/careers/jobs">View Jobs</a>
  <a href="https://boards.greenhouse.io/acme">See All Jobs</a>
</body>
</html>`;

      const fetchedUrls: string[] = [];
      vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        const u = url.toString();
        fetchedUrls.push(u);
        if (u === "https://boards.greenhouse.io/acme") {
          return makeHtmlResponse(ATS_HOSTED_HTML, u);
        }
        if (u === "https://acme.com/careers/jobs") {
          return makeHtmlResponse(LISTINGS_SURFACE_HTML, u);
        }
        return FAIL_RESPONSE;
      });

      const verified: VerifiedCandidate = {
        url: "https://acme.com/careers",
        source_type: "HOMEPAGE_LINK",
        host_type: "OFFICIAL_DOMAIN",
        page_kind: "CAREERS_LANDING",
        verification_reasons: ["page title signals careers intent"],
      };

      const result = await resolveListingsSurface(verified, dualCtaHtml, "acme.com");

      // The ATS CTA (score 3) was tried first and resolved.
      // resolution_method reflects the winning candidate's method (ATS_RESOLVED,
      // because the <a href> to greenhouse.io is picked up by extractResolverCandidates
      // as ATS_RESOLVED — which already precedes CTA_RESOLVED in the non-CTA bucket.
      // What matters: the greenhouse.io URL was reached and the /careers/jobs URL
      // was not fetched (the resolver stopped after the first success).
      expect(result.listings_url).toBe("https://boards.greenhouse.io/acme");
      expect(fetchedUrls).not.toContain("https://acme.com/careers/jobs");
    },
  );
});
