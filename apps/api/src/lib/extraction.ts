/**
 * Extraction module (roadmap Step 6.4).
 * extractJobs(url, platform, extractor_used) contract; Playwright fallback orchestration in worker.
 */

import type { AtsType } from "@surveyor/shared";
import { AtsType as Ats } from "@surveyor/shared";
import { serializeErrorForTrace } from "./errorTrace.js";

export const MAX_LISTINGS_PER_COMPANY = 200;
export const MAX_PAGES_PER_COMPANY = 20;
export const MAX_TIME_PER_COMPANY_MS = 30000;
/** Minimum parsed job listings for a generic surface to be considered confidently enumerated. */
export const MIN_CONFIDENT_LISTINGS = 3;
const REQUEST_TIMEOUT_MS = 5000;

export type Job = {
  title: string;
  location: string | null;
  url: string;
};

/** Return shape from extractJobs — roadmap Step 6.4 (no extra fields). */
export type ExtractJobsResult = {
  jobs: Job[];
  completed: boolean;
  listings_scanned: number;
  pages_visited: number;
  failure_code?: string;
  failure_reason?: string;
};

export const EXTRACTOR_USED = {
  GREENHOUSE: "GREENHOUSE",
  LEVER: "LEVER",
  ASHBY: "ASHBY",
  SMARTRECRUITERS: "SMARTRECRUITERS",
  GENERIC_HTTP: "GENERIC_HTTP",
  PLAYWRIGHT: "PLAYWRIGHT",
} as const;

export type ExtractorUsedName =
  (typeof EXTRACTOR_USED)[keyof typeof EXTRACTOR_USED];

export type PlaywrightStageName =
  | "import_playwright"
  | "browser_launch"
  | "new_context"
  | "new_page"
  | "goto"
  | "wait_for_content"
  | "parse_dom"
  | "browser_close"
  | "unknown";

export type PlaywrightStageFailedDiagnostic = {
  stage: PlaywrightStageName;
  url: string;
  error_name: string | null;
  error_message: string | null;
  error_stack_preview: string | null;
  listings_scanned: number;
  pages_visited: number;
  duration_ms: number;
};

export type ExtractionDiagnostics = {
  onPlaywrightStageFailed?: (diagnostic: PlaywrightStageFailedDiagnostic) => void;
};

type JobLinkCandidate = {
  href: string;
  title: string;
  location: string | null;
};

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCharCode(Number(code))
    );
}

function stripHtmlToText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function extractTextForClass(innerHtml: string, className: string): string | null {
  const re = new RegExp(
    `<[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`,
    "i"
  );
  const match = re.exec(innerHtml);
  if (!match) return null;
  const text = stripHtmlToText(match[1]!);
  return text.length > 0 ? text : null;
}

