/**
 * Unit tests for parseApiError (apps/web/src/apiErrors.ts).
 *
 * Protects the shared frontend error-parsing contract:
 *   - backend `{ error: string }` text is returned verbatim (validation text preserved)
 *   - missing/malformed/wrong-shape bodies fall back to a status-based default
 *   - a caller-provided fallback wins over the status default
 *   - malformed JSON (json() rejects) never throws
 *
 * parseApiError only reads `status` and `json`, so a minimal stub stands in for
 * a real fetch Response.
 */

import { describe, expect, it } from "vitest";
import { parseApiError } from "../apiErrors.js";

function fakeRes(status: number, json: () => Promise<unknown>): Pick<Response, "status" | "json"> {
  return { status, json } as Pick<Response, "status" | "json">;
}

describe("parseApiError", () => {
  it("returns the backend error string when present", async () => {
    const res = fakeRes(400, () => Promise.resolve({ error: "email must be a valid email address" }));
    expect(await parseApiError(res)).toBe("email must be a valid email address");
  });

  it("preserves backend validation text even when a fallback is provided", async () => {
    const res = fakeRes(409, () => Promise.resolve({ error: "email is already registered" }));
    expect(await parseApiError(res, "Something went wrong")).toBe("email is already registered");
  });

  it("uses the provided fallback when the body has no error field", async () => {
    const res = fakeRes(500, () => Promise.resolve({ ok: false }));
    expect(await parseApiError(res, "Could not load your recent scans.")).toBe(
      "Could not load your recent scans."
    );
  });

  it("falls back to a status-based default when no fallback is given", async () => {
    const res = fakeRes(503, () => Promise.resolve({}));
    expect(await parseApiError(res)).toBe("Request failed (503)");
  });

  it("does not throw and uses the fallback when JSON parsing rejects", async () => {
    const res = fakeRes(500, () => Promise.reject(new SyntaxError("Unexpected end of JSON input")));
    await expect(parseApiError(res, "fallback message")).resolves.toBe("fallback message");
  });

  it("ignores a non-string error value", async () => {
    const res = fakeRes(422, () => Promise.resolve({ error: { nested: true } }));
    expect(await parseApiError(res)).toBe("Request failed (422)");
  });

  it("ignores an empty-string error value and uses the fallback", async () => {
    const res = fakeRes(400, () => Promise.resolve({ error: "   " }));
    expect(await parseApiError(res, "default")).toBe("default");
  });

  it("ignores an array body and uses the status default", async () => {
    const res = fakeRes(400, () => Promise.resolve([{ error: "nope" }]));
    expect(await parseApiError(res)).toBe("Request failed (400)");
  });
});
