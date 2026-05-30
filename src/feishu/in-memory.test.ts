import { test, expect } from "bun:test";
import { createInMemoryFeishuClient } from "./in-memory.ts";
import type { CompanyLead } from "./client.ts";

function sampleLead(overrides: Partial<CompanyLead> = {}): CompanyLead {
  return {
    companyId: 1,
    localId: "company-1",
    name: "Acme AI",
    domain: "acme.ai",
    website: "https://acme.ai",
    description: "An AI company",
    directionTags: ["ai-app"],
    topJobs: [],
    topContacts: [],
    remoteLocation: "Remote",
    freshness: "fresh",
    score: 80,
    scorerVersion: "1.0.0",
    matchReason: [],
    sources: ["https://news.ycombinator.com/item?id=1"],
    lastCheckedAt: "2026-05-30T00:00:00.000Z",
    ...overrides,
  };
}

test("findRecordByLocalId before provision throws", async () => {
  const client = createInMemoryFeishuClient();
  await expect(client.findRecordByLocalId("company-1")).rejects.toThrow(
    /provision/,
  );
});

test("upsertCompanyLead before provision throws", async () => {
  const client = createInMemoryFeishuClient();
  await expect(client.upsertCompanyLead(sampleLead())).rejects.toThrow(
    /provision/,
  );
});

test("provision returns deterministic appToken and tableId", async () => {
  const client = createInMemoryFeishuClient();
  const result = await client.provision({ name: "Startup Leads" });
  expect(result.appToken).toBeTruthy();
  expect(result.tableId).toBeTruthy();
  // fieldIds should cover all logical fields the mapper emits so TB-8 can
  // walk a static field name → field id table at push time.
  expect(result.fieldIds).toBeTruthy();
  expect(Object.keys(result.fieldIds).length).toBeGreaterThan(0);
});

test("upsertCompanyLead creates a new record when localId is unseen", async () => {
  const client = createInMemoryFeishuClient();
  await client.provision({ name: "Startup Leads" });

  const res = await client.upsertCompanyLead(sampleLead());

  expect(res.created).toBe(true);
  expect(res.recordId).toBeTruthy();
});

test("upsertCompanyLead with same localId updates existing record (round-trip read)", async () => {
  const client = createInMemoryFeishuClient();
  await client.provision({ name: "Startup Leads" });

  const first = await client.upsertCompanyLead(sampleLead({ score: 70 }));
  const second = await client.upsertCompanyLead(sampleLead({ score: 95 }));

  expect(second.created).toBe(false);
  expect(second.recordId).toBe(first.recordId);

  const read = await client.findRecordByLocalId("company-1");
  expect(read).not.toBeNull();
  expect(read?.recordId).toBe(first.recordId);
  // The last write wins: fields reflect the second upsert's score.
  expect(read?.fields.Score).toBe(95);
});

test("findRecordByDomain returns the record after upsert", async () => {
  const client = createInMemoryFeishuClient();
  await client.provision({ name: "Startup Leads" });

  await client.upsertCompanyLead(sampleLead({ domain: "acme.ai" }));

  const byDomain = await client.findRecordByDomain("acme.ai");
  expect(byDomain).not.toBeNull();
  expect(byDomain?.localId).toBe("company-1");
});

test("findRecordByDomain returns null for unknown domain", async () => {
  const client = createInMemoryFeishuClient();
  await client.provision({ name: "Startup Leads" });

  await client.upsertCompanyLead(sampleLead());

  const miss = await client.findRecordByDomain("nope.example");
  expect(miss).toBeNull();
});

test("findRecordByLocalId returns null for unknown localId", async () => {
  const client = createInMemoryFeishuClient();
  await client.provision({ name: "Startup Leads" });

  const miss = await client.findRecordByLocalId("company-999");
  expect(miss).toBeNull();
});

test("findRecordByDomain ignores leads with null domain", async () => {
  // A lead with domain=null still gets a record (localId is enough) but
  // must NOT poison the by-domain index — findRecordByDomain('') and any
  // other lookup must miss.
  const client = createInMemoryFeishuClient();
  await client.provision({ name: "Startup Leads" });

  await client.upsertCompanyLead(sampleLead({ domain: null }));

  expect(await client.findRecordByDomain("")).toBeNull();
});

test("provision() called twice resets the in-memory state", async () => {
  // Tests that re-run setup must be able to start from empty.
  const client = createInMemoryFeishuClient();
  await client.provision({ name: "Startup Leads" });
  await client.upsertCompanyLead(sampleLead());

  await client.provision({ name: "Startup Leads" });
  const miss = await client.findRecordByLocalId("company-1");
  expect(miss).toBeNull();
});
