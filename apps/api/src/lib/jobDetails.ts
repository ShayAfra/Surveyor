/**
 * Gate 3: minimal job detail fetcher for matched jobs (agentReadiness.md Step 3.2).
 * HTTP only — no LLM, no Playwright. Mirrors the fetchHtml timeout/UA pattern
 * used in extraction.ts, kept local here rather than exported from extraction.ts.
 */

const JOB_DETAIL_FETCH_TIMEOUT_MS = 5000;
const JOB_DETAIL_MAX_TEXT_LENGTH = 20000;

export type JobDetailFetchResult = {
  description_text: string | null;
  failure_code: string | null;
  failure_reason: string | null;
};

const BLOCKED_HTML_PATTERNS: RegExp[] = [
  /\bcaptcha\b/i,
  /g-recaptcha/i,
  /\bhcaptcha\b/i,
  /cf-browser-verification/i,
  /checking your browser/i,
  /enable javascript and cookies to continue/i,
  /please verify you are human/i,
  /verifying you are human/i,
  /\baccess\s+denied\b/i,
  /\b403\s+forbidden\b/i,
  /\btoo\s+many\s+requests\b/i,
  /\brate[\s-]?limit/i,
];

function isBlockedHtml(html: string): boolean {
  return BLOCKED_HTML_PATTERNS.some((pattern) => pattern.test(html));
}

const STRIPPED_TAGS = ["script", "style", "nav", "footer", "header", "noscript", "svg", "form"];

const HTML_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&rdquo;": "”",
  "&ldquo;": "“",
  "&mdash;": "—",
  "&ndash;": "–",
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(nbsp|amp|lt|gt|quot|#39|apos|rsquo|lsquo|rdquo|ldquo|mdash|ndash);/g, (match) => HTML_ENTITIES[match] ?? match);
}

function cleanHtmlToText(html: string): string {
  let cleaned = html;
  for (const tag of STRIPPED_TAGS) {
    const re = new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, "gi");
    cleaned = cleaned.replace(re, " ");
  }
  cleaned = cleaned.replace(/<[^>]+>/g, " ");
  cleaned = decodeHtmlEntities(cleaned);
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned;
}

function truncate(text: string): string {
  return text.length > JOB_DETAIL_MAX_TEXT_LENGTH ? text.slice(0, JOB_DETAIL_MAX_TEXT_LENGTH) : text;
}

function failure(failure_code: string, failure_reason: string): JobDetailFetchResult {
  return { description_text: null, failure_code, failure_reason };
}

export async function fetchJobDetailText(jobUrl: string): Promise<JobDetailFetchResult> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), JOB_DETAIL_FETCH_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(jobUrl, {
        method: "GET",
        redirect: "follow",
        signal: ac.signal,
        headers: {
          "User-Agent": "SurveyorBot/1.0",
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        },
      });
    } catch (error) {
      if (ac.signal.aborted) {
        return failure("JOB_DETAIL_TIMEOUT", "job detail fetch timed out");
      }
      return failure("JOB_DETAIL_FETCH_FAILED", "job detail fetch failed due to a network error");
    }

    if (res.status === 403 || res.status === 429) {
      return failure("JOB_DETAIL_BLOCKED", `job detail fetch was blocked with HTTP ${res.status}`);
    }

    if (!res.ok) {
      return failure("JOB_DETAIL_FETCH_FAILED", `job detail fetch received HTTP ${res.status}`);
    }

    const html = await res.text();

    if (isBlockedHtml(html)) {
      return failure("JOB_DETAIL_BLOCKED", "job detail page content indicates blocking or a CAPTCHA challenge");
    }

    const text = truncate(cleanHtmlToText(html));

    if (text.length === 0) {
      return failure("JOB_DETAIL_EMPTY", "job detail page contained no usable text after cleanup");
    }

    return { description_text: text, failure_code: null, failure_reason: null };
  } finally {
    clearTimeout(t);
  }
}
