import { test, expect } from "bun:test";
import { createInMemoryRepository } from "../storage/index.ts";
import { formatPurgeResult, runPurge } from "./purge.ts";
import type { CollectedLead } from "../types/index.ts";

function leadOf(over: Partial<CollectedLead> = {}): CollectedLead {
  return {
    companyName: "Acme AI",
    domain: "acme.ai",
    directionTags: ["ai-app"],
    jobs: [{ title: "Backend", freshness: "fresh" }],
    contacts: [{ contactType: "email", value: "a@x.io", riskLevel: "low" }],
    source: {
      sourceType: "fake",
      sourceUrl: "fake://acme",
      sourceTitle: "Fake",
      retrievedAt: new Date().toISOString(),
    },
    ...over,
  };
}

test("dry-run reports company counts without deleting", () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  repo.upsertCollectedLead(leadOf(), run.id);

  const result = runPurge({
    repo,
    mode: { kind: "company", domain: "acme.ai" },
    confirm: false,
  });
  expect(result.deleted).toBe(false);
  expect(result.counts.companies).toBe(1);
  expect(result.counts.jobs).toBe(1);

  const remaining = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM companies")
    .get();
  expect(remaining?.c).toBe(1);
});

test("--yes deletes and returns matching counts", () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  repo.upsertCollectedLead(leadOf(), run.id);

  const result = runPurge({
    repo,
    mode: { kind: "company", domain: "acme.ai" },
    confirm: true,
  });
  expect(result.deleted).toBe(true);
  expect(result.counts.companies).toBe(1);

  const remaining = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM companies")
    .get();
  expect(remaining?.c).toBe(0);
});

test("formatPurgeResult preview header mentions --yes", () => {
  const out = formatPurgeResult({
    counts: {
      companies: 0,
      company_domains: 0,
      jobs: 0,
      contacts: 0,
      sources: 0,
      lead_scores: 0,
      push_events: 0,
    },
    deleted: false,
  });
  expect(out).toContain("Purge preview");
  expect(out).toContain("--yes");
  expect(out).toContain("sources");
  expect(out).toContain("(not touched)");
});

test("formatPurgeResult real-delete header is 'Purged:'", () => {
  const out = formatPurgeResult({
    counts: {
      companies: 3,
      company_domains: 5,
      jobs: 8,
      contacts: 2,
      sources: 0,
      lead_scores: 7,
      push_events: 0,
    },
    deleted: true,
  });
  expect(out.startsWith("Purged:")).toBe(true);
  expect(out).toContain("companies");
  expect(out).toContain("3");
});

test("risk dry-run when no matching contacts returns zeros", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  repo.upsertCollectedLead(leadOf(), run.id); // single low-risk contact

  const result = runPurge({
    repo,
    mode: { kind: "risk", levels: ["blocked"] },
    confirm: false,
  });
  expect(result.counts.contacts).toBe(0);
  expect(result.counts.companies).toBe(0);
});
