// Shared test helpers for the HN collector.
//
// Per CLAUDE.local.md T-1: every HN test goes through these helpers. If you
// find yourself reading a fixture file by hand from a test, add a helper here
// instead.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HttpClient, HttpResponse } from "../../http/index.ts";

const FIXTURE_DIR = join(
  fileURLToPath(new URL("./test-fixtures/", import.meta.url)),
);

// Read a JSON fixture from src/collectors/hn/test-fixtures/. Returns the
// parsed JSON object; callers cast to whatever shape they expect.
export function loadFixture<T = unknown>(name: string): T {
  const raw = readFileSync(join(FIXTURE_DIR, name), "utf8");
  return JSON.parse(raw) as T;
}

// Map URL -> (response body OR thrown error) -> deterministic fake HTTP.
// We match by exact URL so a typo in the collector immediately yells.
export interface UrlMap {
  [url: string]: string | Error | (() => string | Error);
}

export interface FakeHttpClient {
  client: HttpClient;
  calls: string[];
}

export function makeFakeHttpClient(map: UrlMap): FakeHttpClient {
  const calls: string[] = [];
  const client: HttpClient = {
    async get(url: string): Promise<HttpResponse> {
      calls.push(url);
      const entry = map[url];
      if (entry === undefined) {
        throw new Error(`fake http: no mapping for ${url}`);
      }
      const resolved = typeof entry === "function" ? entry() : entry;
      if (resolved instanceof Error) {
        throw resolved;
      }
      return {
        status: 200,
        headers: {},
        body: resolved,
      };
    },
  };
  return { client, calls };
}
