import type { FreshnessStatus } from "../types/index.ts";

// Pure DTO inputs for the scorer. No db handle, no fetch, no fs. The caller
// (collect pipeline) materialises these from CollectedLead + assigned source
// ids before invoking scoreCompany.

export interface ScoreJob {
  title: string;
  freshness: FreshnessStatus;
  // evidenceSourceId points at the sources row that produced this job. Used
  // verbatim in match_reason entries so reviewers can trace each point back
  // to a fetched artefact. May be null when no source context is available
  // (e.g. manual seed leads or in-memory unit tests).
  evidenceSourceId: number | null;
}

export interface ScoreContact {
  contactType: string;
  riskLevel: "low" | "medium" | "high" | "blocked";
  evidenceSourceId: number | null;
}

export interface ScoreCompanyInput {
  companyId: number;
  // Direction tags as already stored — unknown strings are tolerated here
  // (they map to 0 contribution + a 'note: ignored unknown tag' entry). The
  // hard reject lives at the write path (TB-4).
  directionTags: readonly string[];
  jobs: readonly ScoreJob[];
  contacts: readonly ScoreContact[];
  // Rule-level overrides. Persisted on the company row (excluded /
  // exclusion_reason). Surfaced as a separate field so the scorer doesn't
  // re-implement the rules engine; collect just reads the column and passes
  // it in.
  excludedByRule: boolean;
  exclusionReason: string | null;
  // Primary source id for the lead itself; used as a fallback evidence id
  // when a component (e.g. direction tags) doesn't belong to any single job.
  primarySourceId: number | null;
  // Injected clock for deterministic freshness scoring.
  now: Date;
}

export type Decision =
  | "accepted_for_feishu"
  | "local_only"
  | "stale"
  | "blocked_contact"
  | "needs_review"
  | "excluded_by_rule";

export type ScoreComponent =
  | "job_match"
  | "direction"
  | "freshness"
  | "contact"
  | "actionability";

// One line of explanation per component. Multiple entries for the same
// component are allowed (e.g. one per matched job), and points sum to the
// component's score.
export interface MatchReasonEntry {
  component: ScoreComponent;
  points: number;
  evidenceSourceId: number | null;
  note: string;
}

export interface LeadScore {
  companyId: number;
  score: number;
  jobMatchScore: number;
  directionScore: number;
  freshnessScore: number;
  contactScore: number;
  actionabilityScore: number;
  matchReason: MatchReasonEntry[];
  decision: Decision;
  scorerVersion: string;
}
