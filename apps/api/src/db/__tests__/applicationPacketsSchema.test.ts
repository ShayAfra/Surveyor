/**
 * Milestone 4 (Application Packet Agent) schema tests:
 * application_packets table, its indexes, and ensureSchema idempotency.
 *
 * Isolation: vitest.config.ts sets DB_PATH=:memory: so this worker gets a
 * fresh in-memory SQLite DB with the schema already applied by db.ts import.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../db.js";
import { ensureSchema } from "../schema.js";

afterEach(() => {
  db.prepare("DELETE FROM application_packets").run();
  db.prepare("DELETE FROM users").run();
});

function insertUser(): string {
  const userId = randomUUID();
  db.prepare(
    `INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(userId, `${userId}@example.com`, "hash", "salt", Date.now());
  return userId;
}

describe("application_packets schema", () => {
  it("table exists with the required columns", () => {
    const userId = insertUser();
    const id = randomUUID();
    const now = Date.now();

    expect(() => {
      db.prepare(
        `INSERT INTO application_packets
          (id, user_id, job_row_id, job_fit_analysis_id, status, packet_summary, cover_letter_draft, positioning_notes_json, resume_bullet_suggestions_json, talking_points_json, questions_to_prepare_json, evidence_snapshot_json, model_name, failure_code, failure_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        userId,
        randomUUID(),
        randomUUID(),
        "COMPLETED",
        "Strong candidate for this role.",
        "Dear hiring manager, ...",
        "[]",
        "[]",
        "[]",
        "[]",
        "{}",
        "gpt-4o-mini",
        null,
        null,
        now
      );
    }).not.toThrow();

    const row = db.prepare("SELECT * FROM application_packets WHERE id = ?").get(id);
    expect(row).toBeDefined();
  });

  it("allows a FAILED row with null generated fields", () => {
    const userId = insertUser();
    const id = randomUUID();

    expect(() => {
      db.prepare(
        `INSERT INTO application_packets
          (id, user_id, job_row_id, job_fit_analysis_id, status, packet_summary, cover_letter_draft, positioning_notes_json, resume_bullet_suggestions_json, talking_points_json, questions_to_prepare_json, evidence_snapshot_json, model_name, failure_code, failure_reason, created_at)
         VALUES (?, ?, ?, NULL, 'FAILED', NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, 'APPLICATION_PACKET_LLM_FAILED', 'application packet LLM call failed', ?)`
      ).run(id, userId, randomUUID(), "{}", Date.now());
    }).not.toThrow();
  });

  it("allows a NULL job_fit_analysis_id (fit analysis is optional context)", () => {
    const userId = insertUser();
    const id = randomUUID();

    expect(() => {
      db.prepare(
        `INSERT INTO application_packets
          (id, user_id, job_row_id, job_fit_analysis_id, status, evidence_snapshot_json, created_at)
         VALUES (?, ?, ?, NULL, 'COMPLETED', '{}', ?)`
      ).run(id, userId, randomUUID(), Date.now());
    }).not.toThrow();

    const row = db.prepare("SELECT job_fit_analysis_id FROM application_packets WHERE id = ?").get(id) as {
      job_fit_analysis_id: string | null;
    };
    expect(row.job_fit_analysis_id).toBeNull();
  });

  it("allows multiple packets for the same job_row_id (regeneration creates new rows)", () => {
    const userId = insertUser();
    const jobRowId = randomUUID();
    const now = Date.now();

    expect(() => {
      db.prepare(
        `INSERT INTO application_packets (id, user_id, job_row_id, status, evidence_snapshot_json, created_at)
         VALUES (?, ?, ?, 'COMPLETED', '{}', ?)`
      ).run(randomUUID(), userId, jobRowId, now);
      db.prepare(
        `INSERT INTO application_packets (id, user_id, job_row_id, status, evidence_snapshot_json, created_at)
         VALUES (?, ?, ?, 'COMPLETED', '{}', ?)`
      ).run(randomUUID(), userId, jobRowId, now + 1);
    }).not.toThrow();

    const rows = db.prepare("SELECT * FROM application_packets WHERE job_row_id = ?").all(jobRowId);
    expect(rows.length).toBe(2);
  });

  it("idx_application_packets_user_id index exists", () => {
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_application_packets_user_id'`
      )
      .get();
    expect(idx).toBeDefined();
  });

  it("idx_application_packets_job_row_id index exists", () => {
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_application_packets_job_row_id'`
      )
      .get();
    expect(idx).toBeDefined();
  });
});

describe("scanner and prior-milestone tables are unchanged by Milestone 4", () => {
  it("runs table is untouched by application_packets columns", () => {
    const columns = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).toContain("status");
    expect(columnNames).not.toContain("application_packet_status");
  });

  it("run_companies table is untouched by application_packets columns", () => {
    const columns = db.prepare(`PRAGMA table_info(run_companies)`).all() as { name: string }[];
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).not.toContain("application_packet_status");
  });

  it("job_fit_analyses table is untouched by application_packets columns", () => {
    const columns = db.prepare(`PRAGMA table_info(job_fit_analyses)`).all() as { name: string }[];
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).not.toContain("application_packet_id");
  });

  it("resumes table is untouched by application_packets columns", () => {
    const columns = db.prepare(`PRAGMA table_info(resumes)`).all() as { name: string }[];
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).toEqual(["id", "user_id", "resume_text", "created_at", "updated_at"]);
  });
});

describe("ensureSchema idempotency with application_packets table", () => {
  it("can be called repeatedly without throwing", () => {
    expect(() => {
      ensureSchema(db);
      ensureSchema(db);
      ensureSchema(db);
    }).not.toThrow();
  });
});
