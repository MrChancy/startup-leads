import { test, expect } from "bun:test";
import { scoreFreshness } from "./freshness.ts";
import { makeJob, makeTestCompany } from "../test-support.ts";

test("no jobs scores 0", () => {
  const result = scoreFreshness(makeTestCompany({ jobs: [] }));
  expect(result.points).toBe(0);
  expect(result.entries[0]?.note).toMatch(/no jobs/i);
});

test("all-fresh jobs hit the 15-point cap", () => {
  const result = scoreFreshness(
    makeTestCompany({ jobs: [makeJob({ freshness: "fresh" })] }),
  );
  expect(result.points).toBe(15);
});

test("usable freshness gets partial credit", () => {
  const result = scoreFreshness(
    makeTestCompany({ jobs: [makeJob({ freshness: "usable" })] }),
  );
  expect(result.points).toBeGreaterThan(0);
  expect(result.points).toBeLessThan(15);
});

test("stale jobs score 0", () => {
  const result = scoreFreshness(
    makeTestCompany({ jobs: [makeJob({ freshness: "stale" })] }),
  );
  expect(result.points).toBe(0);
});

test("unknown freshness scores 0 but is not the same as stale (different note)", () => {
  const result = scoreFreshness(
    makeTestCompany({ jobs: [makeJob({ freshness: "unknown" })] }),
  );
  expect(result.points).toBe(0);
  expect(result.entries[0]?.note).toMatch(/unknown/i);
});

test("freshest job wins when multiple are present", () => {
  const result = scoreFreshness(
    makeTestCompany({
      jobs: [
        makeJob({ freshness: "stale" }),
        makeJob({ freshness: "fresh" }),
      ],
    }),
  );
  expect(result.points).toBe(15);
});