function jobLinkRegexForHtml(html: string): JobLinkCandidate[] {
  const matches: JobLinkCandidate[] = [];
  const re =
    /<a\b[^>]*\bhref\s*=\s*(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = decodeHtmlEntities(m[2]!);
    const innerHtml = m[3]!;
    const title = extractTextForClass(innerHtml, "job-title") ?? stripHtmlToText(innerHtml);
    const location = extractTextForClass(innerHtml, "job-location");
    if (
      /job|career|opening|position|role/i.test(href) ||
      /job|career|opening|position|role/i.test(title)
    ) {
      matches.push({ href, title, location });
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// C4.2 – filter out navigation links, CTA links, and container-page anchors
// ---------------------------------------------------------------------------

/**
 * C4.2: Visible anchor text patterns that indicate a navigation, CTA, or
 * container link pointing to a job listing INDEX, not an individual posting.
 *
 * Anchored with ^ and $ so real job titles that happen to contain these words
 * (e.g. "Senior Careers Advisor") are not accidentally excluded.
 */
const NAV_CTA_TEXT_RE =
  /^(?:careers?|jobs?|openings?|positions?|roles?|opportunities|hiring|join\s+us|work\s+with\s+us|view\s+(?:all\s+)?(?:jobs?|openings?|roles?)|see\s+(?:all\s+)?(?:jobs?|openings?|roles?)|browse\s+(?:all\s+)?(?:jobs?|roles?)|explore\s+(?:roles?|careers?|jobs?|opportunities?)|search\s+jobs?|find\s+(?:a\s+)?jobs?|open\s+roles?|our\s+(?:jobs?|openings?|roles?)|all\s+(?:jobs?|roles?|openings?)|apply\s+now|see\s+all\s+openings?)$/i;

/**
 * C4.2: URL path terminal segments that identify a container or category page.
 * A URL whose path ends at one of these segments — without a further job
 * identifier slug — points to an index/category page, not a specific job posting.
 */
const CONTAINER_PATH_TERMINALS = new Set<string>([
  "careers",
  "jobs",
  "openings",
  "positions",
  "roles",
  "opportunities",
  "hiring",
  "join-us",
  "work-with-us",
  "careers-home",
]);

/**
 * C4.2: Return true when the link is a navigation, CTA, or container anchor
 * that must NOT be counted as an extracted job listing.
 *
 * Two independent checks — a link is excluded when EITHER matches:
 *
 *   Text check — the visible anchor text matches a known navigation or CTA
 *   phrase (e.g. "View all jobs", "See openings", "Careers"). Exact-match
 *   patterns prevent real job title text from being accidentally excluded.
 *
 *   URL check — the URL path ends at a known container segment with no further
 *   job identifier (e.g. /careers, /company/jobs). Paths that include an
 *   additional segment past the container keyword — such as /jobs/12345-engineer
 *   or /careers/software-engineer — pass through as potential real listings.
 */
function isNavOrContainerLink(href: string, text: string): boolean {
  if (NAV_CTA_TEXT_RE.test(text)) {
    return true;
  }
  try {
    const path = new URL(href).pathname.replace(/\/$/, "").toLowerCase();
    const segments = path.split("/").filter(Boolean);
    if (segments.length === 0) return true;
    const last = segments[segments.length - 1]!;
    if (CONTAINER_PATH_TERMINALS.has(last)) return true;
  } catch {
    /* invalid URL — not excluded by URL check */
  }
  return false;
}

type FetchResult =
  | { kind: "ok"; html: string }
  | { kind: "blocked"; status: number }
  | { kind: "error" };

/** Step 8.2: deterministic content-level blocking signals (CAPTCHA, access denied, auth walls). */
const BLOCKED_HTML_PATTERNS: RegExp[] = [
  /\bcaptcha\b/i,
  /g-recaptcha/i,
  /\bhcaptcha\b/i,
  /cf-browser-verification/i,
  /checking your browser/i,
  /enable javascript and cookies to continue/i,
  /please verify you are human/i,
  /verifying you are human/i,
  /\baccess\s+denied\b/i,
  /\b403\s+forbidden\b/i,
  /\btoo\s+many\s+requests\b/i,
  /\brate[\s-]?limit/i,
];

function isBlockedHtml(html: string): boolean {
  return BLOCKED_HTML_PATTERNS.some((pattern) => pattern.test(html));
}

async function fetchHtml(url: string): Promise<FetchResult> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ac.signal,
      headers: {
        "User-Agent": "SurveyorBot/1.0",
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      },
    });
    if (res.status === 403 || res.status === 429) {
      return { kind: "blocked", status: res.status };
    }
    if (!res.ok) {
      return { kind: "error" };
    }
    const html = await res.text();
    return { kind: "ok", html };
  } catch {
    return { kind: "error" };
  } finally {
    clearTimeout(t);
  }
}

function parseJobsFromHtml(html: string, baseUrl: string): Job[] {
  const jobs: Job[] = [];
  const seen = new Set<string>();
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return jobs;
  }

  for (const link of jobLinkRegexForHtml(html)) {
    const { href, title, location } = link;
    let abs: string;
    try {
      abs = new URL(href, base).href;
    } catch {
      continue;
    }
    // C4.2: navigation links, CTA links, and container-page anchors must not
    // be counted as job listings — they inflate listings_scanned without
    // representing real individual job postings.
    if (isNavOrContainerLink(abs, title)) continue;
    if (seen.has(abs) || title.length < 2) {
      continue;
    }
    seen.add(abs);
    jobs.push({ title, location, url: abs });
  }
  return jobs;
}

