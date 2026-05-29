// Argument parsers for the `purge` subcommand. Kept in their own module
// because both parseArgs (CLI validation) and runPurge (orchestration) call
// them — and they're small, pure, and densely tested.

import type { RiskLevel } from "../types/index.ts";

const DAY_MS = 86_400_000;
const VALID_RISK: ReadonlySet<RiskLevel> = new Set([
  "low",
  "medium",
  "high",
  "blocked",
]);

// Parses a `--older-than` value like "180d" into milliseconds. v1 only
// supports the `Nd` (days) grain; 1m / 1y are reserved for follow-up so the
// CLI surface stays sharp until users actually ask for hours/weeks.
export function parseAge(value: string): number {
  const match = /^(\d+)d$/.exec(value);
  if (!match) {
    throw new Error(
      `--older-than: expected "Nd" (days), got "${value}". ` +
        "Only the days grain is supported in v1.",
    );
  }
  const days = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`--older-than: days must be a positive integer, got "${value}"`);
  }
  return days * DAY_MS;
}

// Parses a `--risk` value like "blocked,high" into a list. Order and
// duplicates are preserved as-is — the SQL builder uses `IN (?, ...)` which
// is set-semantic on the DB side, so duplicates are harmless.
export function parseRiskList(value: string): RiskLevel[] {
  if (!value) {
    throw new Error("--risk: value required (e.g. blocked,high)");
  }
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error("--risk: value required (e.g. blocked,high)");
  }
  for (const part of parts) {
    if (!VALID_RISK.has(part as RiskLevel)) {
      throw new Error(
        `--risk: unknown level "${part}". Allowed: low, medium, high, blocked.`,
      );
    }
  }
  return parts as RiskLevel[];
}
