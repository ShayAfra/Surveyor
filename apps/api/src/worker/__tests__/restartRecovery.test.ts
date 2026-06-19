/**
 * P0 regression tests for runRestartRecovery.
 *
 * Protects:
 *   - Stale IN_PROGRESS companies on READY/RUNNING runs are reset to PENDING
 *   - started_at and worker_token are cleared on reclaim
 *   - Recently-started IN_PROGRESS companies are not touched
 *   - Final companies (MATCHES_FOUND, NO_MATCH_SCAN_COMPLETED, UNVERIFIED, CANCELLED) are never modified
 *   - restart_recovery_reclaim trace events are emitted only for actually-reset companies
 *   - Multiple stale companies each produce their own trace event
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../../db/db.js";
import { runRestartRecovery, STALE_IN_PROGRESS_THRESHOLD_MS } from "../restartRecovery.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertRun(id: string, status: "READY" | "RUNNING"): void {
  db.prepare(
    `INSERT INTO runs (id, created_at, status, role_raw, include_adjacent, company_count)
     VALUES (?, ?, ?, 'Software Engineer', 0, 1)`,
  ).run(id, Date.now(), status);
}

function insertInProgressCompany(
  id: string,
  runId: string,
  startedAt: number,
  inputIndex = 0,
): string {
  const token = randomUUID();
  db.prepare(
    `INSERT INTO run_companies (id, run_id, company_name, input_index, status, created_at, started_at, worker_token)
     VALUES (?, ?, 'TestCo', ?, 'IN_PROGRESS', ?, ?, ?)`,
  ).run(id, runId, inputIndex, Date.now(), startedAt, token);
  return token;
}

function insertCompanyWithStatus(id: string, runId: string, status: string, inputIndex = 0): void {
  db.prepare(
    `INSERT INTO run_companies (id, run_id, company_name, input_index, status, created_at)
     VALUES (?, ?, 'TestCo', ?, ?, ?)`,
  ).run(id, runId, inputIndex, status, Date.now());
}

function companyRow(id: string): { status: string; started_at: number | null; worker_token: string | null } {
  return db.prepare("SELECT status, started_at, worker_token FROM run_companies WHERE id = ?").get(id) as {
    status: string;
    started_at: number | null;
    worker_token: string | null;
  };
}

function traceCount(runId: string, eventType: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM trace_events WHERE run_id = ? AND event_type = ?")
      .get(runId, eventType) as { n: number }
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

// Timestamps used across tests.
const staleStartedAt = () => Date.now() - STALE_IN_PROGRESS_THRESHOLD_MS * 2;
const freshStartedAt = () => Date.now();

// ---------------------------------------------------------------------------
// Stale companies are reset to PENDING
// ---------------------------------------------------------------------------

describe("runRestartRecovery — resets stale IN_PROGRESS companies to PENDING", () => {
  it("resets a stale IN_PROGRESS company to PENDING", () => {
    insertRun(runId, "RUNNING");
    const companyId = randomUUID();
    insertInProgressCompany(companyId, runId, staleStartedAt());

    runRestartRecovery();

    expect(companyRow(companyId).status).toBe("PENDING");
  });

  it("clears started_at to NULL on reclaim", () => {
    insertRun(runId, "RUNNING");
    const companyId = randomUUID();
    insertInProgressCompany(companyId, runId, staleStartedAt());

    runRestartRecovery();

    expect(companyRow(companyId).started_at).toBeNull();
  });

  it("clears worker_token to NULL on reclaim", () => {
    insertRun(runId, "RUNNING");
    const companyId = randomUUID();
    insertInProgressCompany(companyId, runId, staleStartedAt());

    runRestartRecovery();

    expect(companyRow(companyId).worker_token).toBeNull();
  });

  it("does not touch a recently-started IN_PROGRESS company", () => {
    insertRun(runId, "RUNNING");
    const companyId = randomUUID();
    const token = insertInProgressCompany(companyId, runId, freshStartedAt());

    runRestartRecovery();

    const row = companyRow(companyId);
    expect(row.status).toBe("IN_PROGRESS");
    expect(row.worker_token).toBe(token);
    expect(row.started_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Final companies are never modified
// ---------------------------------------------------------------------------

describe("runRestartRecovery — does not modify final companies", () => {
  it.each([
    "MATCHES_FOUND",
    "NO_MATCH_SCAN_COMPLETED",
    "UNVERIFIED",
    "CANCELLED",
  ])("leaves %s company unchanged", (finalStatus) => {
    insertRun(runId, "RUNNING");
    const companyId = randomUUID();
    insertCompanyWithStatus(companyId, runId, finalStatus);

    runRestartRecovery();

    expect(companyRow(companyId).status).toBe(finalStatus);
  });
});

// ---------------------------------------------------------------------------
// Trace events
// ---------------------------------------------------------------------------

describe("runRestartRecovery — trace events", () => {
  it("emits a restart_recovery_reclaim trace event for each reclaimed company", () => {
    insertRun(runId, "RUNNING");
    const c1 = randomUUID();
    const c2 = randomUUID();
    insertInProgressCompany(c1, runId, staleStartedAt(), 0);
    insertInProgressCompany(c2, runId, staleStartedAt(), 1);

    runRestartRecovery();

    expect(traceCount(runId, "restart_recovery_reclaim")).toBe(2);
  });

  it("does not emit a trace event for a non-stale IN_PROGRESS company", () => {
    insertRun(runId, "RUNNING");
    const companyId = randomUUID();
    insertInProgressCompany(companyId, runId, freshStartedAt());

    runRestartRecovery();

    expect(traceCount(runId, "restart_recovery_reclaim")).toBe(0);
  });

  it("does not emit trace events for final companies", () => {
    insertRun(runId, "RUNNING");
    const companyId = randomUUID();
    insertCompanyWithStatus(companyId, runId, "NO_MATCH_SCAN_COMPLETED");

    runRestartRecovery();

    expect(traceCount(runId, "restart_recovery_reclaim")).toBe(0);
  });
});
