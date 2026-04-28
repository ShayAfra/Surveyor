/**
 * Discovery (roadmap Step 6.2, hardened per Phase D1–D2).
 *
 * Pure helpers: no I/O, no DB, no trace (deterministic string/URL logic only).
 * discoverCareersUrl: persistence-free (no DB/trace); uses HTTP + search adapter only.
 */

import { searchCareersCandidates } from "./search.js";
import type {
  CandidateSourceType,
  DiscoveryCandidate,
  HostType,
  ListingsStrength,
  PageKind,
  ResolutionPathDetail,
  ResolvedJobSurface,
  VerifiedCandidate,
} from "./discoveryTypes.js";

const REQUEST_TIMEOUT_MS = 5000;

const ATS_HOST_SUFFIXES = [
  "greenhouse.io",
  "lever.co",
  "ashbyhq.com",
  "smartrecruiters.com",
] as const;

// Career-intent text signals used to identify relevant anchor links.
const CAREER_ANCHOR_SIGNALS = [
  "careers",
  "jobs",
  "job openings",
  "open roles",
  "join us",
  "work with us",
  "opportunities",
  "hiring",
] as const;

// ---------------------------------------------------------------------------
// D2.1 – verification signal tables
// ---------------------------------------------------------------------------

/**
 * Phrases that strongly indicate an active job listings surface
 * (the user is expected to search / apply HERE).
 */
const LISTING_PHRASES = [
  "search jobs",
  "open positions",
  "job openings",
  "apply now",
] as const;

/**
 * Phrases that strongly indicate a careers landing page CTA
 * (the user is directed TO jobs from here).
 */
const CAREERS_CTA_PHRASES = [
  "view openings",
  "see all jobs",
  "open roles",
  "explore roles",
  "join our team",
  "explore opportunities",
  "see open positions",
  "view jobs",
  "see open roles",
] as const;

/**
 * Phrases used to identify a page as careers-focused in its title or headings.
 */
const CAREERS_IDENTITY_SIGNALS = [
  "careers",
  "jobs",
  "hiring",
  "join us",
  "work with us",
  "we're hiring",
  "open roles",
  "job opportunities",
] as const;

// --- Pure helpers (no DB, no trace, no network) ---

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function isAtsHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^www\./, "");
  return ATS_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

/**
 * Tight allowlist for ATS URLs found only inside inline &lt;script&gt; bodies.
 * Script `src=`, iframes, and anchor hrefs are still handled by their own paths
 * and must not be filtered through this function.
 *
 * Rejects API endpoints, marketing roots, CDNs, and other generic same-suffix
 * literals; accepts obvious public job-board or embed paths on the canonical
 * board hostnames.
 */
function isAtsListingsOrEmbedShapedForInlineScript(candidate: string): boolean {
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (!isAtsHost(u.hostname)) return false;

  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname;
  const pathLower = path.toLowerCase();

  if (pathLower.startsWith("/api/")) return false;

  if (/\.(css|map|json|ico|png|jpe?g|gif|svg|woff2?|eot|ttf)(\?|$)/i.test(path + (u.search || ""))) {
    return false;
  }

  if (host === "boards.greenhouse.io") {
    if (path === "" || path === "/") return false;
    if (pathLower.startsWith("/embed") || pathLower.includes("job_board")) {
      return true;
    }
    const segs = path.split("/").filter(Boolean);
    return (
      segs.length >= 1 &&
      segs[0] !== "api" &&
      segs[0] !== "static" &&
      segs[0] !== "cdn"
    );
  }

  if (host === "jobs.lever.co") {
    const segs = path.split("/").filter(Boolean);
    return segs.length >= 1 && segs[0] !== "api" && segs[0] !== "static";
  }

  if (host === "jobs.ashbyhq.com") {
    const segs = path.split("/").filter(Boolean);
    return segs.length >= 1;
  }

  if (host === "jobs.smartrecruiters.com") {
    if (pathLower.startsWith("/api/")) return false;
    const segs = path.split("/").filter(Boolean);
    return segs.length >= 1;
  }

  return false;
}

function resolveHostType(urlStr: string, officialDomain: string): HostType {
  try {
    const h = new URL(urlStr).hostname.toLowerCase().replace(/^www\./, "");
    if (h === officialDomain || h.endsWith(`.${officialDomain}`)) {
      return "OFFICIAL_DOMAIN";
    }
    if (isAtsHost(h)) {
      return "SUPPORTED_ATS";
    }
  } catch {
    /* invalid URL */
  }
  return "OTHER";
}

function normalizeHref(raw: string, baseUrl: string): string | null {
  try {
    const decoded = decodeHtmlEntities(raw.trim());
    if (
      !decoded ||
      decoded.startsWith("javascript:") ||
      decoded.startsWith("#") ||
      decoded.startsWith("mailto:") ||
      decoded.startsWith("tel:")
    ) {
      return null;
    }
    return new URL(decoded, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Return true when the anchor text or href path contains a career-intent signal.
 */
function hasCareerSignal(text: string, href: string): boolean {
  const combined = (text + " " + href).toLowerCase();
  return CAREER_ANCHOR_SIGNALS.some((signal) => combined.includes(signal));
}

/**
 * Extract anchor tags from raw HTML, returning href and stripped inner text.
 * Handles both double- and single-quoted href attributes.
 */
function extractAnchors(
  html: string
): Array<{ href: string; text: string }> {
  const results: Array<{ href: string; text: string }> = [];
  const tagRe = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  const hrefDqRe = /\bhref="([^"]*)"/i;
  const hrefSqRe = /\bhref='([^']*)'/i;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const fullMatch = m[0]!;
    const hrefMatch = hrefDqRe.exec(fullMatch) ?? hrefSqRe.exec(fullMatch);
    if (!hrefMatch) continue;
    const href = hrefMatch[1] ?? "";
    // Strip inner tags to get visible text
    const text = fullMatch
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    results.push({ href, text });
  }
  return results;
}

/**
 * Extract iframe src attributes from HTML, returning the raw src string.
 */
function extractIframeSrcs(html: string): string[] {
  const srcs: string[] = [];
  const re = /<iframe\b[^>]*>/gi;
  const srcDqRe = /\bsrc="([^"]*)"/i;
  const srcSqRe = /\bsrc='([^']*)'/i;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0]!;
    const srcMatch = srcDqRe.exec(tag) ?? srcSqRe.exec(tag);
    if (srcMatch) srcs.push(srcMatch[1] ?? "");
  }
  return srcs;
}

/**
 * Extract script src attributes and inline ATS URLs from script tags.
 * Returns raw src strings and any ATS-host URLs found inside inline script bodies.
 */
function extractScriptAtsUrls(html: string): string[] {
  const results: string[] = [];
  // Script src attributes
  const scriptTagRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  const srcDqRe = /\bsrc="([^"]*)"/i;
  const srcSqRe = /\bsrc='([^']*)'/i;
  let m: RegExpExecArray | null;
  while ((m = scriptTagRe.exec(html)) !== null) {
    const attrs = m[1] ?? "";
    const body = m[2] ?? "";
    const srcMatch = srcDqRe.exec(attrs) ?? srcSqRe.exec(attrs);
    if (srcMatch) results.push(srcMatch[1] ?? "");
    // Scan inline script body for absolute URLs referencing ATS hosts
    const urlRe = /https?:\/\/[^\s"'<>]+/gi;
    let um: RegExpExecArray | null;
    while ((um = urlRe.exec(body)) !== null) {
      const candidate = um[0]!;
      if (isAtsListingsOrEmbedShapedForInlineScript(candidate)) {
        results.push(candidate);
      }
    }
  }
  return results;
}

/**
 * Parse homepage HTML and return an ordered, deduplicated list of DiscoveryCandidate objects.
 *
 * Ordering (per Step D1.2):
 *   1. ATS links from homepage anchor tags          (source_type: 'ATS_LINK')
 *   2. Explicit careers/jobs anchor links           (source_type: 'HOMEPAGE_LINK')
 *   3. Embedded ATS iframe or script sources        (source_type: 'EMBEDDED_ATS')
 *
 * Only URLs on the official domain or a supported ATS domain are included (allowed: true).
 * Deduplication is by normalized URL string.
 */
export function extractCandidatesFromHomepage(
  html: string,
  homepageUrl: string,
  officialDomain: string
): DiscoveryCandidate[] {
  const atsCandidates: DiscoveryCandidate[] = [];
  const careerCandidates: DiscoveryCandidate[] = [];
  const embeddedCandidates: DiscoveryCandidate[] = [];
  const seen = new Set<string>();

  function addCandidate(
    url: string,
    source_type: CandidateSourceType,
    bucket: DiscoveryCandidate[]
  ): void {
    if (seen.has(url)) return;
    const host_type = resolveHostType(url, officialDomain);
    // Only include URLs from the official domain or a supported ATS.
    if (host_type === "OTHER") return;
    seen.add(url);
    bucket.push({
      url,
      source_type,
      source_url: homepageUrl,
      allowed: true,
      host_type,
    });
  }

  // --- 1. Anchor tags: ATS links first, then career-signal links ---
  for (const { href, text } of extractAnchors(html)) {
    const normalized = normalizeHref(href, homepageUrl);
    if (!normalized) continue;
    try {
      const h = new URL(normalized).hostname.toLowerCase().replace(/^www\./, "");
      if (isAtsHost(h)) {
        addCandidate(normalized, "ATS_LINK", atsCandidates);
      } else if (hasCareerSignal(text, href)) {
        addCandidate(normalized, "HOMEPAGE_LINK", careerCandidates);
      }
    } catch {
      /* skip invalid URLs */
    }
  }

  // --- 2. Iframes pointing to supported ATS hosts ---
  for (const src of extractIframeSrcs(html)) {
    const normalized = normalizeHref(src, homepageUrl);
    if (!normalized) continue;
    try {
      const h = new URL(normalized).hostname.toLowerCase().replace(/^www\./, "");
      if (isAtsHost(h)) {
        addCandidate(normalized, "EMBEDDED_ATS", embeddedCandidates);
      }
    } catch {
      /* skip */
    }
  }

  // --- 3. Script src attributes and inline ATS URLs ---
  for (const raw of extractScriptAtsUrls(html)) {
    const normalized = normalizeHref(raw, homepageUrl);
    if (!normalized) continue;
    try {
      const h = new URL(normalized).hostname.toLowerCase().replace(/^www\./, "");
      if (isAtsHost(h)) {
        addCandidate(normalized, "EMBEDDED_ATS", embeddedCandidates);
      }
    } catch {
      /* skip */
    }
  }

  return [...atsCandidates, ...careerCandidates, ...embeddedCandidates];
}

