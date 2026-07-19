import { randomUUID } from "node:crypto";
import { ApplicationPacketStatus } from "@surveyor/shared";
import type { ApplicationPacketEvidenceItem, ApplicationPacketResponse } from "@surveyor/shared";
import { db } from "../db/db.js";

const APPLICATION_PACKET_LLM_TIMEOUT_MS = 28_000;

export const ApplicationPacketFailureCode = {
  LLM_FAILED: "APPLICATION_PACKET_LLM_FAILED",
  INVALID_OUTPUT: "APPLICATION_PACKET_INVALID_OUTPUT",
  TIMEOUT: "APPLICATION_PACKET_TIMEOUT",
  EVIDENCE_MISSING: "APPLICATION_PACKET_EVIDENCE_MISSING",
} as const;

export type ApplicationPacketFailureCode =
  (typeof ApplicationPacketFailureCode)[keyof typeof ApplicationPacketFailureCode];

/** Thrown for request/evidence validity problems that must not create an application_packets row. */
export class ApplicationPacketRequestError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string
  ) {
    super(message);
  }
}

interface JobRowRecord {
  id: string;
  run_id: string;
  company_id: string;
  title: string;
  location: string | null;
  url: string;
  match_reason: string;
}

interface RunCompanyStatusRecord {
  status: string;
}

interface JobDetailRecord {
  description_text: string | null;
  failure_code: string | null;
  failure_reason: string | null;
}

interface UserProfileRecord {
  full_name: string | null;
  location: string | null;
  years_experience: number | null;
  target_titles: string | null;
  notes: string | null;
}

interface UserProfileItemRecord {
  item_type: string;
  title: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
}

interface ResumeRecord {
  resume_text: string;
}

