import { scoreActionability } from "./components/actionability.ts";
import { scoreContact } from "./components/contact.ts";
import { scoreDirection } from "./components/direction.ts";
import { scoreFreshness } from "./components/freshness.ts";
import { scoreJobMatch } from "./components/job-match.ts";
import { decideOutcome } from "./decision.ts";
import type { LeadScore, ScoreCompanyInput } from "./types.ts";
import { SCORER_VERSION } from "./version.ts";

// Pure function — takes a DTO, returns a fully-populated LeadScore. No db,
// no fs, no network. The caller (collect pipeline) is responsible for
// materialising the input and persisting the output.
export function scoreCompany(input: ScoreCompanyInput): LeadScore {
  const jobMatch = scoreJobMatch(input);
  const direction = scoreDirection(input);
  const freshness = scoreFreshness(input);
  const contact = scoreContact(input);
  const actionability = scoreActionability(input);

  const score =
    jobMatch.points +
    direction.points +
    freshness.points +
    contact.points +
    actionability.points;

  return {
    companyId: input.companyId,
    score,
    jobMatchScore: jobMatch.points,
    directionScore: direction.points,
    freshnessScore: freshness.points,
    contactScore: contact.points,
    actionabilityScore: actionability.points,
    matchReason: [
      ...jobMatch.entries,
      ...direction.entries,
      ...freshness.entries,
      ...contact.entries,
      ...actionability.entries,
    ],
    decision: decideOutcome(score, input),
    scorerVersion: SCORER_VERSION,
  };
}
