/**
 * P0 regression tests for tryClaimNextCompany.
 *
 * Protects:
 *   - Does not claim when role_spec_json is null (company must not start without a role spec)
 *   - Does not claim when the global IN_PROGRESS count is already at the concurrency cap (2)
 *   - Successful claim transitions the company from PENDING to IN_PROGRESS
 *   - Successful claim sets worker_token to a non-null UUID
 *   - Successful claim sets started_at to a non-null timestamp
 *   - First claim transitions the run from READY to RUNNING
 *
 * processClaimedCompany is mocked — no pipeline work runs during these tests.
 * The DB transaction (claim + READY→RUNNING) is what is being tested.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../../db/db.js";

// Mock processClaimedCompany before importing anything that depends on it.
// claimNextCompany.ts calls `void processClaimedCompany(claimed).catch(...)` after
// the transaction. The mock resolves immediately and produces no DB side-effects.
vi.mock("../processClaimedCompany.js", () => ({
  processClaimedCompany: vi.fn().mockResolvedValue(undefined),
}));

import { tryClaimNextCompany } from "../claimNextCompany.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_ROLE_SPEC = JSON.stringify({
  include_titles: ["Software Engineer"],
  exclude_titles: [],
  seniority: "any",
});

function insertRun(id: string, status: "READY" | "RUNNING", roleSpecJson: string | null): void {
  db.prepare(
    `INSERT INTO runs (id, created_at, status, role_raw, include_adjacent, company_count, role_spec_json)
     VALUES (?, ?, ?, 'Software Engineer', 0, 1, ?)`,
  ).run(id, Date.now(), status, roleSpecJson);
}

function insertPendingCompany(id: string, runId: string, inputIndex = 0): void {
  db.prepare(
    `INSERT INTO run_companies (id, run_id, company_name, input_index, status, created_at)
     VALUES (?, ?, 'TestCo', ?, 'PENDING', ?)`,
  ).run(id, runId, inputIndex, Date.now());
}

function insertInProgressCompany(id: string, runId: string, inputIndex = 0): void {
  db.prepare(
    `INSERT INTO run_companies (id, run_id, company_name, input_index, status, created_at, started_at, worker_token)
     VALUES (?, ?, 'TestCo', ?, 'IN_PROGRESS', ?, ?, ?)`,
  ).run(id, runId, inputIndex, Date.now(), Date.now(), randomUUID());
}

function companyRow(id: string): { status: string; worker_token: string | null; started_at: number | null } {
  return db.prepare("SELECT status, worker_token, started_at FROM run_companies WHERE id = ?").get(id) as {
    status: string;
    worker_token: string | null;
    started_at: number | null;
  };
}

function runStatus(id: string): string {
  return (db.prepare("SELECT status FROM runs WHERE id = ?").get(id) as { status: string }).status;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

let runId: string;
const extraRunIds: string[] = [];

beforeEach(() => {
  runId = randomUUID();
  vi.clearAllMocks();
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
// Eligibility gate: role_spec_json must be non-null
// ---------------------------------------------------------------------------

describe("tryClaimNextCompany — does not claim when role_spec_json is null", () => {
  it("leaves the company PENDING when the run has no role spec", () => {
    insertRun(runId, "READY", null);
    const companyId = randomUUID();
    insertPendingCompany(companyId, runId);

    tryClaimNextCompany();

    expect(companyRow(companyId).status).toBe("PENDING");
  });

  it("leaves the run status unchanged when the run has no role spec", () => {
    insertRun(runId, "READY", null);
    insertPendingCompany(randomUUID(), runId);

    tryClaimNextCompany();

    expect(runStatus(runId)).toBe("READY");
  });
});

// ---------------------------------------------------------------------------
// Eligibility gate: concurrency cap
// ---------------------------------------------------------------------------

describe("tryClaimNextCompany — does not claim when IN_PROGRESS count is at cap (2)", () => {
  it("leaves a PENDING company unclaimed when two companies are already IN_PROGRESS", () => {
    // Run A: already has 2 IN_PROGRESS companies — this fills the global cap.
    const runIdA = randomUUID();
    extraRunIds.push(runIdA);
    insertRun(runIdA, "RUNNING", VALID_ROLE_SPEC);
    insertInProgressCompany(randomUUID(), runIdA, 0);
    insertInProgressCompany(randomUUID(), runIdA, 1);

    // Run B: READY with a valid PENDING company that should NOT be claimed.
    insertRun(runId, "READY", VALID_ROLE_SPEC);
    const pendingCompanyId = randomUUID();
    insertPendingCompany(pendingCompanyId, runId);

    tryClaimNextCompany();

    expect(companyRow(pendingCompanyId).status).toBe("PENDING");
  });
});

// ---------------------------------------------------------------------------
// Successful claim
// ---------------------------------------------------------------------------

describe("tryClaimNextCompany — successful claim", () => {
  it("transitions the company from PENDING to IN_PROGRESS", () => {
    insertRun(runId, "READY", VALID_ROLE_SPEC);
    const companyId = randomUUID();
    insertPendingCompany(companyId, runId);

    tryClaimNextCompany();

    expect(companyRow(companyId).status).toBe("IN_PROGRESS");
  });

  it("sets worker_token to a non-null value on the claimed company", () => {
    insertRun(runId, "READY", VALID_ROLE_SPEC);
    const companyId = randomUUID();
    insertPendingCompany(companyId, runId);

    tryClaimNextCompany();

    expect(companyRow(companyId).worker_token).not.toBeNull();
  });

  it("sets started_at to a non-null timestamp on the claimed company", () => {
    insertRun(runId, "READY", VALID_ROLE_SPEC);
    const companyId = randomUUID();
    insertPendingCompany(companyId, runId);

    tryClaimNextCompany();

    expect(companyRow(companyId).started_at).not.toBeNull();
  });

  it("transitions the run from READY to RUNNING on the first claim", () => {
    insertRun(runId, "READY", VALID_ROLE_SPEC);
    insertPendingCompany(randomUUID(), runId);

    tryClaimNextCompany();

    expect(runStatus(runId)).toBe("RUNNING");
  });

  it("leaves run status RUNNING when run is already RUNNING on a second claim", () => {
    insertRun(runId, "RUNNING", VALID_ROLE_SPEC);
    insertPendingCompany(randomUUID(), runId, 0);

    tryClaimNextCompany();

    expect(runStatus(runId)).toBe("RUNNING");
  });
});
