import { Router } from "express";
import {
  clearSessionCookie,
  createSession,
  createUser,
  findUserByEmail,
  getSessionIdFromRequest,
  isPlausibleEmail,
  deleteSession,
  readCurrentUser,
  setSessionCookie,
  verifyPassword,
  type AuthenticatedRequest,
} from "../lib/auth.js";

export const authRouter = Router();

const MIN_PASSWORD_LENGTH = 8;

authRouter.post("/api/auth/signup", (req, res) => {
  const { email, password } = req.body ?? {};

  if (typeof email !== "string" || email.trim().length === 0) {
    return res.status(400).json({ error: "email must be a non-empty string" });
  }

  if (!isPlausibleEmail(email.trim())) {
    return res.status(400).json({ error: "email must be a valid email address" });
  }

  if (typeof password !== "string" || password.length === 0) {
    return res.status(400).json({ error: "password must be a non-empty string" });
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return res
      .status(400)
      .json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }

  if (findUserByEmail(email)) {
    return res.status(409).json({ error: "email is already registered" });
  }

  const { user } = createUser(email, password);
  const session = createSession(user.id);
  setSessionCookie(res, session.id, session.expiresAt);

  return res.status(201).json({ id: user.id, email: user.email, created_at: user.created_at });
});

authRouter.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body ?? {};

  if (typeof email !== "string" || email.trim().length === 0) {
    return res.status(400).json({ error: "email must be a non-empty string" });
  }

  if (typeof password !== "string" || password.length === 0) {
    return res.status(400).json({ error: "password must be a non-empty string" });
  }

  const userRow = findUserByEmail(email);
  if (!userRow || !verifyPassword(password, userRow.password_salt, userRow.password_hash)) {
    return res.status(401).json({ error: "invalid email or password" });
  }

  const session = createSession(userRow.id);
  setSessionCookie(res, session.id, session.expiresAt);

  return res
    .status(200)
    .json({ id: userRow.id, email: userRow.email, created_at: userRow.created_at });
});

authRouter.post("/api/auth/logout", (req, res) => {
  const sessionId = getSessionIdFromRequest(req);
  if (sessionId) {
    deleteSession(sessionId);
  }
  clearSessionCookie(res);
  return res.status(200).json({ ok: true });
});

authRouter.get("/api/auth/me", (req: AuthenticatedRequest, res) => {
  const user = readCurrentUser(req);
  if (!user) {
    return res.status(401).json({ error: "authentication required" });
  }
  return res.status(200).json({ id: user.id, email: user.email, created_at: user.created_at });
});
