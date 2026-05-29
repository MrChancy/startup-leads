import { test, expect } from "bun:test";
import { parseAge, parseRiskList } from "./purge-args.ts";

// --- parseAge --------------------------------------------------------------

test("parseAge accepts Nd and returns milliseconds", () => {
  expect(parseAge("180d")).toBe(180 * 86_400_000);
  expect(parseAge("30d")).toBe(30 * 86_400_000);
  expect(parseAge("1d")).toBe(86_400_000);
});

test("parseAge rejects missing unit", () => {
  expect(() => parseAge("180")).toThrow(/--older-than/);
});

test("parseAge rejects unsupported units (only Nd in v1)", () => {
  // 1m / 1y / 1h all reserved for follow-up.
  expect(() => parseAge("1m")).toThrow();
  expect(() => parseAge("1y")).toThrow();
  expect(() => parseAge("12h")).toThrow();
});

test("parseAge rejects non-numeric and zero / negative values", () => {
  expect(() => parseAge("abc")).toThrow();
  expect(() => parseAge("-1d")).toThrow();
  expect(() => parseAge("0d")).toThrow();
  expect(() => parseAge("")).toThrow();
});

// --- parseRiskList ---------------------------------------------------------

test("parseRiskList splits on comma and preserves order", () => {
  expect(parseRiskList("blocked,high")).toEqual(["blocked", "high"]);
  expect(parseRiskList("low,medium,high,blocked")).toEqual([
    "low",
    "medium",
    "high",
    "blocked",
  ]);
});

test("parseRiskList accepts a single value", () => {
  expect(parseRiskList("blocked")).toEqual(["blocked"]);
});

test("parseRiskList rejects unknown risk levels", () => {
  expect(() => parseRiskList("blocked,unknown")).toThrow(/unknown/);
  expect(() => parseRiskList("critical")).toThrow();
});

test("parseRiskList rejects empty string", () => {
  expect(() => parseRiskList("")).toThrow();
});

test("parseRiskList trims whitespace around values", () => {
  expect(parseRiskList(" blocked , high ")).toEqual(["blocked", "high"]);
});
