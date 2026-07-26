/**
 * Milestone 3 test for the worker loop guard (startWorkerLoop.ts).
 *
 * A single worker tick that throws unexpectedly must be caught and logged
 * (safe metadata only) rather than becoming an unhandled promise rejection, so
 * later ticks keep running. The tick's dependencies are mocked so no real DB or
 * scanner work is exercised — this test only verifies the guard behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../claimNextCompany.js", () => ({
  tryClaimNextCompany: vi.fn(() => {
    throw new Error("boom from claim");
  }),
}));

vi.mock("../runRoleSpecInitialization.js", () => ({
  processRoleSpecInitialization: vi.fn(async () => {}),
}));

vi.mock("../tryCompleteRun.js", () => ({
  tryCompleteRunsForReadyOrRunning: vi.fn(() => {}),
}));

import { runWorkerTickSafely } from "../startWorkerLoop.js";

describe("runWorkerTickSafely", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("catches an unexpected tick failure instead of rejecting", async () => {
    await expect(runWorkerTickSafely()).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
  });
});
