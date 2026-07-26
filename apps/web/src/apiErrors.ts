/**
 * Shared frontend helper for turning a non-OK API response into a
 * user-presentable message. It mirrors the pattern the app already used
 * inline: prefer the backend's `{ error: string }` text so validation messages
 * reach the form/action, and otherwise fall back to a generic message that
 * still includes the HTTP status.
 *
 * Contract:
 *   1. If the body parses to an object with a non-empty string `error`, return it.
 *   2. If the body is missing/malformed/not that shape, return `fallback` (or a
 *      status-based default).
 *   3. Never throws — a malformed JSON body is swallowed, not surfaced.
 *
 * 401 handling is intentionally left to callers: they continue to detect
 * `res.status === 401` and call `onLoggedOut()` before reaching this helper, so
 * the existing auth/logout flow is unchanged.
 */
export async function parseApiError(
  res: Pick<Response, "status" | "json">,
  fallback?: string
): Promise<string> {
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // Malformed or empty body — fall through to the fallback. Never throw.
    data = null;
  }

  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const errorValue = (data as Record<string, unknown>).error;
    if (typeof errorValue === "string" && errorValue.trim() !== "") {
      return errorValue;
    }
  }

  return fallback ?? `Request failed (${res.status})`;
}
