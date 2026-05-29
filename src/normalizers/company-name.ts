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

const ALIASES = aliases as Record<string, string>;

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
