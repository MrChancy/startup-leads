export type ParsedArgs =
  | { kind: "help" }
  | { kind: "collect"; limit: number; source: string }
  | { kind: "report"; runId: string }
  | { kind: "error"; message: string };

export const HELP_TEXT = `startup-leads — local-first job lead CLI

Usage:
  startup-leads <command> [options]

Commands:
  collect [--limit N] [--source <name>]   Run a collector and store its leads.
  report --run <id>                       Print the run summary for <id>.

Options:
  -h, --help                              Show this help.
`;

function readFlag(args: string[], flag: string) {
  const idx = args.indexOf(flag);
  if (idx === -1) {
    return undefined;
  }
  return args[idx + 1];
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

  return { kind: "error", message: `Unknown command: ${command ?? ""}` };
}
