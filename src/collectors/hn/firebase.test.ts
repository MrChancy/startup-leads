import { test, expect } from "bun:test";
import { fetchStory, fetchComment, itemUrl } from "./firebase.ts";
import { loadFixture, makeFakeHttpClient } from "./test-support.ts";

test("fetchStory returns the post item with kids list", async () => {
  const fixture = loadFixture<unknown>("firebase-post.json");
  const url = itemUrl("42000001");
  const { client, calls } = makeFakeHttpClient({
    [url]: JSON.stringify(fixture),
  });
  const post = await fetchStory(client, "42000001");
  expect(post.id).toBe(42000001);
  expect(post.title).toBe("Ask HN: Who is hiring? (May 2026)");
  expect(post.kids).toEqual([
    42000010, 42000011, 42000012, 42000013, 42000014, 42000015,
  ]);
  expect(calls).toEqual([url]);
});

test("fetchComment returns a single comment item by id", async () => {
  const fixture = loadFixture<unknown>("comment-a-pipe-format.json");
  const url = itemUrl(42000010);
  const { client } = makeFakeHttpClient({
    [url]: JSON.stringify(fixture),
  });
  const comment = await fetchComment(client, 42000010);
  expect(comment.id).toBe(42000010);
  expect(comment.type).toBe("comment");
  expect(comment.text).toContain("Acme AI");
});
