-- TB-1 addition (not in the v1 spec data model):
-- A lightweight per-run event log so `report --run <id>` can answer
-- "how many candidates, stored, deduped, fetch_failed, parse_failed" without
-- coupling those counts to the audit `sources` table or adding a `run_id`
-- column to every domain table. Later tickets (TB-3a/TB-4/TB-11) can either
-- continue to write events here or replace this with JSONL-derived counts.

CREATE TABLE IF NOT EXISTS run_lead_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_run_lead_events_run_id
  ON run_lead_events(run_id);
