// Company-name normalization for TB-4's 4-step dedupe.
//
// The output is the value stored on companies.normalized_name and compared
// during step 2 of the dedupe rule. Two "different" spellings ("ByteDance"
// vs "字节跳动" vs "ＢｙｔｅＤａｎｃｅ") must produce the same key, otherwise
// step 2 silently fails and step 1's synthetic `hn:<name>` keys from TB-3b
// stop matching across language variants.
//
// Pipeline (intentional, do not reorder):
//   1. trim outer whitespace
//   2. NFKC fold — collapses full-width Latin/digits/punct to ASCII
//   3. brand-alias lookup by EXACT post-NFKC key — alias value wins entirely
//      (it is already the canonical form the spec wants stored)
//   4. lowercase
//   5. strip punctuation, keeping [a-z0-9 -] plus non-ASCII letters
//   6. fold runs of whitespace to a single space, then trim

import aliases from "./brand-aliases.json" with { type: "json" };

// Validate the hand-curated alias file at module load. A typo or stray
// non-string value ships forever undetected otherwise (CLAUDE.local.md M-3 +
// M-4 from PR for TB-4). Each entry must be { string → non-empty string }.
export function validateAliases(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("brand-aliases.json must be a JSON object");
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "") {
      throw new Error("brand-aliases.json contains an empty key");
    }
    if (typeof value !== "string") {
      throw new Error(
        `brand-aliases.json: value for "${key}" must be a string, got ${typeof value}`,
      );
    }
    if (value === "") {
      throw new Error(
        `brand-aliases.json: value for "${key}" is an empty string; ` +
          `omit the entry instead of mapping to ""`,
      );
    }
    out[key] = value;
  }
  return out;
}

const ALIASES = validateAliases(aliases);

export function normalizeCompanyName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";

  const folded = trimmed.normalize("NFKC");

  const aliased = ALIASES[folded];
  if (aliased !== undefined) {
    // Alias values are authored as canonical and need no further mangling.
    return aliased;
  }

  const lower = folded.toLowerCase();

  // Keep word chars + hyphens + spaces. \p{L} preserves CJK and other
  // letter scripts so "字节跳动北京" (no alias hit) survives as-is.
  const stripped = lower.replace(/[^\p{L}\p{N}\s-]+/gu, " ");

  return stripped.replace(/\s+/g, " ").trim();
}
