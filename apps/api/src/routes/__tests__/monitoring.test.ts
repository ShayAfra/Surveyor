/**
 * Milestone 6 (Continuous Monitoring) tests:
 *   - GET  /api/saved-searches/:id/monitoring
 *   - PUT  /api/saved-searches/:id/monitoring
 *   - GET  /api/saved-searches/:id/monitoring/executions
 *   - GET  /api/saved-searches/:id/monitoring/matches
 *   - POST /api/saved-searches/:id/monitoring/run-now
 *   - monitoringTick loop (reconciliation + due-search selection)
 *   - new match detection
 *   - deletion/ownership behavior
 *
 * Isolation: vitest.config.ts sets DB_PATH=:memory: so each test worker gets
 * a fresh in-memory SQLite DB. NODE_ENV=test prevents server.ts from
 * starting the worker loop, the monitoring loop, or binding a port.
 */

import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { CompanyStatus, RunStatus } from "@surveyor/shared";
import { app } from "../../server.js";
import { db } from "../../db/db.js";
import { monitoringTick } from "../../monitoring/startMonitoringLoop.js";

afterEach(() => {
  db.prepare("DELETE FROM monitoring_matches").run();
  db.prepare("DELETE FROM monitoring_executions").run();
  db.prepare("DELETE FROM job_details").run();
  db.prepare("DELETE FROM job_rows").run();
  db.prepare("DELETE FROM run_companies").run();
  db.prepare("DELETE FROM runs").run();
  db.prepare("DELETE FROM saved_search_companies").run();
  db.prepare("DELETE FROM saved_searches").run();
  db.prepare("DELETE FROM saved_companies").run();
  db.prepare("DELETE FROM sessions").run();
  db.prepare("DELETE FROM users").run();
});

function extractSessionCookie(res: request.Response): string {
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie as unknown as string];
  const sessionCookie = cookies.find((c) => c.startsWith("surveyor_session="));
  return (sessionCookie as string).split(";")[0];
}

async function signUpUser(label: string): Promise<{ cookie: string; userId: string }> {
  const email = `monitoring-${label}-${randomUUID()}@example.com`;
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "password123" });
  return { cookie: extractSessionCookie(res), userId: res.body.id as string };
}

function validSavedSearchBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "Backend roles",
    role_raw: "backend engineer",
    include_adjacent: true,
    notes: null,
    companies: [{ company_name: "Acme" }, { company_name: "Globex" }],
    ...overrides,
  };
}

async function createSavedSearch(cookie: string, overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/saved-searches")
    .set("Cookie", cookie)
    .send(validSavedSearchBody(overrides));
  return res.body.id as string;
}

/** Directly sets a run's status, bypassing worker processing (tests reconciliation only). */
function setRunStatus(runId: string, status: RunStatus): void {
  db.prepare(`UPDATE runs SET status = ? WHERE id = ?`).run(status, runId);
}

/** Inserts one run_company row in a final status for an existing run. */
function insertFinalCompany(
  runId: string,
  companyName: string,
  inputIndex: number,
  status: CompanyStatus
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO run_companies (id, run_id, company_name, input_index, status, created_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, runId, companyName, inputIndex, status, Date.now(), Date.now(), Date.now());
  return id;
}

/**
 * Runs `fn` with db.prepare patched so that only the specific
 * `SELECT status FROM runs WHERE id = ?` lookup for `brokenRunId` throws -
 * every other query, including the identical lookup for a different run id,
 * behaves normally. Used to simulate a genuine database-level failure while
 * reconciling one monitoring execution (Blocker 2 isolation tests). Restores
 * the original db.prepare unconditionally via try/finally, and uses a plain
 * function reassignment rather than vi.spyOn so nothing can leak into other
 * test files sharing this in-memory database (fileParallelism: false).
 */
function withPatchedRunStatusLookup(brokenRunId: string, fn: () => void): void {
  const originalPrepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = originalPrepare(sql);
    if (sql === `SELECT status FROM runs WHERE id = ?`) {
      const originalGet = statement.get.bind(statement);
      statement.get = ((...args: unknown[]) => {
        if (args[0] === brokenRunId) {
          throw new Error("simulated database error for broken run");
        }
        return originalGet(...(args as [unknown]));
      }) as typeof statement.get;
    }
    return statement;
  }) as typeof db.prepare;

  try {
    fn();
  } finally {
    db.prepare = originalPrepare;
  }
}

/**
 * Runs `fn` with db.prepare patched so that the initial
 * `SELECT * FROM monitoring_executions WHERE status = ?` query -
 * reconcileActiveMonitoringExecutions' lookup of active executions, which
 * runs before its per-execution loop starts - throws once. Used to verify
 * monitoringTick's own guard around Phase 1 (distinct from the per-execution
 * try/catch inside reconcileActiveMonitoringExecutions, which cannot help if
 * the failure happens before that loop even begins). Restores the original
 * db.prepare unconditionally via try/finally, and uses a plain function
 * reassignment rather than vi.spyOn so nothing can leak into other test
 * files sharing this in-memory database (fileParallelism: false).
 */
function withBrokenActiveExecutionsLookup(fn: () => void): void {
  const originalPrepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    if (sql === `SELECT * FROM monitoring_executions WHERE status = ?`) {
      return {
        all: () => {
          throw new Error("simulated database error listing active executions");
        },
      } as unknown as ReturnType<typeof db.prepare>;
    }
    return originalPrepare(sql);
  }) as typeof db.prepare;

  try {
    fn();
  } finally {
    db.prepare = originalPrepare;
  }
}

