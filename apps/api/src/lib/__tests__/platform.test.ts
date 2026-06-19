/**
 * P0 unit tests for detectPlatform (platform.ts).
 *
 * Protects:
 *   - GREENHOUSE, LEVER, ASHBY, SMARTRECRUITERS, UNKNOWN detection
 *   - Detection is deterministic (pure function, no LLM, no network)
 *   - First-match-wins ordering when multiple ATS signals are present
 *   - Host subdomain matching (only official subdomains, not arbitrary suffix matches)
 */

import { describe, expect, it } from "vitest";
import { detectPlatform } from "../platform.js";
import { AtsType } from "@surveyor/shared";

// ---------------------------------------------------------------------------
// GREENHOUSE
// ---------------------------------------------------------------------------

describe("detectPlatform — GREENHOUSE", () => {
  it("detects from a boards.greenhouse.io URL", () => {
    expect(detectPlatform("", "https://boards.greenhouse.io/acmecorp")).toBe(AtsType.GREENHOUSE);
  });

  it("detects from a job-boards.greenhouse.io URL", () => {
    expect(detectPlatform("", "https://job-boards.greenhouse.io/acmecorp")).toBe(AtsType.GREENHOUSE);
  });

  it("detects from HTML that references boards.greenhouse.io", () => {
    const html = '<a href="https://boards.greenhouse.io/acme/jobs/123">Apply</a>';
    expect(detectPlatform(html, "https://example.com/careers")).toBe(AtsType.GREENHOUSE);
  });

  it("detects from HTML that references job-boards.greenhouse.io", () => {
    const html = '<a href="https://job-boards.greenhouse.io/acme/jobs/456">Apply</a>';
    expect(detectPlatform(html, "https://example.com/careers")).toBe(AtsType.GREENHOUSE);
  });

  it("detects from a Greenhouse embed script src in HTML", () => {
    const html = '<script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>';
    expect(detectPlatform(html, "https://example.com/careers")).toBe(AtsType.GREENHOUSE);
  });

  it("detects from grnh.se shortlink in HTML", () => {
    const html = '<a href="https://grnh.se/abc123">Apply via Greenhouse</a>';
    expect(detectPlatform(html, "https://example.com/careers")).toBe(AtsType.GREENHOUSE);
  });
});

// ---------------------------------------------------------------------------
// LEVER
// ---------------------------------------------------------------------------

describe("detectPlatform — LEVER", () => {
  it("detects from a jobs.lever.co URL", () => {
    expect(detectPlatform("", "https://jobs.lever.co/acmecorp")).toBe(AtsType.LEVER);
  });

  it("detects from HTML that references jobs.lever.co", () => {
    const html = '<a href="https://jobs.lever.co/acmecorp/abc-123">Apply</a>';
    expect(detectPlatform(html, "https://example.com/careers")).toBe(AtsType.LEVER);
  });

  it("detects from HTML that references api.lever.co", () => {
    const html = '<script src="https://api.lever.co/v0/postings/co?mode=json"></script>';
    expect(detectPlatform(html, "https://example.com/careers")).toBe(AtsType.LEVER);
  });
});

// ---------------------------------------------------------------------------
// ASHBY
// ---------------------------------------------------------------------------

describe("detectPlatform — ASHBY", () => {
  it("detects from a jobs.ashbyhq.com URL", () => {
    expect(detectPlatform("", "https://jobs.ashbyhq.com/techstartup")).toBe(AtsType.ASHBY);
  });

  it("detects from HTML that references app.ashbyhq.com", () => {
    const html = '<script src="https://app.ashbyhq.com/api/non-user-facing/job-board/techco"></script>';
    expect(detectPlatform(html, "https://example.com/careers")).toBe(AtsType.ASHBY);
  });

  it("detects from HTML that references jobs.ashbyhq.com", () => {
    const html = '<a href="https://jobs.ashbyhq.com/techstartup/opening-id">Apply</a>';
    expect(detectPlatform(html, "https://example.com/careers")).toBe(AtsType.ASHBY);
  });
});

// ---------------------------------------------------------------------------
// SMARTRECRUITERS
// ---------------------------------------------------------------------------

describe("detectPlatform — SMARTRECRUITERS", () => {
  it("detects from a jobs.smartrecruiters.com URL", () => {
    expect(detectPlatform("", "https://jobs.smartrecruiters.com/AcmeCorp")).toBe(AtsType.SMARTRECRUITERS);
  });

  it("detects from HTML that references smartrecruiters.com", () => {
    const html = '<script src="https://smartrecruiters.com/settings/v2/public/js/widget.js"></script>';
    expect(detectPlatform(html, "https://example.com/careers")).toBe(AtsType.SMARTRECRUITERS);
  });

  it("detects from smrtr.io shortlink in HTML", () => {
    const html = '<a href="https://smrtr.io/abc123">Apply</a>';
    expect(detectPlatform(html, "https://example.com/careers")).toBe(AtsType.SMARTRECRUITERS);
  });
});

// ---------------------------------------------------------------------------
// UNKNOWN
// ---------------------------------------------------------------------------

describe("detectPlatform — UNKNOWN", () => {
  it("returns UNKNOWN for plain HTML with no ATS signals", () => {
    const html = "<html><body><h1>Join our team</h1><p>Email us your CV.</p></body></html>";
    expect(detectPlatform(html, "https://example.com/careers")).toBe(AtsType.UNKNOWN);
  });

  it("returns UNKNOWN for empty HTML and a generic URL", () => {
    expect(detectPlatform("", "https://example.com/careers/jobs")).toBe(AtsType.UNKNOWN);
  });

  it("returns UNKNOWN when 'greenhouse' appears only in non-ATS URL path text", () => {
    // The word 'greenhouse' in a non-ATS domain must not trigger GREENHOUSE detection.
    expect(detectPlatform("", "https://example.com/blog/greenhouse-hiring")).toBe(AtsType.UNKNOWN);
  });
});

// ---------------------------------------------------------------------------
// Determinism and ordering
// ---------------------------------------------------------------------------

describe("detectPlatform — determinism and first-match-wins", () => {
  it("returns the same result on repeated calls with the same inputs", () => {
    const html = '<script src="https://boards.greenhouse.io/embed/job_board/js?for=co"></script>';
    const url = "https://example.com/careers";
    expect(detectPlatform(html, url)).toBe(detectPlatform(html, url));
  });

  it("GREENHOUSE wins when both GREENHOUSE and LEVER signals appear (first-match-wins)", () => {
    // ORDERED_PLATFORM_RULES evaluates GREENHOUSE before LEVER.
    const html = [
      '<a href="https://boards.greenhouse.io/co">GH Jobs</a>',
      '<a href="https://jobs.lever.co/co">Lever Jobs</a>',
    ].join("\n");
    expect(detectPlatform(html, "https://example.com/careers")).toBe(AtsType.GREENHOUSE);
  });

  it("LEVER wins when only LEVER signals appear (no GREENHOUSE)", () => {
    const html = '<a href="https://jobs.lever.co/co/abc">Apply</a>';
    expect(detectPlatform(html, "https://example.com/careers")).toBe(AtsType.LEVER);
  });
});
