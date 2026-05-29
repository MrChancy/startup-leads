// Find the current month's "Ask HN: Who is hiring?" thread.
//
// We hit Algolia's HN index (already tagged story/author_whoishiring) and
// pick the highest-scoring hit whose title is "Who is hiring?" for the
// reference month. Algolia returns hits sorted by relevance; in practice
// the current-month thread is the first match, but we still filter by
// title so we don't accidentally select "Who wants to be hired?" or last
// month's "Who is hiring?".

import type { HttpClient } from "../../http/index.ts";

// `/search_by_date` (NOT `/search`) sorts hits by `created_at_i` desc, so the
// current-month thread lands at index 0. The relevance-default `/search`
// endpoint returns high-vote 2015-2017 threads in the top 20 and never the
// current month — that's the real-network smoke regression the orchestrator
// caught right after ts-coder's pass. The test in algolia.test.ts pins this.
export const ALGOLIA_BASE =
  "https://hn.algolia.com/api/v1/search_by_date?query=Who+is+hiring&tags=story,author_whoishiring";

export interface AlgoliaHit {
  objectID: string;
  title: string;
  created_at_i: number;
}

export interface MonthlyPost {
  postId: string;
  title: string;
}

export interface FindMonthlyPostInput {
  client: HttpClient;
  reference: Date; // typically `now`; injected for determinism in tests
}

// The 3-letter month abbreviation isn't enough — December's URL is also
// just "Dec YYYY". We use the full month name, which is how HN writes it.
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export async function findMonthlyPost(
  input: FindMonthlyPostInput,
): Promise<MonthlyPost | null> {
  const { client, reference } = input;
  const response = await client.get(ALGOLIA_BASE);
  const json = JSON.parse(response.body) as { hits?: AlgoliaHit[] };
  const hits = json.hits ?? [];
  if (hits.length === 0) return null;

  // "Ask HN: Who is hiring? (May 2026)" — case-insensitive substring match
  // on both the question phrase and the "Month YYYY" suffix. Ignoring case
  // is intentional; HN posts are inconsistent about it ("Who Is Hiring?"
  // shows up too).
  const month = MONTH_NAMES[reference.getUTCMonth()]!;
  const year = reference.getUTCFullYear();
  const needle = `${month} ${year}`.toLowerCase();

  const match = hits.find((hit) => {
    const title = hit.title.toLowerCase();
    return (
      title.includes("who is hiring") &&
      !title.includes("who wants to be hired") &&
      title.includes(needle.toLowerCase())
    );
  });

  if (!match) return null;
  return { postId: match.objectID, title: match.title };
}
