/**
 * Milestone 7 (Application Tracking) endpoint tests:
 *   - POST   /api/jobs/:jobRowId/applications
 *   - GET    /api/jobs/:jobRowId/applications
 *   - GET    /api/applications
 *   - GET    /api/applications/:id
 *   - PUT    /api/applications/:id
 *   - DELETE /api/applications/:id
 *
 * Isolation: vitest.config.ts sets DB_PATH=:memory: so each test worker gets a
 * fresh in-memory SQLite DB. NODE_ENV=test prevents server.ts from starting
 * the worker loop or binding a port.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { app } from "../../server.js";
import { db } from "../../db/db.js";

let authCookie: string;
let authUserId: string;
let otherCookie: string;
let otherUserId: string;

function extractSessionCookie(res: request.Response): string {
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie as unknown as string];
  const sessionCookie = cookies.find((c) => c.startsWith("surveyor_session="));
  return (sessionCookie as string).split(";")[0];
}

beforeEach(async () => {
  const email = `applications-test-${randomUUID()}@example.com`;
  const res = await request(app).post("/api/auth/signup").send({ email, password: "password123" });
  authCookie = extractSessionCookie(res);
  authUserId = res.body.id as string;

  const otherEmail = `applications-other-${randomUUID()}@example.com`;
  const otherRes = await request(app)
    .post("/api/auth/signup")
    .send({ email: otherEmail, password: "password123" });
  otherCookie = extractSessionCookie(otherRes);
  otherUserId = otherRes.body.id as string;
});

afterEach(() => {
  db.prepare("DELETE FROM applications").run();
  db.prepare("DELETE FROM application_packets").run();
  db.prepare("DELETE FROM job_fit_analyses").run();
  db.prepare("DELETE FROM job_details").run();
  db.prepare("DELETE FROM trace_events").run();
  db.prepare("DELETE FROM job_rows").run();
  db.prepare("DELETE FROM run_companies").run();
  db.prepare("DELETE FROM runs").run();
  db.prepare("DELETE FROM saved_search_companies").run();
  db.prepare("DELETE FROM saved_searches").run();
  db.prepare("DELETE FROM monitoring_matches").run();
  db.prepare("DELETE FROM monitoring_executions").run();
  db.prepare("DELETE FROM sessions").run();
  db.prepare("DELETE FROM users").run();
});

function insertMatchedJobFor(
  userId: string,
  opts: { companyStatus?: string; url?: string; title?: string; location?: string | null } = {}
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
     VALUES (?, ?, ?, ?, ?, ?, 'Matched inclusion phrase Software Engineer')`
  ).run(
    jobId,
    runId,
    companyId,
    opts.title ?? "Software Engineer",
    opts.location === undefined ? "Remote" : opts.location,
    opts.url ?? "https://boards.greenhouse.io/acme/1"
  );

  return { runId, companyId, jobId };
}

function insertApplicationPacketFor(userId: string, jobRowId: string, status = "COMPLETED"): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO application_packets
      (id, user_id, job_row_id, job_fit_analysis_id, status, packet_summary, cover_letter_draft, positioning_notes_json, resume_bullet_suggestions_json, talking_points_json, questions_to_prepare_json, evidence_snapshot_json, model_name, failure_code, failure_reason, created_at)
     VALUES (?, ?, ?, NULL, ?, 'Summary', 'Cover letter', '[]', '[]', '[]', '[]', '{}', 'gpt-4o-mini', NULL, NULL, ?)`
  ).run(id, userId, jobRowId, status, Date.now());
  return id;
}

describe("POST /api/jobs/:jobRowId/applications", () => {
  it("returns 401 when unauthenticated", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const res = await request(app).post(`/api/jobs/${jobId}/applications`);
    expect(res.status).toBe(401);
  });

  it("creates an application for an owned matched job, defaulting status to SAVED", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const res = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", authCookie)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("SAVED");
    expect(res.body.job_row_id).toBe(jobId);
    expect(res.body.application_packet_id).toBeNull();
    expect(res.body.company_name).toBe("Acme");
    expect(res.body.job_title).toBe("Software Engineer");
    expect(res.body.job_url).toBe("https://boards.greenhouse.io/acme/1");
    expect(res.body.job_location).toBe("Remote");
    expect(res.body.user_id).toBeUndefined();
  });

  it("returns 404 for another user's job", async () => {
    const { jobId } = insertMatchedJobFor(otherUserId);
    const res = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", authCookie)
      .send({});
    expect(res.status).toBe(404);
  });

  it("returns 404 for a nonexistent job", async () => {
    const res = await request(app)
      .post(`/api/jobs/${randomUUID()}/applications`)
      .set("Cookie", authCookie)
      .send({});
    expect(res.status).toBe(404);
  });

  it("returns 409 when the job's company is not MATCHES_FOUND", async () => {
    const { jobId } = insertMatchedJobFor(authUserId, { companyStatus: "NO_MATCH_SCAN_COMPLETED" });
    const res = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", authCookie)
      .send({});
    expect(res.status).toBe(409);
  });

  it("creates an application without a packet", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const res = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", authCookie)
      .send({ status: "APPLIED" });
    expect(res.status).toBe(201);
    expect(res.body.application_packet_id).toBeNull();
  });

  it("creates an application with an owned packet for the same job", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const packetId = insertApplicationPacketFor(authUserId, jobId);
    const res = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", authCookie)
      .send({ application_packet_id: packetId });
    expect(res.status).toBe(201);
    expect(res.body.application_packet_id).toBe(packetId);
    expect(res.body.linked_packet).toMatchObject({ id: packetId, status: "COMPLETED" });
  });

  it("returns 404 when attaching another user's packet", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const { jobId: otherJobId } = insertMatchedJobFor(otherUserId);
    const otherPacketId = insertApplicationPacketFor(otherUserId, otherJobId);

    const res = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", authCookie)
      .send({ application_packet_id: otherPacketId });
    expect(res.status).toBe(404);
  });

  it("returns 400 when the packet belongs to a different job", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const { jobId: otherJobOwnedBySameUser } = insertMatchedJobFor(authUserId, {
      url: "https://boards.greenhouse.io/acme/2",
    });
    const mismatchedPacketId = insertApplicationPacketFor(authUserId, otherJobOwnedBySameUser);

    const res = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", authCookie)
      .send({ application_packet_id: mismatchedPacketId });
    expect(res.status).toBe(400);
  });

  it("returns 409 on duplicate (user_id, job_key)", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const first = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", authCookie)
      .send({});
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", authCookie)
      .send({});
    expect(second.status).toBe(409);
  });

  it("returns 409 when the same real job resurfaces under a different job_row_id (monitoring re-run simulation)", async () => {
    const url = "https://boards.greenhouse.io/acme/same-job";
    const { jobId: firstRunJobId } = insertMatchedJobFor(authUserId, { url });
    const first = await request(app)
      .post(`/api/jobs/${firstRunJobId}/applications`)
      .set("Cookie", authCookie)
      .send({});
    expect(first.status).toBe(201);

    // A second scanner run (e.g. a later monitoring execution) discovers the
    // same real job — same URL, same company/title/location — but persists
    // it under a brand new job_row_id.
    const { jobId: secondRunJobId } = insertMatchedJobFor(authUserId, { url });
    expect(secondRunJobId).not.toBe(firstRunJobId);

    const second = await request(app)
      .post(`/api/jobs/${secondRunJobId}/applications`)
      .set("Cookie", authCookie)
      .send({});
    expect(second.status).toBe(409);
  });

  it("snapshots job title/company/url/location at creation time", async () => {
    const { jobId } = insertMatchedJobFor(authUserId, {
      title: "Senior Backend Engineer",
      location: "New York, NY",
      url: "https://boards.greenhouse.io/acme/42",
    });
    const res = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", authCookie)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.company_name).toBe("Acme");
    expect(res.body.job_title).toBe("Senior Backend Engineer");
    expect(res.body.job_url).toBe("https://boards.greenhouse.io/acme/42");
    expect(res.body.job_location).toBe("New York, NY");
  });

  it("returns 400 for an invalid status", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const res = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", authCookie)
      .send({ status: "SUBMITTED_BY_ROBOT" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for malformed notes", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const res = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", authCookie)
      .send({ notes: 12345 });
    expect(res.status).toBe(400);
  });

  it("returns 400 for malformed dates", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const res = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", authCookie)
      .send({ applied_at: "not-a-number" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/jobs/:jobRowId/applications", () => {
  it("returns 401 when unauthenticated", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const res = await request(app).get(`/api/jobs/${jobId}/applications`);
    expect(res.status).toBe(401);
  });

  it("returns [] when no application is tracked yet", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const res = await request(app).get(`/api/jobs/${jobId}/applications`).set("Cookie", authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns 404 for a job row not owned by the caller", async () => {
    const { jobId } = insertMatchedJobFor(otherUserId);
    const res = await request(app).get(`/api/jobs/${jobId}/applications`).set("Cookie", authCookie);
    expect(res.status).toBe(404);
  });

  it("still finds the application via the exact same job_row_id (no regression)", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const created = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", authCookie)
      .send({});
    expect(created.status).toBe(201);

    const res = await request(app).get(`/api/jobs/${jobId}/applications`).set("Cookie", authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(created.body.id);
  });

  it("surfaces an existing application created from a different job_row_id with the same job_key (monitoring re-run)", async () => {
    const url = "https://boards.greenhouse.io/acme/same-job";
    const { jobId: jobRowIdA } = insertMatchedJobFor(authUserId, { url });
    const created = await request(app)
      .post(`/api/jobs/${jobRowIdA}/applications`)
      .set("Cookie", authCookie)
      .send({});
    expect(created.status).toBe(201);

    // A later scanner/monitoring run rediscovers the same real job (same
    // company/title/url) under a brand new job_row_id.
    const { jobId: jobRowIdB } = insertMatchedJobFor(authUserId, { url });
    expect(jobRowIdB).not.toBe(jobRowIdA);

    const res = await request(app)
      .get(`/api/jobs/${jobRowIdB}/applications`)
      .set("Cookie", authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(created.body.id);
    expect(res.body[0].job_row_id).toBe(jobRowIdA);
  });

  it("does not leak another user's application for the same job_key", async () => {
    const url = "https://boards.greenhouse.io/acme/shared-job-key";
    const { jobId: ownJobId } = insertMatchedJobFor(authUserId, { url });
    const { jobId: otherJobId } = insertMatchedJobFor(otherUserId, { url });

    await request(app)
      .post(`/api/jobs/${otherJobId}/applications`)
      .set("Cookie", otherCookie)
      .send({});

    const res = await request(app)
      .get(`/api/jobs/${ownJobId}/applications`)
      .set("Cookie", authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("POST still returns 409 for a duplicate job_key even when the GET-by-job_key fix is in place", async () => {
    const url = "https://boards.greenhouse.io/acme/dup-after-fix";
    const { jobId: jobRowIdA } = insertMatchedJobFor(authUserId, { url });
    await request(app).post(`/api/jobs/${jobRowIdA}/applications`).set("Cookie", authCookie).send({});

    const { jobId: jobRowIdB } = insertMatchedJobFor(authUserId, { url });
    const res = await request(app)
      .post(`/api/jobs/${jobRowIdB}/applications`)
      .set("Cookie", authCookie)
      .send({});
    expect(res.status).toBe(409);
  });
});

describe("GET /api/applications", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(app).get("/api/applications");
    expect(res.status).toBe(401);
  });

  it("lists only the caller's applications", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    await request(app).post(`/api/jobs/${jobId}/applications`).set("Cookie", authCookie).send({});

    const { jobId: otherJobId } = insertMatchedJobFor(otherUserId);
    await request(app)
      .post(`/api/jobs/${otherJobId}/applications`)
      .set("Cookie", otherCookie)
      .send({});

    const res = await request(app).get("/api/applications").set("Cookie", authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].job_row_id).toBe(jobId);
  });

  it("filters by status", async () => {
    const { jobId: job1 } = insertMatchedJobFor(authUserId, { url: "https://x.example/1" });
    const { jobId: job2 } = insertMatchedJobFor(authUserId, { url: "https://x.example/2" });
    await request(app)
      .post(`/api/jobs/${job1}/applications`)
      .set("Cookie", authCookie)
      .send({ status: "APPLIED" });
    await request(app).post(`/api/jobs/${job2}/applications`).set("Cookie", authCookie).send({});

    const res = await request(app)
      .get("/api/applications")
      .query({ status: "APPLIED" })
      .set("Cookie", authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].job_row_id).toBe(job1);
  });

  it("does not expose user_id", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    await request(app).post(`/api/jobs/${jobId}/applications`).set("Cookie", authCookie).send({});
    const res = await request(app).get("/api/applications").set("Cookie", authCookie);
    expect(res.body[0].user_id).toBeUndefined();
  });
});

describe("GET /api/applications/:id", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(app).get(`/api/applications/${randomUUID()}`);
    expect(res.status).toBe(401);
  });

  it("returns an owned application", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const created = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", authCookie)
      .send({});

    const res = await request(app)
      .get(`/api/applications/${created.body.id}`)
      .set("Cookie", authCookie);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
  });

  it("returns 404 for another user's application", async () => {
    const { jobId } = insertMatchedJobFor(otherUserId);
    const created = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", otherCookie)
      .send({});

    const res = await request(app)
      .get(`/api/applications/${created.body.id}`)
      .set("Cookie", authCookie);
    expect(res.status).toBe(404);
  });

  it("returns a null linked_packet when application_packet_id is null", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const created = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", authCookie)
      .send({});
    const res = await request(app)
      .get(`/api/applications/${created.body.id}`)
      .set("Cookie", authCookie);
    expect(res.body.linked_packet).toBeNull();
  });
});

describe("PUT /api/applications/:id", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(app).put(`/api/applications/${randomUUID()}`).send({});
    expect(res.status).toBe(401);
  });

  it("updates status, notes, applied_at, follow_up_at on an owned application", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const created = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", authCookie)
      .send({});

    const appliedAt = Date.now();
    const followUpAt = appliedAt + 7 * 24 * 60 * 60 * 1000;
    const res = await request(app)
      .put(`/api/applications/${created.body.id}`)
      .set("Cookie", authCookie)
      .send({ status: "APPLIED", notes: "Applied via referral", applied_at: appliedAt, follow_up_at: followUpAt });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("APPLIED");
    expect(res.body.notes).toBe("Applied via referral");
    expect(res.body.applied_at).toBe(appliedAt);
    expect(res.body.follow_up_at).toBe(followUpAt);
  });

  it("does not require applied_at to be set for status APPLIED", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const created = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", authCookie)
      .send({});

    const res = await request(app)
      .put(`/api/applications/${created.body.id}`)
      .set("Cookie", authCookie)
      .send({ status: "APPLIED" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("APPLIED");
    expect(res.body.applied_at).toBeNull();
  });

  it("returns 404 for another user's application", async () => {
    const { jobId } = insertMatchedJobFor(otherUserId);
    const created = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", otherCookie)
      .send({});

    const res = await request(app)
      .put(`/api/applications/${created.body.id}`)
      .set("Cookie", authCookie)
      .send({ status: "APPLIED" });
    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid status", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const created = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", authCookie)
      .send({});

    const res = await request(app)
      .put(`/api/applications/${created.body.id}`)
      .set("Cookie", authCookie)
      .send({ status: "GHOSTED" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for malformed notes or dates", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const created = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", authCookie)
      .send({});

    const badNotes = await request(app)
      .put(`/api/applications/${created.body.id}`)
      .set("Cookie", authCookie)
      .send({ notes: { nested: true } });
    expect(badNotes.status).toBe(400);

    const badDate = await request(app)
      .put(`/api/applications/${created.body.id}`)
      .set("Cookie", authCookie)
      .send({ follow_up_at: "next tuesday" });
    expect(badDate.status).toBe(400);
  });

  it("attaches a packet via application_packet_id, then detaches it with null", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const packetId = insertApplicationPacketFor(authUserId, jobId);
    const created = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", authCookie)
      .send({});

    const attach = await request(app)
      .put(`/api/applications/${created.body.id}`)
      .set("Cookie", authCookie)
      .send({ application_packet_id: packetId });
    expect(attach.status).toBe(200);
    expect(attach.body.application_packet_id).toBe(packetId);

    const detach = await request(app)
      .put(`/api/applications/${created.body.id}`)
      .set("Cookie", authCookie)
      .send({ application_packet_id: null });
    expect(detach.status).toBe(200);
    expect(detach.body.application_packet_id).toBeNull();
    expect(detach.body.linked_packet).toBeNull();
  });

  it("rejects attaching another user's packet on update", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const created = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", authCookie)
      .send({});

    const { jobId: otherJobId } = insertMatchedJobFor(otherUserId);
    const otherPacketId = insertApplicationPacketFor(otherUserId, otherJobId);

    const res = await request(app)
      .put(`/api/applications/${created.body.id}`)
      .set("Cookie", authCookie)
      .send({ application_packet_id: otherPacketId });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/applications/:id", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(app).delete(`/api/applications/${randomUUID()}`);
    expect(res.status).toBe(401);
  });

  it("hard-deletes an owned application without deleting scanner/job/packet rows", async () => {
    const { jobId, runId, companyId } = insertMatchedJobFor(authUserId);
    const packetId = insertApplicationPacketFor(authUserId, jobId);
    const created = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", authCookie)
      .send({ application_packet_id: packetId });

    const res = await request(app)
      .delete(`/api/applications/${created.body.id}`)
      .set("Cookie", authCookie);
    expect(res.status).toBe(200);

    const getAfter = await request(app)
      .get(`/api/applications/${created.body.id}`)
      .set("Cookie", authCookie);
    expect(getAfter.status).toBe(404);

    // Scanner and packet rows survive the application delete.
    const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
    const company = db.prepare("SELECT * FROM run_companies WHERE id = ?").get(companyId);
    const jobRow = db.prepare("SELECT * FROM job_rows WHERE id = ?").get(jobId);
    const packet = db.prepare("SELECT * FROM application_packets WHERE id = ?").get(packetId);
    expect(run).toBeDefined();
    expect(company).toBeDefined();
    expect(jobRow).toBeDefined();
    expect(packet).toBeDefined();
  });

  it("returns 404 for another user's application and does not delete it", async () => {
    const { jobId } = insertMatchedJobFor(otherUserId);
    const created = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", otherCookie)
      .send({});

    const res = await request(app)
      .delete(`/api/applications/${created.body.id}`)
      .set("Cookie", authCookie);
    expect(res.status).toBe(404);

    const stillThere = db.prepare("SELECT * FROM applications WHERE id = ?").get(created.body.id);
    expect(stillThere).toBeDefined();
  });
});

describe("packet deletion nulls application_packet_id without deleting the application", () => {
  it("nulls application_packet_id on referencing applications when the packet is deleted", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const packetId = insertApplicationPacketFor(authUserId, jobId);
    const created = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", authCookie)
      .send({ application_packet_id: packetId });
    expect(created.body.application_packet_id).toBe(packetId);

    const deletePacket = await request(app)
      .delete(`/api/application-packets/${packetId}`)
      .set("Cookie", authCookie);
    expect(deletePacket.status).toBe(200);

    const res = await request(app)
      .get(`/api/applications/${created.body.id}`)
      .set("Cookie", authCookie);
    expect(res.status).toBe(200);
    expect(res.body.application_packet_id).toBeNull();
    expect(res.body.linked_packet).toBeNull();
  });
});

describe("deleting a saved search or monitoring history does not delete applications", () => {
  it("survives saved search deletion", async () => {
    const { jobId } = insertMatchedJobFor(authUserId);
    const created = await request(app)
      .post(`/api/jobs/${jobId}/applications`)
      .set("Cookie", authCookie)
      .send({});

    const savedSearch = await request(app)
      .post("/api/saved-searches")
      .set("Cookie", authCookie)
      .send({
        name: "Backend roles",
        role_raw: "backend engineer",
        include_adjacent: false,
        companies: [{ company_name: "Acme" }],
      });
    expect(savedSearch.status).toBe(201);

    const deleteSearch = await request(app)
      .delete(`/api/saved-searches/${savedSearch.body.id}`)
      .set("Cookie", authCookie);
    expect(deleteSearch.status).toBe(200);

    const res = await request(app)
      .get(`/api/applications/${created.body.id}`)
      .set("Cookie", authCookie);
    expect(res.status).toBe(200);
  });
});
