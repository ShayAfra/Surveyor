import { Router } from "express";
import { CompanyStatus, RunStatus } from "@surveyor/shared";
import type { RunCompanyResponse, RunDetailResponse, RunResponse } from "@surveyor/shared";
import { randomUUID } from "node:crypto";
import { db } from "../db/db.js";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";

export const runsRouter = Router();

runsRouter.post("/api/runs", requireAuth, (req: AuthenticatedRequest, res) => {
  const { role, includeAdjacent, companies } = req.body ?? {};

  if (typeof role !== "string") {
    return res.status(400).json({ error: "role must be a string" });
  }

  if (typeof includeAdjacent !== "boolean") {
    return res.status(400).json({ error: "includeAdjacent must be a boolean" });
  }

  if (!Array.isArray(companies)) {
    return res.status(400).json({ error: "companies must be an array" });
  }

  const trimmedRole = role.trim();
  if (trimmedRole.length === 0) {
    return res.status(400).json({ error: "role must be non-empty after trimming" });
  }

  if (companies.length < 1 || companies.length > 10) {
    return res.status(400).json({ error: "companies must contain between 1 and 10 entries" });
  }

  const trimmedCompanies: string[] = [];
  for (const company of companies) {
    if (typeof company !== "string") {
      return res.status(400).json({ error: "each company must be a string" });
    }

    const trimmedCompany = company.trim();
    if (trimmedCompany.length === 0) {
      return res.status(400).json({ error: "company entries must be non-empty after trimming" });
    }

    trimmedCompanies.push(trimmedCompany);
  }

  const runId = randomUUID();
  const nowMs = Date.now();

  const insertRun = db.prepare(`
    INSERT INTO runs (
      id,
      created_at,
      status,
      role_raw,
      include_adjacent,
      role_spec_json,
      role_spec_started_at,
      company_count,
      error_code,
      error_message,
      user_id
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?)
  `);

  const insertCompany = db.prepare(`
    INSERT INTO run_companies (
      id,
      run_id,
      company_name,
      input_index,
      status,
      created_at,
      started_at,
      finished_at,
      worker_token,
      careers_url,
      ats_type,
      extractor_used,
      listings_scanned,
      pages_visited,
      failure_code,
      failure_reason
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
  `);

  const createRunTx = db.transaction(() => {
    insertRun.run(
      runId,
      nowMs,
      RunStatus.CREATED,
      role,
      includeAdjacent ? 1 : 0,
      trimmedCompanies.length,
      req.userId
    );

    for (let index = 0; index < trimmedCompanies.length; index += 1) {
      insertCompany.run(
        randomUUID(),
        runId,
        trimmedCompanies[index],
        index,
        CompanyStatus.PENDING,
        nowMs
      );
    }
  });

  try {
    createRunTx();
    return res.status(201).json({ runId });
  } catch {
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
