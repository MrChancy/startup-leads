// Domain types and the storage contract.
// Everything outside src/storage/sqlite/ talks to storage through LeadRepository.

export type FreshnessStatus = "fresh" | "usable" | "stale" | "unknown";

export interface CollectedJob {
  title: string;
  jobUrl?: string;
  location?: string;
  remotePolicy?: string;
  freshness: FreshnessStatus;
  sourcePostedAt?: string;
  sourceUpdatedAt?: string;
}

export interface CollectedContact {
  name?: string;
  title?: string;
  contactType: string;
  value: string;
  profileUrl?: string;
  riskLevel: "low" | "medium" | "high" | "blocked";
}

export interface CollectedLead {
  companyName: string;
  domain?: string;
  description?: string;
  directionTags?: string[];
  jobs: CollectedJob[];
  contacts: CollectedContact[];
  source: {
    sourceType: string;
    sourceUrl?: string;
    sourceTitle?: string;
    retrievedAt: string;
  };
}

export interface StoredLeadResult {
  companyId: number;
  status: "created" | "deduped";
}

export interface RunRecord {
  id: string;
  startedAt: string;
  source: string;
  limit: number;
}

export interface RunCounts {
  candidates: number;
  stored: number;
  deduped: number;
  fetchFailed: number;
  parseFailed: number;
}

export type RunStatus = "completed" | "partial" | "failed";

// Decision enum is duplicated by name (not by import) here to avoid making
// the public storage surface depend on src/scoring/. The scorer is the
// source of truth; this type only constrains what the repo can persist.
export type LeadScoreDecision =
  | "accepted_for_feishu"
  | "local_only"
  | "stale"
  | "blocked_contact"
  | "needs_review"
  | "excluded_by_rule";

export interface LeadScoreRecord {
  companyId: number;
  score: number;
  jobMatchScore: number;
  directionScore: number;
  freshnessScore: number;
  contactScore: number;
  actionabilityScore: number;
  matchReason: LeadScoreMatchReasonEntry[];
  decision: LeadScoreDecision;
  scorerVersion: string;
}

export interface LeadScoreMatchReasonEntry {
  component: string;
  points: number;
  evidenceSourceId: number | null;
  note: string;
}

export interface DecisionCounts {
  acceptedForFeishu: number;
  localOnly: number;
  stale: number;
  blockedContact: number;
  needsReview: number;
  excludedByRule: number;
}

export interface LeadRepository {
  startRun(input: { source: string; limit: number }): RunRecord;
  finishRun(runId: string, status: RunStatus, errorSummary?: string): void;
  getRun(runId: string): RunRecord | null;
  upsertCollectedLead(lead: CollectedLead, runId: string): StoredLeadResult;
  countByRun(runId: string): RunCounts;
  writeLeadScore(score: LeadScoreRecord): void;
  // Reads back the most recent score row per company seen in the run.
  countDecisionsByRun(runId: string): DecisionCounts;
}