interface FitAnalysisContextRecord {
  id: string;
  fit_summary: string | null;
  strengths_json: string | null;
  gaps_json: string | null;
  risks_json: string | null;
  suggested_next_steps_json: string | null;
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
             job_rows.url AS url,
             job_rows.match_reason AS match_reason
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

function getJobDetail(jobRowId: string): JobDetailRecord | undefined {
  return db
    .prepare(
      `SELECT description_text, failure_code, failure_reason FROM job_details WHERE job_row_id = ?`
    )
    .get(jobRowId) as JobDetailRecord | undefined;
}

function getProfile(userId: string): UserProfileRecord | undefined {
  return db
    .prepare(
      `SELECT full_name, location, years_experience, target_titles, notes FROM user_profiles WHERE user_id = ?`
    )
    .get(userId) as UserProfileRecord | undefined;
}

function getProfileItems(userId: string): UserProfileItemRecord[] {
  return db
    .prepare(
      `SELECT item_type, title, description, start_date, end_date FROM user_profile_items WHERE user_id = ? ORDER BY created_at ASC`
    )
    .all(userId) as UserProfileItemRecord[];
}

function getResume(userId: string): ResumeRecord | undefined {
  return db.prepare(`SELECT resume_text FROM resumes WHERE user_id = ?`).get(userId) as
    | ResumeRecord
    | undefined;
}

/** Latest COMPLETED fit analysis for this job/user, if any. Optional context only — never required. */
function getLatestCompletedFitAnalysis(
  userId: string,
  jobRowId: string
): FitAnalysisContextRecord | undefined {
  return db
    .prepare(
      `SELECT id, fit_summary, strengths_json, gaps_json, risks_json, suggested_next_steps_json
       FROM job_fit_analyses
       WHERE user_id = ? AND job_row_id = ? AND status = 'COMPLETED'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`
    )
    .get(userId, jobRowId) as FitAnalysisContextRecord | undefined;
}

function hasMeaningfulProfileField(profile: UserProfileRecord | undefined): boolean {
  if (!profile) {
    return false;
  }
  return (
    (profile.full_name != null && profile.full_name.trim() !== "") ||
    (profile.location != null && profile.location.trim() !== "") ||
    profile.years_experience != null ||
    (profile.target_titles != null && profile.target_titles.trim() !== "") ||
    (profile.notes != null && profile.notes.trim() !== "")
  );
}

interface EvidenceBundle {
  jobRow: JobRowRecord;
  jobDetail: JobDetailRecord;
  descriptionAvailable: boolean;
  profile: UserProfileRecord | undefined;
  profileItems: UserProfileItemRecord[];
  resumeText: string | undefined;
  fitAnalysis: FitAnalysisContextRecord | undefined;
  caveats: string[];
}

/**
 * Gathers and validates evidence for an application packet request. Throws
 * ApplicationPacketRequestError for problems that must not create an
 * application_packets row (ownership, eligibility, missing job_details row,
 * no usable user evidence). Fit analysis is read only as optional context.
 */
function gatherEvidence(userId: string, jobRowId: string): EvidenceBundle {
  const jobRow = getOwnedJobRow(userId, jobRowId);
  if (!jobRow) {
    throw new ApplicationPacketRequestError(404, "job not found");
  }

  const companyStatus = getCompanyStatus(jobRow.company_id);
  if (companyStatus !== "MATCHES_FOUND") {
    throw new ApplicationPacketRequestError(
      409,
      "job is not eligible for application packet generation"
    );
  }

  const jobDetail = getJobDetail(jobRowId);
  if (!jobDetail) {
    throw new ApplicationPacketRequestError(
      409,
      "job detail evidence is not available for this job"
    );
  }

  const caveats: string[] = [];
  const descriptionAvailable =
    jobDetail.description_text != null && jobDetail.description_text.trim() !== "";
  const recordedDetailFailure =
    (jobDetail.failure_code != null && jobDetail.failure_code.trim() !== "") ||
    (jobDetail.failure_reason != null && jobDetail.failure_reason.trim() !== "");

  if (!descriptionAvailable && !recordedDetailFailure) {
    throw new ApplicationPacketRequestError(409, "job detail evidence is incomplete for this job");
  }

  if (!descriptionAvailable) {
    caveats.push(
      "The full job description could not be fetched. This packet is based only on the job title, location, and match reason."
    );
  }

  const profile = getProfile(userId);
  const profileItems = getProfileItems(userId);
  const resumeRow = getResume(userId);
  const resumeText =
    resumeRow && resumeRow.resume_text.trim() !== "" ? resumeRow.resume_text : undefined;
  const profileUsable = hasMeaningfulProfileField(profile) || profileItems.length > 0;

  if (!resumeText && !profileUsable) {
    throw new ApplicationPacketRequestError(
      400,
      "no usable profile or resume evidence exists for this user"
    );
  }

  if (!resumeText) {
    caveats.push("No resume is on file. This packet is based only on structured profile data.");
  }
  if (!profileUsable) {
    caveats.push("No structured profile is on file. This packet is based only on the resume.");
  }

  const fitAnalysis = getLatestCompletedFitAnalysis(userId, jobRowId);

  return {
    jobRow,
    jobDetail,
    descriptionAvailable,
    profile: profileUsable ? profile : undefined,
    profileItems,
    resumeText,
    fitAnalysis,
    caveats,
  };
}

function buildEvidenceSnapshot(evidence: EvidenceBundle): Record<string, unknown> {
  return {
    job_row: {
      id: evidence.jobRow.id,
      title: evidence.jobRow.title,
      location: evidence.jobRow.location,
      url: evidence.jobRow.url,
      match_reason: evidence.jobRow.match_reason,
    },
    job_detail: evidence.descriptionAvailable
      ? { description_text: evidence.jobDetail.description_text }
      : {
          failure_code: evidence.jobDetail.failure_code,
          failure_reason: evidence.jobDetail.failure_reason,
        },
    profile: evidence.profile ?? null,
    profile_items: evidence.profileItems,
    resume_text: evidence.resumeText ?? null,
    fit_analysis: evidence.fitAnalysis
      ? {
          id: evidence.fitAnalysis.id,
          fit_summary: evidence.fitAnalysis.fit_summary,
          strengths: evidence.fitAnalysis.strengths_json
            ? JSON.parse(evidence.fitAnalysis.strengths_json)
            : null,
          gaps: evidence.fitAnalysis.gaps_json ? JSON.parse(evidence.fitAnalysis.gaps_json) : null,
          risks: evidence.fitAnalysis.risks_json
            ? JSON.parse(evidence.fitAnalysis.risks_json)
            : null,
          suggested_next_steps: evidence.fitAnalysis.suggested_next_steps_json
            ? JSON.parse(evidence.fitAnalysis.suggested_next_steps_json)
            : null,
        }
      : null,
    caveats: evidence.caveats,
  };
}

function buildUserMessage(evidence: EvidenceBundle): string {
  const jobDescriptionSection = evidence.descriptionAvailable
    ? `Job description:\n${evidence.jobDetail.description_text}`
    : `Job description: not available. Base your materials only on the job title, location, and match reason below. Do not invent job requirements.`;

  const profileSection = evidence.profile
    ? `User profile:
Full name: ${evidence.profile.full_name ?? "unknown"}
Location: ${evidence.profile.location ?? "unknown"}
Years of experience: ${evidence.profile.years_experience ?? "unknown"}
Target titles: ${evidence.profile.target_titles ?? "unknown"}
Notes: ${evidence.profile.notes ?? "none"}`
    : `User profile: not on file.`;

  const itemsSection =
    evidence.profileItems.length > 0
      ? `User profile items:\n${evidence.profileItems
          .map(
            (item) =>
              `- [${item.item_type}] ${item.title}${item.description ? `: ${item.description}` : ""}${
                item.start_date || item.end_date
                  ? ` (${item.start_date ?? "?"} - ${item.end_date ?? "?"})`
                  : ""
              }`
          )
          .join("\n")}`
      : `User profile items: none on file.`;

  const resumeSection = evidence.resumeText
    ? `Resume text:\n${evidence.resumeText}`
    : `Resume text: not on file.`;

  const fitAnalysisSection = evidence.fitAnalysis
    ? `Existing fit analysis (optional context, already reviewed by the user):
Fit summary: ${evidence.fitAnalysis.fit_summary ?? "none"}
Strengths: ${evidence.fitAnalysis.strengths_json ?? "[]"}
Gaps: ${evidence.fitAnalysis.gaps_json ?? "[]"}
Risks: ${evidence.fitAnalysis.risks_json ?? "[]"}
Suggested next steps: ${evidence.fitAnalysis.suggested_next_steps_json ?? "[]"}`
    : `Existing fit analysis: none on file. Proceed using only job and user evidence below.`;

  return `Job title: ${evidence.jobRow.title}
Job location: ${evidence.jobRow.location ?? "unknown"}
Match reason (why the scanner matched this job): ${evidence.jobRow.match_reason}

${jobDescriptionSection}

${profileSection}

${itemsSection}

${resumeSection}

${fitAnalysisSection}

Using only the evidence above, prepare draft application materials to help this user apply for this job. Follow these rules strictly:
1. Everything you produce is a DRAFT for the user to review before using. Never imply anything has been submitted or sent.
2. Do not invent user experience, skills, or background beyond what is stated in the profile, profile items, resume, or fit analysis above.
3. Do not invent job requirements beyond the job description (or job title/match reason if no description is available).
4. Use only the evidence provided. If evidence is missing or limited, say so honestly in caveats rather than guessing.
5. Resume bullet suggestions are suggestions only, not a rewritten resume. Do not claim the user has a skill or experience unless it is supported by the profile or resume evidence above.
6. Do not claim or imply that an application was submitted or will be submitted on the user's behalf.

Respond with a single JSON object only (no markdown, no prose) with exactly these keys:
"packet_summary" (non-empty string),
"positioning_notes" (array of objects with "text" and "evidence" string fields),
"cover_letter_draft" (non-empty string, a draft cover letter grounded only in the evidence above),
"resume_bullet_suggestions" (array of objects with "text" and "evidence" string fields),
"talking_points" (array of objects with "text" and "evidence" string fields),
"questions_to_prepare" (array of objects with "text" and "evidence" string fields),
"caveats" (array of strings, noting any missing or limited evidence).

No other keys.`;
}

const SYSTEM_PROMPT = `You output only valid JSON objects containing draft application materials for a specific job, grounded strictly in the evidence provided in the user message. You never invent facts about the candidate's background or the job's requirements beyond what is given. Everything you produce is a draft for human review, never a submitted or final document, and you never imply that an application has been or will be submitted on the user's behalf. Resume bullet suggestions are suggestions only, never a rewritten resume. The object must have exactly the keys packet_summary, positioning_notes, cover_letter_draft, resume_bullet_suggestions, talking_points, questions_to_prepare, and caveats.`;

interface ParsedApplicationPacket {
  packet_summary: string;
  positioning_notes: ApplicationPacketEvidenceItem[];
  cover_letter_draft: string;
  resume_bullet_suggestions: ApplicationPacketEvidenceItem[];
  talking_points: ApplicationPacketEvidenceItem[];
  questions_to_prepare: ApplicationPacketEvidenceItem[];
  caveats: string[];
}

function isEvidenceItemArray(value: unknown): value is ApplicationPacketEvidenceItem[] {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return false;
    }
    const o = item as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length !== 2 || !keys.includes("text") || !keys.includes("evidence")) {
      return false;
    }
    return (
      typeof o.text === "string" &&
      o.text.trim() !== "" &&
      typeof o.evidence === "string" &&
      o.evidence.trim() !== ""
    );
  });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const STRICT_OUTPUT_KEYS = [
  "packet_summary",
  "positioning_notes",
  "cover_letter_draft",
  "resume_bullet_suggestions",
  "talking_points",
  "questions_to_prepare",
  "caveats",
] as const;

