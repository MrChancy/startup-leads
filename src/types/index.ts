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
// TB-4 will add 'duplicate' once the full 4-step dedupe rule lands. When
// it does, DecisionCounts (below), the switch in countDecisionsByRun
// (repository.ts), and the report line in src/reporting/minimal.ts all need
// updating together.
export type LeadScoreDecision =
  | "accepted_for_feishu"
  | "local_only"
  | "stale"
  | "blocked_contact"
  | "needs_review"
  | "excluded_by_rule";

export interface LeadScoreRecord {
  companyId: number;
  runId: string;
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

// Row counts touched (or that would be touched in preview) by a purge call.
// Keys mirror SQLite table names so CLI output / aggregations can iterate
// without a separate name map. `sources` is always 0 — purge never deletes
// audit rows (FK is ON DELETE SET NULL), but it's listed so the field
// shape is identical between preview and real-delete output.
export interface PurgeCounts {
  companies: number;
  company_domains: number;
  jobs: number;
  contacts: number;
  sources: number;
  lead_scores: number;
  push_events: number;
}

export type RiskLevel = "low" | "medium" | "high" | "blocked";

// What the careers enricher needs to do its job. Kept here (next to
// LeadRepository) so the public storage surface stays in one file.
export interface UnknownJobCandidate {
  jobId: number;
  companyId: number;
  normalizedTitle: string;
  // Job URL is included so a future enricher can dedupe by URL even when
  // the title is generic; v1 uses the title only.
  jobUrl: string | null;
}

export interface CareersSourceWriteSuccess {
  url: string;
  fetchStatus: "success";
  parseStatus: "matched" | "no_match";
}

export interface CareersSourceWriteFailure {
  url: string;
  fetchStatus: "failed";
  errorCode: string;
  errorMessage: string;
}

export type CareersSourceWrite =
  | CareersSourceWriteSuccess
  | CareersSourceWriteFailure;

// Subset of ScoreCompanyInput the repo can rebuild from rows. The enricher
// then layers the scorer-specific `now` and computes the rest. We import
// from scoring here is intentional — re-scoring is the whole point of the
// enrichment pipeline and the input shape is stable.
//
// The scoring types stay one-way independent (scoring never imports from
// storage), so this file plays adapter.
export interface CompanyScoreInputView {
  companyId: number;
  directionTags: readonly string[];
  jobs: ReadonlyArray<{
    title: string;
    freshness: FreshnessStatus;
    evidenceSourceId: number | null;
  }>;
  contacts: ReadonlyArray<{
    contactType: string;
    riskLevel: RiskLevel;
    evidenceSourceId: number | null;
  }>;
  excludedByRule: boolean;
  exclusionReason: string | null;
  primarySourceId: number | null;
  now: Date;
}

export interface LeadRepository {
  startRun(input: { source: string; limit: number }): RunRecord;
  finishRun(runId: string, status: RunStatus, errorSummary?: string): void;
  getRun(runId: string): RunRecord | null;
  upsertCollectedLead(lead: CollectedLead, runId: string): StoredLeadResult;
  // Append a free-form event (e.g. "parse_failed", "fetch_failed") to the
  // run. countByRun aggregates these into the matching RunCounts field.
  // Reserved for collector-reported failures that don't map to a company id;
  // upsertCollectedLead still owns "candidate"/"stored"/"deduped".
  recordRunEvent(runId: string, eventType: string): void;
  countByRun(runId: string): RunCounts;
  writeLeadScore(score: LeadScoreRecord): void;
  // Wrap a block in a single SQLite transaction. Nested `db.transaction`
  // calls become SAVEPOINTs, so it composes cleanly with the per-method
  // transactions inside the repo (e.g. upsertCollectedLead). Used by
  // runCollect so a partial scoring failure rolls back the whole lead.
  withTransaction<T>(fn: () => T): T;
  // Reads back the most recent score row per company seen in the run.
  countDecisionsByRun(runId: string): DecisionCounts;

  // TB-12 purge. preview methods are pure reads (no transaction needed) and
  // share predicate SQL with the matching real-delete methods so they can
  // never drift. Real-delete methods are wrapped in a single SQLite
  // transaction so a downstream FK violation rolls back the whole purge.
  previewPurgeOlderThan(cutoff: string): PurgeCounts;
  previewPurgeContactsByRisk(levels: ReadonlyArray<RiskLevel>): PurgeCounts;
  previewPurgeCompany(domain: string): PurgeCounts;
  purgeOlderThan(cutoff: string): PurgeCounts;
  purgeContactsByRisk(levels: ReadonlyArray<RiskLevel>): PurgeCounts;
  purgeCompany(domain: string): PurgeCounts;

  // TB-9 careers enricher. These methods are additive: existing callers
  // (collect, report, purge) don't touch them.
  //
  // listJobsWithFreshness returns every job currently sitting at `status`.
  // The enricher iterates the `unknown` rows and tries to probe each
  // company's careers page. Returning the company id alongside the job
  // means the enricher can `getPrimaryHttpDomain(companyId)` without an
  // extra round-trip per job.
  listJobsWithFreshness(status: FreshnessStatus): UnknownJobCandidate[];

  // Returns a non-hn: domain for the company, or null if every domain on
  // file is a synthetic hn:<hash> key (issue #25). The enricher uses null
  // as "skip this company silently — there's no real URL to probe."
  getPrimaryHttpDomain(companyId: number): string | null;

  // Persist a careers-page probe outcome (success-with-match,
  // success-without-match, or fetch failure). Returns the new sources.id.
  // The enricher passes that id to upgradeJobFreshness so the source row is
  // the audit trail for the upgrade.
  recordCareersSource(input: CareersSourceWrite): number;

  // Move the job from `unknown` to `to` (typically `usable`). Returns true
  // if a row changed, false if the job was already at >= `to` strength so
  // the enricher can keep counters honest. Never demotes a stronger source:
  // a job already `fresh` is skipped silently and the method returns false.
  upgradeJobFreshness(
    jobId: number,
    to: FreshnessStatus,
    sourceId: number,
  ): boolean;

  // Read back everything the scorer needs to re-score a company after an
  // enrichment write. `now` is injected so tests stay deterministic.
  getCompanyScoreInput(companyId: number, now: Date): CompanyScoreInputView;
}
