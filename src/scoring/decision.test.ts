import { test, expect } from "bun:test";
import { decideOutcome } from "./decision.ts";
import { makeContact, makeJob, makeTestCompany } from "./test-support.ts";

// --- Score-based decisions ----------------------------------------------

test("score >= 70 maps to accepted_for_feishu", () => {
  expect(decideOutcome(85, makeTestCompany())).toBe("accepted_for_feishu");
  expect(decideOutcome(70, makeTestCompany())).toBe("accepted_for_feishu");
});

test("score in 50-69 maps to local_only by default", () => {
  expect(decideOutcome(50, makeTestCompany())).toBe("local_only");
  expect(decideOutcome(69, makeTestCompany())).toBe("local_only");
});

test("score in 50-69 with weak signal maps to needs_review", () => {
  // No contacts at all is the v1 'weak signal' tripwire — score is in
  // candidate range but no human can act on it yet.
  expect(decideOutcome(65, makeTestCompany({ contacts: [] }))).toBe(
    "needs_review",
  );
});

test("score < 50 maps to local_only", () => {
  expect(decideOutcome(0, makeTestCompany())).toBe("local_only");
  expect(decideOutcome(49, makeTestCompany())).toBe("local_only");
});

// --- Decision overrides (high score must not bypass rule gates) ---------

test("excluded_by_rule overrides accepted_for_feishu even at a high score", () => {
  const input = makeTestCompany({
    excludedByRule: true,
    exclusionReason: "competitor",
  });
  expect(decideOutcome(95, input)).toBe("excluded_by_rule");
});

test("all-stale jobs override accepted_for_feishu", () => {
  const input = makeTestCompany({
    jobs: [makeJob({ freshness: "stale" })],
  });
  expect(decideOutcome(95, input)).toBe("stale");
});

test("unknown-freshness jobs do NOT trigger the stale override (per spec)", () => {
  // Spec section "新鲜度": stale ≠ unknown. `unknown` stays local until a
  // careers enricher (TB-9) promotes it; it must NOT be auto-marked stale.
  const input = makeTestCompany({
    jobs: [makeJob({ freshness: "unknown" })],
  });
  expect(decideOutcome(30, input)).toBe("local_only");
});

test("mixed freshness (one stale + one fresh) is not stale", () => {
  const input = makeTestCompany({
    jobs: [makeJob({ freshness: "stale" }), makeJob({ freshness: "fresh" })],
  });
  expect(decideOutcome(85, input)).toBe("accepted_for_feishu");
});

test("only-blocked contacts override accepted_for_feishu", () => {
  const input = makeTestCompany({
    contacts: [makeContact({ riskLevel: "blocked" })],
  });
  expect(decideOutcome(95, input)).toBe("blocked_contact");
});

test("excluded_by_rule beats stale + blocked when all three trigger", () => {
  // Override priority is documented: rule > stale > blocked. Pinned so a
  // future refactor that reorders the checks fails a test instead of
  // silently flipping the dashboard.
  const input = makeTestCompany({
    excludedByRule: true,
    exclusionReason: "competitor",
    jobs: [makeJob({ freshness: "stale" })],
    contacts: [makeContact({ riskLevel: "blocked" })],
  });
  expect(decideOutcome(95, input)).toBe("excluded_by_rule");
});

test("stale beats blocked when both trigger and the lead is not excluded", () => {
  const input = makeTestCompany({
    jobs: [makeJob({ freshness: "stale" })],
    contacts: [makeContact({ riskLevel: "blocked" })],
  });
  expect(decideOutcome(95, input)).toBe("stale");
});

// --- Overrides apply to the local_only band too (consistency check) -----

test("excluded leads stay excluded even at a low score", () => {
  const input = makeTestCompany({ excludedByRule: true });
  expect(decideOutcome(20, input)).toBe("excluded_by_rule");
});
