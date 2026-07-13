import { Router } from "express";
import type { RunCompanyResponse, RunDetailResponse, RunResponse } from "@surveyor/shared";
import type { RunStatus } from "@surveyor/shared";
import { db } from "../db/db.js";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import { CreateRunRequestError, createRunForUser } from "../lib/runs.js";

export const runsRouter = Router();

runsRouter.post("/api/runs", requireAuth, (req: AuthenticatedRequest, res) => {
  const { role, includeAdjacent, companies } = req.body ?? {};

  try {
    const { runId } = createRunForUser({
      userId: req.userId as string,
      role,
      includeAdjacent,
      companies,
    });
    return res.status(201).json({ runId });
  } catch (err) {
    if (err instanceof CreateRunRequestError) {
      return res.status(err.httpStatus).json({ error: err.message });
    }
    return res.status(500).json({ error: "failed to create run" });
  }
});

runsRouter.get("/api/runs/:runId", requireAuth, (req: AuthenticatedRequest, res) => {
  const { runId } = req.params;

  const runRow = db
    .prepare(
      `
      SELECT id, status, role_raw, include_adjacent, error_code, error_message
      FROM runs
      WHERE id = ? AND user_id = ?
      `
    )
    .get(runId, req.userId) as
    | {
        id: string;
        status: RunStatus;
        role_raw: string;
        include_adjacent: number;
        error_code: string | null;
        error_message: string | null;
      }
    | undefined;

  if (!runRow) {
    return res.status(404).json({ error: "run not found" });
  }

  const companies = db
    .prepare(
      `
      SELECT
        id,
        company_name,
        status,
        input_index,
        failure_code,
        failure_reason,
        careers_url,
        ats_type,
        extractor_used,
        listings_scanned,
        pages_visited
      FROM run_companies
      WHERE run_id = ?
      ORDER BY input_index ASC
      `
    )
    .all(runId) as RunCompanyResponse[];

  const matchedJobRows = db
    .prepare(
      `
      SELECT
        job_rows.id,
        job_rows.run_id,
        job_rows.company_id,
        job_rows.title,
        job_rows.location,
        job_rows.url,
        job_rows.match_reason,
        job_details.description_text AS detail_description_text,
        job_details.failure_code AS detail_failure_code,
        job_details.failure_reason AS detail_failure_reason
      FROM job_rows
      JOIN run_companies ON run_companies.id = job_rows.company_id
      LEFT JOIN job_details ON job_details.job_row_id = job_rows.id
      WHERE job_rows.run_id = ?
      ORDER BY run_companies.input_index ASC, job_rows.id ASC
      `
    )
    .all(runId) as {
      id: string;
      run_id: string;
      company_id: string;
      title: string;
      location: string | null;
      url: string;
      match_reason: string;
      detail_description_text: string | null;
      detail_failure_code: string | null;
      detail_failure_reason: string | null;
    }[];

  const matchedJobs = matchedJobRows.map((row) => {
    const jobDetailAvailable =
      typeof row.detail_description_text === "string" &&
      row.detail_description_text.length > 0;
    return {
      id: row.id,
      run_id: row.run_id,
      company_id: row.company_id,
      title: row.title,
      location: row.location,
      url: row.url,
      match_reason: row.match_reason,
      job_detail_available: jobDetailAvailable,
      job_detail_failure_code: jobDetailAvailable ? null : row.detail_failure_code,
      job_detail_failure_reason: jobDetailAvailable ? null : row.detail_failure_reason,
    };
  });

  const run: RunResponse = {
    id: runRow.id,
    status: runRow.status,
    role_raw: runRow.role_raw,
    include_adjacent: runRow.include_adjacent === 1,
    error_code: runRow.error_code,
    error_message: runRow.error_message,
  };

  const responseBody: RunDetailResponse = {
    run,
    companies,
    matched_jobs: matchedJobs,
  };

  return res.json(responseBody);
});