function insertJobRow(
  runId: string,
  companyId: string,
  title: string,
  location: string | null,
  url: string
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO job_rows (id, run_id, company_id, title, location, url, match_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, runId, companyId, title, location, url, "matched include_title");
  return id;
}

describe("monitoring — auth requirement", () => {
  it("GET /api/saved-searches/:id/monitoring returns 401 without auth", async () => {
    const res = await request(app).get(`/api/saved-searches/${randomUUID()}/monitoring`);
    expect(res.status).toBe(401);
  });

  it("PUT /api/saved-searches/:id/monitoring returns 401 without auth", async () => {
    const res = await request(app)
      .put(`/api/saved-searches/${randomUUID()}/monitoring`)
      .send({ enabled: true });
    expect(res.status).toBe(401);
  });

  it("GET /api/saved-searches/:id/monitoring/executions returns 401 without auth", async () => {
    const res = await request(app).get(
      `/api/saved-searches/${randomUUID()}/monitoring/executions`
    );
    expect(res.status).toBe(401);
  });

  it("GET /api/saved-searches/:id/monitoring/matches returns 401 without auth", async () => {
    const res = await request(app).get(`/api/saved-searches/${randomUUID()}/monitoring/matches`);
    expect(res.status).toBe(401);
  });

  it("POST /api/saved-searches/:id/monitoring/run-now returns 401 without auth", async () => {
    const res = await request(app).post(
      `/api/saved-searches/${randomUUID()}/monitoring/run-now`
    );
    expect(res.status).toBe(401);
  });
});

describe("monitoring config — enable/disable for own saved search", () => {
  it("defaults to disabled with no last_checked_at", async () => {
    const { cookie } = await signUpUser("default");
    const searchId = await createSavedSearch(cookie);

    const res = await request(app)
      .get(`/api/saved-searches/${searchId}/monitoring`)
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.last_checked_at).toBeNull();
  });

  it("user can enable monitoring for own saved search", async () => {
    const { cookie } = await signUpUser("enable");
    const searchId = await createSavedSearch(cookie);

    const res = await request(app)
      .put(`/api/saved-searches/${searchId}/monitoring`)
      .set("Cookie", cookie)
      .send({ enabled: true });

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });

  it("enabling monitoring does not immediately create a run", async () => {
    const { cookie } = await signUpUser("no-immediate-run");
    const searchId = await createSavedSearch(cookie);

    await request(app)
      .put(`/api/saved-searches/${searchId}/monitoring`)
      .set("Cookie", cookie)
      .send({ enabled: true });

    const executionsRes = await request(app)
      .get(`/api/saved-searches/${searchId}/monitoring/executions`)
      .set("Cookie", cookie);
    expect(executionsRes.body).toEqual([]);
  });

  it("user can disable monitoring for own saved search", async () => {
    const { cookie } = await signUpUser("disable");
    const searchId = await createSavedSearch(cookie);
    await request(app)
      .put(`/api/saved-searches/${searchId}/monitoring`)
      .set("Cookie", cookie)
      .send({ enabled: true });

    const res = await request(app)
      .put(`/api/saved-searches/${searchId}/monitoring`)
      .set("Cookie", cookie)
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });

  it("rejects a non-boolean enabled value", async () => {
    const { cookie } = await signUpUser("bad-enabled");
    const searchId = await createSavedSearch(cookie);

    const res = await request(app)
      .put(`/api/saved-searches/${searchId}/monitoring`)
      .set("Cookie", cookie)
      .send({ enabled: "yes" });
    expect(res.status).toBe(400);
  });

  it("user cannot read/update monitoring for another user's saved search", async () => {
    const { cookie: ownerCookie } = await signUpUser("mon-owner");
    const { cookie: strangerCookie } = await signUpUser("mon-stranger");
    const searchId = await createSavedSearch(ownerCookie);

    const getRes = await request(app)
      .get(`/api/saved-searches/${searchId}/monitoring`)
      .set("Cookie", strangerCookie);
    expect(getRes.status).toBe(404);

    const putRes = await request(app)
      .put(`/api/saved-searches/${searchId}/monitoring`)
      .set("Cookie", strangerCookie)
      .send({ enabled: true });
    expect(putRes.status).toBe(404);

    const executionsRes = await request(app)
      .get(`/api/saved-searches/${searchId}/monitoring/executions`)
      .set("Cookie", strangerCookie);
    expect(executionsRes.status).toBe(404);

    const matchesRes = await request(app)
      .get(`/api/saved-searches/${searchId}/monitoring/matches`)
      .set("Cookie", strangerCookie);
    expect(matchesRes.status).toBe(404);

    const runNowRes = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", strangerCookie);
    expect(runNowRes.status).toBe(404);
  });
});

