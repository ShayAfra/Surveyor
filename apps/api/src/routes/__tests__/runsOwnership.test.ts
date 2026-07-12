/**
 * Milestone 1 (Accounts and Owned Scanner Data) ownership/isolation tests for
 * POST /api/runs, GET /api/runs/:runId, and GET /api/jobs/:jobRowId/detail.
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

const runCleanup: string[] = [];

afterEach(() => {
  for (const runId of runCleanup.splice(0)) {
    db.prepare("DELETE FROM job_details WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM trace_events WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM job_rows WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM run_companies WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
  }
  db.prepare("DELETE FROM sessions").run();
  db.prepare("DELETE FROM users").run();
});

function extractSessionCookie(res: request.Response): string {
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie as unknown as string];
  const sessionCookie = cookies.find((c) => c.startsWith("surveyor_session="));
  return (sessionCookie as string).split(";")[0];
}

async function signUpUser(email: string): Promise<{ cookie: string; userId: string }> {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "password123" });
  return { cookie: extractSessionCookie(res), userId: res.body.id as string };
}

function insertCompletedRunWithMatch(
  runId: string,
  companyId: string,
  jobId: string,
  userId: string
): void {
  db.prepare(
    `INSERT INTO runs (id, created_at, status, role_raw, include_adjacent, company_count, user_id)
     VALUES (?, ?, 'COMPLETED', 'Software Engineer', 0, 1, ?)`
  ).run(runId, Date.now(), userId);

  db.prepare(
    `INSERT INTO run_companies (id, run_id, company_name, input_index, status, created_at)
     VALUES (?, ?, 'Acme', 0, 'MATCHES_FOUND', ?)`
  ).run(companyId, runId, Date.now());

  db.prepare(
    `INSERT INTO job_rows (id, run_id, company_id, title, location, url, match_reason)
     VALUES (?, ?, ?, 'Software Engineer', 'Remote', 'https://boards.greenhouse.io/acme/1', 'Matched inclusion phrase Software Engineer')`
  ).run(jobId, runId, companyId);

  db.prepare(
    `INSERT INTO job_details (id, run_id, company_id, job_row_id, job_url, description_text, fetched_at, failure_code, failure_reason, created_at)
     VALUES (?, ?, ?, ?, ?, 'Full job description text.', ?, NULL, NULL, ?)`
  ).run(randomUUID(), runId, companyId, jobId, "https://boards.greenhouse.io/acme/1", Date.now(), Date.now());
}

describe("POST /api/runs — auth requirement", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app)
      .post("/api/runs")
      .send({ role: "Engineer", includeAdjacent: false, companies: ["Acme"] });
    expect(res.status).toBe(401);
  });

  it("creates a run with user_id set when authenticated", async () => {
    const { cookie, userId } = await signUpUser("creator@example.com");

    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", cookie)
      .send({ role: "Engineer", includeAdjacent: false, companies: ["Acme"] });

    expect(res.status).toBe(201);
    const runId = res.body.runId as string;
    runCleanup.push(runId);

    const row = db.prepare("SELECT user_id FROM runs WHERE id = ?").get(runId) as {
      user_id: string;
    };
    expect(row.user_id).toBe(userId);
  });

  it("preserves existing validation behavior (empty companies rejected) while authenticated", async () => {
    const { cookie } = await signUpUser("validator@example.com");

    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", cookie)
      .send({ role: "Engineer", includeAdjacent: false, companies: ["Acme", "  "] });

    expect(res.status).toBe(400);
  });

  it("preserves existing validation behavior (>10 companies rejected) while authenticated", async () => {
    const { cookie } = await signUpUser("cap@example.com");

    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", cookie)
      .send({
        role: "Engineer",
        includeAdjacent: false,
        companies: Array.from({ length: 11 }, (_, i) => `Company ${i}`),
      });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/runs/:runId — ownership", () => {
  it("returns 401 without auth", async () => {
    const runId = randomUUID();
    const res = await request(app).get(`/api/runs/${runId}`);
    expect(res.status).toBe(401);
  });

  it("returns 200 for the owning user", async () => {
    const { cookie, userId } = await signUpUser("owner@example.com");
    const runId = randomUUID();
    const companyId = randomUUID();
    const jobId = randomUUID();
    runCleanup.push(runId);
    insertCompletedRunWithMatch(runId, companyId, jobId, userId);

    const res = await request(app).get(`/api/runs/${runId}`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.run.id).toBe(runId);
  });

  it("returns 404 for a different authenticated user (does not leak existence)", async () => {
    const { userId: ownerId } = await signUpUser("owner2@example.com");
    const { cookie: strangerCookie } = await signUpUser("stranger@example.com");

    const runId = randomUUID();
    const companyId = randomUUID();
    const jobId = randomUUID();
    runCleanup.push(runId);
    insertCompletedRunWithMatch(runId, companyId, jobId, ownerId);

    const res = await request(app).get(`/api/runs/${runId}`).set("Cookie", strangerCookie);
    expect(res.status).toBe(404);
  });

  it("user A cannot read user B's run", async () => {
    const { cookie: aCookie } = await signUpUser("userA@example.com");
    const { userId: bUserId } = await signUpUser("userB@example.com");

    const runId = randomUUID();
    const companyId = randomUUID();
    const jobId = randomUUID();
    runCleanup.push(runId);
    insertCompletedRunWithMatch(runId, companyId, jobId, bUserId);

    const res = await request(app).get(`/api/runs/${runId}`).set("Cookie", aCookie);
    expect(res.status).toBe(404);
  });

  it("returns 404 for a run that does not exist at all", async () => {
    const { cookie } = await signUpUser("noexist@example.com");
    const res = await request(app).get(`/api/runs/${randomUUID()}`).set("Cookie", cookie);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/jobs/:jobRowId/detail — ownership", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).get(`/api/jobs/${randomUUID()}/detail`);
    expect(res.status).toBe(401);
  });

  it("returns 200 for the owning user", async () => {
    const { cookie, userId } = await signUpUser("jobowner@example.com");
    const runId = randomUUID();
    const companyId = randomUUID();
    const jobId = randomUUID();
    runCleanup.push(runId);
    insertCompletedRunWithMatch(runId, companyId, jobId, userId);

    const res = await request(app).get(`/api/jobs/${jobId}/detail`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.job_row_id).toBe(jobId);
  });

  it("returns 404 for a different authenticated user", async () => {
    const { userId: ownerId } = await signUpUser("jobowner2@example.com");
    const { cookie: strangerCookie } = await signUpUser("jobstranger@example.com");

    const runId = randomUUID();
    const companyId = randomUUID();
    const jobId = randomUUID();
    runCleanup.push(runId);
    insertCompletedRunWithMatch(runId, companyId, jobId, ownerId);

    const res = await request(app).get(`/api/jobs/${jobId}/detail`).set("Cookie", strangerCookie);
    expect(res.status).toBe(404);
  });

  it("user A cannot read user B's job detail even with a known job_row_id", async () => {
    const { cookie: aCookie } = await signUpUser("jobUserA@example.com");
    const { userId: bUserId } = await signUpUser("jobUserB@example.com");

    const runId = randomUUID();
    const companyId = randomUUID();
    const jobId = randomUUID();
    runCleanup.push(runId);
    insertCompletedRunWithMatch(runId, companyId, jobId, bUserId);

    // User A knows the exact job_row_id (e.g. guessed or leaked) but must still be denied.
    const res = await request(app).get(`/api/jobs/${jobId}/detail`).set("Cookie", aCookie);
    expect(res.status).toBe(404);
  });
});
