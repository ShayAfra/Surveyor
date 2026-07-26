import { randomUUID } from "node:crypto";
import { FitAnalysisStatus } from "@surveyor/shared";
import type { FitAnalysisEvidenceItem, FitAnalysisResponse } from "@surveyor/shared";
import { db } from "../db/db.js";

const FIT_ANALYSIS_LLM_TIMEOUT_MS = 28_000;

export const FitAnalysisFailureCode = {
  LLM_FAILED: "FIT_ANALYSIS_LLM_FAILED",
  INVALID_OUTPUT: "FIT_ANALYSIS_INVALID_OUTPUT",
  TIMEOUT: "FIT_ANALYSIS_TIMEOUT",
  EVIDENCE_MISSING: "FIT_ANALYSIS_EVIDENCE_MISSING",
} as const;

export type FitAnalysisFailureCode =
  (typeof FitAnalysisFailureCode)[keyof typeof FitAnalysisFailureCode];

/** Thrown for request/evidence validity problems that must not create a job_fit_analyses row. */
export class FitAnalysisRequestError extends Error {
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
  caveats: string[];
}

/**
 * Gathers and validates evidence for a fit analysis request. Throws
 * FitAnalysisRequestError for problems that must not create a job_fit_analyses
 * row (ownership, eligibility, missing job_details row, no usable user evidence).
 */
function gatherEvidence(userId: string, jobRowId: string): EvidenceBundle {
  const jobRow = getOwnedJobRow(userId, jobRowId);
  if (!jobRow) {
    throw new FitAnalysisRequestError(404, "job not found");
  }

  const companyStatus = getCompanyStatus(jobRow.company_id);
  if (companyStatus !== "MATCHES_FOUND") {
    throw new FitAnalysisRequestError(409, "job is not eligible for fit analysis");
  }

  const jobDetail = getJobDetail(jobRowId);
  if (!jobDetail) {
    throw new FitAnalysisRequestError(409, "job detail evidence is not available for this job");
  }

  const caveats: string[] = [];
  const descriptionAvailable =
    jobDetail.description_text != null && jobDetail.description_text.trim() !== "";
  if (!descriptionAvailable) {
    caveats.push(
      "The full job description could not be fetched. This analysis is based only on the job title, location, and match reason."
    );
  }

  const profile = getProfile(userId);
  const profileItems = getProfileItems(userId);
  const resumeRow = getResume(userId);
  const resumeText =
    resumeRow && resumeRow.resume_text.trim() !== "" ? resumeRow.resume_text : undefined;
  const profileUsable = hasMeaningfulProfileField(profile) || profileItems.length > 0;

  if (!resumeText && !profileUsable) {
    throw new FitAnalysisRequestError(
      400,
      "no usable profile or resume evidence exists for this user"
    );
  }

  if (!resumeText) {
    caveats.push("No resume is on file. This analysis is based only on structured profile data.");
  }
  if (!profileUsable) {
    caveats.push("No structured profile is on file. This analysis is based only on the resume.");
  }

  return {
    jobRow,
    jobDetail,
    descriptionAvailable,
    profile: profileUsable ? profile : undefined,
    profileItems,
    resumeText,
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
    caveats: evidence.caveats,
  };
}

function buildUserMessage(evidence: EvidenceBundle): string {
  const jobDescriptionSection = evidence.descriptionAvailable
    ? `Job description:\n${evidence.jobDetail.description_text}`
    : `Job description: not available. Base your analysis only on the job title, location, and match reason below. Do not invent job requirements.`;

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

  return `Job title: ${evidence.jobRow.title}
Job location: ${evidence.jobRow.location ?? "unknown"}
Match reason (why the scanner matched this job): ${evidence.jobRow.match_reason}

${jobDescriptionSection}

${profileSection}

${itemsSection}

${resumeSection}

Using only the evidence above, assess this user's fit for this job. Do not invent facts about the user's background beyond what is stated above. Do not invent job requirements beyond the job description (or job title/match reason if no description is available). If evidence is missing, say so honestly rather than guessing.

Respond with a single JSON object only (no markdown, no prose) with exactly these keys:
"fit_summary" (non-empty string),
"strengths" (array of objects with "text" and "evidence" string fields),
"gaps" (array of objects with "text" and "evidence" string fields),
"risks" (array of objects with "text" and "evidence" string fields),
"suggested_next_steps" (array of objects with "text" and "evidence" string fields),
"caveats" (array of strings, noting any missing or limited evidence).

No other keys.`;
}

const SYSTEM_PROMPT = `You output only valid JSON objects assessing a job candidate's fit for a specific job, grounded strictly in the evidence provided in the user message. You never invent facts about the candidate's background or the job's requirements beyond what is given. The object must have exactly the keys fit_summary, strengths, gaps, risks, suggested_next_steps, and caveats.`;

