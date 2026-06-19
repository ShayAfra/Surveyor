/**
 * Regression tests for writeTraceEvent (trace.ts).
 *
 * Protects:
 *   - writeTraceEvent inserts exactly one trace row per call
 *   - All fields (run_id, run_company_id, event_type, message, payload_json) are persisted
 *   - run_company_id can be null for run-scoped events
 *   - payload_json can be null
 *   - Multiple events can be inserted for the same run
 *   - created_at is set to write time (the caller's created_at input is NOT used —
 *     the function calls Date.now() internally)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../../db/db.js";
import { writeTraceEvent } from "../trace.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertRun(id: string): void {
  db.prepare(
    `INSERT INTO runs (id, created_at, status, role_raw, include_adjacent, company_count)
     VALUES (?, ?, 'RUNNING', 'SWE', 0, 1)`,
  ).run(id, Date.now());
}

function traceRows(runId: string): {
  run_id: string;
  run_company_id: string | null;
  event_type: string;
  message: string;
  payload_json: string | null;
  created_at: number;
}[] {
  return db
    .prepare(
      "SELECT run_id, run_company_id, event_type, message, payload_json, created_at FROM trace_events WHERE run_id = ?",
    )
    .all(runId) as {
    run_id: string;
    run_company_id: string | null;
    event_type: string;
    message: string;
    payload_json: string | null;
    created_at: number;
  }[];
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

let runId: string;

beforeEach(() => {
  runId = randomUUID();
  insertRun(runId);
});

afterEach(() => {
  db.prepare("DELETE FROM trace_events WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM run_companies WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
});

// ---------------------------------------------------------------------------
// Basic write behavior
// ---------------------------------------------------------------------------

describe("writeTraceEvent — basic persistence", () => {
  it("inserts exactly one trace row", () => {
    writeTraceEvent({
      run_id: runId,
      run_company_id: null,
      event_type: "test_event",
      message: "test message",
      payload_json: null,
      created_at: Date.now(),
    });

    expect(traceRows(runId)).toHaveLength(1);
  });

  it("persists run_id, event_type, and message correctly", () => {
    writeTraceEvent({
      run_id: runId,
      run_company_id: null,
      event_type: "role_spec_success",
      message: "role spec generation succeeded",
      payload_json: null,
      created_at: Date.now(),
    });

    const [row] = traceRows(runId);
    expect(row.run_id).toBe(runId);
    expect(row.event_type).toBe("role_spec_success");
    expect(row.message).toBe("role spec generation succeeded");
  });

  it("persists run_company_id when provided", () => {
    const companyId = randomUUID();

    writeTraceEvent({
      run_id: runId,
      run_company_id: companyId,
      event_type: "finalization_outcome",
      message: "company finalized",
      payload_json: null,
      created_at: Date.now(),
    });

    const [row] = traceRows(runId);
    expect(row.run_company_id).toBe(companyId);
  });

  it("persists run_company_id as null for run-scoped events", () => {
    writeTraceEvent({
      run_id: runId,
      run_company_id: null,
      event_type: "run_completed",
      message: "run transitioned to COMPLETED",
      payload_json: null,
      created_at: Date.now(),
    });

    const [row] = traceRows(runId);
    expect(row.run_company_id).toBeNull();
  });

  it("persists payload_json when provided", () => {
    const payload = { computed_status: "NO_MATCH_SCAN_COMPLETED", match_count: 0 };

    writeTraceEvent({
      run_id: runId,
      run_company_id: null,
      event_type: "finalization_outcome",
      message: "company finalized",
      payload_json: JSON.stringify(payload),
      created_at: Date.now(),
    });

    const [row] = traceRows(runId);
    expect(row.payload_json).not.toBeNull();
    expect(JSON.parse(row.payload_json!)).toMatchObject({ computed_status: "NO_MATCH_SCAN_COMPLETED" });
  });

  it("persists payload_json as null when not provided", () => {
    writeTraceEvent({
      run_id: runId,
      run_company_id: null,
      event_type: "run_completed",
      message: "run transitioned to COMPLETED",
      payload_json: null,
      created_at: Date.now(),
    });

    const [row] = traceRows(runId);
    expect(row.payload_json).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// created_at behavior
// ---------------------------------------------------------------------------

describe("writeTraceEvent — created_at is set to write time, not the caller's input", () => {
  it("stores a positive integer for created_at", () => {
    writeTraceEvent({
      run_id: runId,
      run_company_id: null,
      event_type: "test_event",
      message: "test",
      payload_json: null,
      created_at: 0, // deliberately passing 0; implementation overrides with Date.now()
    });

    const [row] = traceRows(runId);
    expect(row.created_at).toBeGreaterThan(0);
  });

  it("does not store the caller's created_at value when it differs from write time", () => {
    const callerCreatedAt = 999; // far in the past
    writeTraceEvent({
      run_id: runId,
      run_company_id: null,
      event_type: "test_event",
      message: "test",
      payload_json: null,
      created_at: callerCreatedAt,
    });

    const [row] = traceRows(runId);
    // The implementation uses Date.now() internally, not the passed-in value.
    expect(row.created_at).not.toBe(callerCreatedAt);
    expect(row.created_at).toBeGreaterThan(callerCreatedAt);
  });
});

// ---------------------------------------------------------------------------
// Multiple events per run
// ---------------------------------------------------------------------------

describe("writeTraceEvent — multiple events per run", () => {
  it("allows multiple trace events for the same run_id", () => {
    writeTraceEvent({
      run_id: runId,
      run_company_id: null,
      event_type: "role_spec_success",
      message: "first event",
      payload_json: null,
      created_at: Date.now(),
    });
    writeTraceEvent({
      run_id: runId,
      run_company_id: null,
      event_type: "run_completed",
      message: "second event",
      payload_json: null,
      created_at: Date.now(),
    });

    expect(traceRows(runId)).toHaveLength(2);
  });

  it("each trace row has a distinct id", () => {
    writeTraceEvent({
      run_id: runId,
      run_company_id: null,
      event_type: "event_a",
      message: "a",
      payload_json: null,
      created_at: Date.now(),
    });
    writeTraceEvent({
      run_id: runId,
      run_company_id: null,
      event_type: "event_b",
      message: "b",
      payload_json: null,
      created_at: Date.now(),
    });

    const ids = db
      .prepare("SELECT id FROM trace_events WHERE run_id = ?")
      .all(runId) as { id: string }[];
    expect(ids[0].id).not.toBe(ids[1].id);
  });
});
