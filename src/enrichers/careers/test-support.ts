// Shared test helpers for the careers enricher.
//
// Mirrors src/collectors/hn/test-support.ts (CLAUDE.local.md T-1) so tests
// across enrichers/collectors share one fake-http pattern.
//
// Fixtures live in ./test-fixtures and are loaded as raw strings (HTML / XML),
// not parsed JSON — careers pages and sitemaps are text, not records.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpError, type HttpClient, type HttpResponse } from "../../http/index.ts";

const FIXTURE_DIR = join(
  fileURLToPath(new URL("./test-fixtures/", import.meta.url)),
);

export function loadFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

// Each entry can be:
//   - a string         → 200 OK, body = string
//   - { status, body } → exact response
//   - an Error         → throw (HttpError / HttpRetryExhaustedError / ...)
//   - a function       → called per call, returns one of the above
export type FakeResponse =
  | string
  | { status: number; body?: string; headers?: Record<string, string> }
  | Error;

export interface UrlMap {
  [url: string]: FakeResponse | (() => FakeResponse);
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
      if (typeof resolved === "string") {
        return { status: 200, headers: {}, body: resolved };
      }
      // Match real HttpClient semantics: non-2xx throws HttpError (or the
      // already-retried HttpRetryExhaustedError if the caller scripted one
      // via the Error branch above). Tests want to script "this URL is 404"
      // ergonomically as { status: 404 }, so the fake does the conversion.
      const status = resolved.status;
      const body = resolved.body ?? "";
      if (status < 200 || status >= 300) {
        throw new HttpError(url, status, body);
      }
      return {
        status,
        headers: resolved.headers ?? {},
        body,
      };
    },
  };
  return { client, calls };
}
