import { test, expect } from "bun:test";
import { createInMemoryRepository } from "./test-support.ts";
import type {
  CollectedContact,
  CollectedJob,
  CollectedLead,
  LeadScoreRecord,
} from "../../types/index.ts";

// Helpers ------------------------------------------------------------------

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
      sourceUrl: "fake://acme",
      sourceTitle: "fake collector",
      retrievedAt: "2026-05-30T00:00:00.000Z",
    },
    ...overrides,
  };
}

function baseScore(
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
      { component: "job_match", points: 35, evidenceSourceId: 1, note: "match" },
    ],
    decision: "accepted_for_feishu",
    scorerVersion: "1.0.0",
    ...overrides,
  };
}

// --- happy path -----------------------------------------------------------

test("listPushCandidates returns a single accepted company with its jobs + contacts", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const stored = repo.upsertCollectedLead(lead(), run.id);
  repo.writeLeadScore(baseScore(stored.companyId, run.id));
  repo.finishRun(run.id, "completed");

  const candidates = repo.listPushCandidates({ minScore: 70 });
  expect(candidates).toHaveLength(1);
  const c = candidates[0]!;
  expect(c.name).toBe("Acme AI");
  expect(c.domain).toBe("acme.ai");
  expect(c.score).toBe(82);
  expect(c.scorerVersion).toBe("1.0.0");
  expect(c.jobs).toHaveLength(1);
  expect(c.jobs[0]!.title).toBe("Backend Engineer");
  expect(c.jobs[0]!.freshness).toBe("fresh");
  expect(c.contacts).toHaveLength(1);
  expect(c.contacts[0]!.name).toBe("Alice");
  expect(c.contacts[0]!.value).toBe("alice@acme.ai");
  expect(c.sources).toContain("fake://acme");
  expect(c.matchReason).toHaveLength(1);
  expect(c.lastCheckedAt).toBeTruthy();
});

// --- exclusion rules ------------------------------------------------------

test("listPushCandidates excludes companies whose latest decision is stale", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const stored = repo.upsertCollectedLead(lead(), run.id);
  repo.writeLeadScore(baseScore(stored.companyId, run.id, { decision: "stale" }));
  repo.finishRun(run.id, "completed");

  expect(repo.listPushCandidates({ minScore: 70 })).toHaveLength(0);
});

test("listPushCandidates excludes blocked_contact and excluded_by_rule", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 2 });
  const a = repo.upsertCollectedLead(
    lead({ companyName: "A", domain: "a.ai", jobs: [{ ...lead().jobs[0]!, jobUrl: "https://a.ai/j" }] }),
    run.id,
  );
  const b = repo.upsertCollectedLead(
    lead({ companyName: "B", domain: "b.ai", jobs: [{ ...lead().jobs[0]!, jobUrl: "https://b.ai/j" }] }),
    run.id,
  );
  repo.writeLeadScore(baseScore(a.companyId, run.id, { decision: "blocked_contact" }));
  repo.writeLeadScore(baseScore(b.companyId, run.id, { decision: "excluded_by_rule" }));
  repo.finishRun(run.id, "completed");

  expect(repo.listPushCandidates({ minScore: 70 })).toHaveLength(0);
});

test("listPushCandidates filters by minScore", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 2 });
  const a = repo.upsertCollectedLead(
    lead({ companyName: "A", domain: "a.ai", jobs: [{ ...lead().jobs[0]!, jobUrl: "https://a.ai/j" }] }),
    run.id,
  );
  const b = repo.upsertCollectedLead(
    lead({ companyName: "B", domain: "b.ai", jobs: [{ ...lead().jobs[0]!, jobUrl: "https://b.ai/j" }] }),
    run.id,
  );
  repo.writeLeadScore(baseScore(a.companyId, run.id, { score: 85, decision: "accepted_for_feishu" }));
  repo.writeLeadScore(baseScore(b.companyId, run.id, { score: 60, decision: "local_only" }));
  repo.finishRun(run.id, "completed");

  expect(repo.listPushCandidates({ minScore: 70 })).toHaveLength(1);
  expect(repo.listPushCandidates({ minScore: 70 })[0]!.name).toBe("A");
  expect(repo.listPushCandidates({ minScore: 50 })).toHaveLength(2);
});

// --- S-4 regression: latest-score filter --------------------------------

