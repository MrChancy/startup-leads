import { test, expect } from "bun:test";
import { createInMemoryRepository } from "../../storage/index.ts";
import type { CollectedLead } from "../../types/index.ts";
import { HttpRetryExhaustedError } from "../../http/index.ts";
import { CAREERS_PATHS } from "./probe.ts";
import { runEnrichCareers } from "./index.ts";
import { makeFakeHttpClient } from "./test-support.ts";

function lead(over: Partial<CollectedLead> = {}): CollectedLead {
  return {
    companyName: "Acme AI",
    domain: "acme.ai",
    directionTags: ["backend"],
    jobs: [{ title: "Backend Engineer", freshness: "unknown" }],
    contacts: [],
    source: {
      sourceType: "hn_who_is_hiring",
      sourceUrl: "https://news.ycombinator.com/item?id=1",
      retrievedAt: new Date().toISOString(),
    },
    ...over,
  };
}

function notFoundEverywhere(domain: string): Record<string, { status: number }> {
  const out: Record<string, { status: number }> = {};
  for (const path of CAREERS_PATHS) {
    out[`https://${domain}${path}`] = { status: 404 };
  }
  out[`https://${domain}/sitemap.xml`] = { status: 404 };
  return out;
}

test("end-to-end: matching careers page upgrades unknown → usable and rewrites the score", async () => {
  const { repo } = createInMemoryRepository();
  const runId = repo.startRun({ source: "test", limit: 1 }).id;
  const stored = repo.upsertCollectedLead(lead(), runId);

  // Capture the baseline score for comparison after re-score.
  const baselineFreshness = scoreFor(repo, stored.companyId).freshnessScore;

  const { client } = makeFakeHttpClient({
    "https://acme.ai/careers": "<h1>Hiring Backend Engineer (Remote)</h1>",
  });

  const result = await runEnrichCareers({
    repo,
    http: client,
    confirm: true,
    now: () => new Date("2026-05-28T00:00:00.000Z"),
  });

  expect(result.upgraded).toBe(1);
  expect(result.companiesProbed).toBe(1);
  expect(result.fetchFailed).toBe(0);

  const newFreshness = scoreFor(repo, stored.companyId).freshnessScore;
  // usable (10) > unknown (0). The fresher score row is appended (not
  // overwritten) so audit history survives.
  expect(newFreshness).toBeGreaterThan(baselineFreshness);
});

test("careers page with no matching title leaves freshness alone but still records a source row", async () => {
  const { repo, db } = createInMemoryRepository();
  const runId = repo.startRun({ source: "test", limit: 1 }).id;
  const stored = repo.upsertCollectedLead(lead(), runId);

  const { client } = makeFakeHttpClient({
    "https://acme.ai/careers": "<h1>We sell rocks. No open roles.</h1>",
  });

  const result = await runEnrichCareers({
    repo,
    http: client,
    confirm: true,
    now: () => new Date(),
  });

  expect(result.upgraded).toBe(0);
  expect(result.pagesNoMatch).toBe(1);

  const jobRow = db
    .query<{ freshness_status: string }, [number]>(
      "SELECT freshness_status FROM jobs WHERE company_id = ?",
    )
    .get(stored.companyId);
  expect(jobRow?.freshness_status).toBe("unknown");

  const sourceRow = db
    .query<
      { fetch_status: string; parse_status: string | null; source_url: string },
      []
    >(
      "SELECT fetch_status, parse_status, source_url FROM sources WHERE source_type = 'careers_page'",
    )
    .get();
  expect(sourceRow?.fetch_status).toBe("success");
  expect(sourceRow?.parse_status).toBe("no_match");
  expect(sourceRow?.source_url).toBe("https://acme.ai/careers");
});

test("existing fresh / usable jobs are never demoted", async () => {
  const { repo, db } = createInMemoryRepository();
  const runId = repo.startRun({ source: "test", limit: 1 }).id;
  const stored = repo.upsertCollectedLead(
    lead({
      jobs: [
        // fresh job: enricher must skip this company entirely (no `unknown`
        // jobs anywhere on it).
        { title: "Backend Engineer", freshness: "fresh" },
      ],
    }),
    runId,
  );

  const { client, calls } = makeFakeHttpClient({});
  const result = await runEnrichCareers({
    repo,
    http: client,
    confirm: true,
    now: () => new Date(),
  });

  expect(result.companiesProbed).toBe(0);
  expect(calls).toEqual([]);

  const jobRow = db
    .query<{ freshness_status: string }, [number]>(
      "SELECT freshness_status FROM jobs WHERE company_id = ?",
    )
    .get(stored.companyId);
  expect(jobRow?.freshness_status).toBe("fresh");
});

