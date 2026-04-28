import type { JobRowResponse, RunCompanyResponse, RunDetailResponse } from "@surveyor/shared";
import { CompanyStatus, RunStatus } from "@surveyor/shared";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Route, Routes, useNavigate, useParams } from "react-router-dom";
import {
  exportCombinedCsv,
  exportMatchesCsv,
  exportNoMatchCsv,
  exportUnverifiedCsv,
} from "./csvExport.js";

type HealthState =
  | { status: "loading" }
  | { status: "ok"; body: { ok: boolean } }
  | { status: "error"; message: string };

function HomePage() {
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
      <h1>Surveyor</h1>
      <p>Web app is running.</p>
      {health.status === "loading" && <p>Checking API…</p>}
      {health.status === "ok" && (
        <p>API /health: {JSON.stringify(health.body)}</p>
      )}
      {health.status === "error" && (
        <p role="alert">API /health failed: {health.message}</p>
      )}

      <section aria-labelledby="run-form-heading">
        <h2 id="run-form-heading">Run</h2>
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
            {submitting ? "Submitting…" : "Run"}
          </button>
        </form>
      </section>
    </main>
  );
}

function sortCompaniesByInputIndex(companies: RunCompanyResponse[]): RunCompanyResponse[] {
  return [...companies].sort((a, b) => a.input_index - b.input_index);
}

function isRunActive(status: string): boolean {
  return (
    status === RunStatus.CREATED ||
    status === RunStatus.READY ||
    status === RunStatus.RUNNING
  );
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

function RunDetailPage() {
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
  }, [id]);

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

  return (
    <main>
      <h1>Run</h1>
      <p>Run id: {id ?? "—"}</p>
      {pollError != null && <p role="alert">{pollError}</p>}
      {detail != null && (
        <>
          <p>
            Run status: {detail.run.status} · Companies: {detail.companies.length} · Matched jobs:{" "}
            {detail.matched_jobs.length}
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
              {isRunActive(detail.run.status) && pendingInProgress.length > 0 && (
                <section aria-labelledby="run-active-companies-heading">
                  <h2 id="run-active-companies-heading">In progress</h2>
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
                </section>
              )}

              <section aria-labelledby="matches-heading">
                <h2 id="matches-heading">Matches</h2>
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
                              <li key={j.id}>
                                <a href={j.url} target="_blank" rel="noreferrer">
                                  {j.title}
                                </a>
                                {j.location != null && j.location !== "" && ` · ${j.location}`}
                                {j.match_reason && ` · ${j.match_reason}`}
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section aria-labelledby="no-match-heading">
                <h2 id="no-match-heading">No match</h2>
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
              </section>

              <section aria-labelledby="unverified-heading">
                <h2 id="unverified-heading">Unverified</h2>
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
              </section>
            </>
          )}
        </>
      )}
    </main>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/runs/:id" element={<RunDetailPage />} />
    </Routes>
  );
}
