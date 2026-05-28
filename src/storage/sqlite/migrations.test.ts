import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "./migrations.ts";

function tableNames(db: Database) {
  const rows = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  return rows.map((r) => r.name);
}

test("runMigrations creates every domain table", () => {
  const db = new Database(":memory:");
  runMigrations(db);

  const tables = tableNames(db);
  for (const required of [
    "companies",
    "company_domains",
    "jobs",
    "contacts",
    "sources",
    "runs",
    "lead_scores",
    "push_events",
  ]) {
    expect(tables).toContain(required);
  }
});

test("runMigrations is idempotent", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  runMigrations(db);
  const tables = tableNames(db);
  expect(tables).toContain("runs");
});

test("runs table uses limit_value, not limit", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(runs)")
    .all()
    .map((r) => r.name);
  expect(cols).toContain("limit_value");
  expect(cols).not.toContain("limit");
});