function domainGuess(companyName: string): string {
  const t = companyName.trim().toLowerCase();
  if (!t) {
    return "invalid.invalid";
  }
  try {
    if (t.includes(".")) {
      const withProto =
        t.startsWith("http://") || t.startsWith("https://") ? t : `https://${t}`;
      const h = new URL(withProto).hostname.replace(/^www\./, "");
      if (h) {
        return h;
      }
    }
  } catch {
    /* fall through */
  }
  const slug =
    t
      .replace(/[^a-z0-9-]+/g, "")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "company";
  return `${slug}.com`;
}

function buildGuessUrls(domain: string): string[] {
  const bases = [`https://${domain}`, `https://www.${domain}`];
  // D1.3: Deterministic, limited path list. Guesses are lower priority than
  // homepage-derived candidates and must never be auto-accepted on their own.
  const paths = [
    "/careers",
    "/jobs",
    "/careers/jobs",
    "/jobs/careers",
    "/careers-home",
    "/join-us",
    "/work-with-us",
    "/company/careers",
  ];
  const out: string[] = [];
  for (const b of bases) {
    for (const p of paths) {
      out.push(`${b}${p}`);
    }
  }
  return out;
}

/**
 * Fetch the official homepage for a domain.
 * Tries https://{domain} then https://www.{domain}.
 * Follows redirects and returns the final resolved URL and HTML body.
 * Returns null if neither variant is reachable or returns HTML.
 */
async function fetchHomepageHtml(
  domain: string,
  timeoutMs: number
): Promise<{ html: string; finalUrl: string } | null> {
  const urls = [`https://${domain}`, `https://www.${domain}`];
  for (const url of urls) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
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
      if (!res.ok) continue;
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("text/html") && !ct.includes("application/xhtml")) continue;
      const html = await res.text();
      const finalUrl = res.url || url;
      return { html, finalUrl };
    } catch {
      // timeout or network error – try next variant
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * D2.1: Fetch a single candidate URL, following redirects.
 *
 * Returns the response body as HTML text and the final resolved URL,
 * or null if the request failed, timed out, or did not return an HTML document.
 * A successful response here is necessary but NOT sufficient for acceptance —
 * the caller must still run verifyCareersCandidate on the returned HTML.
 */
async function fetchCandidateHtml(
  url: string,
  timeoutMs: number
): Promise<{ html: string; finalUrl: string } | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
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
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("text/html") && !ct.includes("application/xhtml")) return null;
    const html = await res.text();
    const finalUrl = res.url || url;
    return { html, finalUrl };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// D2.1 – deterministic candidate verification
// ---------------------------------------------------------------------------

/**
 * Scoring thresholds for classification.
 *
 * Listings surface:  listingScore >= LISTING_THRESHOLD  (takes priority)
 * Careers landing:   careersScore >= CAREERS_THRESHOLD   (checked only if listing threshold not met)
 * Reject:            neither threshold met
 */
const LISTING_THRESHOLD = 3;
const CAREERS_THRESHOLD = 2;

/**
 * D2.1: Deterministic, explainable verification of a fetched careers page candidate.
 *
 * Classifies the page into one of three outcomes:
 *   - { page_kind: 'LISTINGS_SURFACE' }  — verified active job listings page
 *   - { page_kind: 'CAREERS_LANDING' }   — verified careers entry point linking to listings
 *   - null                               — rejected (insufficient evidence)
 *
 * Rules:
 *   - 2xx HTML is necessary but NOT sufficient.
 *   - A candidate must not be accepted merely because it is on the official domain.
 *   - Classification is based purely on deterministic signal scoring.
 *   - LISTINGS_SURFACE classification takes priority over CAREERS_LANDING when both
 *     score at or above threshold.
 *
 * @param url      - The original requested URL (before any redirects).
 * @param html     - The full HTML body of the fetched page.
 * @param finalUrl - The actual URL after following all redirects.
 */
