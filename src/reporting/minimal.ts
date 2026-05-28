import type { RunCounts } from "../types/index.ts";

// Single source of truth for the TB-1 report line. Both `collect` and
// `report --run` print this exact format so they stay in lockstep.
export function formatRunReport(runId: string, counts: RunCounts) {
  return (
    `Run ${runId} completed: ` +
    `${counts.candidates} candidates, ` +
    `${counts.stored} stored, ` +
    `${counts.deduped} dedupe, ` +
    `${counts.fetchFailed} fetch_failed, ` +
    `${counts.parseFailed} parse_failed`
  );
}
