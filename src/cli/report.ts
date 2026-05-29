import type { LeadRepository } from "../types/index.ts";
import { formatRunReport } from "../reporting/minimal.ts";

export interface ReportResult {
  found: boolean;
  line: string;
}

export function runReport(input: {
  repo: LeadRepository;
  runId: string;
}): ReportResult {
  const { repo, runId } = input;
  const run = repo.getRun(runId);
  if (!run) {
    return { found: false, line: `Run ${runId} not found` };
  }
  return { found: true, line: formatRunReport(runId, repo.countByRun(runId)) };
}