describe("POST /api/saved-searches/:id/monitoring/run-now", () => {
  it("works for own saved search and returns execution + runId", async () => {
    const { cookie } = await signUpUser("runnow1");
    const searchId = await createSavedSearch(cookie);

    const res = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);

    expect(res.status).toBe(201);
    expect(typeof res.body.runId).toBe("string");
    expect(res.body.execution.status).toBe("RUNNING");
    expect(res.body.execution.run_id).toBe(res.body.runId);
    expect(res.body.execution.new_match_count).toBe(0);
  });

  it("is allowed when monitoring_enabled = 0 (monitoring config untouched by default)", async () => {
    const { cookie } = await signUpUser("runnow-disabled");
    const searchId = await createSavedSearch(cookie);

    const configBefore = await request(app)
      .get(`/api/saved-searches/${searchId}/monitoring`)
      .set("Cookie", cookie);
    expect(configBefore.body.enabled).toBe(false);

    const res = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);
    expect(res.status).toBe(201);
  });

  it("creates a normal scanner run owned by the user, CREATED, with PENDING companies in order", async () => {
    const { cookie, userId } = await signUpUser("runnow-normal-run");
    const searchId = await createSavedSearch(cookie, {
      companies: [{ company_name: "Zeta" }, { company_name: "Alpha" }],
    });

    const res = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);

    const runRow = db.prepare("SELECT * FROM runs WHERE id = ?").get(res.body.runId) as {
      user_id: string;
      status: string;
      role_spec_json: string | null;
    };
    expect(runRow.user_id).toBe(userId);
    expect(runRow.status).toBe("CREATED");
    expect(runRow.role_spec_json).toBeNull();

    const companyRows = db
      .prepare(
        `SELECT company_name, input_index, status FROM run_companies WHERE run_id = ? ORDER BY input_index ASC`
      )
      .all(res.body.runId) as { company_name: string; input_index: number; status: string }[];
    expect(companyRows.map((r) => r.company_name)).toEqual(["Zeta", "Alpha"]);
    expect(companyRows.every((r) => r.status === "PENDING")).toBe(true);
  });

  it("creates a monitoring_executions row with status RUNNING linked to the run", async () => {
    const { cookie } = await signUpUser("runnow-execution-row");
    const searchId = await createSavedSearch(cookie);

    const res = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);

    const executionRow = db
      .prepare(`SELECT * FROM monitoring_executions WHERE run_id = ?`)
      .get(res.body.runId) as { status: string; saved_search_id: string };
    expect(executionRow.status).toBe("RUNNING");
    expect(executionRow.saved_search_id).toBe(searchId);
  });

  it("returns 409 if an active execution already exists for the saved search, and creates no new scanner run", async () => {
    const { cookie } = await signUpUser("runnow-409");
    const searchId = await createSavedSearch(cookie);

    const first = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);
    expect(first.status).toBe(201);

    const runCountBefore = (
      db.prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }
    ).n;

    const second = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);
    expect(second.status).toBe(409);

    const runCountAfter = (db.prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }).n;
    expect(runCountAfter).toBe(runCountBefore);

    const executionCount = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM monitoring_executions WHERE saved_search_id = ?`)
        .get(searchId) as { n: number }
    ).n;
    expect(executionCount).toBe(1);
  });

  it("returns 404 for a missing/non-owned saved search", async () => {
    const { cookie } = await signUpUser("runnow-404");
    const res = await request(app)
      .post(`/api/saved-searches/${randomUUID()}/monitoring/run-now`)
      .set("Cookie", cookie);
    expect(res.status).toBe(404);
  });

  // Source-structure note (Blocker 4): triggerMonitoringExecution
  // (apps/api/src/lib/monitoring.ts) wraps the active-execution re-check,
  // insertCreatedRunForUser (runs + run_companies insert), the
  // monitoring_executions insert, and the monitoring_last_checked_at update
  // in one db.transaction(). insertCreatedRunForUser itself opens no
  // transaction of its own - it is the extracted, transaction-safe half of
  // createRunForUser (apps/api/src/lib/runs.ts), which still wraps it in its
  // own transaction for the POST /api/runs path. A failure at any point
  // inside triggerMonitoringExecution's transaction - including the
  // monitoring_executions insert - rolls back the scanner run and
  // run_companies rows created moments earlier in the same transaction, so a
  // monitoring trigger can never leave an unlinked scanner run behind. The
  // 409 test above verifies the practical, observable half of this
  // guarantee (no new run when an active execution already exists).
});

describe("monitoring execution history and matches are user-owned", () => {
  it("execution history lists newest first and only own executions", async () => {
    const { cookie } = await signUpUser("history");
    const searchId = await createSavedSearch(cookie);

    const first = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);

    setRunStatus(first.body.runId, RunStatus.FAILED_ROLE_SPEC);
    monitoringTick();

    const second = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);

    const res = await request(app)
      .get(`/api/saved-searches/${searchId}/monitoring/executions`)
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
    expect(res.body[0].run_id).toBe(second.body.runId);
    expect(res.body[1].run_id).toBe(first.body.runId);
    expect(res.body[1].status).toBe("FAILED");
  });

  it("matches list is scoped to the requesting user's saved search", async () => {
    const { cookie: ownerCookie } = await signUpUser("matches-owner");
    const { cookie: strangerCookie } = await signUpUser("matches-stranger");
    const searchId = await createSavedSearch(ownerCookie);

    const ownerRes = await request(app)
      .get(`/api/saved-searches/${searchId}/monitoring/matches`)
      .set("Cookie", ownerCookie);
    expect(ownerRes.status).toBe(200);

    const strangerRes = await request(app)
      .get(`/api/saved-searches/${searchId}/monitoring/matches`)
      .set("Cookie", strangerCookie);
    expect(strangerRes.status).toBe(404);
  });
});

describe("monitoring loop — reconciliation (Phase 1)", () => {
  it("reconciles a COMPLETED scanner run to a COMPLETED monitoring execution", async () => {
    const { cookie } = await signUpUser("reconcile-completed");
    const searchId = await createSavedSearch(cookie);

    const runNow = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);
    setRunStatus(runNow.body.runId, RunStatus.COMPLETED);

    monitoringTick();

    const executionRow = db
      .prepare(`SELECT * FROM monitoring_executions WHERE run_id = ?`)
      .get(runNow.body.runId) as { status: string; finished_at: number | null };
    expect(executionRow.status).toBe("COMPLETED");
    expect(executionRow.finished_at).not.toBeNull();
  });

  it("reconciles a FAILED_ROLE_SPEC scanner run to a FAILED monitoring execution without detecting matches", async () => {
    const { cookie } = await signUpUser("reconcile-failed");
    const searchId = await createSavedSearch(cookie);

    const runNow = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);
    setRunStatus(runNow.body.runId, RunStatus.FAILED_ROLE_SPEC);

    monitoringTick();

    const executionRow = db
      .prepare(`SELECT * FROM monitoring_executions WHERE run_id = ?`)
      .get(runNow.body.runId) as { status: string; new_match_count: number };
    expect(executionRow.status).toBe("FAILED");
    expect(executionRow.new_match_count).toBe(0);
  });

  it("leaves an execution RUNNING while the linked run is still CREATED/READY/RUNNING", async () => {
    const { cookie } = await signUpUser("reconcile-running");
    const searchId = await createSavedSearch(cookie);

    const runNow = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);
    setRunStatus(runNow.body.runId, RunStatus.RUNNING);

    monitoringTick();

    const executionRow = db
      .prepare(`SELECT status FROM monitoring_executions WHERE run_id = ?`)
      .get(runNow.body.runId) as { status: string };
    expect(executionRow.status).toBe("RUNNING");
  });
});

describe("monitoring loop — due-search selection (Phase 2)", () => {
  it("skips disabled searches", async () => {
    const { cookie } = await signUpUser("loop-disabled");
    await createSavedSearch(cookie);

    monitoringTick();

    const executionCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM monitoring_executions`).get() as { n: number }
    ).n;
    expect(executionCount).toBe(0);
  });

  it("skips enabled searches that are not yet due", async () => {
    const { cookie } = await signUpUser("loop-not-due");
    const searchId = await createSavedSearch(cookie);
    await request(app)
      .put(`/api/saved-searches/${searchId}/monitoring`)
      .set("Cookie", cookie)
      .send({ enabled: true });

    // Simulate a recent check so the fixed interval has not elapsed.
    db.prepare(`UPDATE saved_searches SET monitoring_last_checked_at = ? WHERE id = ?`).run(
      Date.now(),
      searchId
    );

    monitoringTick();

    const executionCount = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM monitoring_executions WHERE saved_search_id = ?`)
        .get(searchId) as { n: number }
    ).n;
    expect(executionCount).toBe(0);
  });

  it("creates a normal scanner run for a due, enabled search with no active execution", async () => {
    const { cookie, userId } = await signUpUser("loop-due");
    const searchId = await createSavedSearch(cookie);
    await request(app)
      .put(`/api/saved-searches/${searchId}/monitoring`)
      .set("Cookie", cookie)
      .send({ enabled: true });

    monitoringTick();

    const executionRow = db
      .prepare(`SELECT * FROM monitoring_executions WHERE saved_search_id = ?`)
      .get(searchId) as { status: string; run_id: string };
    expect(executionRow.status).toBe("RUNNING");

    const runRow = db.prepare(`SELECT status, user_id, role_spec_json FROM runs WHERE id = ?`).get(
      executionRow.run_id
    ) as { status: string; user_id: string; role_spec_json: string | null };
    expect(runRow.status).toBe("CREATED");
    expect(runRow.user_id).toBe(userId);
    expect(runRow.role_spec_json).toBeNull();

    const inProgressCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM run_companies WHERE run_id = ? AND status = 'IN_PROGRESS'`
        )
        .get(executionRow.run_id) as { n: number }
    ).n;
    expect(inProgressCount).toBe(0);
  });

  it("does not create a duplicate execution or duplicate scanner run when one is already active", async () => {
    const { cookie } = await signUpUser("loop-no-dup");
    const searchId = await createSavedSearch(cookie);
    await request(app)
      .put(`/api/saved-searches/${searchId}/monitoring`)
      .set("Cookie", cookie)
      .send({ enabled: true });

    monitoringTick();
    monitoringTick();
    monitoringTick();

    const executionCount = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM monitoring_executions WHERE saved_search_id = ?`)
        .get(searchId) as { n: number }
    ).n;
    expect(executionCount).toBe(1);

    const runCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM monitoring_executions WHERE saved_search_id = ? AND status = 'RUNNING'`
        )
        .get(searchId) as { n: number }
    ).n;
    expect(runCount).toBe(1);
  });

  it("updates monitoring_last_checked_at when a due search is picked up", async () => {
    const { cookie } = await signUpUser("loop-last-checked");
    const searchId = await createSavedSearch(cookie);
    await request(app)
      .put(`/api/saved-searches/${searchId}/monitoring`)
      .set("Cookie", cookie)
      .send({ enabled: true });

    monitoringTick();

    const configRes = await request(app)
      .get(`/api/saved-searches/${searchId}/monitoring`)
      .set("Cookie", cookie);
    expect(configRes.body.last_checked_at).not.toBeNull();
  });
});

