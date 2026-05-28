// Configuration resolved from env vars + sensible defaults.

const DEFAULT_DB_PATH = "data/startup-leads.db";

export function getDatabasePath() {
  return process.env.STARTUP_LEADS_DB ?? DEFAULT_DB_PATH;
}
