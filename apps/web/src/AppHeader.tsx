import { Link } from "react-router-dom";

export interface AuthUser {
  id: string;
  email: string;
  created_at: number;
}

/**
 * Shared authenticated header used by every signed-in page. Gives consistent
 * access to the main areas (Scanner, Profile, Saved, Applications), shows the
 * current user, and offers log out — so no authenticated route is a dead end.
 */
export default function AppHeader({
  user,
  onLoggedOut,
}: {
  user: AuthUser;
  onLoggedOut: () => void;
}) {
  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    onLoggedOut();
  }

  return (
    <header className="app-header">
      <Link to="/" className="app-header__brand">
        Surveyor
      </Link>
      <nav className="app-header__nav" aria-label="Primary">
        <Link to="/">Scanner</Link>
        <Link to="/profile">Profile</Link>
        <Link to="/saved">Saved</Link>
        <Link to="/applications">Applications</Link>
      </nav>
      <div className="app-header__account">
        <span>{user.email}</span>
        <button type="button" onClick={handleLogout}>
          Log out
        </button>
      </div>
    </header>
  );
}
