#!/usr/bin/env bun
import { parseArgs, HELP_TEXT } from "./args.ts";
import { runCollect } from "./collect.ts";
import { runReport } from "./report.ts";
import { fakeCollector } from "../collectors/fake.ts";
import { openLeadRepository } from "../storage/index.ts";
import { formatRunReport } from "../reporting/minimal.ts";
import { getDatabasePath } from "../config/index.ts";
import type { Collector } from "../collectors/types.ts";

const COLLECTORS: Record<string, Collector> = {
  fake: fakeCollector,
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
      const { runId, counts } = await runCollect({
        repo,
        collector,
        limit: parsed.limit,
      });
      process.stdout.write(formatRunReport(runId, counts) + "\n");
      return;
    }

    if (parsed.kind === "report") {
      const result = runReport({ repo, runId: parsed.runId });
      if (!result.found) {
        process.stderr.write(result.line + "\n");
        close();
        process.exit(1);
      }
      process.stdout.write(result.line + "\n");
      return;
    }
  } finally {
    close();
  }
}

await main();