/** Validates the strict structured output shape. Returns null on any shape violation (fail closed). */
function validateApplicationPacketOutput(parsed: unknown): ParsedApplicationPacket | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const o = parsed as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== STRICT_OUTPUT_KEYS.length) {
    return null;
  }
  for (const k of keys) {
    if (!STRICT_OUTPUT_KEYS.includes(k as (typeof STRICT_OUTPUT_KEYS)[number])) {
      return null;
    }
  }

  if (typeof o.packet_summary !== "string" || o.packet_summary.trim() === "") {
    return null;
  }

  if (typeof o.cover_letter_draft !== "string" || o.cover_letter_draft.trim() === "") {
    return null;
  }

  if (
    !isEvidenceItemArray(o.positioning_notes) ||
    !isEvidenceItemArray(o.resume_bullet_suggestions) ||
    !isEvidenceItemArray(o.talking_points) ||
    !isEvidenceItemArray(o.questions_to_prepare)
  ) {
    return null;
  }

  if (!isStringArray(o.caveats)) {
    return null;
  }

  return {
    packet_summary: o.packet_summary.trim(),
    positioning_notes: o.positioning_notes as ApplicationPacketEvidenceItem[],
    cover_letter_draft: o.cover_letter_draft.trim(),
    resume_bullet_suggestions: o.resume_bullet_suggestions as ApplicationPacketEvidenceItem[],
    talking_points: o.talking_points as ApplicationPacketEvidenceItem[],
    questions_to_prepare: o.questions_to_prepare as ApplicationPacketEvidenceItem[],
    caveats: o.caveats as string[],
  };
}

