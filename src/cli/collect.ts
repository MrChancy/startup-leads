import type { LeadRepository, RunCounts } from "../types/index.ts";
import type { Collector } from "../collectors/types.ts";

export interface CollectResult {
  runId: string;
  counts: RunCounts;
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
    for (const lead of leads) {
      repo.upsertCollectedLead(lead, run.id);
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

  return { runId: run.id, counts: repo.countByRun(run.id) };
}
