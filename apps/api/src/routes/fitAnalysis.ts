import { Router } from "express";
import type { FitAnalysisListResponse, FitAnalysisResponse } from "@surveyor/shared";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import { asyncHandler } from "../lib/expressErrors.js";
import {
  FitAnalysisRequestError,
  deleteFitAnalysis,
  generateFitAnalysis,
  getOwnedFitAnalysis,
  isJobRowOwnedByUser,
  listFitAnalysesForJob,
} from "../lib/fitAnalysis.js";

export const fitAnalysisRouter = Router();

fitAnalysisRouter.post(
  "/api/jobs/:jobRowId/fit-analysis",
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const { jobRowId } = req.params;
    const userId = req.userId as string;

    try {
      const analysis = await generateFitAnalysis(userId, jobRowId);
      return res.status(201).json(analysis satisfies FitAnalysisResponse);
    } catch (err) {
      if (err instanceof FitAnalysisRequestError) {
        return res.status(err.httpStatus).json({ error: err.message });
      }
      // Unexpected error: forwarded to jsonErrorHandler (500 JSON) by asyncHandler.
      throw err;
    }
  })
);

fitAnalysisRouter.get(
  "/api/jobs/:jobRowId/fit-analysis",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const { jobRowId } = req.params;
    const userId = req.userId as string;

    if (!isJobRowOwnedByUser(userId, jobRowId)) {
      return res.status(404).json({ error: "job not found" });
    }

    const analyses: FitAnalysisListResponse = listFitAnalysesForJob(userId, jobRowId);
    return res.json(analyses);
  }
);

fitAnalysisRouter.get(
  "/api/fit-analyses/:analysisId",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const { analysisId } = req.params;
    const userId = req.userId as string;

    const analysis = getOwnedFitAnalysis(userId, analysisId);
    if (!analysis) {
      return res.status(404).json({ error: "fit analysis not found" });
    }

    return res.json(analysis satisfies FitAnalysisResponse);
  }
);

fitAnalysisRouter.delete(
  "/api/fit-analyses/:analysisId",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const { analysisId } = req.params;
    const userId = req.userId as string;

    const deleted = deleteFitAnalysis(userId, analysisId);
    if (!deleted) {
      return res.status(404).json({ error: "fit analysis not found" });
    }

    return res.json({ ok: true });
  }
);