function extractAssistantContent(completion: unknown): string | null {
  if (completion === null || typeof completion !== "object" || Array.isArray(completion)) {
    return null;
  }
  const choices = (completion as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length < 1) {
    return null;
  }
  const first = choices[0];
  if (first === null || typeof first !== "object" || Array.isArray(first)) {
    return null;
  }
  const message = (first as { message?: unknown }).message;
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string") {
    return null;
  }
  const trimmed = content.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface LlmOutcome {
  parsed: ParsedApplicationPacket | null;
  modelName: string | null;
  failureCode: ApplicationPacketFailureCode | null;
  failureReason: string | null;
}

/** Single LLM boundary for application packet generation: one HTTP call, strict JSON validation, never throws. */
async function callApplicationPacketLlm(evidence: EvidenceBundle): Promise<LlmOutcome> {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";

  if (!apiKey || apiKey.trim() === "") {
    return {
      parsed: null,
      modelName: null,
      failureCode: ApplicationPacketFailureCode.LLM_FAILED,
      failureReason: "application packet LLM call failed",
    };
  }

  const url = "https://api.openai.com/v1/chat/completions";
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), APPLICATION_PACKET_LLM_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserMessage(evidence) },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    return {
      parsed: null,
      modelName: model,
      failureCode: timedOut
        ? ApplicationPacketFailureCode.TIMEOUT
        : ApplicationPacketFailureCode.LLM_FAILED,
      failureReason: timedOut
        ? "application packet LLM call timed out"
        : "application packet LLM call failed",
    };
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    return {
      parsed: null,
      modelName: model,
      failureCode: ApplicationPacketFailureCode.LLM_FAILED,
      failureReason: "application packet LLM call failed",
    };
  }

  let completion: unknown;
  try {
    completion = (await res.json()) as unknown;
  } catch {
    return {
      parsed: null,
      modelName: model,
      failureCode: ApplicationPacketFailureCode.LLM_FAILED,
      failureReason: "application packet LLM call failed",
    };
  }

  const content = extractAssistantContent(completion);
  if (content === null) {
    return {
      parsed: null,
      modelName: model,
      failureCode: ApplicationPacketFailureCode.INVALID_OUTPUT,
      failureReason: "application packet LLM returned invalid output",
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content) as unknown;
  } catch {
    return {
      parsed: null,
      modelName: model,
      failureCode: ApplicationPacketFailureCode.INVALID_OUTPUT,
      failureReason: "application packet LLM returned invalid output",
    };
  }

  const validated = validateApplicationPacketOutput(parsedJson);
  if (validated === null) {
    return {
      parsed: null,
      modelName: model,
      failureCode: ApplicationPacketFailureCode.INVALID_OUTPUT,
      failureReason: "application packet LLM returned invalid output",
    };
  }

  return { parsed: validated, modelName: model, failureCode: null, failureReason: null };
}

