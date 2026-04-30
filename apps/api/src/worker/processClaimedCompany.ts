/**
 * Company pipeline orchestration (roadmap Step 3.5): discovery → platform → extraction → matching → finalization.
 * Extraction: Step 6.4 (persisted extractor + Playwright fallback when eligible).
 */

import type { RoleSpec } from "@surveyor/shared";
import { AtsType, CompanyStatus } from "@surveyor/shared";
import { db } from "../db/db.js";
import { serializeErrorForTrace } from "../lib/errorTrace.js";
import { writeTraceEvent } from "../lib/trace.js";
import { discoverCareersUrl } from "../lib/discovery.js";
import { detectPlatform } from "../lib/platform.js";
import {
  EXTRACTOR_USED,
  extractJobs,
  initialExtractorForAts,
  shouldAttemptPlaywrightFallback,
  type ExtractJobsResult,
} from "../lib/extraction.js";
import { matchJobs } from "../lib/matching.js";
import {
  computeFinalStatus,
  persistFinalizeCompany,
  type FinalizePersistInput,
} from "../lib/finalizeCompany.js";
import { tryCompleteRun } from "./tryCompleteRun.js";

function deriveCompletionReason(extraction: { completed: boolean; failure_code?: string; jobs?: { length: number } }): string {
  if (extraction.completed) {
    return "CONFIDENT_SURFACE";
  }
  if (extraction.failure_code) {
    return extraction.failure_code;
  }
  return (extraction.jobs?.length ?? 0) === 0 ? "NO_LISTINGS_PARSED" : "NOT_CONFIDENT_SURFACE";
}

const FETCH_TIMEOUT_MS = 5000;

const updateCareersUrl = db.prepare(`
  UPDATE run_companies
  SET careers_url = ?
  WHERE id = ?
    AND status = ?
    AND worker_token = ?
`);

const updateAtsType = db.prepare(`
  UPDATE run_companies
  SET ats_type = ?
  WHERE id = ?
    AND status = ?
    AND worker_token = ?
`);

const updateExtractorUsed = db.prepare(`
  UPDATE run_companies
  SET extractor_used = ?
  WHERE id = ?
    AND status = ?
    AND worker_token = ?
`);

const selectRoleSpecJson = db.prepare(`
  SELECT role_spec_json AS j FROM runs WHERE id = ?
`);

