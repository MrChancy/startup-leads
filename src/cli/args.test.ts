import { test, expect } from "bun:test";
import { parseArgs, HELP_TEXT } from "./args.ts";

test("parseArgs with --help returns help command", () => {
  expect(parseArgs(["--help"])).toEqual({ kind: "help" });
  expect(parseArgs(["-h"])).toEqual({ kind: "help" });
  expect(parseArgs([])).toEqual({ kind: "help" });
});

test("parseArgs collect with defaults", () => {
  expect(parseArgs(["collect"])).toEqual({
    kind: "collect",
    limit: 50,
    source: "fake",
  });
});

test("parseArgs collect with --limit and --source", () => {
  expect(parseArgs(["collect", "--limit", "10", "--source", "fake"])).toEqual({
    kind: "collect",
    limit: 10,
    source: "fake",
  });
});

test("parseArgs report requires --run", () => {
  expect(parseArgs(["report", "--run", "abc"])).toEqual({
    kind: "report",
    runId: "abc",
  });
  expect(parseArgs(["report"])).toEqual({
    kind: "error",
    message: "report: --run <id> is required",
  });
});

test("parseArgs unknown command returns error", () => {
  const parsed = parseArgs(["foobar"]);
  expect(parsed.kind).toBe("error");
});

// --- A-1 / A-2 / A-3 regressions (issue #16) ------------------------------

test("collect --source --help does NOT silently fall through to help (A-1)", () => {
  // Pre-#16: `argv.includes("--help")` matched even when --help appeared as
  // a flag value, masking the real misuse of --source. After: --help only
  // resolves as help when it's the actual subcommand (argv[0]).
  const parsed = parseArgs(["collect", "--source", "--help"]);
  expect(parsed.kind).toBe("error");
  // Must blame the actual problem (--source missing a value).
  if (parsed.kind === "error") {
    expect(parsed.message).toMatch(/--source/);
  }
});

test("collect --source --limit 10 catches flag-as-value (A-2)", () => {
  // Pre-#16: readFlag returned "--limit" as the source value, then
  // --limit parsed as 10. After: --source's value can't start with --.
  const parsed = parseArgs(["collect", "--source", "--limit", "10"]);
  expect(parsed.kind).toBe("error");
  if (parsed.kind === "error") {
    expect(parsed.message).toMatch(/--source/);
  }
});

test("collect --limit (no value) errors instead of silently defaulting (A-3)", () => {
  const parsed = parseArgs(["collect", "--limit"]);
  expect(parsed.kind).toBe("error");
  if (parsed.kind === "error") {
    expect(parsed.message).toMatch(/--limit/);
  }
});

test("report --run --help errors with run-id missing, not help fallthrough", () => {
  const parsed = parseArgs(["report", "--run", "--help"]);
  expect(parsed.kind).toBe("error");
  if (parsed.kind === "error") {
    expect(parsed.message).toMatch(/--run/);
  }
});

test("startup-leads --help and -h still return help", () => {
  expect(parseArgs(["--help"]).kind).toBe("help");
  expect(parseArgs(["-h"]).kind).toBe("help");
  expect(parseArgs([]).kind).toBe("help");
});

test("HELP_TEXT mentions all subcommands", () => {
  expect(HELP_TEXT).toContain("collect");
  expect(HELP_TEXT).toContain("report");
  expect(HELP_TEXT).toContain("purge");
});

// --- purge ----------------------------------------------------------------

test("parseArgs purge --older-than", () => {
  expect(parseArgs(["purge", "--older-than", "180d"])).toEqual({
    kind: "purge",
    mode: { kind: "older-than", cutoffMs: 180 * 86_400_000 },
    confirm: false,
  });
});

test("parseArgs purge --older-than --yes", () => {
  expect(parseArgs(["purge", "--older-than", "30d", "--yes"])).toEqual({
    kind: "purge",
    mode: { kind: "older-than", cutoffMs: 30 * 86_400_000 },
    confirm: true,
  });
});

test("parseArgs purge --risk", () => {
  expect(parseArgs(["purge", "--risk", "blocked,high"])).toEqual({
    kind: "purge",
    mode: { kind: "risk", levels: ["blocked", "high"] },
    confirm: false,
  });
});

test("parseArgs purge --company", () => {
  expect(parseArgs(["purge", "--company", "acme.ai", "--yes"])).toEqual({
    kind: "purge",
    mode: { kind: "company", domain: "acme.ai" },
    confirm: true,
  });
});

test("parseArgs purge with no mode is an error", () => {
  const r = parseArgs(["purge"]);
  expect(r.kind).toBe("error");
  expect(r.kind === "error" && r.message).toMatch(/--older-than|--risk|--company/);
});

