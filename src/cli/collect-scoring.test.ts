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
    return [
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
    ];
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
  const { repo, db } = createInMemoryRepository();
  const failingRepo = {
    ...repo,
    writeLeadScore: () => {
      throw new Error("simulated score writer failure");
    },
  };

  await expect(
    runCollect({
      repo: failingRepo,
      collector: fixtureCollector,
      limit: 50,
    }),
  ).rejects.toThrow(/simulated score writer failure/);

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
