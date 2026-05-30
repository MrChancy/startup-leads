import { test, expect } from "bun:test";
import { formatFullReport } from "./full.ts";
import type {
  DecisionCounts,
  FreshnessStatus,
  ReportStats,
  RunRecord,
  ScoreBucket,
  ScorerVersionGroup,
} from "../types/index.ts";

const ZERO_DECISIONS: DecisionCounts = {
  acceptedForFeishu: 0,
  localOnly: 0,
  stale: 0,
  blockedContact: 0,
  needsReview: 0,
  excludedByRule: 0,
};

const ZERO_FRESHNESS: Record<FreshnessStatus, number> = {
  fresh: 0,
  usable: 0,
  stale: 0,
  unknown: 0,
};

// Canonical empty-bucket scaffold so each test customizes only what matters.
function buckets(
  overrides: Partial<Record<"<50" | "50-69" | "70-84" | "85+", number>> = {},
): ScoreBucket[] {
  return [
    { label: "<50", lo: 0, hi: 49, count: overrides["<50"] ?? 0 },
    { label: "50-69", lo: 50, hi: 69, count: overrides["50-69"] ?? 0 },
    { label: "70-84", lo: 70, hi: 84, count: overrides["70-84"] ?? 0 },
    { label: "85+", lo: 85, hi: null, count: overrides["85+"] ?? 0 },
  ];
}

function run(id: string, startedAt = "2026-05-30T12:00:00.000Z"): RunRecord {
  return { id, startedAt, source: "fake", limit: 50 };
}

function baseStats(): ReportStats {
  return {
    scope: { kind: "latest" },
    runs: [run("abc-123")],
    totalCandidates: 6,
    totalStored: 5,
    totalDeduped: 0,
    totalFetchFailed: 0,
    totalParseFailed: 1,
    decisions: {
      acceptedForFeishu: 2,
      localOnly: 1,
      stale: 1,
      blockedContact: 0,
      needsReview: 1,
      excludedByRule: 0,
    },
    duplicate: 0,
    companiesWithContact: 3,
    totalCompanies: 5,
    jobsByFreshness: { fresh: 3, usable: 1, stale: 1, unknown: 1 },
    totalJobs: 6,
    scoreBuckets: buckets({ "<50": 1, "50-69": 1, "70-84": 1, "85+": 2 }),
    scorerVersionGroups: [
      {
        scorerVersion: "1.0.0",
        decisions: {
          acceptedForFeishu: 2,
          localOnly: 1,
          stale: 1,
          blockedContact: 0,
          needsReview: 1,
          excludedByRule: 0,
        },
        total: 5,
      },
    ],
  };
}

test("formatFullReport prints a latest-run header", () => {
  const out = formatFullReport(baseStats());
  expect(out).toContain("Report (latest run abc-123");
  expect(out).toContain("source=fake");
  expect(out).toContain("started=2026-05-30T12:00:00.000Z");
});

test("formatFullReport prints a single-run header with --run id", () => {
  const stats: ReportStats = {
    ...baseStats(),
    scope: { kind: "run", runId: "abc-123" },
  };
  const out = formatFullReport(stats);
  expect(out).toContain("Report (run abc-123");
});

test("formatFullReport prints a since-window header naming the cutoff and run count", () => {
  const stats: ReportStats = {
    ...baseStats(),
    scope: { kind: "since", cutoff: "2026-05-23T00:00:00.000Z" },
    runs: [run("r1"), run("r2"), run("r3")],
  };
  const out = formatFullReport(stats);
  expect(out).toContain("Report (since 2026-05-23T00:00:00.000Z");
  expect(out).toContain("Aggregating 3 runs since 2026-05-23T00:00:00.000Z");
});

test("formatFullReport pipeline line covers candidate/stored/dedupe/failed split", () => {
  const out = formatFullReport(baseStats());
  // Failure split is "fetch=X parse=Y" so the operator can see which channel
  // owns the failures without scanning two separate lines.
  expect(out).toContain(
    "Pipeline:    6 candidates, 5 stored, 0 deduped, 1 failed (fetch=0 parse=1)",
  );
});

test("formatFullReport decisions line includes accepted/local_only/needs_review/stale/blocked/excluded/duplicate", () => {
  const out = formatFullReport(baseStats());
  expect(out).toContain(
    "Decisions:   accepted=2 local_only=1 needs_review=1 stale=1 blocked=0 excluded=0 duplicate=0",
  );
});

test("formatFullReport coverage line shows contact ratio with percentage", () => {
  const out = formatFullReport(baseStats());
  expect(out).toContain(
    "Coverage:    3/5 companies with >=1 contact (60.0%)",
  );
});

test("formatFullReport freshness line lists each band with percent over total jobs", () => {
  const out = formatFullReport(baseStats());
  // Spec calls out unknown-freshness ratio specifically. 1 of 6 jobs is unknown
  // → 16.7%; we surface every band so the operator can pick the comparison.
  expect(out).toContain("Freshness:");
  expect(out).toContain("fresh=3 (50.0%)");
  expect(out).toContain("usable=1 (16.7%)");
  expect(out).toContain("unknown=1 (16.7%)");
  expect(out).toContain("stale=1 (16.7%)");
  expect(out).toContain("total jobs=6");
});