interface ParsedFitAnalysis {
  fit_summary: string;
  strengths: FitAnalysisEvidenceItem[];
  gaps: FitAnalysisEvidenceItem[];
  risks: FitAnalysisEvidenceItem[];
  suggested_next_steps: FitAnalysisEvidenceItem[];
  caveats: string[];
}

function isEvidenceItemArray(value: unknown): value is FitAnalysisEvidenceItem[] {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return false;
    }
    const o = item as Record<string, unknown>;
    return typeof o.text === "string" && typeof o.evidence === "string";
  });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const STRICT_OUTPUT_KEYS = [
  "fit_summary",
  "strengths",
  "gaps",
  "risks",
  "suggested_next_steps",
  "caveats",
] as const;

/** Validates the strict structured output shape. Returns null on any shape violation (fail closed). */
function validateFitAnalysisOutput(parsed: unknown): ParsedFitAnalysis | null {
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

  if (typeof o.fit_summary !== "string" || o.fit_summary.trim() === "") {
    return null;
  }

  if (
    !isEvidenceItemArray(o.strengths) ||
    !isEvidenceItemArray(o.gaps) ||
    !isEvidenceItemArray(o.risks) ||
    !isEvidenceItemArray(o.suggested_next_steps)
  ) {
    return null;
  }

  if (!isStringArray(o.caveats)) {
    return null;
  }

  return {
    fit_summary: o.fit_summary.trim(),
    strengths: o.strengths as FitAnalysisEvidenceItem[],
    gaps: o.gaps as FitAnalysisEvidenceItem[],
    risks: o.risks as FitAnalysisEvidenceItem[],
    suggested_next_steps: o.suggested_next_steps as FitAnalysisEvidenceItem[],
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
  parsed: ParsedFitAnalysis | null;
  modelName: string | null;
  failureCode: FitAnalysisFailureCode | null;
  failureReason: string | null;
  /** Upstream HTTP status when the LLM call returned a non-OK response. Diagnostics only. */
  upstreamStatus?: number | null;
}

/** Single LLM boundary for fit analysis: one HTTP call, strict JSON validation, never throws. */
async function callFitAnalysisLlm(evidence: EvidenceBundle): Promise<LlmOutcome> {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";

  if (!apiKey || apiKey.trim() === "") {
    return {
      parsed: null,
      modelName: null,
      failureCode: FitAnalysisFailureCode.LLM_FAILED,
      failureReason: "fit analysis LLM call failed",
    };
  }

  const url = "https://api.openai.com/v1/chat/completions";
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FIT_ANALYSIS_LLM_TIMEOUT_MS);

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
      failureCode: timedOut ? FitAnalysisFailureCode.TIMEOUT : FitAnalysisFailureCode.LLM_FAILED,
      failureReason: timedOut ? "fit analysis LLM call timed out" : "fit analysis LLM call failed",
    };
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    return {
      parsed: null,
      modelName: model,
      failureCode: FitAnalysisFailureCode.LLM_FAILED,
      failureReason: "fit analysis LLM call failed",
      upstreamStatus: res.status,
    };
  }

  let completion: unknown;
  try {
    completion = (await res.json()) as unknown;
  } catch {
    return {
      parsed: null,
      modelName: model,
      failureCode: FitAnalysisFailureCode.LLM_FAILED,
      failureReason: "fit analysis LLM call failed",
    };
  }

  const content = extractAssistantContent(completion);
  if (content === null) {
    return {
      parsed: null,
      modelName: model,
      failureCode: FitAnalysisFailureCode.INVALID_OUTPUT,
      failureReason: "fit analysis LLM returned invalid output",
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content) as unknown;
  } catch {
    return {
      parsed: null,
      modelName: model,
      failureCode: FitAnalysisFailureCode.INVALID_OUTPUT,
      failureReason: "fit analysis LLM returned invalid output",
    };
  }

  const validated = validateFitAnalysisOutput(parsedJson);
  if (validated === null) {
    return {
      parsed: null,
      modelName: model,
      failureCode: FitAnalysisFailureCode.INVALID_OUTPUT,
      failureReason: "fit analysis LLM returned invalid output",
    };
  }

  return { parsed: validated, modelName: model, failureCode: null, failureReason: null };
}

interface JobFitAnalysisRow {
  id: string;
  user_id: string;
  job_row_id: string;
  status: string;
  fit_summary: string | null;
  strengths_json: string | null;
  gaps_json: string | null;
  risks_json: string | null;
  suggested_next_steps_json: string | null;
  evidence_snapshot_json: string;
  model_name: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  created_at: number;
}

