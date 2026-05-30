import { test, expect } from "bun:test";
import { formatDryRun } from "./dry-run.ts";
import type { FeishuPayload } from "./mapper.ts";

function payload(overrides: Partial<FeishuPayload> = {}): FeishuPayload {
  return {
    localId: "company-1",
    fields: {
      Company: "Acme AI",
      Domain: "acme.ai",
      Score: 80,
      "Scorer Version": "1.0.0",
    },
    ...overrides,
  };
}

test("formatDryRun with no payloads shows a 'no candidates' message", () => {
  // I-2: empty collection is success (exit 0) — this is a list query, not
  // an id lookup. But the CLI must still TELL the operator nothing matched
  // so silence doesn't look like a stuck process.
  const out = formatDryRun([], { minScore: 70 });
  expect(out).toMatch(/no candidates/i);
  expect(out).toMatch(/70/); // surfaces the threshold so the operator can tune it
});

test("formatDryRun prints a header line with payload count and threshold", () => {
  const out = formatDryRun([payload()], { minScore: 70 });
  expect(out).toMatch(/dry-run/i);
  expect(out).toMatch(/1 candidate/);
  expect(out).toMatch(/70/);
});

test("formatDryRun emits one block per payload with localId visible", () => {
  const out = formatDryRun(
    [
      payload({ localId: "company-1" }),
      payload({ localId: "company-2" }),
    ],
    { minScore: 70 },
  );
  expect(out).toContain("company-1");
  expect(out).toContain("company-2");
});

test("formatDryRun includes the JSON payload so a human can spot-check", () => {
  const out = formatDryRun([payload()], { minScore: 70 });
  // The serialised JSON must appear — the whole point of dry-run is to let
  // the operator eyeball what would be sent.
  expect(out).toContain("\"Company\": \"Acme AI\"");
  expect(out).toContain("\"Scorer Version\": \"1.0.0\"");
});

test("formatDryRun never says 'pushed' or 'sent' (would lie)", () => {
  // Defensive: dry-run must not produce strings that resemble a successful
  // push. TB-8's real push uses different verbs.
  const out = formatDryRun([payload()], { minScore: 70 });
  expect(out).not.toMatch(/\bpushed\b/i);
  expect(out).not.toMatch(/\bsent\b/i);
});

test("formatDryRun output is deterministic (S-3 idempotency)", () => {
  // Same input → identical output. Two `push-feishu --dry-run` runs on a
  // fresh DB must agree byte-for-byte.
  const a = formatDryRun([payload(), payload({ localId: "company-2" })], { minScore: 70 });
  const b = formatDryRun([payload(), payload({ localId: "company-2" })], { minScore: 70 });
  expect(b).toBe(a);
});
