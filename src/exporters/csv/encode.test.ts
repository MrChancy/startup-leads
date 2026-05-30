import { test, expect } from "bun:test";
import { encodeField, encodeRow, encodeCsv } from "./encode.ts";

// ---- encodeField (per-field RFC 4180 escaping) -----------------------------

test("encodeField passes plain ASCII through unquoted", () => {
  expect(encodeField("acme.ai")).toBe("acme.ai");
});

test("encodeField returns empty string for null/undefined", () => {
  expect(encodeField(null)).toBe("");
  expect(encodeField(undefined)).toBe("");
});

test("encodeField returns empty string for empty input unquoted", () => {
  expect(encodeField("")).toBe("");
});

test("encodeField wraps values containing comma in quotes", () => {
  expect(encodeField("a,b")).toBe('"a,b"');
});

test("encodeField wraps values containing double-quote and doubles the quote", () => {
  expect(encodeField('he said "hi"')).toBe('"he said ""hi"""');
});

test("encodeField wraps values containing newline", () => {
  expect(encodeField("line1\nline2")).toBe('"line1\nline2"');
  expect(encodeField("line1\r\nline2")).toBe('"line1\r\nline2"');
});

test("encodeField quotes values that start or end with whitespace", () => {
  expect(encodeField(" leading")).toBe('" leading"');
  expect(encodeField("trailing ")).toBe('"trailing "');
});

test("encodeField stringifies numbers as plain text", () => {
  expect(encodeField(82)).toBe("82");
  expect(encodeField(0)).toBe("0");
});

// ---- encodeRow + encodeCsv (line assembly) ---------------------------------

test("encodeRow joins fields with comma and CRLF terminator", () => {
  expect(encodeRow(["a", "b", "c"])).toBe("a,b,c\r\n");
});

test("encodeRow escapes per-field then joins", () => {
  expect(encodeRow(["plain", "a,b", 'q"q'])).toBe('plain,"a,b","q""q"\r\n');
});

test("encodeCsv emits header-only output when there are no data rows", () => {
  const out = encodeCsv(["Company", "Score"], []);
  expect(out).toBe("Company,Score\r\n");
});

test("encodeCsv emits header then one row per data entry", () => {
  const out = encodeCsv(
    ["Company", "Score"],
    [
      ["Acme", "82"],
      ["Beta, Inc.", "75"],
    ],
  );
  expect(out).toBe('Company,Score\r\nAcme,82\r\n"Beta, Inc.",75\r\n');
});
