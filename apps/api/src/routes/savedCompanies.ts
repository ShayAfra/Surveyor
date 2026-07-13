import { Router } from "express";
import type { SavedCompanyListResponse, SavedCompanyResponse } from "@surveyor/shared";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import {
  createSavedCompany,
  deleteSavedCompany,
  getOwnedSavedCompany,
  listSavedCompanies,
  trimToNullable,
  updateSavedCompany,
  type SavedCompanyInput,
} from "../lib/savedCompanies.js";

export const savedCompaniesRouter = Router();

function parseSavedCompanyInput(
  body: Record<string, unknown>
): { input: SavedCompanyInput } | { error: string } {
  const companyName = trimToNullable(body.company_name);
  if (companyName === null) {
    return { error: "company_name must be a non-empty string" };
  }

  if (
    body.company_url !== undefined &&
    body.company_url !== null &&
    typeof body.company_url !== "string"
  ) {
    return { error: "company_url must be null or a string" };
  }

  if (body.notes !== undefined && body.notes !== null && typeof body.notes !== "string") {
    return { error: "notes must be null or a string" };
  }

  return {
    input: {
      company_name: companyName,
      company_url: trimToNullable(body.company_url),
      notes: trimToNullable(body.notes),
    },
  };
}

savedCompaniesRouter.get(
  "/api/saved-companies",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const companies: SavedCompanyListResponse = listSavedCompanies(req.userId as string);
    return res.json(companies);
  }
);

savedCompaniesRouter.get(
  "/api/saved-companies/:id",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const { id } = req.params;
    const company = getOwnedSavedCompany(req.userId as string, id);
    if (!company) {
      return res.status(404).json({ error: "saved company not found" });
    }
    return res.json(company satisfies SavedCompanyResponse);
  }
);

savedCompaniesRouter.post(
  "/api/saved-companies",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const parsed = parseSavedCompanyInput(req.body ?? {});
    if ("error" in parsed) {
      return res.status(400).json({ error: parsed.error });
    }

    const created = createSavedCompany(req.userId as string, parsed.input);
    return res.status(201).json(created satisfies SavedCompanyResponse);
  }
);

savedCompaniesRouter.put(
  "/api/saved-companies/:id",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const { id } = req.params;
    const userId = req.userId as string;

    if (!getOwnedSavedCompany(userId, id)) {
      return res.status(404).json({ error: "saved company not found" });
    }

    const parsed = parseSavedCompanyInput(req.body ?? {});
    if ("error" in parsed) {
      return res.status(400).json({ error: parsed.error });
    }

    const updated = updateSavedCompany(userId, id, parsed.input);
    if (!updated) {
      return res.status(404).json({ error: "saved company not found" });
    }

    return res.json(updated satisfies SavedCompanyResponse);
  }
);

savedCompaniesRouter.delete(
  "/api/saved-companies/:id",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const { id } = req.params;
    const deleted = deleteSavedCompany(req.userId as string, id);
    if (!deleted) {
      return res.status(404).json({ error: "saved company not found" });
    }
    return res.json({ ok: true });
  }
);
