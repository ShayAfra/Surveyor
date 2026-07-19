import {
  findDueMonitoringSavedSearches,
  reconcileActiveMonitoringExecutions,
  triggerMonitoringExecution,
} from "../lib/monitoring.js";

/** How often the backend checks for due monitored searches. */
export const MONITORING_POLL_INTERVAL_MS = Number(
  process.env.MONITORING_POLL_INTERVAL_MS ?? 60_000
);

/**
 * How often an enabled saved search is due for a repeat scan. Defaults to a
 * safe value for local development (long enough that enabling one search
 * does not spam scanner runs).
 */
export const MONITORING_FIXED_INTERVAL_MS = Number(
  process.env.MONITORING_FIXED_INTERVAL_MS ?? 6 * 60 * 60 * 1000
);

/**
 * One monitoring tick, separate from the scanner worker's workerTick.
 * Phase 1 reconciles RUNNING executions against their linked scanner run
 * status (detecting new matches once a run COMPLETEs). Phase 2 starts due,
 * enabled searches with no active execution via triggerMonitoringExecution -
 * the same helper POST /api/saved-searches/:id/monitoring/run-now uses, so
 * duplicate prevention is consistent between automatic and manual triggers.
 * Never processes scanner work inline: triggerMonitoringExecution only calls
 * createRunForUser, which inserts CREATED/PENDING rows and nothing else.
 */
export function monitoringTick(): void {
  try {
    reconcileActiveMonitoringExecutions();
  } catch (err) {
    // reconcileActiveMonitoringExecutions already isolates failures
    // per-execution internally; this guard is for failures before or
    // between those per-execution attempts (e.g. the initial query for
    // active executions), so one bad Phase 1 pass still lets Phase 2
    // due-search processing run on this tick.
    console.warn("monitoring: Phase 1 reconciliation failed for this tick:", err);
  }

  const dueSearches = findDueMonitoringSavedSearches(MONITORING_FIXED_INTERVAL_MS);
  for (const search of dueSearches) {
    try {
      triggerMonitoringExecution(search.user_id, search.id);
    } catch {
      // A search can race between the due-selection query and the trigger
      // call (e.g. run-now started an execution in between); skip and pick
      // it up again on the next tick rather than throwing out of the loop.
    }
  }
}

export function startMonitoringLoop(): void {
  setInterval(monitoringTick, MONITORING_POLL_INTERVAL_MS);
}
