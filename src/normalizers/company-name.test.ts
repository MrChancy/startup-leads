import { test, expect } from "bun:test";
import { normalizeCompanyName, validateAliases } from "./company-name.ts";

// --- validateAliases: catches typos in the hand-curated alias file -------

test("validateAliases rejects non-object input", () => {
  expect(() => validateAliases(null)).toThrow(/JSON object/);
  expect(() => validateAliases("string")).toThrow(/JSON object/);
  expect(() => validateAliases([])).toThrow(/JSON object/);
});

test("validateAliases rejects an empty key", () => {
  expect(() => validateAliases({ "": "foo" })).toThrow(/empty key/);
});

test("validateAliases rejects a non-string value", () => {
  expect(() => validateAliases({ Foo: 42 })).toThrow(/must be a string/);
  expect(() => validateAliases({ Foo: null })).toThrow(/must be a string/);
});

test("validateAliases rejects an empty-string value (typo guard)", () => {
  expect(() => validateAliases({ "字节跳动": "" })).toThrow(/empty string/);
});

test("validateAliases accepts the shipped brand-aliases.json shape", () => {
  expect(() =>
    validateAliases({
      "字节跳动": "bytedance",
      DeepSeek: "deepseek",
    }),
  ).not.toThrow();
});


// Mechanics: trim → NFKC → alias lookup → lowercase → punctuation strip →
// whitespace fold. Tests are arranged top-down in that order.

test("trims and lowercases plain ASCII names", () => {
  expect(normalizeCompanyName("  Acme  ")).toBe("acme");
  expect(normalizeCompanyName("Acme AI")).toBe("acme ai");
});

test("folds full-width digits and letters via NFKC", () => {
  // "ＡＣＭＥ" (full-width) and "Ａｃｍｅ" both collapse to "acme".
  expect(normalizeCompanyName("ＡＣＭＥ")).toBe("acme");
  expect(normalizeCompanyName("Ａｃｍｅ ＡＩ")).toBe("acme ai");
});

test("looks up brand aliases by exact key (post-NFKC)", () => {
  // Chinese name in the seed file resolves to English brand id.
  expect(normalizeCompanyName("字节跳动")).toBe("bytedance");
  // English stylization that the seed lowercases via alias entry.
  expect(normalizeCompanyName("DeepSeek")).toBe("deepseek");
});

test("alias lookup is exact, not substring", () => {
  // "字节跳动北京" (substring "字节跳动") must NOT alias-map; falls through
  // to general normalization → no alias, returns "字节跳动北京".
  expect(normalizeCompanyName("字节跳动北京")).toBe("字节跳动北京");
});

test("strips punctuation but keeps hyphens and digits", () => {
  expect(normalizeCompanyName("Acme, Inc.")).toBe("acme inc");
  expect(normalizeCompanyName("Beta-Cloud!")).toBe("beta-cloud");
  expect(normalizeCompanyName("Foo123 Bar")).toBe("foo123 bar");
});

test("collapses runs of whitespace to a single space", () => {
  expect(normalizeCompanyName("Acme   AI\t Labs")).toBe("acme ai labs");
});

test("empty / whitespace-only input returns empty string", () => {
  expect(normalizeCompanyName("")).toBe("");
  expect(normalizeCompanyName("    ")).toBe("");
});

test("English brand without alias entry falls through to lowercase", () => {
  // No "Acme" key in aliases → still normalized via the generic pipeline.
  expect(normalizeCompanyName("Acme")).toBe("acme");
});

test("alias key matches before lowercasing (English stylized aliases work)", () => {
  // "ByteDance" should alias-map even though the key in JSON is exactly that.
  // Verifies we look up alias BEFORE forcing lowercase.
  expect(normalizeCompanyName("ByteDance")).toBe("bytedance");
});
