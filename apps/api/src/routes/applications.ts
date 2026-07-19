import { Router } from "express";
import type { ApplicationListResponse, ApplicationResponse } from "@surveyor/shared";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import {
  ApplicationRequestError,
  createApplication,
  deleteApplication,
  getOwnedApplication,
  isJobRowOwnedByUser,
  listApplicationsForJob,
  listApplicationsForUser,
  updateApplication,
} from "../lib/applications.js";

export const applicationsRouter = Router();

applicationsRouter.post(
  "/api/jobs/:jobRowId/applications",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const { jobRowId } = req.params;
    const userId = req.userId as string;
    const body = (req.body ?? {}) as Record<string, unknown>;

    try {
      const application = createApplication(userId, jobRowId, {
        status: body.status,
        application_packet_id: body.application_packet_id,
        notes: body.notes,
        applied_at: body.applied_at,
        follow_up_at: body.follow_up_at,
      });
      return res.status(201).json(application satisfies ApplicationResponse);
    } catch (err) {
      if (err instanceof ApplicationRequestError) {
        return res.status(err.httpStatus).json({ error: err.message });
      }
      throw err;
    }
  }
);

applicationsRouter.get(
  "/api/jobs/:jobRowId/applications",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const { jobRowId } = req.params;
    const userId = req.userId as string;

    if (!isJobRowOwnedByUser(userId, jobRowId)) {
      return res.status(404).json({ error: "job not found" });
    }

    const applications: ApplicationListResponse = listApplicationsForJob(userId, jobRowId);
    return res.json(applications);
  }
);

applicationsRouter.get("/api/applications", requireAuth, (req: AuthenticatedRequest, res) => {
  const userId = req.userId as string;
  const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined;

  try {
    const applications: ApplicationListResponse = listApplicationsForUser(userId, {
      status: statusFilter,
    });
    return res.json(applications);
  } catch (err) {
    if (err instanceof ApplicationRequestError) {
      return res.status(err.httpStatus).json({ error: err.message });
    }
    throw err;
  }
});

applicationsRouter.get(
  "/api/applications/:id",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const { id } = req.params;
    const userId = req.userId as string;

    const application = getOwnedApplication(userId, id);
    if (!application) {
      return res.status(404).json({ error: "application not found" });
    }

    return res.json(application satisfies ApplicationResponse);
  }
);

applicationsRouter.put(
  "/api/applications/:id",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const { id } = req.params;
    const userId = req.userId as string;
    const body = (req.body ?? {}) as Record<string, unknown>;

    try {
      const application = updateApplication(userId, id, {
        status: body.status,
        application_packet_id: body.application_packet_id,
        notes: body.notes,
        applied_at: body.applied_at,
        follow_up_at: body.follow_up_at,
      });
      return res.json(application satisfies ApplicationResponse);
    } catch (err) {
      if (err instanceof ApplicationRequestError) {
        return res.status(err.httpStatus).json({ error: err.message });
      }
      throw err;
    }
  }
);

applicationsRouter.delete(
  "/api/applications/:id",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const { id } = req.params;
    const userId = req.userId as string;

    const deleted = deleteApplication(userId, id);
    if (!deleted) {
      return res.status(404).json({ error: "application not found" });
    }

    return res.json({ ok: true });
  }
);
