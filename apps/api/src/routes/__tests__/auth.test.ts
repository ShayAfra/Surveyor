/**
 * Milestone 1 (Accounts and Owned Scanner Data) auth endpoint tests.
 *
 * Isolation: vitest.config.ts sets DB_PATH=:memory: so each test worker gets a
 * fresh in-memory SQLite DB. NODE_ENV=test prevents server.ts from starting
 * the worker loop or binding a port.
 */

import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../server.js";
import { db } from "../../db/db.js";

afterEach(() => {
  db.prepare("DELETE FROM sessions").run();
  db.prepare("DELETE FROM users").run();
});

function extractSessionCookie(res: request.Response): string {
  const setCookie = res.headers["set-cookie"];
  expect(setCookie).toBeDefined();
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie as unknown as string];
  const sessionCookie = cookies.find((c) => c.startsWith("surveyor_session="));
  expect(sessionCookie).toBeDefined();
  return (sessionCookie as string).split(";")[0];
}

describe("POST /api/auth/signup", () => {
  it("creates a user and returns metadata without password fields", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "alice@example.com", password: "correct-horse" });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe("alice@example.com");
    expect(res.body.id).toBeDefined();
    expect(res.body.password_hash).toBeUndefined();
    expect(res.body.password_salt).toBeUndefined();
  });

  it("stores a hashed password, not plaintext", async () => {
    await request(app)
      .post("/api/auth/signup")
      .send({ email: "bob@example.com", password: "super-secret-pw" });

    const row = db
      .prepare("SELECT password_hash, password_salt FROM users WHERE email = ?")
      .get("bob@example.com") as { password_hash: string; password_salt: string };

    expect(row.password_hash).not.toBe("super-secret-pw");
    expect(row.password_salt.length).toBeGreaterThan(0);
  });

  it("rejects duplicate email", async () => {
    await request(app)
      .post("/api/auth/signup")
      .send({ email: "dup@example.com", password: "password123" });

    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "dup@example.com", password: "another-password" });

    expect(res.status).toBe(409);
  });

  it("rejects duplicate email regardless of case", async () => {
    await request(app)
      .post("/api/auth/signup")
      .send({ email: "Case@Example.com", password: "password123" });

    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "case@example.com", password: "another-password" });

    expect(res.status).toBe(409);
  });

  it("rejects an implausible email", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "not-an-email", password: "password123" });

    expect(res.status).toBe(400);
  });

  it("rejects a too-short password", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "shortpw@example.com", password: "short" });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/login", () => {
  it("succeeds with correct credentials and sets a session cookie", async () => {
    await request(app)
      .post("/api/auth/signup")
      .send({ email: "login-ok@example.com", password: "password123" });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "login-ok@example.com", password: "password123" });

    expect(res.status).toBe(200);
    expect(res.body.email).toBe("login-ok@example.com");
    extractSessionCookie(res);
  });

  it("fails with wrong password", async () => {
    await request(app)
      .post("/api/auth/signup")
      .send({ email: "login-bad@example.com", password: "password123" });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "login-bad@example.com", password: "wrong-password" });

    expect(res.status).toBe(401);
  });

  it("fails for an unknown email", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@example.com", password: "password123" });

    expect(res.status).toBe(401);
  });
});

describe("GET /api/auth/me", () => {
  it("returns the user when a valid session cookie is present", async () => {
    const signupRes = await request(app)
      .post("/api/auth/signup")
      .send({ email: "me@example.com", password: "password123" });
    const cookie = extractSessionCookie(signupRes);

    const res = await request(app).get("/api/auth/me").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.email).toBe("me@example.com");
  });

  it("returns 401 without a session", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("returns 401 with a garbage/unknown session cookie", async () => {
    const res = await request(app)
      .get("/api/auth/me")
      .set("Cookie", "surveyor_session=not-a-real-session");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/auth/logout", () => {
  it("invalidates the session so subsequent authenticated requests fail", async () => {
    const signupRes = await request(app)
      .post("/api/auth/signup")
      .send({ email: "logout@example.com", password: "password123" });
    const cookie = extractSessionCookie(signupRes);

    const meBeforeLogout = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(meBeforeLogout.status).toBe(200);

    const logoutRes = await request(app).post("/api/auth/logout").set("Cookie", cookie);
    expect(logoutRes.status).toBe(200);

    const meAfterLogout = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(meAfterLogout.status).toBe(401);
  });

  it("succeeds even when no session is present", async () => {
    const res = await request(app).post("/api/auth/logout");
    expect(res.status).toBe(200);
  });
});

describe("session expiration", () => {
  it("rejects a session whose expires_at is in the past", async () => {
    const signupRes = await request(app)
      .post("/api/auth/signup")
      .send({ email: "expired@example.com", password: "password123" });
    const cookie = extractSessionCookie(signupRes);
    const sessionId = cookie.split("=")[1];

    db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, sessionId);

    const res = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(res.status).toBe(401);
  });
});
