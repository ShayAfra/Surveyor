/**
 * DuckDuckGo HTML search adapter (roadmap Step 6.2).
 * HTTP only, deterministic parsing, no LLM / headless browser / fallback providers.
 * Endpoint: https://html.duckduckgo.com/html/ (HTML results page).
 */

const SEARCH_TIMEOUT_MS = 5000;
const MAX_CANDIDATES = 12;

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * Normalize DuckDuckGo redirect links to the target URL when present.
 */
function normalizeResultHref(href: string): string | null {
  const decoded = decodeBasicEntities(href.trim());
  let u = decoded;
  if (u.startsWith("//")) {
    u = `https:${u}`;
  }
  try {
    const url = new URL(u);
    if (
      url.hostname.includes("duckduckgo.com") &&
      (url.pathname === "/l/" || url.pathname.startsWith("/l/"))
    ) {
      const uddg = url.searchParams.get("uddg");
      if (uddg) {
        return decodeURIComponent(uddg);
      }
    }
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Deterministic extraction of outbound URLs from DDG HTML results.
 */
function extractUrlsFromDuckDuckGoHtml(html: string): string[] {
  const out: string[] = [];
  const re =
    /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1]!;
    const normalized = normalizeResultHref(raw);
    if (!normalized) {
      continue;
    }
    if (
      normalized.includes("duckduckgo.com") ||
      normalized.startsWith("javascript:")
    ) {
      continue;
    }
    out.push(normalized);
    if (out.length >= MAX_CANDIDATES * 3) {
      break;
    }
  }
  return [...new Set(out)].slice(0, MAX_CANDIDATES);
}

export async function searchCareersCandidates(query: string): Promise<string[]> {
  const q = query.trim();
  if (!q) {
    return [];
  }
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ac.signal,
      headers: {
        "User-Agent": "SurveyorBot/1.0",
        Accept: "text/html",
      },
    });
    if (!res.ok) {
      return [];
    }
    const html = await res.text();
    return extractUrlsFromDuckDuckGoHtml(html);
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}
