#!/usr/bin/env bun
// TB-13 end-to-end smoke driver.
//
// Drives the FULL pipeline in-process so failures point at the failing
// component, not at brittle CLI stdout parsing:
//   HN fixtures (file system) → fake HttpClient → runCollect → SQLite
//     → runExportCsv → CSV string buffer
//     → buildPushCandidates → mapToFeishuPayload → golden diff
//   ↓
//   second pass: same inputs must produce same outputs (S-3 idempotency)
//   ↓
//   purgeOlderThan: company-scoped tables drop to migrations baseline
//
// Exit 0 on success, 1 on failure with the first failing assertion on stderr.
//
// `--update-golden`: re-record tests/golden/feishu-payload.json from the
// current mapper output. Run this ONCE manually after a deliberate mapper
// change, commit the file, then runs without the flag must match it.

import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runMigrations } from "../src/storage/sqlite/migrations.ts";
import { createSqliteLeadRepository } from "../src/storage/sqlite/repository.ts";
import { createHnCollector } from "../src/collectors/hn/index.ts";
import {
  loadFixture,
  makeFakeHttpClient,
} from "../src/collectors/hn/test-support.ts";
import { ALGOLIA_BASE } from "../src/collectors/hn/algolia.ts";
import { itemUrl } from "../src/collectors/hn/firebase.ts";
import { runCollect } from "../src/cli/collect.ts";
import { runExportCsv } from "../src/exporters/csv/export.ts";
import { buildPushCandidates } from "../src/feishu/query.ts";
import { mapToFeishuPayload, type FeishuPayload } from "../src/feishu/mapper.ts";

// Frozen reference time. Tuned so the May 2026 HN fixtures land in the
// `fresh` (≤30d) and `usable` (≤180d) bands deterministically. Picking
// 2026-05-30 means comment-a (May 29) → fresh, comment-c (Mar 28) → usable,
// comment-d (no time) → unknown.
const FROZEN_NOW = new Date("2026-05-30T00:00:00.000Z");

// Wall-clock fields downstream of writeLeadScore use `new Date()` at
// insert time (`repository.ts` writeLeadScore line 855). We can't pin them
// without invasive Date stubbing, so we redact them before comparing to
// the golden. The redacted shape is part of the golden contract.
const REDACTED_TIMESTAMP = "<REDACTED:lastCheckedAt>";

const GOLDEN_PATH = join(import.meta.dir, "..", "tests", "golden", "feishu-payload.json");

interface AlgoliaHit {
  objectID: string;
  title: string;
}

function buildHnFixtureMap(): Record<string, string> {
  // We mirror the URL-construction the collector does (ALGOLIA_BASE +
  // itemUrl) so renames stay in sync — never hardcode the URL strings.
  const algoliaJson = loadFixture<{ hits: AlgoliaHit[] }>("algolia-search.json");
  const story = loadFixture<{ id: number; kids?: number[] }>("firebase-post.json");
  const postId = algoliaJson.hits[0]!.objectID;

  const map: Record<string, string> = {
    [ALGOLIA_BASE]: JSON.stringify(algoliaJson),
    [itemUrl(postId)]: JSON.stringify(story),
  };
  // Map each kid id to its fixture file. The list mirrors the kids in
  // firebase-post.json — extending one without the other will throw a
  // clear "no mapping for ..." error from makeFakeHttpClient.
  const commentFixtures: Record<number, string> = {
    42000010: "comment-a-pipe-format.json",
    42000011: "comment-b-prose.json",
    42000012: "comment-c-onsite.json",
    42000013: "comment-d-no-time.json",
    42000014: "comment-e-multi-role.json",
    42000015: "comment-f-deleted.json",
  };
  for (const [id, file] of Object.entries(commentFixtures)) {
    map[itemUrl(id)] = JSON.stringify(loadFixture(file));
  }
  return map;
}

