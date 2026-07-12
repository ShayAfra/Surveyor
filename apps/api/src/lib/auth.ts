import type { Request, Response, NextFunction } from "express";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { db } from "../db/db.js";

export const SESSION_COOKIE_NAME = "surveyor_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SCRYPT_KEY_LENGTH = 64;

export interface AuthUser {
  id: string;
  email: string;
  created_at: number;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isPlausibleEmail(email: string): boolean {
  // Deliberately simple: presence of exactly one "@" with non-empty local/domain parts.
  // Full RFC validation is not required for this milestone.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString("hex");
}

export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const actual = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  const expected = Buffer.from(expectedHash, "hex");
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

interface CreateUserResult {
  user: AuthUser;
}

/**
 * Creates a user and, if this is the first user in the system, backfills any
 * pre-existing user_id-less runs to that user in the same transaction. This
 * avoids a fake placeholder owner while still giving legacy local runs a real
 * owner as soon as one exists.
 */
export function createUser(email: string, password: string): CreateUserResult {
  const normalizedEmail = normalizeEmail(email);
  const userId = randomUUID();
  const salt = randomBytes(16).toString("hex");
  const passwordHash = hashPassword(password, salt);
  const createdAt = Date.now();

  const insertUser = db.prepare(`
    INSERT INTO users (id, email, password_hash, password_salt, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const countUsers = db.prepare(`SELECT COUNT(*) AS count FROM users`);
  const backfillLegacyRuns = db.prepare(`UPDATE runs SET user_id = ? WHERE user_id IS NULL`);

  const tx = db.transaction(() => {
    const { count } = countUsers.get() as { count: number };
    const isFirstUser = count === 0;

    insertUser.run(userId, normalizedEmail, passwordHash, salt, createdAt);

    if (isFirstUser) {
      backfillLegacyRuns.run(userId);
    }
  });

  tx();

  return { user: { id: userId, email: normalizedEmail, created_at: createdAt } };
}

export function findUserByEmail(
  email: string
): { id: string; email: string; password_hash: string; password_salt: string; created_at: number } | undefined {
  return db
    .prepare(
      `SELECT id, email, password_hash, password_salt, created_at FROM users WHERE email = ?`
    )
    .get(normalizeEmail(email)) as
    | { id: string; email: string; password_hash: string; password_salt: string; created_at: number }
    | undefined;
}

export function createSession(userId: string): { id: string; expiresAt: number } {
  const sessionId = randomBytes(32).toString("hex");
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  db.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`
  ).run(sessionId, userId, now, expiresAt);

  return { id: sessionId, expiresAt };
}

export function deleteSession(sessionId: string): void {
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
}

/** Returns the authenticated user for a session id, or undefined if missing/expired. */
export function getUserForSession(sessionId: string): AuthUser | undefined {
  const row = db
    .prepare(
      `
      SELECT users.id AS id, users.email AS email, users.created_at AS created_at, sessions.expires_at AS expires_at
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.id = ?
      `
    )
    .get(sessionId) as
    | { id: string; email: string; created_at: number; expires_at: number }
    | undefined;

  if (!row) {
    return undefined;
  }

  if (row.expires_at < Date.now()) {
    deleteSession(sessionId);
    return undefined;
  }

  return { id: row.id, email: row.email, created_at: row.created_at };
}

/** Minimal cookie parser scoped to reading the session cookie only. */
function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) {
    return undefined;
  }
  const parts = header.split(";");
  for (const part of parts) {
    const [rawName, ...rawValueParts] = part.trim().split("=");
    if (rawName === SESSION_COOKIE_NAME) {
      return decodeURIComponent(rawValueParts.join("="));
    }
  }
  return undefined;
}

function isProductionCookieContext(): boolean {
  return process.env.NODE_ENV === "production";
}

export function setSessionCookie(res: Response, sessionId: string, expiresAt: number): void {
  res.cookie(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProductionCookieContext(),
    expires: new Date(expiresAt),
    path: "/",
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProductionCookieContext(),
    path: "/",
  });
}

export interface AuthenticatedRequest extends Request {
  userId?: string;
}

/** Attaches req.userId when a valid session cookie is present; does not itself reject requests. */
export function readCurrentUser(req: AuthenticatedRequest): AuthUser | undefined {
  const sessionId = readSessionCookie(req);
  if (!sessionId) {
    return undefined;
  }
  return getUserForSession(sessionId);
}

/** Express middleware: rejects with 401 unless a valid session is present. */
export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const user = readCurrentUser(req);
  if (!user) {
    res.status(401).json({ error: "authentication required" });
    return;
  }
  req.userId = user.id;
  next();
}

export function getSessionIdFromRequest(req: Request): string | undefined {
  return readSessionCookie(req);
}
