import { test, expect } from "bun:test";
import pkg from "../../package.json" with { type: "json" };
import { createHttpClient } from "./client.ts";
import type { HttpClient } from "./types.ts";
import { createFakeClock, createFakeFetch, flushMicrotasks } from "./test-support.ts";

test("createHttpClient returns an HttpClient with a get method", () => {
  const client: HttpClient = createHttpClient();
  expect(typeof client.get).toBe("function");
});

test("the same client instance handles repeated sequential gets", async () => {
  const fetch = createFakeFetch([
    { status: 200, body: "a" },
    { status: 200, body: "b" },
    { status: 200, body: "c" },
  ]);
  const clock = createFakeClock();
  const client = createHttpClient({
    fetch: fetch.fn,
    sleep: clock.sleep,
    now: clock.now,
    env: {},
  });

  const r1 = await client.get("https://example.com/a");
  clock.advance(1_000);
  const r2 = await client.get("https://example.com/b");
  clock.advance(1_000);
  const r3 = await client.get("https://example.com/c");
  expect([r1.body, r2.body, r3.body]).toEqual(["a", "b", "c"]);
  expect(fetch.calls).toHaveLength(3);
});

test("three concurrent gets are admitted one interval apart", async () => {
  const fetch = createFakeFetch([
    { status: 200, body: "1" },
    { status: 200, body: "2" },
    { status: 200, body: "3" },
  ]);
  const clock = createFakeClock();
  const client = createHttpClient({
    fetch: fetch.fn,
    sleep: clock.sleep,
    now: clock.now,
    env: {},
  });

  const p1 = client.get("https://example.com/1");
  const p2 = client.get("https://example.com/2");
  const p3 = client.get("https://example.com/3");

  await p1;
  expect(fetch.calls).toHaveLength(1);

  clock.advance(1_000);
  await p2;
  expect(fetch.calls).toHaveLength(2);

  clock.advance(1_000);
  await p3;
  expect(fetch.calls).toHaveLength(3);
});

test("non-retryable 4xx (404) throws immediately without retry", async () => {
  const fetch = createFakeFetch([{ status: 404, body: "not found" }]);
  const clock = createFakeClock();
  const client = createHttpClient({
    fetch: fetch.fn,
    sleep: clock.sleep,
    now: clock.now,
    env: {},
  });

  const err = await client.get("https://example.com/missing").catch((e: Error) => e);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toMatch(/404/);
  expect(fetch.calls).toHaveLength(1);
});

test("stops after 3 retries (4 attempts total) and throws", async () => {
  const fetch = createFakeFetch([
    { status: 429 },
    { status: 429 },
    { status: 429 },
    { status: 429 },
    // No 5th scripted response — if the client calls again, the fake
    // will throw "no scripted response" and the test will catch it.
  ]);
  const clock = createFakeClock();
  const sleeps: number[] = [];
  const client = createHttpClient({
    fetch: fetch.fn,
    sleep: (ms, signal) => {
      sleeps.push(ms);
      return clock.sleep(ms, signal);
    },
    now: clock.now,
    env: {},
  });

  const pending = client.get("https://example.com/").catch((err: Error) => err);
  for (let i = 0; i < 6; i++) {
    clock.advance(10_000);
    await flushMicrotasks();
  }
  const result = await pending;
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toMatch(/429/);
  expect(fetch.calls).toHaveLength(4);
  const backoffSleeps = sleeps.filter((ms) => ms === 1_000 || ms === 2_000 || ms === 4_000);
  expect(backoffSleeps).toEqual([1_000, 2_000, 4_000]);
});

test("retries 429 and 503 with 1s / 2s / 4s exponential backoff", async () => {
  const fetch = createFakeFetch([
    { status: 429 },
    { status: 503 },
    { status: 200, body: "finally" },
  ]);
  const clock = createFakeClock();
  const sleeps: number[] = [];
  const client = createHttpClient({
    fetch: fetch.fn,
    sleep: (ms, signal) => {
      sleeps.push(ms);
      return clock.sleep(ms, signal);
    },
    now: clock.now,
    env: {},
  });

  const pending = client.get("https://example.com/");
  // Drive each backoff to completion. We just push the clock forward by
  // 10s between flushes; the limiter + retry sleeps will settle.
  for (let i = 0; i < 5; i++) {
    clock.advance(10_000);
    await flushMicrotasks();
  }
  const result = await pending;
  expect(result.status).toBe(200);
  expect(result.body).toBe("finally");
  expect(fetch.calls).toHaveLength(3);
  // The backoff sleeps must include 1s, 2s, 4s in that order (other
  // sleeps come from the rate limiter; we just check the backoff entries
  // are present in order).
  const backoffSleeps = sleeps.filter((ms) => ms === 1_000 || ms === 2_000 || ms === 4_000);
  expect(backoffSleeps).toEqual([1_000, 2_000]);
});

