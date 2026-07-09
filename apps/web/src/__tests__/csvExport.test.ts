/**
 * Regression tests for csvExport.ts pure logic.
 *
 * Protects:
 *   - escapeCsvField: null/undefined → empty, comma/quote/newline → quoted
 *   - exportMatchesCsv: only MATCHES_FOUND companies, correct headers, includes jobs
 *   - exportNoMatchCsv: only NO_MATCH_SCAN_COMPLETED, company-only headers
 *   - exportUnverifiedCsv: UNVERIFIED + CANCELLED, excludes other statuses
 *   - exportCombinedCsv: all companies, empty job columns for no-match rows
 *   - Ordering: input_index ascending regardless of array order
 *
 * triggerDownload (browser-side) is stubbed:
 *   - Blob global is replaced to capture the CSV string before download
 *   - URL.createObjectURL and URL.revokeObjectURL are added (missing in jsdom)
 *   - document.createElement / body operations work natively in jsdom environment
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { RunDetailResponse, RunResponse, RunCompanyResponse, JobRowResponse } from "@surveyor/shared";
import { CompanyStatus } from "@surveyor/shared";
import {
  exportMatchesCsv,
  exportNoMatchCsv,
  exportUnverifiedCsv,
  exportCombinedCsv,
} from "../csvExport.js";

// ---------------------------------------------------------------------------
// Browser stub setup
// ---------------------------------------------------------------------------

let capturedCsv = "";

beforeEach(() => {
  capturedCsv = "";

  // Replace Blob with a class that captures the CSV string passed as the first BlobPart.
  // triggerDownload calls: new Blob([csv], { type: "text/csv;..." })
  // Arrow functions cannot be constructors, so a class is required here.
  class BlobCapture {
    constructor(parts?: BlobPart[]) {
      capturedCsv = typeof parts?.[0] === "string" ? parts[0] : "";
    }
  }
  vi.stubGlobal("Blob", BlobCapture as unknown as typeof Blob);

  // jsdom does not implement URL.createObjectURL / revokeObjectURL.
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn().mockReturnValue("blob:mock"),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });

  // jsdom fires "Not implemented: navigation" when a.click() is called on an
  // anchor with href set. Suppress it; we only care about the CSV content.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const MOCK_RUN: RunResponse = {
  id: "run-1",
  status: "COMPLETED",
  role_raw: "Software Engineer",
  include_adjacent: false,
  error_code: null,
  error_message: null,
};

function makeCompany(id: string, status: CompanyStatus, inputIndex: number, overrides: Partial<RunCompanyResponse> = {}): RunCompanyResponse {
  return {
    id,
    company_name: `Co-${id}`,
    status,
    input_index: inputIndex,
    failure_code: null,
    failure_reason: null,
    careers_url: null,
    ats_type: null,
    extractor_used: null,
    listings_scanned: null,
    pages_visited: null,
    ...overrides,
  };
}

function makeJob(id: string, companyId: string, overrides: Partial<JobRowResponse> = {}): JobRowResponse {
  return {
    id,
    run_id: "run-1",
    company_id: companyId,
    title: "Software Engineer",
    location: "Remote",
    url: "https://example.com/jobs/1",
    match_reason: "Matched inclusion phrase Software Engineer",
    job_detail_available: false,
    job_detail_failure_code: null,
    job_detail_failure_reason: null,
    ...overrides,
  };
}

function makeDetail(companies: RunCompanyResponse[], matched_jobs: JobRowResponse[] = []): RunDetailResponse {
  return { run: MOCK_RUN, companies, matched_jobs };
}

function csvLines(): string[] {
  return capturedCsv.split("\r\n");
}

// ---------------------------------------------------------------------------
// escapeCsvField behavior — tested via CSV output
// ---------------------------------------------------------------------------

describe("escapeCsvField — behavior through CSV output", () => {
  it("null field becomes an empty cell (no quotes)", () => {
    const c = makeCompany("c1", CompanyStatus.NO_MATCH_SCAN_COMPLETED, 0, { careers_url: null });
    exportNoMatchCsv(makeDetail([c]), "run-1");
    const dataRow = csvLines()[1];
    // careers_url is the 4th field (0-indexed: company_name,input_index,company_status,careers_url,...)
    const fields = dataRow.split(",");
    expect(fields[3]).toBe("");
  });

  it("field containing a comma is double-quoted", () => {
    const c = makeCompany("c1", CompanyStatus.NO_MATCH_SCAN_COMPLETED, 0, { company_name: "Acme, Inc" });
    exportNoMatchCsv(makeDetail([c]), "run-1");
    const dataRow = csvLines()[1];
    expect(dataRow).toContain('"Acme, Inc"');
  });

  it("field containing a double quote uses doubled-quote escaping", () => {
    const c = makeCompany("c1", CompanyStatus.NO_MATCH_SCAN_COMPLETED, 0, { company_name: 'Acme "Labs"' });
    exportNoMatchCsv(makeDetail([c]), "run-1");
    const dataRow = csvLines()[1];
    expect(dataRow).toContain('"Acme ""Labs"""');
  });

  it("field containing a newline is double-quoted", () => {
    const c = makeCompany("c1", CompanyStatus.NO_MATCH_SCAN_COMPLETED, 0, { company_name: "Acme\nInc" });
    exportNoMatchCsv(makeDetail([c]), "run-1");
    const dataRow = csvLines()[1];
    expect(dataRow).toContain('"Acme\nInc"');
  });

  it("numeric field is stringified without quotes", () => {
    const c = makeCompany("c1", CompanyStatus.NO_MATCH_SCAN_COMPLETED, 0, { listings_scanned: 42 });
    exportNoMatchCsv(makeDetail([c]), "run-1");
    const dataRow = csvLines()[1];
    // listings_scanned is the 7th field (0-indexed)
    const fields = dataRow.split(",");
    expect(fields[6]).toBe("42");
  });
});

// ---------------------------------------------------------------------------
// exportMatchesCsv
// ---------------------------------------------------------------------------

describe("exportMatchesCsv", () => {
  it("first line is the correct header row", () => {
    exportMatchesCsv(makeDetail([]), "run-1");
    const header = csvLines()[0];
    expect(header).toBe(
      "company_name,input_index,company_status,careers_url,ats_type,extractor_used,listings_scanned,pages_visited,failure_code,failure_reason,job_title,job_location,job_url,match_reason",
    );
  });

  it("only includes MATCHES_FOUND companies", () => {
    const matched = makeCompany("c1", CompanyStatus.MATCHES_FOUND, 0);
    const noMatch = makeCompany("c2", CompanyStatus.NO_MATCH_SCAN_COMPLETED, 1);
    const unverified = makeCompany("c3", CompanyStatus.UNVERIFIED, 2);
    const job = makeJob("j1", "c1");

    exportMatchesCsv(makeDetail([matched, noMatch, unverified], [job]), "run-1");

    // 1 header + 1 job row for the matched company only
    expect(csvLines()).toHaveLength(2);
  });

  it("includes one row per matched job for a MATCHES_FOUND company", () => {
    const c = makeCompany("c1", CompanyStatus.MATCHES_FOUND, 0);
    const jobs = [
      makeJob("j1", "c1", { title: "Software Engineer" }),
      makeJob("j2", "c1", { title: "Backend Engineer" }),
    ];

    exportMatchesCsv(makeDetail([c], jobs), "run-1");

    // 1 header + 2 job rows
    expect(csvLines()).toHaveLength(3);
  });

  it("job title, location, url, match_reason appear in each matched row", () => {
    const c = makeCompany("c1", CompanyStatus.MATCHES_FOUND, 0);
    const job = makeJob("j1", "c1", {
      title: "Software Engineer",
      location: "Remote",
      url: "https://boards.greenhouse.io/acme/1",
      match_reason: "Matched inclusion phrase Software Engineer",
    });

    exportMatchesCsv(makeDetail([c], [job]), "run-1");
    const dataRow = csvLines()[1];
    expect(dataRow).toContain("Software Engineer");
    expect(dataRow).toContain("Remote");
    expect(dataRow).toContain("https://boards.greenhouse.io/acme/1");
    expect(dataRow).toContain("Matched inclusion phrase Software Engineer");
  });
});

// ---------------------------------------------------------------------------
// exportNoMatchCsv
// ---------------------------------------------------------------------------

describe("exportNoMatchCsv", () => {
  it("first line is the correct company-only header row", () => {
    exportNoMatchCsv(makeDetail([]), "run-1");
    const header = csvLines()[0];
    expect(header).toBe(
      "company_name,input_index,company_status,careers_url,ats_type,extractor_used,listings_scanned,pages_visited,failure_code,failure_reason",
    );
  });

  it("only includes NO_MATCH_SCAN_COMPLETED companies", () => {
    const noMatch = makeCompany("c1", CompanyStatus.NO_MATCH_SCAN_COMPLETED, 0);
    const matched = makeCompany("c2", CompanyStatus.MATCHES_FOUND, 1);
    const unverified = makeCompany("c3", CompanyStatus.UNVERIFIED, 2);

    exportNoMatchCsv(makeDetail([noMatch, matched, unverified]), "run-1");

    // 1 header + 1 data row (only the NO_MATCH company)
    expect(csvLines()).toHaveLength(2);
    expect(csvLines()[1]).toContain("Co-c1");
  });

  it("produces only a header row when no companies match", () => {
    const c = makeCompany("c1", CompanyStatus.MATCHES_FOUND, 0);
    exportNoMatchCsv(makeDetail([c]), "run-1");
    expect(csvLines()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// exportUnverifiedCsv
// ---------------------------------------------------------------------------

describe("exportUnverifiedCsv", () => {
  it("includes UNVERIFIED companies", () => {
    const c = makeCompany("c1", CompanyStatus.UNVERIFIED, 0);
    exportUnverifiedCsv(makeDetail([c]), "run-1");
    expect(csvLines()).toHaveLength(2);
    expect(csvLines()[1]).toContain("Co-c1");
  });

  it("includes CANCELLED companies", () => {
    const c = makeCompany("c1", CompanyStatus.CANCELLED, 0);
    exportUnverifiedCsv(makeDetail([c]), "run-1");
    expect(csvLines()).toHaveLength(2);
    expect(csvLines()[1]).toContain("Co-c1");
  });

  it("excludes MATCHES_FOUND and NO_MATCH_SCAN_COMPLETED companies", () => {
    const matched = makeCompany("c1", CompanyStatus.MATCHES_FOUND, 0);
    const noMatch = makeCompany("c2", CompanyStatus.NO_MATCH_SCAN_COMPLETED, 1);
    const unverified = makeCompany("c3", CompanyStatus.UNVERIFIED, 2);
    const cancelled = makeCompany("c4", CompanyStatus.CANCELLED, 3);

    exportUnverifiedCsv(makeDetail([matched, noMatch, unverified, cancelled]), "run-1");

    // 1 header + 2 data rows (UNVERIFIED + CANCELLED only)
    expect(csvLines()).toHaveLength(3);
  });

  it("uses company-only headers (no job columns)", () => {
    exportUnverifiedCsv(makeDetail([]), "run-1");
    const header = csvLines()[0];
    expect(header).not.toContain("job_title");
    expect(header).toContain("failure_code");
  });
});

// ---------------------------------------------------------------------------
// exportCombinedCsv
// ---------------------------------------------------------------------------

describe("exportCombinedCsv", () => {
  it("includes all company statuses", () => {
    const companies = [
      makeCompany("c1", CompanyStatus.MATCHES_FOUND, 0),
      makeCompany("c2", CompanyStatus.NO_MATCH_SCAN_COMPLETED, 1),
      makeCompany("c3", CompanyStatus.UNVERIFIED, 2),
      makeCompany("c4", CompanyStatus.CANCELLED, 3),
    ];
    const job = makeJob("j1", "c1");

    exportCombinedCsv(makeDetail(companies, [job]), "run-1");

    // 1 header + 1 job row (c1) + 3 empty-job rows (c2, c3, c4)
    expect(csvLines()).toHaveLength(5);
  });

  it("MATCHES_FOUND company with jobs gets one row per job", () => {
    const c = makeCompany("c1", CompanyStatus.MATCHES_FOUND, 0);
    const jobs = [makeJob("j1", "c1"), makeJob("j2", "c1")];

    exportCombinedCsv(makeDetail([c], jobs), "run-1");

    // 1 header + 2 job rows
    expect(csvLines()).toHaveLength(3);
  });

  it("company with no matched jobs gets a row with empty job columns", () => {
    const c = makeCompany("c1", CompanyStatus.NO_MATCH_SCAN_COMPLETED, 0);

    exportCombinedCsv(makeDetail([c], []), "run-1");

    // 1 header + 1 row with empty job fields at the end
    expect(csvLines()).toHaveLength(2);
    // Row ends with 3 trailing commas (empty job_title, job_location, job_url, match_reason → last 3 separators)
    const dataRow = csvLines()[1];
    expect(dataRow.endsWith(",,,")).toBe(true);
  });

  it("uses MATCHES_HEADERS (includes job columns)", () => {
    exportCombinedCsv(makeDetail([]), "run-1");
    const header = csvLines()[0];
    expect(header).toContain("job_title");
    expect(header).toContain("match_reason");
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe("input_index ordering", () => {
  it("sorts companies by input_index ascending even when array is out of order", () => {
    const companies = [
      makeCompany("c3", CompanyStatus.NO_MATCH_SCAN_COMPLETED, 2, { company_name: "Third" }),
      makeCompany("c1", CompanyStatus.NO_MATCH_SCAN_COMPLETED, 0, { company_name: "First" }),
      makeCompany("c2", CompanyStatus.NO_MATCH_SCAN_COMPLETED, 1, { company_name: "Second" }),
    ];

    exportNoMatchCsv(makeDetail(companies), "run-1");

    const lines = csvLines();
    expect(lines[1]).toContain("First");
    expect(lines[2]).toContain("Second");
    expect(lines[3]).toContain("Third");
  });

  it("exportMatchesCsv preserves input_index ordering for matched companies", () => {
    const c1 = makeCompany("c1", CompanyStatus.MATCHES_FOUND, 0, { company_name: "First" });
    const c2 = makeCompany("c2", CompanyStatus.MATCHES_FOUND, 1, { company_name: "Second" });
    const jobs = [
      makeJob("j2", "c2", { title: "Job at Second" }),
      makeJob("j1", "c1", { title: "Job at First" }),
    ];

    // c2 and its job appear before c1 in the array, but ordering should use input_index
    exportMatchesCsv(makeDetail([c2, c1], jobs), "run-1");

    const lines = csvLines();
    expect(lines[1]).toContain("First");
    expect(lines[2]).toContain("Second");
  });
});
