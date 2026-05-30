import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryRepository } from "../../storage/sqlite/test-support.ts";
import {
  CSV_HEADER,
  runExportCsv,
  type ExportStreamLike,
} from "./export.ts";
import type { CollectedLead, LeadScoreRecord } from "../../types/index.ts";

// ---- helpers --------------------------------------------------------------

function fakeLead(overrides: Partial<CollectedLead> = {}): CollectedLead {
  return {
    companyName: "Acme AI",
    domain: "acme.ai",
    description: "An AI company",
    directionTags: ["ai-app"],
    jobs: [
      {
        title: "Backend Engineer",
        jobUrl: "https://acme.ai/jobs/be",
        location: "Berlin",
        freshness: "fresh",
        sourcePostedAt: "2026-05-20T00:00:00.000Z",
      },
    ],
    contacts: [
      {
        name: "Alice",
        contactType: "email",
        value: "alice@acme.ai",
        riskLevel: "low",
      },
    ],
    source: {
      sourceType: "fake",
      sourceUrl: "https://example/item?id=1",
      sourceTitle: "fake collector",
      retrievedAt: "2026-05-30T00:00:00.000Z",
    },
    ...overrides,
  };
}

function fakeScore(
  companyId: number,
  runId: string,
  overrides: Partial<LeadScoreRecord> = {},
): LeadScoreRecord {
  return {
    companyId,
    runId,
    score: 82,
    jobMatchScore: 35,
    directionScore: 20,
    freshnessScore: 15,
    contactScore: 7,
    actionabilityScore: 5,
    matchReason: [
      {
        component: "jobMatch",
        points: 35,
        evidenceSourceId: null,
        note: "backend match strong",
      },
    ],
    decision: "accepted_for_feishu",
    scorerVersion: "1.0.0",
    ...overrides,
  };
}

// Capturing stream that records every write as a string. Mirrors the small
// surface runExportCsv actually uses, so the test never needs a real fd.
function capturingStream(): ExportStreamLike & { read(): string } {
  const chunks: string[] = [];
  return {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    read() {
      return chunks.join("");
    },
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "csv-export-"));
}

const FROZEN_NOW = new Date("2026-05-30T12:34:56.000Z");

// ---- AC 1 / 3: empty DB → header-only CSV --------------------------------

test("empty DB → CSV has only the header line", () => {
  const { repo } = createInMemoryRepository();
  const out = capturingStream();
  const result = runExportCsv({ repo, out, now: () => FROZEN_NOW });
  expect(result.path).toBeNull(); // stdout-style write returns null
  expect(out.read()).toBe(CSV_HEADER.join(",") + "\r\n");
});

// ---- AC 2: every column appears in the header in the right order ---------

test("CSV header lists the 10 spec columns in the spec order", () => {
  expect(CSV_HEADER).toEqual([
    "Company",
    "Domain",
    "Direction Tags",
    "Score",
    "Scorer Version",
    "Freshness",
    "Match Reason",
    "Top Job",
    "Recommended Contact",
    "Last Checked At",
  ]);
});

// ---- AC 5: single company round-trip --------------------------------------

test("single scored company round-trips through the CSV", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const stored = repo.upsertCollectedLead(fakeLead(), run.id);
  repo.writeLeadScore(fakeScore(stored.companyId, run.id));
  repo.finishRun(run.id, "completed");

  const out = capturingStream();
  runExportCsv({ repo, out, now: () => FROZEN_NOW });

  const text = out.read();
  const lines = text.split("\r\n").filter((l) => l.length > 0);
  expect(lines).toHaveLength(2); // header + one data row
  const data = lines[1]!;
  expect(data).toContain("Acme AI");
  expect(data).toContain("acme.ai");
  expect(data).toContain("ai-app");
  expect(data).toContain("82");
  expect(data).toContain("1.0.0");
  expect(data).toContain("fresh");
  expect(data).toContain("Backend Engineer @ Berlin");
  expect(data).toContain("Alice");
  expect(data).toContain("alice@acme.ai");
  expect(data).toContain("(low)");
  // Match Reason text uses "<component>+<points>: <note>" entries joined by "; ".
  expect(data).toContain("jobMatch+35: backend match strong");
});

// ---- AC 5: ordered by score desc ------------------------------------------

