/**
 * Milestone 4 (Application Packet Agent) endpoint tests:
 *   - POST /api/jobs/:jobRowId/application-packets
 *   - GET  /api/jobs/:jobRowId/application-packets
 *   - GET  /api/application-packets/:packetId
 *   - DELETE /api/application-packets/:packetId
 *
 * The LLM call is mocked via global fetch, mirroring routes/__tests__/fitAnalysis.test.ts.
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
  packet_summary: "Strong candidate for this backend role.",
  positioning_notes: [{ text: "Emphasize distributed systems work", evidence: "resume" }],
  cover_letter_draft: "Dear Hiring Manager, I am excited to apply for this role...",
  resume_bullet_suggestions: [
    { text: "Led migration of service to Kubernetes", evidence: "resume" },
  ],
  talking_points: [{ text: "Discuss on-call experience", evidence: "profile" }],
  questions_to_prepare: [{ text: "Ask about team structure", evidence: "job description" }],
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
  const email = `apppacket-test-${randomUUID()}@example.com`;
  const res = await request(app).post("/api/auth/signup").send({ email, password: "password123" });
  authCookie = extractSessionCookie(res);
  authUserId = res.body.id as string;

  const otherEmail = `apppacket-other-${randomUUID()}@example.com`;
  const otherRes = await request(app)
    .post("/api/auth/signup")
    .send({ email: otherEmail, password: "password123" });
  otherCookie = extractSessionCookie(otherRes);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db.prepare("DELETE FROM application_packets").run();
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

function insertJobDetailWithDescription(runId: string, companyId: string, jobId: string): void {
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

/** job_details row exists but has neither a usable description nor recorded failure metadata. */
function insertJobDetailIncomplete(
  runId: string,
  companyId: string,
  jobId: string,
  descriptionText: string | null = null
): void {
  db.prepare(
    `INSERT INTO job_details (id, run_id, company_id, job_row_id, job_url, description_text, fetched_at, failure_code, failure_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`
  ).run(
    randomUUID(),
    runId,
    companyId,
    jobId,
    "https://boards.greenhouse.io/acme/1",
    descriptionText,
    Date.now(),
    Date.now()
  );
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

function insertCompletedFitAnalysis(userId: string, jobId: string): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO job_fit_analyses
      (id, user_id, job_row_id, status, fit_summary, strengths_json, gaps_json, risks_json, suggested_next_steps_json, evidence_snapshot_json, model_name, failure_code, failure_reason, created_at)
     VALUES (?, ?, ?, 'COMPLETED', 'Good fit.', '[]', '[]', '[]', '[]', '{}', 'gpt-4o-mini', NULL, NULL, ?)`
  ).run(id, userId, jobId, Date.now());
  return id;
}

describe("POST /api/jobs/:jobRowId/application-packets", () => {
  it("returns 401 without a session", async () => {
    const res = await request(app).post(`/api/jobs/${randomUUID()}/application-packets`);
    expect(res.status).toBe(401);
  });

  it("returns 404 for a completely unknown jobRowId", async () => {
    mockLlmSuccess();
    const res = await request(app)
      .post(`/api/jobs/${randomUUID()}/application-packets`)
      .set("Cookie", authCookie);
    expect(res.status).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS c FROM application_packets").get()).toMatchObject({
      c: 0,
    });
  });

  it("returns 404 for another user's job and does not create a row", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    const res = await request(app)
      .post(`/api/jobs/${jobId}/application-packets`)
      .set("Cookie", otherCookie);

    expect(res.status).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS c FROM application_packets").get()).toMatchObject({
      c: 0,
    });
  });

  it("rejects a job whose company is not MATCHES_FOUND and does not create a row", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId, {
      companyStatus: "UNVERIFIED",
    });
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    const res = await request(app)
      .post(`/api/jobs/${jobId}/application-packets`)
      .set("Cookie", authCookie);

    expect(res.status).toBe(409);
    expect(db.prepare("SELECT COUNT(*) AS c FROM application_packets").get()).toMatchObject({
      c: 0,
    });
  });

  it("rejects a matched job with no job_details row and does not create a row", async () => {
    mockLlmSuccess();
    const { jobId } = insertMatchedJobFor(authUserId);
    insertResume(authUserId);

    const res = await request(app)
      .post(`/api/jobs/${jobId}/application-packets`)
      .set("Cookie", authCookie);

    expect(res.status).toBe(409);
    expect(db.prepare("SELECT COUNT(*) AS c FROM application_packets").get()).toMatchObject({
      c: 0,
    });
  });

  it("rejects a job_details row with null description and no recorded failure metadata, and does not call the LLM", async () => {
    const fetchSpy = vi.fn();
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal("fetch", fetchSpy);

    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailIncomplete(runId, companyId, jobId, null);
    insertResume(authUserId);

    const res = await request(app)
      .post(`/api/jobs/${jobId}/application-packets`)
      .set("Cookie", authCookie);

    expect(res.status).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS c FROM application_packets").get()).toMatchObject({
      c: 0,
    });
  });

  it("rejects a job_details row with blank description and no recorded failure metadata, and does not call the LLM", async () => {
    const fetchSpy = vi.fn();
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal("fetch", fetchSpy);

    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailIncomplete(runId, companyId, jobId, "   ");
    insertResume(authUserId);

    const res = await request(app)
      .post(`/api/jobs/${jobId}/application-packets`)
      .set("Cookie", authCookie);

    expect(res.status).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS c FROM application_packets").get()).toMatchObject({
      c: 0,
    });
  });

  it("rejects when no resume/profile/items exist and does not call the LLM", async () => {
    const fetchSpy = vi.fn();
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal("fetch", fetchSpy);

    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);

    const res = await request(app)
      .post(`/api/jobs/${jobId}/application-packets`)
      .set("Cookie", authCookie);

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS c FROM application_packets").get()).toMatchObject({
      c: 0,
    });
  });

  it("succeeds with description_text when resume evidence exists", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    const res = await request(app)
      .post(`/api/jobs/${jobId}/application-packets`)
      .set("Cookie", authCookie);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("COMPLETED");
    expect(res.body.packet_summary).toBe(VALID_LLM_OUTPUT.packet_summary);
    expect(res.body.cover_letter_draft).toBe(VALID_LLM_OUTPUT.cover_letter_draft);
  });

  it("succeeds with a caveat when job_details has only a failure row", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailFailure(runId, companyId, jobId);
    insertResume(authUserId);

    const res = await request(app)
      .post(`/api/jobs/${jobId}/application-packets`)
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
      .post(`/api/jobs/${jobId}/application-packets`)
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
      .post(`/api/jobs/${jobId}/application-packets`)
      .set("Cookie", authCookie);

    expect(res.status).toBe(201);
    expect(res.body.caveats.join(" ")).toContain("No structured profile is on file");
  });

  it("succeeds with no fit analysis and stores job_fit_analysis_id null", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    const res = await request(app)
      .post(`/api/jobs/${jobId}/application-packets`)
      .set("Cookie", authCookie);

    expect(res.status).toBe(201);
    expect(res.body.job_fit_analysis_id).toBeNull();
  });

  it("succeeds with a latest completed fit analysis and stores job_fit_analysis_id", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);
    const analysisId = insertCompletedFitAnalysis(authUserId, jobId);

    const res = await request(app)
      .post(`/api/jobs/${jobId}/application-packets`)
      .set("Cookie", authCookie);

    expect(res.status).toBe(201);
    expect(res.body.job_fit_analysis_id).toBe(analysisId);
  });

  it("creates a FAILED row on invalid LLM output (missing required key)", async () => {
    mockLlmSuccess({ packet_summary: "ok" }); // missing everything else
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    const res = await request(app)
      .post(`/api/jobs/${jobId}/application-packets`)
      .set("Cookie", authCookie);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("FAILED");
    expect(res.body.failure_code).toBe("APPLICATION_PACKET_INVALID_OUTPUT");
    expect(res.body.packet_summary).toBeNull();
    expect(res.body.cover_letter_draft).toBeNull();

    const row = db.prepare("SELECT * FROM application_packets WHERE job_row_id = ?").get(jobId) as {
      status: string;
    };
    expect(row.status).toBe("FAILED");
  });

  it("creates a FAILED row on invalid evidence items (extra key)", async () => {
    mockLlmSuccess({
      ...VALID_LLM_OUTPUT,
      positioning_notes: [{ text: "x", evidence: "y", extra: "z" }],
    });
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    const res = await request(app)
      .post(`/api/jobs/${jobId}/application-packets`)
      .set("Cookie", authCookie);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("FAILED");
    expect(res.body.failure_code).toBe("APPLICATION_PACKET_INVALID_OUTPUT");
  });

  it("creates a FAILED row when the LLM call throws (network failure)", async () => {
    mockLlmNetworkFailure();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    const res = await request(app)
      .post(`/api/jobs/${jobId}/application-packets`)
      .set("Cookie", authCookie);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("FAILED");
    expect(res.body.failure_code).toBe("APPLICATION_PACKET_LLM_FAILED");
  });

  it("stores evidence_snapshot content on the persisted row", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);
    insertCompletedFitAnalysis(authUserId, jobId);

    await request(app).post(`/api/jobs/${jobId}/application-packets`).set("Cookie", authCookie);

    const row = db
      .prepare("SELECT evidence_snapshot_json FROM application_packets WHERE job_row_id = ?")
      .get(jobId) as { evidence_snapshot_json: string };
    const snapshot = JSON.parse(row.evidence_snapshot_json);
    expect(snapshot.job_row.title).toBe("Software Engineer");
    expect(snapshot.resume_text).toContain("backend engineer");
    expect(snapshot.fit_analysis).not.toBeNull();
  });

  it("regeneration creates a second row rather than overwriting the first", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    await request(app).post(`/api/jobs/${jobId}/application-packets`).set("Cookie", authCookie);
    await request(app).post(`/api/jobs/${jobId}/application-packets`).set("Cookie", authCookie);

    const rows = db.prepare("SELECT * FROM application_packets WHERE job_row_id = ?").all(jobId);
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

    await request(app).post(`/api/jobs/${jobId}/application-packets`).set("Cookie", authCookie);

    expect(db.prepare("SELECT * FROM job_rows WHERE id = ?").get(jobId)).toEqual(beforeJobRow);
    expect(db.prepare("SELECT * FROM run_companies WHERE id = ?").get(companyId)).toEqual(
      beforeCompany
    );
    expect(db.prepare("SELECT * FROM runs WHERE id = ?").get(runId)).toEqual(beforeRun);
    expect(db.prepare("SELECT * FROM job_details WHERE job_row_id = ?").get(jobId)).toEqual(
      beforeDetail
    );
  });

  it("does not mutate profile/resume tables", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);
    insertMeaningfulProfile(authUserId);

    const beforeResume = db.prepare("SELECT * FROM resumes WHERE user_id = ?").get(authUserId);
    const beforeProfile = db
      .prepare("SELECT * FROM user_profiles WHERE user_id = ?")
      .get(authUserId);

    await request(app).post(`/api/jobs/${jobId}/application-packets`).set("Cookie", authCookie);

    expect(db.prepare("SELECT * FROM resumes WHERE user_id = ?").get(authUserId)).toEqual(
      beforeResume
    );
    expect(db.prepare("SELECT * FROM user_profiles WHERE user_id = ?").get(authUserId)).toEqual(
      beforeProfile
    );
  });

  it("does not mutate fit analysis rows", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);
    const analysisId = insertCompletedFitAnalysis(authUserId, jobId);
    const beforeAnalysis = db.prepare("SELECT * FROM job_fit_analyses WHERE id = ?").get(analysisId);

    await request(app).post(`/api/jobs/${jobId}/application-packets`).set("Cookie", authCookie);

    expect(db.prepare("SELECT * FROM job_fit_analyses WHERE id = ?").get(analysisId)).toEqual(
      beforeAnalysis
    );
  });
});

describe("GET /api/jobs/:jobRowId/application-packets", () => {
  it("returns 401 without a session", async () => {
    const res = await request(app).get(`/api/jobs/${randomUUID()}/application-packets`);
    expect(res.status).toBe(401);
  });

  it("returns [] when none exist for an owned job", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const res = await request(app)
      .get(`/api/jobs/${jobId}/application-packets`)
      .set("Cookie", authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns 404 for another user's job", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const res = await request(app)
      .get(`/api/jobs/${jobId}/application-packets`)
      .set("Cookie", otherCookie);
    expect(res.status).toBe(404);
  });

  it("returns owned packets newest first", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    await request(app).post(`/api/jobs/${jobId}/application-packets`).set("Cookie", authCookie);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await request(app).post(`/api/jobs/${jobId}/application-packets`).set("Cookie", authCookie);

    const res = await request(app)
      .get(`/api/jobs/${jobId}/application-packets`)
      .set("Cookie", authCookie);

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
    expect(res.body[0].created_at).toBeGreaterThanOrEqual(res.body[1].created_at);
  });
});

describe("GET /api/application-packets/:packetId", () => {
  it("returns 401 without a session", async () => {
    const res = await request(app).get(`/api/application-packets/${randomUUID()}`);
    expect(res.status).toBe(401);
  });

  it("returns the owned packet", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    const createRes = await request(app)
      .post(`/api/jobs/${jobId}/application-packets`)
      .set("Cookie", authCookie);
    const packetId = createRes.body.id as string;

    const res = await request(app)
      .get(`/api/application-packets/${packetId}`)
      .set("Cookie", authCookie);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(packetId);
  });

  it("returns 404 for another user's packet", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    const createRes = await request(app)
      .post(`/api/jobs/${jobId}/application-packets`)
      .set("Cookie", authCookie);
    const packetId = createRes.body.id as string;

    const res = await request(app)
      .get(`/api/application-packets/${packetId}`)
      .set("Cookie", otherCookie);

    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/application-packets/:packetId", () => {
  it("returns 401 without a session", async () => {
    const res = await request(app).delete(`/api/application-packets/${randomUUID()}`);
    expect(res.status).toBe(401);
  });

  it("deletes the owned packet", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    const createRes = await request(app)
      .post(`/api/jobs/${jobId}/application-packets`)
      .set("Cookie", authCookie);
    const packetId = createRes.body.id as string;

    const res = await request(app)
      .delete(`/api/application-packets/${packetId}`)
      .set("Cookie", authCookie);
    expect(res.status).toBe(200);

    const getRes = await request(app)
      .get(`/api/application-packets/${packetId}`)
      .set("Cookie", authCookie);
    expect(getRes.status).toBe(404);
  });

  it("returns 404 for another user's packet and does not delete it", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    const createRes = await request(app)
      .post(`/api/jobs/${jobId}/application-packets`)
      .set("Cookie", authCookie);
    const packetId = createRes.body.id as string;

    const res = await request(app)
      .delete(`/api/application-packets/${packetId}`)
      .set("Cookie", otherCookie);
    expect(res.status).toBe(404);

    const stillThere = db.prepare("SELECT * FROM application_packets WHERE id = ?").get(packetId);
    expect(stillThere).toBeDefined();
  });
});

describe("deleting profile/resume/fit-analysis does not delete existing packets", () => {
  it("keeps prior packets after resume deletion", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);

    await request(app).post(`/api/jobs/${jobId}/application-packets`).set("Cookie", authCookie);
    await request(app).delete("/api/resume").set("Cookie", authCookie);

    const res = await request(app)
      .get(`/api/jobs/${jobId}/application-packets`)
      .set("Cookie", authCookie);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
  });

  it("keeps prior packets after fit analysis deletion", async () => {
    mockLlmSuccess();
    const { runId, companyId, jobId } = insertMatchedJobFor(authUserId);
    insertJobDetailWithDescription(runId, companyId, jobId);
    insertResume(authUserId);
    const analysisId = insertCompletedFitAnalysis(authUserId, jobId);

    await request(app).post(`/api/jobs/${jobId}/application-packets`).set("Cookie", authCookie);
    await request(app).delete(`/api/fit-analyses/${analysisId}`).set("Cookie", authCookie);

    const res = await request(app)
      .get(`/api/jobs/${jobId}/application-packets`)
      .set("Cookie", authCookie);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].job_fit_analysis_id).toBe(analysisId);
  });
});
