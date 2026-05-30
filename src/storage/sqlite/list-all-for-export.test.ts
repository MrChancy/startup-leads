import { test, expect } from "bun:test";
import { createInMemoryRepository } from "./test-support.ts";
import type {
  CollectedLead,
  LeadScoreDecision,
  LeadScoreRecord,
} from "../../types/index.ts";

// TB-5 listAllForExport: full audit dump, NOT the push-eligible slice.
// Verifies S-4 (latest-per-company-only) and S-3 (deterministic order)
// alongside the AC requirements.

function makeLead(overrides: Partial<CollectedLead> = {}): CollectedLead {
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
        freshness: "fresh",
        sourcePostedAt: "2026-05-20T00:00:00.000Z",
      },
    ],
    contacts: [
      {
        name: "Alice",
        contactType: "email",
        value: "alice@acme.ai",
        riskLevel: "low",
      },
    ],
    source: {
      sourceType: "fake",
      sourceUrl: "https://example/item?id=1",
      sourceTitle: "fake collector",
      retrievedAt: "2026-05-30T00:00:00.000Z",
    },
    ...overrides,
  };
}

function makeScore(
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
      {
        component: "job_match",
        points: 35,
        evidenceSourceId: null,
        note: "backend match strong",
      },
    ],
    decision: "accepted_for_feishu",
    scorerVersion: "1.0.0",
    ...overrides,
  };
}

test("listAllForExport returns [] for an empty DB", () => {
  const { repo } = createInMemoryRepository();
  expect(repo.listAllForExport()).toEqual([]);
});

test("listAllForExport excludes companies that were never scored", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  repo.upsertCollectedLead(makeLead(), run.id);
  // intentionally no writeLeadScore
  repo.finishRun(run.id, "completed");
  expect(repo.listAllForExport()).toEqual([]);
});

test("listAllForExport returns ALL decisions (incl. stale/blocked/excluded)", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 4 });
  const decisions: LeadScoreDecision[] = [
    "stale",
    "blocked_contact",
    "excluded_by_rule",
    "needs_review",
  ];
  for (const [i, d] of decisions.entries()) {
    const stored = repo.upsertCollectedLead(
      makeLead({
        companyName: `Co ${d}`,
        domain: `co-${i}.ai`,
        jobs: [
          {
            title: `Job ${d}`,
            jobUrl: `https://co-${i}.ai/jobs/x`,
            freshness: "unknown",
          },
        ],
      }),
      run.id,
    );
    repo.writeLeadScore(makeScore(stored.companyId, run.id, { decision: d, score: 30 + i }));
  }
  repo.finishRun(run.id, "completed");
  const rows = repo.listAllForExport();
  expect(rows.map((r) => r.decision).sort()).toEqual([
    "blocked_contact",
    "excluded_by_rule",
    "needs_review",
    "stale",
  ]);
});

test("listAllForExport is sorted by score DESC (stable id ASC tie-break)", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 3 });
  const a = repo.upsertCollectedLead(
    makeLead({ companyName: "Mid", domain: "mid.ai", jobs: [{ title: "j", jobUrl: "https://mid.ai/j", freshness: "fresh" }] }),
    run.id,
  );
  const b = repo.upsertCollectedLead(
    makeLead({ companyName: "Top", domain: "top.ai", jobs: [{ title: "j", jobUrl: "https://top.ai/j", freshness: "fresh" }] }),
    run.id,
  );
  const c = repo.upsertCollectedLead(
    makeLead({ companyName: "Tie", domain: "tie.ai", jobs: [{ title: "j", jobUrl: "https://tie.ai/j", freshness: "fresh" }] }),
    run.id,
  );
  repo.writeLeadScore(makeScore(a.companyId, run.id, { score: 70 }));
  repo.writeLeadScore(makeScore(b.companyId, run.id, { score: 90 }));
  repo.writeLeadScore(makeScore(c.companyId, run.id, { score: 70 }));
  repo.finishRun(run.id, "completed");

  const names = repo.listAllForExport().map((r) => r.name);
  expect(names[0]).toBe("Top");
  // Mid (a) was inserted before Tie (c), so the score=70 tie resolves to Mid first.
  expect(names[1]).toBe("Mid");
  expect(names[2]).toBe("Tie");
});

test("listAllForExport uses only the LATEST score per company (S-4)", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const stored = repo.upsertCollectedLead(makeLead(), run.id);
  repo.writeLeadScore(makeScore(stored.companyId, run.id, { score: 50, decision: "local_only" }));
  // The later row outranks the earlier one for the export view.
  repo.writeLeadScore(makeScore(stored.companyId, run.id, { score: 90, decision: "accepted_for_feishu" }));
  repo.finishRun(run.id, "completed");

  const rows = repo.listAllForExport();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.score).toBe(90);
  expect(rows[0]!.decision).toBe("accepted_for_feishu");
});

test("listAllForExport carries jobs, contacts, tags, matchReason", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const stored = repo.upsertCollectedLead(makeLead(), run.id);
  repo.writeLeadScore(makeScore(stored.companyId, run.id));
  repo.finishRun(run.id, "completed");

  const rows = repo.listAllForExport();
  expect(rows).toHaveLength(1);
  const r = rows[0]!;
  expect(r.name).toBe("Acme AI");
  expect(r.domain).toBe("acme.ai");
  expect(r.directionTags).toEqual(["ai-app"]);
  expect(r.jobs.length).toBe(1);
  expect(r.jobs[0]!.title).toBe("Backend Engineer");
  expect(r.jobs[0]!.location).toBe("Berlin");
  expect(r.jobs[0]!.freshness).toBe("fresh");
  expect(r.contacts.length).toBe(1);
  expect(r.contacts[0]!.value).toBe("alice@acme.ai");
  expect(r.matchReason.length).toBe(1);
  expect(r.matchReason[0]!.component).toBe("job_match");
});

test("listAllForExport includes jobs of EVERY freshness (not just fresh/usable)", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const stored = repo.upsertCollectedLead(
    makeLead({
      jobs: [
        { title: "fresh-job", jobUrl: "https://acme.ai/f", freshness: "fresh" },
        { title: "usable-job", jobUrl: "https://acme.ai/u", freshness: "usable" },
        { title: "unknown-job", jobUrl: "https://acme.ai/x", freshness: "unknown" },
        { title: "stale-job", jobUrl: "https://acme.ai/s", freshness: "stale" },
      ],
    }),
    run.id,
  );
  repo.writeLeadScore(makeScore(stored.companyId, run.id));
  repo.finishRun(run.id, "completed");

  const r = repo.listAllForExport()[0]!;
  const freshnesses = r.jobs.map((j) => j.freshness).sort();
  expect(freshnesses).toEqual(["fresh", "stale", "unknown", "usable"]);
});

test("listAllForExport is byte-stable across two calls (S-3)", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 2 });
  const a = repo.upsertCollectedLead(
    makeLead({ companyName: "A", domain: "a.com", jobs: [{ title: "j", jobUrl: "https://a.com/j", freshness: "fresh" }] }),
    run.id,
  );
  const b = repo.upsertCollectedLead(
    makeLead({ companyName: "B", domain: "b.com", jobs: [{ title: "j", jobUrl: "https://b.com/j", freshness: "fresh" }] }),
    run.id,
  );
  repo.writeLeadScore(makeScore(a.companyId, run.id, { score: 88 }));
  repo.writeLeadScore(makeScore(b.companyId, run.id, { score: 88 }));
  repo.finishRun(run.id, "completed");

  expect(JSON.stringify(repo.listAllForExport())).toBe(
    JSON.stringify(repo.listAllForExport()),
  );
});
