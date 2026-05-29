import { test, expect } from "bun:test";
import {
  normalizeForDomain,
  parseComment,
  type FirebaseCommentItem,
} from "./parse.ts";
import { loadFixture } from "./test-support.ts";

// --- normalizeForDomain — issue #25 CJK collision fix ----------------------

test("normalizeForDomain ASCII names go through the strip path unchanged", () => {
  expect(normalizeForDomain("ByteDance")).toBe("bytedance");
  expect(normalizeForDomain("Acme  AI!")).toBe("acme-ai");
});

test("normalizeForDomain all-CJK names produce a non-empty deterministic key (issue #25)", () => {
  // Before #25: every all-CJK name → "" → domain="hn:" → step 1 silently
  // merged unrelated companies. After: distinct names → distinct hash keys.
  const a = normalizeForDomain("字节跳动");
  const b = normalizeForDomain("智谱");
  expect(a).not.toBe("");
  expect(b).not.toBe("");
  expect(a).not.toBe(b);
  // Same input must always produce the same key (S-3 idempotency).
  expect(normalizeForDomain("字节跳动")).toBe(a);
});

test("normalizeForDomain all-punctuation names also fall back to a hash, not empty", () => {
  // Same defect class as the CJK case: stripped string is "". TB-3b
  // follow-up #23 L4 documented the empty collision.
  expect(normalizeForDomain("!!!")).not.toBe("");
  expect(normalizeForDomain("!!!")).not.toBe(normalizeForDomain("???"));
});

// Deterministic "now" used to bucket freshness in every parser test. Picked
// to be > Fixture C's 60-day-old timestamp so that comment lands in usable
// (31-180 days), and < Fixture A's 1-day-old so that one lands in fresh.
const NOW = new Date("2026-05-31T00:00:00Z");

const POST_TITLE = "Ask HN: Who is hiring? (May 2026)";

test("parseComment A: pipe-separated header with REMOTE OK and email", () => {
  const raw = loadFixture<FirebaseCommentItem>("comment-a-pipe-format.json");
  const result = parseComment(raw, { postTitle: POST_TITLE, now: NOW });
  if (result.kind !== "ok") {
    throw new Error(`expected ok, got ${result.kind}: ${result.reason}`);
  }
  const { lead } = result;
  expect(lead.companyName).toBe("Acme AI");
  // Synthetic dedup key — see parse.ts normalizeForDomain.
  expect(lead.domain).toBe("hn:acme-ai");
  expect(lead.jobs).toHaveLength(1);
  expect(lead.jobs[0]!.title).toBe("Backend Engineer");
  expect(lead.jobs[0]!.remotePolicy).toBe("remote");
  expect(lead.jobs[0]!.freshness).toBe("fresh");
  expect(lead.jobs[0]!.jobUrl).toBe(
    "https://news.ycombinator.com/item?id=42000010",
  );
  // Email contact captured at low risk; HTML entities decoded.
  const email = lead.contacts.find((c) => c.contactType === "email");
  expect(email?.value).toBe("jobs@acme.ai");
  expect(email?.riskLevel).toBe("low");
  // Source metadata wired through.
  expect(lead.source.sourceType).toBe("hn_who_is_hiring");
  expect(lead.source.sourceUrl).toBe(
    "https://news.ycombinator.com/item?id=42000010",
  );
  expect(lead.source.sourceTitle).toBe(POST_TITLE);
  // evidence snippet is plain text (HTML stripped, entities decoded).
  expect(lead.description).toContain("Backend Engineer");
  expect(lead.description).not.toContain("&#x");
  expect(lead.description).not.toContain("<p>");
});

test("parseComment B: prose-only header with linkedin profile and location label", () => {
  const raw = loadFixture<FirebaseCommentItem>("comment-b-prose.json");
  const result = parseComment(raw, { postTitle: POST_TITLE, now: NOW });
  if (result.kind !== "ok") {
    throw new Error(`expected ok, got ${result.kind}`);
  }
  const { lead } = result;
  expect(lead.companyName).toBe("Beta Cloud");
  // No explicit "Hiring: <title>" so title falls back to "(see comment)".
  expect(lead.jobs[0]!.title).toBe("(see comment)");
  expect(lead.jobs[0]!.location).toBe("Berlin, Germany (hybrid OK)");
  expect(lead.jobs[0]!.remotePolicy).toBe("hybrid");
  const linkedin = lead.contacts.find((c) => c.contactType === "linkedin");
  expect(linkedin?.value).toBe("linkedin.com/in/beta-recruiting");
  expect(linkedin?.riskLevel).toBe("medium");
});