export function redactPayload(payload: FeishuPayload): FeishuPayload {
  // Only `Last Checked At` is non-deterministic. Everything else is a pure
  // function of the input fixture + scorer + mapper.
  return {
    ...payload,
    fields: {
      ...payload.fields,
      "Last Checked At": REDACTED_TIMESTAMP,
    },
  };
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).sort();
  const bk = Object.keys(bo).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
    if (!deepEqual(ao[ak[i]!], bo[bk[i]!])) return false;
  }
  return true;
}

// Minimal structural diff: returns a string showing the first mismatch
// path. Good enough for golden-file diagnostics; we're not building a real
// diff library.
export function firstMismatch(
  expected: unknown,
  actual: unknown,
  path = "$",
): string | null {
  if (deepEqual(expected, actual)) return null;
  if (
    expected === null ||
    actual === null ||
    typeof expected !== typeof actual ||
    typeof expected !== "object"
  ) {
    return `${path}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`;
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) {
    return `${path}: array vs object mismatch`;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return `${path}.length\n  expected: ${expected.length}\n  actual:   ${actual.length}`;
    }
    for (let i = 0; i < expected.length; i++) {
      const sub = firstMismatch(expected[i], actual[i], `${path}[${i}]`);
      if (sub) return sub;
    }
  }
  const eo = expected as Record<string, unknown>;
  const ao = actual as Record<string, unknown>;
  const allKeys = new Set([...Object.keys(eo), ...Object.keys(ao)]);
  for (const k of allKeys) {
    if (!(k in eo)) return `${path}.${k}\n  expected: <absent>\n  actual:   ${JSON.stringify(ao[k])}`;
    if (!(k in ao)) return `${path}.${k}\n  expected: ${JSON.stringify(eo[k])}\n  actual:   <absent>`;
    const sub = firstMismatch(eo[k], ao[k], `${path}.${k}`);
    if (sub) return sub;
  }
  return null;
}

// Test-targetable assertion: throws with a clear prefix so the top-level
// catch can print it to stderr without ceremony.
function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

interface CompanyScopedRowCounts {
  companies: number;
  company_domains: number;
  jobs: number;
  contacts: number;
  lead_scores: number;
  push_events: number;
}

export function countCompanyScopedRows(db: Database): CompanyScopedRowCounts {
  // Sources rows survive purge by design (audit; FK is SET NULL). Runs
  // rows also survive — they're the history log. The migrations-baseline
  // bar is "no company-scoped rows", not "DB byte-for-byte empty".
  const q = (sql: string): number =>
    (db.query<{ c: number }, []>(sql).get()?.c ?? 0);
  return {
    companies: q("SELECT COUNT(*) AS c FROM companies"),
    company_domains: q("SELECT COUNT(*) AS c FROM company_domains"),
    jobs: q("SELECT COUNT(*) AS c FROM jobs"),
    contacts: q("SELECT COUNT(*) AS c FROM contacts"),
    lead_scores: q("SELECT COUNT(*) AS c FROM lead_scores"),
    push_events: q("SELECT COUNT(*) AS c FROM push_events"),
  };
}

function captureStream() {
  const chunks: string[] = [];
  return {
    write(s: string): boolean {
      chunks.push(s);
      return true;
    },
    read() {
      return chunks.join("");
    },
  };
}

async function runOnePass(args: {
  db: Database;
  fixtureMap: Record<string, string>;
}): Promise<{ payloads: FeishuPayload[]; csv: string }> {
  const repo = createSqliteLeadRepository(args.db);
  const { client } = makeFakeHttpClient(args.fixtureMap);
  const collector = createHnCollector({
    client,
    now: () => FROZEN_NOW,
    // Silence the "no monthly thread" warn channel — won't trigger here
    // since the fixture has the May 2026 post, but defensive.
    warn: () => {},
  });

  await runCollect({ repo, collector, limit: 20 });

  const csvOut = captureStream();
  runExportCsv({ repo, now: () => FROZEN_NOW, out: csvOut });

  const candidates = buildPushCandidates({ repo, minScore: 70 });
  const payloads = candidates.map(mapToFeishuPayload).map(redactPayload);
  return { payloads, csv: csvOut.read() };
}