function isSupportedAtsPlatform(platform: AtsType): boolean {
  return (
    platform === Ats.GREENHOUSE ||
    platform === Ats.LEVER ||
    platform === Ats.ASHBY ||
    platform === Ats.SMARTRECRUITERS
  );
}

function isNamedAtsExtractor(extractor_used: string): boolean {
  return (
    extractor_used === EXTRACTOR_USED.GREENHOUSE ||
    extractor_used === EXTRACTOR_USED.LEVER ||
    extractor_used === EXTRACTOR_USED.ASHBY ||
    extractor_used === EXTRACTOR_USED.SMARTRECRUITERS
  );
}

function hostIsOfficial(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * True when the fetch URL is served from a known ATS job-board host (direct board
 * surface), as opposed to a company marketing page that only references ATS.
 */
function urlLooksLikeSupportedAtsBoard(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      hostIsOfficial(host, "greenhouse.io") ||
      hostIsOfficial(host, "lever.co") ||
      hostIsOfficial(host, "ashbyhq.com") ||
      hostIsOfficial(host, "smartrecruiters.com")
    );
  } catch {
    return false;
  }
}

/**
 * Deterministic HTML markers for an ATS listing shell on the *current* page
 * (embed/widget/list container), keyed to the extractor in use.
 */
function htmlHasAtsListingShellForExtractor(
  html: string,
  extractor_used: string
): boolean {
  switch (extractor_used) {
    case EXTRACTOR_USED.GREENHOUSE:
      return (
        /greenhouse-job-board/i.test(html) ||
        /id=["']grnh_view_job_listings["']/i.test(html) ||
        /data-department-select/i.test(html) ||
        /boards\.greenhouse\.io\/embed\/job_board/i.test(html)
      );
    case EXTRACTOR_USED.LEVER:
      return /lever-jobs-container|postings-container|data-baseurl=["']https?:\/\/jobs\.lever\.co/i.test(
        html
      );
    case EXTRACTOR_USED.ASHBY:
      return (
        /jobs\.ashbyhq\.com/i.test(html) ||
        /app\.ashbyhq\.com\/api\/non-user-facing\/job-board/i.test(html)
      );
    case EXTRACTOR_USED.SMARTRECRUITERS:
      return (
        /smartrecruiters-widget/i.test(html) ||
        /jobs\.smartrecruiters\.com/i.test(html)
      );
    default:
      return false;
  }
}

function pathHasDetailAfterSegment(pathname: string, segmentNames: string[]): boolean {
  const segments = pathname.toLowerCase().split("/").filter(Boolean);
  for (const segmentName of segmentNames) {
    const index = segments.indexOf(segmentName);
    if (index >= 0 && segments.length > index + 1) {
      const detailSegment = segments[index + 1]!;
      if (!CONTAINER_PATH_TERMINALS.has(detailSegment)) {
        return true;
      }
    }
  }
  return false;
}

function parsedJobUrlMatchesExtractor(url: string, extractor_used: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  switch (extractor_used) {
    case EXTRACTOR_USED.GREENHOUSE:
      return (
        hostIsOfficial(host, "greenhouse.io") &&
        pathHasDetailAfterSegment(parsed.pathname, ["jobs"])
      );
    case EXTRACTOR_USED.LEVER:
      return (
        hostIsOfficial(host, "lever.co") &&
        parsed.pathname.split("/").filter(Boolean).length >= 2
      );
    case EXTRACTOR_USED.ASHBY:
      return (
        hostIsOfficial(host, "ashbyhq.com") &&
        parsed.pathname.split("/").filter(Boolean).length >= 2
      );
    case EXTRACTOR_USED.SMARTRECRUITERS:
      return (
        hostIsOfficial(host, "smartrecruiters.com") &&
        parsed.pathname.split("/").filter(Boolean).length >= 2
      );
    default:
      return false;
  }
}

function hasConfidentParsedAtsJobUrls(
  jobs: Job[],
  extractor_used: string
): boolean {
  const uniqueMatchingUrls = new Set<string>();
  for (const job of jobs) {
    if (parsedJobUrlMatchesExtractor(job.url, extractor_used)) {
      uniqueMatchingUrls.add(job.url);
    }
  }
  return uniqueMatchingUrls.size >= MIN_CONFIDENT_LISTINGS;
}

function completionUsesAtsThresholds(
  extractor_used: string,
  url: string
): boolean {
  if (isNamedAtsExtractor(extractor_used)) {
    return true;
  }
  if (
    extractor_used === EXTRACTOR_USED.PLAYWRIGHT &&
    urlLooksLikeSupportedAtsBoard(url)
  ) {
    return true;
  }
  return false;
}

/**
 * Authoritative deterministic gate for whether extraction may set `completed: true`.
 * Generic surfaces need stronger enumeration evidence; supported ATS boards may
 * confirm completion with fewer parsed rows when the URL/HTML show a real board
 * or listing shell (see extractionCompletionRoadmap E1+).
 */
export function isConfidentListingsSurface(
  html: string,
  url: string,
  jobs: Job[],
  extractor_used: string
): boolean {
  if (jobs.length === 0) {
    return false;
  }

  if (completionUsesAtsThresholds(extractor_used, url)) {
    if (urlLooksLikeSupportedAtsBoard(url)) {
      return true;
    }
    if (isNamedAtsExtractor(extractor_used)) {
      return (
        htmlHasAtsListingShellForExtractor(html, extractor_used) ||
        hasConfidentParsedAtsJobUrls(jobs, extractor_used)
      );
    }
    return false;
  }

  // GENERIC_HTTP, or Playwright on a non–ATS-board URL (e.g. JS-rendered corporate careers).
  return jobs.length >= MIN_CONFIDENT_LISTINGS;
}

/**
 * Playwright fallback eligibility (Step 6.4 / D5.2).
 *
 * Playwright is allowed only when one of these two conditions is true:
 *
 *   Condition A — supported ATS platform, HTTP extraction ran but retrieved zero listings.
 *   Condition B — platform is UNKNOWN, the discovery resolver explicitly annotated
 *                 `resolution_method === 'PLAYWRIGHT_REQUIRED'` (set by detectJsGating in
 *                 discovery.ts when high-confidence JS-gating evidence was found).
 *
 * Condition B intentionally requires the resolver's annotation rather than an independent
 * heuristic inside extraction.  Discovery is the authoritative place to detect JS gating;
 * extraction orchestration only acts on that annotation.  This prevents casual Playwright
 * use outside the disciplined escalation path described in D5.2.
 *
 * Caller must still enforce worker_token ownership on the subsequent UPDATE.
 */
export function shouldAttemptPlaywrightFallback(
  platform: AtsType,
  extractor_used: string,
  result: ExtractJobsResult,
  /** resolution_method from the discovery result; 'PLAYWRIGHT_REQUIRED' authorises Condition B. */
  discoveryResolutionMethod: string | null
): boolean {
  if (extractor_used === EXTRACTOR_USED.PLAYWRIGHT) {
    return false;
  }
  if (result.completed) {
    return false;
  }
  if (result.failure_code === "FETCH_FAILED") {
    return false;
  }
  if (result.failure_code === "BLOCKED") {
    return false;
  }
  if (result.pages_visited < 1) {
    return false;
  }

  // Condition A: supported ATS, HTTP extractor ran, no listings retrieved.
  const conditionA =
    isSupportedAtsPlatform(platform) &&
    isNamedAtsExtractor(extractor_used) &&
    result.listings_scanned === 0;

  // Condition B: unknown platform, discovery resolver flagged JS gating.
  // Only 'PLAYWRIGHT_REQUIRED' (set by detectJsGating in discovery.ts) qualifies.
  const conditionB =
    platform === Ats.UNKNOWN &&
    extractor_used === EXTRACTOR_USED.GENERIC_HTTP &&
    discoveryResolutionMethod === "PLAYWRIGHT_REQUIRED";

  return conditionA || conditionB;
}

async function extractJobsWithPlaywright(
  url: string,
  diagnostics?: ExtractionDiagnostics
): Promise<ExtractJobsResult> {
  const startMs = Date.now();
  let stage: PlaywrightStageName = "import_playwright";
  let listings_scanned = 0;
  let pages_visited = 0;
  try {
    stage = "import_playwright";
    const { chromium } = await import("playwright");
    stage = "browser_launch";
    const browser = await chromium.launch({ headless: true });
    try {
      stage = "new_context";
      const context = await browser.newContext();
      stage = "new_page";
      const page = await context.newPage();
      stage = "goto";
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: MAX_TIME_PER_COMPANY_MS,
      });
      pages_visited = 1;

      // Step 8.2: detect blocking via HTTP status code from Playwright response.
      const status = response?.status() ?? null;
      if (status === 403 || status === 429) {
        return {
          jobs: [],
          completed: false,
          listings_scanned: 0,
          pages_visited: 1,
          failure_code: "BLOCKED",
          failure_reason: "request blocked or captcha encountered",
        };
      }

      stage = "wait_for_content";
      const html = await page.content();

      // Step 8.2: detect blocking via page content (CAPTCHA, access denied, auth walls).
      if (isBlockedHtml(html)) {
        return {
          jobs: [],
          completed: false,
          listings_scanned: 0,
          pages_visited: 1,
          failure_code: "BLOCKED",
          failure_reason: "request blocked or captcha encountered",
        };
      }

      stage = "parse_dom";
      const jobs = parseJobsFromHtml(html, url);
      listings_scanned = jobs.length;

      if (
        pages_visited >= MAX_PAGES_PER_COMPANY ||
        listings_scanned >= MAX_LISTINGS_PER_COMPANY ||
        Date.now() - startMs >= MAX_TIME_PER_COMPANY_MS
      ) {
        return {
          jobs,
          completed: false,
          listings_scanned,
          pages_visited,
          failure_code: "CAP_REACHED",
          failure_reason: "extraction limit reached",
        };
      }

      const completed = isConfidentListingsSurface(html, url, jobs, EXTRACTOR_USED.PLAYWRIGHT);

      if (!completed && jobs.length > 0) {
        const isGeneric = !completionUsesAtsThresholds(EXTRACTOR_USED.PLAYWRIGHT, url);
        return {
          jobs,
          completed: false,
          listings_scanned,
          pages_visited,
          failure_code: isGeneric ? "INSUFFICIENT_LISTINGS" : "NOT_CONFIDENT_SURFACE",
          failure_reason: isGeneric
            ? `parsed ${jobs.length} listings, below minimum threshold of ${MIN_CONFIDENT_LISTINGS}`
            : "ATS extractor did not find confident enumeration evidence",
        };
      }

      return {
        jobs,
        completed,
        listings_scanned,
        pages_visited,
      };
    } finally {
      stage = "browser_close";
      await browser.close();
    }
  } catch (error) {
    const serialized = serializeErrorForTrace(error);
    diagnostics?.onPlaywrightStageFailed?.({
      stage: stage ?? "unknown",
      url,
      ...serialized,
      listings_scanned,
      pages_visited,
      duration_ms: Date.now() - startMs,
    });
    return {
      jobs: [],
      completed: false,
      listings_scanned: 0,
      pages_visited: 0,
      failure_code: "PLAYWRIGHT_FAILED",
      failure_reason: "playwright extraction failed or timed out",
    };
  }
}

