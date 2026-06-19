/**
 * P0 persistence tests for persistFinalizeCompany (finalizeCompany.ts).
 *
 * Protects:
 *   - Correct worker_token allows finalization and returns true
 *   - Wrong worker_token returns false and leaves DB unchanged
 *   - Wrong worker_token does not insert job_rows (no partial state)
 *   - MATCHES_FOUND inserts matched jobs atomically with company finalization
 *   - NO_MATCH_SCAN_COMPLETED and UNVERIFIED do not insert job_rows
 *   - worker_token is cleared to NULL after successful finalization
 *   - Only the target company row is updated (other companies in the run untouched)
 *
 * Isolation: vitest.config.ts sets DB_PATH=:memory: so this worker gets a
 * fresh in-memory SQLite DB with the schema already applied by db.ts import.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { AtsType } from "@surveyor/shared";
import { db } from "../../db/db.js";
import { persistFinalizeCompany } from "../finalizeCompany.js";

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

let runId: string;
let companyId: string;
let workerToken: string;

function insertRun(id: string): void {
  db.prepare(
    `INSERT INTO runs (id, created_at, status, role_raw, include_adjacent, company_count)
     VALUES (?, ?, 'READY', 'SWE', 0, 1)`
  ).run(id, Date.now());
}

function insertInProgressCompany(id: string, rId: string, token: string, inputIndex = 0): void {
  db.prepare(
    `INSERT INTO run_companies
       (id, run_id, company_name, input_index, status, created_at, started_at, worker_token)
     VALUES (?, ?, 'Acme', ?, 'IN_PROGRESS', ?, ?, ?)`
  ).run(id, rId, inputIndex, Date.now(), Date.now(), token);
}

beforeEach(() => {
  runId = randomUUID();
  companyId = randomUUID();
  workerToken = randomUUID();
  insertRun(runId);
  insertInProgressCompany(companyId, runId, workerToken);
});

afterEach(() => {
  db.prepare("DELETE FROM trace_events WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM job_rows WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM run_companies WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
});

// Shared evidence fields used in all calls below.
const evidence = {
  careers_url: "https://acme.com/careers",
  listings_url: "https://boards.greenhouse.io/acme",
  ats_type: AtsType.GREENHOUSE,
  extractor_used: "GREENHOUSE",
  listings_scanned: 5,
  pages_visited: 1,
  failure_code: null,
  failure_reason: null,
  matchedJobs: [] as { title: string; location: string | null; url: string; match_reason: string }[],
  resolution_method: "DIRECT_VERIFIED",
  completion_reason: "CONFIDENT_SURFACE",
} as const;

// ---------------------------------------------------------------------------
// Correct ownership
// ---------------------------------------------------------------------------

describe("persistFinalizeCompany — correct ownership", () => {
  it("returns true when worker_token matches", () => {
    const ok = persistFinalizeCompany({
      run_id: runId,
      run_company_id: companyId,
      worker_token: workerToken,
      now_ms: Date.now(),
      computed_status: "NO_MATCH_SCAN_COMPLETED",
      ...evidence,
    });
    expect(ok).toBe(true);
  });

  it("updates company status to NO_MATCH_SCAN_COMPLETED", () => {
    persistFinalizeCompany({
      run_id: runId,
      run_company_id: companyId,
      worker_token: workerToken,
      now_ms: Date.now(),
      computed_status: "NO_MATCH_SCAN_COMPLETED",
      ...evidence,
    });

    const row = db
      .prepare("SELECT status FROM run_companies WHERE id = ?")
      .get(companyId) as { status: string };
    expect(row.status).toBe("NO_MATCH_SCAN_COMPLETED");
  });

  it("updates company status to UNVERIFIED", () => {
    persistFinalizeCompany({
      run_id: runId,
      run_company_id: companyId,
      worker_token: workerToken,
      now_ms: Date.now(),
      computed_status: "UNVERIFIED",
      ...evidence,
      failure_code: "CAREERS_NOT_FOUND",
      failure_reason: "no careers URL found",
    });

    const row = db
      .prepare("SELECT status FROM run_companies WHERE id = ?")
      .get(companyId) as { status: string };
    expect(row.status).toBe("UNVERIFIED");
  });

  it("clears worker_token to NULL after successful finalization", () => {
    persistFinalizeCompany({
      run_id: runId,
      run_company_id: companyId,
      worker_token: workerToken,
      now_ms: Date.now(),
      computed_status: "NO_MATCH_SCAN_COMPLETED",
      ...evidence,
    });

    const row = db
      .prepare("SELECT worker_token FROM run_companies WHERE id = ?")
      .get(companyId) as { worker_token: string | null };
    expect(row.worker_token).toBeNull();
  });

  it("MATCHES_FOUND inserts matched jobs into job_rows", () => {
    const matchedJobs = [
      { title: "Software Engineer", location: "Remote", url: "https://boards.greenhouse.io/acme/jobs/1", match_reason: "Matched inclusion phrase Software Engineer" },
      { title: "Senior SWE", location: null, url: "https://boards.greenhouse.io/acme/jobs/2", match_reason: "Matched inclusion phrase SWE" },
    ];

    persistFinalizeCompany({
      run_id: runId,
      run_company_id: companyId,
      worker_token: workerToken,
      now_ms: Date.now(),
      computed_status: "MATCHES_FOUND",
      ...evidence,
      matchedJobs,
    });

    const jobs = db
      .prepare("SELECT title, location FROM job_rows WHERE run_id = ? AND company_id = ?")
      .all(runId, companyId) as { title: string; location: string | null }[];

    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.title)).toContain("Software Engineer");
    expect(jobs.map((j) => j.title)).toContain("Senior SWE");
  });

  it("MATCHES_FOUND company row is finalized and job_rows exist simultaneously (atomicity check)", () => {
    const matchedJobs = [
      { title: "SWE", location: null, url: "https://x/1", match_reason: "match" },
    ];

    persistFinalizeCompany({
      run_id: runId,
      run_company_id: companyId,
      worker_token: workerToken,
      now_ms: Date.now(),
      computed_status: "MATCHES_FOUND",
      ...evidence,
      matchedJobs,
    });

    const company = db
      .prepare("SELECT status FROM run_companies WHERE id = ?")
      .get(companyId) as { status: string };
    const jobs = db
      .prepare("SELECT id FROM job_rows WHERE company_id = ?")
      .all(companyId);

    // Both must be committed together — no half-committed state.
    expect(company.status).toBe("MATCHES_FOUND");
    expect(jobs).toHaveLength(1);
  });

  it("NO_MATCH_SCAN_COMPLETED does not insert any job_rows", () => {
    persistFinalizeCompany({
      run_id: runId,
      run_company_id: companyId,
      worker_token: workerToken,
      now_ms: Date.now(),
      computed_status: "NO_MATCH_SCAN_COMPLETED",
      ...evidence,
    });

    const jobs = db.prepare("SELECT id FROM job_rows WHERE company_id = ?").all(companyId);
    expect(jobs).toHaveLength(0);
  });

  it("UNVERIFIED does not insert any job_rows", () => {
    persistFinalizeCompany({
      run_id: runId,
      run_company_id: companyId,
      worker_token: workerToken,
      now_ms: Date.now(),
      computed_status: "UNVERIFIED",
      ...evidence,
      failure_code: "CAREERS_NOT_FOUND",
      failure_reason: "no careers URL found",
    });

    const jobs = db.prepare("SELECT id FROM job_rows WHERE company_id = ?").all(companyId);
    expect(jobs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Trace evidence
// ---------------------------------------------------------------------------

describe("persistFinalizeCompany — finalization_outcome trace", () => {
  it("writes a finalization_outcome trace event after successful finalization", () => {
    persistFinalizeCompany({
      run_id: runId,
      run_company_id: companyId,
      worker_token: workerToken,
      now_ms: Date.now(),
      computed_status: "NO_MATCH_SCAN_COMPLETED",
      ...evidence,
    });

    const traces = db
      .prepare(
        "SELECT event_type, run_id, run_company_id, payload_json FROM trace_events WHERE run_id = ? AND event_type = ?",
      )
      .all(runId, "finalization_outcome") as {
      event_type: string;
      run_id: string;
      run_company_id: string;
      payload_json: string;
    }[];

    expect(traces).toHaveLength(1);
    expect(traces[0].run_id).toBe(runId);
    expect(traces[0].run_company_id).toBe(companyId);
    expect(traces[0].event_type).toBe("finalization_outcome");
  });

  it("finalization_outcome payload includes the computed_status", () => {
    persistFinalizeCompany({
      run_id: runId,
      run_company_id: companyId,
      worker_token: workerToken,
      now_ms: Date.now(),
      computed_status: "MATCHES_FOUND",
      ...evidence,
      matchedJobs: [
        {
          title: "Software Engineer",
          location: null,
          url: "https://boards.greenhouse.io/acme/jobs/1",
          match_reason: "Matched inclusion phrase Software Engineer",
        },
      ],
    });

    const row = db
      .prepare("SELECT payload_json FROM trace_events WHERE run_id = ? AND event_type = ?")
      .get(runId, "finalization_outcome") as { payload_json: string } | undefined;

    expect(row).toBeDefined();
    const payload = JSON.parse(row!.payload_json);
    expect(payload.computed_status).toBe("MATCHES_FOUND");
  });

  it("does not write finalization_outcome trace when worker_token is wrong", () => {
    const wrongToken = randomUUID();
    persistFinalizeCompany({
      run_id: runId,
      run_company_id: companyId,
      worker_token: wrongToken,
      now_ms: Date.now(),
      computed_status: "NO_MATCH_SCAN_COMPLETED",
      ...evidence,
    });

    const count = (
      db
        .prepare("SELECT COUNT(*) AS n FROM trace_events WHERE run_id = ? AND event_type = ?")
        .get(runId, "finalization_outcome") as { n: number }
    ).n;
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Wrong ownership
// ---------------------------------------------------------------------------

describe("persistFinalizeCompany — wrong ownership", () => {
  it("returns false when worker_token does not match", () => {
    const wrongToken = randomUUID();
    const ok = persistFinalizeCompany({
      run_id: runId,
      run_company_id: companyId,
      worker_token: wrongToken,
      now_ms: Date.now(),
      computed_status: "NO_MATCH_SCAN_COMPLETED",
      ...evidence,
    });
    expect(ok).toBe(false);
  });

  it("leaves company status as IN_PROGRESS when token is wrong", () => {
    const wrongToken = randomUUID();
    persistFinalizeCompany({
      run_id: runId,
      run_company_id: companyId,
      worker_token: wrongToken,
      now_ms: Date.now(),
      computed_status: "NO_MATCH_SCAN_COMPLETED",
      ...evidence,
    });

    const row = db
      .prepare("SELECT status FROM run_companies WHERE id = ?")
      .get(companyId) as { status: string };
    expect(row.status).toBe("IN_PROGRESS");
  });

  it("preserves the original worker_token when the wrong token is provided", () => {
    const wrongToken = randomUUID();
    persistFinalizeCompany({
      run_id: runId,
      run_company_id: companyId,
      worker_token: wrongToken,
      now_ms: Date.now(),
      computed_status: "NO_MATCH_SCAN_COMPLETED",
      ...evidence,
    });

    const row = db
      .prepare("SELECT worker_token FROM run_companies WHERE id = ?")
      .get(companyId) as { worker_token: string };
    expect(row.worker_token).toBe(workerToken);
  });

  it("does not insert job_rows when token is wrong, even for MATCHES_FOUND", () => {
    const wrongToken = randomUUID();
    persistFinalizeCompany({
      run_id: runId,
      run_company_id: companyId,
      worker_token: wrongToken,
      now_ms: Date.now(),
      computed_status: "MATCHES_FOUND",
      ...evidence,
      matchedJobs: [{ title: "SWE", location: null, url: "https://x/1", match_reason: "match" }],
    });

    const jobs = db.prepare("SELECT id FROM job_rows WHERE company_id = ?").all(companyId);
    expect(jobs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Row isolation
// ---------------------------------------------------------------------------

describe("persistFinalizeCompany — row isolation", () => {
  it("only updates the target company row; other companies in the same run are untouched", () => {
    const companyId2 = randomUUID();
    const workerToken2 = randomUUID();
    insertInProgressCompany(companyId2, runId, workerToken2, 1);

    // Finalize only the first company.
    persistFinalizeCompany({
      run_id: runId,
      run_company_id: companyId,
      worker_token: workerToken,
      now_ms: Date.now(),
      computed_status: "NO_MATCH_SCAN_COMPLETED",
      ...evidence,
    });

    const row2 = db
      .prepare("SELECT status, worker_token FROM run_companies WHERE id = ?")
      .get(companyId2) as { status: string; worker_token: string };

    expect(row2.status).toBe("IN_PROGRESS");
    expect(row2.worker_token).toBe(workerToken2);
  });
});
