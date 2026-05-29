import { test, expect } from "bun:test";
import { formatRunReport } from "./minimal.ts";

const ZERO_DECISIONS = {
  acceptedForFeishu: 0,
  localOnly: 0,
  stale: 0,
  blockedContact: 0,
  needsReview: 0,
  excludedByRule: 0,
};

test("formatRunReport renders the canonical one-liner", () => {
  const line = formatRunReport(
    "abc-123",
    { candidates: 1, stored: 1, deduped: 0, fetchFailed: 0, parseFailed: 0 },
    ZERO_DECISIONS,
  );
  expect(line).toContain(
    "Run abc-123 completed: 1 candidates, 1 stored, 0 dedupe, 0 fetch_failed, 0 parse_failed",
  );
});

test("formatRunReport handles all-zero runs", () => {
  const line = formatRunReport(
    "empty-run",
    { candidates: 0, stored: 0, deduped: 0, fetchFailed: 0, parseFailed: 0 },
    ZERO_DECISIONS,
  );
  expect(line).toContain(
    "Run empty-run completed: 0 candidates, 0 stored, 0 dedupe, 0 fetch_failed, 0 parse_failed",
  );
});

test("formatRunReport appends a decision distribution line", () => {
  // Spec / TB-2 AC: "report 输出按 decision 分布展示".
  const line = formatRunReport(
    "mixed-run",
    { candidates: 3, stored: 3, deduped: 0, fetchFailed: 0, parseFailed: 0 },
    {
      acceptedForFeishu: 1,
      localOnly: 1,
      stale: 1,
      blockedContact: 0,
      needsReview: 0,
      excludedByRule: 0,
    },
  );
  expect(line).toContain(
    "Decisions: accepted=1 local_only=1 needs_review=0 stale=1 blocked_contact=0 excluded=0",
  );
});
