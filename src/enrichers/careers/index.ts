// Careers-page enricher. Walks every job currently at freshness=`unknown`,
// probes the company's official site for a careers page, and — if the page
// mentions the same normalized title — upgrades freshness to `usable` and
// re-scores the company.
//
// Invariants pinned by index.test.ts:
//   * Synthetic `hn:` domains are skipped silently (issue #25): there is no
//     real URL to probe.
//   * Stronger freshness (fresh / usable) is never demoted. The SQL UPDATE
//     in upgradeJobFreshness only fires when the row is still `unknown`.
//   * No contacts are ever created. The enricher reads pages, never writes
//     to the contacts table — even when the page leaks an email.
//   * Each company's probe + writes + re-score live in one withTransaction
//     so a partial failure rolls back cleanly (CLAUDE.local.md S-2).
//   * On HTTP failure we record a sources row (fetch_status=failed) but the
//     company itself is not marked failed.

import type { HttpClient } from "../../http/index.ts";
import { scoreCompany } from "../../scoring/score.ts";
import type { LeadRepository } from "../../types/index.ts";
import { matchTitlesInPage } from "./match.ts";
import { probeCareersPaths } from "./probe.ts";

export interface EnrichCareersInput {
  repo: LeadRepository;
  http: HttpClient;
  // `confirm: false` is a dry-run that probes nothing and writes nothing —
  // it just reports what WOULD happen. UX-aligned with `purge` (--yes).
  confirm: boolean;
  // Injected clock so tests pin re-score freshness math (the scorer takes a
  // Date in its input).
  now: () => Date;
}

export interface EnrichCareersResult {
  // Companies considered for enrichment (any company with ≥ 1 unknown job).
  companiesEligible: number;
  // Subset of `companiesEligible` we actually probed (skipping hn: domains).
  // In dry-run this is 0 and `companiesToProbe` holds the would-be count.
  companiesProbed: number;
  // Dry-run equivalent of `companiesProbed`. In confirm mode this equals
  // `companiesProbed`; we keep both fields so CLI output is one-shape for
  // both modes (CLAUDE.local.md A-3: missing vs explicit).
  companiesToProbe: number;
  // Companies with no probeable domain (every domain is hn:<hash>).
  skippedNoHttpDomain: number;
  // Pages where probe returned 200 and at least one title matched.
  pagesMatched: number;
  // Pages where probe returned 200 but no DB-stored title appeared.
  pagesNoMatch: number;
  // Companies where every probe attempt failed (HttpRetryExhaustedError or
  // similar). One row per company; the per-path failures are aggregated.
  fetchFailed: number;
  // How many jobs were actually upgraded from unknown → usable. May be > the
  // page count when one page matches multiple normalized titles on the same
  // company.
  upgraded: number;
  // Companies where processCompany threw an unexpected error after passing
  // the domain-skip gate. Each one becomes a stderr line; the runs row's
  // final status is 'partial' when this is > 0. pr-review C2/H4.
  companyErrors: number;
  // Per-company outcomes for CLI listing (dry-run prints these so the user
  // sees exactly which domains will be probed before --yes).
  plan: Array<{ companyId: number; domain: string }>;
}

// Stable source tag for the enrichment run row. Lets a future report path
// filter `runs.source = 'enrich:careers'` if it cares about which kind of
// run produced a given lead_scores row.
export const ENRICH_CAREERS_SOURCE = "enrich:careers";

