import type {
  DecisionCounts,
  FreshnessStatus,
  ReportScope,
  ReportStats,
  RunRecord,
  ScoreBucket,
  ScorerVersionGroup,
} from "../types/index.ts";

// TB-11 full report renderer. Pure: in goes a ReportStats, out comes the
// multi-line string. All counting / SQL lives upstream (CLI + repository);
// this file only formats.
//
// Ordering decisions:
//   - "fresh" appears first in the freshness line so the most-recent band is
//     on the left (mirrors the spec's narrative order).
//   - Score buckets render top-down (85+ → <50) so the high-quality leads
//     are visually highest, matching how an operator scans a leaderboard.
//   - scorer_version groups print in the order the repo returns them
//     (oldest version first; see getReportStats SQL).
//
// Bar scaling: one `#` per company while maxCount <= 40, then each `#`
// represents `ceil(maxCount/40)` companies. We pin the upper bound at 40
// chars so terminals under ~80 wide never wrap mid-bar; the annotation line
// makes the scale explicit. Spec leaves this to renderer discretion so the
// rule lives next to the code that implements it.
//
// N/A rule: any ratio whose denominator is zero renders as `N/A` rather
// than `NaN%`. This keeps "no data yet" visually distinct from "0% coverage"
// (which is a meaningful signal — companies exist but none have contacts).
const BAR_MAX_WIDTH = 40;

const FRESHNESS_ORDER: readonly FreshnessStatus[] = [
  "fresh",
  "usable",
  "unknown",
  "stale",
];

export function formatFullReport(stats: ReportStats): string {
  const lines: string[] = [];
  lines.push(renderHeader(stats.scope, stats.runs));

  // The empty-runs branches own ALL the rendering after the header, because
  // every following section's semantics ("60.0% coverage") would mislead at
  // total=0. See I-2: zero records ≠ unknown records; we surface a clearly
  // distinct sentence per scope.
  if (stats.runs.length === 0) {
    if (stats.scope.kind === "since") {
      lines.push("(no runs in window)");
    } else {
      // latest / run scopes both reach here only when the DB has zero runs
      // at all; the CLI catches the explicit `--run <id>` not-found case
      // before calling the renderer (I-2 — error vs success-with-zero).
      lines.push("(no runs yet — try `collect` first)");
    }
    return lines.join("\n");
  }

  // Since-scope adds an aggregation line so the operator can tell at a
  // glance how many runs contributed without grepping the run list.
  if (stats.scope.kind === "since") {
    lines.push(
      `Aggregating ${stats.runs.length} run${stats.runs.length === 1 ? "" : "s"} since ${stats.scope.cutoff}`,
    );
  }

  lines.push("");
  lines.push(
    `Pipeline:    ${stats.totalCandidates} candidates, ` +
      `${stats.totalStored} stored, ` +
      `${stats.totalDeduped} deduped, ` +
      `${stats.totalFetchFailed + stats.totalParseFailed} failed ` +
      `(fetch=${stats.totalFetchFailed} parse=${stats.totalParseFailed})`,
  );
  lines.push(renderDecisionsLine(stats.decisions, stats.duplicate));
  lines.push(renderCoverageLine(stats));
  lines.push(renderFreshnessLine(stats));
  lines.push("");
  lines.push("Score distribution:");
  lines.push(...renderScoreBuckets(stats.scoreBuckets));
  lines.push("");
  for (const group of stats.scorerVersionGroups) {
    lines.push(renderScorerVersionGroup(group));
  }
  return lines.join("\n");
}

