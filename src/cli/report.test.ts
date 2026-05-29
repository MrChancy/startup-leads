import { test, expect } from "bun:test";
import { createInMemoryRepository } from "../storage/sqlite/test-support.ts";
import { runReport } from "./report.ts";

test("runReport returns found=true and canonical line for an existing run", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  repo.finishRun(run.id, "completed");

  const result = runReport({ repo, runId: run.id });
  expect(result.found).toBe(true);
  // TB-2 added a decisions line. Use toContain so future report extensions
  // don't churn this assertion.
  expect(result.line).toContain(
    `Run ${run.id} completed: 0 candidates, 0 stored, 0 dedupe, 0 fetch_failed, 0 parse_failed`,
  );
  expect(result.line).toContain("Decisions:");
});

test("runReport returns found=false and a not-found line for an unknown run id", () => {
  const { repo } = createInMemoryRepository();
  const result = runReport({ repo, runId: "does-not-exist" });
  expect(result.found).toBe(false);
  expect(result.line).toBe("Run does-not-exist not found");
});
