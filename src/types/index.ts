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

// What listGithubOrgCandidates returns. One row per (company, org_slug)
// pair derived from existing `contact_type='github'` rows. Companies with
// no github contact are not returned — the enricher waits until somebody
// actually leaked a github URL before acting (no guess-the-org heuristic).
export interface GithubOrgCandidate {
  companyId: number;
  // The path segment after `github.com/`. Lower-cased; never includes a
  // slash, trailing dot, or query string. May be either an org or a user;
  // the API tells us which when we hit /orgs/<slug>/public_members (404 on
  // user accounts), so we don't try to guess here.
  orgSlug: string;
}

// Persisted shape for one github-sourced contact. priorityRank is assigned
// by the ranker BEFORE the call so the repo never re-orders rows; we want
// "what the ranker said" to land in the DB verbatim.
export interface GithubEnrichmentContact {
  contactType: "email" | "github";
  value: string;
  profileUrl: string | null;
  name: string | null;
  riskLevel: "low" | "medium";
  priorityRank: number;
}

interface GithubEnrichmentInputCommon {
  companyId: number;
  orgSlug: string;
  contacts: ReadonlyArray<GithubEnrichmentContact>;
}

export type GithubEnrichmentInput =
  | (GithubEnrichmentInputCommon & {
      fetchStatus: "success";
      errorCode?: undefined;
      errorMessage?: undefined;
    })
  | (GithubEnrichmentInputCommon & {
      fetchStatus: "failed" | "deferred";
      errorCode: string;
      errorMessage: string;
    });

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

  // TB-10 GitHub enricher. Additive: existing callers don't touch these.
  //
  // Returns one (companyId, orgSlug) per company that has at least one
  // `contact_type='github'` row whose value path-segment looks like an org
  // slug. Companies without a github contact are not returned — the
  // enricher acts only on signals a real source already gave us.
  listGithubOrgCandidates(): GithubOrgCandidate[];

  // Persist a github enrichment outcome — one sources row plus 0..N
  // contacts — in a single transaction (S-2). Contacts whose
  // (company_id, contact_type, value) already exist are skipped silently
  // so re-running the enricher is idempotent. Returns the new sources.id
  // plus the count of contact rows actually inserted (excluding the
  // silently-skipped duplicates) so the caller can drive an honest
  // "contacts created" counter and gate its re-score on real change
  // (careers C3 lesson — a re-score row with zero contact change just
  // attributes a stale decision to the enrich run).
  recordGithubEnrichment(
    input: GithubEnrichmentInput,
  ): { sourceId: number; insertedCount: number };

  // TB-6 feishu push candidates. Read-only — no transaction needed.
  // Returns one row per company whose LATEST lead_scores row clears the
  // exclusion + score gates. "Latest" means MAX(lead_scores.id) per
  // company; the SQL filters on that latest row only (S-4 — earlier
  // accepted rows must NOT resurrect a now-stale company).
  //
  // Per spec § 推送行为规则:
  //   - decision NOT IN ('stale', 'blocked_contact', 'excluded_by_rule')
  //   - score >= minScore
  //   - jobs filtered to freshness IN ('fresh', 'usable') — unknown is
  //     excluded unless a careers/github enricher upgraded it to usable.
  //   - blocked-risk contacts are already filtered at write time
  //     (upsertCollectedLead skips them); this query does not need to
  //     re-filter.
  //
  // Caller is responsible for any further mapping (top-3 truncation,
  // payload assembly). Reading per-company jobs/contacts/sources is N+1
  // but candidate counts are small (push thresholds keep them in the
  // dozens, not thousands) so a JOIN-heavy single query would trade
  // clarity for no measurable win.
  listPushCandidates(query: PushCandidateQuery): PushCandidate[];
}

export interface PushCandidateQuery {
  minScore: number;
}

export interface PushCandidate {
  companyId: number;
  name: string;
  domain: string | null;
  description: string | null;
  directionTags: readonly string[];
  jobs: ReadonlyArray<{
    title: string;
    jobUrl: string | null;
    location: string | null;
    remotePolicy: string | null;
    freshness: FreshnessStatus;
    sourcePostedAt: string | null;
  }>;
  contacts: ReadonlyArray<{
    name: string | null;
    title: string | null;
    contactType: string;
    value: string;
    profileUrl: string | null;
    riskLevel: RiskLevel;
    priorityRank: number | null;
  }>;
  // Source URLs ("https://news.ycombinator.com/item?id=...", careers page,
  // etc.) collected from the sources table. Distinct + ordered by id so
  // the dry-run output is stable across runs.
  sources: readonly string[];
  score: number;
  scorerVersion: string;
  matchReason: readonly LeadScoreMatchReasonEntry[];
  // ISO timestamp of the latest lead_scores row's created_at. Spec
  // "Last Checked At".
  lastCheckedAt: string;
}
