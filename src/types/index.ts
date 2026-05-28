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

export interface LeadRepository {
  startRun(input: { source: string; limit: number }): RunRecord;
  finishRun(runId: string, status: RunStatus, errorSummary?: string): void;
  upsertCollectedLead(lead: CollectedLead, runId: string): StoredLeadResult;
  countByRun(runId: string): RunCounts;
}
