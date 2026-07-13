import { randomUUID } from "node:crypto";
import { CompanyStatus, RunStatus } from "@surveyor/shared";
import { db } from "../db/db.js";

/** Thrown for request validation problems that must not create a run row. */
export class CreateRunRequestError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string
  ) {
    super(message);
  }
}

export interface CreateRunForUserInput {
  userId: string;
  role: unknown;
  includeAdjacent: unknown;
  companies: unknown;
}

export interface CreateRunForUserResult {
  runId: string;
}

/**
 * Validates and durably creates a run + run_companies rows for userId. This is
 * the single implementation shared by POST /api/runs and
 * POST /api/saved-searches/:id/runs so both preserve identical validation and
 * insert behavior. Never starts scanner work: role_spec_json stays null, no
 * company is marked IN_PROGRESS, and no LLM call happens here.
 */
export function createRunForUser(input: CreateRunForUserInput): CreateRunForUserResult {
  const { userId, role, includeAdjacent, companies } = input;

  if (typeof role !== "string") {
    throw new CreateRunRequestError(400, "role must be a string");
  }

  if (typeof includeAdjacent !== "boolean") {
    throw new CreateRunRequestError(400, "includeAdjacent must be a boolean");
  }

  if (!Array.isArray(companies)) {
    throw new CreateRunRequestError(400, "companies must be an array");
  }

  const trimmedRole = role.trim();
  if (trimmedRole.length === 0) {
    throw new CreateRunRequestError(400, "role must be non-empty after trimming");
  }

  if (companies.length < 1 || companies.length > 10) {
    throw new CreateRunRequestError(400, "companies must contain between 1 and 10 entries");
  }

  const trimmedCompanies: string[] = [];
  for (const company of companies) {
    if (typeof company !== "string") {
      throw new CreateRunRequestError(400, "each company must be a string");
    }

    const trimmedCompany = company.trim();
    if (trimmedCompany.length === 0) {
      throw new CreateRunRequestError(400, "company entries must be non-empty after trimming");
    }

    trimmedCompanies.push(trimmedCompany);
  }

  const runId = randomUUID();
  const nowMs = Date.now();

  const insertRun = db.prepare(`
    INSERT INTO runs (
      id,
      created_at,
      status,
      role_raw,
      include_adjacent,
      role_spec_json,
      role_spec_started_at,
      company_count,
      error_code,
      error_message,
      user_id
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?)
  `);

  const insertCompany = db.prepare(`
    INSERT INTO run_companies (
      id,
      run_id,
      company_name,
      input_index,
      status,
      created_at,
      started_at,
      finished_at,
      worker_token,
      careers_url,
      ats_type,
      extractor_used,
      listings_scanned,
      pages_visited,
      failure_code,
      failure_reason
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
  `);

  const createRunTx = db.transaction(() => {
    insertRun.run(
      runId,
      nowMs,
      RunStatus.CREATED,
      role,
      includeAdjacent ? 1 : 0,
      trimmedCompanies.length,
      userId
    );

    for (let index = 0; index < trimmedCompanies.length; index += 1) {
      insertCompany.run(
        randomUUID(),
        runId,
        trimmedCompanies[index],
        index,
        CompanyStatus.PENDING,
        nowMs
      );
    }
  });

  createRunTx();

  return { runId };
}
