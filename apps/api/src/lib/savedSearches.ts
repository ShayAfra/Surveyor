import { randomUUID } from "node:crypto";
import type { SavedSearchCompanyResponse, SavedSearchResponse } from "@surveyor/shared";
import { db } from "../db/db.js";
import { CreateRunRequestError, createRunForUser } from "./runs.js";

/** Thrown for saved-search request validation problems that must not create/update a row. */
export class SavedSearchRequestError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string
  ) {
    super(message);
  }
}

interface SavedSearchRow {
  id: string;
  user_id: string;
  name: string;
  role_raw: string;
  include_adjacent: number;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

interface SavedSearchCompanyRow {
  id: string;
  saved_search_id: string;
  saved_company_id: string | null;
  company_name: string;
  input_index: number;
  created_at: number;
}

function toSavedSearchCompanyResponse(row: SavedSearchCompanyRow): SavedSearchCompanyResponse {
  return {
    id: row.id,
    saved_company_id: row.saved_company_id,
    company_name: row.company_name,
    input_index: row.input_index,
  };
}

function getSavedSearchCompanyRows(savedSearchId: string): SavedSearchCompanyRow[] {
  return db
    .prepare(
      `SELECT * FROM saved_search_companies WHERE saved_search_id = ? ORDER BY input_index ASC`
    )
    .all(savedSearchId) as SavedSearchCompanyRow[];
}

function toSavedSearchResponse(row: SavedSearchRow): SavedSearchResponse {
  return {
    id: row.id,
    name: row.name,
    role_raw: row.role_raw,
    include_adjacent: row.include_adjacent === 1,
    notes: row.notes,
    companies: getSavedSearchCompanyRows(row.id).map(toSavedSearchCompanyResponse),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listSavedSearches(userId: string): SavedSearchResponse[] {
  const rows = db
    .prepare(`SELECT * FROM saved_searches WHERE user_id = ? ORDER BY created_at DESC`)
    .all(userId) as SavedSearchRow[];
  return rows.map(toSavedSearchResponse);
}

export function getOwnedSavedSearchRow(
  userId: string,
  savedSearchId: string
): SavedSearchRow | undefined {
  return db
    .prepare(`SELECT * FROM saved_searches WHERE id = ? AND user_id = ?`)
    .get(savedSearchId, userId) as SavedSearchRow | undefined;
}

export function getOwnedSavedSearch(
  userId: string,
  savedSearchId: string
): SavedSearchResponse | undefined {
  const row = getOwnedSavedSearchRow(userId, savedSearchId);
  return row ? toSavedSearchResponse(row) : undefined;
}

export interface SavedSearchCompanyInput {
  company_name: string;
  saved_company_id: string | null;
}

export interface SavedSearchInput {
  name: string;
  role_raw: string;
  include_adjacent: boolean;
  notes: string | null;
  companies: SavedSearchCompanyInput[];
}

/**
 * Parses+validates the raw request body into a SavedSearchInput. Mirrors the
 * POST /api/runs validation rules for role_raw/companies (non-empty after
 * trim, 1-10 entries, no silent drops, order preserved) plus saved-search-only
 * fields (name, notes, optional saved_company_id per entry). Does not touch
 * the database. Throws SavedSearchRequestError on any violation.
 */
export function parseSavedSearchInput(
  userId: string,
  body: Record<string, unknown>
): SavedSearchInput {
  if (typeof body.name !== "string") {
    throw new SavedSearchRequestError(400, "name must be a string");
  }
  const trimmedName = body.name.trim();
  if (trimmedName.length === 0) {
    throw new SavedSearchRequestError(400, "name must be non-empty after trimming");
  }

  if (typeof body.role_raw !== "string") {
    throw new SavedSearchRequestError(400, "role_raw must be a string");
  }
  const trimmedRole = body.role_raw.trim();
  if (trimmedRole.length === 0) {
    throw new SavedSearchRequestError(400, "role_raw must be non-empty after trimming");
  }

  if (typeof body.include_adjacent !== "boolean") {
    throw new SavedSearchRequestError(400, "include_adjacent must be a boolean");
  }

  if (
    body.notes !== undefined &&
    body.notes !== null &&
    typeof body.notes !== "string"
  ) {
    throw new SavedSearchRequestError(400, "notes must be null or a string");
  }
  const trimmedNotes =
    typeof body.notes === "string" && body.notes.trim().length > 0 ? body.notes.trim() : null;

  if (!Array.isArray(body.companies)) {
    throw new SavedSearchRequestError(400, "companies must be an array");
  }

  if (body.companies.length < 1 || body.companies.length > 10) {
    throw new SavedSearchRequestError(400, "companies must contain between 1 and 10 entries");
  }

  const companies: SavedSearchCompanyInput[] = [];
  for (const entry of body.companies) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new SavedSearchRequestError(400, "each company entry must be an object");
    }
    const o = entry as Record<string, unknown>;

    if (typeof o.company_name !== "string") {
      throw new SavedSearchRequestError(400, "each company_name must be a string");
    }
    const trimmedCompanyName = o.company_name.trim();
    if (trimmedCompanyName.length === 0) {
      throw new SavedSearchRequestError(
        400,
        "company_name entries must be non-empty after trimming"
      );
    }

    let savedCompanyId: string | null = null;
    if (o.saved_company_id !== undefined && o.saved_company_id !== null) {
      if (typeof o.saved_company_id !== "string") {
        throw new SavedSearchRequestError(400, "saved_company_id must be null or a string");
      }
      const owned = db
        .prepare(`SELECT id FROM saved_companies WHERE id = ? AND user_id = ?`)
        .get(o.saved_company_id, userId);
      if (!owned) {
        throw new SavedSearchRequestError(
          400,
          "saved_company_id must reference a saved company owned by the current user"
        );
      }
      savedCompanyId = o.saved_company_id;
    }

    companies.push({ company_name: trimmedCompanyName, saved_company_id: savedCompanyId });
  }

  return {
    name: trimmedName,
    role_raw: trimmedRole,
    include_adjacent: body.include_adjacent,
    notes: trimmedNotes,
    companies,
  };
}

function insertSavedSearchCompanies(savedSearchId: string, companies: SavedSearchCompanyInput[]): void {
  const insertCompany = db.prepare(
    `INSERT INTO saved_search_companies (id, saved_search_id, saved_company_id, company_name, input_index, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const now = Date.now();
  for (let index = 0; index < companies.length; index += 1) {
    insertCompany.run(
      randomUUID(),
      savedSearchId,
      companies[index].saved_company_id,
      companies[index].company_name,
      index,
      now
    );
  }
}

export function createSavedSearch(userId: string, input: SavedSearchInput): SavedSearchResponse {
  const id = randomUUID();
  const now = Date.now();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO saved_searches (id, user_id, name, role_raw, include_adjacent, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, userId, input.name, input.role_raw, input.include_adjacent ? 1 : 0, input.notes, now, now);

    insertSavedSearchCompanies(id, input.companies);
  });
  tx();

  return toSavedSearchResponse(
    db.prepare(`SELECT * FROM saved_searches WHERE id = ?`).get(id) as SavedSearchRow
  );
}

/**
 * Replaces an owned saved search's fields and its full saved_search_companies
 * set in one transaction (delete + reinsert, preserving order via
 * input_index). Returns undefined if not found/not owned.
 */
export function updateSavedSearch(
  userId: string,
  savedSearchId: string,
  input: SavedSearchInput
): SavedSearchResponse | undefined {
  const existing = getOwnedSavedSearchRow(userId, savedSearchId);
  if (!existing) {
    return undefined;
  }

  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE saved_searches
       SET name = ?, role_raw = ?, include_adjacent = ?, notes = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`
    ).run(
      input.name,
      input.role_raw,
      input.include_adjacent ? 1 : 0,
      input.notes,
      now,
      savedSearchId,
      userId
    );

    db.prepare(`DELETE FROM saved_search_companies WHERE saved_search_id = ?`).run(savedSearchId);
    insertSavedSearchCompanies(savedSearchId, input.companies);
  });
  tx();

  return toSavedSearchResponse(
    db.prepare(`SELECT * FROM saved_searches WHERE id = ?`).get(savedSearchId) as SavedSearchRow
  );
}