interface ApplicationPacketRow {
  id: string;
  user_id: string;
  job_row_id: string;
  job_fit_analysis_id: string | null;
  status: string;
  packet_summary: string | null;
  cover_letter_draft: string | null;
  positioning_notes_json: string | null;
  resume_bullet_suggestions_json: string | null;
  talking_points_json: string | null;
  questions_to_prepare_json: string | null;
  evidence_snapshot_json: string;
  model_name: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  created_at: number;
}

function toApplicationPacketResponse(row: ApplicationPacketRow): ApplicationPacketResponse {
  return {
    id: row.id,
    job_row_id: row.job_row_id,
    job_fit_analysis_id: row.job_fit_analysis_id,
    status: row.status as ApplicationPacketResponse["status"],
    packet_summary: row.packet_summary,
    cover_letter_draft: row.cover_letter_draft,
    positioning_notes: row.positioning_notes_json ? JSON.parse(row.positioning_notes_json) : null,
    resume_bullet_suggestions: row.resume_bullet_suggestions_json
      ? JSON.parse(row.resume_bullet_suggestions_json)
      : null,
    talking_points: row.talking_points_json ? JSON.parse(row.talking_points_json) : null,
    questions_to_prepare: row.questions_to_prepare_json
      ? JSON.parse(row.questions_to_prepare_json)
      : null,
    caveats: row.evidence_snapshot_json
      ? ((JSON.parse(row.evidence_snapshot_json) as { caveats?: string[] }).caveats ?? null)
      : null,
    model_name: row.model_name,
    failure_code: row.failure_code,
    failure_reason: row.failure_reason,
    created_at: row.created_at,
  };
}

/**
 * Generates and persists a new application packet for jobRowId owned by userId.
 * Throws ApplicationPacketRequestError (no row created) for ownership/eligibility/evidence
 * problems. Otherwise always inserts a COMPLETED or FAILED row and returns it.
 * Never mutates runs, run_companies, job_rows, job_details, user_profiles,
 * user_profile_items, resumes, or job_fit_analyses.
 */
