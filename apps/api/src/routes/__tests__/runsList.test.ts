/**
 * Milestone 2 (UX Cleanup and Dashboard Clarity) tests for the owned run-list
 * read endpoint GET /api/runs. This is a read-only surface so a returning user
 * can rediscover and reopen previous manual scans. It must scope strictly to
 * the requesting user, order newest-first with a deterministic id tie-breaker,
 * and report per-run company outcome counts derived from run_companies without
 * changing any scanner status meaning.
 *
 * Isolation: vitest.config.ts sets DB_PATH=:memory: so each test worker gets a
 * fresh in-memory SQLite DB. NODE_ENV=test prevents server.ts from starting the
 * worker loop or binding a port.
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

interface InsertRunOptions {
  runId: string;
  userId: string | null;
  status?: string;
  roleRaw?: string;
  includeAdjacent?: 0 | 1;
  createdAt?: number;
  companyStatuses?: string[];
}

/** Inserts one runs row plus a run_companies row per provided company status. */
function insertRun(options: InsertRunOptions): void {
  const {
    runId,
    userId,
    status = "COMPLETED",
    roleRaw = "Software Engineer",
    includeAdjacent = 0,
    createdAt = Date.now(),
    companyStatuses = [],
  } = options;

  db.prepare(
    `INSERT INTO runs (id, created_at, status, role_raw, include_adjacent, company_count, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(runId, createdAt, status, roleRaw, includeAdjacent, companyStatuses.length, userId);

  companyStatuses.forEach((companyStatus, index) => {
    db.prepare(
      `INSERT INTO run_companies (id, run_id, company_name, input_index, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), runId, `Company ${index}`, index, companyStatus, createdAt);
  });
}

