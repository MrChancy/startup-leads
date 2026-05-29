import { test, expect } from "bun:test";
import { createInMemoryRepository } from "./test-support.ts";
import type { CollectedLead } from "../../types/index.ts";

const sampleLead = (): CollectedLead => ({
  companyName: "Acme AI",
  domain: "acme.ai",
  description: "An AI company",
  // pr-review #21 M-3: was "ai-application" (legacy / not in spec enum).
  // TB-4 added direction-tag rejection at upsert time so silent drop would
  // become a hard error if the enum tightens further.
  directionTags: ["ai-app"],
  jobs: [
    {
      title: "Backend Engineer",
      jobUrl: "https://acme.ai/jobs/be",
      freshness: "fresh",
    },
  ],
  contacts: [],
  source: {
    sourceType: "fake",
    sourceUrl: "fake://acme",
    sourceTitle: "fake collector",
    retrievedAt: new Date().toISOString(),
  },
});

test("startRun inserts a runs row with status=partial", () => {
  const { repo, db } = createInMemoryRepository();

  const run = repo.startRun({ source: "fake", limit: 50 });

  expect(run.id).toBeTruthy();
  expect(run.source).toBe("fake");
  expect(run.limit).toBe(50);

  const row = db
    .query<
      { id: string; status: string; source: string; limit_value: number },
      [string]
    >("SELECT id, status, source, limit_value FROM runs WHERE id = ?")
    .get(run.id);
  expect(row).not.toBeNull();
  expect(row?.status).toBe("partial");
  expect(row?.source).toBe("fake");
  expect(row?.limit_value).toBe(50);
});

test("finishRun updates status and finished_at", () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });

  repo.finishRun(run.id, "completed");

  const row = db
    .query<{ status: string; finished_at: string | null }, [string]>(
      "SELECT status, finished_at FROM runs WHERE id = ?",
    )
    .get(run.id);
  expect(row?.status).toBe("completed");
  expect(row?.finished_at).toBeTruthy();
});

test("upsertCollectedLead inserts company, domain, job, and source rows", () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });

  const result = repo.upsertCollectedLead(sampleLead(), run.id);

  expect(result.status).toBe("created");
  expect(result.companyId).toBeGreaterThan(0);

  const company = db
    .query<{ name: string; primary_domain_id: number | null }, [number]>(
      "SELECT name, primary_domain_id FROM companies WHERE id = ?",
    )
    .get(result.companyId);
  expect(company?.name).toBe("Acme AI");
  expect(company?.primary_domain_id).not.toBeNull();

  const domain = db
    .query<{ domain: string; is_primary: number }, [number]>(
      "SELECT domain, is_primary FROM company_domains WHERE company_id = ?",
    )
    .get(result.companyId);
  expect(domain?.domain).toBe("acme.ai");
  expect(domain?.is_primary).toBe(1);

  const jobCount = db
    .query<{ c: number }, [number]>(
      "SELECT COUNT(*) AS c FROM jobs WHERE company_id = ?",
    )
    .get(result.companyId);
  expect(jobCount?.c).toBe(1);

  const sourceCount = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM sources")
    .get();
  expect(sourceCount?.c).toBeGreaterThan(0);
});

test("countByRun reports candidate/stored counts for one run", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });

  repo.upsertCollectedLead(sampleLead(), run.id);
  repo.finishRun(run.id, "completed");

  const counts = repo.countByRun(run.id);
  expect(counts).toEqual({
    candidates: 1,
    stored: 1,
    deduped: 0,
    fetchFailed: 0,
    parseFailed: 0,
  });
});

test("upsertCollectedLead with duplicate domain returns deduped and does not throw", () => {
  const { repo, db } = createInMemoryRepository();

  const run1 = repo.startRun({ source: "fake", limit: 1 });
  const first = repo.upsertCollectedLead(sampleLead(), run1.id);
  repo.finishRun(run1.id, "completed");
  expect(first.status).toBe("created");

  const run2 = repo.startRun({ source: "fake", limit: 1 });
  const second = repo.upsertCollectedLead(sampleLead(), run2.id);
  repo.finishRun(run2.id, "completed");

  expect(second.status).toBe("deduped");
  expect(second.companyId).toBe(first.companyId);

  const companyCount = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM companies")
    .get();
  expect(companyCount?.c).toBe(1);

  const domainCount = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM company_domains")
    .get();
  expect(domainCount?.c).toBe(1);

  const counts = repo.countByRun(run2.id);
  expect(counts).toEqual({
    candidates: 1,
    stored: 0,
    deduped: 1,
    fetchFailed: 0,
    parseFailed: 0,
  });
});