async function main() {
  const argv = process.argv.slice(2);
  const updateGolden = argv.includes("--update-golden");

  const dbPath = process.env.STARTUP_LEADS_DB ?? ":memory:";
  const db = new Database(dbPath);
  runMigrations(db);

  const fixtureMap = buildHnFixtureMap();

  // ---- pass 1 -----------------------------------------------------------
  const pass1 = await runOnePass({ db, fixtureMap });
  check(
    pass1.csv.split("\r\n").filter(Boolean).length >= 2,
    `CSV pass 1: expected ≥1 header + 1 data row, got ${pass1.csv.length} chars`,
  );
  check(
    pass1.payloads.length >= 1,
    `Feishu pass 1: expected ≥1 payload with score≥70, got ${pass1.payloads.length}`,
  );

  if (updateGolden) {
    writeFileSync(GOLDEN_PATH, JSON.stringify(pass1.payloads, null, 2) + "\n");
    console.log(`e2e: golden file rewritten at ${GOLDEN_PATH} (${pass1.payloads.length} payloads).`);
    process.exit(0);
  }

  // ---- golden diff ------------------------------------------------------
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as FeishuPayload[];
  const mismatch = firstMismatch(golden, pass1.payloads);
  if (mismatch) {
    process.stderr.write(
      `e2e FAIL: feishu payload does not match golden at ${mismatch}\n`,
    );
    process.stderr.write(
      `(Run \`bun run e2e --update-golden\` ONLY if this change is intentional.)\n`,
    );
    process.exit(1);
  }

  // ---- pass 2: S-3 idempotency -----------------------------------------
  const repo = createSqliteLeadRepository(db);
  const before = countCompanyScopedRows(db);
  const pass2 = await runOnePass({ db, fixtureMap });
  const after = countCompanyScopedRows(db);
  check(
    after.companies === before.companies,
    `S-3 pass 2 created duplicate companies: ${before.companies} → ${after.companies}`,
  );
  check(
    after.jobs === before.jobs,
    `S-3 pass 2 created duplicate jobs: ${before.jobs} → ${after.jobs}`,
  );
  check(
    after.contacts === before.contacts,
    `S-3 pass 2 created duplicate contacts: ${before.contacts} → ${after.contacts}`,
  );
  check(
    pass2.csv === pass1.csv,
    `S-3 pass 2 CSV diverged from pass 1`,
  );
  const payloadMismatch = firstMismatch(pass1.payloads, pass2.payloads);
  check(
    payloadMismatch === null,
    `S-3 pass 2 payload diverged from pass 1 at ${payloadMismatch}`,
  );

  // ---- purge --older-than 0d cleans company-scoped tables -------------
  // Cutoff = FROZEN_NOW + 1s to ensure all `row_created_at` strings
  // (written with the wall clock during runCollect) are strictly less.
  // In production the cutoff is wall-clock derived; here we just need
  // "anything created so far".
  const cutoff = new Date(Date.now() + 60_000).toISOString();
  repo.purgeOlderThan(cutoff);
  const afterPurge = countCompanyScopedRows(db);
  for (const [table, count] of Object.entries(afterPurge)) {
    check(
      count === 0,
      `purge --older-than 0d left rows in ${table}: ${count} remaining`,
    );
  }

  console.log(
    `e2e: OK (pass1=${pass1.payloads.length} payloads, after-purge=baseline).`,
  );
  process.exit(0);
}

// Only run when invoked as a script (e.g. `bun run scripts/e2e.ts` or via
// the .sh wrapper). Importing the module from a test must NOT trigger the
// full pipeline — otherwise `bun test` would run e2e as a side effect.
if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`e2e FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    if (err instanceof Error && err.stack) process.stderr.write(err.stack + "\n");
    process.exit(1);
  });
}
