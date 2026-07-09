/**
 * P0 regression tests for tryCompleteRun and tryCompleteRunsForReadyOrRunning.
 *
 * Protects:
 *   - Run transitions to COMPLETED only when every company is in a final state
 *   - Run stays READY/RUNNING when any company is PENDING or IN_PROGRESS
 *   - run_completed trace event is written exactly once per transition
 *   - Second call on an already-COMPLETED run does not emit a duplicate trace event
 *   - tryCompleteRunsForReadyOrRunning completes all eligible runs in one pass
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../../db/db.js";
import { tryCompleteRun, tryCompleteRunsForReadyOrRunning } from "../tryCompleteRun.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertRun(id: string, status: string): void {
  db.prepare(
    `INSERT INTO runs (id, created_at, status, role_raw, include_adjacent, company_count)
     VALUES (?, ?, ?, 'Software Engineer', 0, 1)`,
  ).run(id, Date.now(), status);
}

function insertCompany(id: string, runId: string, status: string, inputIndex = 0): void {
  if (status === "IN_PROGRESS") {
    db.prepare(
      `INSERT INTO run_companies (id, run_id, company_name, input_index, status, created_at, started_at, worker_token)
       VALUES (?, ?, 'TestCo', ?, ?, ?, ?, ?)`,
    ).run(id, runId, inputIndex, status, Date.now(), Date.now(), randomUUID());
  } else {
    db.prepare(
      `INSERT INTO run_companies (id, run_id, company_name, input_index, status, created_at)
       VALUES (?, ?, 'TestCo', ?, ?, ?)`,
    ).run(id, runId, inputIndex, status, Date.now());
  }
}

function insertJobRow(id: string, runId: string, companyId: string): void {
  db.prepare(
    `INSERT INTO job_rows (id, run_id, company_id, title, location, url, match_reason)
     VALUES (?, ?, ?, 'Software Engineer', 'Remote', ?, 'Matched inclusion phrase Software Engineer')`,
  ).run(id, runId, companyId, `https://example.com/jobs/${id}`);
}

function insertJobDetail(
  jobRowId: string,
  runId: string,
  companyId: string,
  opts: { description_text?: string | null; failure_code?: string | null; failure_reason?: string | null } = {},
): void {
  db.prepare(
    `INSERT INTO job_details (id, run_id, company_id, job_row_id, job_url, description_text, fetched_at, failure_code, failure_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    runId,
    companyId,
    jobRowId,
    `https://example.com/jobs/${jobRowId}`,
    opts.description_text ?? null,
    Date.now(),
    opts.failure_code ?? null,
    opts.failure_reason ?? null,
    Date.now(),
  );
}

function runStatus(runId: string): string {
  return (db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status;
}

function traceCount(runId: string, eventType: string): number {
  return (
    db.prepare(
      "SELECT COUNT(*) AS n FROM trace_events WHERE run_id = ? AND event_type = ?",
    ).get(runId, eventType) as { n: number }
  ).n;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

let runId: string;
const extraRunIds: string[] = [];

beforeEach(() => {
  runId = randomUUID();
});

afterEach(() => {
  const ids = [runId, ...extraRunIds.splice(0)];
  for (const id of ids) {
    db.prepare("DELETE FROM trace_events WHERE run_id = ?").run(id);
    db.prepare("DELETE FROM job_details WHERE run_id = ?").run(id);
    db.prepare("DELETE FROM job_rows WHERE run_id = ?").run(id);
    db.prepare("DELETE FROM run_companies WHERE run_id = ?").run(id);
    db.prepare("DELETE FROM runs WHERE id = ?").run(id);
  }
});

// ---------------------------------------------------------------------------
// Run transitions to COMPLETED when all companies are final
// ---------------------------------------------------------------------------

describe("tryCompleteRun — transitions run to COMPLETED", () => {
  it("transitions a RUNNING run to COMPLETED when all companies are MATCHES_FOUND", () => {
    insertRun(runId, "RUNNING");
    insertCompany(randomUUID(), runId, "MATCHES_FOUND");

    tryCompleteRun(runId);

    expect(runStatus(runId)).toBe("COMPLETED");
  });

  it("transitions a READY run to COMPLETED when all companies are NO_MATCH_SCAN_COMPLETED", () => {
    insertRun(runId, "READY");
    insertCompany(randomUUID(), runId, "NO_MATCH_SCAN_COMPLETED");

    tryCompleteRun(runId);

    expect(runStatus(runId)).toBe("COMPLETED");
  });

  it("transitions when all four final statuses are present in the same run", () => {
    insertRun(runId, "RUNNING");
    insertCompany(randomUUID(), runId, "MATCHES_FOUND", 0);
    insertCompany(randomUUID(), runId, "NO_MATCH_SCAN_COMPLETED", 1);
    insertCompany(randomUUID(), runId, "UNVERIFIED", 2);
    insertCompany(randomUUID(), runId, "CANCELLED", 3);

    tryCompleteRun(runId);

    expect(runStatus(runId)).toBe("COMPLETED");
  });
});

// ---------------------------------------------------------------------------
// Run does not complete when non-final companies remain
// ---------------------------------------------------------------------------

describe("tryCompleteRun — does not complete when non-final companies remain", () => {
  it("leaves run RUNNING when one company is PENDING", () => {
    insertRun(runId, "RUNNING");
    insertCompany(randomUUID(), runId, "MATCHES_FOUND", 0);
    insertCompany(randomUUID(), runId, "PENDING", 1);

    tryCompleteRun(runId);

    expect(runStatus(runId)).toBe("RUNNING");
  });

  it("leaves run RUNNING when one company is IN_PROGRESS", () => {
    insertRun(runId, "RUNNING");
    insertCompany(randomUUID(), runId, "NO_MATCH_SCAN_COMPLETED", 0);
    insertCompany(randomUUID(), runId, "IN_PROGRESS", 1);

    tryCompleteRun(runId);

    expect(runStatus(runId)).toBe("RUNNING");
  });

  it("does not emit run_completed trace when companies are not all final", () => {
    insertRun(runId, "RUNNING");
    insertCompany(randomUUID(), runId, "PENDING");

    tryCompleteRun(runId);

    expect(traceCount(runId, "run_completed")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Trace event emission
// ---------------------------------------------------------------------------

describe("tryCompleteRun — trace event emission", () => {
  it("emits exactly one run_completed trace event when the run transitions to COMPLETED", () => {
    insertRun(runId, "RUNNING");
    insertCompany(randomUUID(), runId, "NO_MATCH_SCAN_COMPLETED");

    tryCompleteRun(runId);

    expect(traceCount(runId, "run_completed")).toBe(1);
  });

  it("does not emit a second run_completed trace event on a repeated call", () => {
    insertRun(runId, "RUNNING");
    insertCompany(randomUUID(), runId, "UNVERIFIED");

    tryCompleteRun(runId); // transitions to COMPLETED, writes trace
    tryCompleteRun(runId); // run is already COMPLETED, UPDATE changes=0, no trace

    expect(traceCount(runId, "run_completed")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// tryCompleteRunsForReadyOrRunning
// ---------------------------------------------------------------------------

describe("tryCompleteRunsForReadyOrRunning — completes all eligible runs", () => {
  it("completes every READY and RUNNING run whose companies are all final", () => {
    const runId2 = randomUUID();
    extraRunIds.push(runId2);

    insertRun(runId, "RUNNING");
    insertCompany(randomUUID(), runId, "MATCHES_FOUND");

    insertRun(runId2, "READY");
    insertCompany(randomUUID(), runId2, "NO_MATCH_SCAN_COMPLETED");

    tryCompleteRunsForReadyOrRunning();

    expect(runStatus(runId)).toBe("COMPLETED");
    expect(runStatus(runId2)).toBe("COMPLETED");
  });

  it("leaves a run that still has a PENDING company unchanged", () => {
    insertRun(runId, "RUNNING");
    insertCompany(randomUUID(), runId, "PENDING");

    tryCompleteRunsForReadyOrRunning();

    expect(runStatus(runId)).toBe("RUNNING");
  });
});

// ---------------------------------------------------------------------------
// Gate 3 lifecycle fix: run completion must wait for job_details evidence
// ---------------------------------------------------------------------------

describe("tryCompleteRun — waits for job_details rows before completing", () => {
  it("does not complete when all companies are final but a job_row has no job_details row", () => {
    insertRun(runId, "RUNNING");
    const companyId = randomUUID();
    insertCompany(companyId, runId, "MATCHES_FOUND");
    insertJobRow(randomUUID(), runId, companyId);

    tryCompleteRun(runId);

    expect(runStatus(runId)).toBe("RUNNING");
  });

  it("tryCompleteRunsForReadyOrRunning does not complete when a job_row has no job_details row", () => {
    insertRun(runId, "RUNNING");
    const companyId = randomUUID();
    insertCompany(companyId, runId, "MATCHES_FOUND");
    insertJobRow(randomUUID(), runId, companyId);

    tryCompleteRunsForReadyOrRunning();

    expect(runStatus(runId)).toBe("RUNNING");
  });

  it("completes once every job_row in the run has a job_details row", () => {
    insertRun(runId, "RUNNING");
    const companyId = randomUUID();
    insertCompany(companyId, runId, "MATCHES_FOUND");
    const jobRowId = randomUUID();
    insertJobRow(jobRowId, runId, companyId);
    insertJobDetail(jobRowId, runId, companyId, { description_text: "full description" });

    tryCompleteRun(runId);

    expect(runStatus(runId)).toBe("COMPLETED");
  });

  it("a job_details row with non-empty description_text counts as complete", () => {
    insertRun(runId, "RUNNING");
    const companyId = randomUUID();
    insertCompany(companyId, runId, "MATCHES_FOUND");
    const jobRowId = randomUUID();
    insertJobRow(jobRowId, runId, companyId);
    insertJobDetail(jobRowId, runId, companyId, { description_text: "great role" });

    tryCompleteRun(runId);

    expect(runStatus(runId)).toBe("COMPLETED");
  });

  it("a job_details row with null description_text and a failure_code counts as complete", () => {
    insertRun(runId, "RUNNING");
    const companyId = randomUUID();
    insertCompany(companyId, runId, "MATCHES_FOUND");
    const jobRowId = randomUUID();
    insertJobRow(jobRowId, runId, companyId);
    insertJobDetail(jobRowId, runId, companyId, {
      description_text: null,
      failure_code: "JOB_DETAIL_FETCH_FAILED",
      failure_reason: "fetch failed",
    });

    tryCompleteRun(runId);

    expect(runStatus(runId)).toBe("COMPLETED");
  });

  it("a run with NO_MATCH_SCAN_COMPLETED companies and zero job_rows still completes normally", () => {
    insertRun(runId, "RUNNING");
    insertCompany(randomUUID(), runId, "NO_MATCH_SCAN_COMPLETED");

    tryCompleteRun(runId);

    expect(runStatus(runId)).toBe("COMPLETED");
  });

  it("a run with UNVERIFIED companies and zero job_rows still completes normally", () => {
    insertRun(runId, "RUNNING");
    insertCompany(randomUUID(), runId, "UNVERIFIED");

    tryCompleteRun(runId);

    expect(runStatus(runId)).toBe("COMPLETED");
  });

  it("a mixed run waits for MATCHES_FOUND job_rows to have job_details rows before completing", () => {
    insertRun(runId, "RUNNING");
    const matchesCompanyId = randomUUID();
    insertCompany(matchesCompanyId, runId, "MATCHES_FOUND", 0);
    insertCompany(randomUUID(), runId, "NO_MATCH_SCAN_COMPLETED", 1);
    const jobRowId = randomUUID();
    insertJobRow(jobRowId, runId, matchesCompanyId);

    tryCompleteRun(runId);
    expect(runStatus(runId)).toBe("RUNNING");

    insertJobDetail(jobRowId, runId, matchesCompanyId, { description_text: "role details" });
    tryCompleteRun(runId);
    expect(runStatus(runId)).toBe("COMPLETED");
  });

  it("global sweep race: run stays open until job_details rows exist, then completes on next sweep", () => {
    insertRun(runId, "RUNNING");
    const companyId = randomUUID();
    insertCompany(companyId, runId, "MATCHES_FOUND");
    const jobRowId = randomUUID();
    insertJobRow(jobRowId, runId, companyId);

    tryCompleteRunsForReadyOrRunning();
    expect(runStatus(runId)).toBe("RUNNING");

    insertJobDetail(jobRowId, runId, companyId, { description_text: "role details" });

    tryCompleteRunsForReadyOrRunning();
    expect(runStatus(runId)).toBe("COMPLETED");
  });
});
