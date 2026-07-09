/**
 * Gate 3: job detail ingestion orchestrator (agentReadiness.md Step 3.3).
 *
 * Runs after company finalization has committed, for MATCHES_FOUND companies only.
 * Must never change company status or run_companies rows — the UNIQUE index on
 * job_details.job_row_id is the database-level idempotency guard; the existing-row
 * check here just avoids redundant fetches.
 */

import { randomUUID } from "node:crypto";
import { db } from "../db/db.js";
import { writeTraceEvent } from "./trace.js";
import { fetchJobDetailText } from "./jobDetails.js";

const selectMatchedJobRows = db.prepare(`
  SELECT id, url
  FROM job_rows
  WHERE run_id = ?
    AND company_id = ?
`);

const selectExistingJobDetail = db.prepare(`
  SELECT id FROM job_details WHERE job_row_id = ?
`);

const insertJobDetail = db.prepare(`
  INSERT INTO job_details (
    id, run_id, company_id, job_row_id, job_url,
    description_text, fetched_at, failure_code, failure_reason, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export type JobDetailIngestionResult = {
  attempted: number;
  inserted: number;
  skipped: number;
  failed: number;
};

function isUniqueJobRowIdConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" &&
    error.message.includes("job_row_id")
  );
}

function insertJobDetailRow(args: {
  run_id: string;
  company_id: string;
  job_row_id: string;
  job_url: string;
  description_text: string | null;
  fetched_at: number | null;
  failure_code: string | null;
  failure_reason: string | null;
}): boolean {
  try {
    insertJobDetail.run(
      randomUUID(),
      args.run_id,
      args.company_id,
      args.job_row_id,
      args.job_url,
      args.description_text,
      args.fetched_at,
      args.failure_code,
      args.failure_reason,
      Date.now()
    );
    return true;
  } catch (error) {
    // UNIQUE constraint race on job_row_id: another ingestion pass already
    // inserted this row. Treat as already-present and move on. Any other
    // insert failure is a real error and must not be silently swallowed.
    if (isUniqueJobRowIdConstraintError(error)) {
      return false;
    }
    throw error;
  }
}

export async function ingestJobDetailsForCompany(
  runId: string,
  companyId: string
): Promise<JobDetailIngestionResult> {
  const result: JobDetailIngestionResult = {
    attempted: 0,
    inserted: 0,
    skipped: 0,
    failed: 0,
  };

  let jobRows: { id: string; url: string }[];
  try {
    jobRows = selectMatchedJobRows.all(runId, companyId) as { id: string; url: string }[];
  } catch (error) {
    writeTraceEvent({
      run_id: runId,
      run_company_id: companyId,
      event_type: "job_detail_fetch_finished",
      message: "job detail ingestion failed to load matched job rows",
      payload_json: JSON.stringify({ error: String(error) }),
      created_at: Date.now(),
    });
    return result;
  }

  writeTraceEvent({
    run_id: runId,
    run_company_id: companyId,
    event_type: "job_detail_fetch_started",
    message: "job detail ingestion started",
    payload_json: JSON.stringify({ job_count: jobRows.length }),
    created_at: Date.now(),
  });

  for (const job of jobRows) {
    let countedAttempt = false;
    try {
      const existing = selectExistingJobDetail.get(job.id) as { id: string } | undefined;
      if (existing) {
        result.skipped += 1;
        continue;
      }

      result.attempted += 1;
      countedAttempt = true;
      const fetchResult = await fetchJobDetailText(job.url);
      const fetchedAt = Date.now();

      const didInsert = insertJobDetailRow({
        run_id: runId,
        company_id: companyId,
        job_row_id: job.id,
        job_url: job.url,
        description_text: fetchResult.description_text,
        fetched_at: fetchedAt,
        failure_code: fetchResult.failure_code,
        failure_reason: fetchResult.failure_reason,
      });

      if (didInsert) {
        result.inserted += 1;
        if (fetchResult.failure_code) {
          result.failed += 1;
        }
      } else {
        result.skipped += 1;
      }
    } catch {
      // Per-job unexpected exception: try to persist a failure row so the
      // matched job still has ingestion evidence, then continue the loop.
      // `attempted` may already have been incremented above before the throw,
      // so only count it here if that has not happened yet.
      if (!countedAttempt) {
        result.attempted += 1;
      }
      const didInsert = insertJobDetailRow({
        run_id: runId,
        company_id: companyId,
        job_row_id: job.id,
        job_url: job.url,
        description_text: null,
        fetched_at: Date.now(),
        failure_code: "JOB_DETAIL_FETCH_FAILED",
        failure_reason: "unexpected error during job detail ingestion",
      });
      if (didInsert) {
        result.inserted += 1;
        result.failed += 1;
      } else {
        result.skipped += 1;
      }
    }
  }

  writeTraceEvent({
    run_id: runId,
    run_company_id: companyId,
    event_type: "job_detail_fetch_finished",
    message: "job detail ingestion finished",
    payload_json: JSON.stringify(result),
    created_at: Date.now(),
  });

  return result;
}
