// Public surface of the shared HTTP layer.
//
// Collectors and enrichers should import from here, never from
// `./client.ts` or `./types.ts` directly.

export type { HttpClient, HttpOptions, HttpResponse } from "./types.ts";
export {
  createHttpClient,
  type HttpClientDeps,
  type FetchLike,
  type Sleep,
  type Now,
} from "./client.ts";
