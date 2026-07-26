import type {
  MonitoringConfigResponse,
  MonitoringExecutionListResponse,
  MonitoringExecutionResponse,
  MonitoringMatchListResponse,
  MonitoringRunNowResponse,
} from "@surveyor/shared";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { parseApiError } from "./apiErrors.js";

interface SavedSearchMonitoringProps {
  savedSearchId: string;
  onLoggedOut: () => void;
}

type LoadState =
  | { status: "loading" }
  | {
      status: "loaded";
      config: MonitoringConfigResponse;
      executions: MonitoringExecutionListResponse;
      matches: MonitoringMatchListResponse;
    }
  | { status: "error"; message: string };

function statusLabel(execution: MonitoringExecutionResponse): string {
  if (execution.status === "COMPLETED") {
    return execution.new_match_count > 0
      ? `Completed — ${execution.new_match_count} new match${execution.new_match_count === 1 ? "" : "es"}`
      : "Completed — no new matches";
  }
  if (execution.status === "FAILED") {
    return "Failed";
  }
  return "Running…";
}

export default function SavedSearchMonitoring({
  savedSearchId,
  onLoggedOut,
}: SavedSearchMonitoringProps) {
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [toggling, setToggling] = useState(false);
  const [runningNow, setRunningNow] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastRunNowRunId, setLastRunNowRunId] = useState<string | null>(null);

  // Fetches all three monitoring surfaces at once. Returns the resulting load
  // state (loaded/error), or null when a 401 was handled by logging out.
  async function fetchAll(): Promise<LoadState | null> {
    const [configRes, executionsRes, matchesRes] = await Promise.all([
      fetch(`/api/saved-searches/${savedSearchId}/monitoring`),
      fetch(`/api/saved-searches/${savedSearchId}/monitoring/executions`),
      fetch(`/api/saved-searches/${savedSearchId}/monitoring/matches`),
    ]);

    if (configRes.status === 401 || executionsRes.status === 401 || matchesRes.status === 401) {
      onLoggedOut();
      return null;
    }
    if (!configRes.ok || !executionsRes.ok || !matchesRes.ok) {
      return { status: "error", message: "Failed to load monitoring data" };
    }

    const config = (await configRes.json()) as MonitoringConfigResponse;
    const executions = (await executionsRes.json()) as MonitoringExecutionListResponse;
    const matches = (await matchesRes.json()) as MonitoringMatchListResponse;
    return { status: "loaded", config, executions, matches };
  }

  async function load(): Promise<void> {
    setState({ status: "loading" });
    const next = await fetchAll();
    if (next != null) {
      setState(next);
    }
  }

  function handleExpand() {
    const next = !expanded;
    setExpanded(next);
    if (next && state.status !== "loaded") {
      load().catch((err: unknown) => {
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Failed to load monitoring data",
        });
      });
    }
  }

  async function handleToggleEnabled(nextEnabled: boolean) {
    setActionError(null);
    setToggling(true);
    try {
      const res = await fetch(`/api/saved-searches/${savedSearchId}/monitoring`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      if (res.status === 401) {
        onLoggedOut();
        return;
      }
      if (!res.ok) {
        setActionError(await parseApiError(res, "Failed to update monitoring."));
        return;
      }
      await load();
    } catch {
      setActionError("Network error");
    } finally {
      setToggling(false);
    }
  }

  async function handleRunNow() {
    setActionError(null);
    setRunningNow(true);
    try {
      const res = await fetch(`/api/saved-searches/${savedSearchId}/monitoring/run-now`, {
        method: "POST",
      });
      if (res.status === 401) {
        onLoggedOut();
        return;
      }
      if (res.status === 409) {
        // Expected race: an execution is already active. Refresh to show it.
        setActionError("A monitoring run is already active for this saved search.");
        await load();
        return;
      }
      if (!res.ok) {
        setActionError(await parseApiError(res, "Failed to start monitoring run."));
        return;
      }
      const data = (await res.json()) as MonitoringRunNowResponse;
      // Validate the returned runId before offering a "View run" link.
      if (typeof data.runId !== "string" || data.runId.length === 0) {
        setActionError("The monitoring run started but returned an invalid response.");
        await load();
        return;
      }
      setLastRunNowRunId(data.runId);
      await load();
    } catch {
      setActionError("Network error");
    } finally {
      setRunningNow(false);
    }
  }

  const hasActiveExecution =
    state.status === "loaded" && state.executions.some((e) => e.status === "RUNNING");

  // Focused active-execution refresh: only while the panel is expanded and an
  // execution is RUNNING, poll quietly until it reaches a terminal state. There
  // is no other auto-refresh. Monitoring scheduling is unaffected — this only
  // re-reads existing monitoring state for display. Effect-local flags keep it
  // safe: `inFlight` prevents overlapping requests, `cancelled` prevents state
  // updates after unmount/deps-change, and every path is caught so a rejected
  // fetch/parse never becomes an unhandled rejection. On any failure the
  // existing content is preserved (no state change).
  useEffect(() => {
    if (!expanded || !hasActiveExecution) {
      return;
    }
    let cancelled = false;
    let inFlight = false;

    async function quietRefresh(): Promise<void> {
      if (inFlight || cancelled) {
        return;
      }
      inFlight = true;
      try {
        const next = await fetchAll();
        if (!cancelled && next != null && next.status === "loaded") {
          setState(next);
        }
      } catch {
        // Preserve existing content; a quiet refresh never surfaces transient errors.
      } finally {
        inFlight = false;
      }
    }

    const intervalId = window.setInterval(() => {
      void quietRefresh();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, hasActiveExecution]);

  return (
    <div style={{ marginTop: "0.5rem", paddingTop: "0.5rem", borderTop: "1px solid #ddd" }}>
      <button type="button" onClick={handleExpand}>
        {expanded ? "Hide monitoring" : "Monitoring"}
      </button>

      {expanded && (
        <div style={{ marginTop: "0.5rem" }}>
          {state.status === "loading" && <p>Loading monitoring…</p>}
          {state.status === "error" && <p role="alert">{state.message}</p>}

          {state.status === "loaded" && (
            <>
              <p className="muted">
                Monitoring reruns this saved search on a schedule to catch new matches. “Run
                monitoring check now” runs that check immediately. It is the same kind of ordinary
                scanner run as “Scan once” above — the difference is that monitoring also records
                which matches are new. Nothing is submitted or sent anywhere.
              </p>
              <div>
                <label>
                  <input
                    type="checkbox"
                    checked={state.config.enabled}
                    disabled={toggling}
                    onChange={(e) => handleToggleEnabled(e.target.checked)}
                  />{" "}
                  Monitoring enabled
                </label>
              </div>
              <div>
                Last checked:{" "}
                {state.config.last_checked_at != null
                  ? new Date(state.config.last_checked_at).toLocaleString()
                  : "never"}
              </div>
              <div>
                <button
                  type="button"
                  onClick={handleRunNow}
                  disabled={runningNow || hasActiveExecution}
                >
                  {runningNow ? "Starting…" : "Run monitoring check now"}
                </button>
              </div>
              {lastRunNowRunId != null && (
                <p>
                  Monitoring run started — <Link to={`/runs/${lastRunNowRunId}`}>View run</Link>
                </p>
              )}
              {actionError != null && <p role="alert">{actionError}</p>}

              <h4>Execution history</h4>
              {state.executions.length === 0 && <p>No monitoring runs yet.</p>}
              <ul>
                {state.executions.map((execution) => (
                  <li key={execution.id}>
                    <Link to={`/runs/${execution.run_id}`}>View run</Link> —{" "}
                    {statusLabel(execution)} —{" "}
                    {new Date(execution.started_at).toLocaleString()}
                    {execution.status === "FAILED" && (
                      <div className="muted">
                        The linked scanner run failed. Open the run above for details.
                      </div>
                    )}
                  </li>
                ))}
              </ul>

              <h4>Known matches</h4>
              <p className="muted">
                Each match links to the latest Surveyor run that recorded it, where you can review
                the recorded job evidence and use the fit, packet, and tracking actions to prepare to
                apply.
              </p>
              {state.matches.length === 0 && <p>No known matches yet.</p>}
              <ul>
                {state.matches.map((match) => (
                  <li key={match.id}>
                    <strong>{match.title}</strong> at {match.company_name}
                    {match.location != null && match.location !== "" && <> — {match.location}</>}
                    {" — "}
                    <a href={match.job_url} target="_blank" rel="noreferrer">
                      job link
                    </a>
                    <div>
                      First seen: {new Date(match.first_seen_at).toLocaleString()} · Last seen:{" "}
                      {new Date(match.last_seen_at).toLocaleString()} · Seen {match.seen_count}{" "}
                      time{match.seen_count === 1 ? "" : "s"}
                    </div>
                    <div>
                      <Link to={`/runs/${match.last_seen_run_id}`}>
                        Open latest evidence and prepare to apply
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
