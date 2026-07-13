import Database from "better-sqlite3";

/** DDL for runs, run_companies, job_rows, trace_events and required indexes (roadmap 1.2, 5.2). */
export function ensureSchema(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      created_at INTEGER,
      status TEXT,
      role_raw TEXT,
      include_adjacent INTEGER,
      role_spec_json TEXT,
      role_spec_started_at INTEGER,
      company_count INTEGER,
      error_code TEXT,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS run_companies (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      company_name TEXT,
      input_index INTEGER,
      status TEXT,
      created_at INTEGER,
      started_at INTEGER,
      finished_at INTEGER,
      worker_token TEXT,
      careers_url TEXT,
      ats_type TEXT,
      extractor_used TEXT,
      listings_scanned INTEGER,
      pages_visited INTEGER,
      failure_code TEXT,
      failure_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS job_rows (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      company_id TEXT,
      title TEXT,
      location TEXT,
      url TEXT,
      match_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS trace_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      run_company_id TEXT NULL,
      event_type TEXT NOT NULL,
      message TEXT NOT NULL,
      payload_json TEXT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS job_details (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      job_row_id TEXT NOT NULL,
      job_url TEXT NOT NULL,
      description_text TEXT NULL,
      fetched_at INTEGER NULL,
      failure_code TEXT NULL,
      failure_reason TEXT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

    CREATE INDEX IF NOT EXISTS idx_run_companies_run_id ON run_companies(run_id);
    CREATE INDEX IF NOT EXISTS idx_run_companies_status ON run_companies(status);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_job_details_job_row_id_unique ON job_details(job_row_id);
    CREATE INDEX IF NOT EXISTS idx_job_details_run_id ON job_details(run_id);
    CREATE INDEX IF NOT EXISTS idx_job_details_company_id ON job_details(company_id);

    CREATE TABLE IF NOT EXISTS user_profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      full_name TEXT NULL,
      location TEXT NULL,
      years_experience INTEGER NULL,
      target_titles TEXT NULL,
      notes TEXT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profiles_user_id_unique ON user_profiles(user_id);

    CREATE TABLE IF NOT EXISTS user_profile_items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      item_type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NULL,
      start_date TEXT NULL,
      end_date TEXT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_user_profile_items_user_id ON user_profile_items(user_id);

    CREATE TABLE IF NOT EXISTS resumes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      resume_text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_resumes_user_id_unique ON resumes(user_id);

    CREATE TABLE IF NOT EXISTS job_fit_analyses (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      job_row_id TEXT NOT NULL,
      status TEXT NOT NULL,
      fit_summary TEXT NULL,
      strengths_json TEXT NULL,
      gaps_json TEXT NULL,
      risks_json TEXT NULL,
      suggested_next_steps_json TEXT NULL,
      evidence_snapshot_json TEXT NOT NULL,
      model_name TEXT NULL,
      failure_code TEXT NULL,
      failure_reason TEXT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_job_fit_analyses_user_id ON job_fit_analyses(user_id);
    CREATE INDEX IF NOT EXISTS idx_job_fit_analyses_job_row_id ON job_fit_analyses(job_row_id);

    CREATE TABLE IF NOT EXISTS application_packets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      job_row_id TEXT NOT NULL,
      job_fit_analysis_id TEXT NULL,
      status TEXT NOT NULL,
      packet_summary TEXT NULL,
      cover_letter_draft TEXT NULL,
      positioning_notes_json TEXT NULL,
      resume_bullet_suggestions_json TEXT NULL,
      talking_points_json TEXT NULL,
      questions_to_prepare_json TEXT NULL,
      evidence_snapshot_json TEXT NOT NULL,
      model_name TEXT NULL,
      failure_code TEXT NULL,
      failure_reason TEXT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_application_packets_user_id ON application_packets(user_id);
    CREATE INDEX IF NOT EXISTS idx_application_packets_job_row_id ON application_packets(job_row_id);
  `);

  ensureRunsUserIdColumn(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runs_user_id ON runs(user_id);
  `);
}

/**
 * runs.user_id is added via a guarded ALTER TABLE because SQLite has no
 * `ADD COLUMN IF NOT EXISTS`. PRAGMA table_info is checked first so this is
 * safe to call on every startup without erroring on already-migrated DBs.
 */
function ensureRunsUserIdColumn(db: InstanceType<typeof Database>): void {
  const columns = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
  const hasUserId = columns.some((column) => column.name === "user_id");
  if (!hasUserId) {
    db.exec(`ALTER TABLE runs ADD COLUMN user_id TEXT`);
  }
}
