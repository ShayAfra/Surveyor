import { randomUUID } from "node:crypto";
import { CompanyStatus, RunStatus } from "@surveyor/shared";
import { db } from "../db/db.js";
import { processClaimedCompany } from "./processClaimedCompany.js";

const countCompaniesInProgress = db.prepare(`
  SELECT COUNT(*) AS n
  FROM run_companies
  WHERE status = ?
`);

const selectNextEligible = db.prepare(`
  SELECT run_companies.id AS id,
         run_companies.run_id AS run_id,
         run_companies.company_name AS company_name
  FROM run_companies
  JOIN runs ON runs.id = run_companies.run_id
  WHERE run_companies.status = ?
    AND runs.status IN (?, ?)
    AND runs.role_spec_json IS NOT NULL
  ORDER BY runs.created_at ASC, run_companies.input_index ASC, run_companies.id ASC
  LIMIT 1
`);

const claimRunCompany = db.prepare(`
  UPDATE run_companies
  SET status = ?,
      started_at = ?,
      worker_token = ?
  WHERE id = ?
    AND status = ?
`);

const transitionRunReadyToRunning = db.prepare(`
  UPDATE runs
  SET status = ?
  WHERE id = ?
    AND status = ?
`);

/**
 * Atomically claims at most one eligible run_company per call (roadmap Step 3.3).
 * Eligibility: company PENDING, run READY|RUNNING, role_spec_json NOT NULL.
 * Ordering: runs.created_at ASC, run_companies.input_index ASC, run_companies.id ASC.
 * Concurrency (roadmap Step 3.4): at most two companies IN_PROGRESS globally; skip claiming when already at cap.
 */
export function tryClaimNextCompany(): void {
  const inProgressRow = countCompaniesInProgress.get(
    CompanyStatus.IN_PROGRESS
  ) as { n: number } | undefined;
  const inProgressCount = inProgressRow?.n ?? 0;
  if (inProgressCount >= 2) {
    return;
  }

  let claimed: {
    run_id: string;
    run_company_id: string;
    company_name: string;
    worker_token: string;
  } | null = null;

  db.transaction(() => {
    const row = selectNextEligible.get(
      CompanyStatus.PENDING,
      RunStatus.READY,
      RunStatus.RUNNING
    ) as { id: string; run_id: string; company_name: string } | undefined;

    if (!row) {
      return;
    }

    const now_ms = Date.now();
    const worker_token_value = randomUUID();

    const claimInfo = claimRunCompany.run(
      CompanyStatus.IN_PROGRESS,
      now_ms,
      worker_token_value,
      row.id,
      CompanyStatus.PENDING
    );

    if (claimInfo.changes !== 1) {
      return;
    }

    transitionRunReadyToRunning.run(RunStatus.RUNNING, row.run_id, RunStatus.READY);

    claimed = {
      run_id: row.run_id,
      run_company_id: row.id,
      company_name: row.company_name,
      worker_token: worker_token_value,
    };
  })();

  if (claimed) {
    void processClaimedCompany(claimed).catch((err) => {
      console.error("[worker] processClaimedCompany failed", err);
    });
  }
}
