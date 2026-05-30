import type {
  LeadRepository,
  ReportStats,
  RunRecord,
} from "../types/index.ts";
import type { ReportScopeArg } from "./args.ts";
import { formatFullReport } from "../reporting/full.ts";

// TB-11 result shape:
//   - found=false signals "the operator asked for a specific run id and it
//     doesn't exist" → CLI must error (I-2). All other paths return
//     found=true even when the report is empty (no runs yet, no runs in
//     window) so the CLI prints to stdout with exit 0.
export interface ReportResult {
  found: boolean;
  line: string;
}

export interface RunReportInput {
  repo: LeadRepository;
  scope: ReportScopeArg;
  // Injected so tests can pin the since-window cutoff. CLI passes
  // () => new Date().
  now: () => Date;
}

export function runReport(input: RunReportInput): ReportResult {
  const { repo, scope, now } = input;

  if (scope.kind === "run") {
    const run = repo.getRun(scope.runId);
    if (!run) {
      // I-2: an explicit `--run <id>` that doesn't exist is a hard error,
      // not "success with 0 candidates". The CLI maps `found=false` to
      // stderr + exit 1.
      return { found: false, line: `Run ${scope.runId} not found` };
    }
    return { found: true, line: renderFullReport(repo, scope, [run]) };
  }

  if (scope.kind === "latest") {
    const latest = repo.getLatestRun();
    // A fresh DB (no runs at all) is success-with-message — distinct from
    // the "--run <id>" not-found case. The renderer prints the
    // "(no runs yet — try `collect` first)" sentence.
    const runs = latest ? [latest] : [];
    return { found: true, line: renderFullReport(repo, scope, runs) };
  }

  // since-mode: convert the millisecond window into an ISO cutoff at call
  // time so test injection of `now` is the only knob; the storage layer
  // never has to know about millisecond deltas.
  const cutoffIso = new Date(now().getTime() - scope.cutoffMs).toISOString();
  const runs = repo.listRunsSince(cutoffIso);
  return {
    found: true,
    line: renderFullReport(repo, { kind: "since", cutoffMs: scope.cutoffMs }, runs, cutoffIso),
  };
}

// Helper isolated so each scope branch reads top-down without duplicating
// the stats lookup and ReportStats assembly. The `runs` argument is the
// pre-filtered set the renderer's header should describe; storage queries
// always operate on `runs.map(r => r.id)`.
function renderFullReport(
  repo: LeadRepository,
  scope: ReportScopeArg,
  runs: RunRecord[],
  cutoffIso?: string,
): string {
  const aggregate = repo.getReportStats(runs.map((r) => r.id));
  const stats: ReportStats = {
    scope:
      scope.kind === "since"
        ? { kind: "since", cutoff: cutoffIso ?? "" }
        : scope.kind === "run"
          ? { kind: "run", runId: scope.runId }
          : { kind: "latest" },
    runs,
    totalCandidates: aggregate.totalCandidates,
    totalStored: aggregate.totalStored,
    totalDeduped: aggregate.totalDeduped,
    totalFetchFailed: aggregate.totalFetchFailed,
    totalParseFailed: aggregate.totalParseFailed,
    decisions: aggregate.decisions,
    // See LeadScoreDecision comment in src/types/index.ts (line ~65): the
    // 'duplicate' decision is a TB-4 follow-up, not in the current enum.
    // Until it lands we surface 0 so the report column is structurally
    // complete and the operator can recognize it as a known-zero rather
    // than a missing column.
    duplicate: 0,
    companiesWithContact: aggregate.companiesWithContact,
    totalCompanies: aggregate.totalCompanies,
    jobsByFreshness: aggregate.jobsByFreshness,
    totalJobs: aggregate.totalJobs,
    scoreBuckets: aggregate.scoreBuckets,
    scorerVersionGroups: aggregate.scorerVersionGroups,
  };
  return formatFullReport(stats);
}
