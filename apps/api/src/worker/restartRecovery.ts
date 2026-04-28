import { CompanyStatus, RunStatus } from "@surveyor/shared";
import { db } from "../db/db.js";
import { writeTraceEvent } from "../lib/trace.js";

/** Roadmap Step 5.1: stale IN_PROGRESS companies on active runs are reset after this age (unix ms). */
export const STALE_IN_PROGRESS_THRESHOLD_MS = 120000;

const reclaimStaleInProgressCompanies = db.prepare(`
  UPDATE run_companies
  SET status = ?,
      started_at = NULL,
      worker_token = NULL
  WHERE status = ?
    AND run_id IN (SELECT id FROM runs WHERE status IN (?, ?))
    AND started_at IS NOT NULL
    AND started_at < ?
  RETURNING id, run_id
`);

const clearStaleRoleSpecClaim = db.prepare(`
  UPDATE runs
  SET role_spec_started_at = NULL
  WHERE status = ?
    AND role_spec_json IS NULL
    AND role_spec_started_at IS NOT NULL
`);

/**
 * Roadmap Step 5.1: run once on API startup before the worker loop claims work.
 * Reclaims stale IN_PROGRESS companies on READY/RUNNING runs and clears stuck role_spec_started_at on CREATED runs.
 */
export function runRestartRecovery(): void {
  const now_ms = Date.now();
  const staleBeforeMs = now_ms - STALE_IN_PROGRESS_THRESHOLD_MS;

  const reclaimed = reclaimStaleInProgressCompanies.all(
    CompanyStatus.PENDING,
    CompanyStatus.IN_PROGRESS,
    RunStatus.READY,
    RunStatus.RUNNING,
    staleBeforeMs
  ) as { id: string; run_id: string }[];

  for (const row of reclaimed) {
    writeTraceEvent({
      run_id: row.run_id,
      run_company_id: row.id,
      event_type: "restart_recovery_reclaim",
      message: "stale in progress company reset to PENDING",
      payload_json: null,
      created_at: Date.now(),
    });
  }

  clearStaleRoleSpecClaim.run(RunStatus.CREATED);
}
