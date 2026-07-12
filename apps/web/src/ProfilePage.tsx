import type {
  ProfileMemoryResponse,
  UserProfileItemResponse,
  UserProfileResponse,
} from "@surveyor/shared";
import { ProfileItemType } from "@surveyor/shared";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

interface ProfilePageProps {
  onLoggedOut: () => void;
}

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; data: ProfileMemoryResponse }
  | { status: "error"; message: string };

const ITEM_TYPES: UserProfileItemResponse["item_type"][] = [
  ProfileItemType.WORK_HISTORY,
  ProfileItemType.PROJECT,
  ProfileItemType.SKILL,
  ProfileItemType.EDUCATION,
];

function emptyProfileForm(profile: UserProfileResponse | null) {
  return {
    full_name: profile?.full_name ?? "",
    location: profile?.location ?? "",
    years_experience: profile?.years_experience?.toString() ?? "",
    target_titles: profile?.target_titles ?? "",
    notes: profile?.notes ?? "",
  };
}

function emptyItemForm() {
  return {
    item_type: ProfileItemType.WORK_HISTORY as UserProfileItemResponse["item_type"],
    title: "",
    description: "",
    start_date: "",
    end_date: "",
  };
}

export default function ProfilePage({ onLoggedOut }: ProfilePageProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [profileForm, setProfileForm] = useState(emptyProfileForm(null));
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);

  const [itemForm, setItemForm] = useState(emptyItemForm());
  const [itemError, setItemError] = useState<string | null>(null);
  const [itemSaving, setItemSaving] = useState(false);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);

  const [resumeText, setResumeText] = useState("");
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [resumeSaving, setResumeSaving] = useState(false);

  async function loadProfile(): Promise<void> {
    const res = await fetch("/api/profile");
    if (res.status === 401) {
      onLoggedOut();
      return;
    }
    if (!res.ok) {
      setState({ status: "error", message: `Request failed (${res.status})` });
      return;
    }
    const data = (await res.json()) as ProfileMemoryResponse;
    setState({ status: "loaded", data });
    setProfileForm(emptyProfileForm(data.profile));
    setResumeText(data.resume?.resume_text ?? "");
  }

  useEffect(() => {
    loadProfile().catch((err: unknown) => {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Request failed",
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleProfileSubmit(e: React.FormEvent) {
    e.preventDefault();
    setProfileError(null);

    const yearsExperienceTrimmed = profileForm.years_experience.trim();
    let yearsExperience: number | null = null;
    if (yearsExperienceTrimmed.length > 0) {
      const parsed = Number(yearsExperienceTrimmed);
      if (!Number.isInteger(parsed) || parsed < 0) {
        setProfileError("Years of experience must be a non-negative whole number");
        return;
      }
      yearsExperience = parsed;
    }

    setProfileSaving(true);
    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          full_name: profileForm.full_name,
          location: profileForm.location,
          years_experience: yearsExperience,
          target_titles: profileForm.target_titles,
          notes: profileForm.notes,
        }),
      });

      if (res.status === 401) {
        onLoggedOut();
        return;
      }

      const data: unknown = await res.json().catch(() => null);
      const body = data && typeof data === "object" ? (data as Record<string, unknown>) : {};

      if (!res.ok) {
        setProfileError(typeof body.error === "string" ? body.error : "Failed to save profile");
        return;
      }

      await loadProfile();
    } catch {
      setProfileError("Network error");
    } finally {
      setProfileSaving(false);
    }
  }

  async function handleProfileDelete() {
    if (!window.confirm("Clear your profile fields and all profile items? This cannot be undone.")) {
      return;
    }
    setProfileError(null);
    try {
      const res = await fetch("/api/profile", { method: "DELETE" });
      if (res.status === 401) {
        onLoggedOut();
        return;
      }
      if (!res.ok) {
        setProfileError("Failed to clear profile");
        return;
      }
      await loadProfile();
    } catch {
      setProfileError("Network error");
    }
  }

  async function handleItemSubmit(e: React.FormEvent) {
    e.preventDefault();
    setItemError(null);

    if (itemForm.title.trim().length === 0) {
      setItemError("Title must be non-empty");
      return;
    }

    setItemSaving(true);
    try {
      const url = editingItemId ? `/api/profile/items/${editingItemId}` : "/api/profile/items";
      const method = editingItemId ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_type: itemForm.item_type,
          title: itemForm.title,
          description: itemForm.description,
          start_date: itemForm.start_date,
          end_date: itemForm.end_date,
        }),
      });

      if (res.status === 401) {
        onLoggedOut();
        return;
      }

      const data: unknown = await res.json().catch(() => null);
      const body = data && typeof data === "object" ? (data as Record<string, unknown>) : {};

      if (!res.ok) {
        setItemError(typeof body.error === "string" ? body.error : "Failed to save item");
        return;
      }

      setItemForm(emptyItemForm());
      setEditingItemId(null);
      await loadProfile();
    } catch {
      setItemError("Network error");
    } finally {
      setItemSaving(false);
    }
  }

  function handleEditItem(item: UserProfileItemResponse) {
    setEditingItemId(item.id);
    setItemForm({
      item_type: item.item_type,
      title: item.title,
      description: item.description ?? "",
      start_date: item.start_date ?? "",
      end_date: item.end_date ?? "",
    });
    setItemError(null);
  }

  function handleCancelEditItem() {
    setEditingItemId(null);
    setItemForm(emptyItemForm());
    setItemError(null);
  }

  async function handleDeleteItem(itemId: string) {
    if (!window.confirm("Delete this profile item?")) {
      return;
    }
    try {
      const res = await fetch(`/api/profile/items/${itemId}`, { method: "DELETE" });
      if (res.status === 401) {
        onLoggedOut();
        return;
      }
      if (!res.ok) {
        setItemError("Failed to delete item");
        return;
      }
      if (editingItemId === itemId) {
        handleCancelEditItem();
      }
      await loadProfile();
    } catch {
      setItemError("Network error");
    }
  }

  async function handleResumeSave(e: React.FormEvent) {
    e.preventDefault();
    setResumeError(null);

    if (resumeText.trim().length === 0) {
      setResumeError("Resume text must be non-empty");
      return;
    }

    setResumeSaving(true);
    try {
      const res = await fetch("/api/resume", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resume_text: resumeText }),
      });

      if (res.status === 401) {
        onLoggedOut();
        return;
      }

      const data: unknown = await res.json().catch(() => null);
      const body = data && typeof data === "object" ? (data as Record<string, unknown>) : {};

      if (!res.ok) {
        setResumeError(typeof body.error === "string" ? body.error : "Failed to save resume");
        return;
      }

      await loadProfile();
    } catch {
      setResumeError("Network error");
    } finally {
      setResumeSaving(false);
    }
  }

  async function handleResumeClear() {
    if (!window.confirm("Clear your saved resume text? This cannot be undone.")) {
      return;
    }
    setResumeError(null);
    try {
      const res = await fetch("/api/resume", { method: "DELETE" });
      if (res.status === 401) {
        onLoggedOut();
        return;
      }
      if (!res.ok) {
        setResumeError("Failed to clear resume");
        return;
      }
      await loadProfile();
    } catch {
      setResumeError("Network error");
    }
  }

  return (
    <main>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Profile</h1>
        <Link to="/">Back to Run</Link>
      </div>

      {state.status === "loading" && <p>Loading…</p>}
      {state.status === "error" && <p role="alert">{state.message}</p>}

      {state.status === "loaded" && (
        <>
          <section aria-labelledby="profile-fields-heading">
            <h2 id="profile-fields-heading">Profile</h2>
            {state.data.profile === null && <p>No profile saved yet.</p>}
            <form onSubmit={handleProfileSubmit}>
              <div>
                <label htmlFor="profile-full-name">Full name</label>
                <input
                  id="profile-full-name"
                  type="text"
                  value={profileForm.full_name}
                  onChange={(e) =>
                    setProfileForm({ ...profileForm, full_name: e.target.value })
                  }
                />
              </div>
              <div>
                <label htmlFor="profile-location">Location</label>
                <input
                  id="profile-location"
                  type="text"
                  value={profileForm.location}
                  onChange={(e) =>
                    setProfileForm({ ...profileForm, location: e.target.value })
                  }
                />
              </div>
              <div>
                <label htmlFor="profile-years-experience">Years of experience</label>
                <input
                  id="profile-years-experience"
                  type="number"
                  min={0}
                  step={1}
                  value={profileForm.years_experience}
                  onChange={(e) =>
                    setProfileForm({ ...profileForm, years_experience: e.target.value })
                  }
                />
              </div>
              <div>
                <label htmlFor="profile-target-titles">Target titles</label>
                <input
                  id="profile-target-titles"
                  type="text"
                  value={profileForm.target_titles}
                  onChange={(e) =>
                    setProfileForm({ ...profileForm, target_titles: e.target.value })
                  }
                />
              </div>
              <div>
                <label htmlFor="profile-notes">Notes</label>
                <textarea
                  id="profile-notes"
                  rows={4}
                  value={profileForm.notes}
                  onChange={(e) => setProfileForm({ ...profileForm, notes: e.target.value })}
                />
              </div>
              {profileError != null && <p role="alert">{profileError}</p>}
              <button type="submit" disabled={profileSaving}>
                {profileSaving ? "Saving…" : "Save profile"}
              </button>{" "}
              <button
                type="button"
                onClick={handleProfileDelete}
                disabled={state.data.profile === null}
              >
                Clear profile
              </button>
            </form>
          </section>

          <section aria-labelledby="profile-items-heading">
            <h2 id="profile-items-heading">Work history, projects, skills, education</h2>
            {state.data.items.length === 0 && <p>No items saved yet.</p>}
            <ul>
              {state.data.items.map((item) => (
                <li key={item.id}>
                  <strong>{item.item_type}</strong>: {item.title}
                  {item.start_date != null && ` (${item.start_date}${item.end_date ? ` – ${item.end_date}` : ""})`}
                  {item.description != null && item.description !== "" && (
                    <div>{item.description}</div>
                  )}
                  <div>
                    <button type="button" onClick={() => handleEditItem(item)}>
                      Edit
                    </button>{" "}
                    <button type="button" onClick={() => handleDeleteItem(item.id)}>
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            <h3>{editingItemId ? "Edit item" : "Add item"}</h3>
            <form onSubmit={handleItemSubmit}>
              <div>
                <label htmlFor="item-type">Type</label>
                <select
                  id="item-type"
                  value={itemForm.item_type}
                  onChange={(e) =>
                    setItemForm({
                      ...itemForm,
                      item_type: e.target.value as UserProfileItemResponse["item_type"],
                    })
                  }
                >
                  {ITEM_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="item-title">Title</label>
                <input
                  id="item-title"
                  type="text"
                  value={itemForm.title}
                  onChange={(e) => setItemForm({ ...itemForm, title: e.target.value })}
                />
              </div>
              <div>
                <label htmlFor="item-description">Description</label>
                <textarea
                  id="item-description"
                  rows={3}
                  value={itemForm.description}
                  onChange={(e) => setItemForm({ ...itemForm, description: e.target.value })}
                />
              </div>
              <div>
                <label htmlFor="item-start-date">Start date</label>
                <input
                  id="item-start-date"
                  type="text"
                  value={itemForm.start_date}
                  onChange={(e) => setItemForm({ ...itemForm, start_date: e.target.value })}
                />
              </div>
              <div>
                <label htmlFor="item-end-date">End date</label>
                <input
                  id="item-end-date"
                  type="text"
                  value={itemForm.end_date}
                  onChange={(e) => setItemForm({ ...itemForm, end_date: e.target.value })}
                />
              </div>
              {itemError != null && <p role="alert">{itemError}</p>}
              <button type="submit" disabled={itemSaving}>
                {itemSaving ? "Saving…" : editingItemId ? "Update item" : "Add item"}
              </button>{" "}
              {editingItemId && (
                <button type="button" onClick={handleCancelEditItem}>
                  Cancel
                </button>
              )}
            </form>
          </section>

          <section aria-labelledby="resume-heading">
            <h2 id="resume-heading">Resume text</h2>
            {state.data.resume === null && <p>No resume saved yet.</p>}
            <form onSubmit={handleResumeSave}>
              <div>
                <label htmlFor="resume-text">Paste your resume text</label>
                <textarea
                  id="resume-text"
                  rows={12}
                  value={resumeText}
                  onChange={(e) => setResumeText(e.target.value)}
                />
              </div>
              {resumeError != null && <p role="alert">{resumeError}</p>}
              <button type="submit" disabled={resumeSaving}>
                {resumeSaving ? "Saving…" : "Save resume"}
              </button>{" "}
              <button
                type="button"
                onClick={handleResumeClear}
                disabled={state.data.resume === null}
              >
                Clear resume
              </button>
            </form>
          </section>
        </>
      )}
    </main>
  );
}