describe("new match detection", () => {
  it("first MATCHES_FOUND job inserts a monitoring_match and increments new_match_count", async () => {
    const { cookie } = await signUpUser("newmatch-1");
    const searchId = await createSavedSearch(cookie);
    const runNow = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);
    const runId = runNow.body.runId as string;

    const companyId = insertFinalCompany(runId, "Acme", 0, CompanyStatus.MATCHES_FOUND);
    insertJobRow(runId, companyId, "Backend Engineer", "Remote", "https://acme.example/jobs/1");
    setRunStatus(runId, RunStatus.COMPLETED);

    monitoringTick();

    const matchRows = db
      .prepare(`SELECT * FROM monitoring_matches WHERE saved_search_id = ?`)
      .all(searchId) as { seen_count: number; job_url: string; location: string | null }[];
    expect(matchRows.length).toBe(1);
    expect(matchRows[0].seen_count).toBe(1);
    expect(matchRows[0].job_url).toBe("https://acme.example/jobs/1");
    expect(matchRows[0].location).toBe("Remote");

    const executionRow = db
      .prepare(`SELECT new_match_count FROM monitoring_executions WHERE run_id = ?`)
      .get(runId) as { new_match_count: number };
    expect(executionRow.new_match_count).toBe(1);
  });

  it("second sighting of the same normalized URL updates last_seen/seen_count without counting as new", async () => {
    const { cookie } = await signUpUser("newmatch-2");
    const searchId = await createSavedSearch(cookie);

    const firstRun = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);
    const firstRunId = firstRun.body.runId as string;
    const firstCompanyId = insertFinalCompany(firstRunId, "Acme", 0, CompanyStatus.MATCHES_FOUND);
    insertJobRow(firstRunId, firstCompanyId, "Backend Engineer", "Remote", "https://acme.example/jobs/1");
    setRunStatus(firstRunId, RunStatus.COMPLETED);
    monitoringTick();

    const secondRun = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);
    const secondRunId = secondRun.body.runId as string;
    const secondCompanyId = insertFinalCompany(secondRunId, "Acme", 0, CompanyStatus.MATCHES_FOUND);
    insertJobRow(
      secondRunId,
      secondCompanyId,
      "Backend Engineer",
      "Remote",
      "https://acme.example/jobs/1"
    );
    setRunStatus(secondRunId, RunStatus.COMPLETED);
    monitoringTick();

    const matchRows = db
      .prepare(`SELECT * FROM monitoring_matches WHERE saved_search_id = ?`)
      .all(searchId) as { seen_count: number; last_seen_run_id: string }[];
    expect(matchRows.length).toBe(1);
    expect(matchRows[0].seen_count).toBe(2);
    expect(matchRows[0].last_seen_run_id).toBe(secondRunId);

    const secondExecutionRow = db
      .prepare(`SELECT new_match_count FROM monitoring_executions WHERE run_id = ?`)
      .get(secondRunId) as { new_match_count: number };
    expect(secondExecutionRow.new_match_count).toBe(0);
  });

  it("duplicate jobs within one scanner run count once", async () => {
    const { cookie } = await signUpUser("newmatch-dup-in-run");
    const searchId = await createSavedSearch(cookie);
    const runNow = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);
    const runId = runNow.body.runId as string;

    const companyId = insertFinalCompany(runId, "Acme", 0, CompanyStatus.MATCHES_FOUND);
    insertJobRow(runId, companyId, "Backend Engineer", "Remote", "https://acme.example/jobs/1");
    insertJobRow(runId, companyId, "Backend Engineer", "Remote", "https://acme.example/jobs/1");
    setRunStatus(runId, RunStatus.COMPLETED);

    monitoringTick();

    const matchRows = db
      .prepare(`SELECT * FROM monitoring_matches WHERE saved_search_id = ?`)
      .all(searchId);
    expect(matchRows.length).toBe(1);

    const executionRow = db
      .prepare(`SELECT new_match_count FROM monitoring_executions WHERE run_id = ?`)
      .get(runId) as { new_match_count: number };
    expect(executionRow.new_match_count).toBe(1);
  });

  it("empty URL uses the fallback key (company + title + location)", async () => {
    const { cookie } = await signUpUser("newmatch-fallback-empty");
    const searchId = await createSavedSearch(cookie);
    const runNow = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);
    const runId = runNow.body.runId as string;

    const companyId = insertFinalCompany(runId, "Acme", 0, CompanyStatus.MATCHES_FOUND);
    insertJobRow(runId, companyId, "Backend Engineer", "Remote", "");
    setRunStatus(runId, RunStatus.COMPLETED);

    monitoringTick();

    const matchRows = db
      .prepare(`SELECT * FROM monitoring_matches WHERE saved_search_id = ?`)
      .all(searchId) as { job_key: string; job_url: string }[];
    expect(matchRows.length).toBe(1);
    expect(matchRows[0].job_key).toBe("fallback:acme|backend engineer|remote");
    expect(matchRows[0].job_url).toBe("");
  });

  it("invalid/unparseable URL uses the fallback key, not the lowercased raw string", async () => {
    const { cookie } = await signUpUser("newmatch-fallback-invalid");
    const searchId = await createSavedSearch(cookie);
    const runNow = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);
    const runId = runNow.body.runId as string;

    const companyId = insertFinalCompany(runId, "Acme", 0, CompanyStatus.MATCHES_FOUND);
    // Not a parseable absolute URL (no scheme) - must fall back, not become "not a real url".
    insertJobRow(runId, companyId, "Backend Engineer", "Remote", "Not A Real URL");
    setRunStatus(runId, RunStatus.COMPLETED);

    monitoringTick();

    const matchRows = db
      .prepare(`SELECT * FROM monitoring_matches WHERE saved_search_id = ?`)
      .all(searchId) as { job_key: string; job_url: string }[];
    expect(matchRows.length).toBe(1);
    expect(matchRows[0].job_key).toBe("fallback:acme|backend engineer|remote");
    expect(matchRows[0].job_key).not.toContain("not a real url");
    expect(matchRows[0].job_url).toBe("Not A Real URL");
  });

  it("valid URL strips query string, hash, and trailing slash", async () => {
    const { cookie } = await signUpUser("newmatch-url-strip");
    const searchId = await createSavedSearch(cookie);
    const runNow = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);
    const runId = runNow.body.runId as string;

    const companyId = insertFinalCompany(runId, "Acme", 0, CompanyStatus.MATCHES_FOUND);
    insertJobRow(
      runId,
      companyId,
      "Backend Engineer",
      "Remote",
      "https://acme.example/jobs/1/?utm_source=board#apply"
    );
    setRunStatus(runId, RunStatus.COMPLETED);

    monitoringTick();

    const matchRows = db
      .prepare(`SELECT * FROM monitoring_matches WHERE saved_search_id = ?`)
      .all(searchId) as { job_key: string }[];
    expect(matchRows.length).toBe(1);
    expect(matchRows[0].job_key).toBe("url:https://acme.example/jobs/1");
  });

  it("valid URL normalizes protocol and host case", async () => {
    const { cookie } = await signUpUser("newmatch-url-case");
    const searchId = await createSavedSearch(cookie);
    const runNow = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);
    const runId = runNow.body.runId as string;

    const companyId = insertFinalCompany(runId, "Acme", 0, CompanyStatus.MATCHES_FOUND);
    insertJobRow(runId, companyId, "Backend Engineer", "Remote", "HTTPS://ACME.example/jobs/1");
    setRunStatus(runId, RunStatus.COMPLETED);

    monitoringTick();

    const matchRows = db
      .prepare(`SELECT * FROM monitoring_matches WHERE saved_search_id = ?`)
      .all(searchId) as { job_key: string }[];
    expect(matchRows.length).toBe(1);
    expect(matchRows[0].job_key).toBe("url:https://acme.example/jobs/1");
  });

  it("duplicate invalid URLs with different company/title/location do not collapse unrelated jobs", async () => {
    const { cookie } = await signUpUser("newmatch-fallback-distinct");
    const searchId = await createSavedSearch(cookie, {
      companies: [{ company_name: "Acme" }, { company_name: "Globex" }],
    });
    const runNow = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);
    const runId = runNow.body.runId as string;

    const acmeId = insertFinalCompany(runId, "Acme", 0, CompanyStatus.MATCHES_FOUND);
    const globexId = insertFinalCompany(runId, "Globex", 1, CompanyStatus.MATCHES_FOUND);
    insertJobRow(runId, acmeId, "Backend Engineer", "Remote", "not-a-valid-url");
    insertJobRow(runId, globexId, "Frontend Engineer", "NYC", "not-a-valid-url");
    setRunStatus(runId, RunStatus.COMPLETED);

    monitoringTick();

    const matchRows = db
      .prepare(`SELECT * FROM monitoring_matches WHERE saved_search_id = ?`)
      .all(searchId) as { job_key: string; company_name: string }[];
    expect(matchRows.length).toBe(2);
    const keys = matchRows.map((r) => r.job_key).sort();
    expect(keys).toEqual([
      "fallback:acme|backend engineer|remote",
      "fallback:globex|frontend engineer|nyc",
    ]);
  });

  it("UNVERIFIED company does not create a monitoring_match", async () => {
    const { cookie } = await signUpUser("newmatch-unverified");
    const searchId = await createSavedSearch(cookie);
    const runNow = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);
    const runId = runNow.body.runId as string;

    const companyId = insertFinalCompany(runId, "Acme", 0, CompanyStatus.UNVERIFIED);
    insertJobRow(runId, companyId, "Backend Engineer", "Remote", "https://acme.example/jobs/1");
    setRunStatus(runId, RunStatus.COMPLETED);

    monitoringTick();

    const matchRows = db
      .prepare(`SELECT * FROM monitoring_matches WHERE saved_search_id = ?`)
      .all(searchId);
    expect(matchRows.length).toBe(0);

    const executionRow = db
      .prepare(`SELECT status, new_match_count FROM monitoring_executions WHERE run_id = ?`)
      .get(runId) as { status: string; new_match_count: number };
    expect(executionRow.status).toBe("COMPLETED");
    expect(executionRow.new_match_count).toBe(0);
  });

  it("NO_MATCH_SCAN_COMPLETED company does not create a monitoring_match", async () => {
    const { cookie } = await signUpUser("newmatch-nomatch");
    const searchId = await createSavedSearch(cookie);
    const runNow = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);
    const runId = runNow.body.runId as string;

    insertFinalCompany(runId, "Acme", 0, CompanyStatus.NO_MATCH_SCAN_COMPLETED);
    setRunStatus(runId, RunStatus.COMPLETED);

    monitoringTick();

    const matchRows = db
      .prepare(`SELECT * FROM monitoring_matches WHERE saved_search_id = ?`)
      .all(searchId);
    expect(matchRows.length).toBe(0);
  });
});

