import express from "express";
import 'dotenv/config';
import { CompanyStatus, RunStatus } from "@surveyor/shared";
import { randomUUID } from "node:crypto";
import { db } from "./db/db.js";
import type { JobRowResponse, RunCompanyResponse, RunDetailResponse, RunResponse } from "@surveyor/shared";
import { runRestartRecovery } from "./worker/restartRecovery.js";
import { startWorkerLoop } from "./worker/startWorkerLoop.js";

const app = express();
const PORT = Number(process.env.PORT ?? "3000");

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/runs", (req, res) => {
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
      error_message
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL)
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
      trimmedCompanies.length
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

app.get("/api/runs/:runId", (req, res) => {
  const { runId } = req.params;

  const runRow = db
    .prepare(
      `
      SELECT id, status, role_raw, include_adjacent, error_code, error_message
      FROM runs
      WHERE id = ?
      `
    )
    .get(runId) as
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

  const matchedJobs = db
    .prepare(
      `
      SELECT
        job_rows.id,
        job_rows.run_id,
        job_rows.company_id,
        job_rows.title,
        job_rows.location,
        job_rows.url,
        job_rows.match_reason
      FROM job_rows
      JOIN run_companies ON run_companies.id = job_rows.company_id
      WHERE job_rows.run_id = ?
      ORDER BY run_companies.input_index ASC, job_rows.id ASC
      `
    )
    .all(runId) as JobRowResponse[];

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

app.listen(PORT, () => {
  runRestartRecovery();
  startWorkerLoop();
});
