import type { RiskLevel } from "../types/index.ts";
import { parseAge, parseRiskList } from "./purge-args.ts";

export type PurgeMode =
  | { kind: "older-than"; cutoffMs: number }
  | { kind: "risk"; levels: RiskLevel[] }
  | { kind: "company"; domain: string };

// TB-11 report scope as parsed from the CLI. Mirrors src/types/index.ts's
// ReportScope by intent, but carries `cutoffMs` (millisecond delta) instead
// of a resolved ISO cutoff — the CLI layer subtracts from `now` when it
// runs so an operator setting `--since 30d` at 11pm gets the 11pm-30d
// cutoff, not a noon-anchored one.
export type ReportScopeArg =
  | { kind: "latest" }
  | { kind: "run"; runId: string }
  | { kind: "since"; cutoffMs: number };

export type ParsedArgs =
  | { kind: "help" }
  | { kind: "collect"; limit: number; source: string }
  | { kind: "report"; scope: ReportScopeArg }
  | { kind: "purge"; mode: PurgeMode; confirm: boolean }
  | { kind: "enrich"; target: "careers" | "github"; confirm: boolean }
  | { kind: "push-feishu"; dryRun: boolean; minScore: number }
  | { kind: "export"; format: "csv"; stdout: boolean }
  | { kind: "error"; message: string };

export const HELP_TEXT = `startup-leads — local-first job lead CLI

Usage:
  startup-leads <command> [options]

Commands:
  collect [--limit N] [--source <name>]   Run a collector and store its leads.
  report [--run <id>] [--since <Nd>]      Print the full report. With no flags shows
                                          the latest run; --run <id> scopes to one
                                          run; --since aggregates every run within
                                          the window. --run and --since are exclusive.
  enrich careers [--yes]                  Probe each company's careers page; upgrade
                                          matching unknown jobs to usable (dry-run otherwise).
  enrich github  [--yes]                  Pull public GitHub org member profiles for any
                                          company with a github.com/<org> contact and
                                          record evidence-backed contacts (dry-run otherwise).
  push-feishu --dry-run [--min-score N]   Print the Feishu payload that WOULD be pushed
                                          for each candidate company (default min-score 70).
                                          v1 only supports --dry-run; real push lands in TB-8.
  export csv [--stdout]                   Dump every scored company to a CSV file under
                                          data/exports/<timestamp>.csv, or to stdout with
                                          --stdout. Includes scorer_version for audit.
  purge --older-than <Nd> [--yes]         Delete rows older than the cutoff.
  purge --risk <list>     [--yes]         Delete contacts with the listed risk levels.
  purge --company <domain> [--yes]        Delete a single company and all its dependents.

Options:
  -h, --help                              Show this help.
  --yes                                   Required for purge / enrich to actually write (dry-run otherwise).
`;

// The single flag-reading primitive — A-1/A-2/A-3 compliant. Returns:
//   - { present: false } if the flag isn't in argv.
//   - { present: true, value: null } if the flag is there but the next token
//     is another flag or missing entirely. Callers MUST error on this case.
//   - { present: true, value: "..." } when both flag and value are real.
function readFlagSafe(
  args: string[],
  flag: string,
): { present: false } | { present: true; value: string | null } {
  const idx = args.indexOf(flag);
  if (idx === -1) return { present: false };
  const next = args[idx + 1];
  if (next === undefined || next === "" || next.startsWith("--")) {
    return { present: true, value: null };
  }
  return { present: true, value: next };
}

export function parseArgs(argv: string[]): ParsedArgs {
  // Issue #16 (A-1): only treat --help / -h as a help request when it's
  // the SUBCOMMAND (positional 0). Pre-fix `argv.includes("--help")`
  // matched even when --help appeared as a flag value
  // (`collect --source --help`), silently masking the real misuse.
  if (argv.length === 0) return { kind: "help" };
  const head = argv[0]!;
  if (head === "--help" || head === "-h" || head === "help") {
    return { kind: "help" };
  }

  const [command, ...rest] = argv;

  if (command === "collect") {
    const limitFlag = readFlagSafe(rest, "--limit");
    if (limitFlag.present && limitFlag.value === null) {
      return {
        kind: "error",
        message: "collect: --limit requires a positive integer (e.g. --limit 50)",
      };
    }
    const limit = limitFlag.present
      ? Number.parseInt(limitFlag.value as string, 10)
      : 50;
    if (Number.isNaN(limit) || limit <= 0) {
      return { kind: "error", message: "collect: --limit must be a positive integer" };
    }
    const sourceFlag = readFlagSafe(rest, "--source");
    if (sourceFlag.present && sourceFlag.value === null) {
      return {
        kind: "error",
        message: "collect: --source requires a value (e.g. --source fake)",
      };
    }
    const source = sourceFlag.present ? (sourceFlag.value as string) : "fake";
    return { kind: "collect", limit, source };
  }

  if (command === "report") {
    return parseReportArgs(rest);
  }

  if (command === "purge") {
    return parsePurgeArgs(rest);
  }

  if (command === "enrich") {
    return parseEnrichArgs(rest);
  }

  if (command === "push-feishu") {
    return parsePushFeishuArgs(rest);
  }

  if (command === "export") {
    return parseExportArgs(rest);
  }

  return { kind: "error", message: `Unknown command: ${command ?? ""}` };
}

