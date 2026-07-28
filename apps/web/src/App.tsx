import type {
  ApplicationListResponse,
  ApplicationPacketResponse,
  FitAnalysisResponse,
  JobDetailResponse,
  JobRowResponse,
  RunCompanyResponse,
  RunDetailResponse,
  RunListResponse,
  SavedSearchListResponse,
} from "@surveyor/shared";
import { CompanyStatus, RunStatus } from "@surveyor/shared";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Route, Routes, useNavigate, useParams } from "react-router-dom";
import {
  exportCombinedCsv,
  exportMatchesCsv,
  exportNoMatchCsv,
  exportUnverifiedCsv,
} from "./csvExport.js";
import { parseApiError } from "./apiErrors.js";
import InlineError from "./InlineError.js";
import ProfilePage from "./ProfilePage.js";
import SavedPage from "./SavedPage.js";
import ApplicationsPage from "./ApplicationsPage.js";
import ApplicationTracking from "./ApplicationTracking.js";
import SettingsPage from "./SettingsPage.js";
import AppHeader, { type AuthUser } from "./AppHeader.js";

type HealthState =
  | { status: "loading" }
  | { status: "ok"; body: { ok: boolean } }
  | { status: "error"; message: string };

type AuthGateState =
  | { status: "loading" }
  | { status: "authenticated"; user: AuthUser }
  | { status: "unauthenticated" }
  // A non-401 session-check failure (network/500/etc.) is deliberately distinct
  // from "unauthenticated" so an unreachable API is never mistaken for a logout.
  | { status: "error" };

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

      if (!res.ok) {
        // Preserve backend validation text (e.g. "invalid email or password").
        setError(await parseApiError(res));
        return;
      }

      const body = (await res.json().catch(() => null)) as AuthUser | null;
      if (body === null) {
        setError("Unexpected response from the server.");
        return;
      }

      onAuthenticated(body);
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

const RECENT_SCANS_DEFAULT_LIMIT = 5;

/**
 * Returning-user "resume your work" surface for the home page. Lists recent
 * owned scans (newest first, five by default with an in-place show-all toggle)
 * and compact links into saved searches/monitoring and applications. Read-only:
 * it renders the owned run list and existing summaries; it starts no scans and
 * changes no scanner state.
 */
