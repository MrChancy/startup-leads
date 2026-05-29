import { test, expect } from "bun:test";
import { scoreDirection } from "./direction.ts";
import { makeTestCompany } from "../test-support.ts";

test("no direction tags scores 0 with a note", () => {
  const result = scoreDirection(makeTestCompany({ directionTags: [] }));
  expect(result.points).toBe(0);
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]?.note).toMatch(/no direction tags/i);
});

test("a single high-signal tag (ai-native) hits the cap", () => {
  const result = scoreDirection(
    makeTestCompany({ directionTags: ["ai-native"] }),
  );
  expect(result.points).toBe(25);
});

test("a single secondary tag scores partial", () => {
  const result = scoreDirection(
    makeTestCompany({ directionTags: ["remote-friendly"] }),
  );
  expect(result.points).toBeGreaterThan(0);
  expect(result.points).toBeLessThan(25);
});

test("multiple tags stack up to the cap", () => {
  const result = scoreDirection(
    makeTestCompany({
      directionTags: ["backend", "devtools", "remote-friendly", "china-timezone"],
    }),
  );
  expect(result.points).toBe(25);
  const sum = result.entries.reduce((acc, e) => acc + e.points, 0);
  expect(sum).toBe(25);
});

test("unknown tags are ignored and recorded with a warning note", () => {
  const result = scoreDirection(
    makeTestCompany({ directionTags: ["ai-native", "made-up-tag"] }),
  );
  expect(result.points).toBe(25); // ai-native alone covers the cap
  const unknownEntry = result.entries.find((e) =>
    e.note.includes("made-up-tag"),
  );
  expect(unknownEntry?.points).toBe(0);
  expect(unknownEntry?.note).toMatch(/ignored unknown tag/i);
});

test("only-unknown tags scores 0", () => {
  const result = scoreDirection(
    makeTestCompany({ directionTags: ["nope", "also-nope"] }),
  );
  expect(result.points).toBe(0);
});
