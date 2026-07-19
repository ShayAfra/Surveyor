import type { ApplicationListResponse } from "@surveyor/shared";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

interface ApplicationTrackingProps {
  jobRowId: string;
  applicationPacketId?: string;
  onLoggedOut: () => void;
}

/**
 * Small tracking control shown near a matched job (and reused near the
 * application packet widget with an optional applicationPacketId). Lets the
 * user create a recordkeeping application entry for this job, or shows that
 * one already exists — never submits, emails, or automates anything.
 */
export default function ApplicationTracking({
  jobRowId,
  applicationPacketId,
  onLoggedOut,
}: ApplicationTrackingProps) {
  const [applications, setApplications] = useState<ApplicationListResponse | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadApplications() {
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobRowId)}/applications`);
      if (res.status === 401) {
        onLoggedOut();
        return;
      }
      if (!res.ok) {
        setError(`Request failed (${res.status})`);
        return;
      }
      setApplications((await res.json()) as ApplicationListResponse);
    } catch {
      setError("Network error");
    }
  }

  useEffect(() => {
    void loadApplications();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobRowId]);

  async function handleTrack() {
    setError(null);
    setCreating(true);
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobRowId)}/applications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          applicationPacketId ? { application_packet_id: applicationPacketId } : {}
        ),
      });
      if (res.status === 401) {
        onLoggedOut();
        return;
      }
      const data: unknown = await res.json().catch(() => null);
      const body = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
      if (!res.ok) {
        const msg = typeof body.error === "string" ? body.error : `Request failed (${res.status})`;
        setError(msg);
        return;
      }
      await loadApplications();
    } catch {
      setError("Network error");
    } finally {
      setCreating(false);
    }
  }

  if (applications === null) {
    return null;
  }

  const existing = applications.length > 0 ? applications[0] : null;

  return (
    <div>
      {existing ? (
        <p>
          Tracked: {existing.status} — <Link to="/applications">View in Applications</Link>
        </p>
      ) : (
        <button type="button" onClick={handleTrack} disabled={creating}>
          {creating
            ? "Tracking…"
            : applicationPacketId
              ? "Track application with this packet"
              : "Track this application"}
        </button>
      )}
      {error != null && <p role="alert">{error}</p>}
    </div>
  );
}