/**
 * Hard-deletes an owned saved search and its saved_search_companies rows in
 * one transaction (no DB-level cascade in this schema). Never touches past
 * runs/run_companies created from this saved search - those are independent
 * snapshots. Returns true if a saved search was actually deleted.
 */
export function deleteSavedSearch(userId: string, savedSearchId: string): boolean {
  const existing = getOwnedSavedSearchRow(userId, savedSearchId);
  if (!existing) {
    return false;
  }

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM saved_search_companies WHERE saved_search_id = ?`).run(savedSearchId);
    db.prepare(`DELETE FROM saved_searches WHERE id = ? AND user_id = ?`).run(
      savedSearchId,
      userId
    );
  });
  tx();

  return true;
}

/**
 * Starts a normal scanner run from an owned saved search's current
 * role_raw/include_adjacent/ordered companies (a point-in-time snapshot; later
 * edits to the saved search never retroactively change past runs). Delegates
 * to createRunForUser, the same helper POST /api/runs uses, so this creates
 * durable CREATED/PENDING run state only - it does not call the LLM, does not
 * touch role_spec_json, and does not start scanner processing. Throws
 * SavedSearchRequestError(404) if not found/not owned.
 */
export function startRunFromSavedSearch(userId: string, savedSearchId: string): { runId: string } {
  const savedSearch = getOwnedSavedSearchRow(userId, savedSearchId);
  if (!savedSearch) {
    throw new SavedSearchRequestError(404, "saved search not found");
  }

  const companies = getSavedSearchCompanyRows(savedSearchId).map((row) => row.company_name);

  try {
    return createRunForUser({
      userId,
      role: savedSearch.role_raw,
      includeAdjacent: savedSearch.include_adjacent === 1,
      companies,
    });
  } catch (err) {
    if (err instanceof CreateRunRequestError) {
      throw new SavedSearchRequestError(err.httpStatus, err.message);
    }
    throw err;
  }
}
