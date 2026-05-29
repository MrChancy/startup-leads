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
  const r = parseArgs(["enrich", "github"]);
  expect(r.kind).toBe("error");
  expect(r.kind === "error" && r.message).toMatch(/unknown target/);
});
