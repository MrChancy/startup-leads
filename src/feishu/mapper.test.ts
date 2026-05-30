import { test, expect } from "bun:test";
import {
  mapToFeishuFields,
  mapToFeishuPayload,
  truncateJobs,
  truncateContacts,
} from "./mapper.ts";
import type { CompanyLead, TopContact, TopJob } from "./client.ts";
import goldenPayload from "./test-fixtures/golden-payload.json" with { type: "json" };

function job(overrides: Partial<TopJob>): TopJob {
  return {
    title: "Backend Engineer",
    jobUrl: null,
    location: null,
    remotePolicy: null,
    freshness: "fresh",
    sourcePostedAt: null,
    ...overrides,
  };
}

function contact(overrides: Partial<TopContact>): TopContact {
  return {
    name: null,
    title: null,
    contactType: "email",
    value: "x@example.com",
    profileUrl: null,
    riskLevel: "low",
    priorityRank: null,
    ...overrides,
  };
}

function canonicalLead(): CompanyLead {
  // Deterministic input the golden fixture is recorded against.
  return {
    companyId: 42,
    localId: "company-42",
    name: "Acme AI",
    domain: "acme.ai",
    website: "https://acme.ai",
    description: "AI agents for legal teams",
    directionTags: ["ai-app", "backend"],
    topJobs: [
      job({
        title: "Backend Engineer",
        jobUrl: "https://acme.ai/jobs/be",
        location: "Berlin",
        remotePolicy: "remote-friendly",
        freshness: "fresh",
        sourcePostedAt: "2026-05-20T00:00:00.000Z",
      }),
      job({
        title: "ML Engineer",
        jobUrl: "https://acme.ai/jobs/ml",
        location: "Berlin",
        remotePolicy: "remote-friendly",
        freshness: "usable",
        sourcePostedAt: "2026-05-15T00:00:00.000Z",
      }),
    ],
    topContacts: [
      contact({
        name: "Alice",
        title: "CTO",
        contactType: "email",
        value: "alice@acme.ai",
        riskLevel: "low",
        priorityRank: 1,
      }),
      contact({
        name: "Bob",
        contactType: "github",
        value: "https://github.com/bob",
        profileUrl: "https://github.com/bob",
        riskLevel: "low",
        priorityRank: 2,
      }),
    ],
    remoteLocation: "Remote-friendly · Berlin",
    freshness: "fresh",
    score: 82,
    scorerVersion: "1.0.0",
    matchReason: [
      {
        component: "job_match",
        points: 35,
        evidenceSourceId: 7,
        note: "title:'Backend Engineer' matches backend engineer",
      },
      {
        component: "freshness",
        points: 15,
        evidenceSourceId: 7,
        note: "freshest job: fresh",
      },
    ],
    sources: ["https://news.ycombinator.com/item?id=999"],
    lastCheckedAt: "2026-05-30T00:00:00.000Z",
  };
}

test("mapToFeishuPayload matches the golden fixture", () => {
  const payload = mapToFeishuPayload(canonicalLead());
  expect(payload).toEqual(goldenPayload);
});

test("mapToFeishuFields includes Scorer Version and Local ID", () => {
  const fields = mapToFeishuFields(canonicalLead());
  expect(fields["Scorer Version"]).toBe("1.0.0");
  expect(fields["Local ID"]).toBe("company-42");
});

test("mapToFeishuFields includes every spec field", () => {
  const fields = mapToFeishuFields(canonicalLead());
  // Spec § 飞书记录字段
  const required = [
    "Company",
    "Website",
    "Domain",
    "Direction Tags",
    "Top Jobs",
    "Remote / Location",
    "Freshness",
    "Score",
    "Scorer Version",
    "Match Reason",
    "Recommended Contacts",
    "Contact Risk",
    "Sources",
    "Status",
    "Last Checked At",
    "Local ID",
    "Review Notes",
  ];
  for (const name of required) {
    expect(fields).toHaveProperty(name);
  }
});

// --- truncation rules ----------------------------------------------------

