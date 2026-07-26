import type { NextFunction, Request, RequestHandler, Response } from "express";
import { safeErrorName } from "./safeLog.js";

/**
 * Wraps an async route handler so a rejected promise is forwarded to Express's
 * error handling chain (next(err)) instead of becoming an unhandled rejection
 * that leaves the request hanging or produces an HTML error. Express 4 does not
 * catch rejections from async handlers on its own, so async AI routes (fit
 * analysis, application packet generation) use this to reach jsonErrorHandler.
 */
export function asyncHandler<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => unknown | Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(fn(req as Req, res, next)).catch(next);
  };
}

interface BodyParseError {
  type?: string;
}

/**
 * Final Express error boundary. Registered after all routes so every unexpected
 * failure returns JSON (never Express's default HTML) and no stack trace or
 * private data ever reaches the client:
 *   - a malformed JSON request body (surfaced by express.json() as
 *     type "entity.parse.failed") becomes 400 { error: "invalid JSON request body" }
 *   - anything else becomes 500 { error: "unexpected server error" }
 * Logs only safe metadata: method, path, and the error *name* (never the error
 * message, since a message can echo the request body or other private content).
 */
export function jsonErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const isBodyParseFailure =
    err != null && (err as BodyParseError).type === "entity.parse.failed";

  // If the response has already started, we cannot change the status/body;
  // defer to Express's default handling to close the connection.
  if (res.headersSent) {
    next(err);
    return;
  }

  const name = safeErrorName(err);

  if (isBodyParseFailure) {
    console.warn(`[api] invalid JSON body: ${req.method} ${req.path} (${name})`);
    res.status(400).json({ error: "invalid JSON request body" });
    return;
  }

  console.error(`[api] unexpected server error: ${req.method} ${req.path} (${name})`);
  res.status(500).json({ error: "unexpected server error" });
}
