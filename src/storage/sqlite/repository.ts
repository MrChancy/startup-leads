import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { normalizeCompanyName } from "../../normalizers/company-name.ts";
import { isDirectionTag } from "../../types/direction-tags.ts";
import type {
  CareersSourceWrite,
  CollectedLead,
  CompanyScoreInputView,
  CsvExportRow,
  DecisionCounts,
  FreshnessStatus,
  GithubEnrichmentInput,
  GithubOrgCandidate,
  LeadRepository,
  LeadScoreDecision,
  LeadScoreMatchReasonEntry,
  LeadScoreRecord,
  PurgeCounts,
  PushCandidate,
  PushCandidateQuery,
  RiskLevel,
  RunCounts,
  RunRecord,
  RunStatus,
  StoredLeadResult,
  UnknownJobCandidate,
} from "../../types/index.ts";
import {
  previewPurgeCompany as previewPurgeCompanySql,
  previewPurgeContactsByRisk as previewPurgeContactsByRiskSql,
  previewPurgeOlderThan as previewPurgeOlderThanSql,
  purgeCompany as purgeCompanySql,
  purgeContactsByRisk as purgeContactsByRiskSql,
  purgeOlderThan as purgeOlderThanSql,
} from "./purge.ts";

// Normalize a job title into a comparable key. Used for the
// (company_id, normalized_title, location) job-uniqueness fallback. Company
// names use the alias-aware normalizeCompanyName instead.
function normalizeTitle(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// Extract the first path segment after `github.com/` as an org slug.
// `github.com/acme`        → "acme"
// `github.com/acme/site`   → "acme"
// `https://github.com/acme` → "acme"
// Anything that doesn't look like a github URL → null.
// We don't try to distinguish org vs. user accounts here — the GitHub API
// returns 404 on /orgs/<user>/public_members and the enricher treats that
// as "skip silently", which is exactly the same handling as a nonexistent
// org. Keeps the parser one line of intent.
function extractGithubOrgSlug(raw: string): string | null {
  const match = raw.match(/github\.com\/([\w-]+)/i);
  return match ? match[1]!.toLowerCase() : null;
}

// Partition direction tags into the legal subset (persisted) and rejected
// names (surfaced via sources.evidence_snippet). Returning both halves lets
// upsertCollectedLead emit the warning in the same transaction as the
// company/source rows so a rollback drops the warning too.
function partitionDirectionTags(tags: readonly string[] | undefined): {
  accepted: string[];
  rejected: string[];
} {
  if (!tags || tags.length === 0) return { accepted: [], rejected: [] };
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const tag of tags) {
    if (isDirectionTag(tag)) accepted.push(tag);
    else rejected.push(tag);
  }
  return { accepted, rejected };
}

