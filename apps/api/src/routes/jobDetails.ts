import { Router } from "express";
import type { JobDetailResponse } from "@surveyor/shared";
import { db } from "../db/db.js";

export const jobDetailsRouter = Router();

jobDetailsRouter.get("/api/jobs/:jobRowId/detail", (req, res) => {
  const { jobRowId } = req.params;

  const row = db
    .prepare(
      `
      SELECT job_row_id, job_url, description_text, failure_code, failure_reason, fetched_at
      FROM job_details
      WHERE job_row_id = ?
      `
    )
    .get(jobRowId) as
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
