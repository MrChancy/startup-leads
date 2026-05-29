// HN "Ask HN: Who is hiring?" comment parser.
//
// Inputs:
//   - raw: a Firebase item JSON (we trust the structural fields, never the
//     text contents — text is HTML supplied by anonymous strangers).
//   - ctx: post title + a `now` for freshness bucketing.
//
// Output: either a CollectedLead OR a parse_failed reason. We never throw on
// malformed text; the caller counts parse failures and keeps going.
//
// Design notes:
//   - HTML decode/strip is hand-rolled (no DOM, no library). HN text is
//     well-formed enough (`<p>` paragraph breaks + HTML entities) that a
//     regex-based stripper is sufficient for v1.
//   - Title / location / remote / contacts use simple regexes that match
//     the most common community conventions, not arbitrary NLP. Coverage
//     is "5 fixtures, 5 formats" per the AC, not "every comment ever".

import { createHash } from "node:crypto";
import type {
  CollectedContact,
  CollectedLead,
  FreshnessStatus,
} from "../../types/index.ts";

export interface ParseContext {
  postTitle: string;
  now: Date;
}

export type ParseResult =
  | { kind: "ok"; lead: CollectedLead }
  | { kind: "parse_failed"; reason: string };

// Subset of the Firebase comment item shape we care about. `text` is HTML.
export interface FirebaseCommentItem {
  id: number;
  type?: string;
  text?: string;
  time?: number;
  by?: string;
  deleted?: boolean;
  dead?: boolean;
  kids?: number[];
  parent?: number;
}

const FRESH_DAYS = 30;
const USABLE_DAYS = 180;

export function parseComment(
  raw: FirebaseCommentItem,
  ctx: ParseContext,
): ParseResult {
  if (raw.deleted) {
    return { kind: "parse_failed", reason: "deleted" };
  }
  if (raw.dead) {
    return { kind: "parse_failed", reason: "dead" };
  }
  const rawText = raw.text;
  if (typeof rawText !== "string" || rawText.trim() === "") {
    return { kind: "parse_failed", reason: "empty text" };
  }

  const text = stripHtml(decodeHtmlEntities(rawText));
  if (text.length < 10) {
    return { kind: "parse_failed", reason: "text too short" };
  }

  const firstLine = firstNonEmptyLine(text);
  const companyName = extractCompanyName(firstLine);
  if (!companyName) {
    return { kind: "parse_failed", reason: "missing company name" };
  }

  const commentUrl = `https://news.ycombinator.com/item?id=${raw.id}`;
  const freshness = freshnessFor(raw.time, ctx.now);
  const remotePolicy = extractRemotePolicy(text);
  const location = extractLocation(text);
  const title = extractJobTitle(firstLine, companyName, text);

  const lead: CollectedLead = {
    companyName,
    // HN comments don't reveal a real homepage. We synthesize a stable
    // dedup key of the form `hn:<normalized-name>` so the repo's existing
    // domain-uniqueness path identifies the same company across runs
    // (CLAUDE.local.md S-3: second run must not crash on UNIQUE). TB-4's
    // proper name-aware dedup will subsume this; until then, the prefix
    // makes the synthetic origin obvious in the SQLite browser.
    domain: `hn:${normalizeForDomain(companyName)}`,
    description: text.slice(0, 300),
    directionTags: [],
    jobs: [
      {
        title,
        jobUrl: commentUrl,
        ...(location !== undefined ? { location } : {}),
        ...(remotePolicy !== undefined ? { remotePolicy } : {}),
        freshness,
      },
    ],
    contacts: extractContacts(text),
    source: {
      sourceType: "hn_who_is_hiring",
      sourceUrl: commentUrl,
      sourceTitle: ctx.postTitle,
      retrievedAt: ctx.now.toISOString(),
    },
  };

  return { kind: "ok", lead };
}

// ---- HTML normalization ----------------------------------------------------

