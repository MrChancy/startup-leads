import { test, expect } from "bun:test";
import { scoreActionability } from "./actionability.ts";
import { makeContact, makeJob, makeTestCompany } from "../test-support.ts";

test("a fresh job plus a low-risk contact hits the 10-point cap", () => {
  const result = scoreActionability(makeTestCompany());
  expect(result.points).toBe(10);
});

test("fresh job but no contacts: half credit", () => {
  const result = scoreActionability(makeTestCompany({ contacts: [] }));
  expect(result.points).toBeGreaterThan(0);
  expect(result.points).toBeLessThan(10);
});

test("contact but no jobs: half credit", () => {
  const result = scoreActionability(makeTestCompany({ jobs: [] }));
  expect(result.points).toBeGreaterThan(0);
  expect(result.points).toBeLessThan(10);
});

test("no jobs and no contacts: 0", () => {
  const result = scoreActionability(
    makeTestCompany({ jobs: [], contacts: [] }),
  );
  expect(result.points).toBe(0);
});

test("stale job with usable contact still earns the contact half", () => {
  const result = scoreActionability(
    makeTestCompany({
      jobs: [makeJob({ freshness: "stale" })],
      contacts: [makeContact({ riskLevel: "low" })],
    }),
  );
  expect(result.points).toBeGreaterThan(0);
  expect(result.points).toBeLessThan(10);
});

test("fresh job with only-blocked contacts earns only the job half", () => {
  const result = scoreActionability(
    makeTestCompany({
      jobs: [makeJob({ freshness: "fresh" })],
      contacts: [makeContact({ riskLevel: "blocked" })],
    }),
  );
  expect(result.points).toBeGreaterThan(0);
  expect(result.points).toBeLessThan(10);
});