describe("reconciliation is atomic (Blocker 1)", () => {
  it("a RUNNING execution whose linked run is COMPLETED produces the correct new_match_count exactly once", async () => {
    const { cookie } = await signUpUser("atomic-once");
    const searchId = await createSavedSearch(cookie);
    const runNow = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);
    const runId = runNow.body.runId as string;

    const companyId = insertFinalCompany(runId, "Acme", 0, CompanyStatus.MATCHES_FOUND);
    insertJobRow(runId, companyId, "Backend Engineer", "Remote", "https://acme.example/jobs/1");
    setRunStatus(runId, RunStatus.COMPLETED);

    monitoringTick();

    const executionRow = db
      .prepare(`SELECT status, new_match_count, finished_at FROM monitoring_executions WHERE run_id = ?`)
      .get(runId) as { status: string; new_match_count: number; finished_at: number | null };
    expect(executionRow.status).toBe("COMPLETED");
    expect(executionRow.new_match_count).toBe(1);
    expect(executionRow.finished_at).not.toBeNull();

    const matchRows = db
      .prepare(`SELECT seen_count FROM monitoring_matches WHERE saved_search_id = ?`)
      .all(searchId) as { seen_count: number }[];
    expect(matchRows.length).toBe(1);
    expect(matchRows[0].seen_count).toBe(1);
  });

  it("re-running monitoringTick after an execution is COMPLETED does not inflate seen_count or new_match_count", async () => {
    const { cookie } = await signUpUser("atomic-no-replay");
    const searchId = await createSavedSearch(cookie);
    const runNow = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);
    const runId = runNow.body.runId as string;

    const companyId = insertFinalCompany(runId, "Acme", 0, CompanyStatus.MATCHES_FOUND);
    insertJobRow(runId, companyId, "Backend Engineer", "Remote", "https://acme.example/jobs/1");
    setRunStatus(runId, RunStatus.COMPLETED);

    monitoringTick();
    // The linked run and execution are already terminal; re-ticking must be a no-op
    // for this execution (it is no longer RUNNING) rather than re-applying matches.
    monitoringTick();
    monitoringTick();

    const executionRow = db
      .prepare(`SELECT status, new_match_count FROM monitoring_executions WHERE run_id = ?`)
      .get(runId) as { status: string; new_match_count: number };
    expect(executionRow.status).toBe("COMPLETED");
    expect(executionRow.new_match_count).toBe(1);

    const matchRows = db
      .prepare(`SELECT seen_count FROM monitoring_matches WHERE saved_search_id = ?`)
      .all(searchId) as { seen_count: number }[];
    expect(matchRows.length).toBe(1);
    expect(matchRows[0].seen_count).toBe(1);
  });

  it("if the execution is no longer RUNNING, reconciliation does not touch monitoring_matches", async () => {
    const { cookie } = await signUpUser("atomic-skip-non-running");
    const searchId = await createSavedSearch(cookie);
    const runNow = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);
    const runId = runNow.body.runId as string;
    const executionId = (
      db.prepare(`SELECT id FROM monitoring_executions WHERE run_id = ?`).get(runId) as {
        id: string;
      }
    ).id;

    const companyId = insertFinalCompany(runId, "Acme", 0, CompanyStatus.MATCHES_FOUND);
    insertJobRow(runId, companyId, "Backend Engineer", "Remote", "https://acme.example/jobs/1");
    setRunStatus(runId, RunStatus.COMPLETED);

    // Simulate the execution having already been finalized by a concurrent
    // reconciliation pass before this tick runs.
    db.prepare(`UPDATE monitoring_executions SET status = 'FAILED', finished_at = ? WHERE id = ?`).run(
      Date.now(),
      executionId
    );

    monitoringTick();

    const matchRows = db
      .prepare(`SELECT * FROM monitoring_matches WHERE saved_search_id = ?`)
      .all(searchId);
    expect(matchRows.length).toBe(0);

    const executionRow = db
      .prepare(`SELECT status, new_match_count FROM monitoring_executions WHERE id = ?`)
      .get(executionId) as { status: string; new_match_count: number };
    expect(executionRow.status).toBe("FAILED");
    expect(executionRow.new_match_count).toBe(0);
  });
});