// Replace block-level tags with newlines, then drop all remaining tags.
// HN text is overwhelmingly `<p>` for paragraph breaks; that pattern keeps
// the first-line / location-on-its-own-line semantics intact.
function stripHtml(input: string): string {
  return input
    .replace(/<\/?p\s*\/?>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// HN uses a small set of HTML entities (mostly `&#x2F;` for `/` and
// `&#x27;` for `'`). We handle numeric (decimal + hex) plus a tiny named
// table. Anything we don't recognize survives untouched — better an
// occasional stray `&foo;` in the description than data loss from a
// half-broken decoder.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    const ref = body as string;
    if (ref.startsWith("#x") || ref.startsWith("#X")) {
      const code = Number.parseInt(ref.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code) : match;
    }
    if (ref.startsWith("#")) {
      const code = Number.parseInt(ref.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[ref] ?? match;
  });
}

// Build the "domain" suffix for the synthetic hn:<name> dedup key. Lower
// case, whitespace collapsed to `-`, anything non-alphanumeric dropped so
// two cosmetic variants ("Acme AI" vs "Acme  AI!") still collide.
//
// For all-CJK (or any name with no ASCII alphanumerics), the strip would
// produce "" and EVERY such company would land on `hn:` → step 1 of TB-4's
// dedupe rule would silently merge unrelated companies. Fix #25: fall back
// to a deterministic short SHA-1 hex so distinct names get distinct keys
// while the same-spelling repeat still resolves to the same key.
export function normalizeForDomain(name: string): string {
  const stripped = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (stripped !== "") return stripped;
  return shortHash(name);
}

function shortHash(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

function safeFromCodePoint(code: number): string {
  if (code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

// ---- Field extractors ------------------------------------------------------

function firstNonEmptyLine(text: string): string {
  return text.split("\n").map((s) => s.trim()).find((s) => s !== "") ?? "";
}

// First non-empty line, sliced before the first `|`, `(`, or ` - ` delimiter.
// This works for both `Acme AI (San Francisco | REMOTE)` and prose-only
// `Beta Cloud\n\nWe're hiring...` openings.
function extractCompanyName(firstLine: string): string {
  if (!firstLine) return "";
  // Slice off the first delimiter we see. " - " (spaces around dash) so we
  // don't chop hyphenated names like "Beta-Cloud".
  const cutPoints = [
    firstLine.indexOf("|"),
    firstLine.indexOf("("),
    firstLine.indexOf(" - "),
  ].filter((i) => i >= 0);
  const cut = cutPoints.length === 0 ? firstLine.length : Math.min(...cutPoints);
  return firstLine.slice(0, cut).trim();
}

// Two-pass extraction:
//   1. Mine the first-line pipe columns after the company name. The HN
//      convention is "Company (Location | RemotePolicy) | Title | ...".
//      Skip pieces that look like a location (contain a comma), an
//      employment type (Full-time / Part-time / Contract), or a bare
//      remote-policy keyword.
//   2. Fall back to "Hiring:", "Looking for:", "Seeking" with an explicit
//      colon/space anchor in the full text. The colon requirement is what
//      stops "We are hiring across the stack" from being misread as a
//      title.
//   3. Otherwise "(see comment)".
function extractJobTitle(
  firstLine: string,
  companyName: string,
  text: string,
): string {
  const fromHeader = titleFromFirstLine(firstLine, companyName);
  if (fromHeader) return fromHeader;

  const colonMatch = text.match(
    /\b(?:hiring|looking for|seeking|wanted)\s*:\s*([^.\n|]+)/i,
  );
  if (colonMatch) {
    return cleanTitle(colonMatch[1]!);
  }

  return "(see comment)";
}

function titleFromFirstLine(firstLine: string, companyName: string): string | null {
  if (!firstLine) return null;
  // Drop the company name prefix and the optional parens block that often
  // follows it, then split on '|'.
  let rest = firstLine.slice(companyName.length);
  rest = rest.replace(/^\s*\([^)]*\)\s*/, "");
  if (!rest.includes("|") && !rest.startsWith("-")) {
    return null;
  }
  rest = rest.replace(/^[\s|-]+/, "");
  const pieces = rest
    .split("|")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  for (const piece of pieces) {
    if (looksLikeTitle(piece)) {
      return cleanTitle(piece);
    }
  }
  return null;
}

const NON_TITLE_WORDS = new Set([
  "full-time",
  "part-time",
  "contract",
  "internship",
  "intern",
  "remote",
  "remote ok",
  "fully remote",
  "onsite",
  "on-site",
  "hybrid",
  "in-office",
  "in office",
]);

function looksLikeTitle(piece: string): boolean {
  const lower = piece.toLowerCase();
  if (NON_TITLE_WORDS.has(lower)) return false;
  // Likely a location: contains a comma (e.g. "Toronto, Canada").
  if (piece.includes(",")) return false;
  // Too short to be a meaningful job title.
  if (piece.length < 4) return false;
  return true;
}

function cleanTitle(raw: string): string {
  // Truncate at " and " or "," so "Backend Engineer and Data Engineer" or
  // "Backend Engineer, Data Engineer" -> "Backend Engineer".
  const andCut = raw.search(/\s+and\s+/i);
  let trimmed = andCut >= 0 ? raw.slice(0, andCut) : raw;
  const commaCut = trimmed.indexOf(",");
  if (commaCut >= 0) trimmed = trimmed.slice(0, commaCut);
  return trimmed.replace(/\s+/g, " ").trim() || "(see comment)";
}

// Explicit "Location: …" wins. Otherwise undefined — the first-line
// metadata is already captured in evidence / companyName.
function extractLocation(text: string): string | undefined {
  const match = text.match(/\bLocation:\s*([^\n|]+)/i);
  if (!match) return undefined;
  return match[1]!.trim() || undefined;
}

// Order matters and is intentional:
//   1. ONSITE / IN-OFFICE / ON-SITE first — when a poster says "in-office
//      five days a week" they often also negate hybrid/remote in the same
//      sentence ("no remote, no hybrid"). The most restrictive label wins.
//   2. HYBRID before generic REMOTE, since "hybrid" implies partial remote
//      and a poster who said both meant hybrid.
//   3. REMOTE OK / FULLY REMOTE before bare REMOTE so the "OK" phrasing
//      still classifies. "REMOTE" by itself catches the rest.
function extractRemotePolicy(text: string): string | undefined {
  const upper = text.toUpperCase();
  if (/\bONSITE\b|\bON-SITE\b|\bIN-OFFICE\b|\bIN OFFICE\b/.test(upper))
    return "onsite";
  if (/\bHYBRID\b/.test(upper)) return "hybrid";
  if (/\bFULLY REMOTE\b/.test(upper) || /\bREMOTE OK\b/.test(upper))
    return "remote";
  if (/\bREMOTE\b/.test(upper)) return "remote";
  return undefined;
}

const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const GITHUB_RE = /\bgithub\.com\/[\w-]+(?:\/[\w-]+)?\b/gi;
const LINKEDIN_RE = /\blinkedin\.com\/in\/[\w-]+\b/gi;

function extractContacts(text: string): CollectedContact[] {
  const contacts: CollectedContact[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(EMAIL_RE)) {
    const value = m[0];
    if (seen.has(value)) continue;
    seen.add(value);
    contacts.push({ contactType: "email", value, riskLevel: "low" });
  }
  for (const m of text.matchAll(LINKEDIN_RE)) {
    const value = m[0].toLowerCase();
    if (seen.has(value)) continue;
    seen.add(value);
    contacts.push({
      contactType: "linkedin",
      value,
      profileUrl: `https://${value}`,
      riskLevel: "medium",
    });
  }
  for (const m of text.matchAll(GITHUB_RE)) {
    const value = m[0].toLowerCase();
    if (seen.has(value)) continue;
    seen.add(value);
    contacts.push({
      contactType: "github",
      value,
      profileUrl: `https://${value}`,
      riskLevel: "medium",
    });
  }
  return contacts;
}

function freshnessFor(timeSec: number | undefined, now: Date): FreshnessStatus {
  if (typeof timeSec !== "number" || !Number.isFinite(timeSec)) {
    return "unknown";
  }
  // pr-review #23 M2: time=0 is the Unix epoch — clearly a bogus HN value
  // (no real comment was posted in 1970). Without this guard the age would
  // compute to ~56 years and the job would be silently labelled `stale`.
  if (timeSec <= 0) return "unknown";
  const ageDays = (now.getTime() - timeSec * 1000) / (1000 * 60 * 60 * 24);
  if (ageDays < 0) return "fresh"; // future-dated posts shouldn't kill the run
  if (ageDays <= FRESH_DAYS) return "fresh";
  if (ageDays <= USABLE_DAYS) return "usable";
  return "stale";
}
