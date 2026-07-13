import { Router } from "express";
import type { ApplicationPacketListResponse, ApplicationPacketResponse } from "@surveyor/shared";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import {
  ApplicationPacketRequestError,
  deleteApplicationPacket,
  generateApplicationPacket,
  getOwnedApplicationPacket,
  isJobRowOwnedByUser,
  listApplicationPacketsForJob,
} from "../lib/applicationPacket.js";

export const applicationPacketRouter = Router();

applicationPacketRouter.post(
  "/api/jobs/:jobRowId/application-packets",
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const { jobRowId } = req.params;
    const userId = req.userId as string;

    try {
      const packet = await generateApplicationPacket(userId, jobRowId);
      return res.status(201).json(packet satisfies ApplicationPacketResponse);
    } catch (err) {
      if (err instanceof ApplicationPacketRequestError) {
        return res.status(err.httpStatus).json({ error: err.message });
      }
      throw err;
    }
  }
);

applicationPacketRouter.get(
  "/api/jobs/:jobRowId/application-packets",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const { jobRowId } = req.params;
    const userId = req.userId as string;

    if (!isJobRowOwnedByUser(userId, jobRowId)) {
      return res.status(404).json({ error: "job not found" });
    }

    const packets: ApplicationPacketListResponse = listApplicationPacketsForJob(userId, jobRowId);
    return res.json(packets);
  }
);

applicationPacketRouter.get(
  "/api/application-packets/:packetId",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const { packetId } = req.params;
    const userId = req.userId as string;

    const packet = getOwnedApplicationPacket(userId, packetId);
    if (!packet) {
      return res.status(404).json({ error: "application packet not found" });
    }

    return res.json(packet satisfies ApplicationPacketResponse);
  }
);

applicationPacketRouter.delete(
  "/api/application-packets/:packetId",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const { packetId } = req.params;
    const userId = req.userId as string;

    const deleted = deleteApplicationPacket(userId, packetId);
    if (!deleted) {
      return res.status(404).json({ error: "application packet not found" });
    }

    return res.json({ ok: true });
  }
);
