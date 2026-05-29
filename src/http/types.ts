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
