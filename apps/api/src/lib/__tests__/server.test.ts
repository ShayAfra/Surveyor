/**
 * P0 endpoint tests for POST /api/runs and GET /api/runs/:runId.
 *
 * These tests protect:
 *   - Validation rejects (400) before any DB write
 *   - Durable creation: exactly one run row + N company rows, correct initial state
 *   - POST does not start role spec generation or worker processing inline
 *   - GET response shape, field types (include_adjacent as boolean), ordering
 *   - 404 for unknown run id
 *
 * Milestone 1 (Accounts and Owned Scanner Data): both endpoints now require
 * authentication. Every request in this file authenticates as a single test
 * user via the signup endpoint and reuses that session cookie. Dedicated
 * cross-user isolation tests live in routes/__tests__/runsOwnership.test.ts —
 * this file's job is unchanged scanner/validation behavior for an authenticated caller.
 *
 * Isolation: vitest.config.ts sets DB_PATH=:memory: so each test worker gets a
 * fresh in-memory SQLite DB. NODE_ENV=test (set automatically by vitest) prevents
 * server.ts from calling app.listen() / startWorkerLoop() / runRestartRecovery().
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { app } from "../../server.js";
import { db } from "../../db/db.js";

// Run IDs created during each test, deleted in afterEach.
const cleanup: string[] = [];

let authCookie: string;
let authUserId: string;

function extractSessionCookie(res: request.Response): string {
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie as unknown as string];
  const sessionCookie = cookies.find((c) => c.startsWith("surveyor_session="));
  return (sessionCookie as string).split(";")[0];
}

beforeEach(async () => {
  const email = `server-test-${randomUUID()}@example.com`;
  const res = await request(app).post("/api/auth/signup").send({ email, password: "password123" });
  authCookie = extractSessionCookie(res);
  authUserId = res.body.id as string;
});

afterEach(() => {
  for (const runId of cleanup.splice(0)) {
    db.prepare("DELETE FROM trace_events WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM job_rows WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM run_companies WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
  }
  db.prepare("DELETE FROM sessions").run();
  db.prepare("DELETE FROM users").run();
});

// ---------------------------------------------------------------------------
// POST /api/runs — auth requirement
// ---------------------------------------------------------------------------

describe("POST /api/runs — auth requirement", () => {
  it("returns 401 without a session", async () => {
    const res = await request(app)
      .post("/api/runs")
      .send({ role: "SWE", includeAdjacent: false, companies: ["Acme"] });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /api/runs — validation
// ---------------------------------------------------------------------------

describe("POST /api/runs — validation rejects", () => {
  it("returns 400 when role is missing", async () => {
    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ includeAdjacent: false, companies: ["Acme"] });
    expect(res.status).toBe(400);
  });

  it("returns 400 when role is not a string", async () => {
    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: 42, includeAdjacent: false, companies: ["Acme"] });
    expect(res.status).toBe(400);
  });

  it("returns 400 when role is empty after trimming", async () => {
    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "   ", includeAdjacent: false, companies: ["Acme"] });
    expect(res.status).toBe(400);
  });

  it("returns 400 when includeAdjacent is missing", async () => {
    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "SWE", companies: ["Acme"] });
    expect(res.status).toBe(400);
  });

  it("returns 400 when includeAdjacent is not a boolean", async () => {
    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "SWE", includeAdjacent: "yes", companies: ["Acme"] });
    expect(res.status).toBe(400);
  });

  it("returns 400 when companies is missing", async () => {
    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "SWE", includeAdjacent: false });
    expect(res.status).toBe(400);
  });

  it("returns 400 when companies is empty (zero entries)", async () => {
    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "SWE", includeAdjacent: false, companies: [] });
    expect(res.status).toBe(400);
  });

  it("returns 400 when companies has more than 10 entries", async () => {
    const companies = Array.from({ length: 11 }, (_, i) => `Co${i + 1}`);
    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "SWE", includeAdjacent: false, companies });
    expect(res.status).toBe(400);
  });

  it("returns 400 when a company entry is empty after trimming", async () => {
    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "SWE", includeAdjacent: false, companies: ["Acme", "   "] });
    expect(res.status).toBe(400);
  });

  it("returns 400 when a company entry is not a string", async () => {
    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "SWE", includeAdjacent: false, companies: ["Acme", 99] });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/runs — durable creation
// ---------------------------------------------------------------------------

describe("POST /api/runs — durable creation", () => {
  it("returns 201 with a non-empty runId string", async () => {
    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "Software Engineer", includeAdjacent: false, companies: ["Acme"] });

    expect(res.status).toBe(201);
    expect(typeof res.body.runId).toBe("string");
    expect(res.body.runId.length).toBeGreaterThan(0);
    cleanup.push(res.body.runId);
  });

  it("creates exactly one runs row", async () => {
    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "SWE", includeAdjacent: false, companies: ["Acme"] });

    const { runId } = res.body;
    cleanup.push(runId);

    const rows = db.prepare("SELECT id FROM runs WHERE id = ?").all(runId);
    expect(rows).toHaveLength(1);
  });

  it("run row has status CREATED", async () => {
    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "SWE", includeAdjacent: false, companies: ["Acme"] });

    const { runId } = res.body;
    cleanup.push(runId);

    const row = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    expect(row.status).toBe("CREATED");
  });

  it("run row has role_spec_json null immediately after creation (API must not call LLM)", async () => {
    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "SWE", includeAdjacent: false, companies: ["Acme"] });

    const { runId } = res.body;
    cleanup.push(runId);

    const row = db.prepare("SELECT role_spec_json FROM runs WHERE id = ?").get(runId) as { role_spec_json: string | null };
    expect(row.role_spec_json).toBeNull();
  });

  it("run row has error_code and error_message null", async () => {
    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "SWE", includeAdjacent: false, companies: ["Acme"] });

    const { runId } = res.body;
    cleanup.push(runId);

    const row = db.prepare("SELECT error_code, error_message FROM runs WHERE id = ?").get(runId) as {
      error_code: string | null;
      error_message: string | null;
    };
    expect(row.error_code).toBeNull();
    expect(row.error_message).toBeNull();
  });

  it("persists include_adjacent=false as integer 0 in DB", async () => {
    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "SWE", includeAdjacent: false, companies: ["Acme"] });

    const { runId } = res.body;
    cleanup.push(runId);

    const row = db.prepare("SELECT include_adjacent FROM runs WHERE id = ?").get(runId) as { include_adjacent: number };
    expect(row.include_adjacent).toBe(0);
  });

  it("persists include_adjacent=true as integer 1 in DB", async () => {
    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "SWE", includeAdjacent: true, companies: ["Acme"] });

    const { runId } = res.body;
    cleanup.push(runId);

    const row = db.prepare("SELECT include_adjacent FROM runs WHERE id = ?").get(runId) as { include_adjacent: number };
    expect(row.include_adjacent).toBe(1);
  });

  it("creates exactly N run_companies rows for N submitted companies", async () => {
    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "SWE", includeAdjacent: false, companies: ["Alpha", "Beta", "Gamma"] });

    const { runId } = res.body;
    cleanup.push(runId);

    const rows = db.prepare("SELECT id FROM run_companies WHERE run_id = ?").all(runId);
    expect(rows).toHaveLength(3);
  });

  it("all run_companies rows start with status PENDING", async () => {
    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "SWE", includeAdjacent: false, companies: ["Alpha", "Beta"] });

    const { runId } = res.body;
    cleanup.push(runId);

    const rows = db.prepare("SELECT status FROM run_companies WHERE run_id = ?").all(runId) as { status: string }[];
    expect(rows.every((r) => r.status === "PENDING")).toBe(true);
  });

  it("preserves company submission order via input_index", async () => {
    const companies = ["Zeta", "Alpha", "Mu"];
    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "SWE", includeAdjacent: false, companies });

    const { runId } = res.body;
    cleanup.push(runId);

    const rows = db
      .prepare("SELECT company_name, input_index FROM run_companies WHERE run_id = ? ORDER BY input_index ASC")
      .all(runId) as { company_name: string; input_index: number }[];

    expect(rows.map((r) => r.company_name)).toEqual(["Zeta", "Alpha", "Mu"]);
    expect(rows.map((r) => r.input_index)).toEqual([0, 1, 2]);
  });

  it("companies remain PENDING after creation (no inline worker processing)", async () => {
    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "SWE", includeAdjacent: false, companies: ["Acme"] });

    const { runId } = res.body;
    cleanup.push(runId);

    // Worker is not running in tests (NODE_ENV=test prevents app.listen()).
    // Companies must be PENDING and run must be CREATED immediately after POST.
    const compRows = db.prepare("SELECT status FROM run_companies WHERE run_id = ?").all(runId) as { status: string }[];
    expect(compRows.every((r) => r.status === "PENDING")).toBe(true);

    const runRow = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    expect(runRow.status).toBe("CREATED");
  });

  it("accepts exactly 10 companies (boundary)", async () => {
    const companies = Array.from({ length: 10 }, (_, i) => `Co${i + 1}`);
    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "SWE", includeAdjacent: false, companies });

    expect(res.status).toBe(201);
    cleanup.push(res.body.runId);
  });

  it("each POST generates a distinct run_id", async () => {
    const body = { role: "SWE", includeAdjacent: false, companies: ["Acme"] };
    const r1 = await request(app).post("/api/runs").set("Cookie", authCookie).send(body);
    const r2 = await request(app).post("/api/runs").set("Cookie", authCookie).send(body);

    cleanup.push(r1.body.runId, r2.body.runId);
    expect(r1.body.runId).not.toBe(r2.body.runId);
  });

  it("sets runs.user_id to the authenticated user", async () => {
    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "SWE", includeAdjacent: false, companies: ["Acme"] });

    const { runId } = res.body;
    cleanup.push(runId);

    const row = db.prepare("SELECT user_id FROM runs WHERE id = ?").get(runId) as { user_id: string };
    expect(row.user_id).toBe(authUserId);
  });
});

// ---------------------------------------------------------------------------
// GET /api/runs/:runId — auth requirement
// ---------------------------------------------------------------------------

describe("GET /api/runs/:runId — auth requirement", () => {
  it("returns 401 without a session", async () => {
    const res = await request(app).get(`/api/runs/${randomUUID()}`);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /api/runs/:runId
// ---------------------------------------------------------------------------

describe("GET /api/runs/:runId", () => {
  it("returns 404 for an unknown run id", async () => {
    const res = await request(app).get("/api/runs/does-not-exist").set("Cookie", authCookie);
    expect(res.status).toBe(404);
  });

  it("returns 200 with the full RunDetailResponse shape", async () => {
    const post = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "SWE", includeAdjacent: false, companies: ["Acme"] });
    const { runId } = post.body;
    cleanup.push(runId);

    const res = await request(app).get(`/api/runs/${runId}`).set("Cookie", authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("run");
    expect(res.body).toHaveProperty("companies");
    expect(res.body).toHaveProperty("matched_jobs");
  });

  it("run object contains all required fields with correct values", async () => {
    const post = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "Software Engineer", includeAdjacent: true, companies: ["Acme"] });
    const { runId } = post.body;
    cleanup.push(runId);

    const res = await request(app).get(`/api/runs/${runId}`).set("Cookie", authCookie);
    const { run } = res.body;

    expect(run.id).toBe(runId);
    expect(run.status).toBe("CREATED");
    expect(run.role_raw).toBe("Software Engineer");
    expect(run.include_adjacent).toBe(true);
    expect(run.error_code).toBeNull();
    expect(run.error_message).toBeNull();
  });

  it("include_adjacent is returned as boolean true (not integer 1)", async () => {
    const post = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "SWE", includeAdjacent: true, companies: ["Acme"] });
    const { runId } = post.body;
    cleanup.push(runId);

    const res = await request(app).get(`/api/runs/${runId}`).set("Cookie", authCookie);
    expect(typeof res.body.run.include_adjacent).toBe("boolean");
    expect(res.body.run.include_adjacent).toBe(true);
  });

  it("include_adjacent is returned as boolean false (not integer 0)", async () => {
    const post = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "SWE", includeAdjacent: false, companies: ["Acme"] });
    const { runId } = post.body;
    cleanup.push(runId);

    const res = await request(app).get(`/api/runs/${runId}`).set("Cookie", authCookie);
    expect(typeof res.body.run.include_adjacent).toBe("boolean");
    expect(res.body.run.include_adjacent).toBe(false);
  });

  it("companies are ordered by input_index ascending regardless of insertion order", async () => {
    const post = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "SWE", includeAdjacent: false, companies: ["Zeta", "Alpha", "Mu"] });
    const { runId } = post.body;
    cleanup.push(runId);

    const res = await request(app).get(`/api/runs/${runId}`).set("Cookie", authCookie);
    const names = res.body.companies.map((c: { company_name: string }) => c.company_name);
    expect(names).toEqual(["Zeta", "Alpha", "Mu"]);
  });

  it("company objects include all evidence fields from the contract", async () => {
    const post = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "SWE", includeAdjacent: false, companies: ["Acme"] });
    const { runId } = post.body;
    cleanup.push(runId);

    const res = await request(app).get(`/api/runs/${runId}`).set("Cookie", authCookie);
    const company = res.body.companies[0];

    expect(company).toHaveProperty("id");
    expect(company).toHaveProperty("company_name", "Acme");
    expect(company).toHaveProperty("status", "PENDING");
    expect(company).toHaveProperty("input_index", 0);
    expect(company).toHaveProperty("failure_code");
    expect(company).toHaveProperty("failure_reason");
    expect(company).toHaveProperty("careers_url");
    expect(company).toHaveProperty("ats_type");
    expect(company).toHaveProperty("extractor_used");
    expect(company).toHaveProperty("listings_scanned");
    expect(company).toHaveProperty("pages_visited");
  });

  it("matched_jobs is an empty array before any jobs exist", async () => {
    const post = await request(app)
      .post("/api/runs")
      .set("Cookie", authCookie)
      .send({ role: "SWE", includeAdjacent: false, companies: ["Acme"] });
    const { runId } = post.body;
    cleanup.push(runId);

    const res = await request(app).get(`/api/runs/${runId}`).set("Cookie", authCookie);
    expect(Array.isArray(res.body.matched_jobs)).toBe(true);
    expect(res.body.matched_jobs).toHaveLength(0);
  });

  it("returns 200 with correct shape for a FAILED_ROLE_SPEC run", async () => {
    const runId = randomUUID();
    const companyId = randomUUID();
    cleanup.push(runId);

    db.prepare(
      `INSERT INTO runs (id, created_at, status, role_raw, include_adjacent, company_count, error_code, error_message, user_id)
       VALUES (?, ?, 'FAILED_ROLE_SPEC', 'Software Engineer', 0, 1, 'ROLE_SPEC_FAILED', 'role spec generation failed', ?)`,
    ).run(runId, Date.now(), authUserId);

    db.prepare(
      `INSERT INTO run_companies (id, run_id, company_name, input_index, status, created_at, failure_code, failure_reason)
       VALUES (?, ?, 'Acme', 0, 'CANCELLED', ?, 'ROLE_SPEC_FAILED', 'role spec generation failed')`,
    ).run(companyId, runId, Date.now());

    const res = await request(app).get(`/api/runs/${runId}`).set("Cookie", authCookie);

    expect(res.status).toBe(200);
    expect(res.body.run.status).toBe("FAILED_ROLE_SPEC");
    expect(res.body.run.error_code).toBe("ROLE_SPEC_FAILED");
    expect(res.body.run.error_message).toBe("role spec generation failed");
    expect(res.body.companies).toHaveLength(1);
    expect(res.body.companies[0].status).toBe("CANCELLED");
    expect(res.body.companies[0].failure_code).toBe("ROLE_SPEC_FAILED");
    expect(res.body.matched_jobs).toHaveLength(0);
  });

  it("returns 200 with correct shape for a COMPLETED run with matched jobs and evidence fields", async () => {
    const runId = randomUUID();
    const companyId = randomUUID();
    cleanup.push(runId);

    db.prepare(
      `INSERT INTO runs (id, created_at, status, role_raw, include_adjacent, company_count, user_id)
       VALUES (?, ?, 'COMPLETED', 'Software Engineer', 0, 1, ?)`,
    ).run(runId, Date.now(), authUserId);

    db.prepare(
      `INSERT INTO run_companies
         (id, run_id, company_name, input_index, status, created_at,
          careers_url, ats_type, extractor_used, listings_scanned, pages_visited)
       VALUES (?, ?, 'Acme', 0, 'MATCHES_FOUND', ?,
               'https://acme.com/careers', 'GREENHOUSE', 'GREENHOUSE', 12, 1)`,
    ).run(companyId, runId, Date.now());

    db.prepare(
      `INSERT INTO job_rows (id, run_id, company_id, title, location, url, match_reason)
       VALUES (?, ?, ?, 'Software Engineer', 'Remote', 'https://boards.greenhouse.io/acme/1', 'Matched inclusion phrase Software Engineer')`,
    ).run(randomUUID(), runId, companyId);

    const res = await request(app).get(`/api/runs/${runId}`).set("Cookie", authCookie);

    expect(res.status).toBe(200);

    const { run, companies, matched_jobs } = res.body;

    expect(run.status).toBe("COMPLETED");
    expect(run.error_code).toBeNull();
    expect(run.error_message).toBeNull();
    expect(typeof run.include_adjacent).toBe("boolean");

    expect(companies).toHaveLength(1);
    const company = companies[0];
    expect(company.status).toBe("MATCHES_FOUND");
    expect(company.careers_url).toBe("https://acme.com/careers");
    expect(company.ats_type).toBe("GREENHOUSE");
    expect(company.extractor_used).toBe("GREENHOUSE");
    expect(company.listings_scanned).toBe(12);
    expect(company.pages_visited).toBe(1);

    expect(matched_jobs).toHaveLength(1);
    expect(matched_jobs[0].title).toBe("Software Engineer");
    expect(matched_jobs[0].location).toBe("Remote");
    expect(matched_jobs[0].url).toBe("https://boards.greenhouse.io/acme/1");
    expect(matched_jobs[0].match_reason).toBe("Matched inclusion phrase Software Engineer");
    expect(matched_jobs[0].run_id).toBe(runId);
    expect(matched_jobs[0].company_id).toBe(companyId);
  });

  it("matched_jobs are ordered by company input_index ascending (primary sort key)", async () => {
    // Set up a completed run with two companies and manually inserted jobs.
    // Jobs for the company with input_index=0 must appear before jobs for input_index=1
    // regardless of the order they were inserted into job_rows.
    const runId = randomUUID();
    const compAId = randomUUID();
    const compBId = randomUUID();
    cleanup.push(runId);

    db.prepare(
      `INSERT INTO runs (id, created_at, status, role_raw, include_adjacent, company_count, user_id)
       VALUES (?, ?, 'COMPLETED', 'SWE', 0, 2, ?)`
    ).run(runId, Date.now(), authUserId);

    db.prepare(
      `INSERT INTO run_companies (id, run_id, company_name, input_index, status, created_at)
       VALUES (?, ?, 'Alpha', 0, 'MATCHES_FOUND', ?)`
    ).run(compAId, runId, Date.now());

    db.prepare(
      `INSERT INTO run_companies (id, run_id, company_name, input_index, status, created_at)
       VALUES (?, ?, 'Beta', 1, 'MATCHES_FOUND', ?)`
    ).run(compBId, runId, Date.now());

    // Insert Beta's job first so insertion order differs from expected response order.
    db.prepare(
      `INSERT INTO job_rows (id, run_id, company_id, title, location, url, match_reason)
       VALUES (?, ?, ?, 'Engineer at Beta', null, 'https://x/beta', 'match')`
    ).run(randomUUID(), runId, compBId);

    db.prepare(
      `INSERT INTO job_rows (id, run_id, company_id, title, location, url, match_reason)
       VALUES (?, ?, ?, 'Engineer at Alpha', null, 'https://x/alpha', 'match')`
    ).run(randomUUID(), runId, compAId);

    const res = await request(app).get(`/api/runs/${runId}`).set("Cookie", authCookie);
    const titles = res.body.matched_jobs.map((j: { title: string }) => j.title);

    // Alpha (input_index=0) must appear before Beta (input_index=1).
    expect(titles.indexOf("Engineer at Alpha")).toBeLessThan(titles.indexOf("Engineer at Beta"));
  });
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

describe("GET /health", () => {
  it("returns 200 with ok: true", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
