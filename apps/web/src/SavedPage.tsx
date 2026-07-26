import type {
  SavedCompanyListResponse,
  SavedCompanyResponse,
  SavedSearchListResponse,
  SavedSearchResponse,
} from "@surveyor/shared";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { parseApiError } from "./apiErrors.js";
import InlineError from "./InlineError.js";
import SavedSearchMonitoring from "./SavedSearchMonitoring.js";
import AppHeader, { type AuthUser } from "./AppHeader.js";

interface SavedPageProps {
  user: AuthUser;
  onLoggedOut: () => void;
}

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; companies: SavedCompanyListResponse; searches: SavedSearchListResponse }
  | { status: "error"; message: string };

function emptyCompanyForm() {
  return { company_name: "", company_url: "", notes: "" };
}

function emptySearchForm() {
  return {
    name: "",
    role_raw: "",
    include_adjacent: false,
    notes: "",
    companiesText: "",
  };
}

function searchFormFromResponse(search: SavedSearchResponse) {
  return {
    name: search.name,
    role_raw: search.role_raw,
    include_adjacent: search.include_adjacent,
    notes: search.notes ?? "",
    companiesText: search.companies.map((c) => c.company_name).join("\n"),
  };
}

export default function SavedPage({ user, onLoggedOut }: SavedPageProps) {
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const [companyForm, setCompanyForm] = useState(emptyCompanyForm());
  const [companyError, setCompanyError] = useState<string | null>(null);
  const [companySaving, setCompanySaving] = useState(false);
  const [editingCompanyId, setEditingCompanyId] = useState<string | null>(null);

  const [searchForm, setSearchForm] = useState(emptySearchForm());
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchSaving, setSearchSaving] = useState(false);
  const [editingSearchId, setEditingSearchId] = useState<string | null>(null);

  const [startingRunId, setStartingRunId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  async function loadSaved(): Promise<void> {
    const [companiesRes, searchesRes] = await Promise.all([
      fetch("/api/saved-companies"),
      fetch("/api/saved-searches"),
    ]);

    if (companiesRes.status === 401 || searchesRes.status === 401) {
      onLoggedOut();
      return;
    }
    if (!companiesRes.ok || !searchesRes.ok) {
      const failed = !companiesRes.ok ? companiesRes : searchesRes;
      setState({
        status: "error",
        message: await parseApiError(failed, "Could not load your saved companies and searches."),
      });
      return;
    }

    const companies = (await companiesRes.json()) as SavedCompanyListResponse;
    const searches = (await searchesRes.json()) as SavedSearchListResponse;
    setState({ status: "loaded", companies, searches });
  }

  useEffect(() => {
    loadSaved().catch((err: unknown) => {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Request failed",
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleEditCompany(company: SavedCompanyResponse) {
    setEditingCompanyId(company.id);
    setCompanyForm({
      company_name: company.company_name,
      company_url: company.company_url ?? "",
      notes: company.notes ?? "",
    });
    setCompanyError(null);
  }

  function handleCancelEditCompany() {
    setEditingCompanyId(null);
    setCompanyForm(emptyCompanyForm());
    setCompanyError(null);
  }

  async function handleCompanySubmit(e: React.FormEvent) {
    e.preventDefault();
    setCompanyError(null);

    if (companyForm.company_name.trim().length === 0) {
      setCompanyError("Company name must be non-empty");
      return;
    }

    setCompanySaving(true);
    try {
      const url = editingCompanyId
        ? `/api/saved-companies/${editingCompanyId}`
        : "/api/saved-companies";
      const method = editingCompanyId ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_name: companyForm.company_name,
          company_url: companyForm.company_url,
          notes: companyForm.notes,
        }),
      });

      if (res.status === 401) {
        onLoggedOut();
        return;
      }

      const data: unknown = await res.json().catch(() => null);
      const body = data && typeof data === "object" ? (data as Record<string, unknown>) : {};

      if (!res.ok) {
        setCompanyError(
          typeof body.error === "string" ? body.error : "Failed to save saved company"
        );
        return;
      }

      setCompanyForm(emptyCompanyForm());
      setEditingCompanyId(null);
      await loadSaved();
    } catch {
      setCompanyError("Network error");
    } finally {
      setCompanySaving(false);
    }
  }

  async function handleDeleteCompany(companyId: string) {
    if (!window.confirm("Delete this saved company?")) {
      return;
    }
    try {
      const res = await fetch(`/api/saved-companies/${companyId}`, { method: "DELETE" });
      if (res.status === 401) {
        onLoggedOut();
        return;
      }
      if (!res.ok) {
        setCompanyError("Failed to delete saved company");
        return;
      }
      if (editingCompanyId === companyId) {
        handleCancelEditCompany();
      }
      await loadSaved();
    } catch {
      setCompanyError("Network error");
    }
  }

  function handleEditSearch(search: SavedSearchResponse) {
    setEditingSearchId(search.id);
    setSearchForm(searchFormFromResponse(search));
    setSearchError(null);
  }

  function handleCancelEditSearch() {
    setEditingSearchId(null);
    setSearchForm(emptySearchForm());
    setSearchError(null);
  }

  async function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSearchError(null);

    if (searchForm.name.trim().length === 0) {
      setSearchError("Name must be non-empty");
      return;
    }
    if (searchForm.role_raw.trim().length === 0) {
      setSearchError("Role must be non-empty");
      return;
    }

    const trimmedLines = searchForm.companiesText.split("\n").map((line) => line.trim());

    if (trimmedLines.some((line) => line.length === 0)) {
      setSearchError("Company entries must be non-empty. Remove blank lines.");
      return;
    }

    if (trimmedLines.length < 1 || trimmedLines.length > 10) {
      setSearchError("Companies must contain between 1 and 10 entries");
      return;
    }

    const companies = trimmedLines.map((company_name) => ({ company_name }));

    setSearchSaving(true);
    try {
      const url = editingSearchId
        ? `/api/saved-searches/${editingSearchId}`
        : "/api/saved-searches";
      const method = editingSearchId ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: searchForm.name,
          role_raw: searchForm.role_raw,
          include_adjacent: searchForm.include_adjacent,
          notes: searchForm.notes,
          companies,
        }),
      });

      if (res.status === 401) {
        onLoggedOut();
        return;
      }

      const data: unknown = await res.json().catch(() => null);
      const body = data && typeof data === "object" ? (data as Record<string, unknown>) : {};

      if (!res.ok) {
        setSearchError(
          typeof body.error === "string" ? body.error : "Failed to save saved search"
        );
        return;
      }

      setSearchForm(emptySearchForm());
      setEditingSearchId(null);
      await loadSaved();
    } catch {
      setSearchError("Network error");
    } finally {
      setSearchSaving(false);
    }
  }

  async function handleDeleteSearch(searchId: string) {
    if (!window.confirm("Delete this saved search?")) {
      return;
    }
    try {
      const res = await fetch(`/api/saved-searches/${searchId}`, { method: "DELETE" });
      if (res.status === 401) {
        onLoggedOut();
        return;
      }
      if (!res.ok) {
        setSearchError("Failed to delete saved search");
        return;
      }
      if (editingSearchId === searchId) {
        handleCancelEditSearch();
      }
      await loadSaved();
    } catch {
      setSearchError("Network error");
    }
  }

  async function handleStartRun(searchId: string) {
    setRunError(null);
    setStartingRunId(searchId);
    try {
      const res = await fetch(`/api/saved-searches/${searchId}/runs`, { method: "POST" });

      if (res.status === 401) {
        onLoggedOut();
        return;
      }

      const data: unknown = await res.json().catch(() => null);
      const body = data && typeof data === "object" ? (data as Record<string, unknown>) : {};

      if (!res.ok) {
        setRunError(typeof body.error === "string" ? body.error : "Failed to start run");
        return;
      }

      // Validate the returned runId before navigating so a malformed response
      // never sends the user to /runs/undefined.
      const runId = body.runId;
      if (typeof runId !== "string" || runId.length === 0) {
        setRunError("The scan started but returned an invalid response.");
        return;
      }
      navigate(`/runs/${runId}`);
    } catch {
      setRunError("Network error");
    } finally {
      setStartingRunId(null);
    }
  }

  return (
    <main>
      <AppHeader user={user} onLoggedOut={onLoggedOut} />
      <h1>Saved &amp; monitoring</h1>
      <p className="muted">
        Saved companies are a reference shortlist and never start a scan. Saved searches pair a role
        with a company list so you can scan it once now or monitor it for new matches over time.
      </p>

      {state.status === "loading" && <p>Loading…</p>}
      {state.status === "error" && (
        <InlineError
          message={state.message}
          onRetry={() => {
            void loadSaved().catch((err: unknown) => {
              setState({
                status: "error",
                message: err instanceof Error ? err.message : "Request failed",
              });
            });
          }}
        />
      )}

      {state.status === "loaded" && (
        <>
          <section aria-labelledby="saved-companies-heading">
            <h2 id="saved-companies-heading">Saved companies</h2>
            <p className="muted">
              Reference data only — a shortlist of companies you care about. Saving a company does
              not start a scan.
            </p>
            {state.companies.length === 0 && (
              <p>No saved companies yet. Add one below to build your reference list.</p>
            )}
            <ul>
              {state.companies.map((company) => (
                <li key={company.id}>
                  <strong>{company.company_name}</strong>
                  {company.company_url != null && company.company_url !== "" && (
                    <> — {company.company_url}</>
                  )}
                  {company.notes != null && company.notes !== "" && <div>{company.notes}</div>}
                  <div>
                    <button type="button" onClick={() => handleEditCompany(company)}>
                      Edit
                    </button>{" "}
                    <button type="button" onClick={() => handleDeleteCompany(company.id)}>
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            <h3>{editingCompanyId ? "Edit saved company" : "Add saved company"}</h3>
            <form onSubmit={handleCompanySubmit}>
              <div>
                <label htmlFor="saved-company-name">Company name</label>
                <input
                  id="saved-company-name"
                  type="text"
                  value={companyForm.company_name}
                  onChange={(e) =>
                    setCompanyForm({ ...companyForm, company_name: e.target.value })
                  }
                />
              </div>
              <div>
                <label htmlFor="saved-company-url">Company URL</label>
                <input
                  id="saved-company-url"
                  type="text"
                  value={companyForm.company_url}
                  onChange={(e) =>
                    setCompanyForm({ ...companyForm, company_url: e.target.value })
                  }
                />
              </div>
              <div>
                <label htmlFor="saved-company-notes">Notes</label>
                <textarea
                  id="saved-company-notes"
                  rows={3}
                  value={companyForm.notes}
                  onChange={(e) => setCompanyForm({ ...companyForm, notes: e.target.value })}
                />
              </div>
              {companyError != null && <p role="alert">{companyError}</p>}
              <button type="submit" disabled={companySaving}>
                {companySaving ? "Saving…" : editingCompanyId ? "Update company" : "Add company"}
              </button>{" "}
              {editingCompanyId && (
                <button type="button" onClick={handleCancelEditCompany}>
                  Cancel
                </button>
              )}
            </form>
          </section>

          <section aria-labelledby="saved-searches-heading">
            <h2 id="saved-searches-heading">Saved searches</h2>
            <p className="muted">
              A runnable scanner input: a role plus a company list. Scan once runs an ordinary
              scanner scan now (the same as starting one by hand). Monitoring, below each search,
              reruns that same ordinary scan periodically to surface new matches — it submits nothing.
            </p>
            {state.searches.length === 0 && (
              <p>No saved searches yet. Add a role and companies below to create a runnable search.</p>
            )}
            {runError != null && <p role="alert">{runError}</p>}
            <ul>
              {state.searches.map((search) => (
                <li key={search.id}>
                  <strong>{search.name}</strong> — {search.role_raw}
                  {search.include_adjacent && <> (includes adjacent roles)</>}
                  <div>Companies: {search.companies.map((c) => c.company_name).join(", ")}</div>
                  {search.notes != null && search.notes !== "" && <div>{search.notes}</div>}
                  <div>
                    <button
                      type="button"
                      onClick={() => handleStartRun(search.id)}
                      disabled={startingRunId === search.id}
                    >
                      {startingRunId === search.id ? "Scanning…" : "Scan once"}
                    </button>{" "}
                    <button type="button" onClick={() => handleEditSearch(search)}>
                      Edit
                    </button>{" "}
                    <button type="button" onClick={() => handleDeleteSearch(search.id)}>
                      Delete
                    </button>
                  </div>
                  <SavedSearchMonitoring savedSearchId={search.id} onLoggedOut={onLoggedOut} />
                </li>
              ))}
            </ul>

            <h3>{editingSearchId ? "Edit saved search" : "Add saved search"}</h3>
            <form onSubmit={handleSearchSubmit}>
              <div>
                <label htmlFor="saved-search-name">Name</label>
                <input
                  id="saved-search-name"
                  type="text"
                  value={searchForm.name}
                  onChange={(e) => setSearchForm({ ...searchForm, name: e.target.value })}
                />
              </div>
              <div>
                <label htmlFor="saved-search-role">Role</label>
                <input
                  id="saved-search-role"
                  type="text"
                  value={searchForm.role_raw}
                  onChange={(e) => setSearchForm({ ...searchForm, role_raw: e.target.value })}
                />
              </div>
              <div>
                <label htmlFor="saved-search-include-adjacent">
                  <input
                    id="saved-search-include-adjacent"
                    type="checkbox"
                    checked={searchForm.include_adjacent}
                    onChange={(e) =>
                      setSearchForm({ ...searchForm, include_adjacent: e.target.checked })
                    }
                  />{" "}
                  Include adjacent roles
                </label>
              </div>
              <div>
                <label htmlFor="saved-search-companies">Companies (one per line, 1–10)</label>
                <textarea
                  id="saved-search-companies"
                  rows={5}
                  value={searchForm.companiesText}
                  onChange={(e) =>
                    setSearchForm({ ...searchForm, companiesText: e.target.value })
                  }
                />
              </div>
              <div>
                <label htmlFor="saved-search-notes">Notes</label>
                <textarea
                  id="saved-search-notes"
                  rows={3}
                  value={searchForm.notes}
                  onChange={(e) => setSearchForm({ ...searchForm, notes: e.target.value })}
                />
              </div>
              {searchError != null && <p role="alert">{searchError}</p>}
              <button type="submit" disabled={searchSaving}>
                {searchSaving ? "Saving…" : editingSearchId ? "Update search" : "Add search"}
              </button>{" "}
              {editingSearchId && (
                <button type="button" onClick={handleCancelEditSearch}>
                  Cancel
                </button>
              )}
            </form>
          </section>
        </>
      )}
    </main>
  );
}
