/**
 * Run completion check (roadmap Step 3.6): COUNT non-final companies, then
 * transition run to COMPLETED when eligible; emit run_completed only if UPDATE changes === 1.
 * Invoked after each company finalization (Step 3.5) and once per worker tick for READY|RUNNING runs.
 */

import { CompanyStatus, RunStatus } from "@surveyor/shared";
import { db } from "../db/db.js";
import { writeTraceEvent } from "../lib/trace.js";

const countNonFinalCompanies = db.prepare(`
  SELECT COUNT(*) AS n
  FROM run_companies
  WHERE run_id = ?
    AND status NOT IN (?, ?, ?, ?)
`);

const transitionRunToCompleted = db.prepare(`
  UPDATE runs
  SET status = ?
  WHERE id = ?
    AND (status = ? OR status = ?)
`);

const selectReadyOrRunningRunIds = db.prepare(`
  SELECT id AS id
  FROM runs
  WHERE status IN (?, ?)
`);

export function tryCompleteRun(run_id: string): void {
  const row = countNonFinalCompanies.get(
    run_id,
    CompanyStatus.MATCHES_FOUND,
    CompanyStatus.NO_MATCH_SCAN_COMPLETED,
    CompanyStatus.UNVERIFIED,
    CompanyStatus.CANCELLED
  ) as { n: number } | undefined;
  if (!row || row.n !== 0) {
    return;
  }

  const info = transitionRunToCompleted.run(
    RunStatus.COMPLETED,
    run_id,
    RunStatus.RUNNING,
    RunStatus.READY
  );
  if (info.changes === 1) {
    writeTraceEvent({
      run_id,
      run_company_id: null,
      event_type: "run_completed",
      message: "run transitioned to COMPLETED",
      payload_json: null,
      created_at: Date.now(),
    });
  }
}

/** One completion pass per READY or RUNNING run each worker loop iteration (crash-safe). */
export function tryCompleteRunsForReadyOrRunning(): void {
  const rows = selectReadyOrRunningRunIds.all(
    RunStatus.READY,
    RunStatus.RUNNING
  ) as { id: string }[];
  for (const r of rows) {
    tryCompleteRun(r.id);
  }
}
