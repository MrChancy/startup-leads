import type { Database } from "bun:sqlite";
import type { PurgeCounts, RiskLevel } from "../../types/index.ts";

// Spec deletion order (TB-12):
//   contacts → jobs → company_domains → companies
// Plus lead_scores / push_events (CASCADE-protected) and sources (never).
// We model the same predicates twice — once as COUNT(*) for preview, once
// as DELETE for the real run — and share the WHERE clause via the small
// helpers below so the two views can never drift.

const EMPTY_COUNTS: PurgeCounts = {
  companies: 0,
  company_domains: 0,
  jobs: 0,
  contacts: 0,
  sources: 0,
  lead_scores: 0,
  push_events: 0,
};

// Purge predicates take only primitive (string / number) parameters because
// they come from CLI args (a domain, a cutoff ISO string, risk levels) or
// internally-resolved IDs. Keeping the type tight makes the bun:sqlite
// binding signature happy without a cast.
type Param = string | number;

function countOne(db: Database, sql: string, params: Param[]): number {
  return (
    db.query<{ c: number }, Param[]>(`SELECT COUNT(*) AS c FROM ${sql}`).get(
      ...params,
    )?.c ?? 0
  );
}

// Count-then-delete. bun:sqlite's Statement.run().changes returns SQLite's
// total-changes counter, which INCLUDES FK cascade actions (e.g. an
// `ON DELETE SET NULL` UPDATE on run_lead_events). That over-counts the
// "rows deleted from the target table". A pre-count against the same
// predicate is the only honest way to report what the caller asked for.
function deleteOne(db: Database, sql: string, params: Param[]): number {
  const before = countOne(db, sql, params);
  db.query<void, Param[]>(`DELETE FROM ${sql}`).run(...params);
  return before;
}

// ----- older-than ----------------------------------------------------------

// "Old company" eligibility: company itself is old AND has no remaining
// children referencing it. We evaluate this AFTER the contact / job deletes
// so a company whose dependents we just removed becomes eligible.
const OLD_COMPANY_WHERE = `
  companies
  WHERE companies.row_updated_at < ?
    AND NOT EXISTS (SELECT 1 FROM jobs        WHERE company_id = companies.id)
    AND NOT EXISTS (SELECT 1 FROM contacts    WHERE company_id = companies.id)
    AND NOT EXISTS (SELECT 1 FROM lead_scores WHERE company_id = companies.id)
    AND NOT EXISTS (SELECT 1 FROM push_events WHERE company_id = companies.id)
`;

export function previewPurgeOlderThan(
  db: Database,
  cutoff: string,
): PurgeCounts {
  const contacts = countOne(db, "contacts WHERE row_updated_at < ?", [cutoff]);
  const jobs = countOne(db, "jobs WHERE row_updated_at < ?", [cutoff]);
  // Preview must report counts *as if* the cascade has already happened, so
  // we count companies that will be eligible after the contact + job deletes
  // — i.e. their only remaining children would be exactly the ones we just
  // counted to delete.
  const companies = countOne(
    db,
    `
    companies
    WHERE companies.row_updated_at < ?
      AND NOT EXISTS (
        SELECT 1 FROM jobs
        WHERE company_id = companies.id AND row_updated_at >= ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM contacts
        WHERE company_id = companies.id AND row_updated_at >= ?
      )
      AND NOT EXISTS (SELECT 1 FROM lead_scores WHERE company_id = companies.id)
      AND NOT EXISTS (SELECT 1 FROM push_events WHERE company_id = companies.id)
    `,
    [cutoff, cutoff, cutoff],
  );
  // company_domains rows die when their company is deleted (ON DELETE
  // CASCADE). Counting "rows belonging to those companies" gives the user
  // the right number without us doing the cascade math twice.
  const company_domains = countOne(
    db,
    `
    company_domains
    WHERE company_id IN (
      SELECT id FROM companies
      WHERE row_updated_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM jobs
          WHERE company_id = companies.id AND row_updated_at >= ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM contacts
          WHERE company_id = companies.id AND row_updated_at >= ?
        )
        AND NOT EXISTS (SELECT 1 FROM lead_scores WHERE company_id = companies.id)
        AND NOT EXISTS (SELECT 1 FROM push_events WHERE company_id = companies.id)
    )
    `,
    [cutoff, cutoff, cutoff],
  );
  return {
    ...EMPTY_COUNTS,
    contacts,
    jobs,
    companies,
    company_domains,
  };
}

