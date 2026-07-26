/**
 * Milestone 3 tests for the monitoring loop guard (startMonitoringLoop.ts).
 *
 *   - A due-search query failure must not escape the interval callback.
 *   - An expected 409 race on trigger stays quiet.
 *   - An unexpected trigger failure is logged (with the saved search id only)
 *     and does not stop the loop from processing later searches/ticks.
 *
 * The monitoring lib is mocked so no real DB or scanner work runs — this test
 * only verifies the tick's guard/logging behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/monitoring.js", () => ({
  MonitoringRequestError: class MonitoringRequestError extends Error {
    httpStatus: number;
    constructor(httpStatus: number, message: string) {
      super(message);
      this.httpStatus = httpStatus;
    }
  },
  reconcileActiveMonitoringExecutions: vi.fn(),
  findDueMonitoringSavedSearches: vi.fn(),
  triggerMonitoringExecution: vi.fn(),
}));

import {
  MonitoringRequestError,
  findDueMonitoringSavedSearches,
  triggerMonitoringExecution,
} from "../../lib/monitoring.js";
import { monitoringTick } from "../startMonitoringLoop.js";

const findDueMock = vi.mocked(findDueMonitoringSavedSearches);
const triggerMock = vi.mocked(triggerMonitoringExecution);

describe("monitoringTick — Phase 2 guard", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("does not let a due-search query failure escape the tick", () => {
    findDueMock.mockImplementation(() => {
      throw new Error("due-query boom");
    });

    expect(() => monitoringTick()).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("stays quiet on an expected 409 race during trigger", () => {
    findDueMock.mockReturnValue([{ id: "search-1", user_id: "user-1" }]);
    triggerMock.mockImplementation(() => {
      throw new MonitoringRequestError(409, "a monitoring execution is already active");
    });

    expect(() => monitoringTick()).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("logs an unexpected trigger failure and continues", () => {
    findDueMock.mockReturnValue([
      { id: "search-1", user_id: "user-1" },
      { id: "search-2", user_id: "user-1" },
    ]);
    triggerMock.mockImplementation(() => {
      throw new Error("unexpected trigger failure");
    });

    expect(() => monitoringTick()).not.toThrow();
    // One warn per failing search — later searches keep being attempted.
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(triggerMock).toHaveBeenCalledTimes(2);
  });
});
