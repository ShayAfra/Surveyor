/**
 * Milestone 7 (Application Tracking) schema tests: applications table, its
 * indexes, and ensureSchema idempotency.
 *
 * Isolation: vitest.config.ts sets DB_PATH=:memory: so this worker gets a
 * fresh in-memory SQLite DB with the schema already applied by db.ts import.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../db.js";
import { ensureSchema } from "../schema.js";

afterEach(() => {
  db.prepare("DELETE FROM applications").run();
  db.prepare("DELETE FROM application_packets").run();
  db.prepare("DELETE FROM job_rows").run();
  db.prepare("DELETE FROM run_companies").run();
  db.prepare("DELETE FROM runs").run();
  db.prepare("DELETE FROM users").run();
});

function insertUser(): string {
  const userId = randomUUID();
  db.prepare(
    `INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(userId, `${userId}@example.com`, "hash", "salt", Date.now());
  return userId;
}

function insertMatchedJobRow(userId: string): { runId: string; companyId: string; jobRowId: string } {
  const runId = randomUUID();
  const companyId = randomUUID();
  const jobRowId = randomUUID();
  const now = Date.now();

  db.prepare(
    `INSERT INTO runs (id, created_at, status, role_raw, include_adjacent, company_count, user_id)
     VALUES (?, ?, 'COMPLETED', 'Software Engineer', 0, 1, ?)`
  ).run(runId, now, userId);

  db.prepare(
    `INSERT INTO run_companies (id, run_id, company_name, input_index, status, created_at)
     VALUES (?, ?, 'Acme', 0, 'MATCHES_FOUND', ?)`
  ).run(companyId, runId, now);

  db.prepare(
    `INSERT INTO job_rows (id, run_id, company_id, title, location, url, match_reason)
     VALUES (?, ?, ?, 'Software Engineer', 'Remote', 'https://boards.greenhouse.io/acme/1', 'Matched inclusion phrase')`
  ).run(jobRowId, runId, companyId);

  return { runId, companyId, jobRowId };
}

describe("applications schema", () => {
  it("table exists with the required columns", () => {
    const userId = insertUser();
    const { jobRowId } = insertMatchedJobRow(userId);
    const id = randomUUID();
    const now = Date.now();

    expect(() => {
      db.prepare(
        `INSERT INTO applications
          (id, user_id, job_row_id, application_packet_id, status, job_key, company_name, job_title, job_url, job_location, notes, applied_at, follow_up_at, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'SAVED', 'url:https://boards.greenhouse.io/acme/1', 'Acme', 'Software Engineer', 'https://boards.greenhouse.io/acme/1', 'Remote', 'looks good', NULL, NULL, ?, ?)`
      ).run(id, userId, jobRowId, now, now);
    }).not.toThrow();

    const row = db.prepare("SELECT * FROM applications WHERE id = ?").get(id);
    expect(row).toBeDefined();
  });

  it("allows null application_packet_id, job_location, notes, applied_at, follow_up_at", () => {
    const userId = insertUser();
    const { jobRowId } = insertMatchedJobRow(userId);
    const id = randomUUID();
    const now = Date.now();

    expect(() => {
      db.prepare(
        `INSERT INTO applications
          (id, user_id, job_row_id, application_packet_id, status, job_key, company_name, job_title, job_url, job_location, notes, applied_at, follow_up_at, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'SAVED', 'url:https://boards.greenhouse.io/acme/2', 'Acme', 'Software Engineer', 'https://boards.greenhouse.io/acme/2', NULL, NULL, NULL, NULL, ?, ?)`
      ).run(id, userId, jobRowId, now, now);
    }).not.toThrow();
  });

  it("idx_applications_user_id index exists", () => {
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_applications_user_id'`)
      .get();
    expect(idx).toBeDefined();
  });

  it("idx_applications_job_row_id index exists", () => {
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_applications_job_row_id'`
      )
      .get();
    expect(idx).toBeDefined();
  });

  it("idx_applications_application_packet_id index exists", () => {
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_applications_application_packet_id'`
      )
      .get();
    expect(idx).toBeDefined();
  });

  it("has a unique index on user_id + job_key", () => {
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_applications_user_id_job_key_unique'`
      )
      .get();
    expect(idx).toBeDefined();
  });

  it("rejects a duplicate (user_id, job_key) insert at the DB level", () => {
    const userId = insertUser();
    const { jobRowId } = insertMatchedJobRow(userId);
    const now = Date.now();

    db.prepare(
      `INSERT INTO applications
        (id, user_id, job_row_id, application_packet_id, status, job_key, company_name, job_title, job_url, job_location, notes, applied_at, follow_up_at, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'SAVED', 'url:https://boards.greenhouse.io/acme/dup', 'Acme', 'Software Engineer', 'https://boards.greenhouse.io/acme/dup', 'Remote', NULL, NULL, NULL, ?, ?)`
    ).run(randomUUID(), userId, jobRowId, now, now);

    expect(() => {
      db.prepare(
        `INSERT INTO applications
          (id, user_id, job_row_id, application_packet_id, status, job_key, company_name, job_title, job_url, job_location, notes, applied_at, follow_up_at, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'SAVED', 'url:https://boards.greenhouse.io/acme/dup', 'Acme', 'Software Engineer', 'https://boards.greenhouse.io/acme/dup', 'Remote', NULL, NULL, NULL, ?, ?)`
      ).run(randomUUID(), userId, jobRowId, now, now);
    }).toThrow();
  });
});

describe("applications table does not affect scanner tables", () => {
  it("runs table is untouched by application-tracking columns", () => {
    const columns = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
    expect(columns.map((c) => c.name)).not.toContain("application_id");
  });

  it("run_companies table is untouched by application-tracking columns", () => {
    const columns = db.prepare(`PRAGMA table_info(run_companies)`).all() as { name: string }[];
    expect(columns.map((c) => c.name)).not.toContain("application_id");
  });

  it("job_rows table is untouched by application-tracking columns", () => {
    const columns = db.prepare(`PRAGMA table_info(job_rows)`).all() as { name: string }[];
    expect(columns.map((c) => c.name)).not.toContain("application_id");
  });

  it("job_details table is untouched by application-tracking columns", () => {
    const columns = db.prepare(`PRAGMA table_info(job_details)`).all() as { name: string }[];
    expect(columns.map((c) => c.name)).not.toContain("application_id");
  });
});

describe("no recruiter/referral/contact/browser-automation/notification tables were added", () => {
  it("only the expected applications table was added", () => {
    const names = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toContain("applications");
    expect(names).not.toContain("referrals");
    expect(names).not.toContain("recruiters");
    expect(names).not.toContain("contacts");
    expect(names).not.toContain("notifications");
    expect(names).not.toContain("notification_events");
    expect(names).not.toContain("browser_sessions");
    expect(names).not.toContain("browser_automation");
    expect(names).not.toContain("interview_schedules");
  });
});

describe("ensureSchema idempotency with applications table", () => {
  it("can be called repeatedly without throwing", () => {
    expect(() => {
      ensureSchema(db);
      ensureSchema(db);
      ensureSchema(db);
    }).not.toThrow();
  });
});
