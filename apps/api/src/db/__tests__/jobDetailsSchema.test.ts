/**
 * Gate 3 schema tests (agentReadiness.md Step 3.1): job_details table + indexes.
 *
 * Isolation: vitest.config.ts sets DB_PATH=:memory: so this worker gets a
 * fresh in-memory SQLite DB with the schema already applied by db.ts import.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../db.js";

describe("job_details schema", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const id of cleanup.splice(0)) {
      db.prepare("DELETE FROM job_details WHERE id = ?").run(id);
    }
  });

  it("job_details table exists and accepts a full row", () => {
    const id = randomUUID();
    cleanup.push(id);

    expect(() => {
      db.prepare(
        `INSERT INTO job_details
           (id, run_id, company_id, job_row_id, job_url, description_text, fetched_at, failure_code, failure_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        "https://boards.greenhouse.io/acme/1",
        "A description",
        Date.now(),
        null,
        null,
        Date.now()
      );
    }).not.toThrow();

    const row = db.prepare("SELECT * FROM job_details WHERE id = ?").get(id);
    expect(row).toBeDefined();
  });

  it("idx_job_details_run_id exists", () => {
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_job_details_run_id'`)
      .get();
    expect(idx).toBeDefined();
  });

  it("idx_job_details_company_id exists", () => {
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_job_details_company_id'`)
      .get();
    expect(idx).toBeDefined();
  });

  it("idx_job_details_job_row_id_unique exists and is unique", () => {
    const idx = db
      .prepare(`SELECT name, "unique" AS is_unique FROM pragma_index_list('job_details') WHERE name = 'idx_job_details_job_row_id_unique'`)
      .get() as { name: string; is_unique: number } | undefined;
    expect(idx).toBeDefined();
    expect(idx?.is_unique).toBe(1);
  });

  it("enforces uniqueness on job_row_id", () => {
    const jobRowId = randomUUID();
    const id1 = randomUUID();
    const id2 = randomUUID();
    cleanup.push(id1, id2);

    db.prepare(
      `INSERT INTO job_details
         (id, run_id, company_id, job_row_id, job_url, description_text, fetched_at, failure_code, failure_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id1, randomUUID(), randomUUID(), jobRowId, "https://example.com/1", "desc", Date.now(), null, null, Date.now());

    expect(() => {
      db.prepare(
        `INSERT INTO job_details
           (id, run_id, company_id, job_row_id, job_url, description_text, fetched_at, failure_code, failure_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id2, randomUUID(), randomUUID(), jobRowId, "https://example.com/1", "desc2", Date.now(), null, null, Date.now());
    }).toThrow();
  });
});
