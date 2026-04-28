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

    CREATE INDEX IF NOT EXISTS idx_run_companies_run_id ON run_companies(run_id);
    CREATE INDEX IF NOT EXISTS idx_run_companies_status ON run_companies(status);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
  `);
}
