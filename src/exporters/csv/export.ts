import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CsvExportRow,
  FreshnessStatus,
  LeadRepository,
  LeadScoreMatchReasonEntry,
  RiskLevel,
} from "../../types/index.ts";
import { encodeRow } from "./encode.ts";

// TB-5 CSV exporter. Pulls every scored company from the repo (no decision
// or score filter), folds per-company jobs/contacts into single string
// columns, and writes the resulting CSV to either a stream (stdout-like) or
// a fresh file under `data/exports/`.
//
// Column order matches `CSV_HEADER` below and is part of the spec contract;
// reordering would break downstream consumers that rely on positional reads.

export const CSV_HEADER = [
  "Company",
  "Domain",
  "Direction Tags",
  "Score",
  "Scorer Version",
  "Freshness",
  "Match Reason",
  "Top Job",
  "Recommended Contact",
  "Last Checked At",
] as const;

// Minimal stream surface — just enough that runExportCsv works with both
// process.stdout (Node WriteStream) and an in-memory capture used by tests.
export interface ExportStreamLike {
  write(chunk: string): boolean | void;
  // Optional `end` callback used for file-backed streams so the caller can
  // await the flush before returning the resolved path.
  end?(cb?: () => void): void;
}

// Inputs:
//   - `repo` and `now` are always required.
//   - Pass `out` to stream the CSV directly (e.g. process.stdout). The
//     function returns `{ path: null }` because nothing was written to disk.
//   - Pass `outputDir` (no `out`) to write a fresh file at
//     `<outputDir>/<timestamp>.csv` and return its absolute path.
// Default for outputDir is `data/exports`, matching the spec.
export interface RunExportCsvInput {
  repo: LeadRepository;
  now: () => Date;
  out?: ExportStreamLike;
  outputDir?: string;
}

export interface RunExportCsvResult {
  // `null` when stdout-mode (caller's stream). Absolute path on file mode.
  path: string | null;
}

const DEFAULT_EXPORT_DIR = "data/exports";

const FRESHNESS_RANK: Record<FreshnessStatus, number> = {
  fresh: 3,
  usable: 2,
  unknown: 1,
  stale: 0,
};

// Risk preference for the Recommended Contact tie-break. `blocked` rows are
// filtered out before this map is consulted (see `pickTopContact`).
const RISK_RANK: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  blocked: 3,
};

// "Freshness" column rule (documented at the call site per CLAUDE.local.md
// guidance): fresh > usable > unknown > stale; if no jobs, "unknown".
function rollUpFreshness(jobs: CsvExportRow["jobs"]): FreshnessStatus {
  if (jobs.some((j) => j.freshness === "fresh")) return "fresh";
  if (jobs.some((j) => j.freshness === "usable")) return "usable";
  if (jobs.some((j) => j.freshness === "unknown")) return "unknown";
  if (jobs.length === 0) return "unknown";
  return "stale";
}

// "Top Job" rule: freshness DESC, sourcePostedAt DESC (newest first; null
// treated as -Infinity), title ASC as a stable final tie-break. Format is
// `"<title> @ <location>"`, with the `" @ <location>"` suffix dropped when
// location is null/empty.
function pickTopJob(jobs: CsvExportRow["jobs"]): string {
  if (jobs.length === 0) return "";
  const sorted = [...jobs].sort((a, b) => {
    const fr = FRESHNESS_RANK[b.freshness] - FRESHNESS_RANK[a.freshness];
    if (fr !== 0) return fr;
    const aT = a.sourcePostedAt ? Date.parse(a.sourcePostedAt) : -Infinity;
    const bT = b.sourcePostedAt ? Date.parse(b.sourcePostedAt) : -Infinity;
    if (aT !== bT) return bT - aT;
    return a.title.localeCompare(b.title);
  });
  const top = sorted[0]!;
  return top.location ? `${top.title} @ ${top.location}` : top.title;
}

// "Recommended Contact" rule: `blocked` risk is excluded; then
// priorityRank ASC (null treated as +Infinity), riskLevel ASC
// (low > medium > high). Format: `"<name or value> <value> (<riskLevel>)"`.
// When name is null/empty the value stands in alone before the
// parenthesized risk level.
function pickTopContact(contacts: CsvExportRow["contacts"]): string {
  const visible = contacts.filter((c) => c.riskLevel !== "blocked");
  if (visible.length === 0) return "";
  const sorted = [...visible].sort((a, b) => {
    const aR = a.priorityRank ?? Number.POSITIVE_INFINITY;
    const bR = b.priorityRank ?? Number.POSITIVE_INFINITY;
    if (aR !== bR) return aR - bR;
    return RISK_RANK[a.riskLevel] - RISK_RANK[b.riskLevel];
  });
  const top = sorted[0]!;
  const label = top.name && top.name.length > 0
    ? `${top.name} ${top.value}`
    : top.value;
  return `${label} (${top.riskLevel})`;
}

// "Match Reason" rule: "<component>+<points>: <note>" entries joined by
// "; ". Empty array → empty string.
function formatMatchReason(entries: readonly LeadScoreMatchReasonEntry[]): string {
  if (entries.length === 0) return "";
  return entries
    .map((e) => `${e.component}+${e.points}: ${e.note}`)
    .join("; ");
}

// Build the 10 CSV string columns for one company. Derived directly from
// the source row — no identity intermediate DTO (I-3).
function rowFor(row: CsvExportRow): string[] {
  return [
    row.name,
    row.domain ?? "",
    row.directionTags.join("|"),
    String(row.score),
    row.scorerVersion,
    rollUpFreshness(row.jobs),
    formatMatchReason(row.matchReason),
    pickTopJob(row.jobs),
    pickTopContact(row.contacts),
    row.lastCheckedAt,
  ];
}

// Timestamp suffix for the default file name. Colons and the trailing
// fractional `.<ms>Z` get rewritten to dashes so the file name is valid on
// Windows / macOS / Linux without quoting.
//   2026-05-30T12:34:56.789Z  →  2026-05-30T12-34-56
function timestampSlug(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d+Z$/, "") // drop ".789Z"
    .replace(/:/g, "-");
}

export function runExportCsv(input: RunExportCsvInput): RunExportCsvResult {
  const rows = input.repo.listAllForExport();

  // Render once. CSV exports are bounded by the number of scored companies
  // (dozens to low thousands in v1) so a string buffer is well under any
  // memory concern, and it lets us hand the same byte-identical output to
  // either a caller-owned stream OR writeFileSync.
  let buf = encodeRow(CSV_HEADER);
  for (const row of rows) buf += encodeRow(rowFor(row));

  if (input.out) {
    // Caller owns this stream — write to it and DON'T close (we'd kill
    // process.stdout for any later writer).
    input.out.write(buf);
    return { path: null };
  }

  const dir = input.outputDir ?? DEFAULT_EXPORT_DIR;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${timestampSlug(input.now())}.csv`);
  // Synchronous write keeps runExportCsv synchronous so the CLI top-level
  // doesn't need to await and tests can read the file back immediately.
  // pr-review TB-5 M1: open exclusively (wx) so two invocations within
  // the same wall-clock second fail loud instead of silently overwriting
  // the first export's bytes (the slug only has second-resolution).
  try {
    writeFileSync(path, buf, { flag: "wx" });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new Error(
        `Refusing to overwrite existing export: ${path} already exists. ` +
          `Wait a second and retry, or use --stdout to pipe to a different sink.`,
      );
    }
    throw err;
  }
  return { path };
}
