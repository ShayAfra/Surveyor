import { describe, expect, it } from "vitest";
import { serializeErrorForTrace } from "../errorTrace.js";

describe("serializeErrorForTrace", () => {
  it("serializes Error instances with a stack preview", () => {
    const error = new Error("chromium executable missing");
    error.stack = `Error: chromium executable missing\n${"x".repeat(1200)}`;

    const serialized = serializeErrorForTrace(error);

    expect(serialized.error_name).toBe("Error");
    expect(serialized.error_message).toBe("chromium executable missing");
    expect(serialized.error_stack_preview).toHaveLength(1000);
  });

  it("safely serializes non-Error thrown values", () => {
    const serialized = serializeErrorForTrace({ code: "BROKEN" });

    expect(serialized.error_name).toBeNull();
    expect(serialized.error_message).toBe('{"code":"BROKEN"}');
    expect(serialized.error_stack_preview).toBeNull();
  });
});
