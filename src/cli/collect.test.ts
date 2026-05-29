import { test, expect } from "bun:test";
import { fakeCollector } from "../collectors/fake.ts";
import { runCollect } from "./collect.ts";
import { createInMemoryRepository } from "../storage/index.ts";
import type { CollectedLead } from "../types/index.ts";
import type { Collector } from "../collectors/types.ts";

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

test("runCollect counts a lead with empty retrievedAt as parse_failed and keeps going", async () => {
  const { repo, peek } = createInMemoryRepository();

  const goodLead: CollectedLead = {
    companyName: "Good Co",
    domain: "good.co",
    directionTags: ["ai-app"],
    jobs: [{ title: "Engineer", freshness: "fresh" }],
    contacts: [],
    source: {
      sourceType: "test",
      retrievedAt: new Date().toISOString(),
    },
  };
  const badLead: CollectedLead = {
    ...goodLead,
    companyName: "Bad Co",
    domain: "bad.co",
    source: { sourceType: "test", retrievedAt: "" },
  };

  const oneBadOneGoodCollector: Collector = {
    source: "test",
    async collect() {
      return { leads: [badLead, goodLead], parseFailed: 0, fetchFailed: 0 };
    },
  };

  const result = await runCollect({
    repo,
    collector: oneBadOneGoodCollector,
    limit: 2,
  });

  // The good lead still lands.
  expect(peek.companyCount()).toBe(1);
  // The bad lead surfaces as parse_failed without aborting the run.
  expect(result.counts.parseFailed).toBe(1);
  expect(result.counts.stored).toBe(1);
  // Run status is completed (per-lead errors are absorbed by the loop).
  const run = peek.runRow(result.runId);
  expect(run?.status).toBe("completed");
});
