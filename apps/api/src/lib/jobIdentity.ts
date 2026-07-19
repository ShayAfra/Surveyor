/**
 * Pure job identity helper shared by monitoring (monitoring_matches dedup)
 * and application tracking (applications dedup). Extracted from
 * monitoring.ts's original computeJobKey/normalizeJobUrl/normalizeText so
 * both features use one identity definition instead of two copies that could
 * silently drift apart. Contains no scanner logic and touches no database
 * table — callers own all persistence.
 */

/**
 * Conservative job identity key: normalized URL when parseable, otherwise a
 * fallback of company_name + normalized title + normalized location. Kept
 * intentionally simple - this is a dedupe key, not a canonicalization system.
 */
export function computeJobKey(input: {
  companyName: string;
  title: string;
  location: string | null;
  url: string;
}): string {
  const normalizedUrl = normalizeJobUrl(input.url);
  if (normalizedUrl) {
    return `url:${normalizedUrl}`;
  }
  return `fallback:${normalizeText(input.companyName)}|${normalizeText(input.title)}|${normalizeText(input.location ?? "")}`;
}

export function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Returns a normalized URL key for a valid, parseable URL, or null when the
 * URL is empty or unparseable - callers must fall back to the
 * company/title/location key in that case, never to the lowercased raw
 * string (an invalid URL is not a stable identity).
 */
export function normalizeJobUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    const host = parsed.host.toLowerCase();
    let pathname = parsed.pathname;
    if (pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }
    return `${protocol}//${host}${pathname}`;
  } catch {
    return null;
  }
}
