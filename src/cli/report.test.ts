import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../storage/sqlite/migrations.ts";
import { createSqliteLeadRepository } from "../storage/sqlite/repository.ts";
import { runReport } from "./report.ts";

function freshRepo() {
  const db = new Database(":memory:");
  runMigrations(db);
  return createSqliteLeadRepository(db);
}

test("runReport returns found=true and canonical line for an existing run", () => {
  const repo = freshRepo();
  const run = repo.startRun({ source: "fake", limit: 1 });
  repo.finishRun(run.id, "completed");

  const result = runReport({ repo, runId: run.id });
  expect(result.found).toBe(true);
  expect(result.line).toBe(
    `Run ${run.id} completed: 0 candidates, 0 stored, 0 dedupe, 0 fetch_failed, 0 parse_failed`,
  );
});

test("runReport returns found=false and a not-found line for an unknown run id", () => {
  const repo = freshRepo();
  const result = runReport({ repo, runId: "does-not-exist" });
  expect(result.found).toBe(false);
  expect(result.line).toBe("Run does-not-exist not found");
});