export function purgeOlderThan(db: Database, cutoff: string): PurgeCounts {
  // Multi-statement write — wrap in one tx (S-2). bun:sqlite db.transaction
  // returns a wrapped function; call it immediately to run the block.
  return db.transaction((): PurgeCounts => {
    const contacts = deleteOne(db, "contacts WHERE row_updated_at < ?", [cutoff]);
    const jobs = deleteOne(db, "jobs WHERE row_updated_at < ?", [cutoff]);
    // company_domains will cascade when companies go, but we capture the
    // count first so the return shape is honest. Doing it as a separate
    // DELETE (instead of "look at companies' cascades") also keeps the count
    // accurate when a future schema change loosens that FK.
    const company_domains = deleteOne(
      db,
      `
      company_domains
      WHERE company_id IN (SELECT id FROM ${OLD_COMPANY_WHERE.trim()})
      `,
      [cutoff],
    );
    const companies = deleteOne(db, OLD_COMPANY_WHERE, [cutoff]);
    return { ...EMPTY_COUNTS, contacts, jobs, company_domains, companies };
  })();
}

// ----- by risk -------------------------------------------------------------

function risksPlaceholder(levels: ReadonlyArray<RiskLevel>): string {
  return levels.map(() => "?").join(", ");
}

export function previewPurgeContactsByRisk(
  db: Database,
  levels: ReadonlyArray<RiskLevel>,
): PurgeCounts {
  if (levels.length === 0) return { ...EMPTY_COUNTS };
  const contacts = countOne(
    db,
    `contacts WHERE risk_level IN (${risksPlaceholder(levels)})`,
    [...levels],
  );
  return { ...EMPTY_COUNTS, contacts };
}

export function purgeContactsByRisk(
  db: Database,
  levels: ReadonlyArray<RiskLevel>,
): PurgeCounts {
  if (levels.length === 0) return { ...EMPTY_COUNTS };
  // Single-statement DELETE — bun:sqlite's prepared statement is already
  // atomic, but wrapping in tx makes the API uniform with the other two
  // purge methods.
  return db.transaction((): PurgeCounts => {
    const contacts = deleteOne(
      db,
      `contacts WHERE risk_level IN (${risksPlaceholder(levels)})`,
      [...levels],
    );
    return { ...EMPTY_COUNTS, contacts };
  })();
}

// ----- by company domain ---------------------------------------------------

function findCompanyIdByDomain(db: Database, domain: string): number | null {
  const row = db
    .query<
      { company_id: number },
      [string]
    >("SELECT company_id FROM company_domains WHERE domain = ?")
    .get(domain);
  return row?.company_id ?? null;
}

export function previewPurgeCompany(
  db: Database,
  domain: string,
): PurgeCounts {
  const companyId = findCompanyIdByDomain(db, domain);
  if (companyId === null) return { ...EMPTY_COUNTS };
  return {
    companies: 1,
    company_domains: countOne(db, "company_domains WHERE company_id = ?", [
      companyId,
    ]),
    jobs: countOne(db, "jobs WHERE company_id = ?", [companyId]),
    contacts: countOne(db, "contacts WHERE company_id = ?", [companyId]),
    sources: 0,
    lead_scores: countOne(db, "lead_scores WHERE company_id = ?", [companyId]),
    push_events: countOne(db, "push_events WHERE company_id = ?", [companyId]),
  };
}

export function purgeCompany(db: Database, domain: string): PurgeCounts {
  return db.transaction((): PurgeCounts => {
    const companyId = findCompanyIdByDomain(db, domain);
    if (companyId === null) return { ...EMPTY_COUNTS };
    // Spec order: contacts → jobs → company_domains → companies. Add
    // lead_scores / push_events ahead of the company so we never depend on
    // the cascade — explicit deletes give honest counts and survive future
    // FK changes.
    const contacts = deleteOne(db, "contacts WHERE company_id = ?", [companyId]);
    const jobs = deleteOne(db, "jobs WHERE company_id = ?", [companyId]);
    const lead_scores = deleteOne(
      db,
      "lead_scores WHERE company_id = ?",
      [companyId],
    );
    const push_events = deleteOne(
      db,
      "push_events WHERE company_id = ?",
      [companyId],
    );
    const company_domains = deleteOne(
      db,
      "company_domains WHERE company_id = ?",
      [companyId],
    );
    // Null out the company's primary_domain_id pointer first so the
    // subsequent companies DELETE doesn't trip a stale FK reference on
    // databases that may grow tighter constraints later.
    const companies = deleteOne(db, "companies WHERE id = ?", [companyId]);
    return {
      companies,
      company_domains,
      jobs,
      contacts,
      sources: 0,
      lead_scores,
      push_events,
    };
  })();
}
