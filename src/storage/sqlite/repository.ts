import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
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

// Normalize a company display name into a comparable key.
// TB-1 keeps this trivial; TB-4 will replace it with the alias-aware version.
function normalize(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
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
    [string, string | null, string | null, string]
  >(
    "INSERT INTO sources (source_type, source_url, source_title, retrieved_at) VALUES (?, ?, ?, ?) RETURNING id",
  );

  const insertCompany = db.prepare<
    { id: number },
    [string, string, string | null, string | null, string, string]
  >(
    `INSERT INTO companies
     (name, normalized_name, description, direction_tags, row_created_at, row_updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
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

  // TB-1 minimal idempotency: step 1 of TB-4's 4-step dedupe rule (domain match).
  // Steps 2-4 (normalized_name fallback, needs_review on multi-match) remain TB-4.
  const selectCompanyByDomain = db.prepare<
    { company_id: number },
    [string]
  >("SELECT company_id FROM company_domains WHERE domain = ?");

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
     (company_id, score, job_match_score, direction_score, freshness_score,
      contact_score, actionability_score, match_reason, decision, scorer_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Decision per company is "latest lead_scores row in this run". To stay
  // append-only, we resolve which companies belong to a run via
  // run_lead_events (stored / deduped events), then pick MAX(id) per company
  // in lead_scores. SQLite's correlated subquery is fine here — at TB-2
  // scale runs hold <10 companies; TB-11 will replace this with a proper
  // indexed materialised view if needed.
  const decisionsByRun = db.prepare<
    { decision: string; n: number },
    [string]
  >(
    `WITH run_companies AS (
       SELECT DISTINCT company_id
       FROM run_lead_events
       WHERE run_id = ? AND company_id IS NOT NULL
     ),
     latest AS (
       SELECT rc.company_id, (
         SELECT decision FROM lead_scores ls
         WHERE ls.company_id = rc.company_id
         ORDER BY ls.id DESC LIMIT 1
       ) AS decision
       FROM run_companies rc
     )
     SELECT decision, COUNT(*) AS n
     FROM latest
     WHERE decision IS NOT NULL
     GROUP BY decision`,
  );

  return {
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

    upsertCollectedLead: db.transaction(
      (lead: CollectedLead, runId: string): StoredLeadResult => {
        const now = new Date().toISOString();

        insertEvent.run(runId, "candidate", null, now);

        const sourceRow = insertSource.get(
          lead.source.sourceType,
          lead.source.sourceUrl ?? null,
          lead.source.sourceTitle ?? null,
          lead.source.retrievedAt,
        );
        const sourceId = sourceRow!.id;

        if (lead.domain) {
          const existing = selectCompanyByDomain.get(lead.domain);
          if (existing) {
            insertEvent.run(runId, "deduped", existing.company_id, now);
            return { companyId: existing.company_id, status: "deduped" };
          }
        }

        const companyRow = insertCompany.get(
          lead.companyName,
          normalize(lead.companyName),
          lead.description ?? null,
          lead.directionTags?.join(",") ?? null,
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
            normalize(job.title),
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