describe("reconciliation isolates failures per execution (Blocker 2)", () => {
  it("if one active monitoring execution cannot be reconciled, other active executions still reconcile", async () => {
    const { cookie } = await signUpUser("isolation-other-still-runs");
    const brokenSearchId = await createSavedSearch(cookie, { name: "Broken search" });
    const healthySearchId = await createSavedSearch(cookie, { name: "Healthy search" });

    const brokenRunNow = await request(app)
      .post(`/api/saved-searches/${brokenSearchId}/monitoring/run-now`)
      .set("Cookie", cookie);
    const healthyRunNow = await request(app)
      .post(`/api/saved-searches/${healthySearchId}/monitoring/run-now`)
      .set("Cookie", cookie);

    const brokenRunId = brokenRunNow.body.runId as string;
    const healthyRunId = healthyRunNow.body.runId as string;

    setRunStatus(brokenRunId, RunStatus.COMPLETED);
    setRunStatus(healthyRunId, RunStatus.COMPLETED);

    // Force a genuine database-level failure for exactly the broken run's
    // reconciliation lookup, leaving every other query (including the
    // healthy run's identical query for a different run id) untouched.
    // Plain reassignment (not vi.spyOn/mock) restored unconditionally in
    // finally, so nothing can leak into other test files sharing this
    // in-memory database (fileParallelism: false).
    withPatchedRunStatusLookup(brokenRunId, () => {
      expect(() => monitoringTick()).not.toThrow();
    });

    const brokenExecutionRow = db
      .prepare(`SELECT status FROM monitoring_executions WHERE run_id = ?`)
      .get(brokenRunId) as { status: string };
    // The broken execution's reconciliation attempt failed and was caught,
    // so it is left RUNNING to be retried on a later tick rather than
    // silently marked complete.
    expect(brokenExecutionRow.status).toBe("RUNNING");

    const healthyExecutionRow = db
      .prepare(`SELECT status, new_match_count FROM monitoring_executions WHERE run_id = ?`)
      .get(healthyRunId) as { status: string; new_match_count: number };
    expect(healthyExecutionRow.status).toBe("COMPLETED");
  });

  it("due-search processing still runs after one reconciliation failure", async () => {
    const { cookie } = await signUpUser("isolation-phase2-still-runs");
    const brokenSearchId = await createSavedSearch(cookie, { name: "Broken search" });
    const dueSearchId = await createSavedSearch(cookie, { name: "Due search" });

    const brokenRunNow = await request(app)
      .post(`/api/saved-searches/${brokenSearchId}/monitoring/run-now`)
      .set("Cookie", cookie);
    const brokenRunId = brokenRunNow.body.runId as string;
    setRunStatus(brokenRunId, RunStatus.COMPLETED);

    await request(app)
      .put(`/api/saved-searches/${dueSearchId}/monitoring`)
      .set("Cookie", cookie)
      .send({ enabled: true });

    withPatchedRunStatusLookup(brokenRunId, () => {
      expect(() => monitoringTick()).not.toThrow();
    });

    const dueExecutionRow = db
      .prepare(`SELECT status FROM monitoring_executions WHERE saved_search_id = ?`)
      .get(dueSearchId) as { status: string } | undefined;
    expect(dueExecutionRow?.status).toBe("RUNNING");
  });

  it("if reconcileActiveMonitoringExecutions throws before processing any execution, monitoringTick still starts due searches", async () => {
    const { cookie } = await signUpUser("isolation-phase1-query-failure");
    const dueSearchId = await createSavedSearch(cookie, { name: "Due search" });

    await request(app)
      .put(`/api/saved-searches/${dueSearchId}/monitoring`)
      .set("Cookie", cookie)
      .send({ enabled: true });

    // Breaks the query reconcileActiveMonitoringExecutions runs to list
    // active executions, before its per-execution try/catch loop even
    // starts - the per-execution isolation tested above cannot help here,
    // so this exercises monitoringTick's own guard around calling
    // reconcileActiveMonitoringExecutions.
    withBrokenActiveExecutionsLookup(() => {
      expect(() => monitoringTick()).not.toThrow();
    });

    const dueExecutionRow = db
      .prepare(`SELECT status FROM monitoring_executions WHERE saved_search_id = ?`)
      .get(dueSearchId) as { status: string } | undefined;
    expect(dueExecutionRow?.status).toBe("RUNNING");
  });

  // Source-structure note: reconcileActiveMonitoringExecutions loops over
  // active executions and calls reconcileOneMonitoringExecution(execution)
  // inside a per-execution try/catch (see apps/api/src/lib/monitoring.ts).
  // Any thrown error - a genuinely malformed row or, as simulated above, a
  // database error - is caught and logged there, so it cannot propagate out
  // of the loop and prevent remaining executions or Phase 2 (due-search
  // processing) from running. The isolation guarantee is structural: the
  // try/catch wraps each execution independently inside the for-loop, not
  // a single try/catch around the whole loop body.
});

