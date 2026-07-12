import { Router } from "express";
import type { JobDetailResponse } from "@surveyor/shared";
import { db } from "../db/db.js";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";

export const jobDetailsRouter = Router();

jobDetailsRouter.get("/api/jobs/:jobRowId/detail", requireAuth, (req: AuthenticatedRequest, res) => {
  const { jobRowId } = req.params;

  const row = db
    .prepare(
      `
      SELECT job_details.job_row_id AS job_row_id,
             job_details.job_url AS job_url,
             job_details.description_text AS description_text,
             job_details.failure_code AS failure_code,
             job_details.failure_reason AS failure_reason,
             job_details.fetched_at AS fetched_at
      FROM job_details
      JOIN job_rows ON job_rows.id = job_details.job_row_id
      JOIN runs ON runs.id = job_rows.run_id
      WHERE job_details.job_row_id = ? AND runs.user_id = ?
      `
    )
    .get(jobRowId, req.userId) as
    | {
        job_row_id: string;
        job_url: string;
        description_text: string | null;
        failure_code: string | null;
        failure_reason: string | null;
        fetched_at: number | null;
      }
    | undefined;

  if (!row) {
    return res.status(404).json({ error: "job detail not found" });
  }

  const responseBody: JobDetailResponse = {
    job_row_id: row.job_row_id,
    job_url: row.job_url,
    description_text: row.description_text,
    failure_code: row.failure_code,
    failure_reason: row.failure_reason,
    fetched_at: row.fetched_at,
  };

  return res.json(responseBody);
});
