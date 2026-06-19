import { afterEach, describe, expect, it, vi } from "vitest";
import { generateRoleSpec } from "../roleSpec.js";
import { matchJobs } from "../matching.js";

function mockRoleSpecCompletion(roleSpec: unknown): void {
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify(roleSpec),
            },
          },
        ],
      }),
    }),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("matching raw Software Engineer title regression", () => {
  it("matches common Software Engineer title variants", () => {
    const matches = matchJobs(
      [
        {
          title: "Senior Software Engineer, GenAI Platform",
          location: null,
          url: "https://example.com/jobs/1",
        },
        {
          title: "Staff Software Engineer, ML Search",
          location: null,
          url: "https://example.com/jobs/2",
        },
        {
          title: "Android Software Engineer, Ad Formats",
          location: null,
          url: "https://example.com/jobs/3",
        },
      ],
      {
        include_titles: ["Software Engineer"],
        exclude_titles: [],
        seniority: "any",
      },
    );

    expect(matches.map((job) => job.title)).toEqual([
      "Senior Software Engineer, GenAI Platform",
      "Staff Software Engineer, ML Search",
      "Android Software Engineer, Ad Formats",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed boundary tests for generateRoleSpec
// ---------------------------------------------------------------------------

describe("generateRoleSpec — fail-closed: missing or invalid API key", () => {
  it("throws when OPENAI_API_KEY is an empty string", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    await expect(
      generateRoleSpec({ role_raw: "Software Engineer", include_adjacent: false }),
    ).rejects.toMatchObject({ code: "ROLE_SPEC_FAILED", message: "role spec generation failed" });
  });

  it("throws when OPENAI_API_KEY is whitespace only", async () => {
    vi.stubEnv("OPENAI_API_KEY", "   ");
    await expect(
      generateRoleSpec({ role_raw: "Software Engineer", include_adjacent: false }),
    ).rejects.toMatchObject({ code: "ROLE_SPEC_FAILED", message: "role spec generation failed" });
  });
});

describe("generateRoleSpec — fail-closed: network and HTTP errors", () => {
  it("throws when fetch rejects (network error / timeout)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    await expect(
      generateRoleSpec({ role_raw: "Software Engineer", include_adjacent: false }),
    ).rejects.toMatchObject({ code: "ROLE_SPEC_FAILED", message: "role spec generation failed" });
  });

  it("throws when HTTP response is not ok (429 rate limit)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    await expect(
      generateRoleSpec({ role_raw: "Software Engineer", include_adjacent: false }),
    ).rejects.toMatchObject({ code: "ROLE_SPEC_FAILED", message: "role spec generation failed" });
  });

  it("throws when HTTP response is not ok (500 server error)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(
      generateRoleSpec({ role_raw: "Software Engineer", include_adjacent: false }),
    ).rejects.toMatchObject({ code: "ROLE_SPEC_FAILED", message: "role spec generation failed" });
  });
});

describe("generateRoleSpec — fail-closed: malformed response structure", () => {
  it("throws when the response body has no choices field", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ model: "gpt-4o-mini" }),
    }));
    await expect(
      generateRoleSpec({ role_raw: "Software Engineer", include_adjacent: false }),
    ).rejects.toMatchObject({ code: "ROLE_SPEC_FAILED" });
  });

  it("throws when choices is an empty array", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [] }),
    }));
    await expect(
      generateRoleSpec({ role_raw: "Software Engineer", include_adjacent: false }),
    ).rejects.toMatchObject({ code: "ROLE_SPEC_FAILED" });
  });

  it("throws when message.content is null", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: null } }] }),
    }));
    await expect(
      generateRoleSpec({ role_raw: "Software Engineer", include_adjacent: false }),
    ).rejects.toMatchObject({ code: "ROLE_SPEC_FAILED" });
  });

  it("throws when message.content is malformed JSON", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "{not valid json" } }] }),
    }));
    await expect(
      generateRoleSpec({ role_raw: "Software Engineer", include_adjacent: false }),
    ).rejects.toMatchObject({ code: "ROLE_SPEC_FAILED" });
  });
});

describe("generateRoleSpec — fail-closed: strict JSON schema validation", () => {
  it("throws when LLM JSON has extra keys beyond the three required", async () => {
    mockRoleSpecCompletion({
      include_titles: ["Software Engineer"],
      exclude_titles: [],
      seniority: "any",
      extra_key: "unexpected",
    });
    await expect(
      generateRoleSpec({ role_raw: "Software Engineer", include_adjacent: false }),
    ).rejects.toMatchObject({ code: "ROLE_SPEC_FAILED" });
  });

  it("throws when include_titles contains a null item", async () => {
    mockRoleSpecCompletion({
      include_titles: [null],
      exclude_titles: [],
      seniority: "any",
    });
    await expect(
      generateRoleSpec({ role_raw: "Software Engineer", include_adjacent: false }),
    ).rejects.toMatchObject({ code: "ROLE_SPEC_FAILED" });
  });

  it("throws when include_titles contains an empty string after trimming", async () => {
    mockRoleSpecCompletion({
      include_titles: ["Software Engineer", ""],
      exclude_titles: [],
      seniority: "any",
    });
    await expect(
      generateRoleSpec({ role_raw: "Software Engineer", include_adjacent: false }),
    ).rejects.toMatchObject({ code: "ROLE_SPEC_FAILED" });
  });

  it("throws when exclude_titles contains a null item", async () => {
    mockRoleSpecCompletion({
      include_titles: ["Software Engineer"],
      exclude_titles: [null],
      seniority: "any",
    });
    await expect(
      generateRoleSpec({ role_raw: "Software Engineer", include_adjacent: false }),
    ).rejects.toMatchObject({ code: "ROLE_SPEC_FAILED" });
  });

  it("throws when seniority is an unrecognized value", async () => {
    mockRoleSpecCompletion({
      include_titles: ["Software Engineer"],
      exclude_titles: [],
      seniority: "expert",
    });
    await expect(
      generateRoleSpec({ role_raw: "Software Engineer", include_adjacent: false }),
    ).rejects.toMatchObject({ code: "ROLE_SPEC_FAILED" });
  });
});

// ---------------------------------------------------------------------------
// Empty include_titles handling — documents current behavior (NOT fail-closed)
//
// validateStrictRoleSpec accepts an empty array (no items to validate).
// The returned spec has empty include_titles, which will match nothing.
// ---------------------------------------------------------------------------
describe("generateRoleSpec — empty include_titles from LLM does not throw (not fail-closed)", () => {
  it("does not throw when LLM returns empty include_titles", async () => {
    mockRoleSpecCompletion({ include_titles: [], exclude_titles: [], seniority: "any" });
    const spec = await generateRoleSpec({ role_raw: "Software Engineer", include_adjacent: false });
    expect(spec.include_titles).toEqual([]);
  });
});