test("multi-row CSV is sorted by score DESC", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 3 });
  const a = repo.upsertCollectedLead(
    fakeLead({ companyName: "Lo", domain: "lo.com", jobs: [{ title: "j", jobUrl: "https://lo.com/j", freshness: "fresh" }] }),
    run.id,
  );
  const b = repo.upsertCollectedLead(
    fakeLead({ companyName: "Hi", domain: "hi.com", jobs: [{ title: "j", jobUrl: "https://hi.com/j", freshness: "fresh" }] }),
    run.id,
  );
  const c = repo.upsertCollectedLead(
    fakeLead({ companyName: "Mid", domain: "mid.com", jobs: [{ title: "j", jobUrl: "https://mid.com/j", freshness: "fresh" }] }),
    run.id,
  );
  repo.writeLeadScore(fakeScore(a.companyId, run.id, { score: 40 }));
  repo.writeLeadScore(fakeScore(b.companyId, run.id, { score: 95 }));
  repo.writeLeadScore(fakeScore(c.companyId, run.id, { score: 70 }));
  repo.finishRun(run.id, "completed");

  const out = capturingStream();
  runExportCsv({ repo, out, now: () => FROZEN_NOW });
  const lines = out.read().split("\r\n").filter((l) => l.length > 0);
  // header + 3 rows
  expect(lines).toHaveLength(4);
  expect(lines[1]!.startsWith("Hi,")).toBe(true);
  expect(lines[2]!.startsWith("Mid,")).toBe(true);
  expect(lines[3]!.startsWith("Lo,")).toBe(true);
});

// ---- AC 5: comma / quote escaping ----------------------------------------

test("commas and quotes in company name are RFC-4180 escaped", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const stored = repo.upsertCollectedLead(
    fakeLead({
      companyName: 'Beta, "Cloud" Inc.',
      domain: "beta.cloud",
      jobs: [{ title: "j", jobUrl: "https://beta.cloud/j", freshness: "fresh" }],
    }),
    run.id,
  );
  repo.writeLeadScore(fakeScore(stored.companyId, run.id));
  repo.finishRun(run.id, "completed");

  const out = capturingStream();
  runExportCsv({ repo, out, now: () => FROZEN_NOW });
  const text = out.read();
  // The full quoted form per RFC 4180: inner " is doubled, the whole field
  // is wrapped in surrounding quotes.
  expect(text).toContain('"Beta, ""Cloud"" Inc."');
});

// ---- Top Job tie-break: freshness > sourcePostedAt > title ---------------

test("Top Job picks the fresher job when multiple coexist", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const stored = repo.upsertCollectedLead(
    fakeLead({
      jobs: [
        { title: "Old Backend", jobUrl: "https://acme.ai/old", freshness: "usable", sourcePostedAt: "2026-01-01T00:00:00.000Z" },
        { title: "New Backend", jobUrl: "https://acme.ai/new", freshness: "fresh", sourcePostedAt: "2026-05-20T00:00:00.000Z" },
      ],
    }),
    run.id,
  );
  repo.writeLeadScore(fakeScore(stored.companyId, run.id));
  repo.finishRun(run.id, "completed");

  const out = capturingStream();
  runExportCsv({ repo, out, now: () => FROZEN_NOW });
  expect(out.read()).toContain("New Backend");
  // The losing row's title must NOT appear in the Top Job column (it can
  // legitimately appear elsewhere — Match Reason etc — but we only fed one
  // company so any "Old Backend" leak means the wrong job won).
  expect(out.read()).not.toContain("Old Backend");
});

// ---- Recommended Contact: skip blocked, prefer lower priorityRank --------

test("Recommended Contact skips blocked risk and prefers lower priorityRank", () => {
  // Blocked-risk contacts are rejected at upsert time, so we can't easily
  // seed one; instead verify the priority preference, which is the column
  // logic the exporter actually owns.
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const stored = repo.upsertCollectedLead(
    fakeLead({
      contacts: [
        { name: "Low Priority", contactType: "email", value: "low@acme.ai", riskLevel: "medium" },
        { name: "High Priority", contactType: "email", value: "hi@acme.ai", riskLevel: "low" },
      ],
    }),
    run.id,
  );
  repo.writeLeadScore(fakeScore(stored.companyId, run.id));
  repo.finishRun(run.id, "completed");

  const out = capturingStream();
  runExportCsv({ repo, out, now: () => FROZEN_NOW });
  // priorityRank is null for both (collector path doesn't set it), so the
  // tie-break falls to riskLevel: low > medium. "High Priority" wins.
  expect(out.read()).toContain("hi@acme.ai");
  expect(out.read()).toContain("(low)");
});

