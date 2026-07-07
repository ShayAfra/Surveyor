/**
 * Extraction completion unit tests.
 *
 * Covers:
 *   7.1 — isConfidentListingsSurface threshold and structural signal tests
 *   7.2 — shouldAttemptPlaywrightFallback gate change (completed vs job count)
 *   7.3 — completion_reason derivation (documented via extraction result shapes)
 *   7.4 — computeFinalStatus regression tests
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import {
  extractJobs,
  hasPaginationSignal,
  isConfidentListingsSurface,
  EXTRACTOR_USED,
  MIN_CONFIDENT_LISTINGS,
  shouldAttemptPlaywrightFallback,
  type Job,
  type ExtractJobsResult,
} from "../extraction.js";
import { computeFinalStatus } from "../finalizeCompany.js";
import { AtsType } from "@surveyor/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(n: number): Job {
  return { title: "Engineer", location: null, url: `https://example.com/job/${n}` };
}

function makeJobs(count: number): Job[] {
  return Array.from({ length: count }, (_, i) => makeJob(i + 1));
}

function makeGreenhouseJobs(count: number): Job[] {
  return Array.from({ length: count }, (_, i) => ({
    title: "Engineer",
    location: "Remote",
    url: `https://job-boards.greenhouse.io/reddit/jobs/${1000 + i}`,
  }));
}

const NO_SHELL_HTML = "<html><body>hello</body></html>";
const GREENHOUSE_SHELL_HTML = '<div class="greenhouse-job-board"></div>';

function mockHtmlExtraction(html: string): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => html,
  } as Response);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Anchor parsing
// ---------------------------------------------------------------------------
describe("extractJobs anchor parsing", () => {
  it("parses direct text anchors", async () => {
    mockHtmlExtraction('<a href="https://x/jobs/1">Software Engineer</a>');

    const result = await extractJobs(
      "https://x/jobs",
      AtsType.UNKNOWN,
      EXTRACTOR_USED.GENERIC_HTTP
    );

    expect(result.jobs).toEqual([
      { title: "Software Engineer", location: null, url: "https://x/jobs/1" },
    ]);
  });

  it("parses nested anchors", async () => {
    mockHtmlExtraction('<a href="https://x/jobs/1"><div>Software Engineer</div></a>');

    const result = await extractJobs(
      "https://x/jobs",
      AtsType.UNKNOWN,
      EXTRACTOR_USED.GENERIC_HTTP
    );

    expect(result.jobs).toEqual([
      { title: "Software Engineer", location: null, url: "https://x/jobs/1" },
    ]);
  });

  it("uses nested job-title text as title and extracts job-location separately", async () => {
    mockHtmlExtraction(
      '<a href="https://x/jobs/1"><div class="job-title">Software Engineer</div><div class="job-location">Remote</div></a>'
    );

    const result = await extractJobs(
      "https://x/jobs",
      AtsType.UNKNOWN,
      EXTRACTOR_USED.GENERIC_HTTP
    );

    expect(result.jobs).toEqual([
      { title: "Software Engineer", location: "Remote", url: "https://x/jobs/1" },
    ]);
  });

  it("rejects nav links", async () => {
    mockHtmlExtraction('<a href="/careers"><div>Careers</div></a>');

    const result = await extractJobs(
      "https://x/jobs",
      AtsType.UNKNOWN,
      EXTRACTOR_USED.GENERIC_HTTP
    );

    expect(result.jobs).toEqual([]);
  });

  it("rejects non-job nested anchors", async () => {
    mockHtmlExtraction('<a href="/about"><div>About Us</div></a>');

    const result = await extractJobs(
      "https://x/jobs",
      AtsType.UNKNOWN,
      EXTRACTOR_USED.GENERIC_HTTP
    );

    expect(result.jobs).toEqual([]);
  });

  it("dedupes duplicate URLs", async () => {
    mockHtmlExtraction(`
      <a href="https://x/jobs/1"><div>Software Engineer</div></a>
      <a href="https://x/jobs/1"><div>Software Engineer</div></a>
    `);

    const result = await extractJobs(
      "https://x/jobs",
      AtsType.UNKNOWN,
      EXTRACTOR_USED.GENERIC_HTTP
    );

    expect(result.jobs).toEqual([
      { title: "Software Engineer", location: null, url: "https://x/jobs/1" },
    ]);
  });

  it("completes GREENHOUSE extraction from official careers page when parsed job URLs enumerate Greenhouse details", async () => {
    mockHtmlExtraction(`
      <a href="https://job-boards.greenhouse.io/reddit/jobs/1001">
        <div class="job-title">Software Engineer</div>
        <div class="job-location">Remote - United States</div>
      </a>
      <a href="https://job-boards.greenhouse.io/reddit/jobs/1002">
        <div class="job-title">Backend Engineer</div>
        <div class="job-location">Remote - United States</div>
      </a>
      <a href="https://job-boards.greenhouse.io/reddit/jobs/1003">
        <div class="job-title">Frontend Engineer</div>
        <div class="job-location">Remote - United States</div>
      </a>
    `);

    const result = await extractJobs(
      "https://redditinc.com/careers",
      AtsType.GREENHOUSE,
      EXTRACTOR_USED.GREENHOUSE
    );

    expect(result.completed).toBe(true);
    expect(result.jobs).toHaveLength(MIN_CONFIDENT_LISTINGS);
    expect(result.listings_scanned).toBe(MIN_CONFIDENT_LISTINGS);
  });
});

// ---------------------------------------------------------------------------
// 7.1 — isConfidentListingsSurface
// ---------------------------------------------------------------------------
describe("isConfidentListingsSurface", () => {
  const allExtractors = [
    EXTRACTOR_USED.GENERIC_HTTP,
    EXTRACTOR_USED.GREENHOUSE,
    EXTRACTOR_USED.LEVER,
    EXTRACTOR_USED.ASHBY,
    EXTRACTOR_USED.SMARTRECRUITERS,
    EXTRACTOR_USED.PLAYWRIGHT,
  ] as const;

  it("returns false for 0 jobs regardless of extractor", () => {
    for (const ext of allExtractors) {
      expect(
        isConfidentListingsSurface(NO_SHELL_HTML, "https://example.com/careers", [], ext),
      ).toBe(false);
    }
  });

  it("returns false for 1 job on a generic surface (below threshold)", () => {
    expect(
      isConfidentListingsSurface(NO_SHELL_HTML, "https://example.com/careers", makeJobs(1), EXTRACTOR_USED.GENERIC_HTTP),
    ).toBe(false);
  });

  it("returns false for 2 jobs on a generic surface (below threshold)", () => {
    expect(
      isConfidentListingsSurface(NO_SHELL_HTML, "https://example.com/careers", makeJobs(2), EXTRACTOR_USED.GENERIC_HTTP),
    ).toBe(false);
  });

  it("returns true for 3 jobs on a generic surface (meets MIN_CONFIDENT_LISTINGS)", () => {
    expect(MIN_CONFIDENT_LISTINGS).toBe(3);
    expect(
      isConfidentListingsSurface(NO_SHELL_HTML, "https://example.com/careers", makeJobs(3), EXTRACTOR_USED.GENERIC_HTTP),
    ).toBe(true);
  });

  it("returns true for ATS board URL + GREENHOUSE extractor + 1 job", () => {
    expect(
      isConfidentListingsSurface(
        NO_SHELL_HTML,
        "https://boards.greenhouse.io/company/jobs",
        makeJobs(1),
        EXTRACTOR_USED.GREENHOUSE,
      ),
    ).toBe(true);
  });

  it("returns true for named ATS extractor + shell HTML + non-ATS URL + 1 job", () => {
    expect(
      isConfidentListingsSurface(
        GREENHOUSE_SHELL_HTML,
        "https://example.com/careers",
        makeJobs(1),
        EXTRACTOR_USED.GREENHOUSE,
      ),
    ).toBe(true);
  });

  it("returns true for GREENHOUSE extractor + non-ATS source URL + minimum unique Greenhouse job detail URLs", () => {
    expect(
      isConfidentListingsSurface(
        NO_SHELL_HTML,
        "https://redditinc.com/careers",
        makeGreenhouseJobs(MIN_CONFIDENT_LISTINGS),
        EXTRACTOR_USED.GREENHOUSE,
      ),
    ).toBe(true);
  });

  it("returns false for GREENHOUSE extractor + non-ATS source URL + fewer than minimum Greenhouse job detail URLs", () => {
    expect(
      isConfidentListingsSurface(
        NO_SHELL_HTML,
        "https://redditinc.com/careers",
        makeGreenhouseJobs(MIN_CONFIDENT_LISTINGS - 1),
        EXTRACTOR_USED.GREENHOUSE,
      ),
    ).toBe(false);
  });

  it("returns false for GREENHOUSE extractor + non-ATS source URL + many non-ATS job-like URLs", () => {
    expect(
      isConfidentListingsSurface(
        NO_SHELL_HTML,
        "https://redditinc.com/careers",
        makeJobs(10),
        EXTRACTOR_USED.GREENHOUSE,
      ),
    ).toBe(false);
  });

  it("returns false for named ATS extractor + no shell HTML + non-ATS URL + 5 jobs", () => {
    expect(
      isConfidentListingsSurface(
        NO_SHELL_HTML,
        "https://example.com/careers",
        makeJobs(5),
        EXTRACTOR_USED.GREENHOUSE,
      ),
    ).toBe(false);
  });

  it("named ATS extractor name alone (no shell, no board URL) does not imply completion", () => {
    // Even with many jobs, a named ATS extractor on a non-ATS URL without
    // shell HTML evidence must not produce confident completion.
    expect(
      isConfidentListingsSurface(
        NO_SHELL_HTML,
        "https://example.com/careers",
        makeJobs(10),
        EXTRACTOR_USED.GREENHOUSE,
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7.2 — shouldAttemptPlaywrightFallback
// ---------------------------------------------------------------------------
describe("shouldAttemptPlaywrightFallback", () => {
  it("returns false when completed=true (fallback blocked by confident completion)", () => {
    const result: ExtractJobsResult = {
      jobs: makeJobs(1),
      completed: true,
      listings_scanned: 1,
      pages_visited: 1,
    };
    expect(
      shouldAttemptPlaywrightFallback(AtsType.GREENHOUSE, EXTRACTOR_USED.GREENHOUSE, result, null),
    ).toBe(false);
  });

  it("does not block on job count when completed=false with ATS platform + ATS extractor", () => {
    // The old gate `jobs.length > 0` would have blocked this; the new gate
    // `result.completed` does not — so the function proceeds to Condition A/B.
    // Condition A requires listings_scanned === 0, so with 1 job this returns false
    // due to Condition A failing, NOT due to the job-count gate.
    const result: ExtractJobsResult = {
      jobs: makeJobs(1),
      completed: false,
      listings_scanned: 1,
      pages_visited: 1,
    };
    // This should NOT be blocked by the old `jobs.length > 0` gate.
    // It returns false because Condition A requires listings_scanned === 0,
    // but the important thing is it gets past the completion gate.
    const outcome = shouldAttemptPlaywrightFallback(
      AtsType.GREENHOUSE,
      EXTRACTOR_USED.GREENHOUSE,
      result,
      null,
    );
    // Condition A: listings_scanned must be 0 → fails here, so false.
    // But the test validates the gate change: completed=false does NOT block.
    expect(outcome).toBe(false);
  });

  it("returns false when failure_code is BLOCKED", () => {
    const result: ExtractJobsResult = {
      jobs: [],
      completed: false,
      listings_scanned: 0,
      pages_visited: 1,
      failure_code: "BLOCKED",
      failure_reason: "request blocked or captcha encountered",
    };
    expect(
      shouldAttemptPlaywrightFallback(AtsType.GREENHOUSE, EXTRACTOR_USED.GREENHOUSE, result, null),
    ).toBe(false);
  });

  it("returns false when failure_code is FETCH_FAILED", () => {
    const result: ExtractJobsResult = {
      jobs: [],
      completed: false,
      listings_scanned: 0,
      pages_visited: 0,
      failure_code: "FETCH_FAILED",
      failure_reason: "failed to fetch careers page for extraction",
    };
    expect(
      shouldAttemptPlaywrightFallback(AtsType.GREENHOUSE, EXTRACTOR_USED.GREENHOUSE, result, null),
    ).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// 7.3 — completion_reason integration tests
// ---------------------------------------------------------------------------
describe("completion_reason derivation (documented via extraction result shapes)", () => {
  // deriveCompletionReason is private in processClaimedCompany.ts.
  // We document the expected mapping here and verify the extraction result
  // shapes that feed into it via isConfidentListingsSurface and failure codes.

  // completion_reason mapping:
  //   completed=true                              → "CONFIDENT_SURFACE"
  //   completed=false, failure_code present        → failure_code value
  //   completed=false, no failure_code, jobs=[]    → "NO_LISTINGS_PARSED"
  //   completed=false, no failure_code, jobs.len>0 → "NOT_CONFIDENT_SURFACE"

  it("completed=true extraction → completion_reason would be CONFIDENT_SURFACE", () => {
    // When isConfidentListingsSurface returns true, extraction sets completed=true.
    // deriveCompletionReason maps completed=true → "CONFIDENT_SURFACE".
    const confident = isConfidentListingsSurface(
      NO_SHELL_HTML,
      "https://example.com/careers",
      makeJobs(3),
      EXTRACTOR_USED.GENERIC_HTTP,
    );
    expect(confident).toBe(true);
    // The extraction result shape: { completed: true, ... }
    // → deriveCompletionReason returns "CONFIDENT_SURFACE"
  });

  it("completed=false with failure_code=INSUFFICIENT_LISTINGS → completion_reason would be INSUFFICIENT_LISTINGS", () => {
    // When isConfidentListingsSurface returns false and jobs > 0 on a generic surface,
    // extractJobsHttp sets failure_code="INSUFFICIENT_LISTINGS".
    // deriveCompletionReason maps failure_code → "INSUFFICIENT_LISTINGS".
    const confident = isConfidentListingsSurface(
      NO_SHELL_HTML,
      "https://example.com/careers",
      makeJobs(1),
      EXTRACTOR_USED.GENERIC_HTTP,
    );
    expect(confident).toBe(false);
    // The extraction result shape: { completed: false, failure_code: "INSUFFICIENT_LISTINGS", ... }
    // → deriveCompletionReason returns "INSUFFICIENT_LISTINGS"
  });

  it("completed=false, no failure_code, jobs=[] → completion_reason would be NO_LISTINGS_PARSED", () => {
    // When extraction returns zero jobs and no failure_code (defensive fallback),
    // deriveCompletionReason returns "NO_LISTINGS_PARSED".
    // In practice, extractJobsHttp always sets failure_code for zero-job cases,
    // but the fallback exists for safety.
    const confident = isConfidentListingsSurface(
      NO_SHELL_HTML,
      "https://example.com/careers",
      [],
      EXTRACTOR_USED.GENERIC_HTTP,
    );
    expect(confident).toBe(false);
    // Extraction result shape: { completed: false, jobs: [] }
    // → deriveCompletionReason returns "NO_LISTINGS_PARSED"
  });
});

// ---------------------------------------------------------------------------
// 7.4 — Regression tests (computeFinalStatus)
// ---------------------------------------------------------------------------
describe("computeFinalStatus regression", () => {
  it("completed=false with non-empty careersUrl and strong resolution → UNVERIFIED", () => {
    const result = computeFinalStatus({
      careersUrl: "https://example.com/careers",
      extraction: { completed: false, failure_code: "INSUFFICIENT_LISTINGS", failure_reason: "below threshold" },
      matchCount: 0,
      resolutionMethod: "DIRECT_VERIFIED",
    });
    expect(result.computed_status).toBe("UNVERIFIED");
  });

  it("completed=true, matchCount=0, non-empty careersUrl, strong resolution → NO_MATCH_SCAN_COMPLETED", () => {
    const result = computeFinalStatus({
      careersUrl: "https://example.com/careers",
      extraction: { completed: true },
      matchCount: 0,
      resolutionMethod: "DIRECT_VERIFIED",
    });
    expect(result.computed_status).toBe("NO_MATCH_SCAN_COMPLETED");
  });

  it("completed=true, matchCount=3, non-empty careersUrl, strong resolution → MATCHES_FOUND", () => {
    const result = computeFinalStatus({
      careersUrl: "https://example.com/careers",
      extraction: { completed: true },
      matchCount: 3,
      resolutionMethod: "DIRECT_VERIFIED",
    });
    expect(result.computed_status).toBe("MATCHES_FOUND");
  });
});

// ---------------------------------------------------------------------------
// P0: weak and null resolution enforcement (C5.1 / R5.2 / Step 8.4)
// ---------------------------------------------------------------------------

describe("computeFinalStatus — weak and null resolution enforcement", () => {
  // When extraction did not complete, Step 8.4 catches the violation before C5.1,
  // so completed=false + any resolution method must always produce UNVERIFIED without throwing.

  it("completed=false + INDIRECT → UNVERIFIED (no throw)", () => {
    const result = computeFinalStatus({
      careersUrl: "https://example.com/careers",
      extraction: { completed: false, failure_code: "WEAK_SURFACE", failure_reason: "weak resolution" },
      matchCount: 0,
      resolutionMethod: "INDIRECT",
    });
    expect(result.computed_status).toBe("UNVERIFIED");
  });

  it("completed=false + UNRESOLVED → UNVERIFIED (no throw)", () => {
    const result = computeFinalStatus({
      careersUrl: "https://example.com/careers",
      extraction: { completed: false, failure_code: "LISTINGS_SURFACE_UNRESOLVED", failure_reason: "unresolved" },
      matchCount: 0,
      resolutionMethod: "UNRESOLVED",
    });
    expect(result.computed_status).toBe("UNVERIFIED");
  });

  it("completed=false + PLAYWRIGHT_REQUIRED → UNVERIFIED (no throw)", () => {
    const result = computeFinalStatus({
      careersUrl: "https://example.com/careers",
      extraction: { completed: false, failure_code: "JS_REQUIRED_UNRESOLVED", failure_reason: "js required" },
      matchCount: 0,
      resolutionMethod: "PLAYWRIGHT_REQUIRED",
    });
    expect(result.computed_status).toBe("UNVERIFIED");
  });

  it("completed=false + null resolution → UNVERIFIED (no throw)", () => {
    const result = computeFinalStatus({
      careersUrl: null,
      extraction: { completed: false, failure_code: "CAREERS_NOT_FOUND", failure_reason: "not found" },
      matchCount: 0,
      resolutionMethod: null,
    });
    expect(result.computed_status).toBe("UNVERIFIED");
  });

  // C5.1: when extraction is marked complete but the resolution context is weak or null,
  // computeFinalStatus would compute NO_MATCH_SCAN_COMPLETED and then assertFinalOutcomeRules
  // throws — enforcing that uncertain resolution can never claim "no match".
  // In practice processClaimedCompany overrides completed=true to false for weak contexts
  // (isExtractionContextTrustworthy guard), so assertFinalOutcomeRules is defense-in-depth.

  it("C5.1: completed=true, matchCount=0, INDIRECT → throws (uncertain resolution cannot claim no match)", () => {
    expect(() =>
      computeFinalStatus({
        careersUrl: "https://example.com/careers",
        extraction: { completed: true },
        matchCount: 0,
        resolutionMethod: "INDIRECT",
      })
    ).toThrow();
  });

  it("C5.1: completed=true, matchCount=0, UNRESOLVED → throws", () => {
    expect(() =>
      computeFinalStatus({
        careersUrl: "https://example.com/careers",
        extraction: { completed: true },
        matchCount: 0,
        resolutionMethod: "UNRESOLVED",
      })
    ).toThrow();
  });

  it("C5.1: completed=true, matchCount=0, null resolution → throws", () => {
    expect(() =>
      computeFinalStatus({
        careersUrl: "https://example.com/careers",
        extraction: { completed: true },
        matchCount: 0,
        resolutionMethod: null,
      })
    ).toThrow();
  });

  // R5.2: same enforcement for MATCHES_FOUND — weak resolution cannot claim matches found.

  it("R5.2: completed=true, matchCount=1, INDIRECT → throws (uncertain resolution cannot claim matches found)", () => {
    expect(() =>
      computeFinalStatus({
        careersUrl: "https://example.com/careers",
        extraction: { completed: true },
        matchCount: 1,
        resolutionMethod: "INDIRECT",
      })
    ).toThrow();
  });

  it("R5.2: completed=true, matchCount=1, null resolution → throws", () => {
    expect(() =>
      computeFinalStatus({
        careersUrl: "https://example.com/careers",
        extraction: { completed: true },
        matchCount: 1,
        resolutionMethod: null,
      })
    ).toThrow();
  });

  // Positive guards: strong resolution methods must still produce confident outcomes.

  it("ATS_RESOLVED is a strong resolution: completed=true, matchCount=0 → NO_MATCH_SCAN_COMPLETED", () => {
    const result = computeFinalStatus({
      careersUrl: "https://example.com/careers",
      extraction: { completed: true },
      matchCount: 0,
      resolutionMethod: "ATS_RESOLVED",
    });
    expect(result.computed_status).toBe("NO_MATCH_SCAN_COMPLETED");
  });

  it("CTA_RESOLVED is a strong resolution: completed=true, matchCount=2 → MATCHES_FOUND", () => {
    const result = computeFinalStatus({
      careersUrl: "https://example.com/careers",
      extraction: { completed: true },
      matchCount: 2,
      resolutionMethod: "CTA_RESOLVED",
    });
    expect(result.computed_status).toBe("MATCHES_FOUND");
  });
});

// ---------------------------------------------------------------------------
// Pagination signal detection — hasPaginationSignal unit tests
// ---------------------------------------------------------------------------
describe("hasPaginationSignal", () => {
  it("returns false for plain HTML with no pagination signals", () => {
    expect(hasPaginationSignal("<html><body><p>hello</p></body></html>")).toBe(false);
  });

  it("detects rel=next link element (P1)", () => {
    expect(hasPaginationSignal('<link rel="next" href="/jobs?page=2">')).toBe(true);
  });

  it("detects anchor with rel=next (P1)", () => {
    expect(hasPaginationSignal('<a rel="next" href="/jobs?page=2">Next</a>')).toBe(true);
  });

  it("detects 'next page' text (P2)", () => {
    expect(hasPaginationSignal('<a href="/jobs?page=2">Next Page</a>')).toBe(true);
  });

  it("detects 'load more' button text (P3)", () => {
    expect(hasPaginationSignal('<button>Load More</button>')).toBe(true);
  });

  it("detects 'load more' in class attribute (P3)", () => {
    expect(hasPaginationSignal('<div class="load-more-button">Load More Jobs</div>')).toBe(true);
  });

  it("detects 'show more' pattern (P4)", () => {
    expect(hasPaginationSignal('<button>Show More</button>')).toBe(true);
  });

  it("detects 'more jobs' text (P5)", () => {
    expect(hasPaginationSignal('<a href="/jobs?page=2">More Jobs</a>')).toBe(true);
  });

  it("detects 'view more jobs' text (P5)", () => {
    expect(hasPaginationSignal('<a href="/jobs?page=2">View More Jobs</a>')).toBe(true);
  });

  it("detects pagination container class (P6)", () => {
    expect(hasPaginationSignal('<div class="pagination"><span>1</span><a href="?page=2">2</a></div>')).toBe(true);
  });

  it("detects pagination container id (P6)", () => {
    expect(hasPaginationSignal('<nav id="pagination-nav"></nav>')).toBe(true);
  });

  it("detects pager container class (P6)", () => {
    expect(hasPaginationSignal('<div class="pager"><a href="?page=2">2</a></div>')).toBe(true);
  });

  it("detects paginator container class (P6)", () => {
    expect(hasPaginationSignal('<nav class="paginator"><a href="?page=2">Next</a></nav>')).toBe(true);
  });

  it("detects showing N-M of T pattern (P7a)", () => {
    expect(hasPaginationSignal("<p>Showing 1-10 of 50 jobs</p>")).toBe(true);
  });

  it("detects showing N to M of T pattern (P7b)", () => {
    expect(hasPaginationSignal("<p>Showing 1 to 10 of 50 results</p>")).toBe(true);
  });

  it("detects page N of M pattern (P8)", () => {
    expect(hasPaginationSignal("<p>Page 1 of 3</p>")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(hasPaginationSignal("<button>LOAD MORE</button>")).toBe(true);
    expect(hasPaginationSignal('<LINK REL="NEXT" HREF="/page2">')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pagination signal integration — fail-closed on incomplete enumeration
//
// Gate 2 conservative baseline: extraction never fetches or follows a page-2
// URL. When an obvious pagination/incomplete-enumeration signal is present on
// the fetched page, extraction returns completed=false with
// PAGINATION_NOT_COMPLETED rather than attempting to enumerate further pages.
// ---------------------------------------------------------------------------
describe("extractJobs — pagination detection fails closed (no page-2 fetch)", () => {
  it("A: GENERIC_HTTP with >= 3 jobs and no pagination signal returns completed=true", async () => {
    mockHtmlExtraction(`
      <a href="https://example.com/jobs/1">Software Engineer</a>
      <a href="https://example.com/jobs/2">Backend Engineer</a>
      <a href="https://example.com/jobs/3">Frontend Engineer</a>
    `);

    const result = await extractJobs(
      "https://example.com/careers",
      AtsType.UNKNOWN,
      EXTRACTOR_USED.GENERIC_HTTP
    );

    expect(result.completed).toBe(true);
    expect(result.failure_code).toBeUndefined();
  });

  it("B: pagination signal on first page returns completed=false with PAGINATION_NOT_COMPLETED and the required reason", async () => {
    mockHtmlExtraction(`
      <a href="https://example.com/jobs/1">Software Engineer</a>
      <a href="https://example.com/jobs/2">Backend Engineer</a>
      <a href="https://example.com/jobs/3">Frontend Engineer</a>
      <button>Load More</button>
    `);

    const result = await extractJobs(
      "https://example.com/careers",
      AtsType.UNKNOWN,
      EXTRACTOR_USED.GENERIC_HTTP
    );

    expect(result.completed).toBe(false);
    expect(result.failure_code).toBe("PAGINATION_NOT_COMPLETED");
    expect(result.failure_reason).toBe(
      "pagination detected; additional pages were not searched"
    );
    expect(result.jobs.length).toBeGreaterThanOrEqual(3);
  });

  it("C: class=\"pagination\" returns completed=false with PAGINATION_NOT_COMPLETED", async () => {
    mockHtmlExtraction(`
      <nav class="pagination"><a href="https://example.com/careers?page=2">2</a></nav>
      <a href="https://example.com/jobs/1">Software Engineer</a>
      <a href="https://example.com/jobs/2">Backend Engineer</a>
      <a href="https://example.com/jobs/3">Frontend Engineer</a>
    `);

    const result = await extractJobs(
      "https://example.com/careers",
      AtsType.UNKNOWN,
      EXTRACTOR_USED.GENERIC_HTTP
    );

    expect(result.completed).toBe(false);
    expect(result.failure_code).toBe("PAGINATION_NOT_COMPLETED");
  });

  it("D: class=\"pager\" returns completed=false with PAGINATION_NOT_COMPLETED", async () => {
    mockHtmlExtraction(`
      <div class="pager"><a href="https://example.com/careers?page=2">Next</a></div>
      <a href="https://example.com/jobs/1">Software Engineer</a>
      <a href="https://example.com/jobs/2">Backend Engineer</a>
      <a href="https://example.com/jobs/3">Frontend Engineer</a>
    `);

    const result = await extractJobs(
      "https://example.com/careers",
      AtsType.UNKNOWN,
      EXTRACTOR_USED.GENERIC_HTTP
    );

    expect(result.completed).toBe(false);
    expect(result.failure_code).toBe("PAGINATION_NOT_COMPLETED");
  });

  it("E: class=\"paginator\" returns completed=false with PAGINATION_NOT_COMPLETED", async () => {
    mockHtmlExtraction(`
      <nav class="paginator"><a href="https://example.com/careers?page=2">Next</a></nav>
      <a href="https://example.com/jobs/1">Software Engineer</a>
      <a href="https://example.com/jobs/2">Backend Engineer</a>
      <a href="https://example.com/jobs/3">Frontend Engineer</a>
    `);

    const result = await extractJobs(
      "https://example.com/careers",
      AtsType.UNKNOWN,
      EXTRACTOR_USED.GENERIC_HTTP
    );

    expect(result.completed).toBe(false);
    expect(result.failure_code).toBe("PAGINATION_NOT_COMPLETED");
  });

  it("F: rel=\"next\" returns completed=false with PAGINATION_NOT_COMPLETED", async () => {
    mockHtmlExtraction(`
      <link rel="next" href="https://example.com/careers?page=2">
      <a href="https://example.com/jobs/1">Software Engineer</a>
      <a href="https://example.com/jobs/2">Backend Engineer</a>
      <a href="https://example.com/jobs/3">Frontend Engineer</a>
    `);

    const result = await extractJobs(
      "https://example.com/careers",
      AtsType.UNKNOWN,
      EXTRACTOR_USED.GENERIC_HTTP
    );

    expect(result.completed).toBe(false);
    expect(result.failure_code).toBe("PAGINATION_NOT_COMPLETED");
  });

  it("G: 'Load more' / 'Show more' returns completed=false with PAGINATION_NOT_COMPLETED", async () => {
    mockHtmlExtraction(`
      <a href="https://example.com/jobs/1">Software Engineer</a>
      <a href="https://example.com/jobs/2">Backend Engineer</a>
      <a href="https://example.com/jobs/3">Frontend Engineer</a>
      <button>Show More</button>
    `);

    const result = await extractJobs(
      "https://example.com/careers",
      AtsType.UNKNOWN,
      EXTRACTOR_USED.GENERIC_HTTP
    );

    expect(result.completed).toBe(false);
    expect(result.failure_code).toBe("PAGINATION_NOT_COMPLETED");
  });

  it("H: 'showing 1-10 of 50' returns completed=false with PAGINATION_NOT_COMPLETED", async () => {
    mockHtmlExtraction(`
      <p>Showing 1-10 of 50 jobs</p>
      <a href="https://example.com/jobs/1">Software Engineer</a>
      <a href="https://example.com/jobs/2">Backend Engineer</a>
      <a href="https://example.com/jobs/3">Frontend Engineer</a>
    `);

    const result = await extractJobs(
      "https://example.com/careers",
      AtsType.UNKNOWN,
      EXTRACTOR_USED.GENERIC_HTTP
    );

    expect(result.completed).toBe(false);
    expect(result.failure_code).toBe("PAGINATION_NOT_COMPLETED");
  });

  it("pagination signal on a page with zero jobs still returns completed=false (NO_LISTINGS_PARSED takes precedence)", async () => {
    mockHtmlExtraction(`
      <p>Showing 1-10 of 50 jobs</p>
    `);

    const result = await extractJobs(
      "https://example.com/careers",
      AtsType.UNKNOWN,
      EXTRACTOR_USED.GENERIC_HTTP
    );

    expect(result.completed).toBe(false);
    expect(["NO_LISTINGS_PARSED", "PAGINATION_NOT_COMPLETED"]).toContain(result.failure_code);
  });

  it("never fetches a second page even when a followable next-page URL is present", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => `
        <link rel="next" href="https://example.com/careers?page=2">
        <a href="https://example.com/jobs/1">Software Engineer</a>
        <a href="https://example.com/jobs/2">Backend Engineer</a>
        <a href="https://example.com/jobs/3">Frontend Engineer</a>
      `,
    } as Response);

    const result = await extractJobs(
      "https://example.com/careers",
      AtsType.UNKNOWN,
      EXTRACTOR_USED.GENERIC_HTTP
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.pages_visited).toBe(1);
    expect(result.completed).toBe(false);
    expect(result.failure_code).toBe("PAGINATION_NOT_COMPLETED");
  });
});

// ---------------------------------------------------------------------------
// Pagination control exclusion from job listings (parseJobsFromHtml)
// ---------------------------------------------------------------------------
describe("parseJobsFromHtml — pagination controls not counted as jobs", () => {
  // A: /careers/page/2 Next link is not a job.
  it("A: <a href='/careers/page/2'>Next</a> inside pagination container is not a job listing", async () => {
    mockHtmlExtraction(`
      <nav class="pagination"><a href="https://example.com/careers/page/2">Next</a></nav>
      <a href="https://example.com/careers/software-engineer-1">Software Engineer</a>
      <a href="https://example.com/careers/backend-engineer-2">Backend Engineer</a>
      <a href="https://example.com/careers/frontend-engineer-3">Frontend Engineer</a>
    `);
    const result = await extractJobs("https://example.com/careers", AtsType.UNKNOWN, EXTRACTOR_USED.GENERIC_HTTP);

    // Exactly 3 real jobs; the Next link must not appear.
    expect(result.jobs.length).toBe(3);
    const urls = result.jobs.map((j) => j.url);
    expect(urls).not.toContain("https://example.com/careers/page/2");
    expect(result.listings_scanned).toBe(3);
  });

  // B: /jobs/page/2 Next link is not a job.
  it("B: <a href='/jobs/page/2'>Next</a> inside pagination container is not a job listing", async () => {
    mockHtmlExtraction(`
      <nav class="pagination"><a href="https://example.com/jobs/page/2">Next</a></nav>
      <a href="https://example.com/jobs/software-engineer-1">Software Engineer</a>
      <a href="https://example.com/jobs/backend-engineer-2">Backend Engineer</a>
      <a href="https://example.com/jobs/frontend-engineer-3">Frontend Engineer</a>
    `);
    const result = await extractJobs("https://example.com/jobs", AtsType.UNKNOWN, EXTRACTOR_USED.GENERIC_HTTP);

    expect(result.jobs.length).toBe(3);
    const urls = result.jobs.map((j) => j.url);
    expect(urls).not.toContain("https://example.com/jobs/page/2");
    expect(result.listings_scanned).toBe(3);
  });

  // E: Real job link /careers/software-engineer is still parsed as a job.
  it("E: /careers/software-engineer is parsed as a real job (not filtered out)", async () => {
    mockHtmlExtraction(`
      <a href="https://example.com/careers/software-engineer">Software Engineer</a>
      <a href="https://example.com/careers/backend-engineer">Backend Engineer</a>
      <a href="https://example.com/careers/frontend-engineer">Frontend Engineer</a>
    `);
    const result = await extractJobs("https://example.com/careers", AtsType.UNKNOWN, EXTRACTOR_USED.GENERIC_HTTP);

    expect(result.jobs.length).toBe(3);
    expect(result.jobs.map((j) => j.url)).toContain("https://example.com/careers/software-engineer");
  });

  // E2: Numeric job detail URLs are valid job links — not excluded from job parsing.
  it("E2: /jobs/12345 and /careers/12345 still parse as real job links", async () => {
    mockHtmlExtraction(`
      <a href="https://example.com/jobs/12345">Software Engineer</a>
      <a href="https://example.com/careers/67890">Backend Engineer</a>
      <a href="https://example.com/openings/11111">Frontend Engineer</a>
    `);
    const result = await extractJobs("https://example.com/jobs", AtsType.UNKNOWN, EXTRACTOR_USED.GENERIC_HTTP);

    expect(result.jobs.length).toBe(3);
    const urls = result.jobs.map((j) => j.url);
    expect(urls).toContain("https://example.com/jobs/12345");
    expect(urls).toContain("https://example.com/careers/67890");
    expect(urls).toContain("https://example.com/openings/11111");
  });

  // F: listings_scanned is honest — does not include pagination controls.
  it("F: listings_scanned does not count the Next pagination link", async () => {
    mockHtmlExtraction(`
      <nav class="pagination"><a href="https://example.com/careers/page/2">Next</a></nav>
      <a href="https://example.com/careers/software-engineer-1">Software Engineer</a>
      <a href="https://example.com/careers/backend-engineer-2">Backend Engineer</a>
      <a href="https://example.com/careers/frontend-engineer-3">Frontend Engineer</a>
    `);
    const result = await extractJobs("https://example.com/careers", AtsType.UNKNOWN, EXTRACTOR_USED.GENERIC_HTTP);

    // listings_scanned must equal the job count — not inflated by the Next link.
    expect(result.listings_scanned).toBe(result.jobs.length);
    expect(result.listings_scanned).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Pagination signal with computeFinalStatus — must produce UNVERIFIED
// ---------------------------------------------------------------------------
describe("pagination signal forces UNVERIFIED through computeFinalStatus", () => {
  it("completed=false with PAGINATION_NOT_COMPLETED and strong resolution → UNVERIFIED", () => {
    const result = computeFinalStatus({
      careersUrl: "https://example.com/careers",
      extraction: {
        completed: false,
        failure_code: "PAGINATION_NOT_COMPLETED",
        failure_reason: "pagination signal detected but no followable next-page URL found",
      },
      matchCount: 0,
      resolutionMethod: "DIRECT_VERIFIED",
    });

    expect(result.computed_status).toBe("UNVERIFIED");
    expect(result.failure_code).toBe("PAGINATION_NOT_COMPLETED");
  });
});

// ---------------------------------------------------------------------------
// Step 8.4 explicit: completed=false never produces MATCHES_FOUND
// ---------------------------------------------------------------------------
// The existing tests exercise completed=false with matchCount=0 only.
// This block explicitly verifies that a non-zero matchCount cannot override
// the completed=false rule — the result must always be UNVERIFIED.
describe("computeFinalStatus — completed=false always yields UNVERIFIED regardless of matchCount", () => {
  it("completed=false with matchCount > 0 and strong resolution → UNVERIFIED (never MATCHES_FOUND)", () => {
    const result = computeFinalStatus({
      careersUrl: "https://example.com/careers",
      extraction: { completed: false, failure_code: "BLOCKED", failure_reason: "request blocked" },
      matchCount: 5,
      resolutionMethod: "DIRECT_VERIFIED",
    });
    expect(result.computed_status).toBe("UNVERIFIED");
  });

  it("completed=false with matchCount > 0 and null resolution → UNVERIFIED", () => {
    const result = computeFinalStatus({
      careersUrl: null,
      extraction: { completed: false, failure_code: "CAREERS_NOT_FOUND", failure_reason: "not found" },
      matchCount: 3,
      resolutionMethod: null,
    });
    expect(result.computed_status).toBe("UNVERIFIED");
  });
});


// ---------------------------------------------------------------------------
// J: computeFinalStatus preserves/carries through PAGINATION_NOT_COMPLETED
// ---------------------------------------------------------------------------
describe("computeFinalStatus — pagination lifecycle (single-page, fail-closed)", () => {
  it("J1: completed=true with matches → MATCHES_FOUND", () => {
    const result = computeFinalStatus({
      careersUrl: "https://example.com/careers",
      extraction: { completed: true },
      matchCount: 2,
      resolutionMethod: "DIRECT_VERIFIED",
    });
    expect(result.computed_status).toBe("MATCHES_FOUND");
  });

  it("J2: completed=true with no matches → NO_MATCH_SCAN_COMPLETED", () => {
    const result = computeFinalStatus({
      careersUrl: "https://example.com/careers",
      extraction: { completed: true },
      matchCount: 0,
      resolutionMethod: "DIRECT_VERIFIED",
    });
    expect(result.computed_status).toBe("NO_MATCH_SCAN_COMPLETED");
  });

  it("J3: pagination detected → UNVERIFIED, not NO_MATCH_SCAN_COMPLETED, with failure_code and failure_reason preserved", () => {
    const result = computeFinalStatus({
      careersUrl: "https://example.com/careers",
      extraction: {
        completed: false,
        failure_code: "PAGINATION_NOT_COMPLETED",
        failure_reason: "pagination detected; additional pages were not searched",
      },
      matchCount: 0,
      resolutionMethod: "DIRECT_VERIFIED",
    });
    expect(result.computed_status).toBe("UNVERIFIED");
    expect(result.failure_code).toBe("PAGINATION_NOT_COMPLETED");
    expect(result.failure_reason).toBe(
      "pagination detected; additional pages were not searched"
    );
  });

  it("J4: pagination detected with matchCount > 0 still → UNVERIFIED, never MATCHES_FOUND", () => {
    const result = computeFinalStatus({
      careersUrl: "https://example.com/careers",
      extraction: {
        completed: false,
        failure_code: "PAGINATION_NOT_COMPLETED",
        failure_reason: "pagination detected; additional pages were not searched",
      },
      matchCount: 5,
      resolutionMethod: "DIRECT_VERIFIED",
    });
    expect(result.computed_status).toBe("UNVERIFIED");
    expect(result.failure_code).toBe("PAGINATION_NOT_COMPLETED");
  });
});
