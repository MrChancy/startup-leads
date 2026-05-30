import { test, expect } from "bun:test";
import { createInMemoryRepository } from "../storage/sqlite/test-support.ts";
import { runReport } from "./report.ts";

// All three test groups use the same pinned `now` so since-window cutoffs
// are deterministic.
const FROZEN_NOW = new Date("2026-05-30T12:00:00.000Z");
const now = () => FROZEN_NOW;

// ---- run scope (legacy + I-2) -------------------------------------------

test("runReport scope=run found returns the full report with the run header", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  repo.finishRun(run.id, "completed");

  const result = runReport({
    repo,
    scope: { kind: "run", runId: run.id },
    now,
  });
  expect(result.found).toBe(true);
  expect(result.line).toContain(`Report (run ${run.id}`);
  // TB-11 lines.
  expect(result.line).toContain("Pipeline:");
  expect(result.line).toContain("Decisions:");
  expect(result.line).toContain("Coverage:");
  expect(result.line).toContain("Freshness:");
  expect(result.line).toContain("Score distribution:");
});

test("runReport scope=run unknown id returns found=false (I-2)", () => {
  const { repo } = createInMemoryRepository();
  const result = runReport({
    repo,
    scope: { kind: "run", runId: "does-not-exist" },
    now,
  });
  expect(result.found).toBe(false);
  expect(result.line).toBe("Run does-not-exist not found");
});

// ---- latest scope -------------------------------------------------------

test("runReport scope=latest on a fresh DB returns found=true with the 'no runs yet' line", () => {
  // I-2 split: --run <missing> errors, --latest with empty DB is a friendly
  // success that tells the operator what to do next.
  const { repo } = createInMemoryRepository();
  const result = runReport({ repo, scope: { kind: "latest" }, now });
  expect(result.found).toBe(true);
  expect(result.line).toContain("(no runs yet — try `collect` first)");
});

test("runReport scope=latest with one run shows the latest-run header", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  repo.finishRun(run.id, "completed");

  const result = runReport({ repo, scope: { kind: "latest" }, now });
  expect(result.found).toBe(true);
  expect(result.line).toContain(`Report (latest run ${run.id}`);
});

// ---- since scope --------------------------------------------------------

test("runReport scope=since aggregates runs within the cutoff and lists the run count", () => {
  const { repo, db } = createInMemoryRepository();
  // Two runs inside the 30d window, one outside.
  const old = repo.startRun({ source: "fake", limit: 1 });
  const mid = repo.startRun({ source: "fake", limit: 1 });
  const recent = repo.startRun({ source: "fake", limit: 1 });
  db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(
    "2026-01-01T00:00:00.000Z",
    old.id,
  );
  db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(
    "2026-05-15T00:00:00.000Z",
    mid.id,
  );
  db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(
    "2026-05-29T00:00:00.000Z",
    recent.id,
  );

  // 30d from FROZEN_NOW = 2026-04-30 → mid + recent both inside.
  const result = runReport({
    repo,
    scope: { kind: "since", cutoffMs: 30 * 86_400_000 },
    now,
  });
  expect(result.found).toBe(true);
  expect(result.line).toContain("Report (since 2026-04-30T12:00:00.000Z, 2 runs)");
  expect(result.line).toContain("Aggregating 2 runs since 2026-04-30T12:00:00.000Z");
});

test("runReport scope=since with no runs in window prints the in-window-empty notice", () => {
  const { repo, db } = createInMemoryRepository();
  const r = repo.startRun({ source: "fake", limit: 1 });
  db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(
    "2026-01-01T00:00:00.000Z",
    r.id,
  );

  const result = runReport({
    repo,
    scope: { kind: "since", cutoffMs: 30 * 86_400_000 },
    now,
  });
  expect(result.found).toBe(true);
  // Different message from "(no runs yet ...)" — the operator HAS runs,
  // just none in this window. Suggests adjusting --since rather than
  // running collect.
  expect(result.line).toContain("(no runs in window)");
});
