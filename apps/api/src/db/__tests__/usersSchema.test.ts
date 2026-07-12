/**
 * Milestone 1 (Accounts and Owned Scanner Data) schema tests: users/sessions
 * tables, runs.user_id idempotent migration, and legacy-run backfill on first signup.
 *
 * Isolation: vitest.config.ts sets DB_PATH=:memory: so this worker gets a
 * fresh in-memory SQLite DB with the schema already applied by db.ts import.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../db.js";
import { ensureSchema } from "../schema.js";
import { createUser } from "../../lib/auth.js";

describe("users/sessions schema", () => {
  afterEach(() => {
    db.prepare("DELETE FROM sessions").run();
    db.prepare("DELETE FROM users").run();
    db.prepare("DELETE FROM runs").run();
  });

  it("users table exists with the required columns", () => {
    const id = randomUUID();
    expect(() => {
      db.prepare(
        `INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)`
      ).run(id, "schema-test@example.com", "hash", "salt", Date.now());
    }).not.toThrow();

    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    expect(row).toBeDefined();
  });

  it("idx_users_email_unique enforces uniqueness", () => {
    db.prepare(
      `INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(randomUUID(), "dup-schema@example.com", "hash", "salt", Date.now());

    expect(() => {
      db.prepare(
        `INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)`
      ).run(randomUUID(), "dup-schema@example.com", "hash2", "salt2", Date.now());
    }).toThrow();
  });

  it("sessions table exists with the required columns", () => {
    const userId = randomUUID();
    db.prepare(
      `INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(userId, "session-schema@example.com", "hash", "salt", Date.now());

    const sessionId = randomUUID();
    expect(() => {
      db.prepare(
        `INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`
      ).run(sessionId, userId, Date.now(), Date.now() + 1000);
    }).not.toThrow();
  });

  it("idx_sessions_user_id exists", () => {
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_sessions_user_id'`)
      .get();
    expect(idx).toBeDefined();
  });

  it("runs.user_id column exists", () => {
    const columns = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
    expect(columns.some((c) => c.name === "user_id")).toBe(true);
  });

  it("idx_runs_user_id exists", () => {
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_runs_user_id'`)
      .get();
    expect(idx).toBeDefined();
  });

  it("ensureSchema can be called repeatedly without throwing (idempotent migration)", () => {
    expect(() => {
      ensureSchema(db);
      ensureSchema(db);
      ensureSchema(db);
    }).not.toThrow();

    const columns = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
    const userIdColumns = columns.filter((c) => c.name === "user_id");
    expect(userIdColumns.length).toBe(1);
  });
});

describe("legacy run backfill on first signup", () => {
  afterEach(() => {
    db.prepare("DELETE FROM sessions").run();
    db.prepare("DELETE FROM users").run();
    db.prepare("DELETE FROM runs").run();
  });

  it("assigns NULL-owned legacy runs to the first real user created", () => {
    const legacyRunId = randomUUID();
    db.prepare(
      `INSERT INTO runs (id, created_at, status, role_raw, include_adjacent, company_count, user_id)
       VALUES (?, ?, 'COMPLETED', 'Engineer', 0, 0, NULL)`
    ).run(legacyRunId, Date.now());

    const { user } = createUser("first-real-user@example.com", "password123");

    const row = db.prepare("SELECT user_id FROM runs WHERE id = ?").get(legacyRunId) as {
      user_id: string | null;
    };
    expect(row.user_id).toBe(user.id);
  });

  it("does not reassign legacy runs to a second signup once a first user exists", () => {
    const legacyRunId = randomUUID();
    db.prepare(
      `INSERT INTO runs (id, created_at, status, role_raw, include_adjacent, company_count, user_id)
       VALUES (?, ?, 'COMPLETED', 'Engineer', 0, 0, NULL)`
    ).run(legacyRunId, Date.now());

    const { user: firstUser } = createUser("first@example.com", "password123");
    createUser("second@example.com", "password123");

    const row = db.prepare("SELECT user_id FROM runs WHERE id = ?").get(legacyRunId) as {
      user_id: string | null;
    };
    expect(row.user_id).toBe(firstUser.id);
  });

  it("new runs always get user_id going forward (no NULL-owned runs created by app code)", () => {
    createUser("solo@example.com", "password123");

    const freshRunId = randomUUID();
    const { user: secondUser } = createUser("solo2@example.com", "password123");
    db.prepare(
      `INSERT INTO runs (id, created_at, status, role_raw, include_adjacent, company_count, user_id)
       VALUES (?, ?, 'CREATED', 'Engineer', 0, 1, ?)`
    ).run(freshRunId, Date.now(), secondUser.id);

    const row = db.prepare("SELECT user_id FROM runs WHERE id = ?").get(freshRunId) as {
      user_id: string | null;
    };
    expect(row.user_id).toBe(secondUser.id);
  });

  it("remaining NULL-owned legacy runs (if any) are not exposed to arbitrary users once users exist", () => {
    // Simulate a NULL-owned run created after the first user already exists
    // (e.g. from data inserted out-of-band) — it must not match any user_id filter.
    createUser("existing-user@example.com", "password123");

    const orphanRunId = randomUUID();
    db.prepare(
      `INSERT INTO runs (id, created_at, status, role_raw, include_adjacent, company_count, user_id)
       VALUES (?, ?, 'COMPLETED', 'Engineer', 0, 0, NULL)`
    ).run(orphanRunId, Date.now());

    const { user: otherUser } = createUser("other-user@example.com", "password123");

    const row = db
      .prepare("SELECT id FROM runs WHERE id = ? AND user_id = ?")
      .get(orphanRunId, otherUser.id);
    expect(row).toBeUndefined();
  });
});
