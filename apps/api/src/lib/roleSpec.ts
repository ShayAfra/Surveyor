import type { RoleSpec, RoleSpecSeniority } from "@surveyor/shared";

const ROLE_SPEC_LLM_TIMEOUT_MS = 28_000;

const SENIORITY_VALUES = new Set<RoleSpecSeniority>(["any", "junior", "mid", "senior"]);

const STRICT_KEYS = ["include_titles", "exclude_titles", "seniority"] as const;

function throwRoleSpecFailed(): never {
  throw {
    code: "ROLE_SPEC_FAILED" as const,
    message: "role spec generation failed" as const,
  };
}

function validateStrictRoleSpec(parsed: unknown): RoleSpec {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throwRoleSpecFailed();
  }

  const o = parsed as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== STRICT_KEYS.length) {
    throwRoleSpecFailed();
  }
  for (const k of keys) {
    if (!STRICT_KEYS.includes(k as (typeof STRICT_KEYS)[number])) {
      throwRoleSpecFailed();
    }
  }

  const include_titles = o.include_titles;
  const exclude_titles = o.exclude_titles;
  const seniorityRaw = o.seniority;

  if (!Array.isArray(include_titles) || !Array.isArray(exclude_titles)) {
    throwRoleSpecFailed();
  }

  const normInclude: string[] = [];
  for (const item of include_titles) {
    if (typeof item !== "string") {
      throwRoleSpecFailed();
    }
    const t = item.trim();
    if (t.length === 0) {
      throwRoleSpecFailed();
    }
    normInclude.push(t);
  }

  const normExclude: string[] = [];
  for (const item of exclude_titles) {
    if (typeof item !== "string") {
      throwRoleSpecFailed();
    }
    const t = item.trim();
    if (t.length === 0) {
      throwRoleSpecFailed();
    }
    normExclude.push(t);
  }

  if (typeof seniorityRaw !== "string") {
    throwRoleSpecFailed();
  }
  const seniority = seniorityRaw.trim() as RoleSpecSeniority;
  if (!SENIORITY_VALUES.has(seniority)) {
    throwRoleSpecFailed();
  }

  return {
    include_titles: normInclude,
    exclude_titles: normExclude,
    seniority,
  };
}

function buildUserMessage(role_raw: string, include_adjacent: boolean): string {
  const adjacentLine = include_adjacent
    ? "The user wants adjacent related titles included: set include_titles accordingly (still short phrases)."
    : "The user does not want adjacent roles: include_titles should focus tightly on the stated role.";
  return `Raw role string: ${role_raw}

${adjacentLine}

Respond with a single JSON object only (no markdown, no prose) with exactly these keys:
"include_titles" (array of non-empty strings),
"exclude_titles" (array of non-empty strings),
"seniority" (one of: "any", "junior", "mid", "senior").

No other keys. Strings must be non-empty after trimming.`;
}

const SYSTEM_PROMPT = `You output only valid JSON objects for job role matching. The object must have exactly the keys include_titles, exclude_titles, and seniority.`;

/**
 * Single LLM boundary for role spec: one HTTP call, strict JSON validation, or throws { code, message }.
 */
export async function generateRoleSpec(params: {
  role_raw: string;
  include_adjacent: boolean;
}): Promise<RoleSpec> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    throwRoleSpecFailed();
  }

  const model = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
  const url = "https://api.openai.com/v1/chat/completions";

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ROLE_SPEC_LLM_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: buildUserMessage(params.role_raw, params.include_adjacent),
          },
        ],
      }),
      signal: controller.signal,
    });
  } catch {
    throwRoleSpecFailed();
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    throwRoleSpecFailed();
  }

  let completion: unknown;
  try {
    completion = (await res.json()) as unknown;
  } catch {
    throwRoleSpecFailed();
  }

  const content = extractAssistantContent(completion);
  if (content === null) {
    throwRoleSpecFailed();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throwRoleSpecFailed();
  }

  return validateStrictRoleSpec(parsed);
}

function extractAssistantContent(completion: unknown): string | null {
  if (completion === null || typeof completion !== "object" || Array.isArray(completion)) {
    return null;
  }
  const choices = (completion as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length < 1) {
    return null;
  }
  const first = choices[0];
  if (first === null || typeof first !== "object" || Array.isArray(first)) {
    return null;
  }
  const message = (first as { message?: unknown }).message;
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string") {
    return null;
  }
  const trimmed = content.trim();
  return trimmed.length > 0 ? trimmed : null;
}
