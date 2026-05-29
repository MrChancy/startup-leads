// Match DB-stored normalized titles against careers-page text.
//
// v1 strategy (spec: "不要做模糊匹配 / 词形变化 / 同义词"):
//   1. Strip HTML tags from the page and decode the small set of entities
//      HN-style parsers already use elsewhere.
//   2. Lowercase + collapse all whitespace to a single space.
//   3. For each DB normalized_title, test whether it appears as a
//      substring of the normalized page.
//
// Returning the matched normalized_title (rather than the page snippet)
// keeps the caller honest: the upgrade is keyed on the same value the
// DB stores, no fuzzy comparison sneaks back in later.

export interface TitleMatch {
  normalizedTitle: string;
  // Short snippet around the first occurrence; useful for source.evidence_snippet
  // so a reviewer can see WHY the upgrade fired without re-fetching the page.
  snippet: string;
}

const SNIPPET_RADIUS = 60;

export function matchTitlesInPage(
  pageText: string,
  dbTitles: readonly string[],
): TitleMatch[] {
  const normalized = normalizeForMatch(pageText);
  const out: TitleMatch[] = [];
  const seen = new Set<string>();
  for (const raw of dbTitles) {
    const title = raw.trim().toLowerCase().replace(/\s+/g, " ");
    if (title === "") continue;
    if (seen.has(title)) continue;
    const idx = normalized.indexOf(title);
    if (idx === -1) continue;
    seen.add(title);
    out.push({ normalizedTitle: title, snippet: snippetAround(normalized, idx, title.length) });
  }
  return out;
}

// Exported so tests can pin the normalization (the same transform applies on
// both sides of the match) and enricher orchestration can debug-log it.
export function normalizeForMatch(input: string): string {
  const stripped = stripHtml(decodeEntities(input));
  return stripped.toLowerCase().replace(/\s+/g, " ").trim();
}

// HTML strip is intentionally regex-based: careers pages frequently break
// real DOM parsers (mismatched tags, custom <x-foo>), and we don't care about
// structure — we only want the visible text concatenated.
function stripHtml(input: string): string {
  return input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

// Same minimal entity set as src/collectors/hn/parse.ts. Careers pages tend
// to use entities for ampersands and curly quotes; we don't need a full table.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code) : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

function safeFromCodePoint(code: number): string {
  if (code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function snippetAround(text: string, idx: number, len: number): string {
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + len + SNIPPET_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return prefix + text.slice(start, end) + suffix;
}
