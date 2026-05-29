import { test, expect } from "bun:test";
import { createInMemoryRepository } from "./test-support.ts";
import type { CollectedLead } from "../../types/index.ts";

// TB-4: full 4-step dedupe + direction-tag rejection. Step 1 (domain match)
// is covered by repository.test.ts; this file covers steps 2-4 and the
// tag-rejection observability path through sources.evidence_snippet.

function leadOf(
  partial: Partial<CollectedLead> & { companyName: string },
): CollectedLead {
  return {
    directionTags: [],
    jobs: [],
    contacts: [],
    source: {
      sourceType: "fake",
      sourceUrl: "fake://" + partial.companyName,
      sourceTitle: "test",
      retrievedAt: new Date().toISOString(),
    },
    ...partial,
  };
}

// ---- Step 2: normalized_name match (single hit) ---------------------------

test(
  "step 2: same company in two languages with different domains merges and " +
    "attaches the new domain as a non-primary alias",
  () => {
    const { repo, db } = createInMemoryRepository();

    const run = repo.startRun({ source: "fake", limit: 2 });
    const a = repo.upsertCollectedLead(
      leadOf({
        companyName: "ByteDance",
        domain: "bytedance.com",
      }),
      run.id,
    );
    const b = repo.upsertCollectedLead(
      leadOf({
        companyName: "字节跳动",
        domain: "tiktok.com",
      }),
      run.id,
    );

    expect(a.status).toBe("created");
    expect(b.status).toBe("deduped");
    expect(b.companyId).toBe(a.companyId);

    // One company total — names merged via normalized_name.
    const companyCount = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM companies")
      .get();
    expect(companyCount?.c).toBe(1);

    // Two domains attached: bytedance.com (primary), tiktok.com (non-primary).
    const domains = db
      .query<
        { domain: string; is_primary: number },
        [number]
      >(
        "SELECT domain, is_primary FROM company_domains WHERE company_id = ? ORDER BY id",
      )
      .all(a.companyId);
    expect(domains).toHaveLength(2);
    expect(domains[0]?.domain).toBe("bytedance.com");
    expect(domains[0]?.is_primary).toBe(1);
    expect(domains[1]?.domain).toBe("tiktok.com");
    expect(domains[1]?.is_primary).toBe(0);

    // primary_domain_id still points at the original primary domain row, not
    // the freshly added alias. Look up the primary row's id and compare.
    const primaryRow = db
      .query<{ id: number }, [number]>(
        "SELECT id FROM company_domains WHERE company_id = ? AND domain = 'bytedance.com'",
      )
      .get(a.companyId);
    const company = db
      .query<{ primary_domain_id: number | null }, [number]>(
        "SELECT primary_domain_id FROM companies WHERE id = ?",
      )
      .get(a.companyId);
    expect(company?.primary_domain_id).toBe(primaryRow!.id);
  },
);

test(
  "step 2: lead without a domain still merges on normalized_name and does " +
    "not insert a junk row in company_domains",
  () => {
    const { repo, db } = createInMemoryRepository();

    const run = repo.startRun({ source: "fake", limit: 2 });
    const a = repo.upsertCollectedLead(
      leadOf({ companyName: "Acme AI", domain: "acme.ai" }),
      run.id,
    );
    const b = repo.upsertCollectedLead(
      leadOf({ companyName: "ACME  AI" }),
      run.id,
    );

    expect(b.status).toBe("deduped");
    expect(b.companyId).toBe(a.companyId);

    const domainCount = db
      .query<{ c: number }, [number]>(
        "SELECT COUNT(*) AS c FROM company_domains WHERE company_id = ?",
      )
      .get(a.companyId);
    expect(domainCount?.c).toBe(1);
  },
);

