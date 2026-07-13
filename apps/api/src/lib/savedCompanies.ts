import { randomUUID } from "node:crypto";
import type { SavedCompanyResponse } from "@surveyor/shared";
import { db } from "../db/db.js";

/** Trims a string field; returns null for undefined/null/empty-after-trim. */
export function trimToNullable(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

interface SavedCompanyRow {
  id: string;
  user_id: string;
  company_name: string;
  company_url: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

function toSavedCompanyResponse(row: SavedCompanyRow): SavedCompanyResponse {
  return {
    id: row.id,
    company_name: row.company_name,
    company_url: row.company_url,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listSavedCompanies(userId: string): SavedCompanyResponse[] {
  const rows = db
    .prepare(`SELECT * FROM saved_companies WHERE user_id = ? ORDER BY created_at DESC`)
    .all(userId) as SavedCompanyRow[];
  return rows.map(toSavedCompanyResponse);
}

export function getOwnedSavedCompanyRow(
  userId: string,
  savedCompanyId: string
): SavedCompanyRow | undefined {
  return db
    .prepare(`SELECT * FROM saved_companies WHERE id = ? AND user_id = ?`)
    .get(savedCompanyId, userId) as SavedCompanyRow | undefined;
}

export function getOwnedSavedCompany(
  userId: string,
  savedCompanyId: string
): SavedCompanyResponse | undefined {
  const row = getOwnedSavedCompanyRow(userId, savedCompanyId);
  return row ? toSavedCompanyResponse(row) : undefined;
}

export interface SavedCompanyInput {
  company_name: string;
  company_url: string | null;
  notes: string | null;
}

export function createSavedCompany(
  userId: string,
  input: SavedCompanyInput
): SavedCompanyResponse {
  const id = randomUUID();
  const now = Date.now();

  db.prepare(
    `INSERT INTO saved_companies (id, user_id, company_name, company_url, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, userId, input.company_name, input.company_url, input.notes, now, now);

  return toSavedCompanyResponse(
    db.prepare(`SELECT * FROM saved_companies WHERE id = ?`).get(id) as SavedCompanyRow
  );
}

export function updateSavedCompany(
  userId: string,
  savedCompanyId: string,
  input: SavedCompanyInput
): SavedCompanyResponse | undefined {
  const existing = getOwnedSavedCompanyRow(userId, savedCompanyId);
  if (!existing) {
    return undefined;
  }

  const now = Date.now();
  db.prepare(
    `UPDATE saved_companies
     SET company_name = ?, company_url = ?, notes = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(input.company_name, input.company_url, input.notes, now, savedCompanyId, userId);

  return toSavedCompanyResponse(
    db.prepare(`SELECT * FROM saved_companies WHERE id = ?`).get(savedCompanyId) as SavedCompanyRow
  );
}

/**
 * Hard-deletes an owned saved company. In the same transaction, nulls out
 * saved_search_companies.saved_company_id for any rows that referenced it
 * (there is no DB-level FK/ON DELETE SET NULL in this schema, so this is done
 * in application code). saved_search_companies.company_name is left intact,
 * preserving the snapshot the referencing saved search relies on.
 * Returns true if a saved company was actually deleted.
 */
export function deleteSavedCompany(userId: string, savedCompanyId: string): boolean {
  const existing = getOwnedSavedCompanyRow(userId, savedCompanyId);
  if (!existing) {
    return false;
  }

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM saved_companies WHERE id = ? AND user_id = ?`).run(
      savedCompanyId,
      userId
    );
    db.prepare(
      `UPDATE saved_search_companies SET saved_company_id = NULL WHERE saved_company_id = ?`
    ).run(savedCompanyId);
  });
  tx();

  return true;
}
