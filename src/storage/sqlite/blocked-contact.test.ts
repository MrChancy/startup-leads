import { test, expect } from "bun:test";
import { createInMemoryRepository } from "./test-support.ts";
import type { CollectedLead } from "../../types/index.ts";

// TB-12 audit: a lead with blocked contacts persists the non-blocked ones
// only and records the rejected count in sources.evidence_snippet using the
// shared `warn:` prefix (same channel direction-tag rejection uses).

function leadOf(over: Partial<CollectedLead> = {}): CollectedLead {
  return {
    companyName: "Acme AI",
    domain: "acme.ai",
    directionTags: [],
    jobs: [],
    contacts: [],
    source: {
      sourceType: "fake",
      sourceUrl: "fake://acme",
      sourceTitle: "Fake",
      retrievedAt: new Date().toISOString(),
    },
    ...over,
  };
}

test(
  "blocked contacts are not persisted and the count is logged with warn: prefix",
  () => {
    const { repo, db } = createInMemoryRepository();
    const run = repo.startRun({ source: "fake", limit: 1 });
    repo.upsertCollectedLead(
      leadOf({
        contacts: [
          { contactType: "email", value: "ok1@x.io", riskLevel: "low" },
          { contactType: "email", value: "ok2@x.io", riskLevel: "medium" },
          { contactType: "email", value: "bad@x.io", riskLevel: "blocked" },
        ],
      }),
      run.id,
    );

    const persisted = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM contacts")
      .get();
    expect(persisted?.c).toBe(2);

    const source = db
      .query<{ evidence_snippet: string | null }, []>(
        "SELECT evidence_snippet FROM sources ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(source?.evidence_snippet).toContain("warn:blocked_contact_rejected: 1");
  },
);

test(
  "blocked + direction-tag rejection coexist on one source.evidence_snippet",
  () => {
    const { repo, db } = createInMemoryRepository();
    const run = repo.startRun({ source: "fake", limit: 1 });
    repo.upsertCollectedLead(
      leadOf({
        directionTags: ["ai-app", "made-up-tag"],
        contacts: [
          { contactType: "email", value: "bad@x.io", riskLevel: "blocked" },
        ],
      }),
      run.id,
    );

    const source = db
      .query<{ evidence_snippet: string | null }, []>(
        "SELECT evidence_snippet FROM sources ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(source?.evidence_snippet).toContain("warn:direction_tag_rejected:");
    expect(source?.evidence_snippet).toContain("warn:blocked_contact_rejected: 1");
  },
);

test(
  "no blocked contacts and no rejected tags leaves evidence_snippet null",
  () => {
    const { repo, db } = createInMemoryRepository();
    const run = repo.startRun({ source: "fake", limit: 1 });
    repo.upsertCollectedLead(
      leadOf({
        directionTags: ["ai-app"],
        contacts: [
          { contactType: "email", value: "ok@x.io", riskLevel: "low" },
        ],
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

// --- retrievedAt validation: empty string rejects the whole lead -----------

test(
  "empty retrievedAt throws and rolls back — no orphan rows are written",
  () => {
    const { repo, db } = createInMemoryRepository();
    const run = repo.startRun({ source: "fake", limit: 1 });

    const before = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM sources")
      .get();

    expect(() =>
      repo.upsertCollectedLead(
        leadOf({
          source: {
            sourceType: "fake",
            sourceUrl: "fake://acme",
            sourceTitle: "Fake",
            retrievedAt: "",
          },
        }),
        run.id,
      ),
    ).toThrow(/retrievedAt/);

    const sourcesAfter = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM sources")
      .get();
    const companiesAfter = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM companies")
      .get();
    // Rejected BEFORE the source insert, so no rows at all.
    expect(sourcesAfter?.c).toBe(before?.c ?? 0);
    expect(companiesAfter?.c).toBe(0);
  },
);
