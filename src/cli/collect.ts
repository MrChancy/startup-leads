import type {
  CollectedLead,
  DecisionCounts,
  LeadRepository,
  RunCounts,
} from "../types/index.ts";
import type { Collector } from "../collectors/types.ts";
import { scoreCompany } from "../scoring/score.ts";
import type {
  ScoreCompanyInput,
  ScoreContact,
  ScoreJob,
} from "../scoring/types.ts";

export interface CollectResult {
  runId: string;
  counts: RunCounts;
  decisions: DecisionCounts;
}

// Adapt the storage DTO to the scorer DTO. Pure transform; no IO.
// In TB-2 we don't yet have evidence_source_id wired from the storage layer
// back into the DTO (sources rows are created inside upsertCollectedLead and
// the id isn't returned). Setting them to null is honest: the scorer's
// match_reason entries simply omit a specific source pointer, which the
// JSON column accepts. TB-3b / TB-5 can plumb real ids through when the HN
// collector lands.
function toScoreInput(
  lead: CollectedLead,
  companyId: number,
  now: Date,
): ScoreCompanyInput {
  const jobs: ScoreJob[] = lead.jobs.map((j) => ({
    title: j.title,
    freshness: j.freshness,
    evidenceSourceId: null,
  }));
  const contacts: ScoreContact[] = lead.contacts.map((c) => ({
    contactType: c.contactType,
    riskLevel: c.riskLevel,
    evidenceSourceId: null,
  }));
  return {
    companyId,
    directionTags: lead.directionTags ?? [],
    jobs,
    contacts,
    // TB-4 owns the rule-engine columns; until then leads are never excluded
    // by rule at collect time.
    excludedByRule: false,
    exclusionReason: null,
    primarySourceId: null,
    now,
  };
}

export async function runCollect(input: {
  repo: LeadRepository;
  collector: Collector;
  limit: number;
}): Promise<CollectResult> {
  const { repo, collector, limit } = input;
  const run = repo.startRun({ source: collector.source, limit });

  try {
    const leads = await collector.collect({ limit });
    const now = new Date();
    for (const lead of leads) {
      const stored = repo.upsertCollectedLead(lead, run.id);
      // Skip scoring on dedupe: the existing company already has the
      // freshest scoring snapshot from the previous run, and re-scoring it
      // here would duplicate audit rows without new evidence. TB-11 will
      // revisit this once HN evidence is re-ingestable per run.
      if (stored.status === "deduped") continue;
      const scoreInput = toScoreInput(lead, stored.companyId, now);
      const result = scoreCompany(scoreInput);
      repo.writeLeadScore({
        companyId: result.companyId,
        score: result.score,
        jobMatchScore: result.jobMatchScore,
        directionScore: result.directionScore,
        freshnessScore: result.freshnessScore,
        contactScore: result.contactScore,
        actionabilityScore: result.actionabilityScore,
        matchReason: result.matchReason,
        decision: result.decision,
        scorerVersion: result.scorerVersion,
      });
    }
    repo.finishRun(run.id, "completed");
  } catch (err) {
    repo.finishRun(
      run.id,
      "failed",
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }

  return {
    runId: run.id,
    counts: repo.countByRun(run.id),
    decisions: repo.countDecisionsByRun(run.id),
  };
}
