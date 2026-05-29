import { test, expect } from "bun:test";
import { createInMemoryRepository } from "./test-support.ts";
import type {
  CollectedLead,
  LeadScoreRecord,
} from "../../types/index.ts";

function sampleLead(): CollectedLead {
  return {
    companyName: "Acme AI",
    domain: "acme.ai",
    description: "An AI company",
    directionTags: ["ai-app"],
    jobs: [
      {
        title: "Backend Engineer",
        jobUrl: "https://acme.ai/jobs/be",
        freshness: "fresh",
      },
    ],
    contacts: [],
    source: {
      sourceType: "fake",
      sourceUrl: "fake://acme",
      sourceTitle: "fake collector",
      retrievedAt: new Date().toISOString(),
    },
  };
}

function sampleScore(companyId: number): LeadScoreRecord {
  return {
    companyId,
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
        evidenceSourceId: 1,
        note: "title:'Backend Engineer' matches backend engineer",
      },
      {
        component: "freshness",
        points: 15,
        evidenceSourceId: 1,
        note: "freshest job: fresh",
      },
    ],
    decision: "accepted_for_feishu",
    scorerVersion: "1.0.0",
  };
}

test("writeLeadScore inserts a row with all sub-scores and decision", () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const stored = repo.upsertCollectedLead(sampleLead(), run.id);

  repo.writeLeadScore(sampleScore(stored.companyId));

  const row = db
    .query<
      {
        company_id: number;
        score: number;
        job_match_score: number;
        direction_score: number;
        freshness_score: number;
        contact_score: number;
        actionability_score: number;
        decision: string;
        scorer_version: string;
        match_reason: string;
      },
      [number]
    >(
      `SELECT company_id, score, job_match_score, direction_score,
              freshness_score, contact_score, actionability_score,
              decision, scorer_version, match_reason
       FROM lead_scores WHERE company_id = ?`,
    )
    .get(stored.companyId);

  expect(row?.company_id).toBe(stored.companyId);
  expect(row?.score).toBe(82);
  expect(row?.job_match_score).toBe(35);
  expect(row?.direction_score).toBe(20);
  expect(row?.freshness_score).toBe(15);
  expect(row?.contact_score).toBe(7);
  expect(row?.actionability_score).toBe(5);
  expect(row?.decision).toBe("accepted_for_feishu");
  expect(row?.scorer_version).toBe("1.0.0");

  const reason = JSON.parse(row!.match_reason);
  expect(Array.isArray(reason)).toBe(true);
  expect(reason).toHaveLength(2);
  expect(reason[0]).toEqual({
    component: "job_match",
    points: 35,
    evidence_source_id: 1,
    note: "title:'Backend Engineer' matches backend engineer",
  });
});

test("writeLeadScore is append-only: two scores for the same company produce two rows", () => {
  // S-3: 'happy path runs twice without crashing'. Spec says each run writes
  // a new lead_scores row rather than overwriting, so history is queryable.
  const { repo, db } = createInMemoryRepository();
  const run1 = repo.startRun({ source: "fake", limit: 1 });
  const stored1 = repo.upsertCollectedLead(sampleLead(), run1.id);
  repo.writeLeadScore(sampleScore(stored1.companyId));
  repo.finishRun(run1.id, "completed");

  const run2 = repo.startRun({ source: "fake", limit: 1 });
  repo.upsertCollectedLead(sampleLead(), run2.id);
  repo.writeLeadScore({
    ...sampleScore(stored1.companyId),
    score: 55,
    decision: "local_only",
  });
  repo.finishRun(run2.id, "completed");

  const rows = db
    .query<{ score: number; decision: string }, [number]>(
      "SELECT score, decision FROM lead_scores WHERE company_id = ? ORDER BY id",
    )
    .all(stored1.companyId);
  expect(rows).toHaveLength(2);
  expect(rows[0]?.score).toBe(82);
  expect(rows[1]?.score).toBe(55);
});

test("countDecisionsByRun groups by latest decision per company in the run", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 3 });

  const baseLead = sampleLead();
  const a = repo.upsertCollectedLead(
    {
      ...baseLead,
      companyName: "A",
      domain: "a.com",
      jobs: [{ ...baseLead.jobs[0]!, jobUrl: "https://a.com/jobs/be" }],
    },
    run.id,
  );
  repo.writeLeadScore({
    ...sampleScore(a.companyId),
    decision: "accepted_for_feishu",
  });

  const b = repo.upsertCollectedLead(
    {
      ...baseLead,
      companyName: "B",
      domain: "b.com",
      jobs: [{ ...baseLead.jobs[0]!, jobUrl: "https://b.com/jobs/be" }],
    },
    run.id,
  );
  repo.writeLeadScore({
    ...sampleScore(b.companyId),
    decision: "local_only",
  });

  const c = repo.upsertCollectedLead(
    {
      ...baseLead,
      companyName: "C",
      domain: "c.com",
      jobs: [{ ...baseLead.jobs[0]!, jobUrl: "https://c.com/jobs/be" }],
    },
    run.id,
  );
  repo.writeLeadScore({
    ...sampleScore(c.companyId),
    decision: "stale",
  });

  repo.finishRun(run.id, "completed");

  expect(repo.countDecisionsByRun(run.id)).toEqual({
    acceptedForFeishu: 1,
    localOnly: 1,
    stale: 1,
    blockedContact: 0,
    needsReview: 0,
    excludedByRule: 0,
  });
});

test("countDecisionsByRun reads the latest score per company when re-scored in the same run", () => {
  // Idempotency story: re-running collect overwrites display semantics by
  // taking the most recent row, but old rows still exist for audit.
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const stored = repo.upsertCollectedLead(sampleLead(), run.id);
  repo.writeLeadScore({
    ...sampleScore(stored.companyId),
    decision: "local_only",
  });
  repo.writeLeadScore({
    ...sampleScore(stored.companyId),
    decision: "accepted_for_feishu",
  });
  repo.finishRun(run.id, "completed");

  expect(repo.countDecisionsByRun(run.id)).toEqual({
    acceptedForFeishu: 1,
    localOnly: 0,
    stale: 0,
    blockedContact: 0,
    needsReview: 0,
    excludedByRule: 0,
  });
});

test("countDecisionsByRun returns zeros for an unknown run id", () => {
  const { repo } = createInMemoryRepository();
  expect(repo.countDecisionsByRun("does-not-exist")).toEqual({
    acceptedForFeishu: 0,
    localOnly: 0,
    stale: 0,
    blockedContact: 0,
    needsReview: 0,
    excludedByRule: 0,
  });
});
