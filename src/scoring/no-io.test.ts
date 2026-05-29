import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// AC #6: 'scorer 无 IO'. The check is grep-style: scan every src/scoring/
// source file (except tests, test-support, and this guard) for any import
// that could perform IO. If TB-2 ever needs to reach into the database, that
// belongs in the collect pipeline — not the scorer.

const SCORING_DIR = join(import.meta.dir);

const FORBIDDEN_PATTERNS = [
  /bun:sqlite/,
  /from\s+["']node:fs["']/,
  /from\s+["']node:path["']/,
  /from\s+["']node:http["']/,
  /from\s+["']node:https["']/,
  /\bfetch\s*\(/,
  /\.\.\/storage/,
  /\.\.\/http/,
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...listSourceFiles(path));
      continue;
    }
    if (!name.endsWith(".ts")) continue;
    if (name.endsWith(".test.ts")) continue;
    if (name === "test-support.ts") continue;
    out.push(path);
  }
  return out;
}

test("no src/scoring/ source file imports IO-capable modules", () => {
  const offenders: { file: string; pattern: string }[] = [];
  for (const file of listSourceFiles(SCORING_DIR)) {
    const text = readFileSync(file, "utf8");
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(text)) {
        offenders.push({ file, pattern: pattern.source });
      }
    }
  }
  expect(offenders).toEqual([]);
});
