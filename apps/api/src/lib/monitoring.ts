import { randomUUID } from "node:crypto";
import type {
  MonitoringConfigResponse,
  MonitoringExecutionResponse,
  MonitoringMatchResponse,
} from "@surveyor/shared";
import { CompanyStatus, MonitoringExecutionStatus, RunStatus } from "@surveyor/shared";
import { db } from "../db/db.js";
import {
  CreateRunRequestError,
  insertCreatedRunForUser,
  validateRunCreationInput,
} from "./runs.js";
import { getOwnedSavedSearchRow, type SavedSearchRow } from "./savedSearches.js";

/** Thrown for monitoring request problems that must not create/update a row. */
export class MonitoringRequestError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string
  ) {
    super(message);
  }
}

interface MonitoringExecutionRow {
  id: string;
  saved_search_id: string;
  user_id: string;
  run_id: string;
  status: MonitoringExecutionStatus;
  new_match_count: number;
  started_at: number;
  finished_at: number | null;
}

interface MonitoringMatchRow {
  id: string;
  saved_search_id: string;
  user_id: string;
  job_key: string;
  company_name: string;
  title: string;
  location: string | null;
  job_url: string;
  first_seen_run_id: string;
  first_seen_execution_id: string;
  first_seen_at: number;
  last_seen_run_id: string;
  last_seen_execution_id: string;
  last_seen_at: number;
  seen_count: number;
}

