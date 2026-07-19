import { Router } from "express";
import type {
  MonitoringConfigResponse,
  MonitoringExecutionListResponse,
  MonitoringMatchListResponse,
  MonitoringRunNowResponse,
  SavedSearchListResponse,
  SavedSearchResponse,
} from "@surveyor/shared";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import {
  SavedSearchRequestError,
  createSavedSearch,
  deleteSavedSearch,
  getOwnedSavedSearch,
  listSavedSearches,
  parseSavedSearchInput,
  startRunFromSavedSearch,
  updateSavedSearch,
} from "../lib/savedSearches.js";
import {
  MonitoringRequestError,
  getMonitoringConfig,
  listMonitoringExecutions,
  listMonitoringMatches,
  setMonitoringEnabled,
  triggerMonitoringExecution,
} from "../lib/monitoring.js";

export const savedSearchesRouter = Router();

savedSearchesRouter.get("/api/saved-searches", requireAuth, (req: AuthenticatedRequest, res) => {
  const searches: SavedSearchListResponse = listSavedSearches(req.userId as string);
  return res.json(searches);
});

savedSearchesRouter.get(
  "/api/saved-searches/:id",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const { id } = req.params;
    const search = getOwnedSavedSearch(req.userId as string, id);
    if (!search) {
      return res.status(404).json({ error: "saved search not found" });
    }
    return res.json(search satisfies SavedSearchResponse);
  }
);

savedSearchesRouter.post("/api/saved-searches", requireAuth, (req: AuthenticatedRequest, res) => {
  const userId = req.userId as string;

  try {
    const input = parseSavedSearchInput(userId, req.body ?? {});
    const created = createSavedSearch(userId, input);
    return res.status(201).json(created satisfies SavedSearchResponse);
  } catch (err) {
    if (err instanceof SavedSearchRequestError) {
      return res.status(err.httpStatus).json({ error: err.message });
    }
    throw err;
  }
});

savedSearchesRouter.put(
  "/api/saved-searches/:id",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const { id } = req.params;
    const userId = req.userId as string;

    if (!getOwnedSavedSearch(userId, id)) {
      return res.status(404).json({ error: "saved search not found" });
    }

    try {
      const input = parseSavedSearchInput(userId, req.body ?? {});
      const updated = updateSavedSearch(userId, id, input);
      if (!updated) {
        return res.status(404).json({ error: "saved search not found" });
      }
      return res.json(updated satisfies SavedSearchResponse);
    } catch (err) {
      if (err instanceof SavedSearchRequestError) {
        return res.status(err.httpStatus).json({ error: err.message });
      }
      throw err;
    }
  }
);

savedSearchesRouter.delete(
  "/api/saved-searches/:id",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const { id } = req.params;
    const deleted = deleteSavedSearch(req.userId as string, id);
    if (!deleted) {
      return res.status(404).json({ error: "saved search not found" });
    }
    return res.json({ ok: true });
  }
);

savedSearchesRouter.post(
  "/api/saved-searches/:id/runs",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const { id } = req.params;
    const userId = req.userId as string;

    try {
      const { runId } = startRunFromSavedSearch(userId, id);
      return res.status(201).json({ runId });
    } catch (err) {
      if (err instanceof SavedSearchRequestError) {
        return res.status(err.httpStatus).json({ error: err.message });
      }
      return res.status(500).json({ error: "failed to create run" });
    }
  }
);

savedSearchesRouter.get(
  "/api/saved-searches/:id/monitoring",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const { id } = req.params;
    const userId = req.userId as string;

    try {
      const config = getMonitoringConfig(userId, id);
      return res.json(config satisfies MonitoringConfigResponse);
    } catch (err) {
      if (err instanceof MonitoringRequestError) {
        return res.status(err.httpStatus).json({ error: err.message });
      }
      throw err;
    }
  }
);

savedSearchesRouter.put(
  "/api/saved-searches/:id/monitoring",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const { id } = req.params;
    const userId = req.userId as string;
    const body = (req.body ?? {}) as Record<string, unknown>;

    if (typeof body.enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean" });
    }

    try {
      const config = setMonitoringEnabled(userId, id, body.enabled);
      return res.json(config satisfies MonitoringConfigResponse);
    } catch (err) {
      if (err instanceof MonitoringRequestError) {
        return res.status(err.httpStatus).json({ error: err.message });
      }
      throw err;
    }
  }
);

savedSearchesRouter.get(
  "/api/saved-searches/:id/monitoring/executions",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const { id } = req.params;
    const userId = req.userId as string;

    try {
      const executions: MonitoringExecutionListResponse = listMonitoringExecutions(userId, id);
      return res.json(executions);
    } catch (err) {
      if (err instanceof MonitoringRequestError) {
        return res.status(err.httpStatus).json({ error: err.message });
      }
      throw err;
    }
  }
);

savedSearchesRouter.get(
  "/api/saved-searches/:id/monitoring/matches",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const { id } = req.params;
    const userId = req.userId as string;

    try {
      const matches: MonitoringMatchListResponse = listMonitoringMatches(userId, id);
      return res.json(matches);
    } catch (err) {
      if (err instanceof MonitoringRequestError) {
        return res.status(err.httpStatus).json({ error: err.message });
      }
      throw err;
    }
  }
);

savedSearchesRouter.post(
  "/api/saved-searches/:id/monitoring/run-now",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const { id } = req.params;
    const userId = req.userId as string;

    try {
      const { execution, runId } = triggerMonitoringExecution(userId, id);
      return res.status(201).json({ execution, runId } satisfies MonitoringRunNowResponse);
    } catch (err) {
      if (err instanceof MonitoringRequestError) {
        return res.status(err.httpStatus).json({ error: err.message });
      }
      return res.status(500).json({ error: "failed to start monitoring run" });
    }
  }
);