test("parseComment C: ONSITE keyword + github profile maps to onsite + medium-risk github", () => {
  const raw = loadFixture<FirebaseCommentItem>("comment-c-onsite.json");
  const result = parseComment(raw, { postTitle: POST_TITLE, now: NOW });
  if (result.kind !== "ok") {
    throw new Error(`expected ok, got ${result.kind}`);
  }
  const { lead } = result;
  expect(lead.companyName).toBe("Gamma Labs");
  expect(lead.jobs[0]!.remotePolicy).toBe("onsite");
  // 60 days old -> usable (31-180 day band).
  expect(lead.jobs[0]!.freshness).toBe("usable");
  // "Looking for: Senior Site Reliability Engineer" -> matched by regex.
  expect(lead.jobs[0]!.title.toLowerCase()).toContain("site reliability");
  const gh = lead.contacts.find((c) => c.contactType === "github");
  expect(gh?.value).toBe("github.com/gamma-labs");
  expect(gh?.riskLevel).toBe("medium");
});

test("parseComment D: comment without time gets freshness=unknown", () => {
  const raw = loadFixture<FirebaseCommentItem>("comment-d-no-time.json");
  const result = parseComment(raw, { postTitle: POST_TITLE, now: NOW });
  if (result.kind !== "ok") {
    throw new Error(`expected ok, got ${result.kind}`);
  }
  expect(result.lead.jobs[0]!.freshness).toBe("unknown");
});

test("parseComment E: multi-role posting picks the first title (v1 simplification)", () => {
  const raw = loadFixture<FirebaseCommentItem>("comment-e-multi-role.json");
  const result = parseComment(raw, { postTitle: POST_TITLE, now: NOW });
  if (result.kind !== "ok") {
    throw new Error(`expected ok, got ${result.kind}`);
  }
  const { lead } = result;
  expect(lead.companyName).toBe("Epsilon Robotics");
  // v1 keeps it at 1 job; the title comes from the first match after
  // "Hiring:".
  expect(lead.jobs).toHaveLength(1);
  expect(lead.jobs[0]!.title.toLowerCase()).toContain("backend");
  // Hybrid label in the first line is detected even without "Location:".
  expect(lead.jobs[0]!.remotePolicy).toBe("hybrid");
  // Both email and linkedin contacts captured.
  expect(lead.contacts.find((c) => c.contactType === "email")?.value).toBe(
    "hiring@epsilon.dev",
  );
  expect(
    lead.contacts.find((c) => c.contactType === "linkedin")?.value,
  ).toBe("linkedin.com/in/epsilon-recruit");
});

test("parseComment F: deleted comment is reported as parse_failed (not a thrown error)", () => {
  const raw = loadFixture<FirebaseCommentItem>("comment-f-deleted.json");
  const result = parseComment(raw, { postTitle: POST_TITLE, now: NOW });
  expect(result.kind).toBe("parse_failed");
  if (result.kind === "parse_failed") {
    expect(result.reason).toMatch(/deleted/i);
  }
});

test("parseComment treats blank text as parse_failed", () => {
  const result = parseComment(
    { id: 99, type: "comment", time: 1780012800, text: "   <p>  </p>" },
    { postTitle: POST_TITLE, now: NOW },
  );
  expect(result.kind).toBe("parse_failed");
});

test("parseComment treats empty company name as parse_failed", () => {
  // text strips to an empty first line followed by content. companyName
  // extraction returns "" -> parse_failed.
  const result = parseComment(
    { id: 100, type: "comment", time: 1780012800, text: "<p>(  )<p>some body text here" },
    { postTitle: POST_TITLE, now: NOW },
  );
  expect(result.kind).toBe("parse_failed");
});
