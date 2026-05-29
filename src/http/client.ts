// Shared HttpClient implementation.
//
// All collectors and enrichers go through this so we have one place that
// owns: User-Agent, timeout, global QPS limit, and retry/backoff on
// transient HTTP failures.
//
// Network and clock are injected so tests stay offline and instant. See
// `test-support.ts` for the fake implementations.

import pkg from "../../package.json" with { type: "json" };
import type { HttpClient, HttpOptions, HttpResponse } from "./types.ts";
import {
  HttpError,
  HttpRetryExhaustedError,
  HttpTimeoutError,
} from "./types.ts";

const DEFAULT_USER_AGENT = `startup-leads/${pkg.version} (+local research tool)`;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_QPS = 1;
const MAX_RETRIES = 3;
const BACKOFF_MS = [1_000, 2_000, 4_000];
const QPS_ENV_VAR = "STARTUP_LEADS_HTTP_QPS";

// Sleep accepts an optional AbortSignal so callers can cancel a pending
// timer (notably the request timeout, which is shed as soon as fetch
// resolves). Implementations must resolve immediately on abort so the
// surrounding promise can settle and any allocated timer is cleared.
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
export type Now = () => number;
// `init` mirrors `globalThis.fetch` (optional) so wrapping the platform fetch
// doesn't require a widening cast. Internal call sites always pass init.
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientDeps {
  fetch?: FetchLike;
  sleep?: Sleep;
  now?: Now;
  env?: Record<string, string | undefined>;
  userAgent?: string;
}

export function createHttpClient(deps: HttpClientDeps = {}): HttpClient {
  const fetchImpl: FetchLike = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const userAgent = deps.userAgent ?? DEFAULT_USER_AGENT;
  const intervalMs = resolveIntervalMs(env);
  const limiter = createRateLimiter(intervalMs, sleep, now);

  async function get(url: string, opts: HttpOptions = {}): Promise<HttpResponse> {
    const headers = {
      "User-Agent": userAgent,
      ...(opts.headers ?? {}),
    };
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Up to MAX_RETRIES retries means MAX_RETRIES + 1 attempts total. We
    // re-acquire the rate limiter for every attempt so retries also
    // respect the QPS budget.
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await limiter.acquire();
      const response = await fetchWithTimeout(fetchImpl, sleep, url, headers, timeoutMs);

      if (response.ok) {
        return {
          status: response.status,
          headers: headersToObject(response.headers),
          body: await response.text(),
        };
      }

      const retryable = isRetryable(response.status);
      const body = await response.text().catch(() => "");

      if (!retryable) {
        throw new HttpError(url, response.status, body);
      }
      if (attempt === MAX_RETRIES) {
        throw new HttpRetryExhaustedError(
          url,
          MAX_RETRIES + 1,
          response.status,
          body,
        );
      }

      const delay = BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;
      await sleep(delay);
    }

    // Unreachable: the loop either returns or throws on every iteration.
    throw new Error(`HttpClient.get retry loop fell through for ${url}`);
  }

  return { get };
}

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

// Per CLAUDE.local.md A-3: distinguish "env var absent" (fall back to
// default) from "env var present but invalid" (the user explicitly
// misconfigured us; fail loud rather than silently use the default).
function resolveIntervalMs(env: Record<string, string | undefined>): number {
  const raw = env[QPS_ENV_VAR];
  if (raw === undefined) {
    return 1_000 / DEFAULT_QPS;
  }
  const qps = Number.parseFloat(raw);
  if (raw.trim() === "" || !Number.isFinite(qps) || qps <= 0) {
    throw new Error(
      `${QPS_ENV_VAR} must be a positive number (got ${JSON.stringify(raw)})`,
    );
  }
  return 1_000 / qps;
}

interface RateLimiter {
  acquire(): Promise<void>;
}

// Single global limiter shared across all `get` calls on this client.
// We serialize through a promise chain so concurrent acquirers queue in
// FIFO order; each waiter then sleeps just long enough for the configured
// interval to elapse since the previous request was admitted.
function createRateLimiter(intervalMs: number, sleep: Sleep, now: Now): RateLimiter {
  let chain: Promise<void> = Promise.resolve();
  let lastAdmittedAt = -Infinity;

  return {
    acquire() {
      const mine = chain.then(async () => {
        const wait = lastAdmittedAt + intervalMs - now();
        if (wait > 0) {
          await sleep(wait);
        }
        lastAdmittedAt = now();
      });
      // A rejection here would poison every future acquirer; the sleep we
      // use cannot reject in practice, but defensively detach the chain
      // from any error path.
      chain = mine.catch(() => undefined);
      return mine;
    },
  };
}

// Implements the request timeout on top of an injected `sleep` so tests can
// drive it via a virtual clock. We race fetch vs. sleep; whichever wins
// settles the call, and the loser is cancelled via AbortController.
async function fetchWithTimeout(
  fetchImpl: FetchLike,
  sleep: Sleep,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  const abortFetch = new AbortController();
  const cancelTimer = new AbortController();
  let timedOut = false;
  const timer = sleep(timeoutMs, cancelTimer.signal).then(() => {
    if (!cancelTimer.signal.aborted) {
      timedOut = true;
      abortFetch.abort();
    }
  });

  try {
    return await fetchImpl(url, { method: "GET", headers, signal: abortFetch.signal });
  } catch (err) {
    if (timedOut) {
      throw new HttpTimeoutError(url, timeoutMs);
    }
    throw err;
  } finally {
    // Cancel the still-pending timer so we don't leak it. Don't await the
    // resulting promise: the default sleep clears the underlying
    // setTimeout synchronously on abort, so there's nothing dangling.
    cancelTimer.abort();
    // Attach a no-op handler so any (extremely unlikely) rejection on the
    // detached sleep doesn't produce an unhandled-rejection warning.
    timer.catch(() => undefined);
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    }
  });
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}
