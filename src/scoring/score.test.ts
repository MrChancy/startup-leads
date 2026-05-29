import { test, expect } from "bun:test";
import { scoreCompany } from "./score.ts";
import { SCORER_VERSION } from "./version.ts";
import {
  makeContact,
  makeJob,
  makeTestCompany,
} from "./test-support.ts";

test("scoreCompany returns a LeadScore with all five sub-scores populated", () => {
  const result = scoreCompany(makeTestCompany());

  // I-1: every required field is present (no optional-lies).
  expect(typeof result.score).toBe("number");
  expect(typeof result.jobMatchScore).toBe("number");
  expect(typeof result.directionScore).toBe("number");
  expect(typeof result.freshnessScore).toBe("number");
  expect(typeof result.contactScore).toBe("number");
  expect(typeof result.actionabilityScore).toBe("number");
});

test("scoreCompany stamps the constant SCORER_VERSION on every result", () => {
  expect(scoreCompany(makeTestCompany()).scorerVersion).toBe(SCORER_VERSION);
  expect(scoreCompany(makeTestCompany({ jobs: [] })).scorerVersion).toBe(
    SCORER_VERSION,
  );
});

test("overall score equals the sum of the five sub-scores", () => {
  const result = scoreCompany(makeTestCompany());
  expect(result.score).toBe(
    result.jobMatchScore +
      result.directionScore +
      result.freshnessScore +
      result.contactScore +
      result.actionabilityScore,
  );
});

test("match_reason is a structured array with the four required fields per entry", () => {
  const result = scoreCompany(makeTestCompany());
  expect(Array.isArray(result.matchReason)).toBe(true);
  expect(result.matchReason.length).toBeGreaterThan(0);
  for (const entry of result.matchReason) {
    // exactly the four spec fields
    expect(Object.keys(entry).sort()).toEqual(
      ["component", "evidenceSourceId", "note", "points"].sort(),
    );
    expect(typeof entry.component).toBe("string");
    expect(typeof entry.points).toBe("number");
    expect(typeof entry.note).toBe("string");
  }
});

test("match_reason includes at least one entry per scoring component", () => {
  const components = new Set(
    scoreCompany(makeTestCompany()).matchReason.map((e) => e.component),
  );
  expect(components).toEqual(
    new Set(["job_match", "direction", "freshness", "contact", "actionability"]),
  );
});

test("sum of points across matchReason equals overall score", () => {
  const result = scoreCompany(makeTestCompany());
  const sum = result.matchReason.reduce((acc, e) => acc + e.points, 0);
  expect(sum).toBe(result.score);
});

test("a strong lead lands at accepted_for_feishu", () => {
  const input = makeTestCompany({
    directionTags: ["ai-native"],
    jobs: [makeJob({ title: "Backend Engineer", freshness: "fresh" })],
    contacts: [makeContact({ riskLevel: "low" })],
  });
  const result = scoreCompany(input);
  expect(result.score).toBeGreaterThanOrEqual(70);
  expect(result.decision).toBe("accepted_for_feishu");
});

test("a high score but all-stale jobs decides as 'stale'", () => {
  const input = makeTestCompany({
    directionTags: ["ai-native"],
    jobs: [makeJob({ title: "Backend Engineer", freshness: "stale" })],
    contacts: [makeContact({ riskLevel: "low" })],
  });
  expect(scoreCompany(input).decision).toBe("stale");
});

test("a high score but only-blocked contacts decides as 'blocked_contact'", () => {
  const input = makeTestCompany({
    directionTags: ["ai-native"],
    jobs: [makeJob({ title: "Backend Engineer", freshness: "fresh" })],
    contacts: [makeContact({ riskLevel: "blocked" })],
  });
  expect(scoreCompany(input).decision).toBe("blocked_contact");
});

test("excludedByRule wins even with a 95+ raw score", () => {
  const input = makeTestCompany({
    excludedByRule: true,
    exclusionReason: "competitor",
    directionTags: ["ai-native"],
  });
  expect(scoreCompany(input).decision).toBe("excluded_by_rule");
});

test("companyId on the input passes through to the result", () => {
  expect(scoreCompany(makeTestCompany({ companyId: 42 })).companyId).toBe(42);
});

// --- No IO surface: type-level + runtime sanity --------------------------

test("scoreCompany is a pure function (synchronous, no Promise)", () => {
  const value: unknown = scoreCompany(makeTestCompany());
  // If scoreCompany ever became async it would return a Promise, which is
  // unequal to a plain object's typeof and is detectable here.
  expect(value instanceof Promise).toBe(false);
  expect(typeof value).toBe("object");
});

test("scoreCompany accepts only the DTO (no db/fs/http params)", () => {
  // Compile-time: ScoreCompanyInput has no db / fs / fetch field. We assert
  // at runtime that adding such a field to the literal is rejected by TS via
  // its absence on the inferred parameter shape — covered by typecheck. As a
  // runtime smoke, calling with the minimal DTO succeeds:
  expect(() => scoreCompany(makeTestCompany())).not.toThrow();
});