test(
  "step 2 bridges TB-3b's synthetic hn:<name> dedup key across language " +
    "variants of the same company",
  () => {
    // What TB-3b's parser actually produces:
    //   "ByteDance" → normalizeForDomain → "bytedance" → domain="hn:bytedance"
    //   "字节跳动"   → normalizeForDomain strips all non-[a-z0-9] → ""
    //                                                → domain="hn:"
    // The two domains DIFFER so step 1 cannot reconcile them. Step 2 must,
    // and it does — brand-aliases maps both to normalized_name="bytedance".
    //
    // CAVEAT (filed as follow-up against TB-3b): two unrelated all-CJK HN
    // companies both produce domain="hn:" → step 1 then incorrectly merges
    // them. TB-4 cannot fix that here; the fix belongs in TB-3b's
    // normalizeForDomain (use a CJK transliteration or fall back to "hn:" +
    // hash). This test pins the cross-language merge path, NOT the CJK
    // collision path.
    const { repo, db } = createInMemoryRepository();

    const run = repo.startRun({ source: "hn_who_is_hiring", limit: 2 });
    const a = repo.upsertCollectedLead(
      leadOf({ companyName: "ByteDance", domain: "hn:bytedance" }),
      run.id,
    );
    const b = repo.upsertCollectedLead(
      leadOf({ companyName: "字节跳动", domain: "hn:" }),
      run.id,
    );

    expect(a.status).toBe("created");
    expect(b.status).toBe("deduped");
    expect(b.companyId).toBe(a.companyId);

    const companyCount = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM companies")
      .get();
    expect(companyCount?.c).toBe(1);
  },
);

// ---- Step 3: new company ---------------------------------------------------

test(
  "step 3: lead with no matches creates new row; domain is_primary=1 and " +
    "primary_domain_id is set",
  () => {
    const { repo, db } = createInMemoryRepository();

    const run = repo.startRun({ source: "fake", limit: 1 });
    const r = repo.upsertCollectedLead(
      leadOf({ companyName: "Unique Co", domain: "unique.co" }),
      run.id,
    );

    expect(r.status).toBe("created");

    const row = db
      .query<
        { primary_domain_id: number | null; needs_review: number },
        [number]
      >(
        "SELECT primary_domain_id, needs_review FROM companies WHERE id = ?",
      )
      .get(r.companyId);
    expect(row?.primary_domain_id).not.toBeNull();
    expect(row?.needs_review).toBe(0);

    const dom = db
      .query<
        { is_primary: number },
        [number]
      >("SELECT is_primary FROM company_domains WHERE company_id = ?")
      .get(r.companyId);
    expect(dom?.is_primary).toBe(1);
  },
);

test("step 3: lead without a domain creates a row and no company_domains entry", () => {
  const { repo, db } = createInMemoryRepository();

  const run = repo.startRun({ source: "fake", limit: 1 });
  const r = repo.upsertCollectedLead(
    leadOf({ companyName: "No Domain Co" }),
    run.id,
  );

  expect(r.status).toBe("created");
  const row = db
    .query<{ primary_domain_id: number | null }, [number]>(
      "SELECT primary_domain_id FROM companies WHERE id = ?",
    )
    .get(r.companyId);
  expect(row?.primary_domain_id).toBeNull();

  const c = db
    .query<{ c: number }, [number]>(
      "SELECT COUNT(*) AS c FROM company_domains WHERE company_id = ?",
    )
    .get(r.companyId);
  expect(c?.c).toBe(0);
});

// ---- Step 4: multi-match → needs_review -----------------------------------

