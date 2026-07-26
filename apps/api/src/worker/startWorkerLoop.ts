import { tryClaimNextCompany } from "./claimNextCompany.js";
import { processRoleSpecInitialization } from "./runRoleSpecInitialization.js";
import { tryCompleteRunsForReadyOrRunning } from "./tryCompleteRun.js";
import { safeErrorName } from "../lib/safeLog.js";

const WORKER_INTERVAL_MS = 500;

/**
 * Polls SQLite for work state on a fixed interval. No in-memory queue.
 * After a successful claim, the pipeline runs asynchronously (Step 3.5).
 */
async function workerTick(): Promise<void> {
  await processRoleSpecInitialization();
  tryCompleteRunsForReadyOrRunning();
  tryClaimNextCompany();
}

/**
 * Runs exactly one worker tick and guarantees it never rejects: an unexpected
 * failure in a single tick is caught and logged with safe metadata only, so it
 * cannot become an unhandled promise rejection and cannot stop later ticks.
 * This does not change tick ordering, worker ownership, concurrency, or the
 * scanner lifecycle — it only prevents one bad tick from taking down the loop.
 */
export async function runWorkerTickSafely(): Promise<void> {
  try {
    await workerTick();
  } catch (err) {
    console.error(`worker: unexpected tick failure (${safeErrorName(err)})`);
  }
}

export function startWorkerLoop(): void {
  setInterval(() => {
    void runWorkerTickSafely();
  }, WORKER_INTERVAL_MS);
}