function toMonitoringExecutionResponse(row: MonitoringExecutionRow): MonitoringExecutionResponse {
  return {
    id: row.id,
    run_id: row.run_id,
    status: row.status,
    new_match_count: row.new_match_count,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

function toMonitoringMatchResponse(row: MonitoringMatchRow): MonitoringMatchResponse {
  return {
    id: row.id,
    job_key: row.job_key,
    company_name: row.company_name,
    title: row.title,
    location: row.location,
    job_url: row.job_url,
    first_seen_run_id: row.first_seen_run_id,
    last_seen_run_id: row.last_seen_run_id,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    seen_count: row.seen_count,
  };
}

/** Returns the owned saved search row, or throws MonitoringRequestError(404). */
function requireOwnedSavedSearchRow(userId: string, savedSearchId: string): SavedSearchRow {
  const row = getOwnedSavedSearchRow(userId, savedSearchId);
  if (!row) {
    throw new MonitoringRequestError(404, "saved search not found");
  }
  return row;
}

export function getMonitoringConfig(userId: string, savedSearchId: string): MonitoringConfigResponse {
  const row = requireOwnedSavedSearchRow(userId, savedSearchId);
  return {
    enabled: row.monitoring_enabled === 1,
    last_checked_at: row.monitoring_last_checked_at,
  };
}

export function setMonitoringEnabled(
  userId: string,
  savedSearchId: string,
  enabled: boolean
): MonitoringConfigResponse {
  requireOwnedSavedSearchRow(userId, savedSearchId);

  db.prepare(
    `UPDATE saved_searches SET monitoring_enabled = ? WHERE id = ? AND user_id = ?`
  ).run(enabled ? 1 : 0, savedSearchId, userId);

  return getMonitoringConfig(userId, savedSearchId);
}

function getActiveExecution(savedSearchId: string): MonitoringExecutionRow | undefined {
  return db
    .prepare(
      `SELECT * FROM monitoring_executions WHERE saved_search_id = ? AND status = ? LIMIT 1`
    )
    .get(savedSearchId, MonitoringExecutionStatus.RUNNING) as MonitoringExecutionRow | undefined;
}

/** Thrown inside the monitoring trigger transaction to force a rollback when an execution raced in. */
class ActiveExecutionRaceError extends Error {}

/**
 * Creates a normal scanner run from a saved search's current snapshot and
 * records a monitoring execution row linked to it, atomically (Blocker 4):
 * the owned-search check, the active-execution guard, the scanner run
 * insert (runs + run_companies, via the same validateRunCreationInput +
 * insertCreatedRunForUser path createRunForUser uses - so validation and
 * insert behavior are identical to POST /api/runs), the
 * monitoring_executions insert, and the monitoring_last_checked_at update
 * all commit together in one transaction. If any step fails - including the
 * monitoring_executions insert - the scanner run and run_companies rows roll
 * back with it, so a monitoring trigger never leaves an unlinked scanner run
 * behind. Never processes scanner work inline: no LLM call, role_spec_json
 * stays null, no company is marked IN_PROGRESS. Shared by the automatic loop
 * and the manual run-now endpoint so both enforce the same
 * one-active-execution-per-search guard and produce identical history.
 * Throws MonitoringRequestError(404) if not owned, MonitoringRequestError(409)
 * if an execution is already RUNNING.
 */
export function triggerMonitoringExecution(
  userId: string,
  savedSearchId: string
): { execution: MonitoringExecutionResponse; runId: string } {
  const savedSearch = requireOwnedSavedSearchRow(userId, savedSearchId);

  // Validate outside the transaction: validation never touches the
  // database, so failures here throw before anything is written.
  const companies = (
    db
      .prepare(
        `SELECT company_name FROM saved_search_companies WHERE saved_search_id = ? ORDER BY input_index ASC`
      )
      .all(savedSearchId) as { company_name: string }[]
  ).map((row) => row.company_name);

  let validated;
  try {
    validated = validateRunCreationInput({
      userId,
      role: savedSearch.role_raw,
      includeAdjacent: savedSearch.include_adjacent === 1,
      companies,
    });
  } catch (err) {
    if (err instanceof CreateRunRequestError) {
      throw new MonitoringRequestError(err.httpStatus, err.message);
    }
    throw err;
  }

  const executionId = randomUUID();

  const tx = db.transaction(() => {
    // Re-check the active-execution guard inside the transaction so a
    // concurrent trigger cannot race past it between the earlier check and
    // this write.
    if (getActiveExecution(savedSearchId)) {
      throw new ActiveExecutionRaceError();
    }

    const { runId } = insertCreatedRunForUser(validated);

    const now = Date.now();
    db.prepare(
      `INSERT INTO monitoring_executions (id, saved_search_id, user_id, run_id, status, new_match_count, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, NULL)`
    ).run(executionId, savedSearchId, userId, runId, MonitoringExecutionStatus.RUNNING, now);

    db.prepare(`UPDATE saved_searches SET monitoring_last_checked_at = ? WHERE id = ?`).run(
      now,
      savedSearchId
    );

    return runId;
  });

  let runId: string;
  try {
    runId = tx();
  } catch (err) {
    if (err instanceof ActiveExecutionRaceError) {
      throw new MonitoringRequestError(
        409,
        "a monitoring execution is already active for this saved search"
      );
    }
    throw err;
  }

  const executionRow = db
    .prepare(`SELECT * FROM monitoring_executions WHERE id = ?`)
    .get(executionId) as MonitoringExecutionRow;

  return { execution: toMonitoringExecutionResponse(executionRow), runId };
}

export function listMonitoringExecutions(
  userId: string,
  savedSearchId: string
): MonitoringExecutionResponse[] {
  requireOwnedSavedSearchRow(userId, savedSearchId);

  const rows = db
    .prepare(
      `SELECT * FROM monitoring_executions WHERE saved_search_id = ? AND user_id = ? ORDER BY started_at DESC`
    )
    .all(savedSearchId, userId) as MonitoringExecutionRow[];

  return rows.map(toMonitoringExecutionResponse);
}

export function listMonitoringMatches(
  userId: string,
  savedSearchId: string
): MonitoringMatchResponse[] {
  requireOwnedSavedSearchRow(userId, savedSearchId);

  const rows = db
    .prepare(
      `SELECT * FROM monitoring_matches WHERE saved_search_id = ? AND user_id = ? ORDER BY last_seen_at DESC`
    )
    .all(savedSearchId, userId) as MonitoringMatchRow[];

  return rows.map(toMonitoringMatchResponse);
}

// ---- Job identity / URL normalization -------------------------------------------------

/**
 * Conservative job identity key: normalized URL when parseable, otherwise a
 * fallback of company_name + normalized title + normalized location. Kept
 * intentionally simple - this is a dedupe key, not a canonicalization system.
 */
export function computeJobKey(input: {
  companyName: string;
  title: string;
  location: string | null;
  url: string;
}): string {
  const normalizedUrl = normalizeJobUrl(input.url);
  if (normalizedUrl) {
    return `url:${normalizedUrl}`;
  }
  return `fallback:${normalizeText(input.companyName)}|${normalizeText(input.title)}|${normalizeText(input.location ?? "")}`;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Returns a normalized URL key for a valid, parseable URL, or null when the
 * URL is empty or unparseable - callers must fall back to the
 * company/title/location key in that case, never to the lowercased raw
 * string (an invalid URL is not a stable identity).
 */
function normalizeJobUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    const host = parsed.host.toLowerCase();
    let pathname = parsed.pathname;
    if (pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }
    return `${protocol}//${host}${pathname}`;
  } catch {
    return null;
  }
}

// ---- New match detection ----------------------------------------------------------------

interface MatchCandidate {
  jobKey: string;
  companyName: string;
  title: string;
  location: string | null;
  url: string;
}

/**
 * Reads job_rows for companies whose run_companies.status is MATCHES_FOUND
 * under the given run only. UNVERIFIED and NO_MATCH_SCAN_COMPLETED companies
 * never contribute candidates - this mirrors scanner finalization exactly,
 * it does not reinterpret it. Read-only: does not fetch job pages, does not
 * call job_details, does not call the LLM.
 */
function collectMatchCandidatesForRun(runId: string): MatchCandidate[] {
  const rows = db
    .prepare(
      `SELECT job_rows.company_id AS company_id, job_rows.title AS title, job_rows.location AS location,
              job_rows.url AS url, run_companies.company_name AS company_name
       FROM job_rows
       JOIN run_companies ON run_companies.id = job_rows.company_id
       WHERE job_rows.run_id = ? AND run_companies.status = ?`
    )
    .all(runId, CompanyStatus.MATCHES_FOUND) as {
    company_id: string;
    title: string;
    location: string | null;
    url: string;
    company_name: string;
  }[];

  const seen = new Map<string, MatchCandidate>();
  for (const row of rows) {
    const jobKey = computeJobKey({
      companyName: row.company_name,
      title: row.title,
      location: row.location,
      url: row.url,
    });
    // Dedupe within this run before comparing to stored monitoring_matches.
    if (!seen.has(jobKey)) {
      seen.set(jobKey, {
        jobKey,
        companyName: row.company_name,
        title: row.title,
        location: row.location,
        url: row.url,
      });
    }
  }
  return [...seen.values()];
}

/**
 * Applies match candidates from a completed run to the monitoring_matches
 * ledger for one saved search/execution. First sighting of a job_key inserts
 * a row and counts as new; later sightings only bump last_seen fields and
 * seen_count. Returns the number of newly discovered matches for this
 * execution. Does not open its own transaction or query time itself - callers
 * run this inside their own transaction and pass a single `now` so ledger
 * writes and the execution's terminal update commit together.
 */
function applyMatchCandidates(
  savedSearchId: string,
  userId: string,
  runId: string,
  executionId: string,
  candidates: MatchCandidate[],
  now: number
): number {
  const findExisting = db.prepare(
    `SELECT id FROM monitoring_matches WHERE saved_search_id = ? AND job_key = ?`
  );
  const insertMatch = db.prepare(
    `INSERT INTO monitoring_matches (
       id, saved_search_id, user_id, job_key, company_name, title, location, job_url,
       first_seen_run_id, first_seen_execution_id, first_seen_at,
       last_seen_run_id, last_seen_execution_id, last_seen_at, seen_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
  );
  const updateMatch = db.prepare(
    `UPDATE monitoring_matches
     SET last_seen_run_id = ?, last_seen_execution_id = ?, last_seen_at = ?, seen_count = seen_count + 1
     WHERE saved_search_id = ? AND job_key = ?`
  );

  let newMatchCount = 0;

  for (const candidate of candidates) {
    const existing = findExisting.get(savedSearchId, candidate.jobKey) as { id: string } | undefined;
    if (existing) {
      updateMatch.run(runId, executionId, now, savedSearchId, candidate.jobKey);
    } else {
      insertMatch.run(
        randomUUID(),
        savedSearchId,
        userId,
        candidate.jobKey,
        candidate.companyName,
        candidate.title,
        candidate.location,
        candidate.url,
        runId,
        executionId,
        now,
        runId,
        executionId,
        now
      );
      newMatchCount += 1;
    }
  }

  return newMatchCount;
}

// ---- Reconciliation ------------------------------------------------------------------

interface RunStatusRow {
  status: RunStatus;
}

const completeMonitoringExecutionIfRunning = db.prepare(
  `UPDATE monitoring_executions SET status = ?, finished_at = ?, new_match_count = ? WHERE id = ? AND status = ?`
);

const failMonitoringExecutionIfRunning = db.prepare(
  `UPDATE monitoring_executions SET status = ?, finished_at = ? WHERE id = ? AND status = ?`
);

/**
 * Reconciles one RUNNING monitoring_execution against its linked scanner
 * run's current status. For a COMPLETED run, match-ledger writes and the
 * execution's terminal COMPLETED update happen inside a single transaction
 * (Blocker 1): if the process crashes mid-way, the whole transaction rolls
 * back and the execution is simply reconciled again on the next tick,
 * instead of replaying match writes against an execution that already
 * recorded them. The terminal UPDATE is guarded by
 * `WHERE id = ? AND status = 'RUNNING'` and only committed if it affects
 * exactly one row, so a concurrently-completed execution (e.g. reconciled by
 * an overlapping tick) is left untouched rather than double-counted. Never
 * mutates runs/run_companies/job_rows - only reads scanner state.
 */
function reconcileOneMonitoringExecution(execution: MonitoringExecutionRow): void {
  const runRow = db.prepare(`SELECT status FROM runs WHERE id = ?`).get(execution.run_id) as
    | RunStatusRow
    | undefined;
  if (!runRow) {
    return;
  }

  if (runRow.status === RunStatus.COMPLETED) {
    // Read-only candidate collection may happen outside the transaction; it
    // does not mutate any table.
    const candidates = collectMatchCandidatesForRun(execution.run_id);
    const now = Date.now();

    const tx = db.transaction(() => {
      const newMatchCount = applyMatchCandidates(
        execution.saved_search_id,
        execution.user_id,
        execution.run_id,
        execution.id,
        candidates,
        now
      );

      const result = completeMonitoringExecutionIfRunning.run(
        MonitoringExecutionStatus.COMPLETED,
        now,
        newMatchCount,
        execution.id,
        MonitoringExecutionStatus.RUNNING
      );

      if (result.changes !== 1) {
        // Execution is no longer RUNNING (already reconciled elsewhere) -
        // roll back so the match-ledger writes above never commit.
        throw new Error("monitoring execution is no longer RUNNING; skipping reconciliation");
      }
    });

    tx();
  } else if (runRow.status === RunStatus.FAILED_ROLE_SPEC) {
    failMonitoringExecutionIfRunning.run(
      MonitoringExecutionStatus.FAILED,
      Date.now(),
      execution.id,
      MonitoringExecutionStatus.RUNNING
    );
  }
  // CREATED/READY/RUNNING: leave the execution RUNNING.
}

/**
 * Phase 1 of the monitoring tick: for every RUNNING monitoring_execution,
 * reconciles it against its linked scanner run's current status (see
 * reconcileOneMonitoringExecution for the atomicity guarantee). Each
 * execution is reconciled independently and failures are isolated
 * (Blocker 2): one malformed row or database error while reconciling one
 * execution is caught and logged, and does not prevent the remaining active
 * executions - or Phase 2 due-search processing - from running.
 */
export function reconcileActiveMonitoringExecutions(): void {
  const activeExecutions = db
    .prepare(`SELECT * FROM monitoring_executions WHERE status = ?`)
    .all(MonitoringExecutionStatus.RUNNING) as MonitoringExecutionRow[];

  for (const execution of activeExecutions) {
    try {
      reconcileOneMonitoringExecution(execution);
    } catch (err) {
      console.warn(
        `monitoring: failed to reconcile execution ${execution.id} (run ${execution.run_id}):`,
        err
      );
    }
  }
}

// ---- Due-search selection (loop phase 2) ----------------------------------------------

interface DueSavedSearchRow {
  id: string;
  user_id: string;
}

/**
 * Finds saved searches with monitoring_enabled = 1 that are due (never
 * checked, or last checked more than fixedIntervalMs ago) and have no active
 * (RUNNING) monitoring execution. Used only by the automatic loop - run-now
 * bypasses the enabled/due check but still shares the same active-execution
 * guard via triggerMonitoringExecution.
 */
export function findDueMonitoringSavedSearches(fixedIntervalMs: number): DueSavedSearchRow[] {
  const cutoff = Date.now() - fixedIntervalMs;
  return db
    .prepare(
      `SELECT id, user_id FROM saved_searches
       WHERE monitoring_enabled = 1
         AND (monitoring_last_checked_at IS NULL OR monitoring_last_checked_at < ?)
         AND NOT EXISTS (
           SELECT 1 FROM monitoring_executions
           WHERE monitoring_executions.saved_search_id = saved_searches.id
             AND monitoring_executions.status = ?
         )`
    )
    .all(cutoff, MonitoringExecutionStatus.RUNNING) as DueSavedSearchRow[];
}
