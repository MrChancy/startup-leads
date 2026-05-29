// Public types for the shared HTTP client.
//
// Kept intentionally minimal: collectors only need to GET a URL and read the
// body. JSON parsing, encoding, etc. are the caller's problem.

export interface HttpOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HttpClient {
  get(url: string, opts?: HttpOptions): Promise<HttpResponse>;
}

// Typed errors so downstream collectors (TB-3b, TB-9, TB-10) can react by
// `instanceof` instead of regex-matching `err.message` (CLAUDE.local.md I-1).
//
// Hierarchy:
//   Error
//     HttpError (any non-2xx response surfaced to the caller)
//       HttpRetryExhaustedError (429/5xx tried MAX_RETRIES+1 times and lost)
//     HttpTimeoutError (request did not complete within timeoutMs)
//
// HttpTimeoutError is intentionally NOT an HttpError — there's no status
// or body to attach.

export class HttpError extends Error {
  readonly url: string;
  readonly status: number;
  readonly body: string;

  constructor(url: string, status: number, body: string, message?: string) {
    super(
      message ??
        `HTTP ${status} from ${url}${body ? `: ${snippet(body)}` : ""}`,
    );
    this.name = "HttpError";
    this.url = url;
    this.status = status;
    this.body = body;
  }
}

export class HttpRetryExhaustedError extends HttpError {
  readonly attempts: number;
  readonly lastStatus: number;

  constructor(url: string, attempts: number, lastStatus: number, body: string) {
    super(
      url,
      lastStatus,
      body,
      `Retry exhausted after ${attempts} attempts: HTTP ${lastStatus} from ${url}${body ? `: ${snippet(body)}` : ""}`,
    );
    this.name = "HttpRetryExhaustedError";
    this.attempts = attempts;
    this.lastStatus = lastStatus;
  }
}

export class HttpTimeoutError extends Error {
  readonly url: string;
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = "HttpTimeoutError";
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

function snippet(body: string): string {
  return body.length > 200 ? `${body.slice(0, 200)}...` : body;
}
