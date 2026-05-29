import { test, expect } from "bun:test";
import { scoreJobMatch } from "./job-match.ts";
import { makeJob, makeTestCompany } from "../test-support.ts";

test("no jobs scores 0 with an explanatory note", () => {
  const result = scoreJobMatch(makeTestCompany({ jobs: [] }));
  expect(result.points).toBe(0);
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]?.component).toBe("job_match");
  expect(result.entries[0]?.note).toMatch(/no jobs/i);
  expect(result.entries[0]?.points).toBe(0);
});

test("a single backend-engineer role hits the 35-point cap", () => {
  const result = scoreJobMatch(
    makeTestCompany({
      jobs: [makeJob({ title: "Backend Engineer" })],
    }),
  );
  expect(result.points).toBe(35);
  // points across entries must sum to the component total.
  const sum = result.entries.reduce((acc, e) => acc + e.points, 0);
  expect(sum).toBe(35);
});

test("an unrelated role scores 0", () => {
  const result = scoreJobMatch(
    makeTestCompany({
      jobs: [makeJob({ title: "Senior Sales Manager" })],
    }),
  );
  expect(result.points).toBe(0);
});

test("an AI application role partially matches", () => {
  const result = scoreJobMatch(
    makeTestCompany({
      jobs: [makeJob({ title: "AI Product Engineer" })],
    }),
  );
  expect(result.points).toBeGreaterThan(0);
  expect(result.points).toBeLessThan(35);
});

test("multiple jobs are capped at the component max", () => {
  const result = scoreJobMatch(
    makeTestCompany({
      jobs: [
        makeJob({ title: "Backend Engineer" }),
        makeJob({ title: "Staff Software Engineer" }),
        makeJob({ title: "Infrastructure Engineer" }),
      ],
    }),
  );
  expect(result.points).toBe(35);
});

test("each matching job emits its own match_reason entry with its source id", () => {
  const result = scoreJobMatch(
    makeTestCompany({
      jobs: [
        makeJob({ title: "Backend Engineer", evidenceSourceId: 11 }),
        makeJob({ title: "AI Engineer", evidenceSourceId: 22 }),
      ],
    }),
  );
  const sourceIds = result.entries.map((e) => e.evidenceSourceId);
  expect(sourceIds).toContain(11);
  expect(sourceIds).toContain(22);
});
