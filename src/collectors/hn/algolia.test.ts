import { test, expect } from "bun:test";
import { findMonthlyPost, ALGOLIA_BASE } from "./algolia.ts";
import { loadFixture, makeFakeHttpClient } from "./test-support.ts";

const MAY_2026 = new Date("2026-05-31T00:00:00Z");

test("ALGOLIA_BASE hits /search_by_date so the current month is at the top of hits (orchestrator real-network regression)", () => {
  // Orchestrator caught: the production Algolia `/search` endpoint sorts
  // hits by relevance and returns 2015-2017 threads in the top 20, so the
  // current month was never selected on a real smoke. `/search_by_date`
  // returns hits in created_at_i desc order with the current month first.
  expect(ALGOLIA_BASE).toContain("/search_by_date");
});

test("findMonthlyPost picks the May 2026 'Who is hiring?' thread, not 'Who wants to be hired?'", async () => {
  const fixture = loadFixture<unknown>("algolia-search.json");
  const { client, calls } = makeFakeHttpClient({
    [ALGOLIA_BASE]: JSON.stringify(fixture),
  });
  const post = await findMonthlyPost({ client, reference: MAY_2026 });
  expect(post).toEqual({
    postId: "42000001",
    title: "Ask HN: Who is hiring? (May 2026)",
  });
  expect(calls).toEqual([ALGOLIA_BASE]);
});

test("findMonthlyPost returns null when no monthly thread exists yet", async () => {
  const fixture = loadFixture<unknown>("algolia-empty.json");
  const { client } = makeFakeHttpClient({
    [ALGOLIA_BASE]: JSON.stringify(fixture),
  });
  const post = await findMonthlyPost({ client, reference: MAY_2026 });
  expect(post).toBeNull();
});

test("findMonthlyPost returns null when no hit matches the reference month", async () => {
  // Hits exist but they're all April/Who-wants-to-be-hired — none is the
  // May "Who is hiring?" thread. We refuse to silently grab last month.
  const fixture = loadFixture<{ hits: unknown[] }>("algolia-search.json");
  const onlyApril = {
    hits: fixture.hits.filter((h) =>
      String((h as { title: string }).title).includes("April"),
    ),
  };
  const { client } = makeFakeHttpClient({
    [ALGOLIA_BASE]: JSON.stringify(onlyApril),
  });
  const post = await findMonthlyPost({ client, reference: MAY_2026 });
  expect(post).toBeNull();
});
