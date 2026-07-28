import { Link } from "react-router-dom";
import AppHeader, { type AuthUser } from "./AppHeader.js";

interface SettingsPageProps {
  user: AuthUser;
  onLoggedOut: () => void;
}

/**
 * Authenticated account & privacy surface. It is intentionally read-only: it
 * explains what Surveyor stores, how the current browser session works, how AI
 * providers are used, and how point-in-time evidence snapshots are retained,
 * then links out to the places where data is actually managed. Destructive
 * controls deliberately live next to the data they act on (Profile, Scans,
 * Saved & monitoring, Applications) — never duplicated here.
 */
export default function SettingsPage({ user, onLoggedOut }: SettingsPageProps) {
  return (
    <main>
      <AppHeader user={user} onLoggedOut={onLoggedOut} />
      <h1>Settings</h1>
      <p className="muted">
        Surveyor scopes your job-search data to your signed-in account. It stores the information
        below so you can return to your work. Surveyor does not submit applications or contact
        employers.
      </p>

      <section aria-labelledby="settings-account-heading" className="info-box">
        <h2 id="settings-account-heading">Account</h2>
        <p>
          Signed in as <strong>{user.email}</strong>.
        </p>
        <h3>Session &amp; logout</h3>
        <p className="muted">
          Surveyor keeps this browser signed in for up to 30 days. Logging out ends this browser’s
          current session. It does not delete your data or sign out other sessions. Use{" "}
          <strong>Log out</strong> in the header above when you want to end this session.
        </p>
      </section>

      <section aria-labelledby="settings-stores-heading" className="info-box">
        <h2 id="settings-stores-heading">What Surveyor stores</h2>
        <ul className="settings-list">
          <li>
            <strong>Profile &amp; resume:</strong> the profile fields, work/project/skill/education
            items, and resume text you enter.
          </li>
          <li>
            <strong>Scans &amp; run history:</strong> the scans you start and the scanner evidence
            they record (companies checked, matched jobs, and stored job details).
          </li>
          <li>
            <strong>Saved &amp; monitoring:</strong> your saved companies, saved searches, and their
            monitoring history and known matches.
          </li>
          <li>
            <strong>Generated analyses &amp; packets:</strong> the fit analyses and application
            packets you generate, each with a point-in-time copy of the evidence used.
          </li>
          <li>
            <strong>Applications:</strong> the application tracking records you create for your own
            next steps.
          </li>
        </ul>
      </section>

      <section aria-labelledby="settings-ai-heading" className="info-box">
        <h2 id="settings-ai-heading">AI provider use</h2>
        <p className="muted">
          Starting a scan uses AI to structure the role request. When you generate a fit analysis or
          application packet, Surveyor sends the relevant stored job evidence and your current
          profile or resume evidence to the configured AI provider.
        </p>
      </section>

      <section aria-labelledby="settings-retention-heading" className="info-box">
        <h2 id="settings-retention-heading">Evidence-snapshot retention</h2>
        <p className="muted">
          Each generated analysis or packet stores a point-in-time copy of the evidence used. Editing
          or deleting your current profile or resume does not change past artifacts. Delete those
          artifacts separately if you no longer want them stored.
        </p>
      </section>

      <section aria-labelledby="settings-manage-heading" className="info-box">
        <h2 id="settings-manage-heading">Manage your data</h2>
        <p className="muted">
          Deletion controls live next to the data they act on. Use these links to review and manage
          each category.
        </p>
        <ul className="settings-list">
          <li>
            <Link to="/profile">Profile / resume</Link> — edit or delete your profile fields, profile
            items, and resume text.
          </li>
          <li>
            <Link to="/">Scans / run history</Link> — review the scans you have started and their
            recorded evidence.
          </li>
          <li>
            <Link to="/saved">Saved &amp; monitoring</Link> — manage saved companies, saved searches,
            and monitoring.
          </li>
          <li>
            <Link to="/applications">Applications</Link> — manage the applications you are tracking.
          </li>
        </ul>
        <p className="muted">
          Generated fit analyses and application packets are managed from each matched job in your
          scan history: open a scan, expand a matched job, and delete an analysis or packet from
          there.
        </p>
        <p className="muted">
          Scanner run history has no deletion control in this V1 — runs and their recorded evidence
          are kept as-is.
        </p>
      </section>

      <section aria-labelledby="settings-limitations-heading" className="info-box">
        <h2 id="settings-limitations-heading">V1 limitations</h2>
        <p className="muted">
          Complete account deletion and full data export are intentionally deferred for this V1
          because they require broader transactional cleanup across scanner history, generated
          artifacts, monitoring, and applications.
        </p>
      </section>
    </main>
  );
}
