/**
 * Deterministic platform detection (roadmap Step 6.3).
 * Authoritative AtsType enum: @surveyor/shared (GREENHOUSE, LEVER, ASHBY, SMARTRECRUITERS, UNKNOWN).
 * No LLM. Returns exactly one enum value; UNKNOWN when no signature matches.
 *
 * Signatures follow lifecycle doc: hostnames, script/asset URLs, HTML text, path hints.
 * Rules are evaluated in a single fixed order (first match wins) — no alternate fallback strategies.
 */

import type { AtsType } from "@surveyor/shared";
import { AtsType as Ats } from "@surveyor/shared";

type Signals = {
  host: string;
  haystack: string;
};

function buildSignals(html: string, url: string): Signals {
  const htmlLower = html.toLowerCase();
  const trimmed = url.trim();
  let host = "";
  let urlLower = trimmed.toLowerCase();
  try {
    const u = new URL(trimmed);
    host = u.hostname.toLowerCase();
    urlLower = u.href.toLowerCase();
  } catch {
    // Invalid URL: omit host; haystack still includes trimmed URL text for substring checks.
  }
  return {
    host,
    haystack: `${htmlLower}\n${urlLower}\n${host}`,
  };
}

/** Official domain or subdomain only (avoids accidental suffix matches on unrelated hosts). */
function hostIsOfficial(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

const ORDERED_PLATFORM_RULES: ReadonlyArray<{
  type: AtsType;
  match: (s: Signals) => boolean;
}> = [
  {
    type: Ats.GREENHOUSE,
    match: (s) =>
      hostIsOfficial(s.host, "greenhouse.io") ||
      s.haystack.includes("boards.greenhouse.io") ||
      s.haystack.includes("job-boards.greenhouse.io") ||
      s.haystack.includes("grnh.se") ||
      s.haystack.includes("cdn.greenhouse.io") ||
      s.haystack.includes("greenhouse.io/embed"),
  },
  {
    type: Ats.LEVER,
    match: (s) =>
      hostIsOfficial(s.host, "lever.co") ||
      s.haystack.includes("jobs.lever.co") ||
      s.haystack.includes("api.lever.co"),
  },
  {
    type: Ats.ASHBY,
    match: (s) =>
      hostIsOfficial(s.host, "ashbyhq.com") ||
      s.haystack.includes("jobs.ashbyhq.com") ||
      s.haystack.includes("app.ashbyhq.com"),
  },
  {
    type: Ats.SMARTRECRUITERS,
    match: (s) =>
      hostIsOfficial(s.host, "smartrecruiters.com") ||
      s.haystack.includes("smartrecruiters.com") ||
      s.haystack.includes("smrtr.io") ||
      s.haystack.includes("careers.smartrecruiters.com"),
  },
];

export function detectPlatform(html: string, url: string): AtsType {
  const signals = buildSignals(html, url);
  for (const rule of ORDERED_PLATFORM_RULES) {
    if (rule.match(signals)) {
      return rule.type;
    }
  }
  return Ats.UNKNOWN;
}
