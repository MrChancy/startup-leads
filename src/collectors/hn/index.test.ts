import { test, expect } from "bun:test";
import { createHnCollector, HN_SOURCE } from "./index.ts";
import { ALGOLIA_BASE } from "./algolia.ts";
import { itemUrl } from "./firebase.ts";
import { loadFixture, makeFakeHttpClient, type UrlMap } from "./test-support.ts";
import { HttpError } from "../../http/index.ts";

// Pinned to the same clock as the fixtures so freshness buckets are
// deterministic across runs.
const NOW = new Date("2026-05-31T00:00:00Z");

const KID_FIXTURES: Array<{ id: number; file: string }> = [
  { id: 42000010, file: "comment-a-pipe-format.json" },
  { id: 42000011, file: "comment-b-prose.json" },
  { id: 42000012, file: "comment-c-onsite.json" },
  { id: 42000013, file: "comment-d-no-time.json" },
  { id: 42000014, file: "comment-e-multi-role.json" },
  { id: 42000015, file: "comment-f-deleted.json" },
];

function buildMap(extra: UrlMap = {}): UrlMap {
  const map: UrlMap = {
    [ALGOLIA_BASE]: JSON.stringify(loadFixture("algolia-search.json")),
    [itemUrl("42000001")]: JSON.stringify(loadFixture("firebase-post.json")),
  };
  for (const { id, file } of KID_FIXTURES) {
    map[itemUrl(id)] = JSON.stringify(loadFixture(file));
  }
  return { ...map, ...extra };
}

test("collect end-to-end: 6 kids -> 5 leads + 1 parse_failed, 0 fetch_failed", async () => {
  const { client } = makeFakeHttpClient(buildMap());
  const collector = createHnCollector({ client, now: () => NOW });
  expect(collector.source).toBe(HN_SOURCE);

  const result = await collector.collect({ limit: 50 });
  expect(result.leads.map((l) => l.companyName)).toEqual([
    "Acme AI",
    "Beta Cloud",
    "Gamma Labs",
    "Delta AI",
    "Epsilon Robotics",
  ]);
  expect(result.parseFailed).toBe(1); // fixture F (deleted)
  expect(result.fetchFailed).toBe(0);
  // Every lead carries the HN source metadata.
  for (const lead of result.leads) {
    expect(lead.source.sourceType).toBe(HN_SOURCE);
    expect(lead.source.sourceTitle).toBe(
      "Ask HN: Who is hiring? (May 2026)",
    );
    expect(lead.source.sourceUrl).toMatch(
      /^https:\/\/news\.ycombinator\.com\/item\?id=\d+$/,
    );
  }
});

test("collect respects --limit: only fetches the first N kids", async () => {
  const { client, calls } = makeFakeHttpClient(buildMap());
  const collector = createHnCollector({ client, now: () => NOW });

  const result = await collector.collect({ limit: 3 });
  // The first 3 kids are A, B, C — all parse cleanly.
  expect(result.leads).toHaveLength(3);
  expect(result.parseFailed).toBe(0);
  // Calls: Algolia + story + 3 comment fetches = 5 total.
  expect(calls).toHaveLength(5);
  // Last call must be comment 42000012 (the 3rd kid), proving we stopped.
  expect(calls[calls.length - 1]).toBe(itemUrl(42000012));
});

test("collect counts a fetch_failed comment without aborting the run", async () => {
  // Make the second kid (Beta Cloud) blow up. The other 5 kids should
  // still complete; we expect 4 successful leads (A,C,D,E) + 1 parse_failed
  // (F) + 1 fetch_failed (B).
  const map = buildMap({
    [itemUrl(42000011)]: new HttpError(itemUrl(42000011), 500, "internal"),
  });
  const { client } = makeFakeHttpClient(map);
  const collector = createHnCollector({ client, now: () => NOW });

  const result = await collector.collect({ limit: 50 });
  expect(result.leads.map((l) => l.companyName)).toEqual([
    "Acme AI",
    "Gamma Labs",
    "Delta AI",
    "Epsilon Robotics",
  ]);
  expect(result.parseFailed).toBe(1);
  expect(result.fetchFailed).toBe(1);
});

test("collect is deterministic across two consecutive runs (S-3)", async () => {
  // CLAUDE.local.md S-3: walking skeleton happy path must succeed twice.
  // The fake HTTP layer + injected `now` give us a fully deterministic
  // pipeline, so the second run must produce byte-identical leads.
  const collector = createHnCollector({
    client: makeFakeHttpClient(buildMap()).client,
    now: () => NOW,
  });
  const first = await collector.collect({ limit: 50 });

  const second = await createHnCollector({
    client: makeFakeHttpClient(buildMap()).client,
    now: () => NOW,
  }).collect({ limit: 50 });

  expect(second.leads).toEqual(first.leads);
  expect(second.parseFailed).toBe(first.parseFailed);
  expect(second.fetchFailed).toBe(first.fetchFailed);
});

test("collect returns 0 leads (not an error) when no monthly thread exists yet", async () => {
  // I-2: "no current-month thread" is a real outcome at the start of the
  // month, not a failure. We log a warning and return empty.
  const { client } = makeFakeHttpClient({
    [ALGOLIA_BASE]: JSON.stringify(loadFixture("algolia-empty.json")),
  });
  const warnLines: string[] = [];
  const collector = createHnCollector({
    client,
    now: () => NOW,
    warn: (line) => warnLines.push(line),
  });

  const result = await collector.collect({ limit: 50 });
  expect(result).toEqual({ leads: [], parseFailed: 0, fetchFailed: 0 });
  expect(warnLines).toHaveLength(1);
  expect(warnLines[0]).toMatch(/no monthly thread/i);
});

test("collect lets Algolia errors bubble (no post = nothing to do)", async () => {
  const { client } = makeFakeHttpClient({
    [ALGOLIA_BASE]: new HttpError(ALGOLIA_BASE, 503, "service unavailable"),
  });
  const collector = createHnCollector({ client, now: () => NOW });
  await expect(collector.collect({ limit: 50 })).rejects.toThrow();
});
