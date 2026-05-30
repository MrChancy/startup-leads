// Unit tests for the pure helpers in scripts/e2e.ts.
// The e2e *script itself* is exercised by `bun run e2e` (orchestrator runs
// it twice for S-3); these tests only cover the building blocks so a
// failure points at the broken helper, not at "the e2e fell over somewhere".

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";

import { runMigrations } from "../src/storage/sqlite/migrations.ts";
import {
  countCompanyScopedRows,
  deepEqual,
  firstMismatch,
  redactPayload,
} from "./e2e.ts";
import type { FeishuPayload } from "../src/feishu/mapper.ts";

function payload(fields: Record<string, unknown>): FeishuPayload {
  return { localId: "company-1", fields };
}

test("redactPayload replaces only `Last Checked At` and leaves everything else untouched", () => {
  const input = payload({
    Company: "Acme",
    Score: 80,
    "Last Checked At": "2026-05-30T12:00:00.123Z",
  });
  const out = redactPayload(input);
  expect(out.fields["Last Checked At"]).toBe("<REDACTED:lastCheckedAt>");
  expect(out.fields["Company"]).toBe("Acme");
  expect(out.fields["Score"]).toBe(80);
  expect(out.localId).toBe("company-1");
  // Original must be untouched (no in-place mutation).
  expect(input.fields["Last Checked At"]).toBe("2026-05-30T12:00:00.123Z");
});

test("deepEqual returns true for byte-equal nested structures with any key order", () => {
  const a = { x: 1, y: [{ a: 1, b: 2 }, { a: 3 }] };
  const b = { y: [{ b: 2, a: 1 }, { a: 3 }], x: 1 };
  expect(deepEqual(a, b)).toBe(true);
});

test("deepEqual catches scalar mismatch, array length mismatch, and missing keys", () => {
  expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
  expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
  expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  expect(deepEqual(null, {})).toBe(false);
  expect(deepEqual({}, null)).toBe(false);
  expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
});

test("firstMismatch returns null for equal inputs and a path for the first difference", () => {
  expect(firstMismatch({ a: 1 }, { a: 1 })).toBeNull();
  const msg = firstMismatch({ a: { b: 1 } }, { a: { b: 2 } });
  expect(msg).toContain("$.a.b");
  expect(msg).toContain("expected: 1");
  expect(msg).toContain("actual:   2");
});

test("firstMismatch reports an array index path on first divergence", () => {
  const msg = firstMismatch([{ x: 1 }, { x: 2 }], [{ x: 1 }, { x: 3 }]);
  expect(msg).toContain("$[1].x");
  expect(msg).toContain("expected: 2");
});

test("firstMismatch flags an extra key as <absent>", () => {
  const msg = firstMismatch({ a: 1 }, { a: 1, b: 2 });
  expect(msg).toContain("$.b");
  expect(msg).toContain("expected: <absent>");
});

test("countCompanyScopedRows reports zeroes for a fresh-migrated DB", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  const counts = countCompanyScopedRows(db);
  expect(counts).toEqual({
    companies: 0,
    company_domains: 0,
    jobs: 0,
    contacts: 0,
    lead_scores: 0,
    push_events: 0,
  });
  db.close();
});

test("countCompanyScopedRows reflects manual inserts (sanity check)", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  db.run(
    `INSERT INTO companies (name, normalized_name, row_created_at, row_updated_at) VALUES ('A', 'a', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  );
  expect(countCompanyScopedRows(db).companies).toBe(1);
  db.close();
});
