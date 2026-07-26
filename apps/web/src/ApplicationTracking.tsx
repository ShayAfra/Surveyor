import type { ApplicationListResponse, ApplicationPacketListResponse } from "@surveyor/shared";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { parseApiError } from "./apiErrors.js";
import InlineError from "./InlineError.js";

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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadApplications() {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobRowId)}/applications`);
      if (res.status === 401) {
        onLoggedOut();
        return;
      }
      if (!res.ok) {
        setLoadError(await parseApiError(res, `Could not load tracking (${res.status}).`));
        return;
      }
      setApplications((await res.json()) as ApplicationListResponse);
    } catch {
      setLoadError("Network error while loading tracking.");
    } finally {
      setLoading(false);
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
      // Resolve which packet to link. If the parent already handed us one, use
      // it. Otherwise look up existing packets for this job now so a completed
      // packet is linked reliably — even if the packet panel was never opened.
      // If this lookup fails we abort without creating an unlinked application.
      let packetIdToLink: string | null = applicationPacketId ?? null;
      if (packetIdToLink === null) {
        let packets: ApplicationPacketListResponse;
        try {
          const packetsRes = await fetch(
            `/api/jobs/${encodeURIComponent(jobRowId)}/application-packets`,
          );
          if (packetsRes.status === 401) {
            onLoggedOut();
            return;
          }
          if (!packetsRes.ok) {
            setError(`Could not check for a completed packet (${packetsRes.status})`);
            return;
          }
          packets = (await packetsRes.json()) as ApplicationPacketListResponse;
        } catch {
          setError("Could not check for a completed packet");
          return;
        }
        // List is ordered newest first, so the first COMPLETED packet is the
        // newest completed one.
        const newestCompleted = packets.find((p) => p.status === "COMPLETED") ?? null;
        packetIdToLink = newestCompleted ? newestCompleted.id : null;
      }

      const res = await fetch(`/api/jobs/${encodeURIComponent(jobRowId)}/applications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          packetIdToLink ? { application_packet_id: packetIdToLink } : {}
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

  // Never render invisibly forever: while the initial lookup is in flight show
  // a loading line, and on failure show a retryable inline error instead of
  // silently rendering nothing.
  if (applications === null) {
    if (loading) {
      return <p className="muted">Loading tracking…</p>;
    }
    if (loadError != null) {
      return (
        <InlineError
          message={loadError}
          onRetry={() => {
            void loadApplications();
          }}
        />
      );
    }
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
