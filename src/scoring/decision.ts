import type { Decision, ScoreCompanyInput } from "./types.ts";

// Score → decision plus rule overrides.
//
// Override priority (highest first) — pinned by decision.test.ts so a future
// reorder is a loud failure rather than a silent dashboard flip:
//   1. excluded_by_rule  (companies.excluded = 1)
//   2. stale             (every job is explicitly freshness='stale')
//   3. blocked_contact   (every contact is risk='blocked')
// Once no override fires, the score bands apply:
//   score >= 70          accepted_for_feishu
//   50 <= score < 70     local_only (or needs_review when contacts missing)
//   score < 50           local_only
//
// Per spec section "新鲜度": `unknown` is NOT `stale`. unknown jobs stay
// local until a careers enricher (TB-9) promotes them to `usable`. We only
// fire the stale override when every job is *explicitly* marked stale.

const ACCEPT_THRESHOLD = 70;
const REVIEW_BAND_LOW = 50;

function allJobsStale(input: ScoreCompanyInput) {
  return (
    input.jobs.length > 0 &&
    input.jobs.every((j) => j.freshness === "stale")
  );
}

function onlyBlockedContacts(input: ScoreCompanyInput) {
  return (
    input.contacts.length > 0 &&
    input.contacts.every((c) => c.riskLevel === "blocked")
  );
}

export function decideOutcome(
  score: number,
  input: ScoreCompanyInput,
): Decision {
  if (input.excludedByRule) return "excluded_by_rule";
  if (allJobsStale(input)) return "stale";
  if (onlyBlockedContacts(input)) return "blocked_contact";

  if (score >= ACCEPT_THRESHOLD) return "accepted_for_feishu";
  if (score >= REVIEW_BAND_LOW) {
    // Mid-band leads with no contacts at all are the canonical "we need a
    // human to enrich this before pushing" case.
    if (input.contacts.length === 0) return "needs_review";
    return "local_only";
  }
  return "local_only";
}