test("upsertCollectedLead persists lead.contacts when present", () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });

  const leadWithContacts = {
    ...sampleLead(),
    contacts: [
      {
        name: "Alice",
        title: "CTO",
        contactType: "email",
        value: "alice@acme.ai",
        riskLevel: "low" as const,
      },
      {
        name: "Bob",
        contactType: "linkedin",
        value: "https://linkedin.com/in/bob",
        profileUrl: "https://linkedin.com/in/bob",
        riskLevel: "medium" as const,
      },
    ],
  };

  const result = repo.upsertCollectedLead(leadWithContacts, run.id);
  expect(result.status).toBe("created");

  const rows = db
    .query<
      {
        name: string | null;
        contact_type: string;
        value: string;
        risk_level: string;
      },
      [number]
    >(
      "SELECT name, contact_type, value, risk_level FROM contacts WHERE company_id = ? ORDER BY id",
    )
    .all(result.companyId);
  expect(rows).toHaveLength(2);
  expect(rows[0]?.name).toBe("Alice");
  expect(rows[0]?.contact_type).toBe("email");
  expect(rows[0]?.value).toBe("alice@acme.ai");
  expect(rows[0]?.risk_level).toBe("low");
  expect(rows[1]?.name).toBe("Bob");
  expect(rows[1]?.contact_type).toBe("linkedin");
  expect(rows[1]?.risk_level).toBe("medium");
});

test("upsertCollectedLead rolls back the whole lead when a later insert fails", () => {
  const { repo, db } = createInMemoryRepository();

  // Seed first lead so its job_url is already taken.
  const run1 = repo.startRun({ source: "fake", limit: 1 });
  repo.upsertCollectedLead(sampleLead(), run1.id);
  repo.finishRun(run1.id, "completed");

  const companiesBefore = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM companies")
    .get();
  const sourcesBefore = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM sources")
    .get();
  const jobsBefore = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM jobs")
    .get();
  const domainsBefore = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM company_domains")
    .get();

  // A new lead under a fresh domain (skips dedupe) reusing the seeded job_url.
  const run2 = repo.startRun({ source: "fake", limit: 1 });
  const conflicting = {
    ...sampleLead(),
    companyName: "Other AI",
    domain: "other.ai",
    jobs: [
      {
        title: "Backend Engineer",
        jobUrl: "https://acme.ai/jobs/be", // collides with seed
        freshness: "fresh" as const,
      },
    ],
  };

  expect(() => repo.upsertCollectedLead(conflicting, run2.id)).toThrow();

  const companiesAfter = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM companies")
    .get();
  const sourcesAfter = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM sources")
    .get();
  const jobsAfter = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM jobs")
    .get();
  const domainsAfter = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM company_domains")
    .get();

  expect(companiesAfter?.c).toBe(companiesBefore?.c);
  expect(sourcesAfter?.c).toBe(sourcesBefore?.c);
  expect(jobsAfter?.c).toBe(jobsBefore?.c);
  expect(domainsAfter?.c).toBe(domainsBefore?.c);

  // The candidate event for run2 also rolls back along with the rest.
  const counts = repo.countByRun(run2.id);
  expect(counts.candidates).toBe(0);
  expect(counts.stored).toBe(0);
  expect(counts.deduped).toBe(0);
});

test("getRun returns the RunRecord for an existing run", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 7 });

  const got = repo.getRun(run.id);
  expect(got).not.toBeNull();
  expect(got?.id).toBe(run.id);
  expect(got?.source).toBe("fake");
  expect(got?.limit).toBe(7);
  expect(got?.startedAt).toBe(run.startedAt);
});

test("getRun returns null for an unknown run id", () => {
  const { repo } = createInMemoryRepository();
  expect(repo.getRun("does-not-exist")).toBeNull();
});

test("countByRun for an unknown run id returns zeros", () => {
  const { repo } = createInMemoryRepository();
  expect(repo.countByRun("does-not-exist")).toEqual({
    candidates: 0,
    stored: 0,
    deduped: 0,
    fetchFailed: 0,
    parseFailed: 0,
  });
});
