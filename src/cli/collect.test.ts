import { test, expect } from "bun:test";
import { fakeCollector } from "../collectors/fake.ts";
import { runCollect } from "./collect.ts";
import { createInMemoryRepository } from "../storage/index.ts";

test("runCollect persists every fake lead and a completed run", async () => {
  const { repo, peek } = createInMemoryRepository();

  const result = await runCollect({
    repo,
    collector: fakeCollector,
    limit: 50,
  });

  expect(result.runId).toBeTruthy();
  // TB-2 expanded the fake collector to emit three leads spanning the
  // decision space (accepted / mid / stale).
  expect(result.counts).toEqual({
    candidates: 3,
    stored: 3,
    deduped: 0,
    fetchFailed: 0,
    parseFailed: 0,
  });

  const run = peek.runRow(result.runId);
  expect(run?.status).toBe("completed");
  expect(run?.source).toBe("fake");
  expect(run?.limitValue).toBe(50);
  expect(peek.companyCount()).toBe(3);
});