test("formatFullReport score distribution shows ASCII bars with one # per company by default", () => {
  const out = formatFullReport(baseStats());
  expect(out).toContain("Score distribution:");
  // 85+ has count 2 → ## (one bar per company when max <= 40).
  expect(out).toMatch(/85\+\s+2 ##/);
  expect(out).toMatch(/70-84\s+1 #/);
  expect(out).toMatch(/50-69\s+1 #/);
  expect(out).toMatch(/<50\s+1 #/);
});

test("formatFullReport scales bar units when a bucket exceeds 40", () => {
  // Bars: 1 unit per ceil(maxCount/40) companies — so a 50-tall bucket
  // becomes 25 chars when scaled by 2, never wider than 40.
  const stats: ReportStats = {
    ...baseStats(),
    scoreBuckets: buckets({ "<50": 50, "85+": 10 }),
  };
  const out = formatFullReport(stats);
  // 50 / ceil(50/40)=2 = 25 chars; 10 / 2 = 5 chars
  const less50Line = out.split("\n").find((l) => l.trim().startsWith("<50"));
  const plus85Line = out.split("\n").find((l) => l.trim().startsWith("85+"));
  // \b doesn't match between '#' and end-of-line ('#' is non-word), so we
  // assert the exact bar with a $-anchor instead.
  expect(less50Line).toMatch(/<50\s+50 #{25}$/);
  expect(plus85Line).toMatch(/85\+\s+10 #{5}$/);
  // Documented scale annotation so the reader knows units != companies.
  expect(out).toContain("(scale: 1 # = 2 companies)");
});

test("formatFullReport prints one scorer-version line per group", () => {
  const groups: ScorerVersionGroup[] = [
    {
      scorerVersion: "1.0.0",
      decisions: { ...ZERO_DECISIONS, acceptedForFeishu: 1, localOnly: 1, stale: 2 },
      total: 4,
    },
    {
      scorerVersion: "1.1.0",
      decisions: { ...ZERO_DECISIONS, acceptedForFeishu: 1 },
      total: 1,
    },
  ];
  const stats: ReportStats = { ...baseStats(), scorerVersionGroups: groups };
  const out = formatFullReport(stats);
  expect(out).toContain(
    "Scorer 1.0.0: accepted=1 local_only=1 needs_review=0 stale=2 blocked=0 excluded=0 (4 total)",
  );
  expect(out).toContain(
    "Scorer 1.1.0: accepted=1 local_only=0 needs_review=0 stale=0 blocked=0 excluded=0 (1 total)",
  );
});

test("formatFullReport renders N/A instead of NaN% when ratios divide by zero", () => {
  const stats: ReportStats = {
    ...baseStats(),
    companiesWithContact: 0,
    totalCompanies: 0,
    jobsByFreshness: { ...ZERO_FRESHNESS },
    totalJobs: 0,
  };
  const out = formatFullReport(stats);
  expect(out).toContain("Coverage:    0/0 companies with >=1 contact (N/A)");
  expect(out).not.toContain("NaN");
  expect(out).toContain("fresh=0 (N/A)");
  expect(out).toContain("total jobs=0");
});

test("formatFullReport surfaces the 'no runs yet' message when runs is empty (latest scope)", () => {
  const stats: ReportStats = {
    ...baseStats(),
    scope: { kind: "latest" },
    runs: [],
    totalCandidates: 0,
    totalStored: 0,
    totalDeduped: 0,
    totalFetchFailed: 0,
    totalParseFailed: 0,
    decisions: { ...ZERO_DECISIONS },
    duplicate: 0,
    companiesWithContact: 0,
    totalCompanies: 0,
    jobsByFreshness: { ...ZERO_FRESHNESS },
    totalJobs: 0,
    scoreBuckets: buckets(),
    scorerVersionGroups: [],
  };
  const out = formatFullReport(stats);
  // Distinct from "no runs in window" — different actionable advice.
  expect(out).toContain("(no runs yet — try `collect` first)");
});

test("formatFullReport surfaces 'no runs in window' for since scope with zero runs", () => {
  const stats: ReportStats = {
    ...baseStats(),
    scope: { kind: "since", cutoff: "2026-05-23T00:00:00.000Z" },
    runs: [],
    totalCandidates: 0,
    totalStored: 0,
    totalDeduped: 0,
    totalFetchFailed: 0,
    totalParseFailed: 0,
    decisions: { ...ZERO_DECISIONS },
    duplicate: 0,
    companiesWithContact: 0,
    totalCompanies: 0,
    jobsByFreshness: { ...ZERO_FRESHNESS },
    totalJobs: 0,
    scoreBuckets: buckets(),
    scorerVersionGroups: [],
  };
  const out = formatFullReport(stats);
  expect(out).toContain("(no runs in window)");
});

// Boundary sweep for score buckets: hand the renderer counts that already
// reflect a 49/50/69/70/84/85 partition to lock down the labels. The
// repository test pins the actual SQL boundary logic; this only verifies
// the renderer trusts the bucket struct it's given.
test("formatFullReport renders all four bucket labels exactly as <50 / 50-69 / 70-84 / 85+", () => {
  const out = formatFullReport(baseStats());
  // Each label appears as its own column entry (label then whitespace then count).
  expect(out).toMatch(/^\s*<50\s+\d/m);
  expect(out).toMatch(/^\s*50-69\s+\d/m);
  expect(out).toMatch(/^\s*70-84\s+\d/m);
  expect(out).toMatch(/^\s*85\+\s+\d/m);
});
