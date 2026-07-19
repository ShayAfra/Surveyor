import { randomUUID } from "node:crypto";
import { ApplicationTrackingStatus } from "@surveyor/shared";
import type { ApplicationLinkedPacketSummary, ApplicationResponse } from "@surveyor/shared";
import { db } from "../db/db.js";
import { computeJobKey } from "./jobIdentity.js";

/** Thrown for request/ownership/validation problems that must not create or mutate an applications row. */
export class ApplicationRequestError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string
  ) {
    super(message);
  }
}

const VALID_STATUSES: readonly string[] = Object.values(ApplicationTrackingStatus);

interface JobRowRecord {
  id: string;
  run_id: string;
  company_id: string;
  title: string;
  location: string | null;
  url: string;
}

interface RunCompanyStatusRecord {
  status: string;
}

interface ApplicationPacketOwnershipRecord {
  id: string;
  job_row_id: string;
  status: string;
  created_at: number;
}

interface ApplicationRow {
  id: string;
  user_id: string;
  job_row_id: string;
  application_packet_id: string | null;
  status: string;
  job_key: string;
  company_name: string;
  job_title: string;
  job_url: string;
  job_location: string | null;
  notes: string | null;
  applied_at: number | null;
  follow_up_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Fetches the job_row only if it belongs (via run_id) to userId. Undefined otherwise. */
function getOwnedJobRow(userId: string, jobRowId: string): JobRowRecord | undefined {
  return db
    .prepare(
      `
      SELECT job_rows.id AS id,
             job_rows.run_id AS run_id,
             job_rows.company_id AS company_id,
             job_rows.title AS title,
             job_rows.location AS location,
             job_rows.url AS url
      FROM job_rows
      JOIN runs ON runs.id = job_rows.run_id
      WHERE job_rows.id = ? AND runs.user_id = ?
      `
    )
    .get(jobRowId, userId) as JobRowRecord | undefined;
}

function getCompanyStatus(companyId: string): string | undefined {
  const row = db
    .prepare(`SELECT status FROM run_companies WHERE id = ?`)
    .get(companyId) as RunCompanyStatusRecord | undefined;
  return row?.status;
}

function getCompanyName(companyId: string): string {
  const row = db
    .prepare(`SELECT company_name FROM run_companies WHERE id = ?`)
    .get(companyId) as { company_name: string } | undefined;
  return row?.company_name ?? "";
}

/**
 * Computes the same job_key an application row would use for this job_row,
 * via the shared jobIdentity helper (identical inputs to createApplication).
 * Used to look up an existing application for the same real job even when
 * it was created from a different job_row_id (e.g. a later monitoring run
 * rediscovering the same job under a new scanner run).
 */
function computeJobKeyForJobRow(jobRow: JobRowRecord): string {
  return computeJobKey({
    companyName: getCompanyName(jobRow.company_id),
    title: jobRow.title,
    location: jobRow.location,
    url: jobRow.url,
  });
}

/** Returns the packet only if owned by userId. Undefined otherwise (used for both existence and ownership checks). */
function getOwnedApplicationPacketForLinking(
  userId: string,
  packetId: string
): ApplicationPacketOwnershipRecord | undefined {
  return db
    .prepare(`SELECT id, job_row_id, status, created_at FROM application_packets WHERE id = ? AND user_id = ?`)
    .get(packetId, userId) as ApplicationPacketOwnershipRecord | undefined;
}

function isValidStatus(value: unknown): value is ApplicationTrackingStatus {
  return typeof value === "string" && VALID_STATUSES.includes(value);
}

/** Accepts a finite epoch millisecond number, or null/undefined to mean "not set". Throws on anything else. */
function validateOptionalTimestamp(value: unknown, fieldName: string): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApplicationRequestError(400, `${fieldName} must be a number (epoch milliseconds) or null`);
  }
  return value;
}

function validateOptionalNotes(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ApplicationRequestError(400, "notes must be a string or null");
  }
  return value;
}

/**
 * Validates that a packetId (if provided) is owned by userId and belongs to
 * the same jobRowId. Returns the packetId unchanged (or null) for storage.
 * Throws ApplicationRequestError for ownership (404) or job-mismatch (400)
 * problems. Never mutates the packet.
 */
function validatePacketLink(
  userId: string,
  jobRowId: string,
  applicationPacketId: unknown
): string | null {
  if (applicationPacketId === undefined || applicationPacketId === null) {
    return null;
  }
  if (typeof applicationPacketId !== "string" || applicationPacketId.trim() === "") {
    throw new ApplicationRequestError(400, "application_packet_id must be a string or null");
  }

  const packet = getOwnedApplicationPacketForLinking(userId, applicationPacketId);
  if (!packet) {
    throw new ApplicationRequestError(404, "application packet not found");
  }
  if (packet.job_row_id !== jobRowId) {
    throw new ApplicationRequestError(400, "application packet belongs to a different job");
  }
  return applicationPacketId;
}

