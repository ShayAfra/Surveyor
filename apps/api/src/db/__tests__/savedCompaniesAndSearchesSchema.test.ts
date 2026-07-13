/**
 * Milestone 5 (Saved Companies and Saved Searches) schema tests:
 * saved_companies, saved_searches, saved_search_companies tables, their
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
  db.prepare("DELETE FROM saved_search_companies").run();
  db.prepare("DELETE FROM saved_searches").run();
  db.prepare("DELETE FROM saved_companies").run();
  db.prepare("DELETE FROM users").run();
});

function insertUser(): string {
  const userId = randomUUID();
  db.prepare(
    `INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(userId, `${userId}@example.com`, "hash", "salt", Date.now());
  return userId;
}

describe("saved_companies schema", () => {
  it("table exists with the required columns", () => {
    const userId = insertUser();
    const id = randomUUID();
    const now = Date.now();

    expect(() => {
      db.prepare(
        `INSERT INTO saved_companies (id, user_id, company_name, company_url, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(id, userId, "Acme Corp", "https://acme.example", "Great culture", now, now);
    }).not.toThrow();

    const row = db.prepare("SELECT * FROM saved_companies WHERE id = ?").get(id);
    expect(row).toBeDefined();
  });

  it("allows null company_url and notes", () => {
    const userId = insertUser();
    const id = randomUUID();
    const now = Date.now();

    expect(() => {
      db.prepare(
        `INSERT INTO saved_companies (id, user_id, company_name, company_url, notes, created_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, ?, ?)`
      ).run(id, userId, "Acme Corp", now, now);
    }).not.toThrow();
  });

  it("idx_saved_companies_user_id index exists", () => {
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_saved_companies_user_id'`
      )
      .get();
    expect(idx).toBeDefined();
  });
});

describe("saved_searches schema", () => {
  it("table exists with the required columns", () => {
    const userId = insertUser();
    const id = randomUUID();
    const now = Date.now();

    expect(() => {
      db.prepare(
        `INSERT INTO saved_searches (id, user_id, name, role_raw, include_adjacent, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, userId, "Backend roles", "backend engineer", 1, "quarterly check", now, now);
    }).not.toThrow();

    const row = db.prepare("SELECT * FROM saved_searches WHERE id = ?").get(id);
    expect(row).toBeDefined();
  });

  it("allows null notes", () => {
    const userId = insertUser();
    const id = randomUUID();
    const now = Date.now();

    expect(() => {
      db.prepare(
        `INSERT INTO saved_searches (id, user_id, name, role_raw, include_adjacent, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
      ).run(id, userId, "Backend roles", "backend engineer", 0, now, now);
    }).not.toThrow();
  });

  it("idx_saved_searches_user_id index exists", () => {
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_saved_searches_user_id'`
      )
      .get();
    expect(idx).toBeDefined();
  });
});

describe("saved_search_companies schema", () => {
  it("table exists with the required columns", () => {
    const userId = insertUser();
    const savedSearchId = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO saved_searches (id, user_id, name, role_raw, include_adjacent, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
    ).run(savedSearchId, userId, "Backend roles", "backend engineer", 1, now, now);

    const id = randomUUID();
    expect(() => {
      db.prepare(
        `INSERT INTO saved_search_companies (id, saved_search_id, saved_company_id, company_name, input_index, created_at)
         VALUES (?, ?, NULL, ?, ?, ?)`
      ).run(id, savedSearchId, "Acme Corp", 0, now);
    }).not.toThrow();

    const row = db.prepare("SELECT * FROM saved_search_companies WHERE id = ?").get(id);
    expect(row).toBeDefined();
  });

  it("allows a non-null saved_company_id link", () => {
    const userId = insertUser();
    const savedCompanyId = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO saved_companies (id, user_id, company_name, company_url, notes, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?)`
    ).run(savedCompanyId, userId, "Acme Corp", now, now);

    const savedSearchId = randomUUID();
    db.prepare(
      `INSERT INTO saved_searches (id, user_id, name, role_raw, include_adjacent, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
    ).run(savedSearchId, userId, "Backend roles", "backend engineer", 1, now, now);

    const id = randomUUID();
    expect(() => {
      db.prepare(
        `INSERT INTO saved_search_companies (id, saved_search_id, saved_company_id, company_name, input_index, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(id, savedSearchId, savedCompanyId, "Acme Corp", 0, now);
    }).not.toThrow();
  });

  it("idx_saved_search_companies_saved_search_id_input_index index exists", () => {
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_saved_search_companies_saved_search_id_input_index'`
      )
      .get();
    expect(idx).toBeDefined();
  });

  it("idx_saved_search_companies_saved_company_id index exists", () => {
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_saved_search_companies_saved_company_id'`
      )
      .get();
    expect(idx).toBeDefined();
  });
});

describe("no monitoring/scheduling/tracking/referral tables were added", () => {
  it("saved_searches has no scheduling columns", () => {
    const columns = db.prepare(`PRAGMA table_info(saved_searches)`).all() as { name: string }[];
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).not.toContain("enabled");
    expect(columnNames).not.toContain("frequency");
    expect(columnNames).not.toContain("last_run_at");
    expect(columnNames).not.toContain("next_run_at");
  });

  it("no saved_search_runs table exists", () => {
    const table = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'saved_search_runs'`
      )
      .get();
    expect(table).toBeUndefined();
  });

  it("no application tracking / referral / recruiter tables exist", () => {
    const names = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).not.toContain("applications");
    expect(names).not.toContain("referrals");
    expect(names).not.toContain("recruiters");
    expect(names).not.toContain("notifications");
  });
});

describe("scanner and prior-milestone tables are unchanged by Milestone 5", () => {
  it("runs table is untouched by saved-search columns", () => {
    const columns = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).not.toContain("saved_search_id");
  });

  it("run_companies table is untouched by saved-search columns", () => {
    const columns = db.prepare(`PRAGMA table_info(run_companies)`).all() as { name: string }[];
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).not.toContain("saved_search_company_id");
  });
});

describe("ensureSchema idempotency with saved_companies/saved_searches tables", () => {
  it("can be called repeatedly without throwing", () => {
    expect(() => {
      ensureSchema(db);
      ensureSchema(db);
      ensureSchema(db);
    }).not.toThrow();
  });
});
