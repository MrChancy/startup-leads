-- TB-1 walking skeleton schema.
-- All foreign keys ON DELETE CASCADE except sources references which SET NULL
-- (sources rows are audit records, deleting evidence shouldn't drop the entity).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT,
  source_url TEXT,
  source_title TEXT,
  retrieved_at TEXT,
  published_at TEXT,
  content_hash TEXT,
  evidence_snippet TEXT,
  fetch_status TEXT,
  parse_status TEXT,
  error_code TEXT,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  description TEXT,
  direction_tags TEXT,
  excluded INTEGER NOT NULL DEFAULT 0,
  exclusion_reason TEXT,
  primary_domain_id INTEGER,
  needs_review INTEGER NOT NULL DEFAULT 0,
  row_created_at TEXT NOT NULL,
  row_updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  domain TEXT NOT NULL UNIQUE,
  is_primary INTEGER NOT NULL DEFAULT 0,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  row_created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT,
  normalized_title TEXT,
  job_url TEXT UNIQUE,
  location TEXT,
  remote_policy TEXT,
  source_posted_at TEXT,
  source_updated_at TEXT,
  freshness_status TEXT,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  row_created_at TEXT NOT NULL,
  row_updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT,
  title TEXT,
  contact_type TEXT,
  value TEXT,
  profile_url TEXT,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  risk_level TEXT,
  manual_review_required INTEGER,
  usage_status TEXT,
  priority_rank INTEGER,
  row_created_at TEXT NOT NULL,
  row_updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  source TEXT NOT NULL,
  limit_value INTEGER,
  status TEXT NOT NULL,
  error_summary TEXT
);

CREATE TABLE IF NOT EXISTS lead_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  score REAL,
  job_match_score REAL,
  direction_score REAL,
  freshness_score REAL,
  contact_score REAL,
  actionability_score REAL,
  match_reason TEXT,
  decision TEXT,
  scorer_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sink TEXT,
  external_app_token TEXT,
  external_table_id TEXT,
  external_record_id TEXT,
  status TEXT,
  payload_hash TEXT,
  attempt_count INTEGER,
  last_attempt_at TEXT,
  pushed_at TEXT,
  error_message TEXT
);