function renderHeader(scope: ReportScope, runs: readonly RunRecord[]): string {
  // "latest" with at least one run pins the single run's metadata in the
  // header so operators see the same context as the legacy minimal report.
  // "run" mode is identical to "latest" structurally but keyed by user
  // intent — important when the latest run isn't the one being inspected.
  // "since" mode points at the window cutoff because the report aggregates
  // across N runs; embedding a single run's metadata would mislead.
  if (scope.kind === "since") {
    return `Report (since ${scope.cutoff}, ${runs.length} run${runs.length === 1 ? "" : "s"})`;
  }
  const head = scope.kind === "run" ? "run" : "latest run";
  const target = runs[0];
  if (!target) {
    // Empty-runs path: header still names the scope so the operator's eye
    // lands on something familiar before the "(no runs ...)" sentence.
    return scope.kind === "run"
      ? `Report (run ${scope.runId})`
      : "Report (latest run)";
  }
  return `Report (${head} ${target.id}, source=${target.source}, started=${target.startedAt})`;
}

function renderDecisionsLine(
  d: DecisionCounts,
  duplicate: number,
): string {
  // Order matches the minimal report's order so users with both reports
  // open don't have to re-learn the column layout. `duplicate` is appended
  // last because the enum doesn't carry it yet (TB-4 follow-up); appending
  // keeps the column position stable when the enum eventually lands.
  return (
    `Decisions:   accepted=${d.acceptedForFeishu} ` +
    `local_only=${d.localOnly} ` +
    `needs_review=${d.needsReview} ` +
    `stale=${d.stale} ` +
    `blocked=${d.blockedContact} ` +
    `excluded=${d.excludedByRule} ` +
    `duplicate=${duplicate}`
  );
}

function renderCoverageLine(stats: ReportStats): string {
  return (
    `Coverage:    ${stats.companiesWithContact}/${stats.totalCompanies} ` +
    `companies with >=1 contact ` +
    `(${formatRatio(stats.companiesWithContact, stats.totalCompanies)})`
  );
}

function renderFreshnessLine(stats: ReportStats): string {
  const parts: string[] = [];
  for (const band of FRESHNESS_ORDER) {
    const count = stats.jobsByFreshness[band];
    parts.push(`${band}=${count} (${formatRatio(count, stats.totalJobs)})`);
  }
  return `Freshness:   ${parts.join("  ")}  [total jobs=${stats.totalJobs}]`;
}

function renderScoreBuckets(buckets: readonly ScoreBucket[]): string[] {
  // High-to-low visual order: the highest-scoring bucket is on top so the
  // operator's eye starts where the action is. Source order is low-to-high
  // (matches the [<50, 50-69, 70-84, 85+] enum), so reverse here.
  const ordered = [...buckets].reverse();
  const maxCount = ordered.reduce((m, b) => Math.max(m, b.count), 0);
  // Scale = how many companies each `#` represents. Pin to a minimum of 1
  // so a max <= BAR_MAX_WIDTH renders one bar per company.
  const scale = maxCount <= BAR_MAX_WIDTH ? 1 : Math.ceil(maxCount / BAR_MAX_WIDTH);
  // Pad the label column so bars start at the same x for every row.
  const labelWidth = Math.max(...ordered.map((b) => b.label.length));
  const countWidth = Math.max(
    1,
    ...ordered.map((b) => String(b.count).length),
  );
  const lines: string[] = [];
  for (const bucket of ordered) {
    const bar = "#".repeat(Math.floor(bucket.count / scale));
    lines.push(
      `   ${bucket.label.padEnd(labelWidth)} ${String(bucket.count).padStart(countWidth)} ${bar}`,
    );
  }
  if (scale > 1) {
    lines.push(`   (scale: 1 # = ${scale} companies)`);
  }
  return lines;
}

function renderScorerVersionGroup(group: ScorerVersionGroup): string {
  const d = group.decisions;
  return (
    `Scorer ${group.scorerVersion}: ` +
    `accepted=${d.acceptedForFeishu} ` +
    `local_only=${d.localOnly} ` +
    `needs_review=${d.needsReview} ` +
    `stale=${d.stale} ` +
    `blocked=${d.blockedContact} ` +
    `excluded=${d.excludedByRule} ` +
    `(${group.total} total)`
  );
}

function formatRatio(numerator: number, denominator: number): string {
  if (denominator === 0) return "N/A";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}