test("STARTUP_LEADS_HTTP_QPS overrides the default rate", async () => {
  const fetch = createFakeFetch([
    { status: 200, body: "a" },
    { status: 200, body: "b" },
  ]);
  const clock = createFakeClock();
  const client = createHttpClient({
    fetch: fetch.fn,
    sleep: clock.sleep,
    now: clock.now,
    env: { STARTUP_LEADS_HTTP_QPS: "10" }, // 10 req/s -> 100 ms interval
  });

  const a = client.get("https://example.com/a");
  const b = client.get("https://example.com/b");
  await a;
  expect(fetch.calls).toHaveLength(1);

  clock.advance(99);
  await flushMicrotasks();
  expect(fetch.calls).toHaveLength(1);

  clock.advance(1);
  await b;
  expect(fetch.calls).toHaveLength(2);
});

test("STARTUP_LEADS_HTTP_QPS rejects empty / non-positive values", () => {
  expect(() =>
    createHttpClient({ env: { STARTUP_LEADS_HTTP_QPS: "" } }),
  ).toThrow(/STARTUP_LEADS_HTTP_QPS/);
  expect(() =>
    createHttpClient({ env: { STARTUP_LEADS_HTTP_QPS: "0" } }),
  ).toThrow(/STARTUP_LEADS_HTTP_QPS/);
  expect(() =>
    createHttpClient({ env: { STARTUP_LEADS_HTTP_QPS: "abc" } }),
  ).toThrow(/STARTUP_LEADS_HTTP_QPS/);
});

test("concurrent gets are serialized at the default 1 req/s rate", async () => {
  const fetch = createFakeFetch([
    { status: 200, body: "first" },
    { status: 200, body: "second" },
  ]);
  const clock = createFakeClock();
  const client = createHttpClient({
    fetch: fetch.fn,
    sleep: clock.sleep,
    now: clock.now,
    env: {},
  });

  const a = client.get("https://example.com/a");
  const b = client.get("https://example.com/b");

  // Let the first request through.
  await a;
  // The second request must be queued behind the rate limiter.
  expect(fetch.calls).toHaveLength(1);

  // 999 ms is not enough.
  clock.advance(999);
  await flushMicrotasks();
  expect(fetch.calls).toHaveLength(1);

  // At 1 000 ms total it should be released.
  clock.advance(1);
  await b;
  expect(fetch.calls).toHaveLength(2);
});

test("get aborts the fetch after the default 10s timeout", async () => {
  const clock = createFakeClock();
  // A fake fetch that never resolves on its own — only the abort signal
  // can settle it. If the client doesn't time out, the test hangs (and
  // bun:test will eventually fail it).
  const aborts: AbortSignal[] = [];
  const fetchImpl = (_url: string, init: RequestInit) => {
    const signal = init.signal!;
    aborts.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  };

  const client = createHttpClient({
    fetch: fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
    env: {},
  });

  const pending = client.get("https://example.com/").catch((err: Error) => err);
  // Flush enough microtasks for the rate limiter and fetch dispatch to run.
  await flushMicrotasks();
  expect(aborts).toHaveLength(1);
  // 9 999 ms is not enough; the abort should fire at 10 000 ms.
  clock.advance(9_999);
  await flushMicrotasks();
  expect(aborts[0]!.aborted).toBe(false);
  clock.advance(1);
  const result = await pending;
  expect(result).toBeInstanceOf(Error);
  expect(aborts[0]!.aborted).toBe(true);
});


test("get sends the default User-Agent built from the package version", async () => {
  const fetch = createFakeFetch([{ status: 200, body: "ok" }]);
  const clock = createFakeClock();
  const client = createHttpClient({
    fetch: fetch.fn,
    sleep: clock.sleep,
    now: clock.now,
    env: {},
  });

  await client.get("https://example.com/");

  expect(fetch.calls).toHaveLength(1);
  expect(fetch.calls[0]!.headers["User-Agent"]).toBe(
    `startup-leads/${pkg.version} (+local research tool)`,
  );
});
