#!/usr/bin/env bun
import { parseArgs, HELP_TEXT } from "./args.ts";
import { runCollect } from "./collect.ts";
import { runReport } from "./report.ts";
import { formatPurgeResult, runPurge } from "./purge.ts";
import { fakeCollector } from "../collectors/fake.ts";
import { hnCollector, HN_SOURCE } from "../collectors/hn/index.ts";
import { openLeadRepository } from "../storage/index.ts";
import { formatRunReport } from "../reporting/minimal.ts";
import { getDatabasePath } from "../config/index.ts";
import { createHttpClient } from "../http/index.ts";
import {
  formatEnrichResult,
  runEnrichCareers,
} from "../enrichers/careers/index.ts";
import {
  formatEnrichGithubResult,
  runEnrichGithub,
} from "../enrichers/github/index.ts";
import { buildPushCandidates } from "../feishu/query.ts";
import { mapToFeishuPayload } from "../feishu/mapper.ts";
import { formatDryRun } from "../feishu/dry-run.ts";
import { runExportCsv } from "../exporters/csv/export.ts";
import type { Collector } from "../collectors/types.ts";

const COLLECTORS: Record<string, Collector> = {
  fake: fakeCollector,
  [HN_SOURCE]: hnCollector,
};

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.kind === "help") {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  if (parsed.kind === "error") {
    process.stderr.write(parsed.message + "\n\n" + HELP_TEXT);
    process.exit(1);
  }

  const { repo, close } = openLeadRepository(getDatabasePath());

  try {
    if (parsed.kind === "collect") {
      const collector = COLLECTORS[parsed.source];
      if (!collector) {
        process.stderr.write(`Unknown source: ${parsed.source}\n`);
        process.exit(1);
      }
      const { runId, counts, decisions } = await runCollect({
        repo,
        collector,
        limit: parsed.limit,
      });
      process.stdout.write(formatRunReport(runId, counts, decisions) + "\n");
      return;
    }

    if (parsed.kind === "report") {
      const result = runReport({
        repo,
        scope: parsed.scope,
        now: () => new Date(),
      });
      if (!result.found) {
        // I-2: only --run <missing-id> reaches found=false. Latest /
        // since-mode with no runs is a success with a friendly message.
        process.stderr.write(result.line + "\n");
        close();
        process.exit(1);
      }
      process.stdout.write(result.line + "\n");
      return;
    }

    if (parsed.kind === "purge") {
      const result = runPurge({
        repo,
        mode: parsed.mode,
        confirm: parsed.confirm,
      });
      process.stdout.write(formatPurgeResult(result) + "\n");
      return;
    }

    if (parsed.kind === "enrich") {
      // Production wiring: real HttpClient (rate-limited by QPS env var) and
      // wall-clock now. Tests drive runEnrich* directly with fakes.
      const http = createHttpClient();
      if (parsed.target === "careers") {
        const result = await runEnrichCareers({
          repo,
          http,
          confirm: parsed.confirm,
          now: () => new Date(),
        });
        process.stdout.write(formatEnrichResult(result, parsed.confirm) + "\n");
        return;
      }
      // target === "github": forward GITHUB_TOKEN from the real env so the
      // enricher can lift the 60 req/h unauth quota when the operator
      // supplies a PAT.
      const result = await runEnrichGithub({
        repo,
        http,
        confirm: parsed.confirm,
        now: () => new Date(),
        env: process.env,
      });
      process.stdout.write(
        formatEnrichGithubResult(result, parsed.confirm) + "\n",
      );
      return;
    }

    if (parsed.kind === "export") {
      // TB-5: --stdout streams directly to the user's pipe; otherwise we
      // mint a fresh file under data/exports/. Wall-clock `now` keeps the
      // default file name unique per second.
      if (parsed.stdout) {
        runExportCsv({ repo, out: process.stdout, now: () => new Date() });
      } else {
        const result = runExportCsv({ repo, now: () => new Date() });
        // One-line confirmation so the operator knows where the file went;
        // mirrors the "wrote X" feedback other commands give.
        process.stdout.write(`Wrote ${result.path}\n`);
      }
      return;
    }

    if (parsed.kind === "push-feishu") {
      // v1: dry-run only. parseArgs already rejects the non-dry-run path,
      // so we never reach here without parsed.dryRun === true. We DELIBERATELY
      // do not construct LarkCliFeishuClient (TB-7) or write push_events
      // (TB-8) — dry-run only reads. Verify by `SELECT COUNT(*) FROM
      // push_events` after running this branch.
      const leads = buildPushCandidates({
        repo,
        minScore: parsed.minScore,
      });
      const payloads = leads.map((lead) => mapToFeishuPayload(lead));
      process.stdout.write(
        formatDryRun(payloads, { minScore: parsed.minScore }) + "\n",
      );
      return;
    }
  } finally {
    close();
  }
}

await main();
