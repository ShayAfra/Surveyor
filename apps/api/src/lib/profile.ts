import { randomUUID } from "node:crypto";
import { ProfileItemType } from "@surveyor/shared";
import type {
  ProfileMemoryResponse,
  ResumeMemoryResponse,
  UserProfileItemResponse,
  UserProfileResponse,
} from "@surveyor/shared";
import { db } from "../db/db.js";

const ALLOWED_ITEM_TYPES: ProfileItemType[] = [
  ProfileItemType.WORK_HISTORY,
  ProfileItemType.PROJECT,
  ProfileItemType.SKILL,
  ProfileItemType.EDUCATION,
];

export function isValidProfileItemType(value: unknown): value is ProfileItemType {
  return typeof value === "string" && (ALLOWED_ITEM_TYPES as string[]).includes(value);
}

/** Trims a string field; returns null for undefined/null/empty-after-trim. */
export function trimToNullable(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

interface UserProfileRow {
  id: string;
  user_id: string;
  full_name: string | null;
  location: string | null;
  years_experience: number | null;
  target_titles: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

interface UserProfileItemRow {
  id: string;
  user_id: string;
  item_type: ProfileItemType;
  title: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  created_at: number;
  updated_at: number;
}

interface ResumeRow {
  id: string;
  user_id: string;
  resume_text: string;
  created_at: number;
  updated_at: number;
}

function toProfileResponse(row: UserProfileRow): UserProfileResponse {
  return {
    id: row.id,
    full_name: row.full_name,
    location: row.location,
    years_experience: row.years_experience,
    target_titles: row.target_titles,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toItemResponse(row: UserProfileItemRow): UserProfileItemResponse {
  return {
    id: row.id,
    item_type: row.item_type,
    title: row.title,
    description: row.description,
    start_date: row.start_date,
    end_date: row.end_date,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toResumeResponse(row: ResumeRow): ResumeMemoryResponse {
  return {
    id: row.id,
    resume_text: row.resume_text,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getProfileRow(userId: string): UserProfileRow | undefined {
  return db.prepare(`SELECT * FROM user_profiles WHERE user_id = ?`).get(userId) as
    | UserProfileRow
    | undefined;
}

export function getProfileItemRows(userId: string): UserProfileItemRow[] {
  return db
    .prepare(`SELECT * FROM user_profile_items WHERE user_id = ? ORDER BY created_at ASC`)
    .all(userId) as UserProfileItemRow[];
}

export function getResumeRow(userId: string): ResumeRow | undefined {
  return db.prepare(`SELECT * FROM resumes WHERE user_id = ?`).get(userId) as
    | ResumeRow
    | undefined;
}

export function getProfileMemory(userId: string): ProfileMemoryResponse {
  const profileRow = getProfileRow(userId);
  const itemRows = getProfileItemRows(userId);
  const resumeRow = getResumeRow(userId);

  return {
    profile: profileRow ? toProfileResponse(profileRow) : null,
    items: itemRows.map(toItemResponse),
    resume: resumeRow ? toResumeResponse(resumeRow) : null,
  };
}

export interface UpsertProfileInput {
  full_name: string | null;
  location: string | null;
  years_experience: number | null;
  target_titles: string | null;
  notes: string | null;
}

/** PUT replaces the profile resource: omitted fields become null. */
export function upsertProfile(userId: string, input: UpsertProfileInput): UserProfileResponse {
  const existing = getProfileRow(userId);
  const now = Date.now();

  if (existing) {
    db.prepare(
      `UPDATE user_profiles
       SET full_name = ?, location = ?, years_experience = ?, target_titles = ?, notes = ?, updated_at = ?
       WHERE user_id = ?`
    ).run(
      input.full_name,
      input.location,
      input.years_experience,
      input.target_titles,
      input.notes,
      now,
      userId
    );
  } else {
    db.prepare(
      `INSERT INTO user_profiles (id, user_id, full_name, location, years_experience, target_titles, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      userId,
      input.full_name,
      input.location,
      input.years_experience,
      input.target_titles,
      input.notes,
      now,
      now
    );
  }

  return toProfileResponse(getProfileRow(userId) as UserProfileRow);
}

/** Hard-deletes the profile row and all profile items for the user. Does not touch the resume. */
export function deleteProfile(userId: string): void {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM user_profiles WHERE user_id = ?`).run(userId);
    db.prepare(`DELETE FROM user_profile_items WHERE user_id = ?`).run(userId);
  });
  tx();
}

export interface CreateProfileItemInput {
  item_type: ProfileItemType;
  title: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
}

export function createProfileItem(
  userId: string,
  input: CreateProfileItemInput
): UserProfileItemResponse {
  const id = randomUUID();
  const now = Date.now();

  db.prepare(
    `INSERT INTO user_profile_items (id, user_id, item_type, title, description, start_date, end_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    userId,
    input.item_type,
    input.title,
    input.description,
    input.start_date,
    input.end_date,
    now,
    now
  );

  return toItemResponse(
    db.prepare(`SELECT * FROM user_profile_items WHERE id = ?`).get(id) as UserProfileItemRow
  );
}

export function getOwnedProfileItem(
  userId: string,
  itemId: string
): UserProfileItemRow | undefined {
  return db
    .prepare(`SELECT * FROM user_profile_items WHERE id = ? AND user_id = ?`)
    .get(itemId, userId) as UserProfileItemRow | undefined;
}

export function updateProfileItem(
  userId: string,
  itemId: string,
  input: CreateProfileItemInput
): UserProfileItemResponse | undefined {
  const existing = getOwnedProfileItem(userId, itemId);
  if (!existing) {
    return undefined;
  }

  const now = Date.now();
  db.prepare(
    `UPDATE user_profile_items
     SET item_type = ?, title = ?, description = ?, start_date = ?, end_date = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(
    input.item_type,
    input.title,
    input.description,
    input.start_date,
    input.end_date,
    now,
    itemId,
    userId
  );

  return toItemResponse(
    db.prepare(`SELECT * FROM user_profile_items WHERE id = ?`).get(itemId) as UserProfileItemRow
  );
}

/** Returns true if a row was actually deleted (i.e. it existed and was owned by userId). */
export function deleteProfileItem(userId: string, itemId: string): boolean {
  const result = db
    .prepare(`DELETE FROM user_profile_items WHERE id = ? AND user_id = ?`)
    .run(itemId, userId);
  return result.changes > 0;
}

/** Creates or replaces the user's single resume row. */
export function upsertResume(userId: string, resumeText: string): ResumeMemoryResponse {
  const existing = getResumeRow(userId);
  const now = Date.now();

  if (existing) {
    db.prepare(`UPDATE resumes SET resume_text = ?, updated_at = ? WHERE user_id = ?`).run(
      resumeText,
      now,
      userId
    );
  } else {
    db.prepare(
      `INSERT INTO resumes (id, user_id, resume_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run(randomUUID(), userId, resumeText, now, now);
  }

  return toResumeResponse(getResumeRow(userId) as ResumeRow);
}

/** Hard-deletes the user's resume row. Safe to call when none exists. */
export function deleteResume(userId: string): void {
  db.prepare(`DELETE FROM resumes WHERE user_id = ?`).run(userId);
}
