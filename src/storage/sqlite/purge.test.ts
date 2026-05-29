import { test, expect } from "bun:test";
import { createInMemoryRepository } from "./test-support.ts";
import type { CollectedLead, LeadRepository } from "../../types/index.ts";

// All purge tests share this pattern:
//  1. Build a known fixture (company + jobs + contacts + optional score/push_event).
//  2. Call preview → assert counts.
//  3. Verify table rows did NOT change.
//  4. Call real purge → assert counts match preview.
//  5. Verify table rows are gone (or remain, for sources / push_events with
//     ON DELETE CASCADE for some / SET NULL for others).

function leadOf(over: Partial<CollectedLead> = {}): CollectedLead {
  return {
    companyName: "Acme AI",
    domain: "acme.ai",
    directionTags: ["ai-app"],
    jobs: [
      {
        title: "Backend Engineer",
        jobUrl: "https://acme.ai/jobs/be",
        freshness: "fresh",
      },
    ],
    contacts: [
      {
        contactType: "email",
        value: "alice@acme.ai",
        riskLevel: "low",
      },
    ],
    source: {
      sourceType: "fake",
      sourceUrl: "fake://acme",
      sourceTitle: "Fake",
      retrievedAt: new Date().toISOString(),
    },
    ...over,
  };
}

