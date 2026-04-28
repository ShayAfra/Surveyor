/**
 * Internal discovery pipeline types (Step D0.2).
 *
 * These types model the distinct stages of the deterministic discovery pipeline.
 * They are internal to the API and do NOT appear in any shared response contract.
 *
 * Stage progression:
 *   DiscoveryCandidate → (verification) → VerifiedCandidate → (resolution) → ResolvedJobSurface
 */

// ---------------------------------------------------------------------------
// Stage 1 – raw candidate produced by any generation source
// ---------------------------------------------------------------------------

export type CandidateSourceType =
  | "HOMEPAGE_LINK"
  | "URL_GUESS"
  | "SEARCH_RESULT"
  | "ATS_LINK"
  | "EMBEDDED_ATS";

export type HostType = "OFFICIAL_DOMAIN" | "SUPPORTED_ATS" | "OTHER";

export type PageKind = "LISTINGS_SURFACE" | "CAREERS_LANDING";

/**
 * C1.1: Internal listings strength classification.
 *
 * NOT part of the external PageKind contract. Never persisted or returned in API
 * responses. Used only within resolveListingsSurface to decide fast-path eligibility.
 *
 *   STRONG_LISTINGS_SURFACE — direct enumerated job listings; the page IS the
 *     native listing surface (ATS host URL) or server-rendered direct evidence
 *     with no ATS embed indirection.
 *
 *   WEAK_LISTINGS_SURFACE   — meets listing threshold but the page contains ATS
 *     embed markers, script-driven job boards, or iframe-based listings that
 *     indicate listings are not directly enumerable from the server-rendered HTML.
 *     Critical rule: ATS embed signals alone MUST NOT qualify as STRONG.
 *
 *   CAREERS_LANDING         — careers entry point only; not a listings surface.
 */
export type ListingsStrength =
  | "STRONG_LISTINGS_SURFACE"
  | "WEAK_LISTINGS_SURFACE"
  | "CAREERS_LANDING";

/**
 * R4.1: Extended resolution method semantics (internal only).
 *
 * These values are used in-memory throughout the pipeline to guide downstream
 * logic.  They are NEVER persisted to the DB or returned directly in external
 * API responses.
 *
 *   DIRECT_VERIFIED    — strong resolution only (STRONG_LISTINGS_SURFACE).
 *                        The verified careers page IS the authoritative listings
 *                        surface; listings are directly enumerable.  No
 *                        resolution hop was required.
 *
 *   ATS_RESOLVED       — one-hop resolution via an ATS anchor link, ATS iframe
 *                        embed src, or ATS widget data attribute (e.g.
 *                        data-gh-token, data-baseurl, Ashby job-board API path).
 *                        The resolved destination was re-verified as a strong
 *                        listings surface on a supported ATS host.
 *
 *   CTA_RESOLVED       — one-hop resolution via a high-confidence "view jobs" /
 *                        "see all jobs" style CTA link.  The CTA target was
 *                        re-verified as a strong listings surface.
 *
 *   PLAYWRIGHT_REQUIRED — the page contains strong JS-gating evidence; the
 *                         listings surface cannot be reached without a headless
 *                         browser.
 *
 *   UNRESOLVED         — the slow path exhausted all candidates from a
 *                        CAREERS_LANDING page without finding a listings surface.
 *
 *   INDIRECT           — the starting page was a WEAK_LISTINGS_SURFACE (ATS
 *                        embed indicators or other indirect listing signals)
 *                        and the slow path could not resolve to a trustworthy
 *                        listings surface.  Downstream must treat this with the
 *                        same uncertainty as UNRESOLVED, but the distinction
 *                        allows pipeline stages to know the root cause was a
 *                        weak starting surface rather than a complete miss.
 */
export type ResolutionMethod =
  | "DIRECT_VERIFIED"
  | "ATS_RESOLVED"
  | "CTA_RESOLVED"
  | "PLAYWRIGHT_REQUIRED"
  | "UNRESOLVED"
  | "INDIRECT";

