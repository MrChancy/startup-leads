import type { LeadRepository, PurgeCounts } from "../types/index.ts";
import type { PurgeMode } from "./args.ts";

export interface PurgeResult {
  // Same shape for dry-run and real-delete; the caller decides which header
  // to print and whether to issue the real-delete call.
  counts: PurgeCounts;
  deleted: boolean;
}

export function runPurge(input: {
  repo: LeadRepository;
  mode: PurgeMode;
  confirm: boolean;
}): PurgeResult {
  const { repo, mode, confirm } = input;
  if (!confirm) {
    return { counts: preview(repo, mode), deleted: false };
  }
  return { counts: execute(repo, mode), deleted: true };
}

function preview(repo: LeadRepository, mode: PurgeMode): PurgeCounts {
  switch (mode.kind) {
    case "older-than":
      return repo.previewPurgeOlderThan(toIsoFromAge(mode.cutoffMs));
    case "risk":
      return repo.previewPurgeContactsByRisk(mode.levels);
    case "company":
      return repo.previewPurgeCompany(mode.domain);
  }
}

function execute(repo: LeadRepository, mode: PurgeMode): PurgeCounts {
  switch (mode.kind) {
    case "older-than":
      return repo.purgeOlderThan(toIsoFromAge(mode.cutoffMs));
    case "risk":
      return repo.purgeContactsByRisk(mode.levels);
    case "company":
      return repo.purgeCompany(mode.domain);
  }
}

// Translate "N days ago" into the ISO timestamp the repo compares
// row_updated_at against. Centralised so wall-clock derivation lives in
// one place — tests stub Date when they need determinism.
function toIsoFromAge(cutoffMs: number): string {
  return new Date(Date.now() - cutoffMs).toISOString();
}

// One formatter for both dry-run and real-delete keeps the column widths
// aligned and means `| grep contacts` works on either header. The "(not
// touched)" tag on the sources line is constant: purge never writes to
// the audit table.
export function formatPurgeResult(result: PurgeResult): string {
  const { counts, deleted } = result;
  const header = deleted
    ? "Purged:"
    : "Purge preview (no rows deleted; pass --yes to delete):";
  const rows = [
    ["companies", counts.companies, ""],
    ["company_domains", counts.company_domains, ""],
    ["jobs", counts.jobs, ""],
    ["contacts", counts.contacts, ""],
    ["lead_scores", counts.lead_scores, ""],
    ["push_events", counts.push_events, ""],
    ["sources", counts.sources, "(not touched)"],
  ] as const;
  const lines = rows.map(([name, n, tag]) => {
    const padded = name.padEnd(16, " ");
    return `  ${padded} : ${n}${tag ? " " + tag : ""}`;
  });
  return [header, ...lines].join("\n");
}
