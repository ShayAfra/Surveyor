import type {
  ApplicationPacketResponse,
  FitAnalysisResponse,
  JobRowResponse,
  RunCompanyResponse,
  RunDetailResponse,
} from "@surveyor/shared";
import { CompanyStatus, RunStatus } from "@surveyor/shared";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Link, Route, Routes, useNavigate, useParams } from "react-router-dom";
import {
  exportCombinedCsv,
  exportMatchesCsv,
  exportNoMatchCsv,
  exportUnverifiedCsv,
} from "./csvExport.js";
import ProfilePage from "./ProfilePage.js";
import SavedPage from "./SavedPage.js";
import ApplicationsPage from "./ApplicationsPage.js";
import ApplicationTracking from "./ApplicationTracking.js";
import AppHeader, { type AuthUser } from "./AppHeader.js";

type HealthState =
  | { status: "loading" }
  | { status: "ok"; body: { ok: boolean } }
  | { status: "error"; message: string };

type AuthGateState =
  | { status: "loading" }
  | { status: "authenticated"; user: AuthUser }
  | { status: "unauthenticated" };

async function fetchCurrentUser(): Promise<AuthUser | null> {
  const res = await fetch("/api/auth/me");
  if (res.status === 401) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.json()) as AuthUser;
}

function LoginPage({ onAuthenticated }: { onAuthenticated: (user: AuthUser) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const res = await fetch(mode === "login" ? "/api/auth/login" : "/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data: unknown = await res.json().catch(() => null);
      const body = data && typeof data === "object" ? (data as Record<string, unknown>) : {};

      if (!res.ok) {
        const msg =
          typeof body.error === "string" ? body.error : `Request failed (${res.status})`;
        setError(msg);
        return;
      }

      onAuthenticated(body as unknown as AuthUser);
    } catch {
      setError("Network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main>
      <h1>Surveyor</h1>
      <p>
        Surveyor checks official company careers sources, helps you understand verified
        opportunities, prepares evidence-grounded application materials, and keeps your next steps
        organized.
      </p>
      <section aria-labelledby="auth-heading">
        <h2 id="auth-heading">{mode === "login" ? "Log in" : "Sign up"}</h2>
        <form onSubmit={handleSubmit}>
          <div>
            <label htmlFor="auth-email">Email</label>
            <input
              id="auth-email"
              name="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
            />
          </div>
          <div>
            <label htmlFor="auth-password">Password</label>
            <input
              id="auth-password"
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </div>
          {error && <p role="alert">{error}</p>}
          <button type="submit" disabled={submitting}>
            {submitting ? "Submitting…" : mode === "login" ? "Log in" : "Sign up"}
          </button>
        </form>
        <button
          type="button"
          onClick={() => {
            setMode(mode === "login" ? "signup" : "login");
            setError(null);
          }}
        >
          {mode === "login" ? "Need an account? Sign up" : "Already have an account? Log in"}
        </button>
      </section>
    </main>
  );
}

function HomePage({ user, onLoggedOut }: { user: AuthUser; onLoggedOut: () => void }) {
  const navigate = useNavigate();
  const [health, setHealth] = useState<HealthState>({ status: "loading" });
  const [role, setRole] = useState("");
  const [companiesText, setCompaniesText] = useState("");
  const [includeAdjacent, setIncludeAdjacent] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/health")
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return res.json() as Promise<{ ok: boolean }>;
      })
      .then((body) => {
        if (!cancelled) {
          setHealth({ status: "ok", body });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setHealth({
            status: "error",
            message: err instanceof Error ? err.message : "Request failed",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    const trimmedRole = role.trim();
    const companyLines = companiesText.split(/\r?\n/).map((line) => line.trim());

    if (trimmedRole.length === 0) {
      setSubmitError("Role must be non-empty after trimming");
      return;
    }

    if (companyLines.length < 1 || companyLines.length > 10) {
      setSubmitError("Companies must be between 1 and 10 lines");
      return;
    }

    if (companyLines.some((c) => c.length === 0)) {
      setSubmitError("Each company line must be non-empty after trimming");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: trimmedRole,
          includeAdjacent,
          companies: companyLines,
        }),
      });

      if (res.status === 401) {
        onLoggedOut();
        return;
      }

      const data: unknown = await res.json().catch(() => null);
      const body = data && typeof data === "object" ? (data as Record<string, unknown>) : {};

      if (!res.ok) {
        const msg =
          typeof body.error === "string" ? body.error : `Request failed (${res.status})`;
        setSubmitError(msg);
        return;
      }

      const runId = body.runId;
      if (typeof runId !== "string" || runId.length === 0) {
        setSubmitError("Invalid response: missing runId");
        return;
      }

      navigate(`/runs/${runId}`);
    } catch {
      setSubmitError("Network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main>
      <AppHeader user={user} onLoggedOut={onLoggedOut} />
      <h1>Surveyor</h1>
      {health.status === "error" && (
        <p role="alert">
          Surveyor’s API is unavailable right now ({health.message}). Scans cannot start until it
          reconnects.
        </p>
      )}

      <section aria-labelledby="how-it-works-heading" className="info-box">
        <h2 id="how-it-works-heading">How Surveyor works</h2>
        <p>
          Enter one role and 1–10 target companies. Surveyor checks official careers sources and
          reports matches, completed scans with no matching role, or results it could not
          confidently verify.
        </p>
        <ol>
          <li>Add profile and resume context.</li>
          <li>Start a scan for one role across up to 10 companies.</li>
          <li>Review matches, no matches, and unverified results.</li>
          <li>Analyze fit and generate an application packet.</li>
          <li>Save searches, monitor new matches, and track applications.</li>
        </ol>
      </section>

      <section aria-labelledby="run-form-heading">
        <h2 id="run-form-heading">Start a scan</h2>
        <form onSubmit={handleSubmit}>
          <div>
            <label htmlFor="run-role">Role</label>
            <input
              id="run-role"
              name="role"
              type="text"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div>
            <label htmlFor="run-companies">Companies</label>
            <textarea
              id="run-companies"
              name="companies"
              value={companiesText}
              onChange={(e) => setCompaniesText(e.target.value)}
              rows={6}
            />
          </div>
          <div>
            <input
              id="run-include-adjacent"
              name="includeAdjacent"
              type="checkbox"
              checked={includeAdjacent}
              onChange={(e) => setIncludeAdjacent(e.target.checked)}
            />
            <label htmlFor="run-include-adjacent">Include adjacent roles</label>
          </div>
          {submitError && (
            <p role="alert">{submitError}</p>
          )}
          <button type="submit" disabled={submitting}>
            {submitting ? "Submitting…" : "Start scan"}
          </button>
        </form>
      </section>
    </main>
  );
}

function sortCompaniesByInputIndex(companies: RunCompanyResponse[]): RunCompanyResponse[] {
  return [...companies].sort((a, b) => a.input_index - b.input_index);
}

/** Plain-language description of a persisted run status (does not change the status). */
function runStatusPlainLanguage(status: string): string {
  switch (status) {
    case RunStatus.CREATED:
    case RunStatus.READY:
      return "Preparing to scan";
    case RunStatus.RUNNING:
      return "Scanning in progress";
    case RunStatus.COMPLETED:
      return "Scan complete";
    case RunStatus.FAILED_ROLE_SPEC:
      return "Could not interpret the role";
    default:
      return status;
  }
}

/** Renders persisted company evidence only (no inferred state). */
function CompanyEvidence({ company }: { company: RunCompanyResponse }) {
  const lines: { label: string; node: ReactNode }[] = [];

  if (company.careers_url != null && company.careers_url !== "") {
    lines.push({
      label: "Careers URL",
      node: (
        <a href={company.careers_url} target="_blank" rel="noreferrer">
          {company.careers_url}
        </a>
      ),
    });
  }

  if (company.listings_scanned != null) {
    lines.push({
      label: "Listings scanned",
      node: String(company.listings_scanned),
    });
  }

  if (company.failure_reason != null && company.failure_reason !== "") {
    lines.push({
      label: "Failure reason",
      node: company.failure_reason,
    });
  }

  if (lines.length === 0) {
    return null;
  }

  return (
    <ul style={{ margin: "0.25rem 0 0 1rem", padding: 0, listStyle: "disc" }}>
      {lines.map(({ label, node }) => (
        <li key={label}>
          <strong>{label}:</strong> {node}
        </li>
      ))}
    </ul>
  );
}

function EvidenceItemList({ items }: { items: { text: string; evidence: string }[] }) {
  if (items.length === 0) {
    return <p>None noted.</p>;
  }
  return (
    <ul>
      {items.map((item, i) => (
        <li key={i}>
          {item.text} <em>({item.evidence})</em>
        </li>
      ))}
    </ul>
  );
}

/** Fetches, generates, and displays fit analyses for one matched job. Minimal, additive to the run view. */
function JobFitAnalysis({
  jobRowId,
  onLoggedOut,
  profileHref,
}: {
  jobRowId: string;
  onLoggedOut: () => void;
  profileHref: string;
}) {
  const [analyses, setAnalyses] = useState<FitAnalysisResponse[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  async function loadAnalyses() {
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobRowId)}/fit-analysis`);
      if (res.status === 401) {
        onLoggedOut();
        return;
      }
      if (!res.ok) {
        setError(`Request failed (${res.status})`);
        return;
      }
      setAnalyses((await res.json()) as FitAnalysisResponse[]);
    } catch {
      setError("Network error");
    }
  }

  useEffect(() => {
    if (expanded && analyses === null) {
      void loadAnalyses();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  async function handleAnalyze() {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobRowId)}/fit-analysis`, {
        method: "POST",
      });
      if (res.status === 401) {
        onLoggedOut();
        return;
      }
      const data: unknown = await res.json().catch(() => null);
      const body = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
      if (!res.ok) {
        const msg =
          typeof body.error === "string" ? body.error : `Request failed (${res.status})`;
        setError(msg);
        return;
      }
      await loadAnalyses();
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(analysisId: string) {
    const res = await fetch(`/api/fit-analyses/${encodeURIComponent(analysisId)}`, {
      method: "DELETE",
    });
    if (res.status === 401) {
      onLoggedOut();
      return;
    }
    await loadAnalyses();
  }

  const latest = analyses && analyses.length > 0 ? analyses[0] : null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? "Hide fit analysis" : "Analyze fit"}
      </button>
      {expanded && (
        <div style={{ marginLeft: "1rem", marginTop: "0.5rem" }}>
          <p className="muted">
            Compare stored job evidence with your profile or resume. Fit analysis does not change the
            scanner result.
          </p>
          <button type="button" onClick={handleAnalyze} disabled={loading}>
            {loading ? "Analyzing…" : "Generate new analysis"}
          </button>
          {error != null && <p role="alert">{error}</p>}

          {latest && (
            <div>
              {latest.status === "FAILED" ? (
                <p role="alert">
                  Analysis attempt failed: {latest.failure_reason ?? latest.failure_code ?? "unknown error"}
                </p>
              ) : (
                <>
                  <p>{latest.fit_summary}</p>
                  {latest.caveats && latest.caveats.length > 0 && (
                    <p>
                      <strong>Caveats:</strong> {latest.caveats.join(" ")}
                    </p>
                  )}
                  <h4>Strengths</h4>
                  <EvidenceItemList items={latest.strengths ?? []} />
                  <h4>Gaps</h4>
                  <EvidenceItemList items={latest.gaps ?? []} />
                  <h4>Risks</h4>
                  <EvidenceItemList items={latest.risks ?? []} />
                  <h4>Suggested next steps</h4>
                  <EvidenceItemList items={latest.suggested_next_steps ?? []} />
                </>
              )}
              <button type="button" onClick={() => handleDelete(latest.id)}>
                Delete this analysis
              </button>
            </div>
          )}

          {analyses != null && analyses.length === 0 && <p>No fit analysis yet.</p>}

          {error != null && error.toLowerCase().includes("no usable profile or resume") && (
            <p>
              <Link to={profileHref}>Add profile or resume information</Link> to enable fit analysis.
            </p>
          )}

          {analyses != null && analyses.length > 1 && (
            <details>
              <summary>Previous analyses ({analyses.length - 1})</summary>
              <ul>
                {analyses.slice(1).map((a) => (
                  <li key={a.id}>
                    {new Date(a.created_at).toLocaleString()} — {a.status}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function ApplicationPacket({
  jobRowId,
  onLoggedOut,
  profileHref,
  onLatestCompletedPacket,
}: {
  jobRowId: string;
  onLoggedOut: () => void;
  profileHref: string;
  onLatestCompletedPacket: (packetId: string | null) => void;
}) {
  const [packets, setPackets] = useState<ApplicationPacketResponse[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  async function loadPackets() {
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobRowId)}/application-packets`);
      if (res.status === 401) {
        onLoggedOut();
        return;
      }
      if (!res.ok) {
        setError(`Request failed (${res.status})`);
        return;
      }
      setPackets((await res.json()) as ApplicationPacketResponse[]);
    } catch {
      setError("Network error");
    }
  }

  useEffect(() => {
    if (expanded && packets === null) {
      void loadPackets();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  // Report the newest COMPLETED packet upward so the single job-level tracking
  // control can link it. The list is ordered newest first, so the first
  // COMPLETED packet is the newest completed one — a newer FAILED packet must
  // not hide an older completed packet. Keeps packet linkage without a
  // competing control here.
  useEffect(() => {
    if (packets === null) {
      return;
    }
    const newestCompleted = packets.find((p) => p.status === "COMPLETED") ?? null;
    onLatestCompletedPacket(newestCompleted ? newestCompleted.id : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packets]);

  async function handleGenerate() {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobRowId)}/application-packets`, {
        method: "POST",
      });
      if (res.status === 401) {
        onLoggedOut();
        return;
      }
      const data: unknown = await res.json().catch(() => null);
      const body = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
      if (!res.ok) {
        const msg =
          typeof body.error === "string" ? body.error : `Request failed (${res.status})`;
        setError(msg);
        return;
      }
      await loadPackets();
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(packetId: string) {
    const res = await fetch(`/api/application-packets/${encodeURIComponent(packetId)}`, {
      method: "DELETE",
    });
    if (res.status === 401) {
      onLoggedOut();
      return;
    }
    await loadPackets();
  }

  const latest = packets && packets.length > 0 ? packets[0] : null;

  return (
    <div>
      <button type="button" onClick={() => setExpanded((v) => !v)}>
        {expanded ? "Hide application packet" : "Generate application packet"}
      </button>
      {expanded && (
        <div style={{ marginLeft: "1rem", marginTop: "0.5rem" }}>
          <p className="muted">
            Create draft materials from stored job and user evidence. Review everything before use;
            Surveyor never submits applications.
          </p>
          <button type="button" onClick={handleGenerate} disabled={loading}>
            {loading ? "Generating…" : "Generate new packet"}
          </button>
          {error != null && <p role="alert">{error}</p>}

          {latest && (
            <div>
              {latest.status === "FAILED" ? (
                <p role="alert">
                  Packet generation attempt failed:{" "}
                  {latest.failure_reason ?? latest.failure_code ?? "unknown error"}
                </p>
              ) : (
                <>
                  <h4>Packet summary</h4>
                  <p>{latest.packet_summary}</p>

                  {latest.caveats && latest.caveats.length > 0 && (
                    <p>
                      <strong>Caveats:</strong> {latest.caveats.join(" ")}
                    </p>
                  )}

                  <h4>Positioning notes</h4>
                  <EvidenceItemList items={latest.positioning_notes ?? []} />

                  <h4>Draft cover letter</h4>
                  <p>Review before using.</p>
                  <p style={{ whiteSpace: "pre-wrap" }}>{latest.cover_letter_draft}</p>

                  <h4>Resume bullet suggestions</h4>
                  <p>Suggestions only — your stored resume is not changed.</p>
                  <EvidenceItemList items={latest.resume_bullet_suggestions ?? []} />

                  <h4>Talking points</h4>
                  <EvidenceItemList items={latest.talking_points ?? []} />

                  <h4>Questions to prepare</h4>
                  <EvidenceItemList items={latest.questions_to_prepare ?? []} />
                </>
              )}
              <button type="button" onClick={() => handleDelete(latest.id)}>
                Delete this packet
              </button>
            </div>
          )}

          {packets != null && packets.length === 0 && <p>No application packet yet.</p>}

          {error != null && error.toLowerCase().includes("no usable profile or resume") && (
            <p>
              <Link to={profileHref}>Add profile or resume information</Link> to enable application
              packet generation.
            </p>
          )}

          {packets != null && packets.length > 1 && (
            <details>
              <summary>Previous packets ({packets.length - 1})</summary>
              <ul>
                {packets.slice(1).map((p) => (
                  <li key={p.id}>
                    {new Date(p.created_at).toLocaleString()} — {p.status}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One matched job with its fit / packet / tracking tools in a clear order.
 * Holds the newest completed packet id so a single tracking control can link
 * it — there is exactly one tracking control per matched job.
 */
function MatchedJob({
  job,
  onLoggedOut,
  profileHref,
}: {
  job: JobRowResponse;
  onLoggedOut: () => void;
  profileHref: string;
}) {
  const [latestCompletedPacketId, setLatestCompletedPacketId] = useState<string | null>(null);

  return (
    <li>
      <a href={job.url} target="_blank" rel="noreferrer">
        {job.title}
      </a>
      {job.location != null && job.location !== "" && ` · ${job.location}`}
      {job.match_reason && ` · ${job.match_reason}`}
      {job.job_detail_available ? (
        <p className="muted">Full job detail recorded.</p>
      ) : job.job_detail_failure_code != null || job.job_detail_failure_reason != null ? (
        <p className="muted">
          Job detail fetch failed, but the matched job is still recorded as scanner evidence.
        </p>
      ) : null}
      <p className="muted">
        For each match: understand the verified match, analyze fit, prepare a packet, then track the
        application.
      </p>
      <JobFitAnalysis jobRowId={job.id} onLoggedOut={onLoggedOut} profileHref={profileHref} />
      <ApplicationPacket
        jobRowId={job.id}
        onLoggedOut={onLoggedOut}
        profileHref={profileHref}
        onLatestCompletedPacket={setLatestCompletedPacketId}
      />
      <div>
        <p className="muted">
          Tracking records your own next steps. Surveyor does not submit applications.
        </p>
        <ApplicationTracking
          jobRowId={job.id}
          applicationPacketId={latestCompletedPacketId ?? undefined}
          onLoggedOut={onLoggedOut}
        />
      </div>
    </li>
  );
}

function RunDetailPage({ user, onLoggedOut }: { user: AuthUser; onLoggedOut: () => void }) {
  const { id } = useParams();
  const [detail, setDetail] = useState<RunDetailResponse | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  const sortedCompanies = useMemo(
    () => (detail ? sortCompaniesByInputIndex(detail.companies) : []),
    [detail],
  );

  const jobsByCompanyId = useMemo(() => {
    const map = new Map<string, JobRowResponse[]>();
    if (!detail) {
      return map;
    }
    for (const job of detail.matched_jobs) {
      const list = map.get(job.company_id);
      if (list) {
        list.push(job);
      } else {
        map.set(job.company_id, [job]);
      }
    }
    return map;
  }, [detail]);

  useEffect(() => {
    if (id === undefined || id === "") {
      return;
    }
    const runId: string = id;

    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);

        if (res.status === 401) {
          if (!cancelled) {
            onLoggedOut();
          }
          return;
        }

        if (res.status === 404) {
          if (!cancelled) {
            setPollError("Run not found");
          }
          return;
        }

        if (!res.ok) {
          if (!cancelled) {
            setPollError(`Request failed (${res.status})`);
          }
          return;
        }
        const body = (await res.json()) as RunDetailResponse;
        if (!cancelled) {
          setPollError(null);
          setDetail(body);
        }
      } catch {
        if (!cancelled) {
          setPollError("Network error");
        }
      }
    }

    void poll();
    const intervalId = window.setInterval(poll, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [id, onLoggedOut]);

  const pendingInProgress = sortedCompanies.filter(
    (c) => c.status === CompanyStatus.PENDING || c.status === CompanyStatus.IN_PROGRESS,
  );
  const matchesCompanies = sortedCompanies.filter((c) => c.status === CompanyStatus.MATCHES_FOUND);
  const noMatchCompanies = sortedCompanies.filter(
    (c) => c.status === CompanyStatus.NO_MATCH_SCAN_COMPLETED,
  );
  const unverifiedCompanies = sortedCompanies.filter(
    (c) => c.status === CompanyStatus.UNVERIFIED || c.status === CompanyStatus.CANCELLED,
  );

  const failedRoleSpec = detail?.run.status === RunStatus.FAILED_ROLE_SPEC;

  // Context-preserving link so Profile can offer a return path to this run.
  const runPath = id != null && id !== "" ? `/runs/${id}` : null;
  const profileHref = runPath
    ? `/profile?returnTo=${encodeURIComponent(runPath)}`
    : "/profile";

  return (
    <main>
      <AppHeader user={user} onLoggedOut={onLoggedOut} />
      <h1>Run detail</h1>
      {pollError != null && <p role="alert">{pollError}</p>}
      {detail != null && (
        <>
          <p>
            Searched role: <strong>{detail.run.role_raw}</strong>
          </p>
          <p className="muted">
            {detail.run.include_adjacent
              ? "Adjacent roles are included in matching."
              : "Only the specified role is matched."}
          </p>
          <p>
            Status: <strong>{runStatusPlainLanguage(detail.run.status)}</strong> · Companies:{" "}
            {detail.companies.length} · Matched jobs: {detail.matched_jobs.length}
          </p>

          {detail.run.status === RunStatus.COMPLETED && id != null && id !== "" && (
            <section aria-labelledby="run-export-heading">
              <h2 id="run-export-heading">Export</h2>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                <button
                  type="button"
                  onClick={() => {
                    exportMatchesCsv(detail, id);
                  }}
                >
                  Export matches CSV
                </button>
                <button
                  type="button"
                  onClick={() => {
                    exportNoMatchCsv(detail, id);
                  }}
                >
                  Export no match CSV
                </button>
                <button
                  type="button"
                  onClick={() => {
                    exportUnverifiedCsv(detail, id);
                  }}
                >
                  Export unverified CSV
                </button>
                <button
                  type="button"
                  onClick={() => {
                    exportCombinedCsv(detail, id);
                  }}
                >
                  Export combined CSV
                </button>
              </div>
            </section>
          )}

          {failedRoleSpec ? (
            <>
              <section aria-labelledby="run-terminal-error-heading">
                <h2 id="run-terminal-error-heading">Role specification failed</h2>
                <p role="alert">
                  {detail.run.error_message ?? ""}
                </p>
              </section>
              <section aria-labelledby="run-companies-transparency-heading">
                <h2 id="run-companies-transparency-heading">Companies</h2>
                <ul>
                  {sortedCompanies.map((c) => (
                    <li key={c.id}>
                      <strong>{c.company_name}</strong> — {c.status}
                      <CompanyEvidence company={c} />
                    </li>
                  ))}
                </ul>
              </section>
            </>
          ) : (
            <>
              <section aria-labelledby="run-active-companies-heading">
                <h2 id="run-active-companies-heading">In progress</h2>
                <p className="muted">Still scanning.</p>
                {pendingInProgress.length === 0 ? (
                  <p>No companies in this category yet.</p>
                ) : (
                  <ul>
                    {pendingInProgress.map((c) => (
                      <li key={c.id}>
                        <div>
                          {c.input_index}: {c.company_name} — {c.status}
                        </div>
                        <CompanyEvidence company={c} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section aria-labelledby="matches-heading">
                <h2 id="matches-heading">Matches</h2>
                <p className="muted">
                  Surveyor completed the company scan and found one or more jobs matching this run’s
                  role criteria.
                </p>
                {matchesCompanies.length === 0 ? (
                  <p>No companies in this category yet.</p>
                ) : (
                  <ul>
                    {matchesCompanies.map((c) => {
                      const jobs = jobsByCompanyId.get(c.id) ?? [];
                      return (
                        <li key={c.id}>
                          <div>
                            {c.input_index}: {c.company_name} — {c.status}
                          </div>
                          <CompanyEvidence company={c} />
                          {jobs.length > 0 && (
                            <ul>
                              {jobs.map((j) => (
                                <MatchedJob
                                  key={j.id}
                                  job={j}
                                  onLoggedOut={onLoggedOut}
                                  profileHref={profileHref}
                                />
                              ))}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section aria-labelledby="no-match-heading">
                <h2 id="no-match-heading">No match</h2>
                <p className="muted">
                  Surveyor completed the scan confidently but found no jobs matching this run’s role
                  criteria.
                </p>
                {noMatchCompanies.length === 0 ? (
                  <p>No companies in this category yet.</p>
                ) : (
                  <ul>
                    {noMatchCompanies.map((c) => (
                      <li key={c.id}>
                        <div>
                          {c.input_index}: {c.company_name} — {c.status}
                        </div>
                        <CompanyEvidence company={c} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section aria-labelledby="unverified-heading">
                <h2 id="unverified-heading">Unverified</h2>
                <p className="muted">
                  Surveyor could not complete a confident scan for this company. This is not the same
                  as finding no match.
                </p>
                {unverifiedCompanies.length === 0 ? (
                  <p>No companies in this category yet.</p>
                ) : (
                  <ul>
                    {unverifiedCompanies.map((c) => (
                      <li key={c.id}>
                        <div>
                          {c.input_index}: {c.company_name} — {c.status}
                        </div>
                        <CompanyEvidence company={c} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </>
      )}
    </main>
  );
}

export default function App() {
  const [authState, setAuthState] = useState<AuthGateState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetchCurrentUser()
      .then((user) => {
        if (cancelled) return;
        setAuthState(user ? { status: "authenticated", user } : { status: "unauthenticated" });
      })
      .catch(() => {
        if (cancelled) return;
        setAuthState({ status: "unauthenticated" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function handleLoggedOut() {
    setAuthState({ status: "unauthenticated" });
  }

  function handleAuthenticated(user: AuthUser) {
    setAuthState({ status: "authenticated", user });
  }

  if (authState.status === "loading") {
    return (
      <main>
        <p>Loading…</p>
      </main>
    );
  }

  if (authState.status === "unauthenticated") {
    return <LoginPage onAuthenticated={handleAuthenticated} />;
  }

  return (
    <Routes>
      <Route
        path="/"
        element={<HomePage user={authState.user} onLoggedOut={handleLoggedOut} />}
      />
      <Route
        path="/runs/:id"
        element={<RunDetailPage user={authState.user} onLoggedOut={handleLoggedOut} />}
      />
      <Route
        path="/profile"
        element={<ProfilePage user={authState.user} onLoggedOut={handleLoggedOut} />}
      />
      <Route
        path="/saved"
        element={<SavedPage user={authState.user} onLoggedOut={handleLoggedOut} />}
      />
      <Route
        path="/applications"
        element={<ApplicationsPage user={authState.user} onLoggedOut={handleLoggedOut} />}
      />
    </Routes>
  );
}