test("truncateJobs takes top 3 by freshness desc then sourcePostedAt desc", () => {
  // Note: real query pre-filters stale/unknown, but the truncation rule must
  // be defined for all states so a future relaxation can't silently reorder.
  const input: TopJob[] = [
    job({ title: "old fresh",   freshness: "fresh",   sourcePostedAt: "2026-01-01T00:00:00.000Z" }),
    job({ title: "new usable",  freshness: "usable",  sourcePostedAt: "2026-05-30T00:00:00.000Z" }),
    job({ title: "newest fresh", freshness: "fresh",  sourcePostedAt: "2026-05-29T00:00:00.000Z" }),
    job({ title: "stale newest", freshness: "stale",  sourcePostedAt: "2026-05-30T00:00:00.000Z" }),
    job({ title: "unknown newest", freshness: "unknown", sourcePostedAt: "2026-05-30T00:00:00.000Z" }),
  ];
  const out = truncateJobs(input);
  expect(out).toHaveLength(3);
  expect(out[0]!.title).toBe("newest fresh"); // fresh beats usable
  expect(out[1]!.title).toBe("old fresh");    // also fresh, older date but still fresh-band
  expect(out[2]!.title).toBe("new usable");   // best non-fresh
});

test("truncateJobs handles ties by sourcePostedAt newest first", () => {
  const input: TopJob[] = [
    job({ title: "A", freshness: "fresh", sourcePostedAt: "2026-05-10T00:00:00.000Z" }),
    job({ title: "B", freshness: "fresh", sourcePostedAt: "2026-05-20T00:00:00.000Z" }),
    job({ title: "C", freshness: "fresh", sourcePostedAt: "2026-05-15T00:00:00.000Z" }),
  ];
  expect(truncateJobs(input).map((j) => j.title)).toEqual(["B", "C", "A"]);
});

test("truncateJobs treats null sourcePostedAt as oldest (sorts last in ties)", () => {
  const input: TopJob[] = [
    job({ title: "no-date",  freshness: "fresh", sourcePostedAt: null }),
    job({ title: "has-date", freshness: "fresh", sourcePostedAt: "2026-05-20T00:00:00.000Z" }),
  ];
  expect(truncateJobs(input).map((j) => j.title)).toEqual(["has-date", "no-date"]);
});

test("truncateContacts takes top 3 by priorityRank asc then riskLevel low->medium->high", () => {
  const input: TopContact[] = [
    contact({ name: "rank3-low",     priorityRank: 3, riskLevel: "low" }),
    contact({ name: "rank1-medium",  priorityRank: 1, riskLevel: "medium" }),
    contact({ name: "rank2-high",    priorityRank: 2, riskLevel: "high" }),
    contact({ name: "rank1-low",     priorityRank: 1, riskLevel: "low" }),
    contact({ name: "rank-null-low", priorityRank: null, riskLevel: "low" }),
  ];
  const out = truncateContacts(input);
  expect(out).toHaveLength(3);
  expect(out[0]!.name).toBe("rank1-low");    // rank 1, low risk
  expect(out[1]!.name).toBe("rank1-medium"); // rank 1, medium risk
  expect(out[2]!.name).toBe("rank2-high");   // rank 2 beats rank 3 and null
});

test("truncateContacts puts null priorityRank last", () => {
  const input: TopContact[] = [
    contact({ name: "null", priorityRank: null, riskLevel: "low" }),
    contact({ name: "rank5", priorityRank: 5, riskLevel: "high" }),
  ];
  expect(truncateContacts(input).map((c) => c.name)).toEqual(["rank5", "null"]);
});

test("mapToFeishuFields applies top-3 truncation inside the payload", () => {
  const lead = canonicalLead();
  const fiveJobs: TopJob[] = Array.from({ length: 5 }, (_, i) =>
    job({
      title: `Job ${i + 1}`,
      freshness: "fresh",
      // descending dates: i=0 newest, i=4 oldest
      sourcePostedAt: `2026-05-${String(20 - i).padStart(2, "0")}T00:00:00.000Z`,
    }),
  );
  const fields = mapToFeishuFields({ ...lead, topJobs: fiveJobs });
  expect(Array.isArray(fields["Top Jobs"])).toBe(true);
  expect((fields["Top Jobs"] as unknown[]).length).toBe(3);
});

test("mapToFeishuFields truncates contacts to 3", () => {
  const lead = canonicalLead();
  const fiveContacts: TopContact[] = Array.from({ length: 5 }, (_, i) =>
    contact({ name: `c${i}`, priorityRank: i + 1, riskLevel: "low" }),
  );
  const fields = mapToFeishuFields({ ...lead, topContacts: fiveContacts });
  expect((fields["Recommended Contacts"] as unknown[]).length).toBe(3);
});