export interface DiscoveryCandidate {
  url: string;
  source_type: CandidateSourceType;
  /** The page from which this candidate was derived, or null for guessed/searched URLs. */
  source_url: string | null;
  /** Whether the URL passes the allow-list check (official domain or supported ATS). */
  allowed: boolean;
  host_type: HostType;
}

// ---------------------------------------------------------------------------
// Stage 2 – candidate that passed deterministic verification
// ---------------------------------------------------------------------------

export interface VerifiedCandidate {
  url: string;
  source_type: CandidateSourceType;
  host_type: HostType;
  /** Whether this page is already a listings surface or only a careers landing page. */
  page_kind: PageKind;
  /** Human-readable signals that caused verification to pass (for tracing). */
  verification_reasons: string[];
}

// ---------------------------------------------------------------------------
// Stage 3 – final resolved job surface returned by the pipeline
// ---------------------------------------------------------------------------

/**
 * R6.1: Structured resolution path detail attached to every ResolvedJobSurface.
 *
 * Populated on all code paths through resolveListingsSurface so trace consumers
 * can understand exactly which path the resolver took and why, without needing
 * to cross-reference other trace events.
 *
 *   DIRECT_VERIFIED     — fast path; no hop attempted; candidate counts absent.
 *   ATS_RESOLVED        — one-hop via ATS embed/anchor; detection_reason names the signal.
 *   CTA_RESOLVED        — one-hop via CTA link; detection_reason names the CTA phrase.
 *   PLAYWRIGHT_REQUIRED — JS gating detected; candidate counts show what was attempted.
 *   UNRESOLVED          — no listings surface found; counts show scope of attempt.
 *   INDIRECT            — started from weak surface; same counts as UNRESOLVED.
 */
export interface ResolutionPathDetail {
  /** Mirrors resolution_method on the parent ResolvedJobSurface. */
  path: ResolutionMethod;
  /**
   * For ATS_RESOLVED / CTA_RESOLVED: the specific detection signal that
   * identified the winning next-hop candidate, e.g.:
   *   "Greenhouse embed: data-gh-token=\"acme\""
   *   "CTA link: \"view jobs\" in anchor text"
   * Absent for DIRECT_VERIFIED (no hop) and for candidates sourced from
   * generic anchor/iframe extraction that does not generate an explicit reason.
   */
  detection_reason?: string;
  /**
   * Total resolver candidates collected before the RESOLVER_MAX_CANDIDATES cap.
   * Absent for DIRECT_VERIFIED (fast path — no candidates collected).
   */
  candidates_detected?: number;
  /**
   * Resolver candidates actually fetched (bounded by RESOLVER_MAX_CANDIDATES).
   * Absent for DIRECT_VERIFIED.
   */
  candidates_tried?: number;
  /** ATS-type (ATS_RESOLVED method) candidate count. Absent for DIRECT_VERIFIED. */
  ats_candidates_detected?: number;
  /** CTA-type (CTA_RESOLVED method) candidate count. Absent for DIRECT_VERIFIED. */
  cta_candidates_detected?: number;
}

export interface ResolvedJobSurface {
  /** The verified careers entry point URL. */
  careers_url: string;
  /**
   * C3.2: The resolved listings surface URL.
   *
   * For DIRECT_VERIFIED (STRONG_LISTINGS_SURFACE) this equals careers_url —
   * the verified page IS the listings surface so no separate URL exists.
   *
   * null strictly means resolution failed (INDIRECT, UNRESOLVED, or
   * PLAYWRIGHT_REQUIRED).  Downstream must NOT treat null as
   * "careers_url is an equivalent substitute" — null always means no
   * trustworthy listings surface was reached.
   */
  listings_url: string | null;
  selected_source_type: "OFFICIAL_DOMAIN" | "SUPPORTED_ATS";
  page_kind: PageKind;
  resolution_method: ResolutionMethod;
  /** Verification signals that supported accepting this surface (for tracing). */
  verification_reasons: string[];
  /** All URLs that were attempted during discovery and resolution. */
  attempted_urls: string[];
  /** R6.1: Structured detail explaining how (or why not) the resolver reached the listings surface. */
  resolution_path_detail: ResolutionPathDetail;
}
