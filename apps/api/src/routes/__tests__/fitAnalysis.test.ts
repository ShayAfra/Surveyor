/**
 * Milestone 3 (Job Fit and Job Understanding Layer) endpoint tests:
 *   - POST /api/jobs/:jobRowId/fit-analysis
 *   - GET  /api/jobs/:jobRowId/fit-analysis
 *   - GET  /api/fit-analyses/:analysisId
 *   - DELETE /api/fit-analyses/:analysisId
 *
 * The LLM call is mocked via global fetch, mirroring lib/__tests__/roleSpec.test.ts.
 * The real model is never called in tests.
 *
 * Isolation: vitest.config.ts sets DB_PATH=:memory: so each test worker gets a
 * fresh in-memory SQLite DB. NODE_ENV=test prevents server.ts from starting
 * the worker loop or binding a port.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { app } from "../../server.js";
import { db } from "../../db/db.js";

const VALID_LLM_OUTPUT = {
  fit_summary: "Strong overall fit based on relevant experience.",
  strengths: [{ text: "Has 5 years of backend experience", evidence: "resume" }],
  gaps: [{ text: "No stated Kubernetes experience", evidence: "job description" }],
  risks: [{ text: "Career gap in 2021", evidence: "profile" }],
  suggested_next_steps: [{ text: "Highlight system design work", evidence: "resume" }],
  caveats: [],
};

function mockLlmSuccess(output: unknown = VALID_LLM_OUTPUT): void {
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(output) } }],
      }),
    })
  );
}

function mockLlmNetworkFailure(): void {
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
}

let authCookie: string;
let authUserId: string;
let otherCookie: string;

function extractSessionCookie(res: request.Response): string {
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie as unknown as string];
  const sessionCookie = cookies.find((c) => c.startsWith("surveyor_session="));
  return (sessionCookie as string).split(";")[0];
}

beforeEach(async () => {
  const email = `fitanalysis-test-${randomUUID()}@example.com`;
  const res = await request(app).post("/api/auth/signup").send({ email, password: "password123" });
  authCookie = extractSessionCookie(res);
  authUserId = res.body.id as string;

  const otherEmail = `fitanalysis-other-${randomUUID()}@example.com`;
  const otherRes = await request(app)
    .post("/api/auth/signup")
    .send({ email: otherEmail, password: "password123" });
  otherCookie = extractSessionCookie(otherRes);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db.prepare("DELETE FROM job_fit_analyses").run();
  db.prepare("DELETE FROM job_details").run();
  db.prepare("DELETE FROM trace_events").run();
  db.prepare("DELETE FROM job_rows").run();
  db.prepare("DELETE FROM run_companies").run();
  db.prepare("DELETE FROM runs").run();
  db.prepare("DELETE FROM resumes").run();
  db.prepare("DELETE FROM user_profile_items").run();
  db.prepare("DELETE FROM user_profiles").run();
  db.prepare("DELETE FROM sessions").run();
  db.prepare("DELETE FROM users").run();
});

function insertMatchedJobFor(
  userId: string,
  opts: { companyStatus?: string } = {}
): { runId: string; companyId: string; jobId: string } {
  const runId = randomUUID();
  const companyId = randomUUID();
  const jobId = randomUUID();

  db.prepare(
    `INSERT INTO runs (id, created_at, status, role_raw, include_adjacent, company_count, user_id)
     VALUES (?, ?, 'COMPLETED', 'Software Engineer', 0, 1, ?)`
  ).run(runId, Date.now(), userId);

  db.prepare(
    `INSERT INTO run_companies (id, run_id, company_name, input_index, status, created_at)
     VALUES (?, ?, 'Acme', 0, ?, ?)`
  ).run(companyId, runId, opts.companyStatus ?? "MATCHES_FOUND", Date.now());

  db.prepare(
    `INSERT INTO job_rows (id, run_id, company_id, title, location, url, match_reason)
     VALUES (?, ?, ?, 'Software Engineer', 'Remote', 'https://boards.greenhouse.io/acme/1', 'Matched inclusion phrase Software Engineer')`
  ).run(jobId, runId, companyId);

  return { runId, companyId, jobId };
}

function insertJobDetailWithDescription(
  runId: string,
  companyId: string,
  jobId: string
): void {
  db.prepare(
    `INSERT INTO job_details (id, run_id, company_id, job_row_id, job_url, description_text, fetched_at, failure_code, failure_reason, created_at)
     VALUES (?, ?, ?, ?, ?, 'We need a backend engineer with 5 years experience.', ?, NULL, NULL, ?)`
  ).run(randomUUID(), runId, companyId, jobId, "https://boards.greenhouse.io/acme/1", Date.now(), Date.now());
}

function insertJobDetailFailure(runId: string, companyId: string, jobId: string): void {
  db.prepare(
    `INSERT INTO job_details (id, run_id, company_id, job_row_id, job_url, description_text, fetched_at, failure_code, failure_reason, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, 'JOB_DETAIL_BLOCKED', 'job detail fetch was blocked', ?)`
  ).run(randomUUID(), runId, companyId, jobId, "https://boards.greenhouse.io/acme/1", Date.now(), Date.now());
}

function insertResume(userId: string, text = "Experienced backend engineer."): void {
  db.prepare(
    `INSERT INTO resumes (id, user_id, resume_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(randomUUID(), userId, text, Date.now(), Date.now());
}

function insertMeaningfulProfile(userId: string): void {
  db.prepare(
    `INSERT INTO user_profiles (id, user_id, full_name, location, years_experience, target_titles, notes, created_at, updated_at)
     VALUES (?, ?, 'Alice', 'Remote', 5, 'Software Engineer', NULL, ?, ?)`
  ).run(randomUUID(), userId, Date.now(), Date.now());
}

describe("POST /api/jobs/:jobRowId/fit-analysis", () => {
  it("returns 401 without a session", async () => {
    const res = await request(app).post(`/api/jobs/${randomUUID()}/fit-analysis`);
    expect(res.status).toBe(401);
  });

  it("returns 404 for a completely unknown jobRowId", async () => {
    mockLlmSuccess();
    const res = await request(app)
      .post(`/api/jobs/${randomUUID()}/fit-analysis`)
      .set("Cookie", authCookie);
    expect(res.status).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS c FROM job_fit_analyses").get()).toMatchObject({ c: 0 });
  });

  it("returns 404 for another user's job", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    const res = await request(app)
      .post(`/api/jobs/${jobId}/fit-analysis`)
      .set("Cookie", otherCookie);

    expect(res.status).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS c FROM job_fit_analyses").get()).toMatchObject({ c: 0 });
  });

  it("rejects a job whose company is not MATCHES_FOUND and does not create a row", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId, {
      companyStatus: "UNVERIFIED",
    });
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    const res = await request(app)
      .post(`/api/jobs/${jobId}/fit-analysis`)
      .set("Cookie", authCookie);

    expect([400, 409]).toContain(res.status);
    expect(db.prepare("SELECT COUNT(*) AS c FROM job_fit_analyses").get()).toMatchObject({ c: 0 });
  });

  it("rejects a matched job with no job_details row and does not create a row", async () => {
    mockLlmSuccess();
    const { jobId } = insertMatchedJobFor(authUserId);
    insertResume(authUserId);

    const res = await request(app)
      .post(`/api/jobs/${jobId}/fit-analysis`)
      .set("Cookie", authCookie);

    expect([400, 409]).toContain(res.status);
    expect(db.prepare("SELECT COUNT(*) AS c FROM job_fit_analyses").get()).toMatchObject({ c: 0 });
  });

  it("rejects when no resume/profile/items exist and does not call the LLM", async () => {
    const fetchSpy = vi.fn();
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal("fetch", fetchSpy);

    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);

    const res = await request(app)
      .post(`/api/jobs/${jobId}/fit-analysis`)
      .set("Cookie", authCookie);

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS c FROM job_fit_analyses").get()).toMatchObject({ c: 0 });
  });

  it("succeeds with description_text when resume evidence exists", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    const res = await request(app)
      .post(`/api/jobs/${jobId}/fit-analysis`)
      .set("Cookie", authCookie);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("COMPLETED");
    expect(res.body.fit_summary).toBe(VALID_LLM_OUTPUT.fit_summary);
  });

  it("succeeds with a caveat when job_details has only a failure row", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailFailure(runId, companyId, jobId);
    insertResume(authUserId);

    const res = await request(app)
      .post(`/api/jobs/${jobId}/fit-analysis`)
      .set("Cookie", authCookie);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("COMPLETED");
    expect(res.body.caveats.join(" ")).toContain("full job description could not be fetched");
  });

  it("succeeds with profile only (no resume)", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertMeaningfulProfile(authUserId);

    const res = await request(app)
      .post(`/api/jobs/${jobId}/fit-analysis`)
      .set("Cookie", authCookie);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("COMPLETED");
    expect(res.body.caveats.join(" ")).toContain("No resume is on file");
  });

  it("succeeds with resume only (no profile)", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    const res = await request(app)
      .post(`/api/jobs/${jobId}/fit-analysis`)
      .set("Cookie", authCookie);

    expect(res.status).toBe(201);
    expect(res.body.caveats.join(" ")).toContain("No structured profile is on file");
  });

  it("creates a FAILED row on invalid LLM output (missing required key)", async () => {
    mockLlmSuccess({ fit_summary: "ok" }); // missing strengths/gaps/risks/suggested_next_steps/caveats
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    const res = await request(app)
      .post(`/api/jobs/${jobId}/fit-analysis`)
      .set("Cookie", authCookie);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("FAILED");
    expect(res.body.failure_code).toBe("FIT_ANALYSIS_INVALID_OUTPUT");
    expect(res.body.fit_summary).toBeNull();
    expect(res.body.strengths).toBeNull();

    const row = db.prepare("SELECT * FROM job_fit_analyses WHERE job_row_id = ?").get(jobId) as {
      status: string;
    };
    expect(row.status).toBe("FAILED");
  });

  it("creates a FAILED row when the LLM call throws (network failure)", async () => {
    mockLlmNetworkFailure();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    const res = await request(app)
      .post(`/api/jobs/${jobId}/fit-analysis`)
      .set("Cookie", authCookie);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("FAILED");
    expect(res.body.failure_code).toBe("FIT_ANALYSIS_LLM_FAILED");
  });

  it("stores evidence_snapshot content reachable via caveats on the persisted row", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    await request(app).post(`/api/jobs/${jobId}/fit-analysis`).set("Cookie", authCookie);

    const row = db
      .prepare("SELECT evidence_snapshot_json FROM job_fit_analyses WHERE job_row_id = ?")
      .get(jobId) as { evidence_snapshot_json: string };
    const snapshot = JSON.parse(row.evidence_snapshot_json);
    expect(snapshot.job_row.title).toBe("Software Engineer");
    expect(snapshot.resume_text).toContain("backend engineer");
  });

  it("regeneration creates a second row rather than overwriting the first", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    await request(app).post(`/api/jobs/${jobId}/fit-analysis`).set("Cookie", authCookie);
    await request(app).post(`/api/jobs/${jobId}/fit-analysis`).set("Cookie", authCookie);

    const rows = db.prepare("SELECT * FROM job_fit_analyses WHERE job_row_id = ?").all(jobId);
    expect(rows.length).toBe(2);
  });

  it("does not mutate scanner tables (job_rows, run_companies, runs, job_details)", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    const beforeJobRow = db.prepare("SELECT * FROM job_rows WHERE id = ?").get(jobId);
    const beforeCompany = db.prepare("SELECT * FROM run_companies WHERE id = ?").get(companyId);
    const beforeRun = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
    const beforeDetail = db.prepare("SELECT * FROM job_details WHERE job_row_id = ?").get(jobId);

    await request(app).post(`/api/jobs/${jobId}/fit-analysis`).set("Cookie", authCookie);

    expect(db.prepare("SELECT * FROM job_rows WHERE id = ?").get(jobId)).toEqual(beforeJobRow);
    expect(db.prepare("SELECT * FROM run_companies WHERE id = ?").get(companyId)).toEqual(
      beforeCompany
    );
    expect(db.prepare("SELECT * FROM runs WHERE id = ?").get(runId)).toEqual(beforeRun);
    expect(db.prepare("SELECT * FROM job_details WHERE job_row_id = ?").get(jobId)).toEqual(
      beforeDetail
    );
  });
});

describe("GET /api/jobs/:jobRowId/fit-analysis", () => {
  it("returns 401 without a session", async () => {
    const res = await request(app).get(`/api/jobs/${randomUUID()}/fit-analysis`);
    expect(res.status).toBe(401);
  });

  it("returns [] when none exist for an owned job", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const res = await request(app)
      .get(`/api/jobs/${jobId}/fit-analysis`)
      .set("Cookie", authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns 404 for another user's job", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const res = await request(app)
      .get(`/api/jobs/${jobId}/fit-analysis`)
      .set("Cookie", otherCookie);
    expect(res.status).toBe(404);
  });

  it("returns owned analyses newest first", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    await request(app).post(`/api/jobs/${jobId}/fit-analysis`).set("Cookie", authCookie);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await request(app).post(`/api/jobs/${jobId}/fit-analysis`).set("Cookie", authCookie);

    const res = await request(app)
      .get(`/api/jobs/${jobId}/fit-analysis`)
      .set("Cookie", authCookie);

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
    expect(res.body[0].created_at).toBeGreaterThanOrEqual(res.body[1].created_at);
  });
});

describe("GET /api/fit-analyses/:analysisId", () => {
  it("returns 401 without a session", async () => {
    const res = await request(app).get(`/api/fit-analyses/${randomUUID()}`);
    expect(res.status).toBe(401);
  });

  it("returns the owned analysis", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    const createRes = await request(app)
      .post(`/api/jobs/${jobId}/fit-analysis`)
      .set("Cookie", authCookie);
    const analysisId = createRes.body.id as string;

    const res = await request(app)
      .get(`/api/fit-analyses/${analysisId}`)
      .set("Cookie", authCookie);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(analysisId);
  });

  it("returns 404 for another user's analysis", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    const createRes = await request(app)
      .post(`/api/jobs/${jobId}/fit-analysis`)
      .set("Cookie", authCookie);
    const analysisId = createRes.body.id as string;

    const res = await request(app)
      .get(`/api/fit-analyses/${analysisId}`)
      .set("Cookie", otherCookie);

    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/fit-analyses/:analysisId", () => {
  it("returns 401 without a session", async () => {
    const res = await request(app).delete(`/api/fit-analyses/${randomUUID()}`);
    expect(res.status).toBe(401);
  });

  it("deletes the owned analysis", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    const createRes = await request(app)
      .post(`/api/jobs/${jobId}/fit-analysis`)
      .set("Cookie", authCookie);
    const analysisId = createRes.body.id as string;

    const res = await request(app)
      .delete(`/api/fit-analyses/${analysisId}`)
      .set("Cookie", authCookie);
    expect(res.status).toBe(200);

    const getRes = await request(app)
      .get(`/api/fit-analyses/${analysisId}`)
      .set("Cookie", authCookie);
    expect(getRes.status).toBe(404);
  });

  it("returns 404 for another user's analysis and does not delete it", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    const createRes = await request(app)
      .post(`/api/jobs/${jobId}/fit-analysis`)
      .set("Cookie", authCookie);
    const analysisId = createRes.body.id as string;

    const res = await request(app)
      .delete(`/api/fit-analyses/${analysisId}`)
      .set("Cookie", otherCookie);
    expect(res.status).toBe(404);

    const stillThere = db.prepare("SELECT * FROM job_fit_analyses WHERE id = ?").get(analysisId);
    expect(stillThere).toBeDefined();
  });
});

describe("deleting profile/resume does not delete existing analyses", () => {
  it("keeps prior analyses after resume deletion", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    await request(app).post(`/api/jobs/${jobId}/fit-analysis`).set("Cookie", authCookie);
    await request(app).delete("/api/resume").set("Cookie", authCookie);

    const res = await request(app)
      .get(`/api/jobs/${jobId}/fit-analysis`)
      .set("Cookie", authCookie);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
  });
});