export async function runEnrichCareers(
  input: EnrichCareersInput,
): Promise<EnrichCareersResult & { runId: string | null }> {
  const { repo, http, confirm, now } = input;

  const unknownJobs = repo.listJobsWithFreshness("unknown");
  // Group jobs by company so each company's probe runs once. The Map
  // preserves insertion order, which keeps CLI output reproducible across
  // runs and across in-memory vs file DBs.
  const byCompany = new Map<number, typeof unknownJobs>();
  for (const job of unknownJobs) {
    const existing = byCompany.get(job.companyId);
    if (existing) {
      existing.push(job);
    } else {
      byCompany.set(job.companyId, [job]);
    }
  }

  const result: EnrichCareersResult = {
    companiesEligible: byCompany.size,
    companiesProbed: 0,
    companiesToProbe: 0,
    skippedNoHttpDomain: 0,
    pagesMatched: 0,
    pagesNoMatch: 0,
    fetchFailed: 0,
    upgraded: 0,
    companyErrors: 0,
    plan: [],
  };

  // We only need a runs row when we're actually going to write — dry-run
  // produces no audit, so no run row either. `limit: 0` is honest: we don't
  // bound enrichment by a numeric limit, we enrich every eligible company.
  // The runs row is finished in the same call so a crash mid-loop still
  // leaves the row in `partial` status for inspection.
  const enrichRun = confirm
    ? repo.startRun({ source: ENRICH_CAREERS_SOURCE, limit: 0 })
    : null;

  for (const [companyId, jobs] of byCompany) {
    const domain = repo.getPrimaryHttpDomain(companyId);
    if (!domain) {
      // Every domain is hn:<hash> or there's no domain at all. No URL to
      // probe — not a failure, just a silent skip.
      result.skippedNoHttpDomain++;
      continue;
    }
    result.companiesToProbe++;
    result.plan.push({ companyId, domain });

    if (!confirm) {
      // Dry-run: don't touch the network or DB.
      continue;
    }

    // pr-review C2/H4: per-company try/catch so one company's unexpected
    // throw (matchTitlesInPage on huge body, repo edge case, etc.) doesn't
    // abort the run or leave the runs row dangling at status='partial'.
    try {
      await processCompany({
        repo,
        http,
        now,
        companyId,
        domain,
        jobs,
        result,
        runId: enrichRun!.id,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `enrich: company #${companyId} failed — ${msg}\n`,
      );
      result.companyErrors++;
    }
  }

  if (enrichRun) {
    repo.finishRun(
      enrichRun.id,
      result.companyErrors > 0 ? "partial" : "completed",
    );
  }
  return { ...result, runId: enrichRun?.id ?? null };
}

interface ProcessCompanyArgs {
  repo: LeadRepository;
  http: HttpClient;
  now: () => Date;
  companyId: number;
  domain: string;
  jobs: ReadonlyArray<{ jobId: number; normalizedTitle: string }>;
  result: EnrichCareersResult;
  runId: string;
}

async function processCompany(args: ProcessCompanyArgs): Promise<void> {
  const { repo, http, now, companyId, domain, jobs, result, runId } = args;
  result.companiesProbed++;

  // Probe happens OUTSIDE the transaction: real HTTP can take seconds, and
  // holding a SQLite tx for that long would block every other write on the
  // DB. The actual `record source` + `upgrade jobs` + `re-score` writes are
  // tiny and DO go in one tx (S-2 延伸).
  const probe = await probeCareersPaths(http, domain);

  if (probe.kind === "not_found") {
    // No page found and no probe errored — there's no signal worth
    // persisting. We deliberately skip writing a "miss" sources row so we
    // don't bloat the table with one row per company per run.
    return;
  }

  if (probe.kind === "error") {
    result.fetchFailed++;
    const errorCode = errorCodeOf(probe.error);
    repo.withTransaction(() => {
      repo.recordCareersSource({
        url: probe.url,
        fetchStatus: "failed",
        errorCode,
        errorMessage: probe.error.message,
      });
    });
    return;
  }

  // probe.kind === "found": got a 2xx page, decide if any title matches.
  const dbTitles = jobs.map((j) => j.normalizedTitle);
  const matches = matchTitlesInPage(probe.body, dbTitles);

  repo.withTransaction(() => {
    if (matches.length === 0) {
      result.pagesNoMatch++;
      // pr-review H3: every `enrich careers --yes` against the same
      // no_match company appends another sources row. That's intentional
      // — it lets `report` track "we tried again and still saw nothing
      // new" — and bloat is bounded by TB-12 `purge --older-than`. If
      // unbounded growth ever becomes a real problem, add a content_hash
      // dedup on the careers HTML before insert.
      repo.recordCareersSource({
        url: probe.url,
        fetchStatus: "success",
        parseStatus: "no_match",
      });
      return;
    }

    result.pagesMatched++;
    const sourceId = repo.recordCareersSource({
      url: probe.url,
      fetchStatus: "success",
      parseStatus: "matched",
    });

    const matchedTitles = new Set(matches.map((m) => m.normalizedTitle));
    let upgradedThisCompany = 0;
    for (const job of jobs) {
      if (!matchedTitles.has(job.normalizedTitle)) continue;
      const changed = repo.upgradeJobFreshness(job.jobId, "usable", sourceId);
      if (changed) {
        result.upgraded++;
        upgradedThisCompany++;
      }
    }

    // pr-review C3: skip the re-score row if a concurrent run / earlier
    // enrich pass already advanced every matched job past `unknown`. The
    // source row above still records that we successfully matched; only
    // the lead_scores audit row is gated, because writing it with no
    // actual change would attribute a stale decision to the enrich run.
    if (upgradedThisCompany === 0) return;

    // Re-score uses the same scoreCompany pure function the collect path
    // uses, so any future scorer change is reflected here without a second
    // implementation drifting. The new row is appended (we never UPDATE
    // existing lead_scores); audit history survives.
    //
    // pr-review C1: scoreInput.excludedByRule is read live from the DB
    // companies row, intentionally divergent from collect.ts which still
    // hardcodes false until TB-4's exclusion-rule write path lands.
    // Enrich is the first re-score path so it gets the live value first.
    const scoreInput = repo.getCompanyScoreInput(companyId, now());
    const newScore = scoreCompany({
      companyId: scoreInput.companyId,
      directionTags: scoreInput.directionTags,
      jobs: scoreInput.jobs,
      contacts: scoreInput.contacts,
      excludedByRule: scoreInput.excludedByRule,
      exclusionReason: scoreInput.exclusionReason,
      primarySourceId: scoreInput.primarySourceId,
      now: scoreInput.now,
    });
    repo.writeLeadScore({
      companyId: newScore.companyId,
      // Tagged with the enrichment-run id so `report --run <id>` can
      // surface the freshness change distinctly from a collect-run. The
      // row is APPENDED (never an UPDATE) — audit history per spec.
      runId,
      score: newScore.score,
      jobMatchScore: newScore.jobMatchScore,
      directionScore: newScore.directionScore,
      freshnessScore: newScore.freshnessScore,
      contactScore: newScore.contactScore,
      actionabilityScore: newScore.actionabilityScore,
      matchReason: newScore.matchReason,
      decision: newScore.decision,
      scorerVersion: newScore.scorerVersion,
    });
  });
}

function errorCodeOf(err: Error): string {
  switch (err.name) {
    case "HttpRetryExhaustedError":
      return "retry_exhausted";
    case "HttpTimeoutError":
      return "timeout";
    case "HttpError":
      return "http_error";
    default:
      return "unknown";
  }
}

// One-line plan formatter for the CLI. Kept here so any extension to the
// EnrichCareersResult shape can update both producers and consumer in one
// edit.
export function formatEnrichResult(
  result: EnrichCareersResult & { runId?: string | null },
  confirmed: boolean,
): string {
  const header = confirmed
    ? "Careers enrichment:"
    : "Careers enrichment plan (dry-run; pass --yes to probe):";
  const lines = [
    header,
    `  companies eligible        : ${result.companiesEligible}`,
    `  companies to probe        : ${result.companiesToProbe}`,
    `  skipped (no http domain)  : ${result.skippedNoHttpDomain}`,
  ];
  if (confirmed) {
    lines.push(
      `  pages matched             : ${result.pagesMatched}`,
      `  pages no_match            : ${result.pagesNoMatch}`,
      `  fetch_failed              : ${result.fetchFailed}`,
      `  jobs upgraded to usable   : ${result.upgraded}`,
      `  company errors            : ${result.companyErrors}`,
    );
    if (result.runId) {
      // pr-review H1: print the enrich run id so the operator can call
      // `report --run <id>` and see the new decisions attributed to it.
      lines.push(`  run id                    : ${result.runId}`);
    }
  }
  if (result.plan.length > 0) {
    lines.push("", confirmed ? "Probed:" : "Would probe:");
    for (const entry of result.plan) {
      lines.push(`  - company #${entry.companyId} via ${entry.domain}`);
    }
  }
  return lines.join("\n");
}
