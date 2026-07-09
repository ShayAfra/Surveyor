/**
 * Gate 3 tests for ingestJobDetailsForCompany (jobDetailIngestion.ts).
 *
 * Isolation: vitest.config.ts sets DB_PATH=:memory: so this worker gets a
 * fresh in-memory SQLite DB with the schema already applied by db.ts import.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../../db/db.js";
import { ingestJobDetailsForCompany } from "../jobDetailIngestion.js";

let runId: string;
let companyId: string;

function insertRun(id: string): void {
  db.prepare(
    `INSERT INTO runs (id, created_at, status, role_raw, include_adjacent, company_count)
     VALUES (?, ?, 'COMPLETED', 'SWE', 0, 1)`
  ).run(id, Date.now());
}

function insertMatchesFoundCompany(id: string, rId: string): void {
  db.prepare(
    `INSERT INTO run_companies (id, run_id, company_name, input_index, status, created_at)
     VALUES (?, ?, 'Acme', 0, 'MATCHES_FOUND', ?)`
  ).run(id, rId, Date.now());
}

function insertJobRow(id: string, rId: string, cId: string, url: string): void {
  db.prepare(
    `INSERT INTO job_rows (id, run_id, company_id, title, location, url, match_reason)
     VALUES (?, ?, ?, 'Software Engineer', 'Remote', ?, 'Matched inclusion phrase Software Engineer')`
  ).run(id, rId, cId, url);
}

beforeEach(() => {
  runId = randomUUID();
  companyId = randomUUID();
  insertRun(runId);
  insertMatchesFoundCompany(companyId, runId);
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.prepare("DELETE FROM job_details WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM trace_events WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM job_rows WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM run_companies WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
});

function stubFetchOk(html = "<html><body><p>Great job description text.</p></body></html>"): void {
  vi.stubGlobal("fetch", async () => new Response(html, { status: 200 }));
}

function stubFetchFail(status = 500): void {
  vi.stubGlobal("fetch", async () => new Response("error", { status }));
}

describe("ingestJobDetailsForCompany", () => {
  it("creates job_details rows for matched jobs", async () => {
    const jobId = randomUUID();
    insertJobRow(jobId, runId, companyId, "https://example.com/jobs/1");
    stubFetchOk();

    const result = await ingestJobDetailsForCompany(runId, companyId);

    expect(result.attempted).toBe(1);
    expect(result.inserted).toBe(1);

    const row = db.prepare("SELECT * FROM job_details WHERE job_row_id = ?").get(jobId) as
      | { description_text: string | null; failure_code: string | null }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.description_text).toContain("Great job description text.");
    expect(row?.failure_code).toBeNull();
  });

  it("stores failure_code/failure_reason when fetch fails", async () => {
    const jobId = randomUUID();
    insertJobRow(jobId, runId, companyId, "https://example.com/jobs/2");
    stubFetchFail(500);

    const result = await ingestJobDetailsForCompany(runId, companyId);

    expect(result.failed).toBe(1);

    const row = db.prepare("SELECT * FROM job_details WHERE job_row_id = ?").get(jobId) as
      | { description_text: string | null; failure_code: string | null; failure_reason: string | null }
      | undefined;
    expect(row?.description_text).toBeNull();
    expect(row?.failure_code).toBe("JOB_DETAIL_FETCH_FAILED");
    expect(row?.failure_reason).not.toBeNull();
  });

  it("company status remains MATCHES_FOUND even if all detail fetches fail", async () => {
    const jobId = randomUUID();
    insertJobRow(jobId, runId, companyId, "https://example.com/jobs/3");
    stubFetchFail(403);

    await ingestJobDetailsForCompany(runId, companyId);

    const company = db.prepare("SELECT status FROM run_companies WHERE id = ?").get(companyId) as
      | { status: string }
      | undefined;
    expect(company?.status).toBe("MATCHES_FOUND");
  });

  it("running ingestion twice creates no duplicate job_details rows", async () => {
    const jobId = randomUUID();
    insertJobRow(jobId, runId, companyId, "https://example.com/jobs/4");
    stubFetchOk();

    await ingestJobDetailsForCompany(runId, companyId);
    const second = await ingestJobDetailsForCompany(runId, companyId);

    expect(second.skipped).toBe(1);
    expect(second.inserted).toBe(0);

    const rows = db.prepare("SELECT * FROM job_details WHERE job_row_id = ?").all(jobId);
    expect(rows).toHaveLength(1);
  });

  it("skips fetching for a job_row_id that already has a job_details row", async () => {
    const jobId = randomUUID();
    insertJobRow(jobId, runId, companyId, "https://example.com/jobs/5");
    db.prepare(
      `INSERT INTO job_details (id, run_id, company_id, job_row_id, job_url, description_text, fetched_at, failure_code, failure_reason, created_at)
       VALUES (?, ?, ?, ?, ?, 'existing text', ?, NULL, NULL, ?)`
    ).run(randomUUID(), runId, companyId, jobId, "https://example.com/jobs/5", Date.now(), Date.now());

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await ingestJobDetailsForCompany(runId, companyId);

    expect(result.skipped).toBe(1);
    expect(result.attempted).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("handles a unique constraint race by treating the row as skipped", async () => {
    const jobId = randomUUID();
    insertJobRow(jobId, runId, companyId, "https://example.com/jobs/6");
    stubFetchOk();

    // Simulate a concurrent ingestion pass inserting the row after the
    // existing-row check but before this pass's insert.
    db.prepare(
      `INSERT INTO job_details (id, run_id, company_id, job_row_id, job_url, description_text, fetched_at, failure_code, failure_reason, created_at)
       VALUES (?, ?, ?, ?, ?, 'raced text', ?, NULL, NULL, ?)`
    ).run(randomUUID(), runId, companyId, jobId, "https://example.com/jobs/6", Date.now(), Date.now());

    const rowsBefore = db.prepare("SELECT * FROM job_details WHERE job_row_id = ?").all(jobId);
    expect(rowsBefore).toHaveLength(1);

    // Because the row already exists, the code-level check will skip it —
    // this exercises the same "already present" outcome the DB-level unique
    // constraint guards against under true concurrency.
    const result = await ingestJobDetailsForCompany(runId, companyId);
    expect(result.skipped).toBe(1);

    const rowsAfter = db.prepare("SELECT * FROM job_details WHERE job_row_id = ?").all(jobId);
    expect(rowsAfter).toHaveLength(1);
  });

  it("does not modify run_companies status or failure fields", async () => {
    const jobId = randomUUID();
    insertJobRow(jobId, runId, companyId, "https://example.com/jobs/7");
    stubFetchFail(429);

    const before = db.prepare("SELECT * FROM run_companies WHERE id = ?").get(companyId);
    await ingestJobDetailsForCompany(runId, companyId);
    const after = db.prepare("SELECT * FROM run_companies WHERE id = ?").get(companyId);

    expect(after).toEqual(before);
  });

  it("skipped count is returned for jobs with no matched job rows", async () => {
    const result = await ingestJobDetailsForCompany(runId, companyId);
    expect(result.attempted).toBe(0);
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("treats a true DB-level UNIQUE job_row_id race as skipped, not a failure", async () => {
    const jobId = randomUUID();
    insertJobRow(jobId, runId, companyId, "https://example.com/jobs/8");

    // Insert the row for real after the pre-check would have run, by racing
    // a concurrent insert from inside the fetch call itself — this exercises
    // the actual UNIQUE constraint path in insertJobDetailRow rather than the
    // code-level pre-check skip.
    vi.stubGlobal("fetch", async () => {
      db.prepare(
        `INSERT INTO job_details (id, run_id, company_id, job_row_id, job_url, description_text, fetched_at, failure_code, failure_reason, created_at)
         VALUES (?, ?, ?, ?, ?, 'raced text', ?, NULL, NULL, ?)`
      ).run(randomUUID(), runId, companyId, jobId, "https://example.com/jobs/8", Date.now(), Date.now());
      return new Response("<html><body>desc</body></html>", { status: 200 });
    });

    const result = await ingestJobDetailsForCompany(runId, companyId);

    expect(result.attempted).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.inserted).toBe(0);
    expect(result.failed).toBe(0);

    const rows = db.prepare("SELECT * FROM job_details WHERE job_row_id = ?").all(jobId);
    expect(rows).toHaveLength(1);
  });

  // jobDetailIngestion.ts caches its INSERT INTO job_details statement at
  // module import time, so re-spying on db.prepare after import has no effect
  // on that cached statement. All better-sqlite3 Statement instances share one
  // prototype, so patching Statement.prototype.run (gated on `this.source`) is
  // the only way to force that specific cached statement to throw.
  function statementPrototype(): Record<string, unknown> {
    const probe = db.prepare("SELECT 1");
    return Object.getPrototypeOf(probe) as Record<string, unknown>;
  }

  it("does not silently swallow a non-UNIQUE insert error as skipped", async () => {
    const jobId = randomUUID();
    insertJobRow(jobId, runId, companyId, "https://example.com/jobs/9");
    stubFetchOk();

    const proto = statementPrototype();
    const originalRun = proto.run as (...args: unknown[]) => unknown;
    const runSpy = vi.fn(function (this: { source: string }, ...args: unknown[]) {
      if (this.source.includes("INSERT INTO job_details")) {
        throw Object.assign(new Error("simulated non-unique constraint failure"), {
          code: "SQLITE_CONSTRAINT_NOTNULL",
        });
      }
      return originalRun.apply(this, args);
    });
    proto.run = runSpy;

    try {
      await expect(ingestJobDetailsForCompany(runId, companyId)).rejects.toThrow(
        "simulated non-unique constraint failure"
      );
    } finally {
      proto.run = originalRun;
    }
  });

  it("increments attempted at most once per job row when the success-path insert throws an unexpected error", async () => {
    const jobId = randomUUID();
    insertJobRow(jobId, runId, companyId, "https://example.com/jobs/10");
    stubFetchOk();

    // Force the *first* insert attempt (success path) to throw a non-UNIQUE
    // error, which insertJobDetailRow now rethrows. The outer per-job catch
    // then retries with a failure row; `attempted` must still read 1, not 2.
    const proto = statementPrototype();
    const originalRun = proto.run as (...args: unknown[]) => unknown;
    let firstInsertCall = true;
    proto.run = function (this: { source: string }, ...args: unknown[]) {
      if (this.source.includes("INSERT INTO job_details") && firstInsertCall) {
        firstInsertCall = false;
        throw new Error("simulated unexpected insert failure");
      }
      return originalRun.apply(this, args);
    };

    let result;
    try {
      result = await ingestJobDetailsForCompany(runId, companyId);
    } finally {
      proto.run = originalRun;
    }

    expect(result.attempted).toBe(1);
    expect(result.failed).toBe(1);

    const rows = db.prepare("SELECT * FROM job_details WHERE job_row_id = ?").all(jobId);
    expect(rows).toHaveLength(1);
  });
});
