/**
 * Minimal safe-logging helper for local diagnostics. Surveyor deliberately does
 * not use an external logging framework or telemetry service.
 *
 * IMPORTANT: an arbitrary Error.message (or a thrown string) can contain
 * private/user/model/job/request content depending on where the error
 * originated. To guarantee that never leaks into logs, this helper exposes only
 * the error's *name* — never its message, never thrown string content, never a
 * stack trace. Callers that need more context must log explicitly allowlisted,
 * non-sensitive fields (ids/codes/status) themselves.
 */

/** Returns a safe, generic label for an unknown thrown value: its Error name, or its typeof. */
export function safeErrorName(err: unknown): string {
  if (err instanceof Error) {
    return err.name || "Error";
  }
  return typeof err;
}
