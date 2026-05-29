// Shared test helpers for the HttpClient.
//
// Tests inject these fakes via `createHttpClient({ fetch, sleep, now, env })`
// so they never touch the network and never wait on real wall-clock time.

export interface FetchCall {
  url: string;
  init: RequestInit | undefined;
  headers: Record<string, string>;
}

export interface ScriptedResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

export interface FakeFetch {
  fn: (input: string, init?: RequestInit) => Promise<Response>;
  calls: FetchCall[];
}

// Builds a fetch stub that returns responses[i] for call i. After the
// scripted responses run out, further calls fail loudly so a test never
// silently relies on production behaviour.
export function createFakeFetch(responses: ScriptedResponse[]): FakeFetch {
  const calls: FetchCall[] = [];
  let i = 0;
  const fn = async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input, init, headers: extractHeaders(init?.headers) });
    const scripted = responses[i++];
    if (!scripted) {
      throw new Error(`fake fetch: no scripted response for call #${i} (${input})`);
    }
    return new Response(scripted.body ?? "", {
      status: scripted.status,
      headers: scripted.headers ?? {},
    });
  };
  return { fn, calls };
}

export interface FakeClock {
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  sleeps: number[];
  // Manually advance the virtual clock without enqueuing a sleeper. Useful
  // for tests that want to simulate time passing between requests without
  // a real sleep call.
  advance: (ms: number) => void;
}

interface Waiter {
  until: number;
  resolve: () => void;
}

// Virtual clock + queueable sleep. `sleep(ms)` returns a promise that
// resolves only after the clock advances past the requested duration (or
// the optional signal aborts). `now()` reads the virtual clock so the
// rate limiter sees the same time the test sees.
export function createFakeClock(startMs = 0): FakeClock {
  let current = startMs;
  const waiters: Waiter[] = [];
  const sleeps: number[] = [];

  function advance(ms: number) {
    current += ms;
    drain();
  }

  function drain() {
    // Resolve in chronological order; a resolved waiter may unblock code
    // that schedules more sleeps, so loop until nothing more is due.
    let progress = true;
    while (progress) {
      progress = false;
      for (let i = 0; i < waiters.length; i++) {
        const w = waiters[i]!;
        if (w.until <= current) {
          waiters.splice(i, 1);
          w.resolve();
          progress = true;
          break;
        }
      }
    }
  }

  return {
    now: () => current,
    sleep: (ms, signal) => {
      sleeps.push(ms);
      if (ms <= 0 || signal?.aborted) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const waiter: Waiter = { until: current + ms, resolve };
        waiters.push(waiter);
        if (signal) {
          signal.addEventListener(
            "abort",
            () => {
              const idx = waiters.indexOf(waiter);
              if (idx !== -1) {
                waiters.splice(idx, 1);
              }
              resolve();
            },
            { once: true },
          );
        }
      });
    },
    sleeps,
    advance,
  };
}

// Yield enough times that any reasonable chain of `.then` callbacks
// pending on the microtask queue gets a chance to run. Tests use this
// instead of arbitrary `setTimeout(0)` to keep things deterministic.
export async function flushMicrotasks(times = 10) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function extractHeaders(input: RequestInit["headers"]): Record<string, string> {
  if (!input) {
    return {};
  }
  if (input instanceof Headers) {
    const out: Record<string, string> = {};
    input.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(input)) {
    return Object.fromEntries(input);
  }
  return { ...(input as Record<string, string>) };
}
