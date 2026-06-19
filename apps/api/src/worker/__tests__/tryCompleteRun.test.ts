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