export function verifyCareersCandidate(
  url: string,
  html: string,
  finalUrl: string
): { page_kind: PageKind; verification_reasons: string[] } | null {
  // Suppress unused-variable warning; url is accepted for API symmetry / future use.
  void url;

  const bodyLower = html.toLowerCase();
  const listingReasons: string[] = [];
  const careersReasons: string[] = [];
  let listingScore = 0;
  let careersScore = 0;

  // -------------------------------------------------------------------------
  // Listings surface signals
  // -------------------------------------------------------------------------

  // Signal L1: final URL is on a supported ATS host.
  // ATS hosts are purpose-built job listing surfaces — the strongest possible signal.
  let finalHostIsAts = false;
  try {
    const h = new URL(finalUrl).hostname.toLowerCase().replace(/^www\./, "");
    if (isAtsHost(h)) {
      listingScore += 4;
      listingReasons.push("final URL is on a supported ATS host");
      finalHostIsAts = true;
    }
  } catch {
    /* skip invalid URL */
  }

  // Signal L2 (ATS embed markers) has been removed from listing scoring per
  // misclassificationRoadmap Step C2.1.  These markers indicate "jobs exist
  // somewhere behind this page via an ATS", which is evidence of a CAREERS_LANDING
  // entry point, not of directly enumerable server-rendered listings.
  // See Signal C7 below where the same markers are scored as careers evidence.

  // Signal L3: multiple likely job-detail links.
  // Job detail pages share recognizable URL path patterns across ATS and custom systems.
  // Deduplication prevents inflated counts from repeated nav links.
  const jobDetailLinkRe =
    /href=["'][^"']*\/(jobs?|apply|postings?|positions?|openings?|job-detail|job-apply|careers\/[^"'/]+)\/[^"']+["']/gi;
  const jobDetailMatches = html.match(jobDetailLinkRe) ?? [];
  const uniqueJobLinks = new Set(jobDetailMatches.map((m) => m.toLowerCase())).size;
  if (uniqueJobLinks >= 5) {
    listingScore += 3;
    listingReasons.push(`page contains ${uniqueJobLinks} unique job detail links`);
  } else if (uniqueJobLinks >= 3) {
    listingScore += 2;
    listingReasons.push(`page contains ${uniqueJobLinks} unique job detail links`);
  } else if (uniqueJobLinks >= 1) {
    listingScore += 1;
    listingReasons.push(`page contains ${uniqueJobLinks} job detail link(s)`);
  }

  // Signal L4: job card / listing container HTML patterns.
  // These class names and data attributes are used by ATS widgets and custom
  // job board implementations to mark individual job listing rows or cards.
  const jobCardPatterns: RegExp[] = [
    /class="[^"]*\bposting\b[^"]*"/i,
    /class="[^"]*\bjob-card\b[^"]*"/i,
    /class="[^"]*\bjob-listing\b[^"]*"/i,
    /class="[^"]*\bjob-opening\b[^"]*"/i,
    /class="[^"]*\bopening-row\b[^"]*"/i,
    /\bdata-job-id\s*=/i,
    /\bdata-lever-job\b/i,
    /\bdata-greenhouse-job\b/i,
    /\bdata-ashby-job-posting\b/i,
  ];
  const jobCardHits = jobCardPatterns.filter((p) => p.test(html)).length;
  if (jobCardHits >= 2) {
    listingScore += 2;
    listingReasons.push("page contains job card or listing container HTML patterns");
  } else if (jobCardHits === 1) {
    listingScore += 1;
    listingReasons.push("page contains a job card HTML pattern");
  }

  // Signal L5: strong listing action language.
  // These phrases appear on pages where listings are actively searched or applied to.
  const listingLangHits = LISTING_PHRASES.filter((phrase) =>
    bodyLower.includes(phrase)
  );
  if (listingLangHits.length >= 2) {
    listingScore += 2;
    listingReasons.push(
      `page contains strong listing language: ${listingLangHits.join(", ")}`
    );
  } else if (listingLangHits.length === 1) {
    listingScore += 1;
    listingReasons.push(`page contains listing language: ${listingLangHits[0]}`);
  }

  // -------------------------------------------------------------------------
  // Careers landing page signals
  // -------------------------------------------------------------------------

  // Signal C1: page title identifies the page as a careers surface.
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const titleText = titleMatch
    ? (titleMatch[1] ?? "").replace(/<[^>]+>/g, " ").toLowerCase()
    : "";
  if (CAREERS_IDENTITY_SIGNALS.some((s) => titleText.includes(s))) {
    careersScore += 2;
    careersReasons.push("page title signals careers intent");
  }

  // Signal C2: h1 or h2 heading identifies the page as a careers surface.
  const headingRe = /<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi;
  let headingMatch: RegExpExecArray | null;
  let headingCareerFound = false;
  while ((headingMatch = headingRe.exec(html)) !== null) {
    const text = (headingMatch[1] ?? "").replace(/<[^>]+>/g, " ").toLowerCase();
    if (CAREERS_IDENTITY_SIGNALS.some((s) => text.includes(s))) {
      headingCareerFound = true;
      break;
    }
  }
  if (headingCareerFound) {
    careersScore += 2;
    careersReasons.push("page heading signals careers intent");
  }

  // Signal C3: final URL path matches a common careers landing page pattern.
  // A simple /careers or /jobs path without a further segment is typical of
  // a landing page, not a detailed listings surface.
  try {
    const path = new URL(finalUrl).pathname.toLowerCase().replace(/\/$/, "");
    const careersLandingPaths = [
      "/careers",
      "/jobs",
      "/join-us",
      "/work-with-us",
      "/careers-home",
      "/join",
      "/hiring",
      "/company/careers",
    ];
    if (careersLandingPaths.includes(path)) {
      careersScore += 1;
      careersReasons.push("URL path matches a common careers landing pattern");
    }
  } catch {
    /* skip invalid URL */
  }

  // Signal C4: page contains outbound links TO ATS domains.
  // This indicates the careers content lives on the ATS, not on this page directly.
  const outboundAtsRe =
    /href=["'][^"']*(?:greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com)[^"']*["']/gi;
  if (outboundAtsRe.test(html)) {
    careersScore += 2;
    careersReasons.push("page contains outbound ATS links");
  }

  // Signal C5: page embeds ATS content via iframe or script src.
  // This means the ATS is rendering within this page, making this the
  // effective landing point (and potentially a listings surface too —
  // signals L2 above handle the stronger "board rendering" sub-case).
  const atsEmbedRe =
    /(?:src|data-src)=["'][^"']*(?:greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com)/i;
  if (atsEmbedRe.test(html)) {
    careersScore += 2;
    careersReasons.push("page contains an ATS iframe or script embed");
  }

  // Signal C6: careers-specific CTA language pointing the user to listings.
  const ctaHits = CAREERS_CTA_PHRASES.filter((phrase) => bodyLower.includes(phrase));
  if (ctaHits.length >= 1) {
    careersScore += 1;
    careersReasons.push(
      `page contains careers CTA language: ${ctaHits.slice(0, 3).join(", ")}`
    );
  }

  // Signal C7: ATS embed DOM container markers present on the page.
  //
  // These patterns (empty container elements, embed configuration attributes,
  // and ATS-specific class names) indicate the page is configured as an ATS
  // embed landing point.  The ATS renders its job listings into the page via
  // client-side JavaScript, meaning this page is a recruiting entry point —
  // NOT a server-rendered listings surface.
  //
  // Authoritative rule (misclassificationRoadmap Step C2.1):
  //   ATS embed indicators must contribute to CAREERS_LANDING classification,
  //   not to LISTINGS_SURFACE.  This signal is worth +2 (matching the weight
  //   of C4 outbound ATS links and C5 ATS iframe/script src) because it is
  //   equally strong evidence that an ATS is the backend, but equally weak
  //   evidence that listings are directly enumerable from this page.
  const atsContainerProviders: string[] = [];

  if (
    /\bid="grnhse_app"\b/i.test(html) ||
    /\bdata-gh-token\b/i.test(html) ||
    /greenhouse-job-board/i.test(html) ||
    /boards\.greenhouse\.io\/embed/i.test(html)
  ) {
    atsContainerProviders.push("Greenhouse");
  }

  if (
    /\bclass="postings(?:-container)?"/i.test(html) ||
    /lever-job-postings/i.test(html) ||
    /jobs\.lever\.co\/[^"'/]+\/[a-f0-9-]{36}/i.test(html)
  ) {
    atsContainerProviders.push("Lever");
  }

  if (
    /ashby-job-posting/i.test(html) ||
    /\/api\/non-user-facing\/job-board/i.test(html)
  ) {
    atsContainerProviders.push("Ashby");
  }

  if (
    /jobs\.smartrecruiters\.com/i.test(html) ||
    /smartrecruiters-widget/i.test(html)
  ) {
    atsContainerProviders.push("SmartRecruiters");
  }

  if (atsContainerProviders.length > 0) {
    careersScore += 2;
    careersReasons.push(
      `ATS embed container markers present (${atsContainerProviders.join(", ")}) — indicates ATS-rendered job board entry point, not a directly enumerable listings surface`
    );
  }

  // -------------------------------------------------------------------------
  // Classification — listings threshold takes priority
  // -------------------------------------------------------------------------

  // C1.2 / C3.1: Hard-evidence gate — LISTINGS_SURFACE requires at least one
  // strong, direct listing signal.  Score accumulation from weak signals alone
  // must never be sufficient, even when their total meets LISTING_THRESHOLD.
  //
  // Weak signals that are explicitly NOT sufficient on their own (or in
  // combination with each other):
  //   • ATS embed markers       — contribute 0 to listingScore (moved to C7)
  //   • Generic listing phrases — L5, up to +2
  //   • 1-2 job-detail links    — L3 weak, up to +2
  //   • 1 job card pattern      — L4 weak, +1
  //
  // "Hard" evidence: at least one of the following MUST be true:
  //   • finalHostIsAts        — the resolved URL IS an ATS host; the page
  //                             IS the listing surface by definition (L1)
  //   • uniqueJobLinks >= 3   — multiple extractable job-detail link URLs
  //                             matching known path patterns (L3 strong)
  //   • jobCardHits >= 2      — multiple server-rendered job-card / listing-
  //                             container HTML patterns (L4 strong)
  //
  // This boolean gate (C3.1's "hasExtractableListings" safeguard) ensures that
  // any combination of weak signals — e.g. ATS embed marker + listing phrase +
  // 1-2 job links — is blocked regardless of its combined numeric score.
  const hasExtractableListings =
    finalHostIsAts || uniqueJobLinks >= 3 || jobCardHits >= 2;

  if (listingScore >= LISTING_THRESHOLD && hasExtractableListings) {
    return { page_kind: "LISTINGS_SURFACE", verification_reasons: listingReasons };
  }
  if (careersScore >= CAREERS_THRESHOLD) {
    return { page_kind: "CAREERS_LANDING", verification_reasons: careersReasons };
  }

  // Neither threshold met — reject this candidate.
  return null;
}

// ---------------------------------------------------------------------------
// D2.2 – candidate ranking
// ---------------------------------------------------------------------------

/**
 * D2.2: Assign a deterministic numeric rank to a verified candidate.
 *
 * Priority order (lower number = stronger evidence = preferred):
 *
 *   1 — verified supported ATS listings surface
 *         ATS hosts are purpose-built for job listings and the page itself
 *         enumerates job postings. Highest possible confidence.
 *
 *   2 — verified official domain listings surface
 *         Company's own domain confirmed to enumerate listings directly.
 *         Strong signal, but limited to the official domain.
 *
 *   3 — verified official domain careers landing page
 *         Official domain with clear careers intent and CTA or ATS resolution
 *         path. Requires further resolution (D3) to reach actual listings.
 *
 *   4 — verified supported ATS careers landing page
 *         ATS host confirmed as careers-focused but not confirmed to enumerate
 *         listings on its own. Weakest accepted tier.
 *
 * Rationale for rank 4 (ATS landing) being below rank 3 (official landing):
 *   An official domain careers landing page with strong CTA signals is more
 *   likely to be the canonical entry point than an ATS landing page reached
 *   without homepage derivation (e.g. a search result pointing to a generic
 *   ATS root, not the company-specific board).
 *
 * host_type "OTHER" is filtered out by the allowlist before this function is
 * called; it should never appear in accepted candidates. Rank 5 is a safe
 * fallback and will never be selected over ranks 1–4.
 */
function rankVerifiedCandidate(hostType: HostType, pageKind: PageKind): number {
  if (hostType === "SUPPORTED_ATS" && pageKind === "LISTINGS_SURFACE") return 1;
  if (hostType === "OFFICIAL_DOMAIN" && pageKind === "LISTINGS_SURFACE") return 2;
  if (hostType === "OFFICIAL_DOMAIN" && pageKind === "CAREERS_LANDING") return 3;
  if (hostType === "SUPPORTED_ATS" && pageKind === "CAREERS_LANDING") return 4;
  // Should not be reachable for allowed candidates.
  return 5;
}

/**
 * D2.2: Return the best rank achievable for a URL given its host classification,
 * without fetching the page.
 *
 * Used to skip fetching candidates that cannot improve on the current best:
 *   SUPPORTED_ATS   → best possible rank 1 (could be a listings surface)
 *   OFFICIAL_DOMAIN → best possible rank 2 (could be a listings surface)
 *   OTHER           → not allowed; rank 5 (never accepted)
 *
 * If bestPossibleRank(hostType) >= currentBestRank, fetching cannot help.
 */
function bestPossibleRank(hostType: HostType): number {
  if (hostType === "SUPPORTED_ATS") return 1;
  if (hostType === "OFFICIAL_DOMAIN") return 2;
  return 5;
}

// D4.1: Authoritative return shape for the pure discovery helper.
// Includes the fully resolved listings surface (when available), surface kind,
// resolution method, and the verification reasons that justified acceptance.
// All discovery-stage and resolution-stage attempted URLs are merged into a
// single attempted_urls array for traceability.
//
// D6.1: failure_code is populated when careers_url is null, distinguishing:
//   CAREERS_NOT_FOUND       — no candidate URL ever returned HTML
//   CAREERS_PAGE_UNVERIFIED — at least one candidate returned HTML but none
//                             passed deterministic verification
type DiscoverCareersUrlResult = {
  careers_url: string | null;
  listings_url: string | null;
  attempted_urls: string[];
  selected_source_type: "OFFICIAL_DOMAIN" | "SUPPORTED_ATS" | null;
  page_kind: "LISTINGS_SURFACE" | "CAREERS_LANDING" | null;
  // R4.1: outcomes mirror ResolutionMethod in discoveryTypes.ts.
  resolution_method:
    | "DIRECT_VERIFIED"
    | "ATS_RESOLVED"
    | "CTA_RESOLVED"
    | "PLAYWRIGHT_REQUIRED"
    | "UNRESOLVED"
    | "INDIRECT"
    | null;
  verification_reasons: string[];
  /** D6.1: Internal failure detail when careers_url is null; null on success. */
  failure_code: string | null;
  /**
   * R6.1: Structured resolution path detail forwarded from resolveListingsSurface.
   * null when discovery failed before any resolution was attempted (careers_url is null).
   */
  resolution_path_detail: ResolutionPathDetail | null;
};

/**
 * Resolve careers URL using deterministic ordering, HTTP checks, and ranking,
 * then resolve the actual job listings surface via resolveListingsSurface.
 * No database access and no trace writes (orchestrator owns persistence).
 *
 * D2.1: Every candidate must pass verifyCareersCandidate before being
 * accepted. A 2xx HTML response alone is no longer sufficient.
 *
 * D2.2: Instead of returning on the first verified candidate (which causes
 * "Reddit-style" bugs where a weak official-domain page beats a stronger ATS
 * listing just because it appeared earlier in discovery order), we now:
 *   1. Try all candidates from all source groups.
 *   2. Rank each verified candidate with rankVerifiedCandidate.
 *   3. Select the highest-ranked (lowest rank number) accepted candidate.
 *
 * D4.1: After selecting the best verified candidate, call resolveListingsSurface
 * to determine whether the candidate is already a listings surface or requires
 * a resolution step. The returned shape models the full discovery truth:
 *   - careers_url  — verified careers entry point
 *   - listings_url — resolved listings surface (may differ from careers_url)
 *   - page_kind    — LISTINGS_SURFACE or CAREERS_LANDING
 *   - resolution_method — how the listings surface was (or was not) reached
 *   - verification_reasons — signals that justified acceptance
 *
 * Source group order is preserved (homepage → guesses → search) and provides
 * a tie-breaker when two candidates share the same rank: the earlier-discovered
 * candidate wins.
 *
 * Early-exit: rank-1 (ATS listings surface) is the globally best possible
 * result. Once found, remaining candidates are skipped unconditionally.
 *
 * Per-candidate skip: bestPossibleRank(hostType) >= currentBestRank means the
 * candidate's host class cannot produce a rank that improves on what we already
 * have, so the HTTP fetch is skipped (the URL is still recorded in
 * attempted_urls for traceability).
 */
export async function discoverCareersUrl(
  companyName: string
): Promise<DiscoverCareersUrlResult> {
  const attempted_urls: string[] = [];
  const domain = domainGuess(companyName);

  // D2.2: Track the single best verified candidate seen so far.
  // currentBestRank starts at 6 (sentinel: no accepted candidate yet).
  // D4.1: Also track the full VerifiedCandidate and its HTML so
  // resolveListingsSurface can be called after the discovery loops finish.
  let currentBestRank = 6;
  let bestVerifiedCandidate: VerifiedCandidate | null = null;
  let bestHtml: string | null = null;
  // D6.1: true when any candidate returned HTML (fetch succeeded) even if
  // verifyCareersCandidate later rejected it.  Used to emit
  // CAREERS_PAGE_UNVERIFIED instead of the coarser CAREERS_NOT_FOUND.
  let anyFetchSucceeded = false;

  /**
   * Attempt one candidate URL.
   *
   * Always records the URL in attempted_urls. Skips the HTTP fetch when the
   * candidate's host class cannot improve on currentBestRank (bestPossibleRank
   * optimization). Updates the best candidate state if the verified result
   * outranks the current best.
   *
   * sourceType is forwarded into the VerifiedCandidate for resolver use.
   */
  async function tryCandidateUrl(
    url: string,
    hostType: HostType,
    sourceType: CandidateSourceType = "URL_GUESS"
  ): Promise<void> {
    attempted_urls.push(url);
    // Not on the allowlist — skip immediately.
    if (hostType === "OTHER") return;
    // This host class cannot beat the current best rank even in the best case.
    if (bestPossibleRank(hostType) >= currentBestRank) return;
    const fetched = await fetchCandidateHtml(url, REQUEST_TIMEOUT_MS);
    if (!fetched) return;
    // D6.1: mark that at least one candidate returned HTML, even if
    // verifyCareersCandidate rejects it below.
    anyFetchSucceeded = true;
    const verification = verifyCareersCandidate(url, fetched.html, fetched.finalUrl);
    if (!verification) return;
    const finalHostType = resolveHostType(fetched.finalUrl, domain);
    const rank = rankVerifiedCandidate(finalHostType, verification.page_kind);
    if (rank < currentBestRank) {
      currentBestRank = rank;
      // D4.1: Capture the full VerifiedCandidate shape so the resolver has
      // everything it needs without re-fetching the page.
      bestVerifiedCandidate = {
        url: fetched.finalUrl,
        source_type: sourceType,
        host_type: finalHostType,
        page_kind: verification.page_kind,
        verification_reasons: verification.verification_reasons,
      };
      bestHtml = fetched.html;
    }
  }

  // D1.1: Fetch the official homepage before falling back to path guesses.
  // D1.2: Parse homepage HTML to generate ordered DiscoveryCandidate objects.
  // If the homepage is unreachable, discovery continues with path guesses and search.
  const homepageResult = await fetchHomepageHtml(domain, REQUEST_TIMEOUT_MS);
  const homepageCandidates: DiscoveryCandidate[] = homepageResult
    ? extractCandidatesFromHomepage(
        homepageResult.html,
        homepageResult.finalUrl,
        domain
      )
    : [];

  // D1.3 / D2.1 / D2.2: Homepage-derived candidates are tried first.
  // Verified candidates are ranked; we continue past each verified result unless
  // rank-1 (the global best) is already found.
  for (const candidate of homepageCandidates) {
    await tryCandidateUrl(candidate.url, candidate.host_type, candidate.source_type);
    if (currentBestRank === 1) break;
  }

  // D1.3 / D2.1 / D2.2: URL guesses come only after homepage-derived candidates.
  // All URL guesses are on the official domain (max achievable rank: 2).
  // The inner bestPossibleRank check skips fetches when rank-2 is already held;
  // the outer guard skips the whole loop when rank-1 is already found.
  if (currentBestRank > 1) {
    for (const u of buildGuessUrls(domain)) {
      // source_type defaults to 'URL_GUESS' for deterministic path guesses.
      await tryCandidateUrl(u, resolveHostType(u, domain));
      if (currentBestRank === 1) break;
    }
  }

  // D1.4 / D2.1 / D2.2: Search is fallback-only candidate generation. It runs
  // only when rank-1 has not already been found. Search candidates include ATS
  // URLs (capable of rank-1), so they can outrank a guessed official-domain page
  // even when that guess was already verified as rank-2 or rank-3.
  if (currentBestRank > 1) {
    const searchRawUrls = await searchCareersCandidates(
      `${companyName.trim()} careers jobs`
    );
    const searchCandidates: DiscoveryCandidate[] = searchRawUrls.map(
      (raw): DiscoveryCandidate => {
        const host_type = resolveHostType(raw, domain);
        return {
          url: raw,
          source_type: "SEARCH_RESULT",
          source_url: null,
          allowed: host_type !== "OTHER",
          host_type,
        };
      }
    );
    for (const candidate of searchCandidates) {
      await tryCandidateUrl(candidate.url, candidate.host_type, candidate.source_type);
      if (currentBestRank === 1) break;
    }
  }

  // No verified candidate found across all source groups.
  if (!bestVerifiedCandidate || !bestHtml) {
    return {
      careers_url: null,
      listings_url: null,
      attempted_urls,
      selected_source_type: null,
      page_kind: null,
      resolution_method: null,
      verification_reasons: [],
      // D6.1: distinguish "nothing fetched" from "fetched but rejected by verifier"
      failure_code: anyFetchSucceeded ? "CAREERS_PAGE_UNVERIFIED" : "CAREERS_NOT_FOUND",
      // R6.1: null — discovery failed before any resolution was attempted.
      resolution_path_detail: null,
    };
  }

  // D4.1: A verified candidate was found. Run the listings surface resolver to
  // determine whether it is already a listings surface (DIRECT_VERIFIED) or
  // whether a further resolution step is needed (ATS_RESOLVED, CTA_RESOLVED,
  // PLAYWRIGHT_REQUIRED, or UNRESOLVED).
  // The resolver makes no additional fetches on the fast path (page is already
  // a LISTINGS_SURFACE) and at most RESOLVER_MAX_CANDIDATES fetches otherwise.
  const resolved = await resolveListingsSurface(
    bestVerifiedCandidate,
    bestHtml,
    domain
  );

  return {
    careers_url: resolved.careers_url,
    listings_url: resolved.listings_url,
    // Merge discovery-stage and resolution-stage attempted URLs into one list
    // so the trace has a complete picture of every URL the pipeline touched.
    attempted_urls: [...attempted_urls, ...resolved.attempted_urls],
    selected_source_type: resolved.selected_source_type,
    page_kind: resolved.page_kind,
    resolution_method: resolved.resolution_method,
    verification_reasons: resolved.verification_reasons,
    failure_code: null,
    // R6.1: Forward structured resolution path detail from the resolver so the
    // trace can expose which path was taken (direct, ATS hop, CTA hop, unresolved).
    resolution_path_detail: resolved.resolution_path_detail,
  };
}

// ---------------------------------------------------------------------------
// D3.2 – JS gating detection
// ---------------------------------------------------------------------------

/**
 * Known ATS client-side embed script URL patterns.
 *
 * These exact URL patterns only appear in HTML when the page is configured for
 * the ATS to populate job listings via JavaScript.  They are definitively
 * JS-only rendering indicators and are never present on fully server-rendered
 * ATS boards.  Each entry carries a human-readable name for trace output.
 */
const JS_GATING_ATS_EMBED_SCRIPTS: ReadonlyArray<{
  readonly name: string;
  readonly pattern: RegExp;
}> = [
  {
    // Greenhouse embeds its job board via this script; the <div id="grnhse_app">
    // container is empty in the server response and populated client-side.
    name: "Greenhouse JS embed script (boards.greenhouse.io/embed/job_board/js)",
    pattern: /boards\.greenhouse\.io\/embed\/job_board\/js/i,
  },
  {
    // Ashby's public job board API endpoint used by the JS embed widget.
    name: "Ashby JS job board embed (app.ashbyhq.com/api/non-user-facing/job-board)",
    pattern: /app\.ashbyhq\.com\/api\/non-user-facing\/job-board/i,
  },
  {
    // SmartRecruiters serves its job listing widget via this entry-point script.
    name: "SmartRecruiters widget script (jobs.smartrecruiters.com/index.js)",
    pattern: /jobs\.smartrecruiters\.com\/index\.js/i,
  },
] as const;

/**
 * D3.2: Detect whether a page provides high-confidence evidence that job
 * listings exist but require JavaScript execution to retrieve.
 *
 * Conservative design — speculative signals are deliberately excluded:
 *   - SPA / framework indicators alone are not sufficient.
 *   - Single listing-intent phrases without corroborating ATS evidence are
 *     not sufficient.
 *   - An unknown/generic JS-heavy page is NOT flagged — only pages where
 *     a known ATS client-side rendering pattern is unambiguously present.
 *
 * Signals checked (two independent categories):
 *
 *   JS1 — Known ATS client-side embed script present in the raw HTML.
 *          The specific URL patterns in JS_GATING_ATS_EMBED_SCRIPTS only
 *          appear when the page is configured for client-side ATS rendering.
 *          One hit is sufficient on its own.
 *
 *   JS2 — ATS embed container element present in the DOM but server-rendered
 *          content is absent.  Requires the combination of:
 *            (a) a recognised empty ATS placeholder element, AND
 *            (b) zero job-detail links in the page HTML.
 *          Neither condition alone is sufficient.
 *
 * Returns an array of reason strings (for tracing) when JS gating is detected
 * at high confidence, or null when evidence is insufficient.
 *
 * @param html - The full server-rendered HTML of the candidate page.
 */
export function detectJsGating(html: string): string[] | null {
  const reasons: string[] = [];

  // JS1: Definitively known ATS client-side embed scripts.
  for (const { name, pattern } of JS_GATING_ATS_EMBED_SCRIPTS) {
    if (pattern.test(html)) {
      reasons.push(name);
    }
  }

  // JS2: ATS container placeholder present but no server-rendered job content.
  // Reuse the same job-detail link regex from verifyCareersCandidate (Signal L3)
  // to confirm that no listings were actually rendered in the HTML body.
  const jobDetailLinkRe =
    /href=["'][^"']*\/(jobs?|apply|postings?|positions?|openings?|job-detail|job-apply|careers\/[^"'/]+)\/[^"']+["']/gi;
  const hasJobDetailLinks = jobDetailLinkRe.test(html);

  if (!hasJobDetailLinks) {
    // JS2a: Empty Greenhouse container element.
    // <div id="grnhse_app"></div> (or with only whitespace) is a DOM placeholder
    // that Greenhouse populates entirely through client-side JavaScript.
    if (/<div[^>]+id=["']grnhse_app["'][^>]*>(\s*)<\/div>/i.test(html)) {
      reasons.push(
        "Greenhouse ATS container present with no server-rendered job content"
      );
    }

    // JS2b: ATS embed markers combined with listing-intent language, but no
    // server-rendered job links.  No individual sub-signal is sufficient alone —
    // the combination of (embed marker + listing intent + zero job links) is
    // required to clear the high-confidence bar.
    const hasAtsMarkers =
      /\bdata-gh-token\b/i.test(html) ||
      /greenhouse-job-board/i.test(html) ||
      /\bclass="postings(?:-container)?"/i.test(html) ||
      /lever-job-postings/i.test(html) ||
      /ashby-job-posting/i.test(html) ||
      /smartrecruiters-widget/i.test(html);

    const hasListingIntent =
      /search\s+jobs/i.test(html) ||
      /open\s+positions/i.test(html) ||
      /job\s+openings/i.test(html);

    if (hasAtsMarkers && hasListingIntent) {
      reasons.push(
        "ATS embed markers and listing intent present with no server-rendered job listings"
      );
    }
  }

  return reasons.length > 0 ? reasons : null;
}

// ---------------------------------------------------------------------------
// C1.1 – internal listings strength classification
// ---------------------------------------------------------------------------

/**
 * C1.1: Classify the internal listings strength of a verified candidate page.
 *
 * This is an INTERNAL function used only by resolveListingsSurface.
 * It does NOT change the external PageKind contract.
 *
 * Classification rules:
 *
 *   STRONG_LISTINGS_SURFACE
 *     • The resolved URL is on a supported ATS host — the page IS the native
 *       listing board with no embed indirection (finalHostIsAts).
 *     • OR the page has direct server-rendered listing evidence and NO ATS
 *       embed markers of any kind.
 *
 *   WEAK_LISTINGS_SURFACE
 *     • The page classifies as LISTINGS_SURFACE (meets listing threshold and
 *       has extractable listing evidence) BUT also contains ANY of:
 *         - ATS embed container markers (Greenhouse grnhse_app, Lever postings
 *           container, Ashby, SmartRecruiters widget)
 *         - ATS iframe or script-src embed pointing to a supported ATS host
 *         - JS-gating patterns detected by detectJsGating (script-driven boards)
 *     • Critical rule: ATS embed signals MUST NOT qualify a page as STRONG.
 *
 *   CAREERS_LANDING
 *     • pageKind is CAREERS_LANDING — not a listings surface at all.
 *
 * @param pageKind - External PageKind from verifyCareersCandidate.
 * @param html     - Full server-rendered HTML of the page.
 * @param finalUrl - The resolved URL after following all redirects.
 */
export function classifyListingsStrength(
  pageKind: PageKind,
  html: string,
  finalUrl: string
): ListingsStrength {
  if (pageKind !== "LISTINGS_SURFACE") {
    return "CAREERS_LANDING";
  }

  // Direct ATS host: the resolved URL IS a purpose-built listings board.
  // No embed indirection is possible — return STRONG immediately before
  // any embed checks (ATS boards can contain their own ATS-branded HTML).
  try {
    const h = new URL(finalUrl).hostname.toLowerCase().replace(/^www\./, "");
    if (isAtsHost(h)) {
      return "STRONG_LISTINGS_SURFACE";
    }
  } catch {
    /* skip invalid URL */
  }

  // ATS embed container markers: empty shells that an ATS populates via
  // client-side JavaScript.  These indicate the listings are NOT directly
  // enumerable from the server-rendered HTML, regardless of listing score.
  //
  // Note: id="grnhse_app" uses id=["']…["'] (not \b…\b) because the closing
  // quote is a non-word char, making the trailing \b boundary assertion fail.
  const hasAtsEmbedContainer =
    /id=["']grnhse_app["']/i.test(html) ||
    /\bdata-gh-token\b/i.test(html) ||
    /greenhouse-job-board/i.test(html) ||
    /boards\.greenhouse\.io\/embed/i.test(html) ||
    /class=["']postings(?:-container)?["']/i.test(html) ||
    /lever-job-postings/i.test(html) ||
    /jobs\.lever\.co\/[^"'/]+\/[a-f0-9-]{36}/i.test(html) ||
    /ashby-job-posting/i.test(html) ||
    /\/api\/non-user-facing\/job-board/i.test(html) ||
    /jobs\.smartrecruiters\.com/i.test(html) ||
    /smartrecruiters-widget/i.test(html);

  if (hasAtsEmbedContainer) {
    return "WEAK_LISTINGS_SURFACE";
  }

  // ATS iframe or script src embed (Signal C5 pattern): ATS content rendered
  // via iframe or external script means listings are not server-rendered here.
  const hasAtsIframeOrScriptEmbed =
    /(?:src|data-src)=["'][^"']*(?:greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com)/i.test(
      html
    );

  if (hasAtsIframeOrScriptEmbed) {
    return "WEAK_LISTINGS_SURFACE";
  }

  // JS-gated listings: known ATS client-side rendering patterns confirmed by
  // detectJsGating mean the page requires JavaScript execution to retrieve
  // the actual listing content — not directly accessible.
  if (detectJsGating(html) !== null) {
    return "WEAK_LISTINGS_SURFACE";
  }

  return "STRONG_LISTINGS_SURFACE";
}

// ---------------------------------------------------------------------------
// R1.1 – ATS embed candidate detection for weak surfaces
// ---------------------------------------------------------------------------

/**
 * R1.1: Detect high-confidence ATS embed references on a weak surface.
 *
 * Extracts canonical ATS board URLs from embed markers that are NOT captured
 * by the existing anchor-link / iframe-src / script-src extraction in
 * extractResolverCandidates.  Specifically, this targets data attributes and
 * JS widget configuration objects from which a canonical, publicly accessible
 * ATS job-board URL can be deterministically constructed.
 *
 * Supported marker types (per resolutionDepthRoadmap Step R1.1):
 *
 *   Greenhouse
 *     • data-gh-token="<slug>"           → https://boards.greenhouse.io/<slug>
 *     • embed URL param ?for=<slug>      → https://boards.greenhouse.io/<slug>
 *
 *   Lever
 *     • data-baseurl="https://jobs.lever.co/<slug>[/...]"
 *                                        → https://jobs.lever.co/<slug>
 *
 *   Ashby
 *     • app.ashbyhq.com/api/non-user-facing/job-board/<slug>
 *                                        → https://jobs.ashbyhq.com/<slug>
 *
 *   SmartRecruiters
 *     • data-company-id="<slug>"         → https://jobs.smartrecruiters.com/<slug>
 *     • SRJobListingWidget.init({company:"<slug>"})
 *                                        → https://jobs.smartrecruiters.com/<slug>
 *
 * Rules:
 *   - Only supported ATS domains appear in output.
 *   - Output is bounded: at most one URL per supported ATS provider.
 *   - Detection is purely regex-based (deterministic, no network, no LLM).
 *   - The function does NOT fetch or follow any URL.
 *
 * @param html - The full server-rendered HTML of a weak surface page.
 * @returns    An array of ATS embed candidates, each with a canonical ATS
 *             board URL and a human-readable reason string explaining the
 *             detection signal.
 */
export function detectAtsEmbedCandidates(
  html: string
): Array<{ url: string; reason: string }> {
  const results: Array<{ url: string; reason: string }> = [];
  const seen = new Set<string>();

  function add(url: string, reason: string): void {
    if (seen.has(url)) return;
    seen.add(url);
    results.push({ url, reason });
  }

  // -------------------------------------------------------------------------
  // Greenhouse
  // -------------------------------------------------------------------------

  // GH1: data-gh-token attribute.
  // The Greenhouse embed script reads this attribute to load the correct company
  // board.  Value is the company slug used directly in the boards.greenhouse.io URL.
  const ghTokenMatch = /\bdata-gh-token=["']([A-Za-z0-9_-]+)["']/i.exec(html);
  if (ghTokenMatch) {
    const slug = ghTokenMatch[1]!;
    add(
      `https://boards.greenhouse.io/${slug}`,
      `Greenhouse embed: data-gh-token="${slug}"`
    );
  }

  // GH2: boards.greenhouse.io embed URL with ?for=<slug> query parameter.
  // Appears as a script src or inline string in the page HTML and encodes the
  // company board slug.  Normalize to the canonical board URL.
  const ghForMatch =
    /boards\.greenhouse\.io\/embed\/job_board(?:\/js)?\?(?:[^"'\s]*&)?for=([A-Za-z0-9_-]+)/i.exec(
      html
    );
  if (ghForMatch) {
    const slug = ghForMatch[1]!;
    add(
      `https://boards.greenhouse.io/${slug}`,
      `Greenhouse embed: ?for=${slug} parameter`
    );
  }

  // -------------------------------------------------------------------------
  // Lever
  // -------------------------------------------------------------------------

  // LEV1: data-baseurl attribute used by the Lever postings script to locate
  // the company board.  The attribute value is the full board URL; we normalize
  // to the bare company path.
  const levBaseMatch =
    /\bdata-baseurl=["'](https?:\/\/jobs\.lever\.co\/[A-Za-z0-9_-]+)[^"']*["']/i.exec(
      html
    );
  if (levBaseMatch) {
    const rawUrl = levBaseMatch[1]!;
    try {
      const u = new URL(rawUrl);
      const slug = u.pathname.replace(/^\//, "").split("/")[0];
      if (slug) {
        add(
          `https://jobs.lever.co/${slug}`,
          `Lever embed: data-baseurl="${rawUrl}"`
        );
      }
    } catch {
      /* skip malformed URL */
    }
  }

  // -------------------------------------------------------------------------
  // Ashby
  // -------------------------------------------------------------------------

  // ASH1: Ashby's non-user-facing job-board API path encodes the company slug.
  // The path appears in script src or inline script bodies.  The public board
  // URL is at jobs.ashbyhq.com/<slug>.
  const ashbyMatch =
    /app\.ashbyhq\.com\/api\/non-user-facing\/job-board\/([A-Za-z0-9_-]+)/i.exec(
      html
    );
  if (ashbyMatch) {
    const slug = ashbyMatch[1]!;
    add(
      `https://jobs.ashbyhq.com/${slug}`,
      `Ashby embed: non-user-facing/job-board/${slug}`
    );
  }

  // -------------------------------------------------------------------------
  // SmartRecruiters
  // -------------------------------------------------------------------------

  // SR1: data-company-id attribute used by SmartRecruiters widget containers.
  const srDataMatch = /\bdata-company-id=["']([A-Za-z0-9_-]+)["']/i.exec(html);
  if (srDataMatch) {
    const slug = srDataMatch[1]!;
    add(
      `https://jobs.smartrecruiters.com/${slug}`,
      `SmartRecruiters embed: data-company-id="${slug}"`
    );
  }

  // SR2: SRJobListingWidget.init JS config with a "company" key.
  // The SmartRecruiters widget is initialized via this call; the company value
  // is the slug used in the public jobs board URL.
  const srWidgetMatch =
    /SRJobListingWidget\s*\.\s*init\s*\(\s*\{[^}]*["']?company["']?\s*:\s*["']([A-Za-z0-9_-]+)["']/i.exec(
      html
    );
  if (srWidgetMatch) {
    const slug = srWidgetMatch[1]!;
    add(
      `https://jobs.smartrecruiters.com/${slug}`,
      `SmartRecruiters embed: SRJobListingWidget company="${slug}"`
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// D3.1 – listings surface resolver
// ---------------------------------------------------------------------------

/**
 * High-confidence CTA anchor-text phrases that indicate a direct navigation link
 * to job listings. Only anchors whose visible text closely matches one of these
 * phrases are treated as high-confidence CTA targets by the resolver.
 *
 * Rules (R2.1):
 *   - Phrases must be strongly job-related navigation intent.
 *   - Generic marketing language ("join our team", "explore opportunities") is
 *     deliberately excluded — those appear in CAREERS_CTA_PHRASES for
 *     page classification, not for navigation target detection.
 *   - Detection remains deterministic: exact substring match on lowercased text.
 */
const RESOLVER_CTA_PHRASES = [
  // Original resolver phrases
  "view openings",
  "open roles",
  "search jobs",
  "see all jobs",
  // R2.1: additional high-confidence job navigation phrases from roadmap
  "browse roles",
  "current openings",
  "open positions",
  "view jobs",
] as const;

/**
 * Maximum number of next-hop candidate URLs the resolver will fetch and
 * re-verify.  Keeps the resolver bounded and deterministic.
 */
const RESOLVER_MAX_CANDIDATES = 5;

/** Map any HostType to the two allowed selected_source_type values. */
function toSelectedSourceType(
  hostType: HostType
): "OFFICIAL_DOMAIN" | "SUPPORTED_ATS" {
  return hostType === "SUPPORTED_ATS" ? "SUPPORTED_ATS" : "OFFICIAL_DOMAIN";
}

/** Return true when the anchor text contains one of the strong CTA phrases. */
function hasResolverCtaSignal(text: string): boolean {
  const lower = text.toLowerCase();
  return RESOLVER_CTA_PHRASES.some((phrase) => lower.includes(phrase));
}

// ---------------------------------------------------------------------------
// R2.1 – CTA-based candidate detection for careers pages
// ---------------------------------------------------------------------------

/**
 * R2.1: Detect high-confidence CTA links on a careers page that are likely
 * to navigate to an actual job listings surface.
 *
 * Supported CTA intent (per resolutionDepthRoadmap Step R2.1):
 *   "view openings", "open roles", "search jobs", "see all jobs",
 *   "browse roles", "current openings", "open positions", "view jobs"
 *
 * Rules:
 *   - CTA must be link-backed with a concrete href (not javascript:, #,
 *     mailto:, or tel: — these are rejected by normalizeHref).
 *   - CTA must be strongly job-related: the visible anchor text must contain
 *     one of the phrases in RESOLVER_CTA_PHRASES.
 *   - Weak generic marketing CTAs ("join our team", "learn more", etc.)
 *     do not appear in the phrase list and are therefore excluded.
 *   - Detection is purely regex-based (deterministic, no network, no LLM).
 *   - The function does NOT fetch or follow any URL.
 *   - Duplicate URLs (same normalized href) are deduplicated; the first
 *     matching phrase for each URL is reported as the reason.
 *
 * @param html    - The full server-rendered HTML of a careers page.
 * @param pageUrl - The base URL of the page (used to resolve relative hrefs).
 * @returns       An array of CTA candidates, each with an absolute URL and a
 *                human-readable reason string identifying the matched phrase.
 */
export function detectCtaCandidates(
  html: string,
  pageUrl: string
): Array<{ url: string; reason: string }> {
  const results: Array<{ url: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const { href, text } of extractAnchors(html)) {
    const normalized = normalizeHref(href, pageUrl);
    if (!normalized) continue;

    const textLower = text.toLowerCase();
    const matchedPhrase = RESOLVER_CTA_PHRASES.find((phrase) =>
      textLower.includes(phrase)
    );
    if (!matchedPhrase) continue;

    if (seen.has(normalized)) continue;
    seen.add(normalized);

    results.push({
      url: normalized,
      reason: `CTA link: "${matchedPhrase}" in anchor text`,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// R2.3 – CTA candidate ranking
// ---------------------------------------------------------------------------

/**
 * Job-specific URL path segments used by scoreCtaCandidate.
 *
 * Tier 2 (+2 pts) — directly job-specific; a URL path containing one of these
 * strongly suggests the destination is a dedicated listings page.
 *
 * Tier 1 (+1 pt) — moderately job-related but also common in generic marketing
 * copy; worth a point but not enough on its own to clear the trust threshold.
 *
 * The lists are deliberately short and generic to avoid overfitting any
 * single site's URL conventions (R2.3 deterministic / no-overfit rule).
 */
const CTA_PATH_TIER2_SEGMENTS: ReadonlyArray<string> = [
  "jobs",
  "careers",
  "openings",
  "positions",
  "roles",
];

const CTA_PATH_TIER1_SEGMENTS: ReadonlyArray<string> = [
  "hiring",
  "vacancies",
  "join",
  "work",
];

/** Minimum score required for a CTA candidate to be "clearly trustworthy" (R2.3). */
const CTA_TRUST_THRESHOLD = 2;

/**
 * R2.3: Compute a conservative trust score for a single CTA candidate URL.
 *
 * Scoring:
 *   +3 — destination is a supported ATS host (highest-confidence CTA target)
 *   +2 — URL path contains a tier-2 job-specific segment
 *          (jobs, careers, openings, positions, roles)
 *   +1 — URL path contains a tier-1 job-specific segment
 *          (hiring, vacancies, join, work)
 *
 * Score components are additive (path score accumulates from at most one tier).
 * A CTA is "clearly trustworthy" only when score >= CTA_TRUST_THRESHOLD (2).
 * Candidates below the threshold are ambiguous and must not be followed.
 *
 * Rules upheld:
 *   - Deterministic: same URL → same score.
 *   - No site-specific heuristics: tier lists are generic, not tuned for any
 *     particular company or job board.
 *   - ATS-destination preference is expressed numerically: ATS score ≥ 3 always
 *     beats an official-domain path score of ≤ 2.
 *
 * @param url - The absolute CTA target URL to score.
 */
export function scoreCtaCandidate(url: string): {
  score: number;
  trustworthy: boolean;
} {
  let score = 0;
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");

    // ATS destination: always the highest-confidence CTA target.
    if (isAtsHost(hostname)) {
      score += 3;
    }

    // Path segments: split on "/" and "-" to handle compound slugs like
    // "job-openings" or "open-roles".  Use the highest tier match found
    // (do not double-count when both a tier-2 and a tier-1 segment appear).
    const path = parsed.pathname.toLowerCase();
    const pathParts = path.split(/[/\-]+/).filter(Boolean);
    let pathScore = 0;
    for (const seg of pathParts) {
      if (CTA_PATH_TIER2_SEGMENTS.includes(seg)) {
        pathScore = Math.max(pathScore, 2);
      } else if (CTA_PATH_TIER1_SEGMENTS.includes(seg)) {
        pathScore = Math.max(pathScore, 1);
      }
    }
    score += pathScore;
  } catch {
    /* invalid URL — score stays 0 */
  }

  return { score, trustworthy: score >= CTA_TRUST_THRESHOLD };
}

/**
 * R2.3: Rank CTA candidates conservatively.
 *
 * Rules:
 *   - Discard candidates whose score < CTA_TRUST_THRESHOLD (ambiguous targets).
 *   - Among trustworthy candidates, prefer higher score (ATS > job-path > other).
 *   - Equal-score candidates retain their original relative order (stable sort).
 *   - If no candidate meets the threshold, returns an empty array so the caller
 *     does not follow any CTA — ambiguous pages remain unresolved.
 *
 * Deterministic: same input list → same output list.
 *
 * @param candidates - CTA candidates in discovery order.
 */
export function rankCtaCandidates(
  candidates: ReadonlyArray<{ url: string; method: "CTA_RESOLVED"; reason?: string }>
): Array<{ url: string; method: "CTA_RESOLVED"; reason?: string }> {
  // Score every candidate exactly once.
  const scored = candidates.map((c) => {
    const { score, trustworthy } = scoreCtaCandidate(c.url);
    return { url: c.url, method: c.method, reason: c.reason, score, trustworthy };
  });

  // Drop candidates below the trust threshold.
  const trustworthy = scored.filter((c) => c.trustworthy);

  // Stable descending sort by score: higher-confidence targets first.
  // Array.prototype.sort is stable in Node.js 11+ (V8 ≥ 7.0).
  trustworthy.sort((a, b) => b.score - a.score);

  return trustworthy.map(({ url, method, reason }) => ({ url, method, reason }));
}

/**
 * Extract candidate next-hop URLs from a careers landing page's HTML.
 *
 * Priority order (duplicates removed by normalized URL string):
 *   1. ATS outbound anchor links  (method: 'ATS_RESOLVED')
 *   2. Iframe src pointing to a supported ATS host  (method: 'ATS_RESOLVED')
 *   3. Script-sourced ATS URLs from src attrs and inline bodies  (method: 'ATS_RESOLVED')
 *   4. Strong CTA anchor links on the official domain  (method: 'CTA_RESOLVED')
 *
 * Browsers often embed ATS via iframe / script, so those are treated as
 * higher-confidence than text-based CTA navigation.
 */
function extractResolverCandidates(
  html: string,
  pageUrl: string,
  officialDomain: string
): Array<{ url: string; method: "ATS_RESOLVED" | "CTA_RESOLVED"; reason?: string }> {
  const atsLinks: Array<{ url: string; method: "ATS_RESOLVED"; reason?: string }> = [];
  const embeds: Array<{ url: string; method: "ATS_RESOLVED"; reason?: string }> = [];
  const ctaLinks: Array<{ url: string; method: "CTA_RESOLVED"; reason?: string }> = [];
  const seen = new Set<string>();

  function add<M extends "ATS_RESOLVED" | "CTA_RESOLVED">(
    url: string,
    method: M,
    bucket: Array<{ url: string; method: M; reason?: string }>
  ): void {
    if (seen.has(url)) return;
    seen.add(url);
    bucket.push({ url, method });
  }

  // 1. Anchor tags: ATS outbound links and strong CTA links
  for (const { href, text } of extractAnchors(html)) {
    const normalized = normalizeHref(href, pageUrl);
    if (!normalized) continue;
    try {
      const h = new URL(normalized).hostname.toLowerCase().replace(/^www\./, "");
      if (isAtsHost(h)) {
        // Any anchor pointing to a supported ATS is a high-confidence next hop.
        add(normalized, "ATS_RESOLVED", atsLinks);
      } else if (hasResolverCtaSignal(text)) {
        // CTA links are only followed on the official domain to prevent leaving
        // the allowed source set.
        const ht = resolveHostType(normalized, officialDomain);
        if (ht === "OFFICIAL_DOMAIN") {
          add(normalized, "CTA_RESOLVED", ctaLinks);
        }
      }
    } catch {
      /* skip invalid URLs */
    }
  }

  // 2. Iframes whose src points to a supported ATS host
  for (const src of extractIframeSrcs(html)) {
    const normalized = normalizeHref(src, pageUrl);
    if (!normalized) continue;
    try {
      const h = new URL(normalized).hostname.toLowerCase().replace(/^www\./, "");
      if (isAtsHost(h)) {
        add(normalized, "ATS_RESOLVED", embeds);
      }
    } catch {
      /* skip */
    }
  }

  // 3. Script src attributes and inline ATS URLs
  for (const raw of extractScriptAtsUrls(html)) {
    const normalized = normalizeHref(raw, pageUrl);
    if (!normalized) continue;
    try {
      const h = new URL(normalized).hostname.toLowerCase().replace(/^www\./, "");
      if (isAtsHost(h)) {
        add(normalized, "ATS_RESOLVED", embeds);
      }
    } catch {
      /* skip */
    }
  }

  // Return in priority order: ATS links → embedded ATS → CTA links
  return [...atsLinks, ...embeds, ...ctaLinks];
}

/**
 * D3.1: Resolve the actual job listings surface from a verified candidate.
 *
 * Fast path — already a listings surface:
 *   Returns a ResolvedJobSurface with resolution_method = 'DIRECT_VERIFIED'
 *   immediately, without any additional network requests.
 *
 * Slow path — careers landing page:
 *   Extracts high-confidence next-hop candidates from the page HTML
 *   (ATS outbound links, iframe/script embeds, strong CTA anchor links),
 *   then fetches and re-verifies each one in priority order until a page
 *   that passes verifyCareersCandidate as a LISTINGS_SURFACE is found.
 *
 *   If no listings surface is confirmed after exhausting the bounded
 *   candidate set, returns resolution_method = 'UNRESOLVED' rather than
 *   accepting a page that did not pass re-verification.
 *
 * Rules upheld:
 *   - Deterministic: same inputs → same outputs.
 *   - Bounded: at most RESOLVER_MAX_CANDIDATES next-hop fetches.
 *   - No Playwright.
 *   - No broad crawling: only high-confidence next hops from the page itself.
 *   - Conservative: only a LISTINGS_SURFACE re-verification result is accepted.
 *
 * @param verified      - The verified candidate produced by verifyCareersCandidate.
 * @param html          - The HTML body of the verified candidate page.
 * @param officialDomain - The official domain used for host-type classification.
 */
export async function resolveListingsSurface(
  verified: VerifiedCandidate,
  html: string,
  officialDomain: string
): Promise<ResolvedJobSurface> {
  // C2.1 / C2.2: DIRECT_VERIFIED is an output-level hard rule, not just a routing decision.
  //
  // C2.1 (routing): WEAK_LISTINGS_SURFACE must NOT skip the slow path.
  // C2.2 (output):  DIRECT_VERIFIED may ONLY be returned when strength is
  //                 STRONG_LISTINGS_SURFACE.  No other code path in this function
  //                 may produce DIRECT_VERIFIED.
  //
  // A WEAK surface contains ATS embed indicators or other indirect listing
  // signals that mean listings are not directly enumerable from the server-
  // rendered HTML.  It must fall through to the slow path — exactly like
  // CAREERS_LANDING — and produce an unresolved or indirect resolution_method.
  const strength = classifyListingsStrength(verified.page_kind, html, verified.url);
  if (strength === "STRONG_LISTINGS_SURFACE") {
    // C2.2: Only reachable for STRONG surfaces.  DIRECT_VERIFIED implies that
    // listings are directly and confidently enumerable from this page.
    //
    // C3.2: listings_url is set to verified.url (same as careers_url) rather
    // than null.  This makes null strictly mean "resolution failed" so
    // downstream code cannot conflate "no separate listings URL" with "no
    // trustworthy listings surface exists".
    return {
      careers_url: verified.url,
      listings_url: verified.url,
      selected_source_type: toSelectedSourceType(verified.host_type),
      page_kind: "LISTINGS_SURFACE",
      resolution_method: "DIRECT_VERIFIED",
      verification_reasons: verified.verification_reasons,
      attempted_urls: [],
      // R6.1: Fast path — the careers page IS the listings surface.
      // No resolution hop was attempted; candidate counts are not applicable.
      resolution_path_detail: { path: "DIRECT_VERIFIED" },
    };
  }
  // C2.2: strength is WEAK_LISTINGS_SURFACE or CAREERS_LANDING here.
  // DIRECT_VERIFIED must NEVER be returned below this line.

  // Slow path: careers landing page or weak listings surface — attempt to find
  // the actual listings surface.
  const extractorCandidates = extractResolverCandidates(html, verified.url, officialDomain);

  // R1.2: Incorporate ATS embed candidates detected by detectAtsEmbedCandidates
  // (R1.1). These are canonical ATS board URLs derived from data attributes and
  // JS widget configs (e.g. data-gh-token, data-baseurl, Ashby API paths,
  // SmartRecruiters widget init). They are NOT captured by href/src extraction
  // but are equally high-confidence indicators of where the ATS board lives.
  //
  // Rules upheld:
  //   - Single hop: each candidate is fetched once; no recursion.
  //   - Re-verification required: destination must pass verifyCareersCandidate.
  //   - Bounded: total candidate list is still capped at RESOLVER_MAX_CANDIDATES.
  //   - Conservative: only LISTINGS_SURFACE re-verification is accepted.
  //   - Only supported ATS domains appear (detectAtsEmbedCandidates guarantee).
  //
  // Priority: ATS/iframe/script candidates first → R1.1 embed candidates →
  // CTA candidates. Deduplicate by URL so a URL already captured by
  // extractResolverCandidates is not fetched twice.
  //
  // R6.1: Preserve `reason` from detectAtsEmbedCandidates so it can be
  // forwarded into resolution_path_detail.detection_reason when this candidate
  // is the one that successfully resolves.
  const atsEmbedFromDetection = detectAtsEmbedCandidates(html).map(
    ({ url, reason }) => ({ url, method: "ATS_RESOLVED" as const, reason })
  );
  const existingUrls = new Set(extractorCandidates.map((c) => c.url));
  const newEmbedCandidates = atsEmbedFromDetection.filter(
    (c) => !existingUrls.has(c.url)
  );
  // Keep CTA candidates at the end of the priority queue; R1.1 embed candidates
  // go before them (same tier as other ATS_RESOLVED entries).
  const nonCtaCandidates = extractorCandidates.filter((c) => c.method !== "CTA_RESOLVED");
  const ctaCandidates = extractorCandidates.filter(
    (c): c is { url: string; method: "CTA_RESOLVED"; reason?: string } => c.method === "CTA_RESOLVED"
  );

  // R2.2: Incorporate CTA candidates detected by detectCtaCandidates (R2.1).
  // These are anchor links whose visible text matches a high-confidence job
  // navigation phrase (e.g. "view jobs", "search jobs", "see all jobs").
  // detectCtaCandidates is a pure function with no domain restriction; we
  // restrict here to allowed destinations only — official domain or supported
  // ATS — to prevent following unsupported external job boards or arbitrary
  // third-party links.
  //
  // Rules upheld:
  //   - Single hop: each candidate is fetched exactly once; no recursion.
  //   - Re-verification required: destination must pass verifyCareersCandidate
  //     as LISTINGS_SURFACE ("verified more strongly" than CAREERS_LANDING).
  //   - Bounded: total candidate list remains capped at RESOLVER_MAX_CANDIDATES.
  //   - Conservative: only LISTINGS_SURFACE re-verification is accepted.
  //   - Domain-restricted: OTHER-domain CTAs are excluded per roadmap safety rules
  //     (no generic external crawling, no unsupported job boards).
  //
  // CTAs already captured by extractResolverCandidates (official-domain
  // CTA_RESOLVED entries) or present as ATS_RESOLVED are deduplicated
  // via the existingUrls set so no URL is fetched twice.
  //
  // R6.1: Preserve `reason` from detectCtaCandidates so it can be forwarded
  // into resolution_path_detail.detection_reason on successful CTA resolution.
  const ctaFromDetection = detectCtaCandidates(html, verified.url)
    .filter(({ url }) => resolveHostType(url, officialDomain) !== "OTHER")
    .map(({ url, reason }) => ({ url, method: "CTA_RESOLVED" as const, reason }));
  const newCtaCandidates = ctaFromDetection.filter((c) => !existingUrls.has(c.url));

  // R2.3: Rank CTA candidates conservatively before merging into the final
  // candidate list.  This filters out ambiguous targets (score < threshold)
  // and places higher-confidence CTA URLs first (ATS > job-path > generic).
  // If no CTA candidate clears the trust threshold, rankedCtaCandidates is
  // empty and the resolver skips all CTA hops — ambiguous pages remain
  // unresolved instead of being guessed through.
  const rankedCtaCandidates = rankCtaCandidates([
    ...ctaCandidates,
    ...newCtaCandidates,
  ]);

  const candidates = [
    ...nonCtaCandidates,
    ...newEmbedCandidates,
    ...rankedCtaCandidates,
  ];

  // R6.1: Pre-compute candidate counts for resolution_path_detail.
  // Counted from the full candidates array (before RESOLVER_MAX_CANDIDATES cap)
  // so the trace reflects all candidates that were detected, not just those tried.
  const atsCandidatesDetected = candidates.filter((c) => c.method === "ATS_RESOLVED").length;
  const ctaCandidatesDetected = candidates.filter((c) => c.method === "CTA_RESOLVED").length;
  // R1.3: Hard safety boundaries for ATS embed resolution.
  //
  // (a) ONE HOP DEPTH — this loop represents a single level of resolution.
  //     Each candidate URL is fetched exactly once.  We NEVER call
  //     resolveListingsSurface recursively from inside this loop.  If a fetched
  //     ATS board page itself contains further ATS embed markers, those are
  //     ignored — we only descend ONE level from the original weak surface.
  //
  // (b) BOUNDED — candidates.slice(0, RESOLVER_MAX_CANDIDATES) is the only
  //     place the list is consumed.  No unbounded crawling is possible.
  //
  // (c) SUPPORTED DOMAINS ONLY — every URL in `candidates` was produced by
  //     extractResolverCandidates (which only adds isAtsHost() URLs for
  //     ATS_RESOLVED entries, and official-domain-only URLs for CTA_RESOLVED)
  //     or by detectAtsEmbedCandidates (which only produces URLs for the four
  //     supported ATS providers).  Unsupported job boards and arbitrary
  //     third-party links are never present in this list.
  //
  // (d) VERIFICATION REQUIRED — the `if (verification?.page_kind !== "LISTINGS_SURFACE")`
  //     guard means a candidate is accepted ONLY when it independently verifies
  //     as a listings surface.  If the ATS destination fails verification for
  //     any reason (fetch failure, redirect to non-ATS page, insufficient signals),
  //     we continue to the next candidate or ultimately return UNRESOLVED/INDIRECT.
  //     Failed ATS guesses can never produce false confidence.
  const bounded = candidates.slice(0, RESOLVER_MAX_CANDIDATES);
  const attempted_urls: string[] = [];

  for (const candidate of bounded) {
    attempted_urls.push(candidate.url);
    const fetched = await fetchCandidateHtml(candidate.url, REQUEST_TIMEOUT_MS);
    if (!fetched) continue;
    const verification = verifyCareersCandidate(
      candidate.url,
      fetched.html,
      fetched.finalUrl
    );
    // Only accept a page that re-verifies as a listings surface.
    // If this is null or CAREERS_LANDING, skip without recursing further.
    if (verification?.page_kind !== "LISTINGS_SURFACE") continue;
    // R3.1 / R3.2: Keep strong vs weak distinctions intact on resolved destinations.
    //
    // R3.1 — Re-run verification after each resolution hop: every resolved
    // destination must be explicitly verified (verifyCareersCandidate above)
    // before it can be treated as a listings surface.  A followed link is never
    // automatically authoritative.
    //
    // R3.2 — Upgrade resolved surfaces only on strong evidence: even when a
    // resolved destination passes verifyCareersCandidate as LISTINGS_SURFACE, it
    // may still be a WEAK_LISTINGS_SURFACE (e.g. a page with job-detail links
    // that also contains ATS embed container markers, an ATS iframe/script
    // embed, or JS-gating patterns).  Such a page requires JavaScript to
    // enumerate the actual listings and is NOT an authoritative, directly
    // extractable surface.
    //
    // R3.2 rule: strong listings surface → extraction may begin
    //            weak destination       → skip; remain unresolved
    //            unresolved             → do not treat as final
    //
    // The same correctness rule that blocks DIRECT_VERIFIED for weak initial
    // candidates must also apply here: a one-hop destination makes listings_url
    // non-null (extraction-ready) ONLY when classifyListingsStrength confirms
    // STRONG_LISTINGS_SURFACE.  Weak resolved pages stay conservative.
    const resolvedStrength = classifyListingsStrength(
      verification.page_kind,
      fetched.html,
      fetched.finalUrl
    );
    if (resolvedStrength !== "STRONG_LISTINGS_SURFACE") continue;
    // R1.3(a): Return immediately on the first successful resolution — no further
    // hops into the resolved listings_url.  The single-hop contract ends here.
    const resolvedHostType = resolveHostType(fetched.finalUrl, officialDomain);
    return {
      careers_url: verified.url,
      listings_url: fetched.finalUrl,
      selected_source_type: toSelectedSourceType(resolvedHostType),
      page_kind: "LISTINGS_SURFACE",
      resolution_method: candidate.method,
      verification_reasons: verification.verification_reasons,
      attempted_urls,
      // R6.1: Surface which signal triggered this hop and how many candidates
      // were detected vs tried so the trace explains why this path was taken.
      resolution_path_detail: {
        path: candidate.method,
        detection_reason: candidate.reason,
        candidates_detected: candidates.length,
        candidates_tried: attempted_urls.length,
        ats_candidates_detected: atsCandidatesDetected,
        cta_candidates_detected: ctaCandidatesDetected,
      },
    };
  }

  // D3.2: Before returning UNRESOLVED, check whether the verified candidate's
  // HTML contains high-confidence evidence that listings exist but require JS
  // to be retrieved.  If so, surface PLAYWRIGHT_REQUIRED so downstream
  // orchestration can escalate to interactive resolution rather than treating
  // this as a generic failure.  Only high-confidence signals qualify — see
  // detectJsGating for the precise criteria.
  const jsGatingReasons = detectJsGating(html);
  if (jsGatingReasons !== null) {
    return {
      careers_url: verified.url,
      listings_url: null,
      selected_source_type: toSelectedSourceType(verified.host_type),
      page_kind: "CAREERS_LANDING",
      resolution_method: "PLAYWRIGHT_REQUIRED",
      verification_reasons: [...verified.verification_reasons, ...jsGatingReasons],
      attempted_urls,
      // R6.1: JS gating detected; record how many candidates were tried before
      // JS gating was confirmed as the blocker.
      resolution_path_detail: {
        path: "PLAYWRIGHT_REQUIRED",
        candidates_detected: candidates.length,
        candidates_tried: attempted_urls.length,
        ats_candidates_detected: atsCandidatesDetected,
        cta_candidates_detected: ctaCandidatesDetected,
      },
    };
  }

  // No listings surface could be resolved and no JS gating evidence found.
  //
  // C3.1: Distinguish the two root causes so downstream stages can treat them
  // appropriately without checking strength themselves:
  //
  //   INDIRECT  — the starting page was a WEAK_LISTINGS_SURFACE.  A trustworthy
  //               listings surface was not reachable via the slow path.
  //               Downstream must treat this as uncertain (same as UNRESOLVED).
  //
  //   UNRESOLVED — the starting page was a plain CAREERS_LANDING.  No listings
  //                surface could be found at all.
  const unresolvedMethod =
    strength === "WEAK_LISTINGS_SURFACE" ? "INDIRECT" : "UNRESOLVED";

  return {
    careers_url: verified.url,
    listings_url: null,
    selected_source_type: toSelectedSourceType(verified.host_type),
    page_kind: "CAREERS_LANDING",
    resolution_method: unresolvedMethod,
    verification_reasons: verified.verification_reasons,
    attempted_urls,
    // R6.1: No listings surface was found. Record how many candidates were
    // detected and tried so the trace explains the scope of the resolution
    // attempt. For INDIRECT, the starting page was a WEAK_LISTINGS_SURFACE.
    // For UNRESOLVED, it was a plain CAREERS_LANDING. Either way, the counts
    // show what was attempted without conflating the two root causes.
    resolution_path_detail: {
      path: unresolvedMethod,
      candidates_detected: candidates.length,
      candidates_tried: attempted_urls.length,
      ats_candidates_detected: atsCandidatesDetected,
      cta_candidates_detected: ctaCandidatesDetected,
    },
  };
}
