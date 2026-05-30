import { test, expect } from "bun:test";
import { createInMemoryRepository } from "../storage/sqlite/test-support.ts";
import { buildPushCandidates } from "./query.ts";
import type {
  CollectedLead,
  LeadScoreRecord,
} from "../types/index.ts";

function lead(overrides: Partial<CollectedLead> = {}): CollectedLead {
  return {
    companyName: "Acme AI",
    domain: "acme.ai",
    description: "An AI company",
    directionTags: ["ai-app"],
    jobs: [
      {
        title: "Backend Engineer",
        jobUrl: "https://acme.ai/jobs/be",
        location: "Berlin",
        remotePolicy: "remote-friendly",
        freshness: "fresh",
        sourcePostedAt: "2026-05-20T00:00:00.000Z",
      },
    ],
    contacts: [
      {
        name: "Alice",
        title: "CTO",
        contactType: "email",
        value: "alice@acme.ai",
        riskLevel: "low",
      },
    ],
    source: {
      sourceType: "fake",
      sourceUrl: "https://hn.example/item?id=1",
      sourceTitle: "fake collector",
      retrievedAt: "2026-05-30T00:00:00.000Z",
    },
    ...overrides,
  };
}

function score(
  companyId: number,
  runId: string,
  overrides: Partial<LeadScoreRecord> = {},
): LeadScoreRecord {
  return {
    companyId,
    runId,
    score: 82,
    jobMatchScore: 35,
    directionScore: 20,
    freshnessScore: 15,
    contactScore: 7,
    actionabilityScore: 5,
    matchReason: [
      { component: "job_match", points: 35, evidenceSourceId: 1, note: "m" },
    ],
    decision: "accepted_for_feishu",
    scorerVersion: "1.0.0",
    ...overrides,
  };
}

test("buildPushCandidates maps each repo row into a CompanyLead", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const stored = repo.upsertCollectedLead(lead(), run.id);
  repo.writeLeadScore(score(stored.companyId, run.id));
  repo.finishRun(run.id, "completed");

  const out = buildPushCandidates({ repo, minScore: 70 });
  expect(out).toHaveLength(1);
  const lead0 = out[0]!;
  expect(lead0.localId).toBe(`company-${stored.companyId}`);
  expect(lead0.companyId).toBe(stored.companyId);
  expect(lead0.name).toBe("Acme AI");
  expect(lead0.domain).toBe("acme.ai");
  expect(lead0.score).toBe(82);
  expect(lead0.scorerVersion).toBe("1.0.0");
  expect(lead0.topJobs).toHaveLength(1);
  expect(lead0.topContacts).toHaveLength(1);
  expect(lead0.freshness).toBe("fresh");
  expect(lead0.sources).toContain("https://hn.example/item?id=1");
});

test("buildPushCandidates returns empty for empty repo", () => {
  const { repo } = createInMemoryRepository();
  expect(buildPushCandidates({ repo, minScore: 70 })).toEqual([]);
});

test("buildPushCandidates threads minScore to the repo (exclude below)", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 2 });
  const a = repo.upsertCollectedLead(
    lead({ companyName: "Hi", domain: "hi.com", jobs: [{ ...lead().jobs[0]!, jobUrl: "https://hi.com/j" }] }),
    run.id,
  );
  const b = repo.upsertCollectedLead(
    lead({ companyName: "Lo", domain: "lo.com", jobs: [{ ...lead().jobs[0]!, jobUrl: "https://lo.com/j" }] }),
    run.id,
  );
  repo.writeLeadScore(score(a.companyId, run.id, { score: 90 }));
  repo.writeLeadScore(score(b.companyId, run.id, { score: 55, decision: "local_only" }));
  repo.finishRun(run.id, "completed");

  expect(buildPushCandidates({ repo, minScore: 70 }).map((l) => l.name)).toEqual(["Hi"]);
  expect(buildPushCandidates({ repo, minScore: 50 }).map((l) => l.name).sort())
    .toEqual(["Hi", "Lo"]);
});

test("buildPushCandidates rolls freshness up from the best job", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const stored = repo.upsertCollectedLead(
    lead({
      jobs: [
        { title: "j1", jobUrl: "https://acme.ai/j1", freshness: "usable" },
        { title: "j2", jobUrl: "https://acme.ai/j2", freshness: "fresh" },
      ],
    }),
    run.id,
  );
  repo.writeLeadScore(score(stored.companyId, run.id));
  repo.finishRun(run.id, "completed");

  const out = buildPushCandidates({ repo, minScore: 70 });
  expect(out[0]!.freshness).toBe("fresh");
});

test("buildPushCandidates rolls freshness to 'usable' when no fresh job remains", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const stored = repo.upsertCollectedLead(
    lead({
      jobs: [
        { title: "u", jobUrl: "https://acme.ai/u", freshness: "usable" },
      ],
    }),
    run.id,
  );
  repo.writeLeadScore(score(stored.companyId, run.id));
  repo.finishRun(run.id, "completed");

  const out = buildPushCandidates({ repo, minScore: 70 });
  expect(out[0]!.freshness).toBe("usable");
});

test("buildPushCandidates derives Remote / Location from the top job", () => {
  // Single test that pins the remoteLocation rule. The mapper is a pure
  // echo of this field so a string-compare here is enough.
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const stored = repo.upsertCollectedLead(
    lead({
      jobs: [
        {
          title: "j",
          jobUrl: "https://acme.ai/j",
          location: "Berlin",
          remotePolicy: "remote-friendly",
          freshness: "fresh",
        },
      ],
    }),
    run.id,
  );
  repo.writeLeadScore(score(stored.companyId, run.id));
  repo.finishRun(run.id, "completed");

  const out = buildPushCandidates({ repo, minScore: 70 });
  // Loose contract: must mention both pieces of info. Exact format is a
  // dry-run cosmetic, not a downstream contract.
  expect(out[0]!.remoteLocation).toMatch(/Berlin/);
  expect(out[0]!.remoteLocation).toMatch(/remote-friendly/);
});

test("buildPushCandidates returns empty when only stale companies exist", () => {
  // Spec exclusion contract: stale never pushes.
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const stored = repo.upsertCollectedLead(lead(), run.id);
  repo.writeLeadScore(score(stored.companyId, run.id, { decision: "stale" }));
  repo.finishRun(run.id, "completed");

  expect(buildPushCandidates({ repo, minScore: 70 })).toEqual([]);
});

test("buildPushCandidates is stable across two runs on the same data (S-3 idempotency)", () => {
  // Dry-run writes nothing, so the SECOND call must yield byte-identical
  // output to the first.
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const stored = repo.upsertCollectedLead(lead(), run.id);
  repo.writeLeadScore(score(stored.companyId, run.id));
  repo.finishRun(run.id, "completed");

  const a = buildPushCandidates({ repo, minScore: 70 });
  const b = buildPushCandidates({ repo, minScore: 70 });
  expect(JSON.stringify(b)).toBe(JSON.stringify(a));
});