function parseReportArgs(rest: string[]): ParsedArgs {
  // Three modes:
  //   1. (no flags)          → latest run
  //   2. --run <id>          → that specific run
  //   3. --since <duration>  → every run with started_at >= now - duration
  // --run and --since are mutually exclusive; passing both is a clear user
  // mistake (you can't aggregate across a window AND scope to one id), so
  // we error rather than silently picking one.
  const runFlag = readFlagSafe(rest, "--run");
  const sinceFlag = readFlagSafe(rest, "--since");

  if (runFlag.present && sinceFlag.present) {
    return {
      kind: "error",
      message: "report: --run and --since are mutually exclusive (pick one)",
    };
  }

  if (runFlag.present) {
    if (runFlag.value === null) {
      return { kind: "error", message: "report: --run requires a run id" };
    }
    return { kind: "report", scope: { kind: "run", runId: runFlag.value } };
  }

  if (sinceFlag.present) {
    if (sinceFlag.value === null) {
      return {
        kind: "error",
        message: "report: --since requires a duration (e.g. --since 30d)",
      };
    }
    try {
      const cutoffMs = parseAge(sinceFlag.value);
      return { kind: "report", scope: { kind: "since", cutoffMs } };
    } catch (err) {
      // parseAge throws a self-explanatory message (`expected "Nd"`...).
      // Surface it verbatim so the operator sees the same wording the
      // purge flow uses — one less mental model.
      return {
        kind: "error",
        message:
          err instanceof Error
            ? `report: ${err.message}`
            : `report: ${String(err)}`,
      };
    }
  }

  return { kind: "report", scope: { kind: "latest" } };
}

function parseExportArgs(rest: string[]): ParsedArgs {
  // Format is positional (no default) so a future `jsonl` lands as a new
  // positional rather than silently changing what `export` does.
  const [format, ...flags] = rest;
  if (!format) {
    return {
      kind: "error",
      message: "export: format is required (e.g. `export csv`)",
    };
  }
  if (format !== "csv") {
    return { kind: "error", message: `export: unknown format "${format}"` };
  }
  const stdout = flags.includes("--stdout");
  return { kind: "export", format: "csv", stdout };
}

function parsePushFeishuArgs(rest: string[]): ParsedArgs {
  // v1 only supports dry-run. Refusing the non-dry-run mode here means a
  // user who runs `push-feishu` against an empty TB-8 stack gets a clean
  // error rather than a silent no-op or a half-wired push attempt.
  const dryRunFlag = readFlagSafe(rest, "--dry-run");
  if (!dryRunFlag.present) {
    return {
      kind: "error",
      message:
        "push-feishu: --dry-run is required in v1 (real push lands in TB-8)",
    };
  }
  const minScoreFlag = readFlagSafe(rest, "--min-score");
  if (minScoreFlag.present && minScoreFlag.value === null) {
    return {
      kind: "error",
      message:
        "push-feishu: --min-score requires a non-negative integer (e.g. --min-score 70)",
    };
  }
  // Spec § 飞书推送阈值 default. parsePushFeishuArgs is the single source
  // of truth for the threshold so the CLI and any future caller agree.
  const minScore = minScoreFlag.present
    ? Number.parseInt(minScoreFlag.value as string, 10)
    : 70;
  if (Number.isNaN(minScore) || minScore < 0) {
    return {
      kind: "error",
      message: "push-feishu: --min-score must be a non-negative integer",
    };
  }
  return { kind: "push-feishu", dryRun: true, minScore };
}

function parseEnrichArgs(rest: string[]): ParsedArgs {
  // Targets are positional (no default) so adding a new enricher never
  // silently changes what `enrich --yes` does.
  const [target, ...flags] = rest;
  if (!target) {
    return {
      kind: "error",
      message: "enrich: target is required (e.g. `enrich careers`)",
    };
  }
  if (target !== "careers" && target !== "github") {
    return { kind: "error", message: `enrich: unknown target "${target}"` };
  }
  const confirm = flags.includes("--yes");
  return { kind: "enrich", target, confirm };
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