test("HttpRetryExhaustedError records a failed sources row, does not fail the company", async () => {
  const { repo, db } = createInMemoryRepository();
  const runId = repo.startRun({ source: "test", limit: 1 }).id;
  repo.upsertCollectedLead(lead(), runId);

  const responses: Record<
    string,
    { status: number } | Error
  > = notFoundEverywhere("acme.ai");
  responses["https://acme.ai/careers"] = new HttpRetryExhaustedError(
    "https://acme.ai/careers",
    4,
    503,
    "service unavailable",
  );

  const { client } = makeFakeHttpClient(responses);
  const result = await runEnrichCareers({
    repo,
    http: client,
    confirm: true,
    now: () => new Date(),
  });

  expect(result.fetchFailed).toBe(1);
  expect(result.upgraded).toBe(0);

  const failedRow = db
    .query<
      {
        fetch_status: string;
        parse_status: string | null;
        error_code: string | null;
        source_url: string;
      },
      []
    >(
      "SELECT fetch_status, parse_status, error_code, source_url FROM sources WHERE source_type = 'careers_page'",
    )
    .get();
  expect(failedRow?.fetch_status).toBe("failed");
  expect(failedRow?.error_code).toBe("retry_exhausted");
});

test("companies whose only domain starts with hn: are skipped silently (issue #25)", async () => {
  const { repo } = createInMemoryRepository();
  const runId = repo.startRun({ source: "test", limit: 1 }).id;
  repo.upsertCollectedLead(
    lead({ companyName: "Stealth Co", domain: "hn:stealth-co" }),
    runId,
  );

  const { client, calls } = makeFakeHttpClient({});
  const result = await runEnrichCareers({
    repo,
    http: client,
    confirm: true,
    now: () => new Date(),
  });

  expect(result.companiesProbed).toBe(0);
  expect(result.skippedNoHttpDomain).toBe(1);
  expect(calls).toEqual([]);
});

test("dry-run reports counts and never writes", async () => {
  const { repo, db } = createInMemoryRepository();
  const runId = repo.startRun({ source: "test", limit: 1 }).id;
  repo.upsertCollectedLead(lead(), runId);
  repo.upsertCollectedLead(
    lead({ companyName: "Beta Co", domain: "hn:beta" }),
    runId,
  );

  const { client, calls } = makeFakeHttpClient({});
  const result = await runEnrichCareers({
    repo,
    http: client,
    confirm: false,
    now: () => new Date(),
  });

  // 2 companies have unknown jobs; 1 has a probeable domain.
  expect(result.companiesToProbe).toBe(1);
  expect(result.skippedNoHttpDomain).toBe(1);
  // Dry-run never calls the HTTP client.
  expect(calls).toEqual([]);
  // ... and never writes a sources row.
  const sourceCount = db
    .query<{ c: number }, []>(
      "SELECT COUNT(*) AS c FROM sources WHERE source_type = 'careers_page'",
    )
    .get();
  expect(sourceCount?.c).toBe(0);
});

test("re-score writes a NEW lead_scores row rather than overwriting (audit history)", async () => {
  const { repo, db } = createInMemoryRepository();
  const runId = repo.startRun({ source: "test", limit: 1 }).id;
  const stored = repo.upsertCollectedLead(lead(), runId);

  // One baseline score from collect.
  repo.writeLeadScore({
    companyId: stored.companyId,
    runId,
    score: 10,
    jobMatchScore: 5,
    directionScore: 5,
    freshnessScore: 0,
    contactScore: 0,
    actionabilityScore: 0,
    matchReason: [],
    decision: "local_only",
    scorerVersion: "1.0.0",
  });

  const { client } = makeFakeHttpClient({
    "https://acme.ai/careers": "<h1>Hiring Backend Engineer</h1>",
  });

  await runEnrichCareers({
    repo,
    http: client,
    confirm: true,
    now: () => new Date(),
  });

  const rows = db
    .query<{ freshness_score: number; created_at: string }, [number]>(
      "SELECT freshness_score, created_at FROM lead_scores WHERE company_id = ? ORDER BY id",
    )
    .all(stored.companyId);
  expect(rows).toHaveLength(2);
  // Latest row reflects the upgrade.
  expect(rows[1]!.freshness_score).toBeGreaterThan(rows[0]!.freshness_score);
});

// ---- guard: no contact creation -------------------------------------------

test("enricher never inserts a contact, even if the page contains an email", async () => {
  const { repo, db } = createInMemoryRepository();
  const runId = repo.startRun({ source: "test", limit: 1 }).id;
  repo.upsertCollectedLead(lead(), runId);

  const { client } = makeFakeHttpClient({
    "https://acme.ai/careers":
      "<h1>Hiring Backend Engineer</h1><p>Contact hr@acme.ai</p>",
  });

  await runEnrichCareers({
    repo,
    http: client,
    confirm: true,
    now: () => new Date(),
  });

  const contactCount = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM contacts")
    .get();
  // The collect path didn't create one and the enricher must not either.
  expect(contactCount?.c).toBe(0);
});

// Helper: peek at the most recent score row for a company.
function scoreFor(
  repo: ReturnType<typeof createInMemoryRepository>["repo"],
  companyId: number,
) {
  // Use the score input shape so we get the freshness component back.
  // The DB is the source of truth; reading via the repo keeps this test
  // honest about what the public surface offers.
  const input = repo.getCompanyScoreInput(companyId, new Date());
  const usable = input.jobs.filter((j) => j.freshness === "usable").length;
  const fresh = input.jobs.filter((j) => j.freshness === "fresh").length;
  const unknown = input.jobs.filter((j) => j.freshness === "unknown").length;
  // Mirror scoreFreshness: fresh wins (15), usable next (10), unknown 0.
  const freshnessScore = fresh > 0 ? 15 : usable > 0 ? 10 : 0;
  return { freshnessScore, fresh, usable, unknown };
}
