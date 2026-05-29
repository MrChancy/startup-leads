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
    const { leads, parseFailed, fetchFailed } = await collector.collect({
      limit,
    });
    // Record collector-reported failures BEFORE any per-lead work so they
    // attribute to the run even if a later upsert/scoring throw aborts the
    // loop. The repo writes are tiny (one INSERT each) and outside the
    // per-lead transaction so they survive a downstream rollback.
    for (let i = 0; i < parseFailed; i++) {
      repo.recordRunEvent(run.id, "parse_failed");
    }
    for (let i = 0; i < fetchFailed; i++) {
      repo.recordRunEvent(run.id, "fetch_failed");
    }
    const now = new Date();
    for (const lead of leads) {
      // pr-review H-2: upsert + scoring are wrapped in one transaction so
      // a failure in writeLeadScore (or scorer regression that throws on
      // the input) rolls back the company / domain / source / events too —
      // no permanent "stored without a score" orphans. Nested SAVEPOINTs
      // mean the inner upsertCollectedLead tx still works.
      // TB-12: per-lead errors (e.g. empty source.retrievedAt) get recorded
      // as parse_failed and the loop continues. A single bad collector
      // payload shouldn't abort the whole run.
      try {
        repo.withTransaction(() => {
          const stored = repo.upsertCollectedLead(lead, run.id);
          // Skip scoring on dedupe: the existing company already has its
          // most recent scoring snapshot from the previous run, and
          // re-scoring would duplicate audit rows without new evidence.
          if (stored.status === "deduped") return;
          const scoreInput = toScoreInput(lead, stored.companyId, now);
          const result = scoreCompany(scoreInput);
          repo.writeLeadScore({
            companyId: result.companyId,
            runId: run.id,
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
        });
      } catch (perLeadErr) {
        // Per-lead failure: inner tx already rolled back, no orphan rows.
        // Surface to stderr so operators see the underlying message — silent
        // counters were the L-6 finding on PR #5. Then record on the run so
        // countByRun reports parse_failed; do NOT re-throw, the next lead
        // might still be fine.
        const msg =
          perLeadErr instanceof Error ? perLeadErr.message : String(perLeadErr);
        process.stderr.write(`collect: lead failed — ${msg}\n`);
        repo.recordRunEvent(run.id, "parse_failed");
      }
    }
    // Note (M-5): when a per-lead tx rolls back, the `candidate` event it
    // emitted is also undone. countByRun therefore reports
    // `candidates = stored + deduped` (no failed leads), and `parse_failed`
    // tracks the failures separately. This is intentional: "candidates"
    // counts what made it past the storage gate, not raw collector output.
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
