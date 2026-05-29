import { test, expect } from "bun:test";
import { runCollect } from "./collect.ts";
import { createInMemoryRepository } from "../storage/index.ts";
import { createHnCollector } from "../collectors/hn/index.ts";
import { ALGOLIA_BASE } from "../collectors/hn/algolia.ts";
import { itemUrl } from "../collectors/hn/firebase.ts";
import {
  loadFixture,
  makeFakeHttpClient,
  type UrlMap,
} from "../collectors/hn/test-support.ts";

// CLAUDE.local.md S-3 + W-1: walk the full collect happy path twice with the
// HN collector backed by fixtures. The second run must succeed (no UNIQUE
// constraint violations) and dedupe every company.

const NOW = new Date("2026-05-31T00:00:00Z");

function buildMap(): UrlMap {
  const map: UrlMap = {
    [ALGOLIA_BASE]: JSON.stringify(loadFixture("algolia-search.json")),
    [itemUrl("42000001")]: JSON.stringify(loadFixture("firebase-post.json")),
  };
  for (const { id, file } of [
    { id: 42000010, file: "comment-a-pipe-format.json" },
    { id: 42000011, file: "comment-b-prose.json" },
    { id: 42000012, file: "comment-c-onsite.json" },
    { id: 42000013, file: "comment-d-no-time.json" },
    { id: 42000014, file: "comment-e-multi-role.json" },
    { id: 42000015, file: "comment-f-deleted.json" },
  ]) {
    map[itemUrl(id)] = JSON.stringify(loadFixture(file));
  }
  return map;
}

test("runCollect with HN collector: first run stores 5 leads + 1 parse_failed", async () => {
  const { repo } = createInMemoryRepository();
  const collector = createHnCollector({
    client: makeFakeHttpClient(buildMap()).client,
    now: () => NOW,
  });

  const result = await runCollect({ repo, collector, limit: 50 });
  expect(result.counts.candidates).toBe(5);
  expect(result.counts.stored).toBe(5);
  expect(result.counts.deduped).toBe(0);
  expect(result.counts.parseFailed).toBe(1);
  expect(result.counts.fetchFailed).toBe(0);
});

test("runCollect with HN collector: second run dedupes every company (S-3)", async () => {
  // CLAUDE.local.md S-3: a second `collect` against the same repo must not
  // crash. Because each HN lead carries a synthetic `hn:<name>` domain
  // (see parse.ts), the existing domain-based dedup in upsertCollectedLead
  // recognises every repeat company.
  const { repo } = createInMemoryRepository();
  const collector = createHnCollector({
    client: makeFakeHttpClient(buildMap()).client,
    now: () => NOW,
  });

  const first = await runCollect({ repo, collector, limit: 50 });
  expect(first.counts.stored).toBe(5);
  expect(first.counts.deduped).toBe(0);

  const second = await runCollect({
    repo,
    collector: createHnCollector({
      client: makeFakeHttpClient(buildMap()).client,
      now: () => NOW,
    }),
    limit: 50,
  });
  expect(second.counts.candidates).toBe(5);
  expect(second.counts.stored).toBe(0);
  expect(second.counts.deduped).toBe(5);
  expect(second.counts.parseFailed).toBe(1);
  expect(second.counts.fetchFailed).toBe(0);
});
