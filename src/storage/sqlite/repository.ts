import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { normalizeCompanyName } from "../../normalizers/company-name.ts";
import { isDirectionTag } from "../../types/direction-tags.ts";
import type {
  CollectedLead,
  DecisionCounts,
  LeadRepository,
  LeadScoreRecord,
  RunCounts,
  RunRecord,
  RunStatus,
  StoredLeadResult,
} from "../../types/index.ts";

// Normalize a job title into a comparable key. Used for the
// (company_id, normalized_title, location) job-uniqueness fallback. Company
// names use the alias-aware normalizeCompanyName instead.
function normalizeTitle(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
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

        insertEvent.run(runId, "candidate", null, now);

        // Direction tags are validated up front so the warning, if any,
        // travels with the source row created below.
        // Warnings use a "warn:" prefix so future enrichers (TB-9/10) that
        // want to record actual evidence text into the same column can grep
        // and strip these without conflict. Multiple `warn:` lines may be
        // appended in the future; for now there is exactly one channel.
        const { accepted: acceptedTags, rejected: rejectedTags } =
          partitionDirectionTags(lead.directionTags);
        const evidenceSnippet =
          rejectedTags.length === 0
            ? null
            : `warn:direction_tag_rejected: ${rejectedTags.join(", ")}`;

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
  };
}
