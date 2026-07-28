import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import InlineError from "./InlineError.js";

export interface AuthUser {
  id: string;
  email: string;
  created_at: number;
}

type NavArea = "scans" | "profile" | "saved" | "applications" | "settings";

/** True when the current path belongs to the given nav area. */
function isActiveArea(pathname: string, area: NavArea): boolean {
  switch (area) {
    case "scans":
      // The Scans area covers the home/start-a-scan page and every run detail.
      return pathname === "/" || pathname.startsWith("/runs/");
    case "profile":
      return pathname.startsWith("/profile");
    case "saved":
      return pathname.startsWith("/saved");
    case "applications":
      return pathname.startsWith("/applications");
    case "settings":
      return pathname.startsWith("/settings");
  }
}

/**
 * Shared authenticated header used by every signed-in page. Gives consistent
 * access to the main areas (Scans, Profile, Saved & monitoring, Applications,
 * Settings), highlights the active area, shows the current user, and offers log
 * out — so no authenticated route is a dead end.
 */
export default function AppHeader({
  user,
  onLoggedOut,
}: {
  user: AuthUser;
  onLoggedOut: () => void;
}) {
  const { pathname } = useLocation();
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  async function handleLogout() {
    setLogoutError(null);
    setLoggingOut(true);
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      if (!res.ok) {
        // Logout failed on the server — keep the user signed in and surface it.
        setLogoutError("Could not log out. Please try again.");
        return;
      }
      onLoggedOut();
    } catch {
      // Network failure — keep the user signed in rather than faking a logout.
      setLogoutError("Could not log out. Please try again.");
    } finally {
      setLoggingOut(false);
    }
  }

  function navLinkClass(area: NavArea): string {
    return isActiveArea(pathname, area) ? "app-header__nav-link is-active" : "app-header__nav-link";
  }

  return (
    <header className="app-header">
      <Link to="/" className="app-header__brand">
        Surveyor
      </Link>
      <nav className="app-header__nav" aria-label="Primary">
        <Link
          to="/"
          className={navLinkClass("scans")}
          aria-current={isActiveArea(pathname, "scans") ? "page" : undefined}
        >
          Scans
        </Link>
        <Link
          to="/profile"
          className={navLinkClass("profile")}
          aria-current={isActiveArea(pathname, "profile") ? "page" : undefined}
        >
          Profile
        </Link>
        <Link
          to="/saved"
          className={navLinkClass("saved")}
          aria-current={isActiveArea(pathname, "saved") ? "page" : undefined}
        >
          Saved &amp; monitoring
        </Link>
        <Link
          to="/applications"
          className={navLinkClass("applications")}
          aria-current={isActiveArea(pathname, "applications") ? "page" : undefined}
        >
          Applications
        </Link>
        <Link
          to="/settings"
          className={navLinkClass("settings")}
          aria-current={isActiveArea(pathname, "settings") ? "page" : undefined}
        >
          Settings
        </Link>
      </nav>
      <div className="app-header__account">
        <span>{user.email}</span>
        <button type="button" onClick={handleLogout} disabled={loggingOut}>
          {loggingOut ? "Logging out…" : "Log out"}
        </button>
        {logoutError != null && (
          <InlineError
            message={logoutError}
            onRetry={() => {
              void handleLogout();
            }}
          />
        )}
      </div>
    </header>
  );
}
