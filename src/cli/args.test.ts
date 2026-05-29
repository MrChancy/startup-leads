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

test("HELP_TEXT mentions both subcommands", () => {
  expect(HELP_TEXT).toContain("collect");
  expect(HELP_TEXT).toContain("report");
});