function toApplicationResponse(row: ApplicationRow): ApplicationResponse {
  const jobRow = db.prepare(`SELECT run_id FROM job_rows WHERE id = ?`).get(row.job_row_id) as
    | { run_id: string }
    | undefined;

  let linkedPacket: ApplicationLinkedPacketSummary | null = null;
  if (row.application_packet_id) {
    const packet = db
      .prepare(`SELECT id, status, created_at FROM application_packets WHERE id = ?`)
      .get(row.application_packet_id) as
      | { id: string; status: string; created_at: number }
      | undefined;
    if (packet) {
      linkedPacket = {
        id: packet.id,
        status: packet.status as ApplicationLinkedPacketSummary["status"],
        created_at: packet.created_at,
      };
    }
  }

  return {
    id: row.id,
    job_row_id: row.job_row_id,
    run_id: jobRow?.run_id ?? "",
    application_packet_id: row.application_packet_id,
    linked_packet: linkedPacket,
    status: row.status as ApplicationResponse["status"],
    company_name: row.company_name,
    job_title: row.job_title,
    job_url: row.job_url,
    job_location: row.job_location,
    notes: row.notes,
    applied_at: row.applied_at,
    follow_up_at: row.follow_up_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function isJobRowOwnedByUser(userId: string, jobRowId: string): boolean {
  return getOwnedJobRow(userId, jobRowId) !== undefined;
}

export interface CreateApplicationInput {
  status?: unknown;
  application_packet_id?: unknown;
  notes?: unknown;
  applied_at?: unknown;
  follow_up_at?: unknown;
}

/**
 * Creates an application tracking record for jobRowId owned by userId.
 * Throws ApplicationRequestError for ownership (404), eligibility (409),
 * duplicate job_key (409), packet ownership (404), packet/job mismatch (400),
 * or field validation (400) problems. Never mutates job_rows, job_details,
 * run_companies, runs, or application_packets.
 */
export function createApplication(
  userId: string,
  jobRowId: string,
  input: CreateApplicationInput
): ApplicationResponse {
  const jobRow = getOwnedJobRow(userId, jobRowId);
  if (!jobRow) {
    throw new ApplicationRequestError(404, "job not found");
  }

  const companyStatus = getCompanyStatus(jobRow.company_id);
  if (companyStatus !== "MATCHES_FOUND") {
    throw new ApplicationRequestError(409, "job is not eligible for application tracking");
  }

  const status = input.status === undefined ? ApplicationTrackingStatus.SAVED : input.status;
  if (!isValidStatus(status)) {
    throw new ApplicationRequestError(400, "status is not a valid application tracking status");
  }

  const applicationPacketId = validatePacketLink(userId, jobRowId, input.application_packet_id);
  const notes = validateOptionalNotes(input.notes);
  const appliedAt = validateOptionalTimestamp(input.applied_at, "applied_at");
  const followUpAt = validateOptionalTimestamp(input.follow_up_at, "follow_up_at");

  const companyName = getCompanyName(jobRow.company_id);
  const jobKey = computeJobKeyForJobRow(jobRow);

  const existingDuplicate = db
    .prepare(`SELECT id FROM applications WHERE user_id = ? AND job_key = ?`)
    .get(userId, jobKey) as { id: string } | undefined;
  if (existingDuplicate) {
    throw new ApplicationRequestError(409, "an application for this job is already tracked");
  }

  const id = randomUUID();
  const now = Date.now();

  db.prepare(
    `INSERT INTO applications
      (id, user_id, job_row_id, application_packet_id, status, job_key, company_name, job_title, job_url, job_location, notes, applied_at, follow_up_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    userId,
    jobRowId,
    applicationPacketId,
    status,
    jobKey,
    companyName,
    jobRow.title,
    jobRow.url,
    jobRow.location,
    notes,
    appliedAt,
    followUpAt,
    now,
    now
  );

  const row = db.prepare(`SELECT * FROM applications WHERE id = ?`).get(id) as ApplicationRow;
  return toApplicationResponse(row);
}

/**
 * Returns the caller's applications for the same real job as jobRowId,
 * newest first by created_at. Looks up by the job row's computed job_key
 * (not exact job_row_id) so an application created from an earlier scanner
 * or monitoring run surfaces correctly when the same real job is
 * rediscovered under a new job_row_id — matching how createApplication's
 * UNIQUE(user_id, job_key) dedupe already treats those as the same job.
 * Returns [] if jobRowId is not owned by userId (callers distinguish
 * not-owned via isJobRowOwnedByUser).
 */
export function listApplicationsForJob(userId: string, jobRowId: string): ApplicationResponse[] {
  const jobRow = getOwnedJobRow(userId, jobRowId);
  if (!jobRow) {
    return [];
  }

  const jobKey = computeJobKeyForJobRow(jobRow);

  const rows = db
    .prepare(
      `SELECT * FROM applications WHERE user_id = ? AND job_key = ? ORDER BY created_at DESC, id DESC`
    )
    .all(userId, jobKey) as ApplicationRow[];
  return rows.map(toApplicationResponse);
}

export interface ListApplicationsOptions {
  status?: string;
}

/**
 * Lists all of the caller's applications, newest first by updated_at (ties
 * broken by id). Optional status filter. Documented ordering: updated_at
 * DESC so recently-edited records surface first, matching how a tracking
 * list is actually used (recently touched rows matter most).
 */
export function listApplicationsForUser(
  userId: string,
  options: ListApplicationsOptions = {}
): ApplicationResponse[] {
  if (options.status !== undefined && !isValidStatus(options.status)) {
    throw new ApplicationRequestError(400, "status filter is not a valid application tracking status");
  }

  const rows = options.status
    ? (db
        .prepare(
          `SELECT * FROM applications WHERE user_id = ? AND status = ? ORDER BY updated_at DESC, id DESC`
        )
        .all(userId, options.status) as ApplicationRow[])
    : (db
        .prepare(`SELECT * FROM applications WHERE user_id = ? ORDER BY updated_at DESC, id DESC`)
        .all(userId) as ApplicationRow[]);

  return rows.map(toApplicationResponse);
}

export function getOwnedApplication(userId: string, applicationId: string): ApplicationResponse | undefined {
  const row = db
    .prepare(`SELECT * FROM applications WHERE id = ? AND user_id = ?`)
    .get(applicationId, userId) as ApplicationRow | undefined;
  return row ? toApplicationResponse(row) : undefined;
}

export interface UpdateApplicationInput {
  status?: unknown;
  application_packet_id?: unknown;
  notes?: unknown;
  applied_at?: unknown;
  follow_up_at?: unknown;
}

/**
 * Updates status/notes/dates/packet-link on an owned application. Does not
 * allow changing job_row_id, job_key, or the snapshot fields (company_name,
 * job_title, job_url, job_location) — those are immutable evidence captured
 * at creation time. Throws ApplicationRequestError(404) if not owned/found,
 * (400) for invalid fields, packet job-mismatch, or (404) for a non-owned
 * packet. Passing application_packet_id: null detaches an existing link.
 */
export function updateApplication(
  userId: string,
  applicationId: string,
  input: UpdateApplicationInput
): ApplicationResponse {
  const existing = db
    .prepare(`SELECT * FROM applications WHERE id = ? AND user_id = ?`)
    .get(applicationId, userId) as ApplicationRow | undefined;
  if (!existing) {
    throw new ApplicationRequestError(404, "application not found");
  }

  const status = input.status === undefined ? existing.status : input.status;
  if (!isValidStatus(status)) {
    throw new ApplicationRequestError(400, "status is not a valid application tracking status");
  }

  const applicationPacketId =
    input.application_packet_id === undefined
      ? existing.application_packet_id
      : validatePacketLink(userId, existing.job_row_id, input.application_packet_id);

  const notes = input.notes === undefined ? existing.notes : validateOptionalNotes(input.notes);
  const appliedAt =
    input.applied_at === undefined
      ? existing.applied_at
      : validateOptionalTimestamp(input.applied_at, "applied_at");
  const followUpAt =
    input.follow_up_at === undefined
      ? existing.follow_up_at
      : validateOptionalTimestamp(input.follow_up_at, "follow_up_at");

  const now = Date.now();

  db.prepare(
    `UPDATE applications
     SET status = ?, application_packet_id = ?, notes = ?, applied_at = ?, follow_up_at = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(status, applicationPacketId, notes, appliedAt, followUpAt, now, applicationId, userId);

  const row = db.prepare(`SELECT * FROM applications WHERE id = ?`).get(applicationId) as ApplicationRow;
  return toApplicationResponse(row);
}

/** Returns true if a row was actually deleted (i.e. it existed and was owned by userId). Hard delete only. */
export function deleteApplication(userId: string, applicationId: string): boolean {
  const result = db
    .prepare(`DELETE FROM applications WHERE id = ? AND user_id = ?`)
    .run(applicationId, userId);
  return result.changes > 0;
}
