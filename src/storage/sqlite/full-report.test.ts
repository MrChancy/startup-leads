import { test, expect } from "bun:test";
import { createInMemoryRepository } from "./test-support.ts";
import type {
  CollectedLead,
  LeadScoreRecord,
} from "../../types/index.ts";

// ---- shared helpers ------------------------------------------------------

let companyCounter = 0;
function uniqueLead(overrides: Partial<CollectedLead> = {}): CollectedLead {
  companyCounter += 1;
  const id = companyCounter;
  return {
    companyName: `Company ${id}`,
    domain: `c${id}.example.com`,
    directionTags: ["ai-app"],
    jobs: [
      {
        title: "Backend Engineer",
        jobUrl: `https://c${id}.example.com/jobs/be`,
        freshness: "fresh",
      },
    ],
    contacts: [],
    source: {
      sourceType: "fake",
      sourceUrl: `fake://c${id}`,
      sourceTitle: "fake",
      retrievedAt: new Date().toISOString(),
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
    score: 75,
    jobMatchScore: 35,
    directionScore: 20,
    freshnessScore: 15,
    contactScore: 0,
    actionabilityScore: 5,
    matchReason: [],
    decision: "accepted_for_feishu",
    scorerVersion: "1.0.0",
    ...overrides,
  };
}

// Direct SQL helper for back-dating started_at — the runs row is otherwise
// stamped with wall-clock time, which makes since-window tests flaky.
function backdateRun(
  db: import("bun:sqlite").Database,
  runId: string,
  iso: string,
) {
  db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(iso, runId);
}

// ---- getLatestRun --------------------------------------------------------

test("getLatestRun returns null on a fresh database", () => {
  const { repo } = createInMemoryRepository();
  expect(repo.getLatestRun()).toBeNull();
});

test("getLatestRun returns the most-recent run by started_at", () => {
  const { repo, db } = createInMemoryRepository();
  const r1 = repo.startRun({ source: "fake", limit: 1 });
  const r2 = repo.startRun({ source: "fake", limit: 1 });
  const r3 = repo.startRun({ source: "fake", limit: 1 });
  // Pin order so "most recent by started_at" is unambiguous.
  backdateRun(db, r1.id, "2026-05-01T00:00:00.000Z");
  backdateRun(db, r2.id, "2026-05-15T00:00:00.000Z");
  backdateRun(db, r3.id, "2026-05-30T00:00:00.000Z");

  const latest = repo.getLatestRun();
  expect(latest?.id).toBe(r3.id);
});

// ---- listRunsSince -------------------------------------------------------

test("listRunsSince returns only runs whose started_at >= cutoff, newest first", () => {
  const { repo, db } = createInMemoryRepository();
  const old = repo.startRun({ source: "fake", limit: 1 });
  const mid = repo.startRun({ source: "fake", limit: 1 });
  const recent = repo.startRun({ source: "fake", limit: 1 });
  backdateRun(db, old.id, "2026-04-01T00:00:00.000Z");
  backdateRun(db, mid.id, "2026-05-15T00:00:00.000Z");
  backdateRun(db, recent.id, "2026-05-30T00:00:00.000Z");

  const cutoff = "2026-05-01T00:00:00.000Z";
  const result = repo.listRunsSince(cutoff);
  expect(result.map((r) => r.id)).toEqual([recent.id, mid.id]);
});

test("listRunsSince returns an empty array (not null) when nothing matches", () => {
  const { repo, db } = createInMemoryRepository();
  const r = repo.startRun({ source: "fake", limit: 1 });
  backdateRun(db, r.id, "2026-01-01T00:00:00.000Z");
  expect(repo.listRunsSince("2026-05-01T00:00:00.000Z")).toEqual([]);
});

// ---- getReportStats ------------------------------------------------------

test("getReportStats with empty runIds returns the zero state", () => {
  const { repo } = createInMemoryRepository();
  const stats = repo.getReportStats([]);
  expect(stats.totalCandidates).toBe(0);
  expect(stats.totalCompanies).toBe(0);
  expect(stats.totalJobs).toBe(0);
  expect(stats.decisions).toEqual({
    acceptedForFeishu: 0,
    localOnly: 0,
    stale: 0,
    blockedContact: 0,
    needsReview: 0,
    excludedByRule: 0,
  });
  expect(stats.scoreBuckets.map((b) => b.label)).toEqual([
    "<50",
    "50-69",
    "70-84",
    "85+",
  ]);
  expect(stats.scoreBuckets.every((b) => b.count === 0)).toBe(true);
  expect(stats.scorerVersionGroups).toEqual([]);
  expect(stats.jobsByFreshness).toEqual({
    fresh: 0,
    usable: 0,
    stale: 0,
    unknown: 0,
  });
});

test("getReportStats aggregates pipeline counts for the given runs", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 2 });
  repo.upsertCollectedLead(uniqueLead(), run.id);
  repo.upsertCollectedLead(uniqueLead(), run.id);
  repo.recordRunEvent(run.id, "parse_failed");
  repo.finishRun(run.id, "completed");

  const stats = repo.getReportStats([run.id]);
  expect(stats.totalCandidates).toBe(2);
  expect(stats.totalStored).toBe(2);
  expect(stats.totalDeduped).toBe(0);
  expect(stats.totalFetchFailed).toBe(0);
  expect(stats.totalParseFailed).toBe(1);
});

