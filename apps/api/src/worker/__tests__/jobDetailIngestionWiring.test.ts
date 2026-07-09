/**
 * Gate 3 lifecycle wiring tests (agentReadiness.md Step 3.3 / operatingContext.md):
 * job detail ingestion must run after the finalization transaction commits,
 * only for MATCHES_FOUND companies, and must complete before tryCompleteRun.
 *
 * Upstream pipeline stages (discovery, platform detection, extraction, matching)
 * are mocked so the test exercises only the finalize → ingest → complete wiring
 * inside processClaimedCompany, without depending on real HTTP/search behavior
 * already covered by discovery.test.ts / extraction-completion.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { AtsType, CompanyStatus } from "@surveyor/shared";
import { db } from "../../db/db.js";

vi.mock("../../lib/discovery.js", () => ({
  discoverCareersUrl: vi.fn(),
}));
vi.mock("../../lib/platform.js", () => ({
  detectPlatform: vi.fn().mockReturnValue(AtsType.GREENHOUSE),
}));
vi.mock("../../lib/extraction.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/extraction.js")>("../../lib/extraction.js");
  return {
    ...actual,
    extractJobs: vi.fn(),
    initialExtractorForAts: vi.fn().mockReturnValue("GREENHOUSE"),
    shouldAttemptPlaywrightFallback: vi.fn().mockReturnValue(false),
  };
});
vi.mock("../../lib/matching.js", () => ({
  matchJobs: vi.fn(),
}));

const ingestJobDetailsForCompanyMock = vi.fn().mockResolvedValue({
  attempted: 0,
  inserted: 0,
  skipped: 0,
  failed: 0,
});
vi.mock("../../lib/jobDetailIngestion.js", () => ({
  ingestJobDetailsForCompany: (...args: unknown[]) => ingestJobDetailsForCompanyMock(...args),
}));

const tryCompleteRunMock = vi.fn();
vi.mock("../tryCompleteRun.js", () => ({
  tryCompleteRun: (...args: unknown[]) => tryCompleteRunMock(...args),
}));

const { discoverCareersUrl } = await import("../../lib/discovery.js");
const { extractJobs } = await import("../../lib/extraction.js");
const { matchJobs } = await import("../../lib/matching.js");
const { processClaimedCompany } = await import("../processClaimedCompany.js");

let runId: string;
let companyId: string;
let workerToken: string;

function insertRun(id: string, roleSpec: unknown): void {
  db.prepare(
    `INSERT INTO runs (id, created_at, status, role_raw, include_adjacent, role_spec_json, company_count)
     VALUES (?, ?, 'RUNNING', 'Software Engineer', 0, ?, 1)`
  ).run(id, Date.now(), JSON.stringify(roleSpec));
}

function insertInProgressCompany(id: string, rId: string, token: string): void {
  db.prepare(
    `INSERT INTO run_companies (id, run_id, company_name, input_index, status, created_at, started_at, worker_token)
     VALUES (?, ?, 'Acme', 0, 'IN_PROGRESS', ?, ?, ?)`
  ).run(id, rId, Date.now(), Date.now(), token);
}

beforeEach(() => {
  runId = randomUUID();
  companyId = randomUUID();
  workerToken = randomUUID();
  insertRun(runId, { include_titles: ["Software Engineer"], exclude_titles: [], seniority: "any" });
  insertInProgressCompany(companyId, runId, workerToken);
  ingestJobDetailsForCompanyMock.mockClear();
  tryCompleteRunMock.mockClear();
});

afterEach(() => {
  db.prepare("DELETE FROM job_details WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM trace_events WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM job_rows WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM run_companies WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
  vi.clearAllMocks();
});

describe("processClaimedCompany — job detail ingestion wiring", () => {
  it("calls ingestJobDetailsForCompany before tryCompleteRun when company finalizes MATCHES_FOUND", async () => {
    vi.mocked(discoverCareersUrl).mockResolvedValue({
      careers_url: "https://acme.com/careers",
      listings_url: "https://acme.com/careers",
      attempted_urls: ["https://acme.com/careers"],
      failure_code: null,
      selected_source_type: "DIRECT",
      page_kind: "CAREERS",
      resolution_method: "DIRECT_VERIFIED",
      verification_reasons: [],
      resolution_path_detail: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    vi.mocked(extractJobs).mockResolvedValue({
      jobs: [{ title: "Software Engineer", location: "Remote", url: "https://acme.com/jobs/1" }],
      completed: true,
      listings_scanned: 1,
      pages_visited: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    vi.mocked(matchJobs).mockReturnValue([
      {
        title: "Software Engineer",
        location: "Remote",
        url: "https://acme.com/jobs/1",
        match_reason: "Matched inclusion phrase Software Engineer",
      },
    ]);

    const callOrder: string[] = [];
    ingestJobDetailsForCompanyMock.mockImplementation(async () => {
      callOrder.push("ingest");
      return { attempted: 1, inserted: 1, skipped: 0, failed: 0 };
    });
    tryCompleteRunMock.mockImplementation(() => {
      callOrder.push("complete");
    });

    await processClaimedCompany({
      run_id: runId,
      run_company_id: companyId,
      company_name: "Acme",
      worker_token: workerToken,
    });

    const company = db.prepare("SELECT status FROM run_companies WHERE id = ?").get(companyId) as
      | { status: string }
      | undefined;
    expect(company?.status).toBe(CompanyStatus.MATCHES_FOUND);

    expect(ingestJobDetailsForCompanyMock).toHaveBeenCalledTimes(1);
    expect(ingestJobDetailsForCompanyMock).toHaveBeenCalledWith(runId, companyId);
    expect(tryCompleteRunMock).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["ingest", "complete"]);
  });

  it("does not call ingestJobDetailsForCompany when company finalizes UNVERIFIED (discovery failure)", async () => {
    vi.mocked(discoverCareersUrl).mockResolvedValue({
      careers_url: null,
      listings_url: null,
      attempted_urls: ["https://acme.com"],
      failure_code: "CAREERS_NOT_FOUND",
      selected_source_type: null,
      page_kind: null,
      resolution_method: null,
      verification_reasons: [],
      resolution_path_detail: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await processClaimedCompany({
      run_id: runId,
      run_company_id: companyId,
      company_name: "Acme",
      worker_token: workerToken,
    });

    const company = db.prepare("SELECT status FROM run_companies WHERE id = ?").get(companyId) as
      | { status: string }
      | undefined;
    expect(company?.status).toBe(CompanyStatus.UNVERIFIED);

    expect(ingestJobDetailsForCompanyMock).not.toHaveBeenCalled();
    expect(tryCompleteRunMock).toHaveBeenCalledTimes(1);
  });

  it("does not change company status when ingestJobDetailsForCompany throws unexpectedly", async () => {
    vi.mocked(discoverCareersUrl).mockResolvedValue({
      careers_url: "https://acme.com/careers",
      listings_url: "https://acme.com/careers",
      attempted_urls: ["https://acme.com/careers"],
      failure_code: null,
      selected_source_type: "DIRECT",
      page_kind: "CAREERS",
      resolution_method: "DIRECT_VERIFIED",
      verification_reasons: [],
      resolution_path_detail: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    vi.mocked(extractJobs).mockResolvedValue({
      jobs: [{ title: "Software Engineer", location: "Remote", url: "https://acme.com/jobs/1" }],
      completed: true,
      listings_scanned: 1,
      pages_visited: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    vi.mocked(matchJobs).mockReturnValue([
      {
        title: "Software Engineer",
        location: "Remote",
        url: "https://acme.com/jobs/1",
        match_reason: "Matched inclusion phrase Software Engineer",
      },
    ]);

    ingestJobDetailsForCompanyMock.mockRejectedValue(new Error("unexpected ingestion crash"));

    await processClaimedCompany({
      run_id: runId,
      run_company_id: companyId,
      company_name: "Acme",
      worker_token: workerToken,
    });

    const company = db.prepare("SELECT status FROM run_companies WHERE id = ?").get(companyId) as
      | { status: string }
      | undefined;
    expect(company?.status).toBe(CompanyStatus.MATCHES_FOUND);
    expect(tryCompleteRunMock).toHaveBeenCalledTimes(1);
  });
});