describe("GET /api/runs — owned run list", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/runs");
    expect(res.status).toBe(401);
  });

  it("returns only the requesting user's runs and excludes another user's runs", async () => {
    const { cookie: aCookie, userId: aUserId } = await signUpUser("list-a@example.com");
    const { userId: bUserId } = await signUpUser("list-b@example.com");

    const aRunId = randomUUID();
    const bRunId = randomUUID();
    runCleanup.push(aRunId, bRunId);
    insertRun({ runId: aRunId, userId: aUserId });
    insertRun({ runId: bRunId, userId: bUserId });

    const res = await request(app).get("/api/runs").set("Cookie", aCookie);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: string }[]).map((r) => r.id);
    expect(ids).toContain(aRunId);
    expect(ids).not.toContain(bRunId);
  });

  it("excludes ownerless/default legacy runs (user_id IS NULL)", async () => {
    // A signup backfills any pre-existing ownerless runs to the first user, so
    // insert the ownerless run AFTER signup to keep it genuinely ownerless.
    const { cookie } = await signUpUser("list-owner@example.com");

    const orphanRunId = randomUUID();
    runCleanup.push(orphanRunId);
    insertRun({ runId: orphanRunId, userId: null });

    const res = await request(app).get("/api/runs").set("Cookie", cookie);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: string }[]).map((r) => r.id);
    expect(ids).not.toContain(orphanRunId);
  });

  it("orders newest-first by created_at DESC with id DESC as deterministic tie-breaker", async () => {
    const { cookie, userId } = await signUpUser("list-order@example.com");

    const older = randomUUID();
    const newer = randomUUID();
    // Two runs share the same created_at to exercise the id tie-breaker.
    const sameTime = Date.now();
    const tieA = "00000000-0000-0000-0000-000000000001";
    const tieB = "00000000-0000-0000-0000-000000000002";
    runCleanup.push(older, newer, tieA, tieB);

    insertRun({ runId: older, userId, createdAt: 1000 });
    insertRun({ runId: newer, userId, createdAt: 2000 });
    insertRun({ runId: tieA, userId, createdAt: sameTime });
    insertRun({ runId: tieB, userId, createdAt: sameTime });

    const res = await request(app).get("/api/runs").set("Cookie", cookie);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: string }[]).map((r) => r.id);

    // Same-created_at pair must come first (largest created_at), tie broken by
    // id DESC (tieB before tieA), then the newer, then the older run.
    expect(ids).toEqual([tieB, tieA, newer, older]);
  });

  it("returns include_adjacent as a boolean", async () => {
    const { cookie, userId } = await signUpUser("list-bool@example.com");
    const trueRunId = randomUUID();
    const falseRunId = randomUUID();
    runCleanup.push(trueRunId, falseRunId);
    insertRun({ runId: trueRunId, userId, includeAdjacent: 1, createdAt: 2 });
    insertRun({ runId: falseRunId, userId, includeAdjacent: 0, createdAt: 1 });

    const res = await request(app).get("/api/runs").set("Cookie", cookie);
    const byId = new Map(
      (res.body as { id: string; include_adjacent: boolean }[]).map((r) => [r.id, r.include_adjacent])
    );
    expect(byId.get(trueRunId)).toBe(true);
    expect(byId.get(falseRunId)).toBe(false);
  });

  it("returns company_count and correct matched/no-match/unverified counts; UNVERIFIED counts but CANCELLED does not", async () => {
    const { cookie, userId } = await signUpUser("list-counts@example.com");
    const runId = randomUUID();
    runCleanup.push(runId);
    insertRun({
      runId,
      userId,
      companyStatuses: [
        "MATCHES_FOUND",
        "MATCHES_FOUND",
        "NO_MATCH_SCAN_COMPLETED",
        "UNVERIFIED",
        "CANCELLED",
        "PENDING",
      ],
    });

    const res = await request(app).get("/api/runs").set("Cookie", cookie);
    expect(res.status).toBe(200);
    const item = (
      res.body as {
        id: string;
        company_count: number;
        matched_company_count: number;
        no_match_company_count: number;
        unverified_company_count: number;
      }[]
    ).find((r) => r.id === runId)!;

    expect(item.company_count).toBe(6);
    expect(item.matched_company_count).toBe(2);
    expect(item.no_match_company_count).toBe(1);
    // UNVERIFIED contributes to the unverified count; CANCELLED must not.
    expect(item.unverified_company_count).toBe(1);
  });

  it("lists CREATED, READY, RUNNING, and FAILED_ROLE_SPEC runs (not just terminal COMPLETED runs)", async () => {
    const { cookie, userId } = await signUpUser("list-statuses@example.com");
    const created = randomUUID();
    const ready = randomUUID();
    const running = randomUUID();
    const failed = randomUUID();
    runCleanup.push(created, ready, running, failed);
    insertRun({ runId: created, userId, status: "CREATED", createdAt: 4 });
    insertRun({ runId: ready, userId, status: "READY", createdAt: 3 });
    insertRun({ runId: running, userId, status: "RUNNING", createdAt: 2 });
    insertRun({ runId: failed, userId, status: "FAILED_ROLE_SPEC", createdAt: 1 });

    const res = await request(app).get("/api/runs").set("Cookie", cookie);
    expect(res.status).toBe(200);
    const byId = new Map((res.body as { id: string; status: string }[]).map((r) => [r.id, r.status]));
    expect(byId.get(created)).toBe("CREATED");
    expect(byId.get(ready)).toBe("READY");
    expect(byId.get(running)).toBe("RUNNING");
    expect(byId.get(failed)).toBe("FAILED_ROLE_SPEC");
  });

  it("returns an empty array for a user with no runs", async () => {
    const { cookie } = await signUpUser("list-empty@example.com");
    const res = await request(app).get("/api/runs").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("GET /api/runs does not disturb existing run endpoints", () => {
  it("existing POST /api/runs behavior remains unchanged (201 + run persisted)", async () => {
    const { cookie, userId } = await signUpUser("list-post@example.com");
    const res = await request(app)
      .post("/api/runs")
      .set("Cookie", cookie)
      .send({ role: "Engineer", includeAdjacent: false, companies: ["Acme"] });
    expect(res.status).toBe(201);
    const runId = res.body.runId as string;
    runCleanup.push(runId);
    const row = db.prepare("SELECT user_id, status FROM runs WHERE id = ?").get(runId) as {
      user_id: string;
      status: string;
    };
    expect(row.user_id).toBe(userId);
    expect(row.status).toBe("CREATED");
  });

  it("existing GET /api/runs/:runId behavior remains unchanged", async () => {
    const { cookie, userId } = await signUpUser("list-detail@example.com");
    const runId = randomUUID();
    runCleanup.push(runId);
    insertRun({ runId, userId, companyStatuses: ["MATCHES_FOUND"] });

    const res = await request(app).get(`/api/runs/${runId}`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.run.id).toBe(runId);
    expect(Array.isArray(res.body.companies)).toBe(true);
    expect(Array.isArray(res.body.matched_jobs)).toBe(true);
  });
});
