/**
 * P0 regression tests for processRoleSpecInitialization.
 *
 * Protects:
 *   - Success path: run transitions CREATED → READY with role_spec_json persisted
 *   - Success path: role_spec_success trace event is written after the DB update
 *   - Success path: PENDING companies remain PENDING (not modified)
 *   - Failure path: run transitions CREATED → FAILED_ROLE_SPEC
 *   - Failure path: error_code and error_message are persisted on the run
 *   - Failure path: all PENDING companies become CANCELLED
 *   - Failure path: cancelled companies receive failure_code and failure_reason
 *   - Failure path: role_spec_failure trace event is written after the DB update
 *
 * No vi.mock: uses vi.stubEnv and vi.stubGlobal (same pattern as roleSpec.test.ts)
 * to control generateRoleSpec behavior without triggering ESM module re-evaluation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../../db/db.js";
import { processRoleSpecInitialization } from "../runRoleSpecInitialization.js";

// ---------------------------------------------------------------------------
// Stub helpers — mirror the pattern in roleSpec.test.ts
// ---------------------------------------------------------------------------

const VALID_ROLE_SPEC_RESPONSE = {
  include_titles: ["Software Engineer"],
  exclude_titles: [],
  seniority: "any",
};

function stubSuccessfulLlmResponse(): void {
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(VALID_ROLE_SPEC_RESPONSE) } }],
      }),
    }),
  );
}

function stubMissingApiKey(): void {
  vi.stubEnv("OPENAI_API_KEY", "");
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function insertCreatedRun(id: string, companyCount = 1): void {
  db.prepare(
    `INSERT INTO runs (id, created_at, status, role_raw, include_adjacent, company_count)
     VALUES (?, ?, 'CREATED', 'Software Engineer', 0, ?)`,
  ).run(id, Date.now(), companyCount);
}

function insertPendingCompany(id: string, runId: string, inputIndex = 0): void {
  db.prepare(
    `INSERT INTO run_companies (id, run_id, company_name, input_index, status, created_at)
     VALUES (?, ?, 'TestCo', ?, 'PENDING', ?)`,
  ).run(id, runId, inputIndex, Date.now());
}

function runRow(id: string): {
  status: string;
  role_spec_json: string | null;
  error_code: string | null;
  error_message: string | null;
} {
  return db
    .prepare("SELECT status, role_spec_json, error_code, error_message FROM runs WHERE id = ?")
    .get(id) as {
    status: string;
    role_spec_json: string | null;
    error_code: string | null;
    error_message: string | null;
  };
}

function companyRow(id: string): {
  status: string;
  failure_code: string | null;
  failure_reason: string | null;
} {
  return db
    .prepare("SELECT status, failure_code, failure_reason FROM run_companies WHERE id = ?")
    .get(id) as { status: string; failure_code: string | null; failure_reason: string | null };
}

function traceCount(runId: string, eventType: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM trace_events WHERE run_id = ? AND event_type = ?")
      .get(runId, eventType) as { n: number }
  ).n;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

let runId: string;

beforeEach(() => {
  runId = randomUUID();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db.prepare("DELETE FROM trace_events WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM run_companies WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
});

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe("processRoleSpecInitialization — success path", () => {
  it("transitions the run from CREATED to READY", async () => {
    stubSuccessfulLlmResponse();
    insertCreatedRun(runId);

    await processRoleSpecInitialization();

    expect(runRow(runId).status).toBe("READY");
  });

  it("persists a non-null role_spec_json on the run row", async () => {
    stubSuccessfulLlmResponse();
    insertCreatedRun(runId);

    await processRoleSpecInitialization();

    const saved = runRow(runId).role_spec_json;
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved!)).toMatchObject({
      include_titles: expect.arrayContaining(["Software Engineer"]),
      seniority: "any",
    });
  });

  it("leaves PENDING companies unchanged", async () => {
    stubSuccessfulLlmResponse();
    insertCreatedRun(runId, 2);
    const c1 = randomUUID();
    const c2 = randomUUID();
    insertPendingCompany(c1, runId, 0);
    insertPendingCompany(c2, runId, 1);

    await processRoleSpecInitialization();

    expect(companyRow(c1).status).toBe("PENDING");
    expect(companyRow(c2).status).toBe("PENDING");
  });

  it("writes a role_spec_success trace event after the DB update", async () => {
    stubSuccessfulLlmResponse();
    insertCreatedRun(runId);

    await processRoleSpecInitialization();

    expect(traceCount(runId, "role_spec_success")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Failure path
// ---------------------------------------------------------------------------

describe("processRoleSpecInitialization — failure path", () => {
  it("transitions the run from CREATED to FAILED_ROLE_SPEC when generateRoleSpec fails", async () => {
    stubMissingApiKey();
    insertCreatedRun(runId);

    await processRoleSpecInitialization();

    expect(runRow(runId).status).toBe("FAILED_ROLE_SPEC");
  });

  it("persists error_code ROLE_SPEC_FAILED on the run", async () => {
    stubMissingApiKey();
    insertCreatedRun(runId);

    await processRoleSpecInitialization();

    expect(runRow(runId).error_code).toBe("ROLE_SPEC_FAILED");
  });

  it("persists error_message on the run", async () => {
    stubMissingApiKey();
    insertCreatedRun(runId);

    await processRoleSpecInitialization();

    expect(runRow(runId).error_message).toBe("role spec generation failed");
  });

  it("sets all PENDING companies to CANCELLED", async () => {
    stubMissingApiKey();
    insertCreatedRun(runId, 3);
    const c1 = randomUUID();
    const c2 = randomUUID();
    const c3 = randomUUID();
    insertPendingCompany(c1, runId, 0);
    insertPendingCompany(c2, runId, 1);
    insertPendingCompany(c3, runId, 2);

    await processRoleSpecInitialization();

    expect(companyRow(c1).status).toBe("CANCELLED");
    expect(companyRow(c2).status).toBe("CANCELLED");
    expect(companyRow(c3).status).toBe("CANCELLED");
  });

  it("sets failure_code ROLE_SPEC_FAILED on cancelled companies", async () => {
    stubMissingApiKey();
    insertCreatedRun(runId);
    const companyId = randomUUID();
    insertPendingCompany(companyId, runId);

    await processRoleSpecInitialization();

    expect(companyRow(companyId).failure_code).toBe("ROLE_SPEC_FAILED");
  });

  it("sets failure_reason on cancelled companies", async () => {
    stubMissingApiKey();
    insertCreatedRun(runId);
    const companyId = randomUUID();
    insertPendingCompany(companyId, runId);

    await processRoleSpecInitialization();

    expect(companyRow(companyId).failure_reason).toBe("role spec generation failed");
  });

  it("writes a role_spec_failure trace event after the DB update", async () => {
    stubMissingApiKey();
    insertCreatedRun(runId);

    await processRoleSpecInitialization();

    expect(traceCount(runId, "role_spec_failure")).toBe(1);
  });
});