function stillOwns(run_company_id: string, worker_token: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS o FROM run_companies WHERE id = ? AND status = ? AND worker_token = ?`
    )
    .get(
      run_company_id,
      CompanyStatus.IN_PROGRESS,
      worker_token
    ) as { o: number } | undefined;
  return !!row;
}

async function fetchCareersHtml(url: string): Promise<string | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
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
    if (!res.ok) {
      return null;
    }
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function parseRoleSpec(json: string): RoleSpec | null {
  try {
    const o = JSON.parse(json) as RoleSpec;
    if (
      !Array.isArray(o.include_titles) ||
      !Array.isArray(o.exclude_titles) ||
      typeof o.seniority !== "string"
    ) {
      return null;
    }
    return o;
  } catch {
    return null;
  }
}

function finalizeAndCompleteRun(input: FinalizePersistInput): void {
  const ok = persistFinalizeCompany(input);
  if (ok) {
    tryCompleteRun(input.run_id);
  }
}

async function runTracedExtractorAttempt(args: {
  run_id: string;
  run_company_id: string;
  url: string;
  ats_type: AtsType;
  extractor_used: string;
  attempt_number: number;
}): Promise<ExtractJobsResult> {
  const {
    run_id,
    run_company_id,
    url,
    ats_type,
    extractor_used,
    attempt_number,
  } = args;
  const startMs = Date.now();

  writeTraceEvent({
    run_id,
    run_company_id,
    event_type: "extractor_attempt_started",
    message: "extractor attempt started",
    payload_json: JSON.stringify({
      extractor_used,
      ats_type,
      url,
      attempt_number,
    }),
    created_at: Date.now(),
  });

  try {
    const extraction = await extractJobs(url, ats_type, extractor_used, {
      onPlaywrightStageFailed: (diagnostic) => {
        writeTraceEvent({
          run_id,
          run_company_id,
          event_type: "playwright_stage_failed",
          message: "playwright stage failed",
          payload_json: JSON.stringify(diagnostic),
          created_at: Date.now(),
        });
      },
    });

    writeTraceEvent({
      run_id,
      run_company_id,
      event_type: "extractor_attempt_finished",
      message: "extractor attempt finished",
      payload_json: JSON.stringify({
        extractor_used,
        ats_type,
        url,
        attempt_number,
        completed: extraction.completed,
        jobs_count: extraction.jobs.length,
        listings_scanned: extraction.listings_scanned,
        pages_visited: extraction.pages_visited,
        failure_code: extraction.failure_code ?? null,
        failure_reason: extraction.failure_reason ?? null,
        duration_ms: Date.now() - startMs,
      }),
      created_at: Date.now(),
    });

    return extraction;
  } catch (error) {
    const serialized = serializeErrorForTrace(error);
    writeTraceEvent({
      run_id,
      run_company_id,
      event_type: "extractor_attempt_exception",
      message: "extractor attempt threw exception",
      payload_json: JSON.stringify({
        extractor_used,
        ats_type,
        url,
        attempt_number,
        stage: null,
        ...serialized,
        duration_ms: Date.now() - startMs,
      }),
      created_at: Date.now(),
    });
    throw error;
  }
}

/**
 * Step 6.2 / D4.2 discovery orchestration: persistence + trace only here (not exported).
 *
 * listings_url is kept in memory on success for downstream extraction (D5.1).
 * resolution_method is forwarded so extraction orchestration can consult whether
 * the resolver annotated 'PLAYWRIGHT_REQUIRED' (D5.2 Condition B).
 */
type RunDiscoveryResult =
  | {
      status: "success";
      careers_url: string;
      listings_url: string | null;
      /** From discoverCareersUrl; 'PLAYWRIGHT_REQUIRED' authorises Playwright Condition B. */
      resolution_method: string | null;
    }
  | {
      status: "failure_not_found";
      /** D6.1: specific discovery failure code (CAREERS_NOT_FOUND or CAREERS_PAGE_UNVERIFIED). */
      failure_code: string;
    }
  | { status: "aborted" };

async function runDiscoveryForCompany(args: {
  run_id: string;
  run_company_id: string;
  company_name: string;
  worker_token: string;
}): Promise<RunDiscoveryResult> {
  const { run_id, run_company_id, company_name, worker_token } = args;

  const result = await discoverCareersUrl(company_name);

  writeTraceEvent({
    run_id,
    run_company_id,
    event_type: "careers_url_attempts",
    message: "careers url attempts completed",
    payload_json: JSON.stringify({
      attempted_urls: result.attempted_urls,
      total_attempted: result.attempted_urls.length,
      // null on success; "CAREERS_NOT_FOUND" = no HTML fetched; "CAREERS_PAGE_UNVERIFIED" = fetched but rejected
      failure_code: result.failure_code,
    }),
    created_at: Date.now(),
  });

  if (!result.careers_url) {
    return { status: "failure_not_found", failure_code: result.failure_code ?? "CAREERS_NOT_FOUND" };
  }

  if (!stillOwns(run_company_id, worker_token)) {
    return { status: "aborted" };
  }

  const uCareers = updateCareersUrl.run(
    result.careers_url,
    run_company_id,
    CompanyStatus.IN_PROGRESS,
    worker_token
  );
  if (uCareers.changes !== 1) {
    return { status: "aborted" };
  }

  // D4.2 / D6.2: Emit enriched trace payload explaining why the URL was selected,
  // not just what URL won. Includes listings_url, page_kind, resolution_method,
  // verification_reasons from the full D4.1 resolver output, an explicit
  // js_gating_detected flag derived from resolution_method for fast debugging,
  // and resolution_path_detail (R6.1) so the trace exposes which specific path
  // the resolver took and why — enabling diagnosis of Reddit-like indirect cases.
  writeTraceEvent({
    run_id,
    run_company_id,
    event_type: "careers_url_selected",
    message: "careers url selected",
    payload_json: JSON.stringify({
      careers_url: result.careers_url,
      listings_url: result.listings_url,
      selected_source_type: result.selected_source_type,
      page_kind: result.page_kind,
      resolution_method: result.resolution_method,
      verification_reasons: result.verification_reasons,
      // true when detectJsGating fired and set resolution_method to PLAYWRIGHT_REQUIRED
      js_gating_detected: result.resolution_method === "PLAYWRIGHT_REQUIRED",
      // R6.1: Structured resolution path detail — exposes which path was used
      // (direct_verified / ats_resolved / cta_resolved / unresolved / indirect /
      // playwright_required), what detection signal triggered any hop, and how
      // many candidates were detected vs tried by the resolver.
      resolution_path_detail: result.resolution_path_detail,
    }),
    created_at: Date.now(),
  });

  return {
    status: "success",
    careers_url: result.careers_url,
    listings_url: result.listings_url,
    resolution_method: result.resolution_method,
  };
}

export async function processClaimedCompany(args: {
  run_id: string;
  run_company_id: string;
  company_name: string;
  worker_token: string;
}): Promise<void> {
  const { run_id, run_company_id, company_name, worker_token } = args;

  if (!stillOwns(run_company_id, worker_token)) {
    return;
  }

  const discoveryOutcome = await runDiscoveryForCompany({
    run_id,
    run_company_id,
    company_name,
    worker_token,
  });

  if (discoveryOutcome.status === "failure_not_found") {
    const computed = computeFinalStatus({
      careersUrl: null,
      extraction: { completed: false },
      matchCount: 0,
      // No resolution was attempted — discovery failed before any resolver ran.
      resolutionMethod: null,
    });
    // D6.1: use the specific discovery failure code forwarded from discoverCareersUrl
    // instead of the generic CAREERS_NOT_FOUND that computeFinalStatus always returns.
    const discoveryFailureCode = discoveryOutcome.failure_code;
    const discoveryFailureReason =
      discoveryFailureCode === "CAREERS_PAGE_UNVERIFIED"
        ? "careers page candidates were found but none passed deterministic verification"
        : "no authoritative careers URL could be discovered";
    finalizeAndCompleteRun({
      run_id,
      run_company_id,
      worker_token,
      now_ms: Date.now(),
      computed_status: computed.computed_status,
      careers_url: null,
      // R4.2: discovery failed entirely — no entry point, no resolved surface.
      listings_url: null,
      ats_type: AtsType.UNKNOWN,
      extractor_used: null,
      listings_scanned: 0,
      pages_visited: 0,
      failure_code: discoveryFailureCode,
      failure_reason: discoveryFailureReason,
      matchedJobs: [],
      // C6.2: null — discovery failed before any resolution was attempted.
      resolution_method: null,
      completion_reason: discoveryFailureCode,
    });
    return;
  }

  if (discoveryOutcome.status === "aborted") {
    return;
  }

  if (!stillOwns(run_company_id, worker_token)) {
    return;
  }

  const careersUrl = discoveryOutcome.careers_url;
  // D5.1: prefer the resolved listings surface as the extraction start URL when
  // available — extraction begins on the actual job listings page, not a weaker
  // upstream landing page.  Platform detection is also run on this URL so it
  // gets the strongest possible signal.
  const listingsUrl = discoveryOutcome.listings_url;
  // D5.2: resolver annotation forwarded to shouldAttemptPlaywrightFallback.
  // 'PLAYWRIGHT_REQUIRED' (set by detectJsGating in discovery) authorises Condition B.
  const discoveryResolutionMethod = discoveryOutcome.resolution_method;

  // C3.2: listings_url is null ONLY when resolution genuinely failed (INDIRECT,
  // UNRESOLVED, PLAYWRIGHT_REQUIRED).  For DIRECT_VERIFIED, listings_url equals
  // careers_url explicitly.  Do NOT fall back to careersUrl when listings_url is
  // null — that would falsely treat an unresolved surface as if it were the
  // authoritative listings surface (equivalence assumption eliminated here).
  const extractionStartUrl = listingsUrl;

  // R3.2: Upgrade resolved surfaces only on strong evidence.
  //
  // listings_url is non-null ONLY when resolveListingsSurface confirmed a
  // STRONG_LISTINGS_SURFACE destination (DIRECT_VERIFIED, ATS_RESOLVED, or
  // CTA_RESOLVED with a strong re-verified destination).  Weak resolved pages
  // (INDIRECT) and unresolved cases (UNRESOLVED, PLAYWRIGHT_REQUIRED) always
  // produce listings_url = null.
  //
  // Extraction may therefore begin ONLY when extractionStartUrl is non-null:
  //   strong listings surface → extractionStartUrl set → extraction may begin
  //   weak destination        → listings_url null     → UNVERIFIED (conservative)
  //   unresolved destination  → listings_url null     → UNVERIFIED (conservative)
  if (extractionStartUrl === null) {
    // No trustworthy listings surface was resolved.  Finalize as UNVERIFIED
    // with a specific failure code derived from the resolver's annotation.
    const failureCode =
      discoveryResolutionMethod === "PLAYWRIGHT_REQUIRED"
        ? "JS_REQUIRED_UNRESOLVED"
        : "LISTINGS_SURFACE_UNRESOLVED";
    const failureReason =
      discoveryResolutionMethod === "PLAYWRIGHT_REQUIRED"
        ? "careers page requires JavaScript rendering which could not be completed"
        : discoveryResolutionMethod === "INDIRECT"
          ? "careers page has ATS-embedded listings that could not be resolved to a direct surface"
          : "careers page was found but no listings surface could be resolved from it";
    const computed = computeFinalStatus({
      careersUrl: careersUrl,
      extraction: {
        completed: false,
        failure_code: failureCode,
        failure_reason: failureReason,
      },
      matchCount: 0,
      // Resolution method forwarded so C5.1 can assert no weak resolution produces NO_MATCH.
      resolutionMethod: discoveryResolutionMethod,
    });
    finalizeAndCompleteRun({
      run_id,
      run_company_id,
      worker_token,
      now_ms: Date.now(),
      computed_status: computed.computed_status,
      careers_url: careersUrl,
      // R4.2: resolution produced no trustworthy surface — listings_url is null.
      // careers_url holds the entry point; listings_url null signals the resolver
      // could not advance beyond it (UNRESOLVED / INDIRECT / PLAYWRIGHT_REQUIRED).
      listings_url: null,
      ats_type: AtsType.UNKNOWN,
      extractor_used: null,
      listings_scanned: 0,
      pages_visited: 0,
      failure_code: computed.failure_code,
      failure_reason: computed.failure_reason,
      matchedJobs: [],
      // C6.2: resolution method forwarded so finalization trace documents the
      // resolution path (INDIRECT, UNRESOLVED, PLAYWRIGHT_REQUIRED) that caused
      // the early exit without reaching extraction.
      resolution_method: discoveryResolutionMethod,
      completion_reason: failureCode,
    });
    return;
  }

  let html = await fetchCareersHtml(extractionStartUrl);
  if (html === null) {
    html = "";
  }

  const detectedPlatform = detectPlatform(html, extractionStartUrl);

  const uAts = updateAtsType.run(
    detectedPlatform,
    run_company_id,
    CompanyStatus.IN_PROGRESS,
    worker_token
  );
  if (uAts.changes !== 1) {
    return;
  }

  writeTraceEvent({
    run_id,
    run_company_id,
    event_type: "platform_detected",
    message: "platform detection completed",
    payload_json: JSON.stringify({
      detected_platform: detectedPlatform,
    }),
    created_at: Date.now(),
  });

  if (!stillOwns(run_company_id, worker_token)) {
    return;
  }

  const extractorName = initialExtractorForAts(detectedPlatform);

  const uExt = updateExtractorUsed.run(
    extractorName,
    run_company_id,
    CompanyStatus.IN_PROGRESS,
    worker_token
  );
  if (uExt.changes !== 1) {
    return;
  }

  writeTraceEvent({
    run_id,
    run_company_id,
    event_type: "extractor_selected",
    message: "extractor selected",
    payload_json: JSON.stringify({
      extractor_used: extractorName,
    }),
    created_at: Date.now(),
  });

  if (!stillOwns(run_company_id, worker_token)) {
    return;
  }

  let extraction = await runTracedExtractorAttempt({
    run_id,
    run_company_id,
    url: extractionStartUrl,
    ats_type: detectedPlatform,
    extractor_used: extractorName,
    attempt_number: 1,
  });

  let finalExtractorUsed = extractorName;

  if (
    stillOwns(run_company_id, worker_token) &&
    shouldAttemptPlaywrightFallback(
      detectedPlatform,
      extractorName,
      extraction,
      discoveryResolutionMethod
    )
  ) {
    const uPw = updateExtractorUsed.run(
      EXTRACTOR_USED.PLAYWRIGHT,
      run_company_id,
      CompanyStatus.IN_PROGRESS,
      worker_token
    );
    if (uPw.changes !== 1) {
      return;
    }

    writeTraceEvent({
      run_id,
      run_company_id,
      event_type: "extractor_selected",
      message: "extractor selected",
      payload_json: JSON.stringify({
        extractor_used: EXTRACTOR_USED.PLAYWRIGHT,
      }),
      created_at: Date.now(),
    });

    if (!stillOwns(run_company_id, worker_token)) {
      return;
    }

    extraction = await runTracedExtractorAttempt({
      run_id,
      run_company_id,
      url: extractionStartUrl,
      ats_type: detectedPlatform,
      extractor_used: EXTRACTOR_USED.PLAYWRIGHT,
      attempt_number: 2,
    });
    finalExtractorUsed = EXTRACTOR_USED.PLAYWRIGHT;
  }

  // C4.1: Defense-in-depth — extraction must not be treated as complete on a
  // weak or unresolved discovery surface. Listings-surface confidence itself
  // is enforced inside extraction via `isConfidentListingsSurface` (not raw job
  // count). INDIRECT / UNRESOLVED / PLAYWRIGHT_REQUIRED are excluded and should
  // never reach this point.
  const isExtractionContextTrustworthy =
    discoveryResolutionMethod === "DIRECT_VERIFIED" ||
    discoveryResolutionMethod === "ATS_RESOLVED" ||
    discoveryResolutionMethod === "CTA_RESOLVED";

  if (extraction.completed) {
    if (!isExtractionContextTrustworthy) {
      extraction = {
        ...extraction,
        completed: false,
        failure_code: "WEAK_SURFACE",
        failure_reason: "extraction context is not a trustworthy listings surface",
      };
    }
  }

  const roleRow = selectRoleSpecJson.get(run_id) as { j: string } | undefined;
  const roleSpec = roleRow ? parseRoleSpec(roleRow.j) : null;

  // Step 8.4: if extraction completed but role spec is unavailable (DB anomaly),
  // matching cannot be performed. Treat the outcome as uncertain → UNVERIFIED.
  // Passing completed=false prevents NO_MATCH_SCAN_COMPLETED from being assigned
  // when matching was never actually evaluated.
  const extractionForFinalization =
    extraction.completed && roleSpec === null
      ? {
          completed: false as const,
          failure_code: "ROLE_SPEC_UNAVAILABLE",
          failure_reason: "role spec unavailable for matching",
        }
      : extraction;

  const matched =
    extractionForFinalization.completed && roleSpec
      ? matchJobs(extraction.jobs, roleSpec)
      : [];

  const computed = computeFinalStatus({
    careersUrl: careersUrl,
    extraction: extractionForFinalization,
    matchCount: matched.length,
    // C5.1: Forward resolution method so finalization can independently
    // enforce that weak/unresolved resolution cannot produce NO_MATCH_SCAN_COMPLETED.
    resolutionMethod: discoveryResolutionMethod,
  });

  // D6.1: when the company ends up UNVERIFIED and discovery already determined
  // that the listings surface could not be resolved, replace the extraction-level
  // failure code with a more specific discovery failure code so the UI / CSV can
  // show the root cause rather than a downstream extraction error.
  let finalFailureCode = computed.failure_code;
  let finalFailureReason = computed.failure_reason;
  if (computed.computed_status === CompanyStatus.UNVERIFIED) {
    if (discoveryResolutionMethod === "UNRESOLVED") {
      finalFailureCode = "LISTINGS_SURFACE_UNRESOLVED";
      finalFailureReason =
        "careers page was found but no listings surface could be resolved from it";
    } else if (discoveryResolutionMethod === "PLAYWRIGHT_REQUIRED") {
      finalFailureCode = "JS_REQUIRED_UNRESOLVED";
      finalFailureReason =
        "careers page requires JavaScript rendering which could not be completed";
    }
  }

  if (!stillOwns(run_company_id, worker_token)) {
    return;
  }

  finalizeAndCompleteRun({
    run_id,
    run_company_id,
    worker_token,
    now_ms: Date.now(),
    computed_status: computed.computed_status,
    careers_url: careersUrl,
    // R4.2: Pass the resolved listings surface so the finalization_outcome trace
    // records the exact URL extraction ran on.  listingsUrl is always non-null
    // here — the extractionStartUrl === null guard above ensures we only reach
    // this point when a strong listings surface was confirmed by the resolver.
    //
    // For DIRECT_VERIFIED: listings_url === careers_url (same page, both recorded).
    // For ATS_RESOLVED / CTA_RESOLVED: listings_url differs from careers_url,
    // making the one-hop resolution explicit and inspectable in the trace.
    listings_url: listingsUrl,
    ats_type: detectedPlatform,
    extractor_used: finalExtractorUsed,
    listings_scanned: extraction.listings_scanned,
    pages_visited: extraction.pages_visited,
    failure_code: finalFailureCode,
    failure_reason: finalFailureReason,
    matchedJobs:
      computed.computed_status === CompanyStatus.MATCHES_FOUND ? matched : [],
    // C6.2: resolution method forwarded so finalization trace documents the path
    // taken through the resolver (DIRECT_VERIFIED, ATS_RESOLVED, CTA_RESOLVED, etc.).
    // DIRECT_VERIFIED only appears here for strong surfaces — weak surfaces exit
    // earlier (extractionStartUrl === null guard) and never reach this point.
    resolution_method: discoveryResolutionMethod,
    completion_reason: deriveCompletionReason(extractionForFinalization),
  });
}