async function extractJobsHttp(
  url: string,
  extractor_used: string
): Promise<ExtractJobsResult> {
  const startMs = Date.now();

  const fetchResult = await fetchHtml(url);

  if (Date.now() - startMs >= MAX_TIME_PER_COMPANY_MS) {
    return {
      jobs: [],
      completed: false,
      listings_scanned: 0,
      pages_visited: 1,
      failure_code: "CAP_REACHED",
      failure_reason: "extraction limit reached",
    };
  }

  // Step 8.2: HTTP 403 / 429 → BLOCKED immediately.
  if (fetchResult.kind === "blocked") {
    return {
      jobs: [],
      completed: false,
      listings_scanned: 0,
      pages_visited: 1,
      failure_code: "BLOCKED",
      failure_reason: "request blocked or captcha encountered",
    };
  }

  if (fetchResult.kind === "error") {
    return {
      jobs: [],
      completed: false,
      listings_scanned: 0,
      pages_visited: 0,
      failure_code: "FETCH_FAILED",
      failure_reason: "failed to fetch careers page for extraction",
    };
  }

  const html = fetchResult.html;

  // Step 8.2: content-level blocking signals (CAPTCHA, access denied, auth walls).
  if (isBlockedHtml(html)) {
    return {
      jobs: [],
      completed: false,
      listings_scanned: 0,
      pages_visited: 1,
      failure_code: "BLOCKED",
      failure_reason: "request blocked or captcha encountered",
    };
  }

  const jobs = parseJobsFromHtml(html, url);
  const listings_scanned = jobs.length;
  const pages_visited = 1;

  if (
    pages_visited >= MAX_PAGES_PER_COMPANY ||
    listings_scanned >= MAX_LISTINGS_PER_COMPANY ||
    Date.now() - startMs >= MAX_TIME_PER_COMPANY_MS
  ) {
    return {
      jobs,
      completed: false,
      listings_scanned,
      pages_visited,
      failure_code: "CAP_REACHED",
      failure_reason: "extraction limit reached",
    };
  }

  if (jobs.length === 0 && extractor_used === EXTRACTOR_USED.GENERIC_HTTP) {
    return {
      jobs: [],
      completed: false,
      listings_scanned: 0,
      pages_visited: 1,
      failure_code: "NO_LISTINGS_PARSED",
      failure_reason: "could not enumerate job listings from HTML",
    };
  }

  if (jobs.length === 0 && isNamedAtsExtractor(extractor_used)) {
    return {
      jobs: [],
      completed: false,
      listings_scanned: 0,
      pages_visited: 1,
      failure_code: "HTTP_NO_LISTINGS",
      failure_reason: "no job listings retrieved via HTTP extractor",
    };
  }

  const completed = isConfidentListingsSurface(html, url, jobs, extractor_used);

  if (!completed && jobs.length > 0) {
    const isGeneric = !completionUsesAtsThresholds(extractor_used, url);
    return {
      jobs,
      completed: false,
      listings_scanned,
      pages_visited,
      failure_code: isGeneric ? "INSUFFICIENT_LISTINGS" : "NOT_CONFIDENT_SURFACE",
      failure_reason: isGeneric
        ? `parsed ${jobs.length} listings, below minimum threshold of ${MIN_CONFIDENT_LISTINGS}`
        : "ATS extractor did not find confident enumeration evidence",
    };
  }

  return {
    jobs,
    completed,
    listings_scanned,
    pages_visited,
  };
}

export async function extractJobs(
  url: string,
  _platform: AtsType,
  extractor_used: string,
  diagnostics?: ExtractionDiagnostics
): Promise<ExtractJobsResult> {
  if (extractor_used === EXTRACTOR_USED.PLAYWRIGHT) {
    return extractJobsWithPlaywright(url, diagnostics);
  }
  return extractJobsHttp(url, extractor_used);
}

export function initialExtractorForAts(ats: AtsType): ExtractorUsedName {
  switch (ats) {
    case Ats.GREENHOUSE:
      return EXTRACTOR_USED.GREENHOUSE;
    case Ats.LEVER:
      return EXTRACTOR_USED.LEVER;
    case Ats.ASHBY:
      return EXTRACTOR_USED.ASHBY;
    case Ats.SMARTRECRUITERS:
      return EXTRACTOR_USED.SMARTRECRUITERS;
    case Ats.UNKNOWN:
    default:
      return EXTRACTOR_USED.GENERIC_HTTP;
  }
}
