/**
 * Milestone 3 blocker-fix test: safeErrorName must never leak arbitrary error
 * content into logs. It exposes only a generic label (Error name, or typeof for
 * non-Errors) — never the Error.message and never thrown string content, which
 * could contain private/user/model/job/request data.
 */

import { describe, expect, it } from "vitest";
import { safeErrorName } from "../safeLog.js";

describe("safeErrorName", () => {
  it("returns the Error name and never the message", () => {
    const err = new Error("private user secret: resume text and cover letter draft");
    expect(safeErrorName(err)).toBe("Error");
    expect(safeErrorName(err)).not.toContain("resume");
    expect(safeErrorName(err)).not.toContain("secret");
  });

  it("returns the specific Error subclass name, not its message", () => {
    const err = new TypeError("boom with sensitive details");
    expect(safeErrorName(err)).toBe("TypeError");
    expect(safeErrorName(err)).not.toContain("sensitive");
  });

  it("does not expose thrown string content", () => {
    const result = safeErrorName("SELECT * FROM users WHERE token = 'abc123'");
    expect(result).toBe("string");
    expect(result).not.toContain("token");
    expect(result).not.toContain("abc123");
  });

  it("labels other thrown values by typeof only", () => {
    expect(safeErrorName({ message: "object detail" })).toBe("object");
    expect(safeErrorName(42)).toBe("number");
    expect(safeErrorName(undefined)).toBe("undefined");
    // typeof null is "object" — still a generic, content-free label.
    expect(safeErrorName(null)).toBe("object");
  });
});
