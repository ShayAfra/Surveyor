/**
 * Deterministic matching (roadmap Step 6.5).
 */

import type { RoleSpec } from "@surveyor/shared";
import type { Job } from "./extraction.js";

export type MatchedJob = Job & { match_reason: string };

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s-]/g, "");
}

function isExcluded(norm: string, exclude_titles: string[]): boolean {
  for (const ex of exclude_titles) {
    const n = normalizeTitle(ex);
    if (n.length === 0) {
      continue;
    }
    if (norm.includes(n)) {
      return true;
    }
    const tokens = n.split(/\s+/).filter((w) => w.length > 0);
    if (tokens.length > 1 && tokens.every((w) => norm.includes(w))) {
      return true;
    }
  }
  return false;
}

function matchInclusion(norm: string, roleSpec: RoleSpec): string | null {
  for (const inc of roleSpec.include_titles) {
    const n = normalizeTitle(inc);
    if (n.length === 0) {
      continue;
    }
    if (norm.includes(n)) {
      return `Matched inclusion phrase ${inc.trim()}`;
    }
    const tokens = n.split(/\s+/).filter((w) => w.length > 0);
    if (tokens.length > 1 && tokens.every((w) => norm.includes(w))) {
      return `Matched token set ${tokens.join(" plus ")}`;
    }
  }
  return null;
}

function passesSeniority(norm: string, seniority: RoleSpec["seniority"]): boolean {
  if (seniority === "any") {
    return true;
  }
  const has = (s: string) => norm.includes(s);
  switch (seniority) {
    case "junior":
      return has("junior") || has("jr") || has("entry");
    case "mid":
      return (
        has("mid") ||
        (!has("senior") && !has("sr") && !has("junior") && !has("jr") && !has("principal") && !has("staff"))
      );
    case "senior":
      return has("senior") || has("sr") || has("lead") || has("principal") || has("staff");
    default:
      return true;
  }
}

export function matchJobs(jobs: Job[], roleSpec: RoleSpec): MatchedJob[] {
  const out: MatchedJob[] = [];
  for (const job of jobs) {
    const norm = normalizeTitle(job.title);
    if (isExcluded(norm, roleSpec.exclude_titles)) {
      continue;
    }
    const inc = matchInclusion(norm, roleSpec);
    if (!inc) {
      continue;
    }
    if (!passesSeniority(norm, roleSpec.seniority)) {
      continue;
    }
    out.push({ ...job, match_reason: inc });
  }
  return out;
}
