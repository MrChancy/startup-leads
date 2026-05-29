import type { RiskLevel } from "../types/index.ts";
import { parseAge, parseRiskList } from "./purge-args.ts";

export type PurgeMode =
  | { kind: "older-than"; cutoffMs: number }
  | { kind: "risk"; levels: RiskLevel[] }
  | { kind: "company"; domain: string };

export type ParsedArgs =
  | { kind: "help" }
  | { kind: "collect"; limit: number; source: string }
  | { kind: "report"; runId: string }
  | { kind: "purge"; mode: PurgeMode; confirm: boolean }
  | { kind: "enrich"; target: "careers"; confirm: boolean }
  | { kind: "error"; message: string };

export const HELP_TEXT = `startup-leads — local-first job lead CLI

Usage:
  startup-leads <command> [options]

Commands:
  collect [--limit N] [--source <name>]   Run a collector and store its leads.
  report --run <id>                       Print the run summary for <id>.
  enrich careers [--yes]                  Probe each company's careers page; upgrade
                                          matching unknown jobs to usable (dry-run otherwise).
  purge --older-than <Nd> [--yes]         Delete rows older than the cutoff.
  purge --risk <list>     [--yes]         Delete contacts with the listed risk levels.
  purge --company <domain> [--yes]        Delete a single company and all its dependents.

Options:
  -h, --help                              Show this help.
  --yes                                   Required for purge / enrich to actually write (dry-run otherwise).
`;

function readFlag(args: string[], flag: string) {
  const idx = args.indexOf(flag);
  if (idx === -1) {
    return undefined;
  }
  return args[idx + 1];
}

// Variant of readFlag with the two A-2/A-3 fixes from CLAUDE.local.md.
//   - { present: false } if the flag isn't in argv.
//   - { present: true, value: null } if the flag is there but the next token
//     is another flag or missing entirely.
//   - { present: true, value: "..." } when both flag and value are real.
// Existing readFlag stays put so the older `collect` / `report` paths keep
// their current (buggy) behaviour; follow-up #16 will migrate them. New
// purge code uses this one exclusively.
function readFlagSafe(
  args: string[],
  flag: string,
): { present: false } | { present: true; value: string | null } {
  const idx = args.indexOf(flag);
  if (idx === -1) return { present: false };
  const next = args[idx + 1];
  if (next === undefined || next.startsWith("--")) {
    return { present: true, value: null };
  }
  return { present: true, value: next };
}

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { kind: "help" };
  }

  const [command, ...rest] = argv;

  if (command === "collect") {
    const limitStr = readFlag(rest, "--limit");
    const limit = limitStr ? Number.parseInt(limitStr, 10) : 50;
    if (Number.isNaN(limit) || limit <= 0) {
      return { kind: "error", message: "collect: --limit must be a positive integer" };
    }
    const source = readFlag(rest, "--source") ?? "fake";
    return { kind: "collect", limit, source };
  }

  if (command === "report") {
    const runId = readFlag(rest, "--run");
    if (!runId) {
      return { kind: "error", message: "report: --run <id> is required" };
    }
    return { kind: "report", runId };
  }

  if (command === "purge") {
    return parsePurgeArgs(rest);
  }

  if (command === "enrich") {
    return parseEnrichArgs(rest);
  }

  return { kind: "error", message: `Unknown command: ${command ?? ""}` };
}

function parseEnrichArgs(rest: string[]): ParsedArgs {
  // v1 only ships one enricher (careers). We require the target as a
  // positional arg rather than guessing because TB-10 will add `github` and
  // shipping a default-target now would change behaviour silently then.
  const [target, ...flags] = rest;
  if (!target) {
    return {
      kind: "error",
      message: "enrich: target is required (e.g. `enrich careers`)",
    };
  }
  if (target !== "careers") {
    return { kind: "error", message: `enrich: unknown target "${target}"` };
  }
  const confirm = flags.includes("--yes");
  return { kind: "enrich", target: "careers", confirm };
}

function parsePurgeArgs(rest: string[]): ParsedArgs {
  const older = readFlagSafe(rest, "--older-than");
  const risk = readFlagSafe(rest, "--risk");
  const company = readFlagSafe(rest, "--company");
  const confirm = rest.includes("--yes");

  const modesPresent = [older.present, risk.present, company.present].filter(
    Boolean,
  ).length;
  if (modesPresent === 0) {
    return {
      kind: "error",
      message:
        "purge: one of --older-than <Nd>, --risk <list>, or --company <domain> is required",
    };
  }
  if (modesPresent > 1) {
    return {
      kind: "error",
      message:
        "purge: --older-than, --risk, and --company are mutually exclusive (pick one)",
    };
  }

  try {
    if (older.present === true) {
      if (older.value === null) {
        return { kind: "error", message: "purge: --older-than requires a value (e.g. 180d)" };
      }
      const cutoffMs = parseAge(older.value);
      return { kind: "purge", mode: { kind: "older-than", cutoffMs }, confirm };
    }
    if (risk.present === true) {
      if (risk.value === null) {
        return { kind: "error", message: "purge: --risk requires a value (e.g. blocked,high)" };
      }
      const levels = parseRiskList(risk.value);
      return { kind: "purge", mode: { kind: "risk", levels }, confirm };
    }
    // Reachable only when company.present === true (the modesPresent guard
    // above asserts exactly one mode is selected).
    if (company.present !== true) {
      return {
        kind: "error",
        message: "purge: internal — no mode resolved",
      };
    }
    if (company.value === null || company.value === "") {
      return {
        kind: "error",
        message: "purge: --company requires a domain (e.g. acme.ai)",
      };
    }
    return {
      kind: "purge",
      mode: { kind: "company", domain: company.value },
      confirm,
    };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
