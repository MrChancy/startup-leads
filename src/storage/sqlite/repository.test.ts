import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "./migrations.ts";
import { createSqliteLeadRepository } from "./repository.ts";
import type { CollectedLead } from "../../types/index.ts";

function freshDb() {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

const sampleLead = (): CollectedLead => ({
  companyName: "Acme AI",
  domain: "acme.ai",
  description: "An AI company",
  directionTags: ["ai-application"],
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
  const db = freshDb();
  const repo = createSqliteLeadRepository(db);

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
  const db = freshDb();
  const repo = createSqliteLeadRepository(db);
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
  const db = freshDb();
  const repo = createSqliteLeadRepository(db);
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
  const db = freshDb();
  const repo = createSqliteLeadRepository(db);
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
  const db = freshDb();
  const repo = createSqliteLeadRepository(db);

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

test("countByRun for an unknown run id returns zeros", () => {
  const db = freshDb();
  const repo = createSqliteLeadRepository(db);
  expect(repo.countByRun("does-not-exist")).toEqual({
    candidates: 0,
    stored: 0,
    deduped: 0,
    fetchFailed: 0,
    parseFailed: 0,
  });
});
