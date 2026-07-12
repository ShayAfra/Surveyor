/**
 * Milestone 2 (Profile and Resume Memory) schema tests: user_profiles,
 * user_profile_items, resumes tables, their indexes/uniqueness, and
 * ensureSchema idempotency.
 *
 * Isolation: vitest.config.ts sets DB_PATH=:memory: so this worker gets a
 * fresh in-memory SQLite DB with the schema already applied by db.ts import.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../db.js";
import { ensureSchema } from "../schema.js";

afterEach(() => {
  db.prepare("DELETE FROM resumes").run();
  db.prepare("DELETE FROM user_profile_items").run();
  db.prepare("DELETE FROM user_profiles").run();
  db.prepare("DELETE FROM users").run();
});

function insertUser(): string {
  const userId = randomUUID();
  db.prepare(
    `INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(userId, `${userId}@example.com`, "hash", "salt", Date.now());
  return userId;
}

describe("user_profiles schema", () => {
  it("table exists with the required columns", () => {
    const userId = insertUser();
    const id = randomUUID();
    const now = Date.now();

    expect(() => {
      db.prepare(
        `INSERT INTO user_profiles (id, user_id, full_name, location, years_experience, target_titles, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, userId, "Alice", "Remote", 5, "Engineer", "notes", now, now);
    }).not.toThrow();

    const row = db.prepare("SELECT * FROM user_profiles WHERE id = ?").get(id);
    expect(row).toBeDefined();
  });

  it("idx_user_profiles_user_id_unique enforces at most one profile per user", () => {
    const userId = insertUser();
    const now = Date.now();

    db.prepare(
      `INSERT INTO user_profiles (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)`
    ).run(randomUUID(), userId, now, now);

    expect(() => {
      db.prepare(
        `INSERT INTO user_profiles (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)`
      ).run(randomUUID(), userId, now, now);
    }).toThrow();
  });

  it("idx_user_profiles_user_id_unique index exists", () => {
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_user_profiles_user_id_unique'`
      )
      .get();
    expect(idx).toBeDefined();
  });
});

describe("user_profile_items schema", () => {
  it("table exists with the required columns", () => {
    const userId = insertUser();
    const id = randomUUID();
    const now = Date.now();

    expect(() => {
      db.prepare(
        `INSERT INTO user_profile_items (id, user_id, item_type, title, description, start_date, end_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, userId, "WORK_HISTORY", "Engineer at Acme", "Built things", "2020", "2022", now, now);
    }).not.toThrow();

    const row = db.prepare("SELECT * FROM user_profile_items WHERE id = ?").get(id);
    expect(row).toBeDefined();
  });

  it("allows multiple items of the same type for one user (no uniqueness constraint)", () => {
    const userId = insertUser();
    const now = Date.now();

    expect(() => {
      db.prepare(
        `INSERT INTO user_profile_items (id, user_id, item_type, title, created_at, updated_at)
         VALUES (?, ?, 'SKILL', 'TypeScript', ?, ?)`
      ).run(randomUUID(), userId, now, now);
      db.prepare(
        `INSERT INTO user_profile_items (id, user_id, item_type, title, created_at, updated_at)
         VALUES (?, ?, 'SKILL', 'SQLite', ?, ?)`
      ).run(randomUUID(), userId, now, now);
    }).not.toThrow();
  });

  it("idx_user_profile_items_user_id index exists", () => {
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_user_profile_items_user_id'`
      )
      .get();
    expect(idx).toBeDefined();
  });
});

describe("resumes schema", () => {
  it("table exists with the required columns", () => {
    const userId = insertUser();
    const id = randomUUID();
    const now = Date.now();

    expect(() => {
      db.prepare(
        `INSERT INTO resumes (id, user_id, resume_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
      ).run(id, userId, "Resume text.", now, now);
    }).not.toThrow();

    const row = db.prepare("SELECT * FROM resumes WHERE id = ?").get(id);
    expect(row).toBeDefined();
  });

  it("idx_resumes_user_id_unique enforces at most one resume per user", () => {
    const userId = insertUser();
    const now = Date.now();

    db.prepare(
      `INSERT INTO resumes (id, user_id, resume_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run(randomUUID(), userId, "First resume.", now, now);

    expect(() => {
      db.prepare(
        `INSERT INTO resumes (id, user_id, resume_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
      ).run(randomUUID(), userId, "Second resume.", now, now);
    }).toThrow();
  });

  it("idx_resumes_user_id_unique index exists", () => {
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_resumes_user_id_unique'`
      )
      .get();
    expect(idx).toBeDefined();
  });
});

describe("ensureSchema idempotency with profile/resume tables", () => {
  it("can be called repeatedly without throwing", () => {
    expect(() => {
      ensureSchema(db);
      ensureSchema(db);
      ensureSchema(db);
    }).not.toThrow();
  });
});
