/**
 * Milestone 3 (Job Fit and Job Understanding Layer) schema tests:
 * job_fit_analyses table, its indexes, and ensureSchema idempotency.
 *
 * Isolation: vitest.config.ts sets DB_PATH=:memory: so this worker gets a
 * fresh in-memory SQLite DB with the schema already applied by db.ts import.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../db.js";
import { ensureSchema } from "../schema.js";

afterEach(() => {
  db.prepare("DELETE FROM job_fit_analyses").run();
  db.prepare("DELETE FROM users").run();
});

function insertUser(): string {
  const userId = randomUUID();
  db.prepare(
    `INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(userId, `${userId}@example.com`, "hash", "salt", Date.now());
  return userId;
}

describe("job_fit_analyses schema", () => {
  it("table exists with the required columns", () => {
    const userId = insertUser();
    const id = randomUUID();
    const now = Date.now();

    expect(() => {
      db.prepare(
        `INSERT INTO job_fit_analyses
          (id, user_id, job_row_id, status, fit_summary, strengths_json, gaps_json, risks_json, suggested_next_steps_json, evidence_snapshot_json, model_name, failure_code, failure_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        userId,
        randomUUID(),
        "COMPLETED",
        "Strong fit overall.",
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

    const row = db.prepare("SELECT * FROM job_fit_analyses WHERE id = ?").get(id);
    expect(row).toBeDefined();
  });

  it("allows a FAILED row with null analysis fields", () => {
    const userId = insertUser();
    const id = randomUUID();

    expect(() => {
      db.prepare(
        `INSERT INTO job_fit_analyses
          (id, user_id, job_row_id, status, fit_summary, strengths_json, gaps_json, risks_json, suggested_next_steps_json, evidence_snapshot_json, model_name, failure_code, failure_reason, created_at)
         VALUES (?, ?, ?, 'FAILED', NULL, NULL, NULL, NULL, NULL, ?, NULL, 'FIT_ANALYSIS_LLM_FAILED', 'fit analysis LLM call failed', ?)`
      ).run(id, userId, randomUUID(), "{}", Date.now());
    }).not.toThrow();
  });

  it("allows multiple analyses for the same job_row_id (regeneration creates new rows)", () => {
    const userId = insertUser();
    const jobRowId = randomUUID();
    const now = Date.now();

    expect(() => {
      db.prepare(
        `INSERT INTO job_fit_analyses (id, user_id, job_row_id, status, evidence_snapshot_json, created_at)
         VALUES (?, ?, ?, 'COMPLETED', '{}', ?)`
      ).run(randomUUID(), userId, jobRowId, now);
      db.prepare(
        `INSERT INTO job_fit_analyses (id, user_id, job_row_id, status, evidence_snapshot_json, created_at)
         VALUES (?, ?, ?, 'COMPLETED', '{}', ?)`
      ).run(randomUUID(), userId, jobRowId, now + 1);
    }).not.toThrow();

    const rows = db
      .prepare("SELECT * FROM job_fit_analyses WHERE job_row_id = ?")
      .all(jobRowId);
    expect(rows.length).toBe(2);
  });

  it("idx_job_fit_analyses_user_id index exists", () => {
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_job_fit_analyses_user_id'`
      )
      .get();
    expect(idx).toBeDefined();
  });

  it("idx_job_fit_analyses_job_row_id index exists", () => {
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_job_fit_analyses_job_row_id'`
      )
      .get();
    expect(idx).toBeDefined();
  });
});

describe("scanner status enums are unchanged by Milestone 3", () => {
  it("runs table still only permits scanner-managed status values via application logic (schema does not enumerate CHECK constraints, so this asserts the columns are untouched)", () => {
    const columns = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).toContain("status");
    expect(columnNames).not.toContain("fit_analysis_status");
  });

  it("run_companies table is untouched by job_fit_analyses columns", () => {
    const columns = db.prepare(`PRAGMA table_info(run_companies)`).all() as { name: string }[];
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).not.toContain("fit_analysis_status");
  });
});

describe("ensureSchema idempotency with job_fit_analyses table", () => {
  it("can be called repeatedly without throwing", () => {
    expect(() => {
      ensureSchema(db);
      ensureSchema(db);
      ensureSchema(db);
    }).not.toThrow();
  });
});
