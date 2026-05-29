import { test, expect } from "bun:test";
import { loadFixture } from "./test-support.ts";
import { matchTitlesInPage, normalizeForMatch } from "./match.ts";

test("matchTitlesInPage finds a normalized title verbatim in prose", () => {
  const page = "<p>We're hiring a Backend Engineer to own services.</p>";
  const result = matchTitlesInPage(page, ["backend engineer"]);
  expect(result.map((r) => r.normalizedTitle)).toEqual(["backend engineer"]);
});

test("matchTitlesInPage normalizes whitespace / casing on both sides", () => {
  // The fixture uses multiple whitespace + uppercase. Both must fold to a
  // single-space lower-case form before we compare.
  const page = loadFixture("careers-list-format.html");
  const result = matchTitlesInPage(page, [
    "senior backend engineer",
    "staff machine learning engineer",
  ]);
  expect(new Set(result.map((r) => r.normalizedTitle))).toEqual(
    new Set(["senior backend engineer", "staff machine learning engineer"]),
  );
});

test("matchTitlesInPage returns empty array when no title matches", () => {
  const page = loadFixture("careers-no-match.html");
  const result = matchTitlesInPage(page, ["backend engineer", "frontend engineer"]);
  expect(result).toEqual([]);
});

test("matchTitlesInPage deduplicates titles that match more than once", () => {
  const page = "Backend Engineer (Remote). Backend Engineer (Onsite).";
  const result = matchTitlesInPage(page, ["backend engineer"]);
  expect(result).toHaveLength(1);
  expect(result[0]?.normalizedTitle).toBe("backend engineer");
});

test("matchTitlesInPage ignores empty / whitespace titles in the DB list", () => {
  const page = "Backend Engineer";
  // An empty normalized title would match every page if we naively did
  // substring; the fixture's job table will sometimes carry one (legacy data),
  // so the matcher must filter those out.
  const result = matchTitlesInPage(page, ["", "   ", "backend engineer"]);
  expect(result.map((r) => r.normalizedTitle)).toEqual(["backend engineer"]);
});

test("normalizeForMatch strips HTML tags before folding whitespace", () => {
  // We strip tags so anchor text like "<a>Backend Engineer</a>" matches the
  // DB-stored "backend engineer". HTML entities (e.g. &amp;) get decoded.
  const out = normalizeForMatch("<a>Backend &amp; Data</a> Engineer");
  expect(out).toBe("backend & data engineer");
});
