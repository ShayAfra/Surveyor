/**
 * Gate 3 tests for fetchJobDetailText (jobDetails.ts).
 *
 * All network I/O is replaced with vi.stubGlobal("fetch", ...), matching the
 * convention used in discovery.test.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJobDetailText } from "../jobDetails.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function htmlResponse(status: number, html: string): Response {
  return new Response(html, { status });
}

describe("fetchJobDetailText — success", () => {
  it("stores cleaned description_text for a successful HTML fetch", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        htmlResponse(
          200,
          `<html><body><h1>Software Engineer</h1><p>We build great things.</p></body></html>`
        )
    );

    const result = await fetchJobDetailText("https://example.com/jobs/1");

    expect(result.failure_code).toBeNull();
    expect(result.failure_reason).toBeNull();
    expect(result.description_text).toContain("Software Engineer");
    expect(result.description_text).toContain("We build great things.");
  });

  it("removes script/style/nav/footer/header/form content", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        htmlResponse(
          200,
          `<html><body>
            <nav>Site Nav Links</nav>
            <header>Site Header</header>
            <script>var x = "SECRET_SCRIPT_CONTENT";</script>
            <style>.a { color: red; } /* STYLE_CONTENT */</style>
            <form><input name="apply" /> FORM_CONTENT</form>
            <main><h1>Backend Engineer</h1><p>Real job description text.</p></main>
            <footer>Site Footer</footer>
          </body></html>`
        )
    );

    const result = await fetchJobDetailText("https://example.com/jobs/2");

    expect(result.description_text).toContain("Backend Engineer");
    expect(result.description_text).toContain("Real job description text.");
    expect(result.description_text).not.toContain("SECRET_SCRIPT_CONTENT");
    expect(result.description_text).not.toContain("STYLE_CONTENT");
    expect(result.description_text).not.toContain("FORM_CONTENT");
    expect(result.description_text).not.toContain("Site Nav Links");
    expect(result.description_text).not.toContain("Site Header");
    expect(result.description_text).not.toContain("Site Footer");
  });

  it("normalizes whitespace", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        htmlResponse(200, `<html><body><p>Line   one\n\n\n  Line   two\t\ttabbed</p></body></html>`)
    );

    const result = await fetchJobDetailText("https://example.com/jobs/3");

    expect(result.description_text).not.toMatch(/\s{2,}/);
  });

  it("caps stored text at JOB_DETAIL_MAX_TEXT_LENGTH (20000)", async () => {
    const longText = "a".repeat(30000);
    vi.stubGlobal("fetch", async () => htmlResponse(200, `<html><body><p>${longText}</p></body></html>`));

    const result = await fetchJobDetailText("https://example.com/jobs/4");

    expect(result.description_text).not.toBeNull();
    expect(result.description_text!.length).toBeLessThanOrEqual(20000);
  });
});

describe("fetchJobDetailText — failures", () => {
  it("returns JOB_DETAIL_BLOCKED on HTTP 403", async () => {
    vi.stubGlobal("fetch", async () => htmlResponse(403, "forbidden"));

    const result = await fetchJobDetailText("https://example.com/jobs/5");

    expect(result.failure_code).toBe("JOB_DETAIL_BLOCKED");
    expect(result.description_text).toBeNull();
  });

  it("returns JOB_DETAIL_BLOCKED on HTTP 429", async () => {
    vi.stubGlobal("fetch", async () => htmlResponse(429, "too many requests"));

    const result = await fetchJobDetailText("https://example.com/jobs/6");

    expect(result.failure_code).toBe("JOB_DETAIL_BLOCKED");
  });

  it("returns JOB_DETAIL_BLOCKED when content looks like a CAPTCHA challenge", async () => {
    vi.stubGlobal(
      "fetch",
      async () => htmlResponse(200, `<html><body>Please verify you are human via g-recaptcha</body></html>`)
    );

    const result = await fetchJobDetailText("https://example.com/jobs/7");

    expect(result.failure_code).toBe("JOB_DETAIL_BLOCKED");
  });

  it("returns JOB_DETAIL_TIMEOUT on abort", async () => {
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const resultPromise = fetchJobDetailText("https://example.com/jobs/8");
    const result = await resultPromise;

    expect(result.failure_code).toBe("JOB_DETAIL_TIMEOUT");
  }, 10000);

  it("returns JOB_DETAIL_FETCH_FAILED on network error", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });

    const result = await fetchJobDetailText("https://example.com/jobs/9");

    expect(result.failure_code).toBe("JOB_DETAIL_FETCH_FAILED");
  });

  it("returns JOB_DETAIL_FETCH_FAILED on non-OK, non-blocking HTTP status", async () => {
    vi.stubGlobal("fetch", async () => htmlResponse(500, "server error"));

    const result = await fetchJobDetailText("https://example.com/jobs/10");

    expect(result.failure_code).toBe("JOB_DETAIL_FETCH_FAILED");
  });

  it("returns JOB_DETAIL_EMPTY when usable text is empty after cleanup", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        htmlResponse(200, `<html><body><script>var x = 1;</script><nav>nav only</nav></body></html>`)
    );

    const result = await fetchJobDetailText("https://example.com/jobs/11");

    expect(result.failure_code).toBe("JOB_DETAIL_EMPTY");
  });

  it("does not throw for controlled failure cases", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("boom");
    });

    await expect(fetchJobDetailText("https://example.com/jobs/12")).resolves.toBeDefined();
  });
});