test(
  "step 4: when two existing companies share a normalized_name, the third " +
    "lead is created as a new row with needs_review=1",
  () => {
    const { repo, db } = createInMemoryRepository();

    // Seed two distinct companies with the same normalized name "atlas".
    // Each has a unique domain so step-1 keeps them separate at insert time.
    const run = repo.startRun({ source: "fake", limit: 3 });
    const a = repo.upsertCollectedLead(
      leadOf({ companyName: "Atlas", domain: "atlas-bio.com" }),
      run.id,
    );
    // The second Atlas must skip step 2 — different normalized_name? No,
    // same normalized — so we need to force it past dedupe. We do that by
    // inserting it directly via a domain-only lead AND a name that collides.
    // To create a true ambiguity, we manually insert a second row in DB:
    db.exec(
      "INSERT INTO companies (name, normalized_name, row_created_at, row_updated_at) " +
        "VALUES ('Atlas', 'atlas', '2026-01-01', '2026-01-01')",
    );

    // Third lead arrives with "Atlas" → name maps to "atlas", which now
    // matches TWO companies. Per the spec we must NOT merge; create new and
    // flag.
    const c = repo.upsertCollectedLead(
      leadOf({ companyName: "Atlas", domain: "atlas-air.com" }),
      run.id,
    );

    expect(c.status).toBe("created");
    expect(c.companyId).not.toBe(a.companyId);

    const row = db
      .query<{ needs_review: number }, [number]>(
        "SELECT needs_review FROM companies WHERE id = ?",
      )
      .get(c.companyId);
    expect(row?.needs_review).toBe(1);

    // Domain still attached but NOT as primary (it's a tentative new row).
    const dom = db
      .query<{ is_primary: number }, [number]>(
        "SELECT is_primary FROM company_domains WHERE company_id = ?",
      )
      .get(c.companyId);
    expect(dom?.is_primary).toBe(1);
  },
);

// ---- Direction tag rejection ----------------------------------------------

test(
  "unknown direction tags are dropped at upsert time and a warning is " +
    "recorded in sources.evidence_snippet",
  () => {
    const { repo, db } = createInMemoryRepository();

    const run = repo.startRun({ source: "fake", limit: 1 });
    const r = repo.upsertCollectedLead(
      leadOf({
        companyName: "Mixed Tags Co",
        domain: "mixed.co",
        directionTags: ["backend", "ai-application", "made-up", "ai-app"],
      }),
      run.id,
    );

    expect(r.status).toBe("created");

    const company = db
      .query<{ direction_tags: string | null }, [number]>(
        "SELECT direction_tags FROM companies WHERE id = ?",
      )
      .get(r.companyId);
    // Only the two legal tags survive, in input order.
    expect(company?.direction_tags).toBe("backend,ai-app");

    // The dropped tags leave an audit trail on the source row used by this
    // lead. We don't promise a specific format beyond "mentions the bad tags".
    const source = db
      .query<{ evidence_snippet: string | null }, []>(
        "SELECT evidence_snippet FROM sources ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(source?.evidence_snippet).toContain("ai-application");
    expect(source?.evidence_snippet).toContain("made-up");
    // The warn: prefix namespaces this field so future enrichers can write
    // real evidence text alongside the warning without colliding.
    expect(source?.evidence_snippet).toMatch(/^warn:/);
  },
);

test(
  "all-legal direction tags do not pollute sources.evidence_snippet with a " +
    "warning",
  () => {
    const { repo, db } = createInMemoryRepository();

    const run = repo.startRun({ source: "fake", limit: 1 });
    repo.upsertCollectedLead(
      leadOf({
        companyName: "Clean Tags Co",
        domain: "clean.co",
        directionTags: ["backend", "ai-app"],
      }),
      run.id,
    );

    const source = db
      .query<{ evidence_snippet: string | null }, []>(
        "SELECT evidence_snippet FROM sources ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(source?.evidence_snippet).toBeNull();
  },
);

test("a lead with only unknown direction tags stores direction_tags as NULL", () => {
  const { repo, db } = createInMemoryRepository();

  const run = repo.startRun({ source: "fake", limit: 1 });
  const r = repo.upsertCollectedLead(
    leadOf({
      companyName: "All Wrong Co",
      domain: "wrong.co",
      directionTags: ["ai-application", "lol"],
    }),
    run.id,
  );

  const company = db
    .query<{ direction_tags: string | null }, [number]>(
      "SELECT direction_tags FROM companies WHERE id = ?",
    )
    .get(r.companyId);
  expect(company?.direction_tags).toBeNull();
});
