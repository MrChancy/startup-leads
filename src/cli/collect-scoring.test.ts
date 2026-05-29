import { test, expect } from "bun:test";
import { runCollect } from "./collect.ts";
import { createInMemoryRepository } from "../storage/index.ts";
import type { Collector } from "../collectors/types.ts";
import type { CollectedLead } from "../types/index.ts";

// Inline test collector: one strong lead (-> accepted) and one weak lead
// (-> local_only) so we can assert distribution end-to-end without coupling
// to whatever the production fake collector returns in any given quarter.
function makeLead(overrides: Partial<CollectedLead> = {}): CollectedLead {
  return {
    companyName: "Strong Co",
    domain: "strong.co",
    description: "AI-native infra",
    directionTags: ["ai-native"],
    jobs: [
      {
        title: "Backend Engineer",
        jobUrl: "https://strong.co/jobs/be",
        freshness: "fresh",
      },
    ],
    contacts: [
      {
        contactType: "email",
        value: "ceo@strong.co",
        riskLevel: "low",
      },
    ],
    source: {
      sourceType: "fake-test",
      sourceUrl: "fake://strong",
      sourceTitle: "test",
      retrievedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

const fixtureCollector: Collector = {
  source: "fake-test",
  async collect() {
    return {
      leads: [
        makeLead(),
        makeLead({
          companyName: "Weak Co",
          domain: "weak.co",
          directionTags: ["overseas"],
          jobs: [
            {
              title: "Sales Manager",
              jobUrl: "https://weak.co/jobs/sales",
              freshness: "unknown",
            },
          ],
          contacts: [],
          source: {
            sourceType: "fake-test",
            sourceUrl: "fake://weak",
            sourceTitle: "test",
            retrievedAt: new Date().toISOString(),
          },
        }),
      ],
      parseFailed: 0,
      fetchFailed: 0,
    };
  },
};

test("runCollect scores each stored lead and reports decision distribution", async () => {
  const { repo } = createInMemoryRepository();
  const result = await runCollect({
    repo,
    collector: fixtureCollector,
    limit: 50,
  });

  expect(result.counts.stored).toBe(2);
  // Strong lead lands at accepted_for_feishu. Weak lead has <50 score and
  // no contacts, so it falls in the score-band local_only bucket (the
  // needs_review carve-out only triggers in the 50-69 mid-band).
  expect(result.decisions.acceptedForFeishu).toBe(1);
  expect(result.decisions.localOnly).toBe(1);
});

test("runCollect rolls back the entire lead when writeLeadScore throws (H-2)", async () => {
  // pr-review H-2: upsert + score must be co-transactional. A failing
  // writeLeadScore would otherwise leave the company / domain / source
  // committed and dedupe-skip on every subsequent run — permanent split-brain.
  // TB-12: per-lead failures are now absorbed (counted as parse_failed) so
  // one bad lead doesn't abort the whole run. The rollback invariant still
  // holds — no orphan rows survive.
  const { repo, db } = createInMemoryRepository();
  const failingRepo = {
    ...repo,
    writeLeadScore: () => {
      throw new Error("simulated score writer failure");
    },
  };

  const result = await runCollect({
    repo: failingRepo,
    collector: fixtureCollector,
    limit: 50,
  });

  const companies = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM companies")
    .get();
  const jobs = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM jobs")
    .get();
  const scores = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM lead_scores")
    .get();
  expect(companies?.c).toBe(0);
  expect(jobs?.c).toBe(0);
  expect(scores?.c).toBe(0);
  // Failing leads are reported as parse_failed, not silently lost.
  expect(result.counts.parseFailed).toBeGreaterThan(0);
  expect(result.counts.stored).toBe(0);
});

test("runCollect surfaces collector-reported parse_failed and fetch_failed counts", async () => {
  // TB-3b: real collectors (HN, etc.) report failure counts in
  // CollectorResult. The orchestrator must materialise those into
  // run_lead_events rows so countByRun(runId) reflects them. Without this,
  // the report would silently show 0 even when half the comments failed.
  const failingCollector: Collector = {
    source: "fake-failing",
    async collect() {
      return {
        leads: [makeLead()],
        parseFailed: 2,
        fetchFailed: 1,
      };
    },
  };
  const { repo } = createInMemoryRepository();
  const result = await runCollect({
    repo,
    collector: failingCollector,
    limit: 50,
  });
  expect(result.counts.parseFailed).toBe(2);
  expect(result.counts.fetchFailed).toBe(1);
  // The lead itself still got upserted and scored.
  expect(result.counts.stored).toBe(1);
});

test("runCollect skips scoring deduped leads (no new score row)", async () => {
  const { repo, db } = createInMemoryRepository();
  await runCollect({ repo, collector: fixtureCollector, limit: 50 });
  const before = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM lead_scores")
    .get();
  await runCollect({ repo, collector: fixtureCollector, limit: 50 });
  const after = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM lead_scores")
    .get();
  // Both runs see both companies as deduped on the second pass, so the only
  // new lead_scores rows on the second run come from the dedup→re-score
  // choice. v1 picks "score every stored row, skip deduped" so the count
  // stays put.
  expect(after?.c).toBe(before?.c);
});
