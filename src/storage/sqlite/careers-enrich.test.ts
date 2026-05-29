// Repository-level tests for the methods the careers enricher needs.
// Kept in its own file (per file-per-feature convention in this repo) so
// the broad repository.test.ts doesn't pull in enricher-specific shape.

import { test, expect } from "bun:test";
import { createInMemoryRepository } from "./test-support.ts";
import type { CollectedLead } from "../../types/index.ts";

function lead(over: Partial<CollectedLead> = {}): CollectedLead {
  return {
    companyName: "Acme AI",
    domain: "acme.ai",
    directionTags: ["backend"],
    jobs: [{ title: "Backend Engineer", freshness: "unknown" }],
    contacts: [],
    source: {
      sourceType: "fake",
      sourceUrl: "fake://acme",
      retrievedAt: new Date().toISOString(),
    },
    ...over,
  };
}

test("listJobsWithFreshness returns only jobs at the requested status", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  repo.upsertCollectedLead(lead(), run.id);
  repo.upsertCollectedLead(
    lead({
      companyName: "Beta Co",
      domain: "beta.co",
      jobs: [{ title: "Backend Engineer", freshness: "fresh" }],
    }),
    run.id,
  );

  const unknownJobs = repo.listJobsWithFreshness("unknown");
  expect(unknownJobs).toHaveLength(1);
  expect(unknownJobs[0]?.normalizedTitle).toBe("backend engineer");

  const freshJobs = repo.listJobsWithFreshness("fresh");
  expect(freshJobs).toHaveLength(1);
});

test("getPrimaryHttpDomain returns a real domain and skips hn: prefixes", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const a = repo.upsertCollectedLead(
    lead({ companyName: "Acme", domain: "acme.ai" }),
    run.id,
  );
  const b = repo.upsertCollectedLead(
    lead({ companyName: "Beta", domain: "hn:beta-co" }),
    run.id,
  );

  expect(repo.getPrimaryHttpDomain(a.companyId)).toBe("acme.ai");
  // Synthetic hn: domains are not usable for HTTP probes (issue #25 followup).
  expect(repo.getPrimaryHttpDomain(b.companyId)).toBeNull();
});

test("upgradeJobFreshness only upgrades unknown jobs and never demotes a stronger status", () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const stored = repo.upsertCollectedLead(
    lead({
      jobs: [
        { title: "Backend Engineer", freshness: "unknown" },
        { title: "Frontend Engineer", freshness: "fresh" },
      ],
    }),
    run.id,
  );

  const jobs = repo.listJobsWithFreshness("unknown");
  expect(jobs).toHaveLength(1);
  const target = jobs[0]!;
  expect(target.companyId).toBe(stored.companyId);

  // Record a careers source row to point at, then upgrade.
  const sourceId = repo.recordCareersSource({
    url: "https://acme.ai/careers",
    fetchStatus: "success",
    parseStatus: "matched",
  });
  const upgraded = repo.upgradeJobFreshness(target.jobId, "usable", sourceId);
  expect(upgraded).toBe(true);

  // The frontend (fresh) job is unchanged; only the backend (unknown) one upgrades.
  const rows = db
    .query<{ title: string; freshness_status: string }, [number]>(
      "SELECT title, freshness_status FROM jobs WHERE company_id = ? ORDER BY id",
    )
    .all(stored.companyId);
  const byTitle = Object.fromEntries(rows.map((r) => [r.title, r.freshness_status]));
  expect(byTitle["Backend Engineer"]).toBe("usable");
  expect(byTitle["Frontend Engineer"]).toBe("fresh");

  // Calling upgrade again on the now-usable job is a no-op.
  const second = repo.upgradeJobFreshness(target.jobId, "usable", sourceId);
  expect(second).toBe(false);
});

test("recordCareersSource writes fetch_status / parse_status / error_message", () => {
  const { repo, db } = createInMemoryRepository();
  const failedId = repo.recordCareersSource({
    url: "https://acme.ai/careers",
    fetchStatus: "failed",
    errorCode: "retry_exhausted",
    errorMessage: "HTTP 503 after 4 attempts",
  });

  const row = db
    .query<
      {
        source_type: string;
        source_url: string;
        fetch_status: string;
        parse_status: string | null;
        error_code: string | null;
        error_message: string | null;
        retrieved_at: string | null;
      },
      [number]
    >(
      "SELECT source_type, source_url, fetch_status, parse_status, error_code, error_message, retrieved_at FROM sources WHERE id = ?",
    )
    .get(failedId);

  expect(row?.source_type).toBe("careers_page");
  expect(row?.source_url).toBe("https://acme.ai/careers");
  expect(row?.fetch_status).toBe("failed");
  expect(row?.parse_status).toBeNull();
  expect(row?.error_code).toBe("retry_exhausted");
  expect(row?.error_message).toBe("HTTP 503 after 4 attempts");
  // retrieved_at is set even on failures so a downstream purge by age can
  // still locate this row.
  expect(row?.retrieved_at).toBeTruthy();
});

test("getCompanyScoreInput reconstructs the DTO the scorer needs", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  repo.upsertCollectedLead(
    lead({
      directionTags: ["backend", "devtools"],
      jobs: [
        { title: "Backend Engineer", freshness: "unknown" },
        { title: "SRE", freshness: "fresh" },
      ],
      contacts: [
        { contactType: "email", value: "a@x.io", riskLevel: "low" },
      ],
    }),
    run.id,
  );

  const companyId = repo.listJobsWithFreshness("unknown")[0]!.companyId;
  const now = new Date("2026-05-01T00:00:00.000Z");
  const input = repo.getCompanyScoreInput(companyId, now);

  expect(input.companyId).toBe(companyId);
  expect(input.directionTags).toEqual(["backend", "devtools"]);
  expect(input.jobs).toHaveLength(2);
  expect(new Set(input.jobs.map((j) => j.freshness))).toEqual(
    new Set(["unknown", "fresh"]),
  );
  expect(input.contacts).toHaveLength(1);
  expect(input.contacts[0]?.contactType).toBe("email");
  expect(input.excludedByRule).toBe(false);
  expect(input.now).toBe(now);
});
