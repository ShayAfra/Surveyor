/**
 * Pure unit tests for the shared job identity helper (extracted from
 * monitoring.ts in Milestone 7 so both monitoring and application tracking
 * use one identity definition). No database, no network.
 */

import { describe, expect, it } from "vitest";
import { computeJobKey, normalizeJobUrl, normalizeText } from "../jobIdentity.js";

describe("computeJobKey", () => {
  it("produces a stable key for a valid URL", () => {
    const key = computeJobKey({
      companyName: "Acme",
      title: "Software Engineer",
      location: "Remote",
      url: "https://boards.greenhouse.io/acme/jobs/123",
    });
    expect(key).toBe("url:https://boards.greenhouse.io/acme/jobs/123");
  });

  it("normalizes query strings, hashes are preserved as part of pathname-only normalization, and trailing slashes consistently", () => {
    const withTrailingSlash = computeJobKey({
      companyName: "Acme",
      title: "Software Engineer",
      location: "Remote",
      url: "https://boards.greenhouse.io/acme/jobs/123/",
    });
    const withoutTrailingSlash = computeJobKey({
      companyName: "Acme",
      title: "Software Engineer",
      location: "Remote",
      url: "https://boards.greenhouse.io/acme/jobs/123",
    });
    expect(withTrailingSlash).toBe(withoutTrailingSlash);

    const upperHost = computeJobKey({
      companyName: "Acme",
      title: "Software Engineer",
      location: "Remote",
      url: "HTTPS://BOARDS.GREENHOUSE.IO/acme/jobs/123",
    });
    expect(upperHost).toBe(withoutTrailingSlash);
  });

  it("uses the fallback key when the URL is invalid/unparseable", () => {
    const key = computeJobKey({
      companyName: "Acme",
      title: "Software Engineer",
      location: "Remote",
      url: "not a url",
    });
    expect(key).toBe("fallback:acme|software engineer|remote");
  });

  it("uses the fallback key when the URL is empty", () => {
    const key = computeJobKey({
      companyName: "Acme",
      title: "Software Engineer",
      location: null,
      url: "",
    });
    expect(key).toBe("fallback:acme|software engineer|");
  });

  it("dedupes the same real job across different job_row_id values via job_key (identical inputs, same key)", () => {
    const keyA = computeJobKey({
      companyName: "Acme",
      title: "Software Engineer",
      location: "Remote",
      url: "https://boards.greenhouse.io/acme/jobs/123",
    });
    // Simulates a second monitoring run producing a new job_row_id but the
    // same underlying job (same URL) — the key must match so application
    // tracking's UNIQUE(user_id, job_key) catches the duplicate.
    const keyB = computeJobKey({
      companyName: "Acme",
      title: "Software Engineer",
      location: "Remote",
      url: "https://boards.greenhouse.io/acme/jobs/123",
    });
    expect(keyA).toBe(keyB);
  });

  it("does not collide different jobs with different title/location", () => {
    const key1 = computeJobKey({
      companyName: "Acme",
      title: "Software Engineer",
      location: "Remote",
      url: "",
    });
    const key2 = computeJobKey({
      companyName: "Acme",
      title: "Product Manager",
      location: "Remote",
      url: "",
    });
    const key3 = computeJobKey({
      companyName: "Acme",
      title: "Software Engineer",
      location: "New York",
      url: "",
    });
    expect(key1).not.toBe(key2);
    expect(key1).not.toBe(key3);
    expect(key2).not.toBe(key3);
  });
});

describe("normalizeJobUrl", () => {
  it("returns null for an empty string", () => {
    expect(normalizeJobUrl("")).toBeNull();
    expect(normalizeJobUrl("   ")).toBeNull();
  });

  it("returns null for an unparseable URL", () => {
    expect(normalizeJobUrl("not a url")).toBeNull();
  });

  it("strips a single trailing slash but preserves root path", () => {
    expect(normalizeJobUrl("https://example.com/")).toBe("https://example.com/");
    expect(normalizeJobUrl("https://example.com/jobs/1/")).toBe("https://example.com/jobs/1");
  });
});

describe("normalizeText", () => {
  it("trims, lowercases, and collapses whitespace", () => {
    expect(normalizeText("  Software   Engineer  ")).toBe("software engineer");
  });
});
