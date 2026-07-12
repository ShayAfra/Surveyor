import { Router } from "express";
import type { ProfileMemoryResponse } from "@surveyor/shared";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import {
  createProfileItem,
  deleteProfile,
  deleteProfileItem,
  deleteResume,
  getOwnedProfileItem,
  getProfileMemory,
  isValidProfileItemType,
  trimToNullable,
  updateProfileItem,
  upsertProfile,
  upsertResume,
  type CreateProfileItemInput,
} from "../lib/profile.js";

export const profileRouter = Router();

profileRouter.get("/api/profile", requireAuth, (req: AuthenticatedRequest, res) => {
  const responseBody: ProfileMemoryResponse = getProfileMemory(req.userId as string);
  return res.json(responseBody);
});

profileRouter.put("/api/profile", requireAuth, (req: AuthenticatedRequest, res) => {
  const body = req.body ?? {};

  let yearsExperience: number | null = null;
  if (body.years_experience !== undefined && body.years_experience !== null) {
    if (
      typeof body.years_experience !== "number" ||
      !Number.isInteger(body.years_experience) ||
      body.years_experience < 0
    ) {
      return res
        .status(400)
        .json({ error: "years_experience must be null or a non-negative integer" });
    }
    yearsExperience = body.years_experience;
  }

  const saved = upsertProfile(req.userId as string, {
    full_name: trimToNullable(body.full_name),
    location: trimToNullable(body.location),
    years_experience: yearsExperience,
    target_titles: trimToNullable(body.target_titles),
    notes: trimToNullable(body.notes),
  });

  return res.json(saved);
});

profileRouter.delete("/api/profile", requireAuth, (req: AuthenticatedRequest, res) => {
  deleteProfile(req.userId as string);
  return res.json({ ok: true });
});

function parseProfileItemInput(
  body: Record<string, unknown>
): { input: CreateProfileItemInput } | { error: string } {
  if (!isValidProfileItemType(body.item_type)) {
    return { error: "item_type must be one of WORK_HISTORY, PROJECT, SKILL, EDUCATION" };
  }

  const title = trimToNullable(body.title);
  if (title === null) {
    return { error: "title must be a non-empty string" };
  }

  return {
    input: {
      item_type: body.item_type,
      title,
      description: trimToNullable(body.description),
      start_date: trimToNullable(body.start_date),
      end_date: trimToNullable(body.end_date),
    },
  };
}

profileRouter.post("/api/profile/items", requireAuth, (req: AuthenticatedRequest, res) => {
  const parsed = parseProfileItemInput(req.body ?? {});
  if ("error" in parsed) {
    return res.status(400).json({ error: parsed.error });
  }

  const created = createProfileItem(req.userId as string, parsed.input);
  return res.status(201).json(created);
});

profileRouter.put(
  "/api/profile/items/:itemId",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const { itemId } = req.params;
    const userId = req.userId as string;

    if (!getOwnedProfileItem(userId, itemId)) {
      return res.status(404).json({ error: "profile item not found" });
    }

    const parsed = parseProfileItemInput(req.body ?? {});
    if ("error" in parsed) {
      return res.status(400).json({ error: parsed.error });
    }

    const updated = updateProfileItem(userId, itemId, parsed.input);
    if (!updated) {
      return res.status(404).json({ error: "profile item not found" });
    }

    return res.json(updated);
  }
);

profileRouter.delete(
  "/api/profile/items/:itemId",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const { itemId } = req.params;
    const userId = req.userId as string;

    if (!getOwnedProfileItem(userId, itemId)) {
      return res.status(404).json({ error: "profile item not found" });
    }

    deleteProfileItem(userId, itemId);
    return res.json({ ok: true });
  }
);

profileRouter.put("/api/resume", requireAuth, (req: AuthenticatedRequest, res) => {
  const { resume_text: resumeText } = req.body ?? {};

  if (typeof resumeText !== "string" || resumeText.trim().length === 0) {
    return res.status(400).json({ error: "resume_text must be a non-empty string" });
  }

  const saved = upsertResume(req.userId as string, resumeText.trim());
  return res.json(saved);
});

profileRouter.delete("/api/resume", requireAuth, (req: AuthenticatedRequest, res) => {
  deleteResume(req.userId as string);
  return res.json({ ok: true });
});
