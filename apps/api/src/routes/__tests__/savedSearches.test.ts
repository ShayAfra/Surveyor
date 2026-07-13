/**
 * Milestone 5 (Saved Companies and Saved Searches) endpoint tests for saved searches
 * and starting a scanner run from a saved search:
 *   - GET    /api/saved-searches
 *   - GET    /api/saved-searches/:id
 *   - POST   /api/saved-searches
 *   - PUT    /api/saved-searches/:id
 *   - DELETE /api/saved-searches/:id
 *   - POST   /api/saved-searches/:id/runs
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
    db.prepare("DELETE FROM run_companies WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
  }
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
  const email = `savedsearches-${label}-${randomUUID()}@example.com`;
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
    notes: "quarterly check",
    companies: [{ company_name: "Acme" }, { company_name: "Globex" }],
    ...overrides,
  };
}

describe("saved searches — auth requirement", () => {
  it("GET /api/saved-searches returns 401 without auth", async () => {
    const res = await request(app).get("/api/saved-searches");
    expect(res.status).toBe(401);
  });

  it("POST /api/saved-searches returns 401 without auth", async () => {
    const res = await request(app).post("/api/saved-searches").send(validSavedSearchBody());
    expect(res.status).toBe(401);
  });

  it("PUT /api/saved-searches/:id returns 401 without auth", async () => {
    const res = await request(app)
      .put(`/api/saved-searches/${randomUUID()}`)
      .send(validSavedSearchBody());
    expect(res.status).toBe(401);
  });

  it("DELETE /api/saved-searches/:id returns 401 without auth", async () => {
    const res = await request(app).delete(`/api/saved-searches/${randomUUID()}`);
    expect(res.status).toBe(401);
  });

  it("POST /api/saved-searches/:id/runs returns 401 without auth", async () => {
    const res = await request(app).post(`/api/saved-searches/${randomUUID()}/runs`);
    expect(res.status).toBe(401);
  });
});

describe("saved searches — CRUD for own data", () => {
  it("user can create own saved search with ordered companies", async () => {
    const { cookie } = await signUpUser("create");

    const res = await request(app)
      .post("/api/saved-searches")
      .set("Cookie", cookie)
      .send(validSavedSearchBody());

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Backend roles");
    expect(res.body.role_raw).toBe("backend engineer");
    expect(res.body.include_adjacent).toBe(true);
    expect(res.body.companies.map((c: { company_name: string }) => c.company_name)).toEqual([
      "Acme",
      "Globex",
    ]);
    expect(res.body.companies[0].input_index).toBe(0);
    expect(res.body.companies[1].input_index).toBe(1);
    expect(res.body.user_id).toBeUndefined();
  });

  it("user can list own saved searches", async () => {
    const { cookie } = await signUpUser("list");
    await request(app).post("/api/saved-searches").set("Cookie", cookie).send(validSavedSearchBody());

    const res = await request(app).get("/api/saved-searches").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
  });

  it("user can get own saved search", async () => {
    const { cookie } = await signUpUser("get");
    const created = await request(app)
      .post("/api/saved-searches")
      .set("Cookie", cookie)
      .send(validSavedSearchBody());

    const res = await request(app)
      .get(`/api/saved-searches/${created.body.id}`)
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
  });

  it("user can update own saved search, replacing its companies", async () => {
    const { cookie } = await signUpUser("update");
    const created = await request(app)
      .post("/api/saved-searches")
      .set("Cookie", cookie)
      .send(validSavedSearchBody());

    const res = await request(app)
      .put(`/api/saved-searches/${created.body.id}`)
      .set("Cookie", cookie)
      .send(
        validSavedSearchBody({
          name: "Backend roles v2",
          companies: [{ company_name: "Initech" }],
        })
      );

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Backend roles v2");
    expect(res.body.companies.length).toBe(1);
    expect(res.body.companies[0].company_name).toBe("Initech");
  });

  it("user can delete own saved search", async () => {
    const { cookie } = await signUpUser("delete");
    const created = await request(app)
      .post("/api/saved-searches")
      .set("Cookie", cookie)
      .send(validSavedSearchBody());

    const res = await request(app)
      .delete(`/api/saved-searches/${created.body.id}`)
      .set("Cookie", cookie);
    expect(res.status).toBe(200);

    const getRes = await request(app)
      .get(`/api/saved-searches/${created.body.id}`)
      .set("Cookie", cookie);
    expect(getRes.status).toBe(404);

    const companyRows = db
      .prepare("SELECT * FROM saved_search_companies WHERE saved_search_id = ?")
      .all(created.body.id);
    expect(companyRows.length).toBe(0);
  });

  it("user cannot access or run another user's saved search", async () => {
    const { cookie: ownerCookie } = await signUpUser("owner");
    const { cookie: strangerCookie } = await signUpUser("stranger");

    const created = await request(app)
      .post("/api/saved-searches")
      .set("Cookie", ownerCookie)
      .send(validSavedSearchBody());

    const getRes = await request(app)
      .get(`/api/saved-searches/${created.body.id}`)
      .set("Cookie", strangerCookie);
    expect(getRes.status).toBe(404);

    const putRes = await request(app)
      .put(`/api/saved-searches/${created.body.id}`)
      .set("Cookie", strangerCookie)
      .send(validSavedSearchBody({ name: "Hijacked" }));
    expect(putRes.status).toBe(404);

    const deleteRes = await request(app)
      .delete(`/api/saved-searches/${created.body.id}`)
      .set("Cookie", strangerCookie);
    expect(deleteRes.status).toBe(404);

    const runRes = await request(app)
      .post(`/api/saved-searches/${created.body.id}/runs`)
      .set("Cookie", strangerCookie);
    expect(runRes.status).toBe(404);
  });
});

describe("saved searches — validation", () => {
  it("empty name is rejected", async () => {
    const { cookie } = await signUpUser("v1");
    const res = await request(app)
      .post("/api/saved-searches")
      .set("Cookie", cookie)
      .send(validSavedSearchBody({ name: "   " }));
    expect(res.status).toBe(400);
  });

  it("empty role_raw is rejected", async () => {
    const { cookie } = await signUpUser("v2");
    const res = await request(app)
      .post("/api/saved-searches")
      .set("Cookie", cookie)
      .send(validSavedSearchBody({ role_raw: "   " }));
    expect(res.status).toBe(400);
  });

  it("non-boolean include_adjacent is rejected", async () => {
    const { cookie } = await signUpUser("v3");
    const res = await request(app)
      .post("/api/saved-searches")
      .set("Cookie", cookie)
      .send(validSavedSearchBody({ include_adjacent: "yes" }));
    expect(res.status).toBe(400);
  });

  it("zero companies is rejected", async () => {
    const { cookie } = await signUpUser("v4");
    const res = await request(app)
      .post("/api/saved-searches")
      .set("Cookie", cookie)
      .send(validSavedSearchBody({ companies: [] }));
    expect(res.status).toBe(400);
  });

  it("empty company_name is rejected", async () => {
    const { cookie } = await signUpUser("v5");
    const res = await request(app)
      .post("/api/saved-searches")
      .set("Cookie", cookie)
      .send(validSavedSearchBody({ companies: [{ company_name: "  " }] }));
    expect(res.status).toBe(400);
  });

  it("more than 10 companies is rejected", async () => {
    const { cookie } = await signUpUser("v6");
    const res = await request(app)
      .post("/api/saved-searches")
      .set("Cookie", cookie)
      .send(
        validSavedSearchBody({
          companies: Array.from({ length: 11 }, (_, i) => ({ company_name: `Company ${i}` })),
        })
      );
    expect(res.status).toBe(400);
  });

  it("exactly 10 companies is accepted", async () => {
    const { cookie } = await signUpUser("v7");
    const res = await request(app)
      .post("/api/saved-searches")
      .set("Cookie", cookie)
      .send(
        validSavedSearchBody({
          companies: Array.from({ length: 10 }, (_, i) => ({ company_name: `Company ${i}` })),
        })
      );
    expect(res.status).toBe(201);
    expect(res.body.companies.length).toBe(10);
  });

  it("company order is preserved", async () => {
    const { cookie } = await signUpUser("v8");
    const res = await request(app)
      .post("/api/saved-searches")
      .set("Cookie", cookie)
      .send(
        validSavedSearchBody({
          companies: [
            { company_name: "Zeta" },
            { company_name: "Alpha" },
            { company_name: "Mu" },
          ],
        })
      );
    expect(res.status).toBe(201);
    expect(res.body.companies.map((c: { company_name: string }) => c.company_name)).toEqual([
      "Zeta",
      "Alpha",
      "Mu",
    ]);
  });

  it("saved_company_id must belong to the current user if provided", async () => {
    const { cookie: ownerCookie } = await signUpUser("scid-owner");
    const { cookie: strangerCookie } = await signUpUser("scid-stranger");

    const savedCompany = await request(app)
      .post("/api/saved-companies")
      .set("Cookie", ownerCookie)
      .send({ company_name: "Acme" });

    const res = await request(app)
      .post("/api/saved-searches")
      .set("Cookie", strangerCookie)
      .send(
        validSavedSearchBody({
          companies: [{ company_name: "Acme", saved_company_id: savedCompany.body.id }],
        })
      );
    expect(res.status).toBe(400);
  });

  it("saved search can use raw company_name with saved_company_id null", async () => {
    const { cookie } = await signUpUser("rawname");
    const res = await request(app)
      .post("/api/saved-searches")
      .set("Cookie", cookie)
      .send(validSavedSearchBody({ companies: [{ company_name: "Acme" }] }));
    expect(res.status).toBe(201);
    expect(res.body.companies[0].saved_company_id).toBeNull();
  });
});

describe("POST /api/saved-searches/:id/runs — starts a normal scanner run only", () => {
  it("returns { runId } for an owned saved search", async () => {
    const { cookie } = await signUpUser("run1");
    const created = await request(app)
      .post("/api/saved-searches")
      .set("Cookie", cookie)
      .send(validSavedSearchBody());

    const res = await request(app)
      .post(`/api/saved-searches/${created.body.id}/runs`)
      .set("Cookie", cookie);

    expect(res.status).toBe(201);
    expect(typeof res.body.runId).toBe("string");
    runCleanup.push(res.body.runId as string);
  });

  it("created run is owned by the current user, CREATED, with role/include_adjacent matching the saved search", async () => {
    const { cookie, userId } = await signUpUser("run2");
    const created = await request(app)
      .post("/api/saved-searches")
      .set("Cookie", cookie)
      .send(validSavedSearchBody({ role_raw: "staff engineer", include_adjacent: true }));

    const res = await request(app)
      .post(`/api/saved-searches/${created.body.id}/runs`)
      .set("Cookie", cookie);
    runCleanup.push(res.body.runId as string);

    const runRow = db
      .prepare("SELECT * FROM runs WHERE id = ?")
      .get(res.body.runId) as {
      user_id: string;
      status: string;
      role_raw: string;
      include_adjacent: number;
      role_spec_json: string | null;
    };

    expect(runRow.user_id).toBe(userId);
    expect(runRow.status).toBe("CREATED");
    expect(runRow.role_raw).toBe("staff engineer");
    expect(runRow.include_adjacent).toBe(1);
    expect(runRow.role_spec_json).toBeNull();
  });

  it("run_companies are PENDING, preserve saved search order, and no company is IN_PROGRESS", async () => {
    const { cookie } = await signUpUser("run3");
    const created = await request(app)
      .post("/api/saved-searches")
      .set("Cookie", cookie)
      .send(
        validSavedSearchBody({
          companies: [
            { company_name: "Zeta" },
            { company_name: "Alpha" },
            { company_name: "Mu" },
          ],
        })
      );

    const res = await request(app)
      .post(`/api/saved-searches/${created.body.id}/runs`)
      .set("Cookie", cookie);
    runCleanup.push(res.body.runId as string);

    const companyRows = db
      .prepare("SELECT company_name, input_index, status FROM run_companies WHERE run_id = ? ORDER BY input_index ASC")
      .all(res.body.runId) as { company_name: string; input_index: number; status: string }[];

    expect(companyRows.map((r) => r.company_name)).toEqual(["Zeta", "Alpha", "Mu"]);
    expect(companyRows.every((r) => r.status === "PENDING")).toBe(true);
    expect(companyRows.some((r) => r.status === "IN_PROGRESS")).toBe(false);
  });

  it("starting a run does not process scanner work in the API (run stays CREATED immediately after)", async () => {
    const { cookie } = await signUpUser("run4");
    const created = await request(app)
      .post("/api/saved-searches")
      .set("Cookie", cookie)
      .send(validSavedSearchBody());

    const res = await request(app)
      .post(`/api/saved-searches/${created.body.id}/runs`)
      .set("Cookie", cookie);
    runCleanup.push(res.body.runId as string);

    const runRow = db.prepare("SELECT status, role_spec_json FROM runs WHERE id = ?").get(
      res.body.runId
    ) as { status: string; role_spec_json: string | null };

    expect(runRow.status).toBe("CREATED");
    expect(runRow.role_spec_json).toBeNull();
  });

  it("later edits to the saved search do not change a previously created run (snapshot semantics)", async () => {
    const { cookie } = await signUpUser("run5");
    const created = await request(app)
      .post("/api/saved-searches")
      .set("Cookie", cookie)
      .send(validSavedSearchBody({ role_raw: "backend engineer" }));

    const runRes = await request(app)
      .post(`/api/saved-searches/${created.body.id}/runs`)
      .set("Cookie", cookie);
    runCleanup.push(runRes.body.runId as string);

    await request(app)
      .put(`/api/saved-searches/${created.body.id}`)
      .set("Cookie", cookie)
      .send(validSavedSearchBody({ role_raw: "staff engineer" }));

    const runRow = db.prepare("SELECT role_raw FROM runs WHERE id = ?").get(
      runRes.body.runId
    ) as { role_raw: string };
    expect(runRow.role_raw).toBe("backend engineer");
  });
});