function ResumeYourWork({
  runs,
  showAll,
  onToggleShowAll,
  savedSearchCount,
  applicationCount,
}: {
  runs: RunListResponse;
  showAll: boolean;
  onToggleShowAll: () => void;
  savedSearchCount: number | null;
  applicationCount: number | null;
}) {
  const visibleRuns = showAll ? runs : runs.slice(0, RECENT_SCANS_DEFAULT_LIMIT);
  const hasMore = runs.length > RECENT_SCANS_DEFAULT_LIMIT;

  return (
    <section aria-labelledby="resume-work-heading" className="info-box">
      <h2 id="resume-work-heading">Resume your work</h2>
      <p className="muted">
        Pick up a previous scan, or jump to your saved searches and tracked applications.
      </p>

      <h3>Recent scans</h3>
      <ul className="recent-scans">
        {visibleRuns.map((run) => (
          <li key={run.id} className="recent-scan">
            <Link to={`/runs/${run.id}`}>{run.role_raw}</Link>
            {run.include_adjacent && <span className="muted"> (includes adjacent roles)</span>}
            <div className="muted">
              {new Date(run.created_at).toLocaleString()} · {runStatusPlainLanguage(run.status)}
            </div>
            <div className="muted">
              {run.company_count} compan{run.company_count === 1 ? "y" : "ies"} · {run.matched_company_count}{" "}
              matched · {run.no_match_company_count} no match · {run.unverified_company_count}{" "}
              unverified
            </div>
          </li>
        ))}
      </ul>
      {hasMore && (
        <button type="button" onClick={onToggleShowAll}>
          {showAll
            ? `Show fewer scans`
            : `Show all previous scans (${runs.length})`}
        </button>
      )}

      <p className="muted" style={{ marginTop: "1rem" }}>
        <Link to="/saved">Saved searches &amp; monitoring</Link>
        {savedSearchCount != null && (
          <> — {savedSearchCount} saved search{savedSearchCount === 1 ? "" : "es"}</>
        )}
        {" · "}
        <Link to="/applications">Applications</Link>
        {applicationCount != null && (
          <> — {applicationCount} tracked</>
        )}
      </p>
    </section>
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
  // Returning-user "resume your work" data. recentRuns stays null until the
  // owned run list loads so first-time onboarding is not shown prematurely.
  const [recentRuns, setRecentRuns] = useState<RunListResponse | null>(null);
  const [recentRunsError, setRecentRunsError] = useState<string | null>(null);
  const [showAllScans, setShowAllScans] = useState(false);
  const [savedSearchCount, setSavedSearchCount] = useState<number | null>(null);
  const [applicationCount, setApplicationCount] = useState<number | null>(null);

  // Recent-scans loader. A load failure must not silently remove the resume
  // surface: it sets a retryable error while leaving the Start scan form fully
  // usable. First-time onboarding still keys off recentRuns === [] once loaded.
  const loadRecentScans = useCallback(async () => {
    setRecentRunsError(null);
    try {
      const res = await fetch("/api/runs");
      if (res.status === 401) {
        onLoggedOut();
        return;
      }
      if (!res.ok) {
        setRecentRunsError(await parseApiError(res, "Could not load your recent scans."));
        return;
      }
      setRecentRuns((await res.json()) as RunListResponse);
    } catch {
      setRecentRunsError("Could not load your recent scans.");
    }
  }, [onLoggedOut]);

  // Load the owned run list plus compact saved-search / application summaries.
  // These are additive resume-work surfaces built on existing read endpoints;
  // the count summaries degrade quietly, but recent-scans failures are surfaced.
  useEffect(() => {
    let cancelled = false;

    async function loadSavedSearchCount() {
      try {
        const res = await fetch("/api/saved-searches");
        if (res.ok && !cancelled) {
          setSavedSearchCount(((await res.json()) as SavedSearchListResponse).length);
        }
      } catch {
        /* summary link is optional */
      }
    }

    async function loadApplicationCount() {
      try {
        const res = await fetch("/api/applications");
        if (res.ok && !cancelled) {
          setApplicationCount(((await res.json()) as ApplicationListResponse).length);
        }
      } catch {
        /* summary link is optional */
      }
    }

    void loadRecentScans();
    void loadSavedSearchCount();
    void loadApplicationCount();

    return () => {
      cancelled = true;
    };
  }, [loadRecentScans]);

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

      if (!res.ok) {
        setSubmitError(await parseApiError(res));
        return;
      }

      const data: unknown = await res.json().catch(() => null);
      const body = data && typeof data === "object" ? (data as Record<string, unknown>) : {};

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

      {recentRunsError != null && (
        <InlineError
          message={recentRunsError}
          onRetry={() => {
            void loadRecentScans();
          }}
        />
      )}

      {recentRuns !== null && recentRuns.length > 0 && (
        <ResumeYourWork
          runs={recentRuns}
          showAll={showAllScans}
          onToggleShowAll={() => setShowAllScans((v) => !v)}
          savedSearchCount={savedSearchCount}
          applicationCount={applicationCount}
        />
      )}

      {recentRuns !== null && recentRuns.length === 0 && (
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
      )}

      <section aria-labelledby="run-form-heading">
        <h2 id="run-form-heading">Start a new scan</h2>
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
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  async function loadAnalyses() {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobRowId)}/fit-analysis`);
      if (res.status === 401) {
        onLoggedOut();
        return;
      }
      if (!res.ok) {
        setHistoryError(
          await parseApiError(res, `Could not load fit analysis history (${res.status}).`)
        );
        return;
      }
      setAnalyses((await res.json()) as FitAnalysisResponse[]);
    } catch {
      setHistoryError("Network error while loading fit analysis history.");
    } finally {
      setHistoryLoading(false);
    }
  }

  useEffect(() => {
    // Load once on first expand. On failure analyses stays null and this effect
    // does not re-run (deps unchanged), so the Retry button drives any refetch.
    if (expanded && analyses === null && !historyLoading && historyError === null) {
      void loadAnalyses();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  async function handleAnalyze() {
    setActionError(null);
    setGenerating(true);
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobRowId)}/fit-analysis`, {
        method: "POST",
      });
      if (res.status === 401) {
        onLoggedOut();
        return;
      }
      if (!res.ok) {
        setActionError(await parseApiError(res));
        return;
      }
      await loadAnalyses();
    } catch {
      setActionError("Network error while generating the analysis.");
    } finally {
      setGenerating(false);
    }
  }

  async function handleDelete(analysisId: string) {
    if (
      !window.confirm(
        "Delete this analysis? This deletes this analysis and its stored evidence snapshot. " +
          "It does not delete generated application packets, and it does not delete scanner or job evidence."
      )
    ) {
      return;
    }
    setActionError(null);
    setDeletingId(analysisId);
    try {
      const res = await fetch(`/api/fit-analyses/${encodeURIComponent(analysisId)}`, {
        method: "DELETE",
      });
      if (res.status === 401) {
        onLoggedOut();
        return;
      }
      if (!res.ok) {
        // A failed delete must not imply success — surface it, do not reload.
        setActionError(await parseApiError(res, "Could not delete this analysis."));
        return;
      }
      await loadAnalyses();
    } catch {
      setActionError("Network error while deleting this analysis.");
    } finally {
      setDeletingId(null);
    }
  }

  const latest = analyses && analyses.length > 0 ? analyses[0] : null;
  const busy = generating || deletingId != null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? "Hide fit analysis" : "Fit analysis"}
      </button>
      {expanded && (
        <div style={{ marginLeft: "1rem", marginTop: "0.5rem" }}>
          <p className="muted">
            Generating a fit analysis sends the stored job evidence plus your current profile or
            resume evidence to the configured AI provider. Fit analysis does not change the scanner
            result.
          </p>
          <p className="muted">
            Each generated analysis stores a point-in-time snapshot of the evidence used. Editing or
            deleting your current profile or resume does not change analyses you already generated.
          </p>
          <button type="button" onClick={handleAnalyze} disabled={busy}>
            {generating ? "Analyzing…" : "Generate new analysis"}
          </button>
          {actionError != null && <p role="alert">{actionError}</p>}

          {historyLoading && analyses === null && <p>Loading fit analysis…</p>}
          {historyError != null && (
            <InlineError
              message={historyError}
              onRetry={() => {
                void loadAnalyses();
              }}
            />
          )}

          {latest && (
            <div>
              {latest.status === "FAILED" ? (
                <p role="alert">
                  Analysis attempt failed ({new Date(latest.created_at).toLocaleString()}). Reason:{" "}
                  {latest.failure_reason ?? "unknown"}
                  {latest.failure_code != null && ` · Code: ${latest.failure_code}`}
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
              <button
                type="button"
                onClick={() => handleDelete(latest.id)}
                disabled={generating || deletingId === latest.id}
              >
                {deletingId === latest.id ? "Deleting…" : "Delete this analysis"}
              </button>
            </div>
          )}

          {analyses != null && analyses.length === 0 && !historyLoading && (
            <p>No fit analysis yet.</p>
          )}

          {actionError != null &&
            actionError.toLowerCase().includes("no usable profile or resume") && (
              <p>
                <Link to={profileHref}>Add profile or resume information</Link> to enable fit
                analysis.
              </p>
            )}

          {analyses != null && analyses.length > 1 && (
            <details>
              <summary>Previous analyses ({analyses.length - 1})</summary>
              <ul>
                {analyses.slice(1).map((a) => (
                  <li key={a.id}>
                    {new Date(a.created_at).toLocaleString()} — {a.status}
                    {a.status === "FAILED" &&
                      (a.failure_reason != null || a.failure_code != null) && (
                        <>
                          {" — Reason: "}
                          {a.failure_reason ?? "unknown"}
                          {a.failure_code != null && ` · Code: ${a.failure_code}`}
                        </>
                      )}{" "}
                    <button
                      type="button"
                      onClick={() => handleDelete(a.id)}
                      disabled={generating || deletingId === a.id}
                    >
                      {deletingId === a.id ? "Deleting…" : "Delete"}
                    </button>
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
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  async function loadPackets() {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobRowId)}/application-packets`);
      if (res.status === 401) {
        onLoggedOut();
        return;
      }
      if (!res.ok) {
        setHistoryError(
          await parseApiError(res, `Could not load application packet history (${res.status}).`)
        );
        return;
      }
      setPackets((await res.json()) as ApplicationPacketResponse[]);
    } catch {
      setHistoryError("Network error while loading application packet history.");
    } finally {
      setHistoryLoading(false);
    }
  }

  useEffect(() => {
    // Load once on first expand. On failure packets stays null and this effect
    // does not re-run (deps unchanged), so the Retry button drives any refetch.
    if (expanded && packets === null && !historyLoading && historyError === null) {
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
    setActionError(null);
    setGenerating(true);
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobRowId)}/application-packets`, {
        method: "POST",
      });
      if (res.status === 401) {
        onLoggedOut();
        return;
      }
      if (!res.ok) {
        setActionError(await parseApiError(res));
        return;
      }
      await loadPackets();
    } catch {
      setActionError("Network error while generating the packet.");
    } finally {
      setGenerating(false);
    }
  }

  async function handleDelete(packetId: string) {
    if (
      !window.confirm(
        "Delete this packet? This deletes this packet and its stored evidence snapshot. " +
          "Any linked application remains but is unlinked from this packet, and scanner or job evidence is not deleted."
      )
    ) {
      return;
    }
    setActionError(null);
    setDeletingId(packetId);
    try {
      const res = await fetch(`/api/application-packets/${encodeURIComponent(packetId)}`, {
        method: "DELETE",
      });
      if (res.status === 401) {
        onLoggedOut();
        return;
      }
      if (!res.ok) {
        // A failed delete must not imply success — surface it, do not reload.
        setActionError(await parseApiError(res, "Could not delete this packet."));
        return;
      }
      await loadPackets();
    } catch {
      setActionError("Network error while deleting this packet.");
    } finally {
      setDeletingId(null);
    }
  }

  const latest = packets && packets.length > 0 ? packets[0] : null;
  const busy = generating || deletingId != null;

  return (
    <div>
      <button type="button" onClick={() => setExpanded((v) => !v)}>
        {expanded ? "Hide application packet" : "Application packet"}
      </button>
      {expanded && (
        <div style={{ marginLeft: "1rem", marginTop: "0.5rem" }}>
          <p className="muted">
            Generating a packet may send your current profile or resume evidence, the stored job
            evidence, and optionally your latest fit-analysis evidence to the configured AI provider.
            Review everything before use; Surveyor never submits applications.
          </p>
          <p className="muted">
            Each generated packet stores a point-in-time snapshot of the evidence used. Editing or
            deleting your current profile or resume does not change packets you already generated.
          </p>
          <button type="button" onClick={handleGenerate} disabled={busy}>
            {generating ? "Generating…" : "Generate new packet"}
          </button>
          {actionError != null && <p role="alert">{actionError}</p>}

          {historyLoading && packets === null && <p>Loading application packet…</p>}
          {historyError != null && (
            <InlineError
              message={historyError}
              onRetry={() => {
                void loadPackets();
              }}
            />
          )}

          {latest && (
            <div>
              {latest.status === "FAILED" ? (
                <p role="alert">
                  Packet generation attempt failed (
                  {new Date(latest.created_at).toLocaleString()}). Reason:{" "}
                  {latest.failure_reason ?? "unknown"}
                  {latest.failure_code != null && ` · Code: ${latest.failure_code}`}
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
              <button
                type="button"
                onClick={() => handleDelete(latest.id)}
                disabled={generating || deletingId === latest.id}
              >
                {deletingId === latest.id ? "Deleting…" : "Delete this packet"}
              </button>
            </div>
          )}

          {packets != null && packets.length === 0 && !historyLoading && (
            <p>No application packet yet.</p>
          )}

          {actionError != null &&
            actionError.toLowerCase().includes("no usable profile or resume") && (
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
                    {p.status === "FAILED" &&
                      (p.failure_reason != null || p.failure_code != null) && (
                        <>
                          {" — Reason: "}
                          {p.failure_reason ?? "unknown"}
                          {p.failure_code != null && ` · Code: ${p.failure_code}`}
                        </>
                      )}{" "}
                    <button
                      type="button"
                      onClick={() => handleDelete(p.id)}
                      disabled={generating || deletingId === p.id}
                    >
                      {deletingId === p.id ? "Deleting…" : "Delete"}
                    </button>
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
 * Lazily loads and shows the stored job description for a matched job. Only
 * rendered when the run detail already reports that a stored description
 * exists. Uses the existing GET /api/jobs/:jobRowId/detail endpoint on expand;
 * it never refetches the job page, summarizes, or changes scanner evidence.
 */
function StoredJobDescription({
  jobRowId,
  onLoggedOut,
}: {
  jobRowId: string;
  onLoggedOut: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<JobDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobRowId)}/detail`);
      if (res.status === 401) {
        onLoggedOut();
        return;
      }
      if (!res.ok) {
        setError(await parseApiError(res, `Could not load the stored job description (${res.status}).`));
        return;
      }
      setDetail((await res.json()) as JobDetailResponse);
    } catch {
      setError("Network error while loading the stored job description.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (expanded && detail === null && !loading && error === null) {
      void load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  return (
    <div>
      <button type="button" onClick={() => setExpanded((v) => !v)}>
        {expanded ? "Hide stored job description" : "View stored job description"}
      </button>
      {expanded && (
        <div style={{ marginLeft: "1rem", marginTop: "0.5rem" }}>
          {loading && <p>Loading stored job description…</p>}
          {error != null && (
            <InlineError
              message={error}
              onRetry={() => {
                void load();
              }}
            />
          )}
          {detail != null && (
            <>
              {detail.fetched_at != null && (
                <p className="muted">Recorded {new Date(detail.fetched_at).toLocaleString()}.</p>
              )}
              {detail.description_text != null && detail.description_text !== "" ? (
                <p style={{ whiteSpace: "pre-wrap" }}>{detail.description_text}</p>
              ) : detail.failure_reason != null || detail.failure_code != null ? (
                <p className="muted">
                  Stored description unavailable: {detail.failure_reason ?? detail.failure_code}
                </p>
              ) : (
                <p className="muted">No stored description text.</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Plain-language job-detail evidence state for a matched job, derived only from
 * RunDetailResponse fields already fetched for the run. Shows one of three
 * states, offers the stored-description viewer when a description exists, and
 * surfaces the stored failure reason when the detail fetch failed. Reads
 * scanner evidence only — it never changes company status or refetches pages.
 */
function JobEvidence({ job, onLoggedOut }: { job: JobRowResponse; onLoggedOut: () => void }) {
  const hasFailure =
    job.job_detail_failure_code != null || job.job_detail_failure_reason != null;

  return (
    <div className="job-evidence">
      <p className="muted">
        <strong>Job evidence:</strong>{" "}
        {job.job_detail_available
          ? "Full job description recorded."
          : hasFailure
            ? "Full description unavailable; preparation uses the title, location, and match reason."
            : "Detail status not yet available."}
      </p>
      {job.job_detail_available && (
        <StoredJobDescription jobRowId={job.id} onLoggedOut={onLoggedOut} />
      )}
      {!job.job_detail_available && hasFailure && (
        <p className="muted">
          Reason: {job.job_detail_failure_reason ?? job.job_detail_failure_code}
        </p>
      )}
    </div>
  );
}

/**
 * One matched job, grouped into three parts: the job link and scanner match
 * reason, the recorded Job evidence, and a Prepare to apply workflow (fit,
 * packet, tracking) in order. Holds the newest completed packet id so the
 * single tracking control can link it — there is exactly one tracking control
 * per matched job.
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
      <div>
        <a href={job.url} target="_blank" rel="noreferrer">
          {job.title}
        </a>
        {job.location != null && job.location !== "" && ` · ${job.location}`}
        {job.match_reason && ` · ${job.match_reason}`}
      </div>

      <JobEvidence job={job} onLoggedOut={onLoggedOut} />

      <div className="prepare-to-apply">
        <p className="muted">
          <strong>Prepare to apply:</strong> analyze fit, generate an application packet, then track
          your application. Surveyor never submits anything.
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
    let inFlight = false;
    let stopped = false;
    let intervalId: number | undefined;

    function stopPolling() {
      stopped = true;
      if (intervalId !== undefined) {
        window.clearInterval(intervalId);
        intervalId = undefined;
      }
    }

    async function poll() {
      // Prevent overlapping requests: if a poll is still in flight when the
      // interval fires again, skip this tick.
      if (inFlight || stopped) {
        return;
      }
      inFlight = true;
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
        if (cancelled) {
          return;
        }

        if (res.status === 401) {
          onLoggedOut();
          stopPolling();
          return;
        }

        if (res.status === 404) {
          // Terminal: the run does not exist. Stop polling and explain clearly.
          setPollError("This run could not be found. It may have been removed.");
          stopPolling();
          return;
        }

        if (!res.ok) {
          // Transient failure: keep last-known data visible and keep polling.
          setPollError(await parseApiError(res, `Could not load this run (${res.status}).`));
          return;
        }

        const body = (await res.json()) as RunDetailResponse;
        if (cancelled) {
          return;
        }
        setPollError(null);
        setDetail(body);

        // Stop polling once the run reaches a terminal status — no further
        // scanner-visible changes will occur. Status semantics are unchanged.
        if (
          body.run.status === RunStatus.COMPLETED ||
          body.run.status === RunStatus.FAILED_ROLE_SPEC
        ) {
          stopPolling();
        }
      } catch {
        if (!cancelled) {
          // Keep last-known data (if any) and keep polling to recover.
          setPollError("Network error while loading this run.");
        }
      } finally {
        inFlight = false;
      }
    }

    void poll();
    intervalId = window.setInterval(() => {
      void poll();
    }, 1000);

    return () => {
      cancelled = true;
      stopPolling();
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

  // Once the run has completed, every company is finalized, so an empty
  // In progress section is just noise — hide it. While the run is still
  // CREATED/READY/RUNNING, keep showing it (a transiently empty list still
  // means "still scanning").
  const hideEmptyInProgress =
    detail?.run.status === RunStatus.COMPLETED && pendingInProgress.length === 0;

  // Context-preserving link so Profile can offer a return path to this run.
  const runPath = id != null && id !== "" ? `/runs/${id}` : null;
  const profileHref = runPath
    ? `/profile?returnTo=${encodeURIComponent(runPath)}`
    : "/profile";

  return (
    <main>
      <AppHeader user={user} onLoggedOut={onLoggedOut} />
      <p>
        <Link to="/">← Back to scans</Link>
      </p>
      <h1>Run detail</h1>
      {detail == null && pollError == null && <p>Loading run…</p>}
      {pollError != null && <InlineError message={pollError} />}
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
              {!hideEmptyInProgress && (
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
              )}

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

  const checkSession = useCallback(async () => {
    setAuthState({ status: "loading" });
    try {
      const res = await fetch("/api/auth/me");
      if (res.status === 401) {
        // Genuinely unauthenticated — show login (unchanged 401 behavior).
        setAuthState({ status: "unauthenticated" });
        return;
      }
      if (!res.ok) {
        // Non-401 failure: do NOT log the user out. Surface a retryable error.
        setAuthState({ status: "error" });
        return;
      }
      const user = (await res.json()) as AuthUser;
      setAuthState({ status: "authenticated", user });
    } catch {
      setAuthState({ status: "error" });
    }
  }, []);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

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

  if (authState.status === "error") {
    return (
      <main>
        <h1>Surveyor</h1>
        <InlineError
          message="Surveyor could not verify your session."
          onRetry={() => {
            void checkSession();
          }}
        />
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
      <Route
        path="/settings"
        element={<SettingsPage user={authState.user} onLoggedOut={handleLoggedOut} />}
      />
    </Routes>
  );
}
