import type {
  MatchReasonEntry,
  ScoreCompanyInput,
} from "../types.ts";
import type { ComponentResult } from "./job-match.ts";

export const ACTIONABILITY_MAX = 10;

const JOB_HALF = 5;
const CONTACT_HALF = 5;

// Actionability is the "can a human act on this in one step today?" signal.
// The full 10 points require both a live job (so there's something to apply
// to / reference in outreach) and a reachable contact (so we know who to
// reach). Either half on its own is still useful but not a clean ask.

export function scoreActionability(input: ScoreCompanyInput): ComponentResult {
  const entries: MatchReasonEntry[] = [];
  let total = 0;

  const liveJob = input.jobs.find(
    (j) => j.freshness === "fresh" || j.freshness === "usable",
  );
  if (liveJob) {
    entries.push({
      component: "actionability",
      points: JOB_HALF,
      evidenceSourceId: liveJob.evidenceSourceId,
      note: `live ${liveJob.freshness} job: '${liveJob.title}'`,
    });
    total += JOB_HALF;
  } else if (input.jobs.length === 0) {
    entries.push({
      component: "actionability",
      points: 0,
      evidenceSourceId: input.primarySourceId,
      note: "no jobs to act on",
    });
  } else {
    entries.push({
      component: "actionability",
      points: 0,
      evidenceSourceId: input.jobs[0]?.evidenceSourceId ?? input.primarySourceId,
      note: "no live jobs (all stale/unknown)",
    });
  }

  const reachable = input.contacts.find(
    (c) => c.riskLevel === "low" || c.riskLevel === "medium",
  );
  if (reachable) {
    entries.push({
      component: "actionability",
      points: CONTACT_HALF,
      evidenceSourceId: reachable.evidenceSourceId,
      note: `reachable contact (${reachable.contactType}, ${reachable.riskLevel})`,
    });
    total += CONTACT_HALF;
  } else if (input.contacts.length === 0) {
    entries.push({
      component: "actionability",
      points: 0,
      evidenceSourceId: input.primarySourceId,
      note: "no contacts to reach",
    });
  } else {
    entries.push({
      component: "actionability",
      points: 0,
      evidenceSourceId:
        input.contacts[0]?.evidenceSourceId ?? input.primarySourceId,
      note: "no reachable contacts (all high-risk/blocked)",
    });
  }

  return { points: total, entries };
}
