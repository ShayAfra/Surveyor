import type { ApplicationListResponse, ApplicationResponse } from "@surveyor/shared";
import { ApplicationTrackingStatus } from "@surveyor/shared";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { parseApiError } from "./apiErrors.js";
import InlineError from "./InlineError.js";
import AppHeader, { type AuthUser } from "./AppHeader.js";

interface ApplicationsPageProps {
  user: AuthUser;
  onLoggedOut: () => void;
}

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; applications: ApplicationListResponse }
  | { status: "error"; message: string };

const STATUS_OPTIONS = Object.values(ApplicationTrackingStatus);

/** Human-readable labels for stored tracking statuses. Display only — stored enum values are unchanged. */
const STATUS_LABELS: Record<string, string> = {
  [ApplicationTrackingStatus.SAVED]: "Saved",
  [ApplicationTrackingStatus.APPLIED]: "Applied",
  [ApplicationTrackingStatus.INTERVIEWING]: "Interviewing",
  [ApplicationTrackingStatus.OFFER]: "Offer",
  [ApplicationTrackingStatus.REJECTED]: "Rejected",
  [ApplicationTrackingStatus.WITHDRAWN]: "Withdrawn",
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

function toDatetimeLocalValue(epochMs: number | null): string {
  if (epochMs == null) {
    return "";
  }
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDatetimeLocalValue(value: string): number | null {
  if (value.trim() === "") {
    return null;
  }
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function ApplicationRow({
  application,
  onLoggedOut,
  onChanged,
}: {
  application: ApplicationResponse;
  onLoggedOut: () => void;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState(application.status);
  const [notes, setNotes] = useState(application.notes ?? "");
  const [appliedAt, setAppliedAt] = useState(toDatetimeLocalValue(application.applied_at));
  const [followUpAt, setFollowUpAt] = useState(toDatetimeLocalValue(application.follow_up_at));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    status !== application.status ||
    notes !== (application.notes ?? "") ||
    appliedAt !== toDatetimeLocalValue(application.applied_at) ||
    followUpAt !== toDatetimeLocalValue(application.follow_up_at);

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/applications/${encodeURIComponent(application.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          notes: notes.trim() === "" ? null : notes,
          applied_at: fromDatetimeLocalValue(appliedAt),
          follow_up_at: fromDatetimeLocalValue(followUpAt),
        }),
      });
      if (res.status === 401) {
        onLoggedOut();
        return;
      }
      if (!res.ok) {
        setError(await parseApiError(res));
        return;
      }
      onChanged();
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDetachPacket() {
    if (
      !window.confirm(
        "Detach this packet from the application? This removes only the link between the application and the packet. " +
          "The packet remains stored, and the application remains."
      )
    ) {
      return;
    }
    setError(null);
    try {
      const res = await fetch(`/api/applications/${encodeURIComponent(application.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ application_packet_id: null }),
      });
      if (res.status === 401) {
        onLoggedOut();
        return;
      }
      if (!res.ok) {
        // Do not imply success on a failed detach.
        setError(await parseApiError(res, "Could not detach the packet."));
        return;
      }
      onChanged();
    } catch {
      setError("Network error while detaching the packet.");
    }
  }

  async function handleDelete() {
    if (
      !window.confirm(
        "Delete this application? This deletes only the application tracking record. " +
          "It does not delete the scanner run or job evidence, and it does not delete the generated packet."
      )
    ) {
      return;
    }
    setError(null);
    try {
      const res = await fetch(`/api/applications/${encodeURIComponent(application.id)}`, {
        method: "DELETE",
      });
      if (res.status === 401) {
        onLoggedOut();
        return;
      }
      if (!res.ok) {
        // Do not imply success on a failed delete.
        setError(await parseApiError(res, "Could not delete this application."));
        return;
      }
      onChanged();
    } catch {
      setError("Network error while deleting this application.");
    }
  }

  return (
    <li style={{ marginBottom: "1rem", paddingBottom: "1rem", borderBottom: "1px solid #ccc" }}>
      <div>
        <strong>{application.job_title}</strong> at {application.company_name}
        {application.job_location != null && application.job_location !== "" && (
          <> · {application.job_location}</>
        )}
      </div>
      <div>
        <a href={application.job_url} target="_blank" rel="noreferrer">
          {application.job_url}
        </a>
      </div>
      <div>
        <Link to={`/runs/${application.run_id}`}>View run/job evidence</Link>
      </div>

      {application.linked_packet ? (
        <div>
          Linked packet: {application.linked_packet.status} (
          {new Date(application.linked_packet.created_at).toLocaleString()}){" "}
          <button type="button" onClick={handleDetachPacket}>
            Detach packet
          </button>
        </div>
      ) : (
        <div>No application packet linked.</div>
      )}

      <div style={{ marginTop: "0.5rem" }}>
        <label>
          Status{" "}
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ marginTop: "0.5rem" }}>
        <label>
          Notes
          <br />
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            style={{ width: "100%", maxWidth: "30rem" }}
          />
        </label>
      </div>

      <div style={{ marginTop: "0.5rem" }}>
        <label>
          Applied at{" "}
          <input
            type="datetime-local"
            value={appliedAt}
            onChange={(e) => setAppliedAt(e.target.value)}
          />
        </label>{" "}
        <label>
          Follow up at{" "}
          <input
            type="datetime-local"
            value={followUpAt}
            onChange={(e) => setFollowUpAt(e.target.value)}
          />
        </label>
      </div>

      {error != null && <p role="alert">{error}</p>}

      <div style={{ marginTop: "0.5rem" }}>
        <button type="button" onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save changes"}
        </button>{" "}
        <button type="button" onClick={handleDelete}>
          Delete
        </button>
      </div>
    </li>
  );
}

export default function ApplicationsPage({ user, onLoggedOut }: ApplicationsPageProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [statusFilter, setStatusFilter] = useState<string>("");

  async function load(): Promise<void> {
    const query = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : "";
    const res = await fetch(`/api/applications${query}`);
    if (res.status === 401) {
      onLoggedOut();
      return;
    }
    if (!res.ok) {
      setState({
        status: "error",
        message: await parseApiError(res, `Could not load applications (${res.status}).`),
      });
      return;
    }
    const applications = (await res.json()) as ApplicationListResponse;
    setState({ status: "loaded", applications });
  }

  useEffect(() => {
    load().catch((err: unknown) => {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Request failed",
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  return (
    <main>
      <AppHeader user={user} onLoggedOut={onLoggedOut} />
      <h1>Applications</h1>
      <p>
        A record of what you did with verified opportunities. You decide what happened — nothing
        here submits applications or contacts anyone on your behalf.
      </p>
      <p className="muted">
        “Saved” means you have recorded an opportunity but not yet marked further progress. Update
        the status as things move to applied, interviewing, offer, rejected, or withdrawn.
      </p>

      <section aria-labelledby="applications-filter-heading">
        <h2 id="applications-filter-heading">Filter</h2>
        <label>
          Status{" "}
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
        </label>
      </section>

      {state.status === "loading" && <p>Loading…</p>}
      {state.status === "error" && (
        <InlineError
          message={state.message}
          onRetry={() => {
            void load().catch((err: unknown) => {
              setState({
                status: "error",
                message: err instanceof Error ? err.message : "Request failed",
              });
            });
          }}
        />
      )}

      {state.status === "loaded" && (
        <section aria-labelledby="applications-list-heading">
          <h2 id="applications-list-heading">Tracked applications ({state.applications.length})</h2>
          {state.applications.length === 0 ? (
            <p>
              No applications are tracked yet. Start a scan, open a verified match, and choose Track
              application.
            </p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0 }}>
              {state.applications.map((application) => (
                <ApplicationRow
                  key={application.id}
                  application={application}
                  onLoggedOut={onLoggedOut}
                  onChanged={() => {
                    void load();
                  }}
                />
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