test("parseArgs purge with two modes is an error", () => {
  const r = parseArgs(["purge", "--older-than", "30d", "--risk", "blocked"]);
  expect(r.kind).toBe("error");
});

test("parseArgs purge bubbles parseAge errors", () => {
  const r = parseArgs(["purge", "--older-than", "abc"]);
  expect(r.kind).toBe("error");
});

test("parseArgs purge bubbles parseRiskList errors", () => {
  const r = parseArgs(["purge", "--risk", "unknown"]);
  expect(r.kind).toBe("error");
});

test("parseArgs purge --older-than missing value is an error", () => {
  const r = parseArgs(["purge", "--older-than"]);
  expect(r.kind).toBe("error");
});

test("parseArgs purge --company empty is an error", () => {
  const r = parseArgs(["purge", "--company", ""]);
  expect(r.kind).toBe("error");
});

// --- enrich ---------------------------------------------------------------

test("parseArgs enrich careers defaults to confirm=false (dry-run)", () => {
  expect(parseArgs(["enrich", "careers"])).toEqual({
    kind: "enrich",
    target: "careers",
    confirm: false,
  });
});

test("parseArgs enrich careers --yes flips confirm", () => {
  expect(parseArgs(["enrich", "careers", "--yes"])).toEqual({
    kind: "enrich",
    target: "careers",
    confirm: true,
  });
});

test("parseArgs enrich with no target is an error", () => {
  const r = parseArgs(["enrich"]);
  expect(r.kind).toBe("error");
  expect(r.kind === "error" && r.message).toMatch(/target is required/);
});

test("parseArgs enrich with unknown target is an error", () => {
  const r = parseArgs(["enrich", "linkedin"]);
  expect(r.kind).toBe("error");
  expect(r.kind === "error" && r.message).toMatch(/unknown target/);
});

test("parseArgs enrich github defaults to confirm=false (dry-run)", () => {
  expect(parseArgs(["enrich", "github"])).toEqual({
    kind: "enrich",
    target: "github",
    confirm: false,
  });
});

test("parseArgs enrich github --yes flips confirm", () => {
  expect(parseArgs(["enrich", "github", "--yes"])).toEqual({
    kind: "enrich",
    target: "github",
    confirm: true,
  });
});

// --- push-feishu (TB-6) ---------------------------------------------------

test("parseArgs push-feishu --dry-run defaults min-score to 70", () => {
  expect(parseArgs(["push-feishu", "--dry-run"])).toEqual({
    kind: "push-feishu",
    dryRun: true,
    minScore: 70,
  });
});

test("parseArgs push-feishu --dry-run --min-score 80 parses", () => {
  expect(parseArgs(["push-feishu", "--dry-run", "--min-score", "80"])).toEqual({
    kind: "push-feishu",
    dryRun: true,
    minScore: 80,
  });
});

test("parseArgs push-feishu without --dry-run is an error in v1", () => {
  // Real push lives in TB-8 (HITL). Refusing the non-dry-run mode here
  // prevents accidentally trying to push without TB-7/TB-8 in place.
  const r = parseArgs(["push-feishu"]);
  expect(r.kind).toBe("error");
  if (r.kind === "error") {
    expect(r.message).toMatch(/--dry-run/);
    expect(r.message).toMatch(/TB-8|v1/);
  }
});

test("parseArgs push-feishu --min-score with no value errors (A-3)", () => {
  const r = parseArgs(["push-feishu", "--dry-run", "--min-score"]);
  expect(r.kind).toBe("error");
  if (r.kind === "error") {
    expect(r.message).toMatch(/--min-score/);
  }
});

test("parseArgs push-feishu --min-score followed by another flag errors (A-2)", () => {
  const r = parseArgs(["push-feishu", "--min-score", "--dry-run"]);
  expect(r.kind).toBe("error");
  if (r.kind === "error") {
    expect(r.message).toMatch(/--min-score/);
  }
});

test("parseArgs push-feishu --min-score non-numeric errors", () => {
  const r = parseArgs(["push-feishu", "--dry-run", "--min-score", "abc"]);
  expect(r.kind).toBe("error");
  if (r.kind === "error") {
    expect(r.message).toMatch(/--min-score/);
  }
});

test("parseArgs push-feishu --min-score negative errors", () => {
  const r = parseArgs(["push-feishu", "--dry-run", "--min-score", "-1"]);
  expect(r.kind).toBe("error");
});

test("HELP_TEXT mentions push-feishu", () => {
  expect(HELP_TEXT).toContain("push-feishu");
  expect(HELP_TEXT).toContain("--dry-run");
});