export async function generateApplicationPacket(
  userId: string,
  jobRowId: string
): Promise<ApplicationPacketResponse> {
  const evidence = gatherEvidence(userId, jobRowId);
  const evidenceSnapshot = buildEvidenceSnapshot(evidence);
  const outcome = await callApplicationPacketLlm(evidence);

  const id = randomUUID();
  const createdAt = Date.now();
  const fitAnalysisId = evidence.fitAnalysis ? evidence.fitAnalysis.id : null;

  if (outcome.parsed) {
    // Include the model's own caveats in the persisted snapshot so GET reflects them.
    const snapshotWithModelCaveats = {
      ...evidenceSnapshot,
      caveats: [...evidence.caveats, ...outcome.parsed.caveats],
    };

    db.prepare(
      `INSERT INTO application_packets
        (id, user_id, job_row_id, job_fit_analysis_id, status, packet_summary, cover_letter_draft, positioning_notes_json, resume_bullet_suggestions_json, talking_points_json, questions_to_prepare_json, evidence_snapshot_json, model_name, failure_code, failure_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      userId,
      jobRowId,
      fitAnalysisId,
      ApplicationPacketStatus.COMPLETED,
      outcome.parsed.packet_summary,
      outcome.parsed.cover_letter_draft,
      JSON.stringify(outcome.parsed.positioning_notes),
      JSON.stringify(outcome.parsed.resume_bullet_suggestions),
      JSON.stringify(outcome.parsed.talking_points),
      JSON.stringify(outcome.parsed.questions_to_prepare),
      JSON.stringify(snapshotWithModelCaveats),
      outcome.modelName,
      null,
      null,
      createdAt
    );
  } else {
    db.prepare(
      `INSERT INTO application_packets
        (id, user_id, job_row_id, job_fit_analysis_id, status, packet_summary, cover_letter_draft, positioning_notes_json, resume_bullet_suggestions_json, talking_points_json, questions_to_prepare_json, evidence_snapshot_json, model_name, failure_code, failure_reason, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)`
    ).run(
      id,
      userId,
      jobRowId,
      fitAnalysisId,
      ApplicationPacketStatus.FAILED,
      JSON.stringify(evidenceSnapshot),
      outcome.modelName,
      outcome.failureCode,
      outcome.failureReason,
      createdAt
    );
  }

  const row = db.prepare(`SELECT * FROM application_packets WHERE id = ?`).get(id) as
    | ApplicationPacketRow
    | undefined;
  return toApplicationPacketResponse(row as ApplicationPacketRow);
}

/** Returns all packets for jobRowId owned by userId, newest first. Empty array if job not owned/found. */
export function listApplicationPacketsForJob(
  userId: string,
  jobRowId: string
): ApplicationPacketResponse[] {
  const rows = db
    .prepare(
      `SELECT * FROM application_packets WHERE user_id = ? AND job_row_id = ? ORDER BY created_at DESC, id DESC`
    )
    .all(userId, jobRowId) as ApplicationPacketRow[];
  return rows.map(toApplicationPacketResponse);
}

/** Returns whether jobRowId exists and is owned by userId (used to distinguish empty-list from 404). */
export function isJobRowOwnedByUser(userId: string, jobRowId: string): boolean {
  return getOwnedJobRow(userId, jobRowId) !== undefined;
}

export function getOwnedApplicationPacket(
  userId: string,
  packetId: string
): ApplicationPacketResponse | undefined {
  const row = db
    .prepare(`SELECT * FROM application_packets WHERE id = ? AND user_id = ?`)
    .get(packetId, userId) as ApplicationPacketRow | undefined;
  return row ? toApplicationPacketResponse(row) : undefined;
}

/**
 * Returns true if a row was actually deleted (i.e. it existed and was owned
 * by userId). Any applications rows referencing this packet have
 * application_packet_id nulled out in the same transaction (Milestone 7:
 * application tracking must never be left with a dangling packet id, and the
 * application record itself must never be deleted as a side effect of
 * deleting the packet it was linked to).
 */
export function deleteApplicationPacket(userId: string, packetId: string): boolean {
  const tx = db.transaction(() => {
    const result = db
      .prepare(`DELETE FROM application_packets WHERE id = ? AND user_id = ?`)
      .run(packetId, userId);

    if (result.changes > 0) {
      db.prepare(
        `UPDATE applications SET application_packet_id = NULL, updated_at = ? WHERE application_packet_id = ? AND user_id = ?`
      ).run(Date.now(), packetId, userId);
    }

    return result.changes > 0;
  });

  return tx();
}
