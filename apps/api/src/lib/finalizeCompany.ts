/**
 * Roadmap Step 6.6: atomic matched-job insert + company row finalization.
 * Roadmap Step 6.7: `computeFinalStatus` — ordered outcome logic only; callers pass
 * `computed_status` and evidence into `persistFinalizeCompany` (Step 6.6).
 */

import { randomUUID } from "node:crypto";
import { CompanyStatus } from "@surveyor/shared";
import type { AtsType } from "@surveyor/shared";
import { db } from "../db/db.js";
import { writeTraceEvent } from "./trace.js";
import type { ExtractJobsResult } from "./extraction.js";
import type { MatchedJob } from "./matching.js";

/** Step 6.6: ownership check must match spec WHERE status = 'IN_PROGRESS' + worker_token. */
const verifyOwnershipStmt = db.prepare(`
  SELECT id
  FROM run_companies
  WHERE id = ?
    AND status = 'IN_PROGRESS'
    AND worker_token = ?
`);

const insertJobStmt = db.prepare(`
  INSERT INTO job_rows (id, run_id, company_id, title, location, url, match_reason)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const finalizeCompanyStmt = db.prepare(`
  UPDATE run_companies
  SET status = ?,
      finished_at = ?,
      careers_url = ?,
      ats_type = ?,
      extractor_used = ?,
      listings_scanned = ?,
      pages_visited = ?,
      failure_code = ?,
      failure_reason = ?,
      worker_token = NULL
  WHERE id = ?
    AND status = 'IN_PROGRESS'
    AND worker_token = ?
`);

/**
 * C5.1 / R4.1: Resolution methods that are considered strong — the resolver
 * confirmed a trustworthy listings surface is directly reachable.
 *
 * Any other resolution_method (INDIRECT, UNRESOLVED, PLAYWRIGHT_REQUIRED, null)
 * is weak or unresolved and MUST NOT produce NO_MATCH_SCAN_COMPLETED.
 */
const STRONG_RESOLUTION_METHODS = new Set([
  "DIRECT_VERIFIED",
  "ATS_RESOLVED",
  "CTA_RESOLVED",
]);

export type FinalizeComputationInput = {
  careersUrl: string | null;
  extraction: Pick<
    ExtractJobsResult,
    "completed" | "failure_code" | "failure_reason"
  >;
  matchCount: number;
  /**
   * C5.1: The resolution_method forwarded from discovery/resolver output.
   * null when no resolution was attempted (e.g. discovery failed entirely).
   *
   * Used by assertFinalOutcomeRules to enforce: weak or unresolved resolution
   * cannot produce NO_MATCH_SCAN_COMPLETED.
   */
  resolutionMethod: string | null;
};

/**
 * Step 8.4 + C5.1: absolute outcome enforcement.
 *
 * Step 8.4 rules (ABSOLUTE):
 * - completed = false → MUST be UNVERIFIED
 * - NO_MATCH_SCAN_COMPLETED ONLY when: completed = true AND matchCount = 0
 *
 * C5.1 rule (ABSOLUTE):
 * - IF resolution is weak or unresolved (resolutionMethod not in STRONG_RESOLUTION_METHODS)
 *   THEN status MUST be UNVERIFIED — weak resolution cannot produce NO_MATCH_SCAN_COMPLETED.
 *   "No Match" must never be claimed without strong enumeration from a trustworthy surface.
 *
 * This is a defence-in-depth guard: upstream code (C3.2 / C4.1) is already
 * responsible for forcing extraction.completed = false when resolution is weak,
 * so that rule (step 8.4 line 1) catches most violations first. The C5.1 check
 * is an independent assertion that fires even if upstream correctness regresses.
 *
 * Called at the end of computeFinalStatus to guard against future drift.
 * Throws if the computed result violates any documented contract.
 */
function assertFinalOutcomeRules(
  result: {
    computed_status:
      | typeof CompanyStatus.MATCHES_FOUND
      | typeof CompanyStatus.NO_MATCH_SCAN_COMPLETED
      | typeof CompanyStatus.UNVERIFIED;
  },
  extraction_completed: boolean,
  matchCount: number,
  resolutionMethod: string | null
): void {
  if (
    !extraction_completed &&
    result.computed_status !== CompanyStatus.UNVERIFIED
  ) {
    throw new Error(
      `[Step 8.4] outcome enforcement violation: extraction completed=false but computed_status=${result.computed_status}`
    );
  }
  if (
    result.computed_status === CompanyStatus.NO_MATCH_SCAN_COMPLETED &&
    (!extraction_completed || matchCount !== 0)
  ) {
    throw new Error(
      `[Step 8.4] outcome enforcement violation: NO_MATCH_SCAN_COMPLETED requires completed=true AND matchCount=0 (got completed=${extraction_completed}, matchCount=${matchCount})`
    );
  }

  // C5.1: Weak or unresolved resolution must NEVER produce NO_MATCH_SCAN_COMPLETED.
  // Strong resolution methods are those where the resolver confirmed a trustworthy
  // listings surface is directly reachable.  Everything else (INDIRECT, UNRESOLVED,
  // PLAYWRIGHT_REQUIRED, null) is uncertain and must resolve to UNVERIFIED.
  const isResolutionStrong =
    resolutionMethod !== null && STRONG_RESOLUTION_METHODS.has(resolutionMethod);
  if (
    !isResolutionStrong &&
    result.computed_status === CompanyStatus.NO_MATCH_SCAN_COMPLETED
  ) {
    throw new Error(
      `[Step C5.1] outcome enforcement violation: resolution_method=${resolutionMethod ?? "null"} is weak or unresolved but computed_status=${result.computed_status}; system must not claim NO_MATCH_SCAN_COMPLETED without strong enumeration`
    );
  }

  // R5.2: Weak or unresolved resolution must NEVER produce MATCHES_FOUND.
  //
  // If deeper resolution did not reach a trustworthy listings surface
  // (resolution_method not in STRONG_RESOLUTION_METHODS), the outcome
  // must be UNVERIFIED regardless of what the extractor returned.
  //
  // Defense-in-depth: processClaimedCompany.ts forces extraction.completed=false
  // for non-strong resolution contexts (isExtractionContextTrustworthy guard),
  // which means Step 8.4 check 1 above catches most violations first.
  // This assertion is an independent safety net that fires even if that upstream
  // guard regresses — ensuring "false completion" is impossible at the boundary.
  if (
    !isResolutionStrong &&
    result.computed_status === CompanyStatus.MATCHES_FOUND
  ) {
    throw new Error(
      `[Step R5.2] outcome enforcement violation: resolution_method=${resolutionMethod ?? "null"} is not a strong resolution but computed_status=${result.computed_status}; uncertain resolution must not claim matches found`
    );
  }
}

/**
 * Step 6.7 finalization order (authoritative):
 * 1. No careers URL → UNVERIFIED
 * 2. Extraction not completed → UNVERIFIED
 * 3. matches > 0 → MATCHES_FOUND
 * 4. else → NO_MATCH_SCAN_COMPLETED
 *
 * For UNVERIFIED, failure_code and failure_reason are always non-null strings
 * (required for persistence and finalization_outcome when status is UNVERIFIED).
 *
 * Step 8.4 enforcement is asserted after each return path.
 */
export function computeFinalStatus(input: FinalizeComputationInput): {
  computed_status: typeof CompanyStatus.MATCHES_FOUND | typeof CompanyStatus.NO_MATCH_SCAN_COMPLETED | typeof CompanyStatus.UNVERIFIED;
  failure_code: string | null;
  failure_reason: string | null;
} {
  const careersUrlPresent =
    typeof input.careersUrl === "string" && input.careersUrl.trim() !== "";

  if (!careersUrlPresent) {
    const result = {
      computed_status: CompanyStatus.UNVERIFIED,
      failure_code: "CAREERS_NOT_FOUND",
      failure_reason: "no authoritative careers URL could be discovered",
    } as const;
    assertFinalOutcomeRules(result, input.extraction.completed, input.matchCount, input.resolutionMethod);
    return result;
  }
  if (!input.extraction.completed) {
    const result = {
      computed_status: CompanyStatus.UNVERIFIED,
      failure_code: input.extraction.failure_code ?? "EXTRACTION_INCOMPLETE",
      failure_reason:
        input.extraction.failure_reason ?? "extraction did not complete",
    } as const;
    assertFinalOutcomeRules(result, input.extraction.completed, input.matchCount, input.resolutionMethod);
    return result;
  }
  if (input.matchCount > 0) {
    const result = {
      computed_status: CompanyStatus.MATCHES_FOUND,
      failure_code: null,
      failure_reason: null,
    } as const;
    assertFinalOutcomeRules(result, input.extraction.completed, input.matchCount, input.resolutionMethod);
    return result;
  }
  const result = {
    computed_status: CompanyStatus.NO_MATCH_SCAN_COMPLETED,
    failure_code: null,
    failure_reason: null,
  } as const;
  assertFinalOutcomeRules(result, input.extraction.completed, input.matchCount, input.resolutionMethod);
  return result;
}

export type FinalizePersistInput = {
  run_id: string;
  run_company_id: string;
  worker_token: string;
  now_ms: number;
  computed_status:
    | typeof CompanyStatus.MATCHES_FOUND
    | typeof CompanyStatus.NO_MATCH_SCAN_COMPLETED
    | typeof CompanyStatus.UNVERIFIED;
  careers_url: string | null;
  /**
   * R4.2: The resolved listings surface URL — the actual page extraction ran on.
   * Equals careers_url for DIRECT_VERIFIED (same page). Differs from careers_url
   * for ATS_RESOLVED and CTA_RESOLVED where a one-hop resolution found a deeper
   * surface. Null when resolution failed (UNRESOLVED, INDIRECT, PLAYWRIGHT_REQUIRED).
   *
   * Included in finalization_outcome trace so the final persisted event documents
   * which URL extraction actually started from, not just the discovery entry point.
   * careers_url and listings_url are kept distinct: they are never collapsed when
   * they represent different pages.
   */
  listings_url: string | null;
  ats_type: AtsType;
  extractor_used: string | null;
  listings_scanned: number;
  pages_visited: number;
  failure_code: string | null;
  failure_reason: string | null;
  matchedJobs: MatchedJob[];
  /**
   * C6.2: Resolution method forwarded from the discovery/resolver stage.
   * Included in finalization_outcome trace payload so the final trace event
   * documents the full resolution path without requiring cross-referencing
   * careers_url_selected.
   *
   * null when discovery failed before any resolution was attempted.
   * Otherwise one of: DIRECT_VERIFIED | ATS_RESOLVED | CTA_RESOLVED
   *                   PLAYWRIGHT_REQUIRED | UNRESOLVED | INDIRECT
   */
  resolution_method: string | null;
  /** Deterministic reason for the extraction completion decision. */
  completion_reason: string;
};

/**
 * Step 6.6: single transaction (verify ownership → optional job_rows → finalize row).
 * Step 6.7: emit exactly one `finalization_outcome` after this transaction COMMIT succeeds
 * (never on rollback); payload_json has only: computed_status, listings_scanned,
 * pages_visited, failure_code, failure_reason — values match what was persisted.
 *
 * @returns whether the company row was finalized by this worker
 */
export function persistFinalizeCompany(input: FinalizePersistInput): boolean {
  const {
    run_id,
    run_company_id,
    worker_token,
    now_ms,
    computed_status,
    careers_url,
    listings_url,
    ats_type,
    extractor_used,
    listings_scanned,
    pages_visited,
    failure_code,
    failure_reason,
    matchedJobs,
    resolution_method,
    completion_reason,
  } = input;

  const runFinalizeTx = db.transaction(() => {
    const rows = verifyOwnershipStmt.all(
      run_company_id,
      worker_token
    ) as { id: string }[];
    if (rows.length !== 1) {
      throw new Error("finalize_company_ownership_failed");
    }

    if (computed_status === CompanyStatus.MATCHES_FOUND) {
      for (const j of matchedJobs) {
        insertJobStmt.run(
          randomUUID(),
          run_id,
          run_company_id,
          j.title,
          j.location,
          j.url,
          j.match_reason
        );
      }
    }

    const info = finalizeCompanyStmt.run(
      computed_status,
      now_ms,
      careers_url,
      ats_type,
      extractor_used,
      listings_scanned,
      pages_visited,
      failure_code,
      failure_reason,
      run_company_id,
      worker_token
    );

    if (info.changes !== 1) {
      throw new Error("finalize_company_update_mismatch");
    }
  });

  try {
    runFinalizeTx();
  } catch {
    return false;
  }

  // C6.2: resolution_method is included so the finalization trace event
  // documents the full resolution path (DIRECT_VERIFIED, INDIRECT, UNRESOLVED, etc.)
  // without requiring correlation with the earlier careers_url_selected event.
  // This satisfies "traces show realistic resolution paths" and makes it
  // immediately visible that no weak surface produced DIRECT_VERIFIED.
  // R4.2: Include both careers_url (entry point) and listings_url (resolved
  // surface) so the finalization trace documents the full resolution truth.
  // When ATS_RESOLVED or CTA_RESOLVED succeeded, listings_url differs from
  // careers_url and shows exactly which page extraction ran on.  They are kept
  // as distinct fields — never collapsed — so inspectors can tell whether a
  // one-hop resolution was performed and where it landed.
  writeTraceEvent({
    run_id,
    run_company_id,
    event_type: "finalization_outcome",
    message: "company finalized",
    payload_json: JSON.stringify({
      computed_status,
      resolution_method,
      careers_url,
      listings_url,
      ats_type,
      extractor_used,
      listings_scanned,
      pages_visited,
      failure_code,
      failure_reason,
      match_count: matchedJobs.length,
      completion_reason,
    }),
    created_at: Date.now(),
  });

  return true;
}
