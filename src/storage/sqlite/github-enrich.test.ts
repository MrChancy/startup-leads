// Repository-level tests for the methods the GitHub enricher needs.
// Mirrors careers-enrich.test.ts (one file per enricher) so future repo
// surface changes for one enricher don't entangle the other.

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
      sourceType: "hn_who_is_hiring",
      sourceUrl: "https://news.ycombinator.com/item?id=1",
      retrievedAt: new Date().toISOString(),
    },
    ...over,
  };
}

test("listGithubOrgCandidates returns one (company, org_slug) per github contact and skips companies with none", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "test", limit: 1 });

  // Company A: github org leaked as `github.com/acme-ai`.
  const acme = repo.upsertCollectedLead(
    lead({
      contacts: [
        {
          contactType: "github",
          value: "github.com/acme-ai",
          profileUrl: "https://github.com/acme-ai",
          riskLevel: "medium",
        },
      ],
    }),
    run.id,
  );

  // Company B: github org leaked with extra path segment.
  const beta = repo.upsertCollectedLead(
    lead({
      companyName: "Beta",
      domain: "beta.co",
      contacts: [
        {
          contactType: "github",
          value: "github.com/beta-org/some-repo",
          profileUrl: "https://github.com/beta-org/some-repo",
          riskLevel: "medium",
        },
      ],
    }),
    run.id,
  );

  // Company C: no github contact at all (must NOT appear).
  repo.upsertCollectedLead(
    lead({ companyName: "Quiet Co", domain: "quiet.co", contacts: [] }),
    run.id,
  );

  const candidates = repo.listGithubOrgCandidates();
  // Map by companyId so the assertion doesn't depend on row order.
  const byCompany = new Map(
    candidates.map((c) => [c.companyId, c.orgSlug] as const),
  );
  expect(byCompany.get(acme.companyId)).toBe("acme-ai");
  // The path segment after the slug is dropped — we want the org, not
  // the org/repo.
  expect(byCompany.get(beta.companyId)).toBe("beta-org");
  // Quiet Co has no github contact, so no row.
  expect(candidates.find((c) => c.companyId !== acme.companyId && c.companyId !== beta.companyId)).toBeUndefined();
});

test("listGithubOrgCandidates deduplicates per (company, org_slug) even with multiple github contacts on same org", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "test", limit: 1 });
  repo.upsertCollectedLead(
    lead({
      contacts: [
        {
          contactType: "github",
          value: "github.com/acme-ai",
          riskLevel: "medium",
        },
        {
          contactType: "github",
          value: "github.com/acme-ai/site",
          riskLevel: "medium",
        },
      ],
    }),
    run.id,
  );
  const candidates = repo.listGithubOrgCandidates();
  // Both contacts collapse to org_slug=acme-ai → one row per company.
  expect(candidates).toHaveLength(1);
  expect(candidates[0]?.orgSlug).toBe("acme-ai");
});

test("recordGithubEnrichment writes one sources row and N contacts in a single transaction (S-2)", () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "test", limit: 1 });
  const acme = repo.upsertCollectedLead(
    lead({
      contacts: [
        {
          contactType: "github",
          value: "github.com/acme-ai",
          riskLevel: "medium",
        },
      ],
    }),
    run.id,
  );

  const beforeSources = db
    .query<{ c: number }, []>(
      "SELECT COUNT(*) AS c FROM sources WHERE source_type = 'github_profile'",
    )
    .get();
  const beforeContacts = db
    .query<{ c: number }, [number]>(
      "SELECT COUNT(*) AS c FROM contacts WHERE company_id = ?",
    )
    .get(acme.companyId);

  const { sourceId, insertedCount } = repo.recordGithubEnrichment({
    companyId: acme.companyId,
    orgSlug: "acme-ai",
    fetchStatus: "success",
    contacts: [
      {
        contactType: "email",
        value: "alice@acme.ai",
        profileUrl: "https://github.com/alice",
        name: "Alice",
        riskLevel: "low",
        priorityRank: 1,
      },
      {
        contactType: "github",
        value: "github.com/bob",
        profileUrl: "https://github.com/bob",
        name: null,
        riskLevel: "medium",
        priorityRank: 2,
      },
    ],
  });
  expect(insertedCount).toBe(2);

  // sources row written
  const sourcesAfter = db
    .query<{ c: number }, []>(
      "SELECT COUNT(*) AS c FROM sources WHERE source_type = 'github_profile'",
    )
    .get();
  expect(sourcesAfter?.c).toBe((beforeSources?.c ?? 0) + 1);

  const sourceRow = db
    .query<
      {
        source_type: string;
        source_url: string | null;
        fetch_status: string | null;
      },
      [number]
    >(
      "SELECT source_type, source_url, fetch_status FROM sources WHERE id = ?",
    )
    .get(sourceId);
  expect(sourceRow?.source_type).toBe("github_profile");
  expect(sourceRow?.source_url).toBe("https://api.github.com/orgs/acme-ai/public_members");
  expect(sourceRow?.fetch_status).toBe("success");

  // contacts written, each with source_id pointing at the new sources row.
  const contactsAfter = db
    .query<
      {
        contact_type: string;
        value: string;
        priority_rank: number | null;
        source_id: number | null;
        risk_level: string | null;
      },
      [number]
    >(
      "SELECT contact_type, value, priority_rank, source_id, risk_level FROM contacts WHERE company_id = ? ORDER BY id",
    )
    .all(acme.companyId);
  expect(contactsAfter.length).toBe((beforeContacts?.c ?? 0) + 2);
  // The two new rows are the last two by id.
  const newRows = contactsAfter.slice(-2);
  expect(newRows[0]?.value).toBe("alice@acme.ai");
  expect(newRows[0]?.contact_type).toBe("email");
  expect(newRows[0]?.priority_rank).toBe(1);
  expect(newRows[0]?.source_id).toBe(sourceId);
  expect(newRows[0]?.risk_level).toBe("low");
  expect(newRows[1]?.contact_type).toBe("github");
  expect(newRows[1]?.priority_rank).toBe(2);
  expect(newRows[1]?.source_id).toBe(sourceId);
});