describe("deletion and disabling behavior", () => {
  it("deleting a saved search deletes its monitoring executions and matches", async () => {
    const { cookie } = await signUpUser("delete-cascade");
    const searchId = await createSavedSearch(cookie);
    const runNow = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);
    const runId = runNow.body.runId as string;

    const companyId = insertFinalCompany(runId, "Acme", 0, CompanyStatus.MATCHES_FOUND);
    insertJobRow(runId, companyId, "Backend Engineer", "Remote", "https://acme.example/jobs/1");
    setRunStatus(runId, RunStatus.COMPLETED);
    monitoringTick();

    await request(app).delete(`/api/saved-searches/${searchId}`).set("Cookie", cookie);

    const executionRows = db
      .prepare(`SELECT * FROM monitoring_executions WHERE saved_search_id = ?`)
      .all(searchId);
    const matchRows = db
      .prepare(`SELECT * FROM monitoring_matches WHERE saved_search_id = ?`)
      .all(searchId);
    expect(executionRows.length).toBe(0);
    expect(matchRows.length).toBe(0);
  });

  it("deleting a saved search does not delete the linked scanner run", async () => {
    const { cookie } = await signUpUser("delete-preserves-run");
    const searchId = await createSavedSearch(cookie);
    const runNow = await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);
    const runId = runNow.body.runId as string;

    await request(app).delete(`/api/saved-searches/${searchId}`).set("Cookie", cookie);

    const runRow = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId);
    expect(runRow).toBeDefined();

    db.prepare("DELETE FROM run_companies WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
  });

  it("disabling monitoring does not delete execution history", async () => {
    const { cookie } = await signUpUser("disable-preserves-history");
    const searchId = await createSavedSearch(cookie);
    await request(app)
      .post(`/api/saved-searches/${searchId}/monitoring/run-now`)
      .set("Cookie", cookie);

    await request(app)
      .put(`/api/saved-searches/${searchId}/monitoring`)
      .set("Cookie", cookie)
      .send({ enabled: false });

    const executionsRes = await request(app)
      .get(`/api/saved-searches/${searchId}/monitoring/executions`)
      .set("Cookie", cookie);
    expect(executionsRes.body.length).toBe(1);
  });
});
