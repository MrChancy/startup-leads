import type { DecisionCounts, RunCounts } from "../types/index.ts";

// Single source of truth for the minimal report. Both `collect` and
// `report --run` print this exact format so they stay in lockstep.
//
// Line 1: candidate / stored / deduped / fetch_failed / parse_failed.
// Line 2: decision distribution (TB-2). TB-11 will replace this with
// score-bucket + scorer_version groupings.
export function formatRunReport(
  runId: string,
  counts: RunCounts,
  decisions: DecisionCounts,
) {
  const summary =
    `Run ${runId} completed: ` +
    `${counts.candidates} candidates, ` +
    `${counts.stored} stored, ` +
    `${counts.deduped} dedupe, ` +
    `${counts.fetchFailed} fetch_failed, ` +
    `${counts.parseFailed} parse_failed`;

  const decisionLine =
    `Decisions: ` +
    `accepted=${decisions.acceptedForFeishu} ` +
    `local_only=${decisions.localOnly} ` +
    `needs_review=${decisions.needsReview} ` +
    `stale=${decisions.stale} ` +
    `blocked_contact=${decisions.blockedContact} ` +
    `excluded=${decisions.excludedByRule}`;

  return `${summary}\n${decisionLine}`;
}
