/**
 * Milestone 3 (Error Handling and Observability) tests for the Express JSON
 * error boundary.
 *
 *   - A malformed JSON request body returns 400 { error: "invalid JSON request body" }
 *     as JSON (never Express's default HTML error page).
 *   - jsonErrorHandler is unit-tested directly for the unexpected-error (500)
 *     and body-parse (400) branches, since there is no clean way to force an
 *     unexpected 500 through a real route without adding a test-only route.
 *
 * Isolation: vitest.config.ts sets DB_PATH=:memory: and NODE_ENV=test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Request, Response } from "express";
import { app } from "../../server.js";
import { jsonErrorHandler } from "../../lib/expressErrors.js";

describe("Express JSON error boundary — malformed request body", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns 400 JSON for an invalid JSON body", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send('{"email": "a@b.co", '); // truncated, invalid JSON

    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: "invalid JSON request body" });
  });
});

describe("jsonErrorHandler — direct branch coverage", () => {
  function makeRes(): Response & { statusCode: number; body: unknown } {
    const res = {
      headersSent: false,
      statusCode: 0,
      body: undefined,
      status: vi.fn(function (this: { statusCode: number }, code: number) {
        this.statusCode = code;
        return this;
      }),
      json: vi.fn(function (this: { body: unknown }, body: unknown) {
        this.body = body;
        return this;
      }),
    };
    return res as unknown as Response & { statusCode: number; body: unknown };
  }

  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("returns 500 JSON for an unexpected error and does not call next", () => {
    const res = makeRes();
    const next = vi.fn();
    const req = { method: "GET", path: "/api/whatever" } as unknown as Request;

    jsonErrorHandler(new Error("boom"), req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.body).toEqual({ error: "unexpected server error" });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 400 JSON for an entity.parse.failed error", () => {
    const res = makeRes();
    const next = vi.fn();
    const req = { method: "POST", path: "/api/whatever" } as unknown as Request;
    const err = Object.assign(new SyntaxError("Unexpected token"), {
      type: "entity.parse.failed",
    });

    jsonErrorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toEqual({ error: "invalid JSON request body" });
    expect(next).not.toHaveBeenCalled();
  });

  it("delegates to next when the response has already started", () => {
    const res = makeRes();
    (res as { headersSent: boolean }).headersSent = true;
    const next = vi.fn();
    const req = { method: "GET", path: "/api/whatever" } as unknown as Request;
    const err = new Error("late failure");

    jsonErrorHandler(err, req, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
  });
});