function tableCount(db: import("bun:sqlite").Database, name: string): number {
  // name is a hard-coded table list at every call site — never user input.
  return (
    db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM ${name}`).get()?.c ?? 0
  );
}

// Force a row's row_updated_at to a fixed timestamp so cutoff tests are
// deterministic. We don't want a "sleep until row is old" pattern.
function backdateCompany(
  db: import("bun:sqlite").Database,
  companyId: number,
  iso: string,
) {
  db.query("UPDATE companies SET row_updated_at = ? WHERE id = ?").run(
    iso,
    companyId,
  );
}
function backdateJobs(
  db: import("bun:sqlite").Database,
  companyId: number,
  iso: string,
) {
  db.query("UPDATE jobs SET row_updated_at = ? WHERE company_id = ?").run(
    iso,
    companyId,
  );
}
function backdateContacts(
  db: import("bun:sqlite").Database,
  companyId: number,
  iso: string,
) {
  db.query("UPDATE contacts SET row_updated_at = ? WHERE company_id = ?").run(
    iso,
    companyId,
  );
}

// Insert a push_events row so purgeCompany has something to cascade.
function insertPushEvent(
  db: import("bun:sqlite").Database,
  companyId: number,
) {
  db.query(
    "INSERT INTO push_events (company_id, sink, status) VALUES (?, 'feishu', 'pending')",
  ).run(companyId);
}

// Insert a lead_scores row (we don't need a meaningful score, just FK presence).
function insertScoreRow(
  repo: LeadRepository,
  companyId: number,
  runId: string,
) {
  repo.writeLeadScore({
    companyId,
    runId,
    score: 0,
    jobMatchScore: 0,
    directionScore: 0,
    freshnessScore: 0,
    contactScore: 0,
    actionabilityScore: 0,
    matchReason: [],
    decision: "local_only",
    scorerVersion: "test",
  });
}

// --- previewPurgeOlderThan -------------------------------------------------

test("previewPurgeOlderThan counts old rows and does not delete anything", () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const stored = repo.upsertCollectedLead(leadOf(), run.id);
  const old = "2020-01-01T00:00:00.000Z";
  backdateCompany(db, stored.companyId, old);
  backdateJobs(db, stored.companyId, old);
  backdateContacts(db, stored.companyId, old);

  const before = {
    companies: tableCount(db, "companies"),
    jobs: tableCount(db, "jobs"),
    contacts: tableCount(db, "contacts"),
    domains: tableCount(db, "company_domains"),
  };

  const cutoff = "2024-01-01T00:00:00.000Z";
  const preview = repo.previewPurgeOlderThan(cutoff);
  expect(preview.contacts).toBe(1);
  expect(preview.jobs).toBe(1);
  // Company is eligible (old + no remaining children after the contact/job
  // counts above would be removed) — but preview reports the would-be delete.
  expect(preview.companies).toBe(1);
  expect(preview.company_domains).toBe(1);
  expect(preview.sources).toBe(0);

  // Nothing was deleted by preview.
  expect(tableCount(db, "companies")).toBe(before.companies);
  expect(tableCount(db, "jobs")).toBe(before.jobs);
  expect(tableCount(db, "contacts")).toBe(before.contacts);
  expect(tableCount(db, "company_domains")).toBe(before.domains);
});

test("purgeOlderThan actually deletes the same rows preview reported", () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const stored = repo.upsertCollectedLead(leadOf(), run.id);
  const old = "2020-01-01T00:00:00.000Z";
  backdateCompany(db, stored.companyId, old);
  backdateJobs(db, stored.companyId, old);
  backdateContacts(db, stored.companyId, old);

  const cutoff = "2024-01-01T00:00:00.000Z";
  const preview = repo.previewPurgeOlderThan(cutoff);
  const deleted = repo.purgeOlderThan(cutoff);

  expect(deleted.companies).toBe(preview.companies);
  expect(deleted.jobs).toBe(preview.jobs);
  expect(deleted.contacts).toBe(preview.contacts);
  expect(deleted.company_domains).toBe(preview.company_domains);

  expect(tableCount(db, "companies")).toBe(0);
  expect(tableCount(db, "jobs")).toBe(0);
  expect(tableCount(db, "contacts")).toBe(0);
  expect(tableCount(db, "company_domains")).toBe(0);
});

test("purgeOlderThan keeps a recent company even when its children are old", () => {
  // Spec subtlety: companies.row_updated_at only changes when the company row
  // itself changes. A recently-inserted company with old jobs/contacts should
  // NOT be deleted — we only delete old jobs/contacts.
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const stored = repo.upsertCollectedLead(leadOf(), run.id);
  // Company stays recent (its row_updated_at = now). Jobs + contacts go old.
  const old = "2020-01-01T00:00:00.000Z";
  backdateJobs(db, stored.companyId, old);
  backdateContacts(db, stored.companyId, old);

  const cutoff = "2024-01-01T00:00:00.000Z";
  const deleted = repo.purgeOlderThan(cutoff);
  expect(deleted.jobs).toBe(1);
  expect(deleted.contacts).toBe(1);
  expect(deleted.companies).toBe(0);
  expect(deleted.company_domains).toBe(0);

  expect(tableCount(db, "companies")).toBe(1);
  expect(tableCount(db, "jobs")).toBe(0);
  expect(tableCount(db, "contacts")).toBe(0);
});

test("purgeOlderThan deletes a company that has a lead_scores row (H-1 regression)", () => {
  // pr-review H-1: every collected company gets a lead_scores row in the
  // real CLI flow. The previous predicate refused to delete any company
  // with lead_scores → PIPL "delete on request" intent silently broken.
  // After the fix, lead_scores + push_events cascade with the company.
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const stored = repo.upsertCollectedLead(leadOf(), run.id);
  insertScoreRow(repo, stored.companyId, run.id);

  const old = "2020-01-01T00:00:00.000Z";
  backdateCompany(db, stored.companyId, old);
  backdateJobs(db, stored.companyId, old);
  backdateContacts(db, stored.companyId, old);

  const result = repo.purgeOlderThan("2024-01-01T00:00:00.000Z");
  expect(result.companies).toBe(1);
  expect(result.lead_scores).toBe(1);

  const remainingCompanies = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM companies")
    .get();
  expect(remainingCompanies?.c).toBe(0);
  const remainingScores = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM lead_scores")
    .get();
  expect(remainingScores?.c).toBe(0);
});

test("purgeOlderThan is idempotent (second run deletes nothing)", () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const stored = repo.upsertCollectedLead(leadOf(), run.id);
  const old = "2020-01-01T00:00:00.000Z";
  backdateCompany(db, stored.companyId, old);
  backdateJobs(db, stored.companyId, old);
  backdateContacts(db, stored.companyId, old);

  const cutoff = "2024-01-01T00:00:00.000Z";
  const first = repo.purgeOlderThan(cutoff);
  expect(first.companies + first.jobs + first.contacts).toBeGreaterThan(0);

  const second = repo.purgeOlderThan(cutoff);
  expect(second.companies).toBe(0);
  expect(second.jobs).toBe(0);
  expect(second.contacts).toBe(0);
  expect(second.company_domains).toBe(0);
});

// --- previewPurgeContactsByRisk / purgeContactsByRisk ----------------------

test("previewPurgeContactsByRisk counts only matching contacts and does not delete", () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  repo.upsertCollectedLead(
    leadOf({
      contacts: [
        { contactType: "email", value: "a@x.io", riskLevel: "low" },
        { contactType: "email", value: "b@x.io", riskLevel: "high" },
        { contactType: "email", value: "c@x.io", riskLevel: "medium" },
      ],
    }),
    run.id,
  );

  const before = tableCount(db, "contacts");
  const preview = repo.previewPurgeContactsByRisk(["high"]);
  expect(preview.contacts).toBe(1);
  expect(preview.companies).toBe(0);
  expect(preview.jobs).toBe(0);
  expect(tableCount(db, "contacts")).toBe(before);
});

test("purgeContactsByRisk deletes only the requested levels", () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  repo.upsertCollectedLead(
    leadOf({
      contacts: [
        { contactType: "email", value: "a@x.io", riskLevel: "low" },
        { contactType: "email", value: "b@x.io", riskLevel: "high" },
        { contactType: "email", value: "c@x.io", riskLevel: "medium" },
      ],
    }),
    run.id,
  );

  // Note: blocked contacts are never persisted (TB-2), so "blocked" in the
  // levels list naturally matches zero rows. That's fine; documented.
  const deleted = repo.purgeContactsByRisk(["high", "medium", "blocked"]);
  expect(deleted.contacts).toBe(2);
  expect(tableCount(db, "contacts")).toBe(1);
});

// --- previewPurgeCompany / purgeCompany ------------------------------------

test("previewPurgeCompany returns all zeros for an unknown domain", () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  repo.upsertCollectedLead(leadOf(), run.id);

  const preview = repo.previewPurgeCompany("nonexistent.com");
  expect(preview).toEqual({
    companies: 0,
    company_domains: 0,
    jobs: 0,
    contacts: 0,
    sources: 0,
    lead_scores: 0,
    push_events: 0,
  });
  expect(tableCount(db, "companies")).toBe(1);
});

test("purgeCompany on an unknown domain is a no-op, not an error", () => {
  const { repo } = createInMemoryRepository();
  const deleted = repo.purgeCompany("nope.invalid");
  expect(deleted.companies).toBe(0);
  expect(deleted.jobs).toBe(0);
});

test("purgeCompany removes company and dependents but preserves sources", () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const stored = repo.upsertCollectedLead(leadOf(), run.id);
  insertPushEvent(db, stored.companyId);
  insertScoreRow(repo, stored.companyId, run.id);

  const sourcesBefore = tableCount(db, "sources");

  const preview = repo.previewPurgeCompany("acme.ai");
  expect(preview.companies).toBe(1);
  expect(preview.company_domains).toBe(1);
  expect(preview.jobs).toBe(1);
  expect(preview.contacts).toBe(1);
  expect(preview.lead_scores).toBe(1);
  expect(preview.push_events).toBe(1);
  expect(preview.sources).toBe(0);

  const deleted = repo.purgeCompany("acme.ai");
  expect(deleted).toEqual(preview);

  expect(tableCount(db, "companies")).toBe(0);
  expect(tableCount(db, "company_domains")).toBe(0);
  expect(tableCount(db, "jobs")).toBe(0);
  expect(tableCount(db, "contacts")).toBe(0);
  expect(tableCount(db, "lead_scores")).toBe(0);
  expect(tableCount(db, "push_events")).toBe(0);
  // sources is audit-only — never touched.
  expect(tableCount(db, "sources")).toBe(sourcesBefore);
});

test("purgeCompany lets run_lead_events.company_id cascade to NULL (M-4 audit invariant)", () => {
  // The run_lead_events FK is ON DELETE SET NULL: we want the candidate /
  // stored events the company produced to survive in run history (so
  // `report --run <id>` is still meaningful) — but with no dangling FK.
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const stored = repo.upsertCollectedLead(leadOf(), run.id);
  const eventsBefore = db
    .query<{ c: number }, [number]>(
      "SELECT COUNT(*) AS c FROM run_lead_events WHERE company_id = ?",
    )
    .get(stored.companyId);
  expect(eventsBefore?.c).toBeGreaterThan(0);

  repo.purgeCompany("acme.ai");

  // Events still exist (history preserved); their company_id is NULL.
  const eventsAfter = db
    .query<{ c: number }, []>(
      "SELECT COUNT(*) AS c FROM run_lead_events WHERE company_id IS NULL",
    )
    .get();
  expect(eventsAfter?.c).toBeGreaterThanOrEqual(eventsBefore?.c ?? 0);
  const orphans = db
    .query<{ c: number }, [number]>(
      "SELECT COUNT(*) AS c FROM run_lead_events WHERE company_id = ?",
    )
    .get(stored.companyId);
  expect(orphans?.c).toBe(0);
});

test("purgeCompany is idempotent (second run = all zeros)", () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  repo.upsertCollectedLead(leadOf(), run.id);
  insertPushEvent(db, 1);

  const first = repo.purgeCompany("acme.ai");
  expect(first.companies).toBe(1);
  const second = repo.purgeCompany("acme.ai");
  expect(second.companies).toBe(0);
  expect(second.jobs).toBe(0);
});

// --- Re-collect after purge: dedupe slate must be clean --------------------

test("after purgeCompany, a fresh collect of the same domain creates a new row", () => {
  const { repo, db } = createInMemoryRepository();

  const run1 = repo.startRun({ source: "fake", limit: 1 });
  const first = repo.upsertCollectedLead(leadOf(), run1.id);
  repo.finishRun(run1.id, "completed");
  expect(first.status).toBe("created");

  repo.purgeCompany("acme.ai");

  const run2 = repo.startRun({ source: "fake", limit: 1 });
  // Same domain — must NOT dedupe to a now-gone company id.
  const second = repo.upsertCollectedLead(leadOf(), run2.id);
  expect(second.status).toBe("created");
  expect(tableCount(db, "companies")).toBe(1);
});