test("getReportStats counts companies and contact coverage within scope", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 3 });

  // Two companies have contacts, one does not.
  const withContact = uniqueLead({
    contacts: [
      {
        contactType: "email",
        value: "a@a.test",
        riskLevel: "low",
      },
    ],
  });
  const withContact2 = uniqueLead({
    contacts: [
      {
        contactType: "linkedin",
        value: "https://linkedin.com/in/b",
        riskLevel: "medium",
      },
    ],
  });
  const noContact = uniqueLead();

  const a = repo.upsertCollectedLead(withContact, run.id);
  const b = repo.upsertCollectedLead(withContact2, run.id);
  const c = repo.upsertCollectedLead(noContact, run.id);
  repo.writeLeadScore(score(a.companyId, run.id, { score: 80 }));
  repo.writeLeadScore(score(b.companyId, run.id, { score: 60 }));
  repo.writeLeadScore(score(c.companyId, run.id, { score: 40 }));
  repo.finishRun(run.id, "completed");

  const stats = repo.getReportStats([run.id]);
  expect(stats.totalCompanies).toBe(3);
  expect(stats.companiesWithContact).toBe(2);
});

test("getReportStats counts jobs by freshness within scope", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 3 });

  const fresh = uniqueLead({
    jobs: [
      {
        title: "BE",
        jobUrl: "https://fresh.example.com/be",
        freshness: "fresh",
      },
    ],
  });
  const usable = uniqueLead({
    jobs: [
      {
        title: "BE",
        jobUrl: "https://usable.example.com/be",
        freshness: "usable",
      },
    ],
  });
  const unknown = uniqueLead({
    jobs: [
      {
        title: "BE",
        jobUrl: "https://unknown.example.com/be",
        freshness: "unknown",
      },
    ],
  });
  const a = repo.upsertCollectedLead(fresh, run.id);
  const b = repo.upsertCollectedLead(usable, run.id);
  const c = repo.upsertCollectedLead(unknown, run.id);
  repo.writeLeadScore(score(a.companyId, run.id));
  repo.writeLeadScore(score(b.companyId, run.id));
  repo.writeLeadScore(score(c.companyId, run.id));
  repo.finishRun(run.id, "completed");

  const stats = repo.getReportStats([run.id]);
  expect(stats.totalJobs).toBe(3);
  expect(stats.jobsByFreshness.fresh).toBe(1);
  expect(stats.jobsByFreshness.usable).toBe(1);
  expect(stats.jobsByFreshness.unknown).toBe(1);
  expect(stats.jobsByFreshness.stale).toBe(0);
});

test("getReportStats buckets scores at 49/50/69/70/84/85 boundaries", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 6 });

  const samples: number[] = [49, 50, 69, 70, 84, 85];
  for (const s of samples) {
    const lead = uniqueLead();
    const stored = repo.upsertCollectedLead(lead, run.id);
    repo.writeLeadScore(score(stored.companyId, run.id, { score: s }));
  }
  repo.finishRun(run.id, "completed");

  const stats = repo.getReportStats([run.id]);
  // Mapped by label so a future label-rename surfaces here.
  const byLabel = Object.fromEntries(
    stats.scoreBuckets.map((b) => [b.label, b.count]),
  );
  // 49 → <50;  50, 69 → 50-69;  70, 84 → 70-84;  85 → 85+.
  expect(byLabel["<50"]).toBe(1);
  expect(byLabel["50-69"]).toBe(2);
  expect(byLabel["70-84"]).toBe(2);
  expect(byLabel["85+"]).toBe(1);
});