test("recordGithubEnrichment with fetchStatus=deferred writes an evidence row and zero contacts", () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "test", limit: 1 });
  const acme = repo.upsertCollectedLead(
    lead({
      contacts: [
        {
          contactType: "github",
          value: "github.com/acme-ai",
          riskLevel: "medium",
        },
      ],
    }),
    run.id,
  );

  const { sourceId, insertedCount } = repo.recordGithubEnrichment({
    companyId: acme.companyId,
    orgSlug: "acme-ai",
    fetchStatus: "deferred",
    errorCode: "rate_limited",
    errorMessage: "x-ratelimit-remaining: 0",
    contacts: [],
  });
  expect(insertedCount).toBe(0);

  const sourceRow = db
    .query<
      {
        fetch_status: string | null;
        error_code: string | null;
        error_message: string | null;
      },
      [number]
    >("SELECT fetch_status, error_code, error_message FROM sources WHERE id = ?")
    .get(sourceId);
  expect(sourceRow?.fetch_status).toBe("deferred");
  expect(sourceRow?.error_code).toBe("rate_limited");
  expect(sourceRow?.error_message).toBe("x-ratelimit-remaining: 0");

  const contactsCount = db
    .query<{ c: number }, [number, number]>(
      "SELECT COUNT(*) AS c FROM contacts WHERE company_id = ? AND source_id = ?",
    )
    .get(acme.companyId, sourceId);
  expect(contactsCount?.c).toBe(0);
});

test("recordGithubEnrichment dedupes against pre-existing (contact_type, value) on the same company (idempotency)", () => {
  // Running the enricher twice must not insert two rows for the same
  // (company, contactType, value). Without dedup, every re-run would bloat
  // the contacts table.
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "test", limit: 1 });
  const acme = repo.upsertCollectedLead(
    lead({
      contacts: [
        {
          contactType: "github",
          value: "github.com/acme-ai",
          riskLevel: "medium",
        },
      ],
    }),
    run.id,
  );

  repo.recordGithubEnrichment({
    companyId: acme.companyId,
    orgSlug: "acme-ai",
    fetchStatus: "success",
    contacts: [
      {
        contactType: "github",
        value: "github.com/alice",
        profileUrl: "https://github.com/alice",
        name: "Alice",
        riskLevel: "medium",
        priorityRank: 1,
      },
    ],
  });

  // Second run with the exact same candidate.
  repo.recordGithubEnrichment({
    companyId: acme.companyId,
    orgSlug: "acme-ai",
    fetchStatus: "success",
    contacts: [
      {
        contactType: "github",
        value: "github.com/alice",
        profileUrl: "https://github.com/alice",
        name: "Alice",
        riskLevel: "medium",
        priorityRank: 1,
      },
    ],
  });

  const aliceRows = db
    .query<{ c: number }, [number, string]>(
      "SELECT COUNT(*) AS c FROM contacts WHERE company_id = ? AND contact_type = 'github' AND value = ?",
    )
    .get(acme.companyId, "github.com/alice");
  expect(aliceRows?.c).toBe(1);
});