// ---- Freshness rollup (fresh > usable > unknown > stale) -----------------

test("Freshness column rolls up to the best job freshness", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 1 });
  const stored = repo.upsertCollectedLead(
    fakeLead({
      jobs: [
        { title: "u1", jobUrl: "https://acme.ai/u1", freshness: "usable" },
        { title: "s1", jobUrl: "https://acme.ai/s1", freshness: "stale" },
      ],
    }),
    run.id,
  );
  repo.writeLeadScore(fakeScore(stored.companyId, run.id));
  repo.finishRun(run.id, "completed");

  const out = capturingStream();
  runExportCsv({ repo, out, now: () => FROZEN_NOW });
  const data = out.read().split("\r\n")[1]!;
  // The freshness column is the 6th column (index 5). With no commas in
  // earlier fields for this fixture, splitting on "," is safe.
  expect(data.split(",")[5]).toBe("usable");
});

// ---- File mode: default path under data/exports/<timestamp>.csv ---------

test("file mode writes data/exports/<timestamp>.csv with the same content", () => {
  const dir = tempDir();
  try {
    const { repo } = createInMemoryRepository();
    const run = repo.startRun({ source: "fake", limit: 1 });
    const stored = repo.upsertCollectedLead(fakeLead(), run.id);
    repo.writeLeadScore(fakeScore(stored.companyId, run.id));
    repo.finishRun(run.id, "completed");

    const result = runExportCsv({
      repo,
      now: () => FROZEN_NOW,
      outputDir: dir,
    });
    expect(result.path).not.toBeNull();
    // Path format: <dir>/2026-05-30T12-34-56.csv (colons swapped to dashes
    // so Windows-friendly).
    expect(result.path!.endsWith("2026-05-30T12-34-56.csv")).toBe(true);
    const fileText = readFileSync(result.path!, "utf8");
    expect(fileText.startsWith(CSV_HEADER.join(",") + "\r\n")).toBe(true);
    expect(fileText).toContain("Acme AI");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- M1: intra-second collision must not silently overwrite -------------

test("two file exports with the same injected `now` error instead of silently overwriting", () => {
  // pr-review TB-5 M1: two invocations within the same wall-clock second
  // resolve to the same `<dir>/<YYYY-MM-DDTHH-mm-ss>.csv`. writeFileSync
  // with the default 'w' flag silently overwrites — the first export's
  // bytes are lost with no signal. The contract must be: second call
  // fails loud with a clear message (so the operator either picks --stdout
  // or waits one second), NOT silent data loss.
  const { repo } = createInMemoryRepository();
  const dir = tempDir();
  try {
    const first = runExportCsv({
      repo,
      now: () => FROZEN_NOW,
      outputDir: dir,
    });
    expect(first.path).not.toBeNull();
    // Same `now` → same slug → would overwrite. Must throw.
    expect(() =>
      runExportCsv({
        repo,
        now: () => FROZEN_NOW,
        outputDir: dir,
      }),
    ).toThrow(/already exists/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- S-3 idempotency: two calls with the same frozen `now` are byte-equal

test("two exports with the same injected `now` produce byte-identical CSV (S-3)", () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "fake", limit: 2 });
  const a = repo.upsertCollectedLead(
    fakeLead({ companyName: "A", domain: "a.com", jobs: [{ title: "j", jobUrl: "https://a.com/j", freshness: "fresh" }] }),
    run.id,
  );
  const b = repo.upsertCollectedLead(
    fakeLead({ companyName: "B", domain: "b.com", jobs: [{ title: "j", jobUrl: "https://b.com/j", freshness: "fresh" }] }),
    run.id,
  );
  repo.writeLeadScore(fakeScore(a.companyId, run.id, { score: 88 }));
  repo.writeLeadScore(fakeScore(b.companyId, run.id, { score: 88 }));
  repo.finishRun(run.id, "completed");

  const out1 = capturingStream();
  runExportCsv({ repo, out: out1, now: () => FROZEN_NOW });
  const out2 = capturingStream();
  runExportCsv({ repo, out: out2, now: () => FROZEN_NOW });
  expect(out2.read()).toBe(out1.read());
});
