// Shared test helpers for the GitHub enricher.
//
// Mirrors src/enrichers/careers/test-support.ts (T-1) — same FakeResponse
// shape, same UrlMap signature — so a future shared-test-support extraction
// is a rename, not a redesign. The one extension: github calls also assert
// against the `Authorization` header, so the fake records the headers it
// saw, not just the URL.
//
// Fixtures live in ./test-fixtures and are loaded raw — they are JSON
// strings on the wire; the enricher parses them itself.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HttpError,
  type HttpClient,
  type HttpOptions,
  type HttpResponse,
} from "../../http/index.ts";

const FIXTURE_DIR = join(
  fileURLToPath(new URL("./test-fixtures/", import.meta.url)),
);

export function loadFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

export type FakeResponse =
  | string
  | {
      status: number;
      body?: string;
      headers?: Record<string, string>;
    }
  | Error;

export interface UrlMap {
  [url: string]: FakeResponse | (() => FakeResponse);
}

export interface FakeCall {
  url: string;
  headers: Record<string, string>;
}

export interface FakeHttpClient {
  client: HttpClient;
  calls: FakeCall[];
}

export function makeFakeHttpClient(map: UrlMap): FakeHttpClient {
  const calls: FakeCall[] = [];
  const client: HttpClient = {
    async get(url: string, opts: HttpOptions = {}): Promise<HttpResponse> {
      calls.push({ url, headers: opts.headers ?? {} });
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
      const status = resolved.status;
      const body = resolved.body ?? "";
      if (status < 200 || status >= 300) {
        // Surface as HttpError, matching the real HttpClient's behaviour for
        // non-2xx that isn't 429/5xx-retried. Tests that need the retry
        // wrapper script HttpRetryExhaustedError via the Error branch above.
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