export function createSqliteLeadRepository(db: Database): LeadRepository {
  // Prepared statements are created lazily on first call so the repo factory
  // stays cheap and a freshly migrated db is always ready.

  const insertRun = db.prepare<
    void,
    [string, string, string, number]
  >(
    "INSERT INTO runs (id, started_at, source, limit_value, status) VALUES (?, ?, ?, ?, 'partial')",
  );

  const updateRun = db.prepare<
    void,
    [string, string | null, string, string]
  >(
    "UPDATE runs SET status = ?, error_summary = ?, finished_at = ? WHERE id = ?",
  );

  const selectRun = db.prepare<
    {
      id: string;
      started_at: string;
      source: string;
      limit_value: number;
    },
    [string]
  >("SELECT id, started_at, source, limit_value FROM runs WHERE id = ?");

  const insertSource = db.prepare<
    { id: number },
    [string, string | null, string | null, string, string | null]
  >(
    `INSERT INTO sources (source_type, source_url, source_title, retrieved_at, evidence_snippet)
     VALUES (?, ?, ?, ?, ?) RETURNING id`,
  );

  const insertCompany = db.prepare<
    { id: number },
    [string, string, string | null, string | null, number, string, string]
  >(
    `INSERT INTO companies
     (name, normalized_name, description, direction_tags, needs_review, row_created_at, row_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  );

  const insertDomain = db.prepare<
    { id: number },
    [number, string, number, number | null, string]
  >(
    `INSERT INTO company_domains
     (company_id, domain, is_primary, source_id, row_created_at)
     VALUES (?, ?, ?, ?, ?)
     RETURNING id`,
  );

  // Step 1 of the 4-step dedupe rule: an exact domain alias resolves to a
  // known company. company_domains.domain is UNIQUE so at most one row.
  const selectCompanyByDomain = db.prepare<
    { company_id: number },
    [string]
  >("SELECT company_id FROM company_domains WHERE domain = ?");

  // Step 2 / Step 4: which companies share a normalized_name. ≥2 rows means
  // the spelling is ambiguous and the caller must NOT auto-merge.
  const selectCompaniesByNormalizedName = db.prepare<
    { id: number },
    [string]
  >("SELECT id FROM companies WHERE normalized_name = ?");

  const setPrimaryDomain = db.prepare<void, [number, string, number]>(
    "UPDATE companies SET primary_domain_id = ?, row_updated_at = ? WHERE id = ?",
  );

  const insertJob = db.prepare<
    void,
    [
      number,
      string,
      string,
      string | null,
      string | null,
      string | null,
      string | null,
      number | null,
      string,
      string,
    ]
  >(
    `INSERT INTO jobs
     (company_id, title, normalized_title, job_url, location, remote_policy, freshness_status, source_id, row_created_at, row_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertContact = db.prepare<
    void,
    [
      number,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      number | null,
      string | null,
      string,
      string,
    ]
  >(
    `INSERT INTO contacts
     (company_id, name, title, contact_type, value, profile_url, source_id, risk_level, row_created_at, row_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertEvent = db.prepare<
    void,
    [string, string, number | null, string]
  >(
    "INSERT INTO run_lead_events (run_id, event_type, company_id, created_at) VALUES (?, ?, ?, ?)",
  );

  const countEvents = db.prepare<
    { event_type: string; n: number },
    [string]
  >(
    "SELECT event_type, COUNT(*) AS n FROM run_lead_events WHERE run_id = ? GROUP BY event_type",
  );

  const insertScore = db.prepare<
    void,
    [
      number,
      string,
      number,
      number,
      number,
      number,
      number,
      number,
      string,
      string,
      string,
      string,
    ]
  >(
    `INSERT INTO lead_scores
     (company_id, run_id, score, job_match_score, direction_score, freshness_score,
      contact_score, actionability_score, match_reason, decision, scorer_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Decisions PRODUCED in a given run. We filter lead_scores by run_id (set
  // at writeLeadScore time) and pick the latest row per company so that
  // multiple score writes inside one run still display the last decision —
  // but old runs do NOT contribute. A re-run that fully dedupes correctly
  // reports zeros (pr-review H-1 regression pinned by lead-scores.test.ts).
  const decisionsByRun = db.prepare<
    { decision: string; n: number },
    [string]
  >(
    `WITH latest AS (
       SELECT company_id, decision
       FROM lead_scores ls
       WHERE ls.run_id = ?
         AND ls.id = (
           SELECT MAX(id) FROM lead_scores
           WHERE company_id = ls.company_id AND run_id = ls.run_id
         )
     )
     SELECT decision, COUNT(*) AS n
     FROM latest
     WHERE decision IS NOT NULL
     GROUP BY decision`,
  );

  // ---- TB-9 careers enricher statements ------------------------------------

  const listJobsByStatusStmt = db.prepare<
    {
      id: number;
      company_id: number;
      normalized_title: string | null;
      job_url: string | null;
    },
    [string]
  >(
    `SELECT id, company_id, normalized_title, job_url
     FROM jobs
     WHERE freshness_status = ?
     ORDER BY id`,
  );

  // Primary domain first, then the rest by id. The enricher filters out the
  // `hn:` synthetic keys at the SQL level so the JS side never sees a
  // non-probeable string. is_primary DESC ranks the primary first so the
  // typical case is one row, not a sort-then-pick.
  const httpDomainStmt = db.prepare<
    { domain: string },
    [number]
  >(
    `SELECT domain FROM company_domains
     WHERE company_id = ?
       -- pr-review H2: filter every synthetic-prefix domain, not just hn:.
       -- A real hostname never contains a colon (bytedance.com OK,
       -- hn:bytedance / github:vercel / yc:airbnb not), so one pattern
       -- handles TB-3b plus future collectors without a schema change.
       AND domain NOT LIKE '%:%'
     ORDER BY is_primary DESC, id ASC
     LIMIT 1`,
  );

  const insertCareersSourceStmt = db.prepare<
    { id: number },
    [string, string, string, string | null, string | null, string | null]
  >(
    `INSERT INTO sources
       (source_type, source_url, retrieved_at, fetch_status, parse_status, error_code, error_message)
     VALUES ('careers_page', ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  );

  // Only upgrade when the existing freshness is `unknown` so this method
  // can never demote a stronger source. The caller still gets `false` back
  // (changes() === 0) and reports it accurately.
  const upgradeJobStmt = db.prepare<
    void,
    [string, number, string, number]
  >(
    `UPDATE jobs
     SET freshness_status = ?,
         source_id = ?,
         row_updated_at = ?
     WHERE id = ?
       AND freshness_status = 'unknown'`,
  );

  const selectCompanyForScoreStmt = db.prepare<
    {
      direction_tags: string | null;
      excluded: number;
      exclusion_reason: string | null;
      primary_domain_id: number | null;
    },
    [number]
  >(
    `SELECT direction_tags, excluded, exclusion_reason, primary_domain_id
     FROM companies WHERE id = ?`,
  );

  const selectJobsForScoreStmt = db.prepare<
    { title: string | null; freshness_status: string | null; source_id: number | null },
    [number]
  >(
    `SELECT title, freshness_status, source_id FROM jobs
     WHERE company_id = ? ORDER BY id`,
  );

  const selectContactsForScoreStmt = db.prepare<
    { contact_type: string | null; risk_level: string | null; source_id: number | null },
    [number]
  >(
    `SELECT contact_type, risk_level, source_id FROM contacts
     WHERE company_id = ? ORDER BY id`,
  );

  const selectPrimarySourceForScoreStmt = db.prepare<
    { source_id: number | null },
    [number]
  >(
    `SELECT source_id FROM company_domains WHERE id = ?`,
  );

  // ---- TB-10 github enricher statements -----------------------------------

  // Discovery query: contacts whose source is NOT the enricher itself.
  // We must exclude rows that the github enricher already wrote (those
  // have source_type='github_profile') so re-running the enricher doesn't
  // treat its own outputs (`github.com/<member-login>`) as new orgs to
  // probe. The JOIN's LEFT-side guard catches contacts with NULL source
  // (legacy / hand-seeded rows) so they still count as discovery signals.
  const listGithubContactsStmt = db.prepare<
    { company_id: number; value: string | null },
    []
  >(
    `SELECT c.company_id, c.value FROM contacts c
     LEFT JOIN sources s ON s.id = c.source_id
     WHERE c.contact_type = 'github' AND c.value IS NOT NULL
       AND (s.source_type IS NULL OR s.source_type != 'github_profile')
     ORDER BY c.company_id, c.id`,
  );

  const insertGithubSourceStmt = db.prepare<
    { id: number },
    [string, string, string, string | null, string | null]
  >(
    `INSERT INTO sources
       (source_type, source_url, retrieved_at, fetch_status, error_code, error_message)
     VALUES ('github_profile', ?, ?, ?, ?, ?)
     RETURNING id`,
  );

  // Dedup guard for re-runs: skip a contact if (company_id, contact_type,
  // value) already exists. We can't use UNIQUE on the column because the
  // collect path also writes contacts and that schema is shared with TB-1.
  const existingContactStmt = db.prepare<
    { id: number },
    [number, string, string]
  >(
    `SELECT id FROM contacts
     WHERE company_id = ? AND contact_type = ? AND value = ?
     LIMIT 1`,
  );

  const insertGithubContactStmt = db.prepare<
    void,
    [
      number,
      string | null,
      string,
      string,
      string | null,
      number,
      string,
      number,
      string,
      string,
    ]
  >(
    `INSERT INTO contacts
       (company_id, name, contact_type, value, profile_url, source_id,
        risk_level, priority_rank, row_created_at, row_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // ---- TB-6 feishu push candidates -------------------------------------

  // Latest-score-per-company query. S-4: the subselect filters on
  // company_id and we pick MAX(id) within that scope. The outer WHERE
  // then rejects the latest row by decision / score. A company whose
  // latest row is stale (regardless of older accepted rows) won't match.
  const pushCandidateStmt = db.prepare<
    {
      company_id: number;
      name: string;
      description: string | null;
      direction_tags: string | null;
      score: number;
      scorer_version: string;
      match_reason: string;
      created_at: string;
    },
    [number]
  >(
    `SELECT c.id AS company_id,
            c.name,
            c.description,
            c.direction_tags,
            ls.score,
            ls.scorer_version,
            ls.match_reason,
            ls.created_at
     FROM lead_scores ls
     JOIN companies c ON c.id = ls.company_id
     WHERE ls.id = (
       SELECT MAX(ls2.id) FROM lead_scores ls2
       WHERE ls2.company_id = ls.company_id
     )
       AND ls.decision NOT IN ('stale', 'blocked_contact', 'excluded_by_rule')
       AND ls.score >= ?
     ORDER BY c.id`,
  );

  // Primary domain first (matches getPrimaryHttpDomain), but we want the
  // string itself for the payload — including synthetic hn: keys because
  // the Feishu record still wants SOMETHING to display rather than blank.
  // Caller knows hn:hash isn't a clickable domain; the mapper renders it
  // as-is and the human reviewer decides.
  const pushDomainStmt = db.prepare<
    { domain: string },
    [number]
  >(
    `SELECT domain FROM company_domains
     WHERE company_id = ?
     ORDER BY is_primary DESC, id ASC
     LIMIT 1`,
  );

  // Jobs for the payload: filter freshness to fresh/usable per spec
  // ("unknown 新鲜度默认排除"). The mapper will then truncate to top 3.
  // We return ALL matching jobs so the mapper's sort sees the full set;
  // pre-truncating in SQL would bake the sort order into the query and
  // make a future tweak require a schema-level change.
  const pushJobsStmt = db.prepare<
    {
      title: string | null;
      job_url: string | null;
      location: string | null;
      remote_policy: string | null;
      freshness_status: string | null;
      source_posted_at: string | null;
    },
    [number]
  >(
    `SELECT title, job_url, location, remote_policy, freshness_status, source_posted_at
     FROM jobs
     WHERE company_id = ?
       AND freshness_status IN ('fresh', 'usable')
     ORDER BY id`,
  );

  // Contacts: blocked-risk rows were already filtered at upsertCollectedLead
  // time so this query trusts the table. Returning everything keeps the
  // mapper free to apply the priority_rank → risk_level sort.
  const pushContactsStmt = db.prepare<
    {
      name: string | null;
      title: string | null;
      contact_type: string | null;
      value: string | null;
      profile_url: string | null;
      risk_level: string | null;
      priority_rank: number | null;
    },
    [number]
  >(
    `SELECT name, title, contact_type, value, profile_url, risk_level, priority_rank
     FROM contacts
     WHERE company_id = ?
     ORDER BY id`,
  );

  // Source URLs as evidence for the Feishu record. DISTINCT on URL so a
  // company touched by N collectors doesn't list the same HN thread N times;
  // ordered by id so the output is stable across runs (S-3 idempotency).
  const pushSourcesStmt = db.prepare<
    { source_url: string | null },
    [number, number, number]
  >(
    `SELECT DISTINCT s.source_url
     FROM sources s
     WHERE s.id IN (
       SELECT source_id FROM company_domains WHERE company_id = ? AND source_id IS NOT NULL
       UNION
       SELECT source_id FROM jobs            WHERE company_id = ? AND source_id IS NOT NULL
       UNION
       SELECT source_id FROM contacts        WHERE company_id = ? AND source_id IS NOT NULL
     )
     AND s.source_url IS NOT NULL
     ORDER BY s.id`,
  );

  // TB-5 CSV export. Same S-4 latest-row pattern as pushCandidateStmt, but
  // without the decision / score gates — the export covers EVERY scored
  // company. ORDER BY score DESC then company_id ASC keeps the output
  // byte-stable across runs (S-3).
  const exportCandidateStmt = db.prepare<
    {
      company_id: number;
      name: string;
      description: string | null;
      direction_tags: string | null;
      score: number;
      scorer_version: string;
      decision: string;
      match_reason: string;
      created_at: string;
    },
    []
  >(
    `SELECT c.id AS company_id,
            c.name,
            c.description,
            c.direction_tags,
            ls.score,
            ls.scorer_version,
            ls.decision,
            ls.match_reason,
            ls.created_at
     FROM lead_scores ls
     JOIN companies c ON c.id = ls.company_id
     WHERE ls.id = (
       SELECT MAX(ls2.id) FROM lead_scores ls2
       WHERE ls2.company_id = ls.company_id
     )
     ORDER BY ls.score DESC, c.id ASC`,
  );

  // Primary domain only (matches getPrimaryHttpDomain). Synthetic hn: keys
  // stay because CSV is an audit dump — the reviewer wants the real value,
  // not a sanitized one.
  const exportDomainStmt = db.prepare<
    { domain: string },
    [number]
  >(
    `SELECT domain FROM company_domains
     WHERE company_id = ?
     ORDER BY is_primary DESC, id ASC
     LIMIT 1`,
  );

  // ALL jobs for the company (no freshness filter — exporter rolls up).
  const exportJobsStmt = db.prepare<
    {
      title: string | null;
      location: string | null;
      freshness_status: string | null;
      source_posted_at: string | null;
    },
    [number]
  >(
    `SELECT title, location, freshness_status, source_posted_at
     FROM jobs
     WHERE company_id = ?
     ORDER BY id`,
  );

  // ALL contacts (no risk filter — the exporter excludes 'blocked' itself
  // for the "Recommended Contact" column, but the row count / surfacing
  // logic might still want to see them in future). Blocked-risk contacts
  // are rejected at upsert time, so in practice this returns low/medium/high.
  const exportContactsStmt = db.prepare<
    {
      name: string | null;
      contact_type: string | null;
      value: string | null;
      risk_level: string | null;
      priority_rank: number | null;
    },
    [number]
  >(
    `SELECT name, contact_type, value, risk_level, priority_rank
     FROM contacts
     WHERE company_id = ?
     ORDER BY id`,
  );

  function parseMatchReason(json: string): LeadScoreMatchReasonEntry[] {
    // The DB stores snake_case keys (per writeLeadScore); revert to camelCase
    // for the public DTO so callers don't need to know about the on-disk
    // shape.
    try {
      const parsed = JSON.parse(json) as Array<{
        component: string;
        points: number;
        evidence_source_id: number | null;
        note: string;
      }>;
      return parsed.map((entry) => ({
        component: entry.component,
        points: entry.points,
        evidenceSourceId: entry.evidence_source_id,
        note: entry.note,
      }));
    } catch {
      // A corrupt match_reason shouldn't break the whole listing; surface
      // an empty array so the row still goes through and the operator sees
      // "no reasons" rather than a crash.
      return [];
    }
  }

  return {
    withTransaction<T>(fn: () => T): T {
      // bun:sqlite's db.transaction returns a wrapped fn; invoke immediately.
      // Nested transactions use SAVEPOINTs, so wrapping a block that calls
      // upsertCollectedLead (already a tx) is safe.
      return db.transaction(fn)();
    },

    startRun({ source, limit }) {
      const id = randomUUID();
      const startedAt = new Date().toISOString();
      insertRun.run(id, startedAt, source, limit);
      const record: RunRecord = { id, startedAt, source, limit };
      return record;
    },

    finishRun(runId, status: RunStatus, errorSummary) {
      updateRun.run(
        status,
        errorSummary ?? null,
        new Date().toISOString(),
        runId,
      );
    },

    getRun(runId) {
      const row = selectRun.get(runId);
      if (!row) return null;
      return {
        id: row.id,
        startedAt: row.started_at,
        source: row.source,
        limit: row.limit_value,
      };
    },

    recordRunEvent(runId, eventType) {
      // company_id is null because these collector-reported failures (a
      // parse error on a discarded HN comment, a Firebase fetch that
      // exhausted retries) never produced a company row to point at.
      insertEvent.run(runId, eventType, null, new Date().toISOString());
    },

    upsertCollectedLead: db.transaction(
      (lead: CollectedLead, runId: string): StoredLeadResult => {
        const now = new Date().toISOString();

        // Reject leads with no retrieval timestamp BEFORE we write anything.
        // The spec ("contacts.source_id / retrieved_at non-null") means a
        // contact must reference a source that has retrieved_at; the cleanest
        // way to enforce that without a column on contacts is to demand the
        // source row arrive valid. Throwing here surfaces as parse_failed in
        // runCollect's per-lead try block.
        if (!lead.source.retrievedAt || lead.source.retrievedAt.length === 0) {
          throw new Error(
            "rejected lead: source.retrievedAt is empty (every contact must " +
              "trace back to a timestamped source)",
          );
        }

        insertEvent.run(runId, "candidate", null, now);

        // Direction tags AND blocked contacts are validated up front so any
        // warnings travel with the source row created below.
        // Warnings use a "warn:" prefix so future enrichers (TB-9/10) that
        // want to record actual evidence text into the same column can grep
        // and strip these without conflict. Multiple `warn:` lines join with
        // `\n` so each channel stays grep-able as a single line.
        const { accepted: acceptedTags, rejected: rejectedTags } =
          partitionDirectionTags(lead.directionTags);
        const blockedContactCount = lead.contacts.reduce(
          (n, c) => (c.riskLevel === "blocked" ? n + 1 : n),
          0,
        );
        const warnings: string[] = [];
        if (rejectedTags.length > 0) {
          warnings.push(
            `warn:direction_tag_rejected: ${rejectedTags.join(", ")}`,
          );
        }
        if (blockedContactCount > 0) {
          warnings.push(`warn:blocked_contact_rejected: ${blockedContactCount}`);
        }
        const evidenceSnippet = warnings.length === 0 ? null : warnings.join("\n");

        const sourceRow = insertSource.get(
          lead.source.sourceType,
          lead.source.sourceUrl ?? null,
          lead.source.sourceTitle ?? null,
          lead.source.retrievedAt,
          evidenceSnippet,
        );
        const sourceId = sourceRow!.id;

        // ---- Step 1: domain match ----------------------------------------
        if (lead.domain) {
          const existing = selectCompanyByDomain.get(lead.domain);
          if (existing) {
            insertEvent.run(runId, "deduped", existing.company_id, now);
            return { companyId: existing.company_id, status: "deduped" };
          }
        }

        const normalizedName = normalizeCompanyName(lead.companyName);

        // ---- Step 2 / Step 4: normalized_name lookup ---------------------
        // Empty normalized_name (e.g. whitespace-only company name) is
        // treated as "no match" — we never want every nameless lead to
        // collide on "".
        const nameMatches = normalizedName
          ? selectCompaniesByNormalizedName.all(normalizedName)
          : [];

        if (nameMatches.length === 1) {
          // Step 2: merge into the single existing row. New domain (if any)
          // joins as a non-primary alias; we deliberately do NOT touch the
          // existing primary_domain_id — the first domain to land is "real",
          // later finds are aliases until a human says otherwise.
          const existingId = nameMatches[0]!.id;
          if (lead.domain) {
            insertDomain.run(existingId, lead.domain, 0, sourceId, now);
          }
          insertEvent.run(runId, "deduped", existingId, now);
          return { companyId: existingId, status: "deduped" };
        }

        // ---- Step 3 / Step 4: create new ---------------------------------
        // Step 4 is "step 3 + needs_review=1". Both paths share the insert.
        const needsReview = nameMatches.length >= 2 ? 1 : 0;
        const companyRow = insertCompany.get(
          lead.companyName,
          normalizedName,
          lead.description ?? null,
          acceptedTags.length > 0 ? acceptedTags.join(",") : null,
          needsReview,
          now,
          now,
        );
        const companyId = companyRow!.id;

        if (lead.domain) {
          const domainRow = insertDomain.get(
            companyId,
            lead.domain,
            1,
            sourceId,
            now,
          );
          setPrimaryDomain.run(domainRow!.id, now, companyId);
        }

        for (const job of lead.jobs) {
          insertJob.run(
            companyId,
            job.title,
            normalizeTitle(job.title),
            job.jobUrl ?? null,
            job.location ?? null,
            job.remotePolicy ?? null,
            job.freshness,
            sourceId,
            now,
            now,
          );
        }

        // Naive contact persistence: insert each row as supplied. Dedup by
        // profile_url/value belongs to TB-9/TB-10's enrichers + TB-12 purge.
        // blocked-risk contacts are intentionally NOT persisted (see spec
        // "Local Data Retention").
        for (const contact of lead.contacts) {
          if (contact.riskLevel === "blocked") continue;
          insertContact.run(
            companyId,
            contact.name ?? null,
            contact.title ?? null,
            contact.contactType,
            contact.value,
            contact.profileUrl ?? null,
            sourceId,
            contact.riskLevel,
            now,
            now,
          );
        }

        insertEvent.run(runId, "stored", companyId, now);

        return { companyId, status: "created" };
      },
    ),

    writeLeadScore(score: LeadScoreRecord) {
      // Single-INSERT — no transaction needed per S-2 ("multi-statement
      // writes must be transactional"). bun:sqlite makes a single prepared
      // statement atomic by itself.
      // match_reason JSON keys match the spec's snake_case shape; the
      // in-memory DTO uses camelCase per TS convention.
      const reasonJson = JSON.stringify(
        score.matchReason.map((entry) => ({
          component: entry.component,
          points: entry.points,
          evidence_source_id: entry.evidenceSourceId,
          note: entry.note,
        })),
      );
      insertScore.run(
        score.companyId,
        score.runId,
        score.score,
        score.jobMatchScore,
        score.directionScore,
        score.freshnessScore,
        score.contactScore,
        score.actionabilityScore,
        reasonJson,
        score.decision,
        score.scorerVersion,
        new Date().toISOString(),
      );
    },

    countDecisionsByRun(runId): DecisionCounts {
      const counts: DecisionCounts = {
        acceptedForFeishu: 0,
        localOnly: 0,
        stale: 0,
        blockedContact: 0,
        needsReview: 0,
        excludedByRule: 0,
      };
      for (const row of decisionsByRun.all(runId)) {
        switch (row.decision) {
          case "accepted_for_feishu":
            counts.acceptedForFeishu = row.n;
            break;
          case "local_only":
            counts.localOnly = row.n;
            break;
          case "stale":
            counts.stale = row.n;
            break;
          case "blocked_contact":
            counts.blockedContact = row.n;
            break;
          case "needs_review":
            counts.needsReview = row.n;
            break;
          case "excluded_by_rule":
            counts.excludedByRule = row.n;
            break;
        }
      }
      return counts;
    },

    previewPurgeOlderThan(cutoff: string): PurgeCounts {
      return previewPurgeOlderThanSql(db, cutoff);
    },
    previewPurgeContactsByRisk(
      levels: ReadonlyArray<RiskLevel>,
    ): PurgeCounts {
      return previewPurgeContactsByRiskSql(db, levels);
    },
    previewPurgeCompany(domain: string): PurgeCounts {
      return previewPurgeCompanySql(db, domain);
    },
    purgeOlderThan(cutoff: string): PurgeCounts {
      return purgeOlderThanSql(db, cutoff);
    },
    purgeContactsByRisk(levels: ReadonlyArray<RiskLevel>): PurgeCounts {
      return purgeContactsByRiskSql(db, levels);
    },
    purgeCompany(domain: string): PurgeCounts {
      return purgeCompanySql(db, domain);
    },

    countByRun(runId): RunCounts {
      const counts: RunCounts = {
        candidates: 0,
        stored: 0,
        deduped: 0,
        fetchFailed: 0,
        parseFailed: 0,
      };
      for (const row of countEvents.all(runId)) {
        switch (row.event_type) {
          case "candidate":
            counts.candidates = row.n;
            break;
          case "stored":
            counts.stored = row.n;
            break;
          case "deduped":
            counts.deduped = row.n;
            break;
          case "fetch_failed":
            counts.fetchFailed = row.n;
            break;
          case "parse_failed":
            counts.parseFailed = row.n;
            break;
        }
      }
      return counts;
    },

    // ---- TB-9 careers enricher --------------------------------------------

    listJobsWithFreshness(status: FreshnessStatus): UnknownJobCandidate[] {
      const rows = listJobsByStatusStmt.all(status);
      return rows
        // A NULL / empty normalized_title couldn't match anything anyway and
        // would let an empty string match every page (substring of ""). The
        // matcher also guards against this, but skipping here saves a fetch.
        .filter((row) => row.normalized_title && row.normalized_title.trim() !== "")
        .map((row) => ({
          jobId: row.id,
          companyId: row.company_id,
          normalizedTitle: row.normalized_title!,
          jobUrl: row.job_url,
        }));
    },

    getPrimaryHttpDomain(companyId: number): string | null {
      const row = httpDomainStmt.get(companyId);
      return row?.domain ?? null;
    },

    recordCareersSource(input: CareersSourceWrite): number {
      const now = new Date().toISOString();
      const row =
        input.fetchStatus === "success"
          ? insertCareersSourceStmt.get(
              input.url,
              now,
              "success",
              input.parseStatus,
              null,
              null,
            )
          : insertCareersSourceStmt.get(
              input.url,
              now,
              "failed",
              null,
              input.errorCode,
              input.errorMessage,
            );
      // SQLite RETURNING always yields a row when the INSERT succeeded; if it
      // didn't we'd already have thrown. A null here would be a driver-level
      // surprise so we surface it loudly rather than coerce.
      if (!row) {
        throw new Error("recordCareersSource: INSERT did not return an id");
      }
      return row.id;
    },

    upgradeJobFreshness(
      jobId: number,
      to: FreshnessStatus,
      sourceId: number,
    ): boolean {
      const now = new Date().toISOString();
      // The prepared UPDATE has `freshness_status = 'unknown'` in its WHERE,
      // so we cannot demote a stronger source. bun:sqlite's Statement.run
      // returns { changes, lastInsertRowid } — `changes` is 0 when the row
      // was already past `unknown`, 1 when the upgrade landed.
      const result = upgradeJobStmt.run(to, sourceId, now, jobId);
      return result.changes > 0;
    },

    // ---- TB-10 github enricher --------------------------------------------

    listGithubOrgCandidates(): GithubOrgCandidate[] {
      const rows = listGithubContactsStmt.all();
      // Dedupe per (companyId, orgSlug); a company can leak multiple
      // github URLs that resolve to the same org (the bare org URL plus
      // org/site, etc.) and we want one probe per org per company.
      const seen = new Set<string>();
      const out: GithubOrgCandidate[] = [];
      for (const row of rows) {
        if (!row.value) continue;
        const slug = extractGithubOrgSlug(row.value);
        if (!slug) continue;
        const key = `${row.company_id}\0${slug}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ companyId: row.company_id, orgSlug: slug });
      }
      return out;
    },

    recordGithubEnrichment: db.transaction(
      (
        input: GithubEnrichmentInput,
      ): { sourceId: number; insertedCount: number } => {
        const now = new Date().toISOString();
        const sourceUrl = `https://api.github.com/orgs/${input.orgSlug}/public_members`;
        const fetchStatus = input.fetchStatus;
        const errorCode =
          fetchStatus === "success" ? null : input.errorCode;
        const errorMessage =
          fetchStatus === "success" ? null : input.errorMessage;

        const sourceRow = insertGithubSourceStmt.get(
          sourceUrl,
          now,
          fetchStatus,
          errorCode,
          errorMessage,
        );
        if (!sourceRow) {
          throw new Error(
            "recordGithubEnrichment: INSERT did not return an id",
          );
        }
        const sourceId = sourceRow.id;

        let insertedCount = 0;
        for (const c of input.contacts) {
          // Idempotency: a re-run that sees the same (company, type, value)
          // must NOT create a duplicate. We pre-check rather than relying
          // on a UNIQUE constraint because the collect path already writes
          // contacts under a shared schema (TB-1) and we don't want to
          // change the legacy write to use ON CONFLICT.
          const existing = existingContactStmt.get(
            input.companyId,
            c.contactType,
            c.value,
          );
          if (existing) continue;
          insertGithubContactStmt.run(
            input.companyId,
            c.name,
            c.contactType,
            c.value,
            c.profileUrl,
            sourceId,
            c.riskLevel,
            c.priorityRank,
            now,
            now,
          );
          insertedCount++;
        }

        return { sourceId, insertedCount };
      },
    ),

    listPushCandidates(query: PushCandidateQuery): PushCandidate[] {
      const rows = pushCandidateStmt.all(query.minScore);
      return rows.map((row) => {
        const domainRow = pushDomainStmt.get(row.company_id);
        const jobs = pushJobsStmt.all(row.company_id).map((j) => ({
          title: j.title ?? "",
          jobUrl: j.job_url,
          location: j.location,
          remotePolicy: j.remote_policy,
          // The IN ('fresh', 'usable') guard in pushJobsStmt means we never
          // see unknown/stale here; the cast is therefore safe but we
          // default defensively in case a future migration loosens the
          // WHERE clause.
          freshness:
            (j.freshness_status as FreshnessStatus | null) ?? "unknown",
          sourcePostedAt: j.source_posted_at,
        }));
        const contacts = pushContactsStmt.all(row.company_id).map((c) => ({
          name: c.name,
          title: c.title,
          contactType: c.contact_type ?? "",
          value: c.value ?? "",
          profileUrl: c.profile_url,
          riskLevel: (c.risk_level as RiskLevel | null) ?? "low",
          priorityRank: c.priority_rank,
        }));
        const sources = pushSourcesStmt
          .all(row.company_id, row.company_id, row.company_id)
          .map((s) => s.source_url)
          .filter((url): url is string => url !== null);
        const directionTags = row.direction_tags
          ? row.direction_tags.split(",").map((t) => t.trim()).filter(Boolean)
          : [];
        return {
          companyId: row.company_id,
          name: row.name,
          domain: domainRow?.domain ?? null,
          description: row.description,
          directionTags,
          jobs,
          contacts,
          sources,
          score: row.score,
          scorerVersion: row.scorer_version,
          matchReason: parseMatchReason(row.match_reason),
          lastCheckedAt: row.created_at,
        };
      });
    },

    listAllForExport(): CsvExportRow[] {
      const rows = exportCandidateStmt.all();
      return rows.map((row) => {
        const domainRow = exportDomainStmt.get(row.company_id);
        const jobs = exportJobsStmt.all(row.company_id).map((j) => ({
          title: j.title ?? "",
          location: j.location,
          freshness:
            (j.freshness_status as FreshnessStatus | null) ?? "unknown",
          sourcePostedAt: j.source_posted_at,
        }));
        const contacts = exportContactsStmt.all(row.company_id).map((c) => ({
          name: c.name,
          contactType: c.contact_type ?? "",
          value: c.value ?? "",
          riskLevel: (c.risk_level as RiskLevel | null) ?? "low",
          priorityRank: c.priority_rank,
        }));
        const directionTags = row.direction_tags
          ? row.direction_tags.split(",").map((t) => t.trim()).filter(Boolean)
          : [];
        return {
          companyId: row.company_id,
          name: row.name,
          domain: domainRow?.domain ?? null,
          description: row.description,
          directionTags,
          jobs,
          contacts,
          score: row.score,
          scorerVersion: row.scorer_version,
          decision: row.decision as LeadScoreDecision,
          matchReason: parseMatchReason(row.match_reason),
          lastCheckedAt: row.created_at,
        };
      });
    },

    getCompanyScoreInput(companyId: number, now: Date): CompanyScoreInputView {
      const company = selectCompanyForScoreStmt.get(companyId);
      if (!company) {
        throw new Error(
          `getCompanyScoreInput: company ${companyId} not found`,
        );
      }
      const jobs = selectJobsForScoreStmt.all(companyId).map((row) => ({
        title: row.title ?? "",
        // The DB column is unconstrained TEXT; we validated values at write
        // time but still defend by mapping unknown text to "unknown" rather
        // than letting a typo flow into the scorer.
        freshness: (row.freshness_status as FreshnessStatus | null) ?? "unknown",
        evidenceSourceId: row.source_id ?? null,
      }));
      const contacts = selectContactsForScoreStmt.all(companyId).map((row) => ({
        contactType: row.contact_type ?? "",
        riskLevel: (row.risk_level as RiskLevel | null) ?? "low",
        evidenceSourceId: row.source_id ?? null,
      }));
      const directionTags = company.direction_tags
        ? company.direction_tags.split(",").map((t) => t.trim()).filter(Boolean)
        : [];
      const primarySourceId =
        company.primary_domain_id !== null
          ? selectPrimarySourceForScoreStmt.get(company.primary_domain_id)?.source_id ?? null
          : null;
      return {
        companyId,
        directionTags,
        jobs,
        contacts,
        excludedByRule: company.excluded === 1,
        exclusionReason: company.exclusion_reason,
        primarySourceId,
        now,
      };
    },
  };
}
