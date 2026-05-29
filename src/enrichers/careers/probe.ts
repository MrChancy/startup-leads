// Discover a careers page on a single company domain.
//
// Strategy:
//   1. Try a fixed list of conventional paths in order. Stop at the first
//      200 with non-empty body.
//   2. If no direct path returned a usable body, fetch /sitemap.xml and
//      probe whatever careers-ish URLs it lists (in order).
//   3. Surface three outcomes: found / not_found / error. The orchestrator
//      decides what to write into the sources table for each.
//
// All HTTP goes through the shared HttpClient so retries / QPS / timeout are
// handled centrally (CLAUDE.local.md W-4: real-network smoke uses the same
// path).

import {
  HttpError,
  HttpRetryExhaustedError,
  HttpTimeoutError,
  type HttpClient,
} from "../../http/index.ts";
import { parseSitemap } from "./sitemap.ts";

// Probe order is pinned by probe.test.ts so a reorder is a loud failure
// rather than a silent behaviour change.
export const CAREERS_PATHS = [
  "/careers",
  "/careers/",
  "/jobs",
  "/jobs/",
  "/work-with-us",
  "/about/careers",
  "/jobs.html",
] as const;

const SITEMAP_PATH = "/sitemap.xml";

// We cap sitemap follow-ups so a hostile sitemap with thousands of careers
// URLs can't blow our QPS budget on one company. The first hit ends the
// probe anyway; the cap only bites when every candidate also 404s.
const MAX_SITEMAP_PROBES = 5;

export type ProbeResult =
  | { kind: "found"; url: string; body: string }
  | { kind: "not_found" }
  | { kind: "error"; url: string; error: Error };

export async function probeCareersPaths(
  http: HttpClient,
  domain: string,
): Promise<ProbeResult> {
  let firstError: { url: string; error: Error } | null = null;

  for (const path of CAREERS_PATHS) {
    const url = `https://${domain}${path}`;
    const outcome = await probeOne(http, url);
    if (outcome.kind === "ok") {
      return { kind: "found", url, body: outcome.body };
    }
    if (outcome.kind === "error" && firstError === null) {
      firstError = { url, error: outcome.error };
    }
    // "miss" (404/410/empty body) just falls through to the next path.
  }

  // Direct paths all missed. Try the sitemap as a last resort.
  const sitemapUrl = `https://${domain}${SITEMAP_PATH}`;
  const sitemapOutcome = await probeOne(http, sitemapUrl);
  if (sitemapOutcome.kind === "ok") {
    const candidates = parseSitemap(sitemapOutcome.body).slice(0, MAX_SITEMAP_PROBES);
    for (const url of candidates) {
      const followUp = await probeOne(http, url);
      if (followUp.kind === "ok") {
        return { kind: "found", url, body: followUp.body };
      }
      if (followUp.kind === "error" && firstError === null) {
        firstError = { url, error: followUp.error };
      }
    }
  } else if (sitemapOutcome.kind === "error" && firstError === null) {
    firstError = { url: sitemapUrl, error: sitemapOutcome.error };
  }

  if (firstError) {
    return { kind: "error", url: firstError.url, error: firstError.error };
  }
  return { kind: "not_found" };
}

type OneOutcome =
  | { kind: "ok"; body: string }
  | { kind: "miss" }
  | { kind: "error"; error: Error };

async function probeOne(http: HttpClient, url: string): Promise<OneOutcome> {
  try {
    const res = await http.get(url);
    if (res.status >= 200 && res.status < 300 && res.body.trim() !== "") {
      return { kind: "ok", body: res.body };
    }
    // 2xx with empty body: treat as miss (would match anything as a substring).
    // 3xx: HttpClient hands us redirects through fetch already; if we see one
    // here it means the upstream chose to surface it instead of following, in
    // which case there's no body worth searching.
    return { kind: "miss" };
  } catch (err) {
    if (err instanceof HttpError && !(err instanceof HttpRetryExhaustedError)) {
      // Non-retryable 4xx that fetch's retry policy surfaced as a throw
      // (HttpClient throws HttpError for non-2xx that aren't retried). 404 /
      // 410 / 403 etc. all mean "not at this path" — keep probing.
      return { kind: "miss" };
    }
    if (
      err instanceof HttpRetryExhaustedError ||
      err instanceof HttpTimeoutError
    ) {
      return { kind: "error", error: err };
    }
    // Anything else (DNS failure surfaced through fetch, an arbitrary
    // network error, etc.) is also a probe failure. We never let a probe
    // exception kill the loop.
    return { kind: "error", error: err instanceof Error ? err : new Error(String(err)) };
  }
}
