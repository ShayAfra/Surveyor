import { Router } from "express";
import type {
  RunCompanyResponse,
  RunDetailResponse,
  RunListItemResponse,
  RunListResponse,
  RunResponse,
} from "@surveyor/shared";
import type { RunStatus } from "@surveyor/shared";
import { CompanyStatus } from "@surveyor/shared";
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

/**
 * Owned run list for the returning-user "resume your work" surface. Read-only:
 * returns only the current user's runs (never accepts user_id from the client),
 * newest first with id as a deterministic tie-breaker. Company outcome counts
 * come from conditional aggregation over run_companies and preserve scanner
 * status meanings exactly — MATCHES_FOUND, NO_MATCH_SCAN_COMPLETED, and
 * UNVERIFIED each map to their own count; CANCELLED is deliberately not counted
 * as unverified. Ownerless (user_id IS NULL) legacy runs are excluded because
 * user_id = ? never matches NULL; the only convention that gives a user legacy
 * runs is the first-signup backfill in createUser(), which assigns real
 * ownership, so those already appear as owned runs here.
 */
runsRouter.get("/api/runs", requireAuth, (req: AuthenticatedRequest, res) => {
  const rows = db
    .prepare(
      `
      SELECT
        runs.id AS id,
        runs.status AS status,
        runs.role_raw AS role_raw,
        runs.include_adjacent AS include_adjacent,
        runs.created_at AS created_at,
        COUNT(run_companies.id) AS company_count,
        SUM(CASE WHEN run_companies.status = ? THEN 1 ELSE 0 END) AS matched_company_count,
        SUM(CASE WHEN run_companies.status = ? THEN 1 ELSE 0 END) AS no_match_company_count,
        SUM(CASE WHEN run_companies.status = ? THEN 1 ELSE 0 END) AS unverified_company_count
      FROM runs
      LEFT JOIN run_companies ON run_companies.run_id = runs.id
      WHERE runs.user_id = ?
      GROUP BY runs.id
      ORDER BY runs.created_at DESC, runs.id DESC
      `
    )
    .all(
      CompanyStatus.MATCHES_FOUND,
      CompanyStatus.NO_MATCH_SCAN_COMPLETED,
      CompanyStatus.UNVERIFIED,
      req.userId
    ) as {
      id: string;
      status: RunStatus;
      role_raw: string;
      include_adjacent: number;
      created_at: number;
      company_count: number;
      matched_company_count: number;
      no_match_company_count: number;
      unverified_company_count: number;
    }[];

  const responseBody: RunListResponse = rows.map(
    (row): RunListItemResponse => ({
      id: row.id,
      status: row.status,
      role_raw: row.role_raw,
      include_adjacent: row.include_adjacent === 1,
      created_at: row.created_at,
      company_count: Number(row.company_count) || 0,
      matched_company_count: Number(row.matched_company_count) || 0,
      no_match_company_count: Number(row.no_match_company_count) || 0,
      unverified_company_count: Number(row.unverified_company_count) || 0,
    })
  );

  return res.json(responseBody);
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