function toFitAnalysisResponse(row: JobFitAnalysisRow): FitAnalysisResponse {
  return {
    id: row.id,
    job_row_id: row.job_row_id,
    status: row.status as FitAnalysisResponse["status"],
    fit_summary: row.fit_summary,
    strengths: row.strengths_json ? JSON.parse(row.strengths_json) : null,
    gaps: row.gaps_json ? JSON.parse(row.gaps_json) : null,
    risks: row.risks_json ? JSON.parse(row.risks_json) : null,
    suggested_next_steps: row.suggested_next_steps_json
      ? JSON.parse(row.suggested_next_steps_json)
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
 * Generates and persists a new fit analysis for jobRowId owned by userId.
 * Throws FitAnalysisRequestError (no row created) for ownership/eligibility/evidence
 * problems. Otherwise always inserts a COMPLETED or FAILED row and returns it.
 * Never mutates runs, run_companies, job_rows, or job_details.
 */
export async function generateFitAnalysis(
  userId: string,
  jobRowId: string
): Promise<FitAnalysisResponse> {
  const evidence = gatherEvidence(userId, jobRowId);
  const evidenceSnapshot = buildEvidenceSnapshot(evidence);
  const outcome = await callFitAnalysisLlm(evidence);

  const id = randomUUID();
  const createdAt = Date.now();

  if (outcome.parsed) {
    // Include the model's own caveats in the persisted snapshot so GET reflects them.
    const snapshotWithModelCaveats = {
      ...evidenceSnapshot,
      caveats: [...evidence.caveats, ...outcome.parsed.caveats],
    };

    db.prepare(
      `INSERT INTO job_fit_analyses
        (id, user_id, job_row_id, status, fit_summary, strengths_json, gaps_json, risks_json, suggested_next_steps_json, evidence_snapshot_json, model_name, failure_code, failure_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      userId,
      jobRowId,
      FitAnalysisStatus.COMPLETED,
      outcome.parsed.fit_summary,
      JSON.stringify(outcome.parsed.strengths),
      JSON.stringify(outcome.parsed.gaps),
      JSON.stringify(outcome.parsed.risks),
      JSON.stringify(outcome.parsed.suggested_next_steps),
      JSON.stringify(snapshotWithModelCaveats),
      outcome.modelName,
      null,
      null,
      createdAt
    );
  } else {
    // Safe diagnostics only: ids/codes/model/upstream status — never evidence,
    // prompt, or model output. The FAILED row is still durable evidence.
    console.warn("fit analysis generation failed", {
      analysisId: id,
      jobRowId,
      failureCode: outcome.failureCode,
      model: outcome.modelName,
      upstreamStatus: outcome.upstreamStatus ?? null,
    });

    db.prepare(
      `INSERT INTO job_fit_analyses
        (id, user_id, job_row_id, status, fit_summary, strengths_json, gaps_json, risks_json, suggested_next_steps_json, evidence_snapshot_json, model_name, failure_code, failure_reason, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)`
    ).run(
      id,
      userId,
      jobRowId,
      FitAnalysisStatus.FAILED,
      JSON.stringify(evidenceSnapshot),
      outcome.modelName,
      outcome.failureCode,
      outcome.failureReason,
      createdAt
    );
  }

  const row = db.prepare(`SELECT * FROM job_fit_analyses WHERE id = ?`).get(id) as
    | JobFitAnalysisRow
    | undefined;
  return toFitAnalysisResponse(row as JobFitAnalysisRow);
}

/** Returns all analyses for jobRowId owned by userId, newest first. Empty array if job not owned/found. */
export function listFitAnalysesForJob(userId: string, jobRowId: string): FitAnalysisResponse[] {
  const rows = db
    .prepare(
      `SELECT * FROM job_fit_analyses WHERE user_id = ? AND job_row_id = ? ORDER BY created_at DESC, id DESC`
    )
    .all(userId, jobRowId) as JobFitAnalysisRow[];
  return rows.map(toFitAnalysisResponse);
}

/** Returns whether jobRowId exists and is owned by userId (used to distinguish empty-list from 404). */
export function isJobRowOwnedByUser(userId: string, jobRowId: string): boolean {
  return getOwnedJobRow(userId, jobRowId) !== undefined;
}

export function getOwnedFitAnalysis(
  userId: string,
  analysisId: string
): FitAnalysisResponse | undefined {
  const row = db
    .prepare(`SELECT * FROM job_fit_analyses WHERE id = ? AND user_id = ?`)
    .get(analysisId, userId) as JobFitAnalysisRow | undefined;
  return row ? toFitAnalysisResponse(row) : undefined;
}

/** Returns true if a row was actually deleted (i.e. it existed and was owned by userId). */
export function deleteFitAnalysis(userId: string, analysisId: string): boolean {
  const result = db
    .prepare(`DELETE FROM job_fit_analyses WHERE id = ? AND user_id = ?`)
    .run(analysisId, userId);
  return result.changes > 0;
}
