import { CompanyStatus, RunStatus } from "@surveyor/shared";
import { db } from "../db/db.js";
import { generateRoleSpec } from "../lib/roleSpec.js";
import { writeTraceEvent } from "../lib/trace.js";

export const ROLE_SPEC_TIMEOUT_MS = 30000;

const selectCandidateRun = db.prepare(`
  SELECT id FROM runs
  WHERE status = ?
    AND role_spec_json IS NULL
    AND (
      role_spec_started_at IS NULL
      OR role_spec_started_at < ?
    )
  ORDER BY created_at ASC, id ASC
  LIMIT 1
`);

const claimRunForRoleSpec = db.prepare(`
  UPDATE runs
  SET role_spec_started_at = ?
  WHERE id = ?
    AND status = ?
    AND role_spec_json IS NULL
    AND (
      role_spec_started_at IS NULL
      OR role_spec_started_at < ?
    )
`);

const loadRunForStub = db.prepare(`
  SELECT role_raw, include_adjacent FROM runs WHERE id = ?
`);

const persistRoleSpecFailure = db.prepare(`
  UPDATE runs
  SET status = ?,
      error_code = ?,
      error_message = ?,
      role_spec_started_at = NULL
  WHERE id = ?
`);

const cancelPendingCompaniesOnRoleSpecFailure = db.prepare(`
  UPDATE run_companies
  SET status = ?,
      finished_at = ?,
      failure_code = ?,
      failure_reason = ?,
      worker_token = NULL
  WHERE run_id = ?
    AND status = ?
`);

const persistRoleSpecSuccess = db.prepare(`
  UPDATE runs
  SET role_spec_json = ?,
      status = ?,
      role_spec_started_at = NULL
  WHERE id = ?
`);

/**
 * Attempts at most one role-spec initialization per tick: stale-safe claim, LLM generation, then durable success or failure + trace.
 */
export async function processRoleSpecInitialization(): Promise<void> {
  const claimTx = db.transaction((): string | null => {
    const selectThreshold = Date.now() - ROLE_SPEC_TIMEOUT_MS;
    const row = selectCandidateRun.get(RunStatus.CREATED, selectThreshold) as { id: string } | undefined;
    if (!row) {
      return null;
    }

    const now_ms = Date.now();
    const updateThreshold = now_ms - ROLE_SPEC_TIMEOUT_MS;
    const info = claimRunForRoleSpec.run(now_ms, row.id, RunStatus.CREATED, updateThreshold);
    if (info.changes !== 1) {
      return null;
    }

    return row.id;
  });

  const runId = claimTx();
  if (!runId) {
    return;
  }

  const runRow = loadRunForStub.get(runId) as
    | { role_raw: string; include_adjacent: number }
    | undefined;

  if (!runRow) {
    return;
  }

  const includeAdjacent = runRow.include_adjacent === 1;
  let roleSpecJsonString: string;
  try {
    const roleSpec = await generateRoleSpec({ role_raw: runRow.role_raw, include_adjacent: includeAdjacent });
    roleSpecJsonString = JSON.stringify(roleSpec);
  } catch {
    persistFailureAndTrace(runId);
    return;
  }

  try {
    db.transaction(() => {
      const info = persistRoleSpecSuccess.run(roleSpecJsonString, RunStatus.READY, runId);
      if (info.changes !== 1) {
        throw new Error("role spec success update expected 1 row");
      }
    })();
  } catch {
    return;
  }

  writeTraceEvent({
    run_id: runId,
    run_company_id: null,
    event_type: "role_spec_success",
    message: "role spec generation succeeded",
    payload_json: JSON.stringify({ role_spec_json: roleSpecJsonString }),
    created_at: Date.now(),
  });
}

function persistFailureAndTrace(runId: string): void {
  const failTx = db.transaction(() => {
    const now_ms = Date.now();
    persistRoleSpecFailure.run(
      RunStatus.FAILED_ROLE_SPEC,
      "ROLE_SPEC_FAILED",
      "role spec generation failed",
      runId
    );
    cancelPendingCompaniesOnRoleSpecFailure.run(
      CompanyStatus.CANCELLED,
      now_ms,
      "ROLE_SPEC_FAILED",
      "role spec generation failed",
      runId,
      CompanyStatus.PENDING
    );
  });

  try {
    failTx();
  } catch {
    return;
  }

  writeTraceEvent({
    run_id: runId,
    run_company_id: null,
    event_type: "role_spec_failure",
    message: "role spec generation failed",
    payload_json: JSON.stringify({ error_code: "ROLE_SPEC_FAILED" }),
    created_at: Date.now(),
  });
}
