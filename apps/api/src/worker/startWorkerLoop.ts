import { tryClaimNextCompany } from "./claimNextCompany.js";
import { processRoleSpecInitialization } from "./runRoleSpecInitialization.js";
import { tryCompleteRunsForReadyOrRunning } from "./tryCompleteRun.js";

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

export function startWorkerLoop(): void {
  setInterval(workerTick, WORKER_INTERVAL_MS);
}