test("getReportStats groups decisions by scorer_version", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 3 });

  const a = repo.upsertCollectedLead(uniqueLead(), run.id);
  const b = repo.upsertCollectedLead(uniqueLead(), run.id);
  const c = repo.upsertCollectedLead(uniqueLead(), run.id);
  repo.writeLeadScore(
    score(a.companyId, run.id, {
      scorerVersion: "1.0.0",
      decision: "accepted_for_feishu",
    }),
  );
  repo.writeLeadScore(
    score(b.companyId, run.id, {
      scorerVersion: "1.0.0",
      decision: "local_only",
    }),
  );
  repo.writeLeadScore(
    score(c.companyId, run.id, {
      scorerVersion: "1.1.0",
      decision: "stale",
    }),
  );
  repo.finishRun(run.id, "completed");

  const stats = repo.getReportStats([run.id]);
  expect(stats.scorerVersionGroups).toHaveLength(2);

  const v10 = stats.scorerVersionGroups.find((g) => g.scorerVersion === "1.0.0");
  const v11 = stats.scorerVersionGroups.find((g) => g.scorerVersion === "1.1.0");
  expect(v10?.total).toBe(2);
  expect(v10?.decisions.acceptedForFeishu).toBe(1);
  expect(v10?.decisions.localOnly).toBe(1);
  expect(v11?.total).toBe(1);
  expect(v11?.decisions.stale).toBe(1);
});

// ---- S-4 regression ------------------------------------------------------
// This is the rule's poster-child failure: a latest-row subselect that only
// JOINs on run_id (instead of also FILTERing) pulls in a different run's
// score and lies to the operator. Run A and run B both touch the same
// company; querying B alone must report only B's latest decision.

test("getReportStats run B does NOT inherit run A's decision for the same company (S-4)", () => {
  const { repo } = createInMemoryRepository();

  const runA = repo.startRun({ source: "fake", limit: 1 });
  const lead = uniqueLead();
  const stored = repo.upsertCollectedLead(lead, runA.id);
  repo.writeLeadScore(
    score(stored.companyId, runA.id, { decision: "accepted_for_feishu" }),
  );
  repo.finishRun(runA.id, "completed");

  // Run B: same company, write a stale decision (a re-score in the new run).
  const runB = repo.startRun({ source: "fake", limit: 1 });
  repo.writeLeadScore(
    score(stored.companyId, runB.id, { decision: "stale", score: 30 }),
  );
  repo.finishRun(runB.id, "completed");

  // Scoping to run B must see exactly one stale and zero accepted.
  const statsB = repo.getReportStats([runB.id]);
  expect(statsB.decisions.stale).toBe(1);
  expect(statsB.decisions.acceptedForFeishu).toBe(0);
  // Buckets follow the same scope: only the score=30 from run B counts.
  const byLabel = Object.fromEntries(
    statsB.scoreBuckets.map((b) => [b.label, b.count]),
  );
  expect(byLabel["<50"]).toBe(1);
  expect(byLabel["70-84"]).toBe(0);

  // Sanity: aggregating both runs picks the LATEST per company (B is later),
  // so it's stale=1 — not stale=1 + accepted=1.
  const statsAll = repo.getReportStats([runA.id, runB.id]);
  expect(statsAll.decisions.stale).toBe(1);
  expect(statsAll.decisions.acceptedForFeishu).toBe(0);
});

test("getReportStats aggregates pipeline counts across multiple runs (since-window)", () => {
  const { repo } = createInMemoryRepository();
  const r1 = repo.startRun({ source: "fake", limit: 1 });
  repo.upsertCollectedLead(uniqueLead(), r1.id);
  repo.finishRun(r1.id, "completed");

  const r2 = repo.startRun({ source: "fake", limit: 1 });
  repo.upsertCollectedLead(uniqueLead(), r2.id);
  repo.recordRunEvent(r2.id, "fetch_failed");
  repo.finishRun(r2.id, "completed");

  const stats = repo.getReportStats([r1.id, r2.id]);
  expect(stats.totalCandidates).toBe(2);
  expect(stats.totalStored).toBe(2);
  expect(stats.totalFetchFailed).toBe(1);
});
