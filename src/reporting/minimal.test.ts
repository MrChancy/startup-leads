import { test, expect } from "bun:test";
import { formatRunReport } from "./minimal.ts";

test("formatRunReport renders the canonical one-liner", () => {
  const line = formatRunReport("abc-123", {
    candidates: 1,
    stored: 1,
    deduped: 0,
    fetchFailed: 0,
    parseFailed: 0,
  });
  expect(line).toBe(
    "Run abc-123 completed: 1 candidates, 1 stored, 0 dedupe, 0 fetch_failed, 0 parse_failed",
  );
});

test("formatRunReport handles all-zero runs", () => {
  const line = formatRunReport("empty-run", {
    candidates: 0,
    stored: 0,
    deduped: 0,
    fetchFailed: 0,
    parseFailed: 0,
  });
  expect(line).toBe(
    "Run empty-run completed: 0 candidates, 0 stored, 0 dedupe, 0 fetch_failed, 0 parse_failed",
  );
});
