import type {
  MonitoringConfigResponse,
  MonitoringExecutionListResponse,
  MonitoringExecutionResponse,
  MonitoringMatchListResponse,
  MonitoringRunNowResponse,
} from "@surveyor/shared";
import { useState } from "react";
import { Link } from "react-router-dom";

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

  async function load(): Promise<void> {
    setState({ status: "loading" });
    const [configRes, executionsRes, matchesRes] = await Promise.all([
      fetch(`/api/saved-searches/${savedSearchId}/monitoring`),
      fetch(`/api/saved-searches/${savedSearchId}/monitoring/executions`),
      fetch(`/api/saved-searches/${savedSearchId}/monitoring/matches`),
    ]);

    if (configRes.status === 401 || executionsRes.status === 401 || matchesRes.status === 401) {
      onLoggedOut();
      return;
    }
    if (!configRes.ok || !executionsRes.ok || !matchesRes.ok) {
      setState({ status: "error", message: "Failed to load monitoring data" });
      return;
    }

    const config = (await configRes.json()) as MonitoringConfigResponse;
    const executions = (await executionsRes.json()) as MonitoringExecutionListResponse;
    const matches = (await matchesRes.json()) as MonitoringMatchListResponse;
    setState({ status: "loaded", config, executions, matches });
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
        setActionError("Failed to update monitoring");
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
        setActionError("A monitoring run is already active for this saved search.");
        await load();
        return;
      }
      if (!res.ok) {
        setActionError("Failed to start monitoring run");
        return;
      }
      const data = (await res.json()) as MonitoringRunNowResponse;
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