test("listPushCandidates uses the LATEST score per company (S-4)", () => {
  // S-4 lesson: aggregations must filter on the latest row, not any row.
  // A company that was previously accepted but is now stale must NOT
  // appear. A company that was previously stale but is now accepted MUST
  // appear.
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 2 });

  // A: was accepted, now stale → must NOT appear.
  const a = repo.upsertCollectedLead(
    lead({ companyName: "A", domain: "a.ai", jobs: [{ ...lead().jobs[0]!, jobUrl: "https://a.ai/j" }] }),
    run.id,
  );
  repo.writeLeadScore(baseScore(a.companyId, run.id, { score: 90, decision: "accepted_for_feishu" }));
  repo.writeLeadScore(baseScore(a.companyId, run.id, { score: 88, decision: "stale" }));

  // B: was stale, now accepted → MUST appear.
  const b = repo.upsertCollectedLead(
    lead({ companyName: "B", domain: "b.ai", jobs: [{ ...lead().jobs[0]!, jobUrl: "https://b.ai/j" }] }),
    run.id,
  );
  repo.writeLeadScore(baseScore(b.companyId, run.id, { score: 40, decision: "stale" }));
  repo.writeLeadScore(baseScore(b.companyId, run.id, { score: 80, decision: "accepted_for_feishu" }));

  repo.finishRun(run.id, "completed");

  const candidates = repo.listPushCandidates({ minScore: 70 });
  expect(candidates).toHaveLength(1);
  expect(candidates[0]!.name).toBe("B");
  expect(candidates[0]!.score).toBe(80); // the new latest score, not 40
});

// --- unknown freshness rule --------------------------------------------

test("listPushCandidates filters out jobs with unknown or stale freshness", () => {
  // Spec: "unknown 新鲜度默认排除（除非已被升级为 usable）". The repo
  // returns only fresh/usable jobs so the mapper doesn't have to re-filter.
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const fresh: CollectedJob = {
    title: "Backend Engineer",
    jobUrl: "https://acme.ai/jobs/be",
    freshness: "fresh",
    sourcePostedAt: "2026-05-20T00:00:00.000Z",
  };
  const stale: CollectedJob = {
    title: "Old Listing",
    jobUrl: "https://acme.ai/jobs/old",
    freshness: "stale",
    sourcePostedAt: "2025-01-01T00:00:00.000Z",
  };
  const unknown: CollectedJob = {
    title: "Mystery Listing",
    jobUrl: "https://acme.ai/jobs/mystery",
    freshness: "unknown",
  };
  const usable: CollectedJob = {
    title: "Probed Listing",
    jobUrl: "https://acme.ai/jobs/probed",
    freshness: "usable",
  };
  const stored = repo.upsertCollectedLead(
    lead({ jobs: [fresh, stale, unknown, usable] }),
    run.id,
  );
  repo.writeLeadScore(baseScore(stored.companyId, run.id));
  repo.finishRun(run.id, "completed");

  const c = repo.listPushCandidates({ minScore: 70 })[0]!;
  const titles = c.jobs.map((j) => j.title).sort();
  expect(titles).toEqual(["Backend Engineer", "Probed Listing"]);
});

// --- blocked contacts already filtered at write time ---------------------

test("listPushCandidates returns no blocked-risk contacts (filtered at write time)", () => {
  // The repo's upsertCollectedLead drops blocked-risk contacts. Re-asserting
  // here so the query path is honest about what it returns.
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const cs: CollectedContact[] = [
    { name: "OK", contactType: "email", value: "ok@x.com", riskLevel: "low" },
    { name: "Blocked", contactType: "email", value: "blk@x.com", riskLevel: "blocked" },
  ];
  const stored = repo.upsertCollectedLead(lead({ contacts: cs }), run.id);
  repo.writeLeadScore(baseScore(stored.companyId, run.id));
  repo.finishRun(run.id, "completed");

  const c = repo.listPushCandidates({ minScore: 70 })[0]!;
  expect(c.contacts).toHaveLength(1);
  expect(c.contacts[0]!.riskLevel).not.toBe("blocked");
});

// --- empty corpus -------------------------------------------------------

test("listPushCandidates returns [] for an empty database (success, not error)", () => {
  const { repo } = createInMemoryRepository();
  expect(repo.listPushCandidates({ minScore: 70 })).toEqual([]);
});
