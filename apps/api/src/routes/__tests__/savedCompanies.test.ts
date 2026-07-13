/**
 * Milestone 5 (Saved Companies and Saved Searches) endpoint tests for saved companies:
 *   - GET    /api/saved-companies
 *   - GET    /api/saved-companies/:id
 *   - POST   /api/saved-companies
 *   - PUT    /api/saved-companies/:id
 *   - DELETE /api/saved-companies/:id
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

afterEach(() => {
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
  const email = `savedcompanies-${label}-${randomUUID()}@example.com`;
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "password123" });
  return { cookie: extractSessionCookie(res), userId: res.body.id as string };
}

describe("saved companies — auth requirement", () => {
  it("GET /api/saved-companies returns 401 without auth", async () => {
    const res = await request(app).get("/api/saved-companies");
    expect(res.status).toBe(401);
  });

  it("POST /api/saved-companies returns 401 without auth", async () => {
    const res = await request(app).post("/api/saved-companies").send({ company_name: "Acme" });
    expect(res.status).toBe(401);
  });

  it("PUT /api/saved-companies/:id returns 401 without auth", async () => {
    const res = await request(app)
      .put(`/api/saved-companies/${randomUUID()}`)
      .send({ company_name: "Acme" });
    expect(res.status).toBe(401);
  });

  it("DELETE /api/saved-companies/:id returns 401 without auth", async () => {
    const res = await request(app).delete(`/api/saved-companies/${randomUUID()}`);
    expect(res.status).toBe(401);
  });
});

describe("saved companies — CRUD for own data", () => {
  it("user can create own saved company", async () => {
    const { cookie } = await signUpUser("create");

    const res = await request(app)
      .post("/api/saved-companies")
      .set("Cookie", cookie)
      .send({ company_name: "Acme Corp", company_url: "https://acme.example", notes: "great" });

    expect(res.status).toBe(201);
    expect(res.body.company_name).toBe("Acme Corp");
    expect(res.body.company_url).toBe("https://acme.example");
    expect(res.body.notes).toBe("great");
    expect(res.body.user_id).toBeUndefined();
  });

  it("user can list own saved companies", async () => {
    const { cookie } = await signUpUser("list");
    await request(app)
      .post("/api/saved-companies")
      .set("Cookie", cookie)
      .send({ company_name: "Acme Corp" });

    const res = await request(app).get("/api/saved-companies").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
    expect(res.body[0].company_name).toBe("Acme Corp");
  });

  it("user can get own saved company", async () => {
    const { cookie } = await signUpUser("get");
    const created = await request(app)
      .post("/api/saved-companies")
      .set("Cookie", cookie)
      .send({ company_name: "Acme Corp" });

    const res = await request(app)
      .get(`/api/saved-companies/${created.body.id}`)
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
  });

  it("user can update own saved company", async () => {
    const { cookie } = await signUpUser("update");
    const created = await request(app)
      .post("/api/saved-companies")
      .set("Cookie", cookie)
      .send({ company_name: "Acme Corp" });

    const res = await request(app)
      .put(`/api/saved-companies/${created.body.id}`)
      .set("Cookie", cookie)
      .send({ company_name: "Acme Corp Renamed", company_url: null, notes: null });

    expect(res.status).toBe(200);
    expect(res.body.company_name).toBe("Acme Corp Renamed");
  });

  it("user can delete own saved company", async () => {
    const { cookie } = await signUpUser("delete");
    const created = await request(app)
      .post("/api/saved-companies")
      .set("Cookie", cookie)
      .send({ company_name: "Acme Corp" });

    const res = await request(app)
      .delete(`/api/saved-companies/${created.body.id}`)
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const getRes = await request(app)
      .get(`/api/saved-companies/${created.body.id}`)
      .set("Cookie", cookie);
    expect(getRes.status).toBe(404);
  });

  it("user cannot access another user's saved company", async () => {
    const { cookie: ownerCookie } = await signUpUser("owner");
    const { cookie: strangerCookie } = await signUpUser("stranger");

    const created = await request(app)
      .post("/api/saved-companies")
      .set("Cookie", ownerCookie)
      .send({ company_name: "Acme Corp" });

    const getRes = await request(app)
      .get(`/api/saved-companies/${created.body.id}`)
      .set("Cookie", strangerCookie);
    expect(getRes.status).toBe(404);

    const putRes = await request(app)
      .put(`/api/saved-companies/${created.body.id}`)
      .set("Cookie", strangerCookie)
      .send({ company_name: "Hijacked" });
    expect(putRes.status).toBe(404);

    const deleteRes = await request(app)
      .delete(`/api/saved-companies/${created.body.id}`)
      .set("Cookie", strangerCookie);
    expect(deleteRes.status).toBe(404);

    const stillThere = await request(app)
      .get(`/api/saved-companies/${created.body.id}`)
      .set("Cookie", ownerCookie);
    expect(stillThere.status).toBe(200);
    expect(stillThere.body.company_name).toBe("Acme Corp");
  });

  it("empty company_name is rejected", async () => {
    const { cookie } = await signUpUser("validate");
    const res = await request(app)
      .post("/api/saved-companies")
      .set("Cookie", cookie)
      .send({ company_name: "   " });
    expect(res.status).toBe(400);
  });
});

describe("deleting a saved company nulls references but preserves company_name snapshot", () => {
  it("nulls saved_company_id on referencing saved_search_companies rows without deleting them", async () => {
    const { cookie } = await signUpUser("cascade");

    const savedCompany = await request(app)
      .post("/api/saved-companies")
      .set("Cookie", cookie)
      .send({ company_name: "Acme Corp" });

    const savedSearch = await request(app)
      .post("/api/saved-searches")
      .set("Cookie", cookie)
      .send({
        name: "Backend roles",
        role_raw: "backend engineer",
        include_adjacent: false,
        companies: [{ company_name: "Acme Corp", saved_company_id: savedCompany.body.id }],
      });
    expect(savedSearch.status).toBe(201);
    expect(savedSearch.body.companies[0].saved_company_id).toBe(savedCompany.body.id);

    const deleteRes = await request(app)
      .delete(`/api/saved-companies/${savedCompany.body.id}`)
      .set("Cookie", cookie);
    expect(deleteRes.status).toBe(200);

    const refreshed = await request(app)
      .get(`/api/saved-searches/${savedSearch.body.id}`)
      .set("Cookie", cookie);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.companies.length).toBe(1);
    expect(refreshed.body.companies[0].saved_company_id).toBeNull();
    expect(refreshed.body.companies[0].company_name).toBe("Acme Corp");
  });
});
