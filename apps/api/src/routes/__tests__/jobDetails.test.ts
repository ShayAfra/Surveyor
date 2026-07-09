/**
 * Gate 3 endpoint tests:
 *   - GET /api/runs/:runId includes job_detail_available / failure fields,
 *     and does not include description_text.
 *   - GET /api/jobs/:jobRowId/detail returns full detail or 404.
 *
 * Isolation: vitest.config.ts sets DB_PATH=:memory: so each test worker gets a
 * fresh in-memory SQLite DB. NODE_ENV=test prevents server.ts from starting
 * the worker loop or binding a port.
 */

import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { app } from "../../server.js";
import { db } from "../../db/db.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const runId of cleanup.splice(0)) {
    db.prepare("DELETE FROM job_details WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM trace_events WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM job_rows WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM run_companies WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
  }
});

function insertCompletedRunWithMatch(runId: string, companyId: string, jobId: string): void {
  db.prepare(
    `INSERT INTO runs (id, created_at, status, role_raw, include_adjacent, company_count)
     VALUES (?, ?, 'COMPLETED', 'Software Engineer', 0, 1)`
  ).run(runId, Date.now());

  db.prepare(
    `INSERT INTO run_companies (id, run_id, company_name, input_index, status, created_at)
     VALUES (?, ?, 'Acme', 0, 'MATCHES_FOUND', ?)`
  ).run(companyId, runId, Date.now());

  db.prepare(
    `INSERT INTO job_rows (id, run_id, company_id, title, location, url, match_reason)
     VALUES (?, ?, ?, 'Software Engineer', 'Remote', 'https://boards.greenhouse.io/acme/1', 'Matched inclusion phrase Software Engineer')`
  ).run(jobId, runId, companyId);
}

describe("GET /api/runs/:runId — job detail fields", () => {
  it("job_detail_available is false and failure fields are null when no job_details row exists", async () => {
    const runId = randomUUID();
    const companyId = randomUUID();
    const jobId = randomUUID();
    cleanup.push(runId);
    insertCompletedRunWithMatch(runId, companyId, jobId);

    const res = await request(app).get(`/api/runs/${runId}`);

    expect(res.status).toBe(200);
    const job = res.body.matched_jobs[0];
    expect(job.job_detail_available).toBe(false);
    expect(job.job_detail_failure_code).toBeNull();
    expect(job.job_detail_failure_reason).toBeNull();
    expect(job.description_text).toBeUndefined();
  });

  it("job_detail_available is true when description_text is non-empty", async () => {
    const runId = randomUUID();
    const companyId = randomUUID();
    const jobId = randomUUID();
    cleanup.push(runId);
    insertCompletedRunWithMatch(runId, companyId, jobId);

    db.prepare(
      `INSERT INTO job_details (id, run_id, company_id, job_row_id, job_url, description_text, fetched_at, failure_code, failure_reason, created_at)
       VALUES (?, ?, ?, ?, ?, 'Full job description text.', ?, NULL, NULL, ?)`
    ).run(randomUUID(), runId, companyId, jobId, "https://boards.greenhouse.io/acme/1", Date.now(), Date.now());

    const res = await request(app).get(`/api/runs/${runId}`);

    const job = res.body.matched_jobs[0];
    expect(job.job_detail_available).toBe(true);
    expect(job.job_detail_failure_code).toBeNull();
    expect(job.job_detail_failure_reason).toBeNull();
    expect(job.description_text).toBeUndefined();
  });

  it("job_detail_available is false and failure fields are populated when fetch failed", async () => {
    const runId = randomUUID();
    const companyId = randomUUID();
    const jobId = randomUUID();
    cleanup.push(runId);
    insertCompletedRunWithMatch(runId, companyId, jobId);

    db.prepare(
      `INSERT INTO job_details (id, run_id, company_id, job_row_id, job_url, description_text, fetched_at, failure_code, failure_reason, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, 'JOB_DETAIL_BLOCKED', 'job detail fetch was blocked', ?)`
    ).run(randomUUID(), runId, companyId, jobId, "https://boards.greenhouse.io/acme/1", Date.now(), Date.now());

    const res = await request(app).get(`/api/runs/${runId}`);

    const job = res.body.matched_jobs[0];
    expect(job.job_detail_available).toBe(false);
    expect(job.job_detail_failure_code).toBe("JOB_DETAIL_BLOCKED");
    expect(job.job_detail_failure_reason).toBe("job detail fetch was blocked");
  });
});

describe("GET /api/jobs/:jobRowId/detail", () => {
  it("returns full detail when a job_details row exists", async () => {
    const runId = randomUUID();
    const companyId = randomUUID();
    const jobId = randomUUID();
    cleanup.push(runId);
    insertCompletedRunWithMatch(runId, companyId, jobId);

    const fetchedAt = Date.now();
    db.prepare(
      `INSERT INTO job_details (id, run_id, company_id, job_row_id, job_url, description_text, fetched_at, failure_code, failure_reason, created_at)
       VALUES (?, ?, ?, ?, ?, 'Full job description text.', ?, NULL, NULL, ?)`
    ).run(randomUUID(), runId, companyId, jobId, "https://boards.greenhouse.io/acme/1", fetchedAt, Date.now());

    const res = await request(app).get(`/api/jobs/${jobId}/detail`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      job_row_id: jobId,
      job_url: "https://boards.greenhouse.io/acme/1",
      description_text: "Full job description text.",
      failure_code: null,
      failure_reason: null,
      fetched_at: fetchedAt,
    });
  });

  it("returns 404 when no job_details row exists for the jobRowId", async () => {
    const runId = randomUUID();
    const companyId = randomUUID();
    const jobId = randomUUID();
    cleanup.push(runId);
    insertCompletedRunWithMatch(runId, companyId, jobId);

    const res = await request(app).get(`/api/jobs/${jobId}/detail`);

    expect(res.status).toBe(404);
  });

  it("returns 404 for a completely unknown jobRowId", async () => {
    const res = await request(app).get(`/api/jobs/${randomUUID()}/detail`);
    expect(res.status).toBe(404);
  });
});
