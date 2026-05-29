// HN "Ask HN: Who is hiring?" collector.
//
// Flow: Algolia (find current month's post) -> Firebase (fetch post +
// each comment up to --limit) -> parser (turn each comment into a lead).
//
// Failure semantics (CLAUDE.local.md I-2 "missing vs zero"):
//   - Algolia returns 0 hits OR no hit matches the reference month -> we
//     log a warning and return { leads: [], parseFailed: 0, fetchFailed: 0 }.
//     "We haven't found this month's thread yet" is a real outcome on the
//     1st-3rd of every month, not an error.
//   - Algolia / story-fetch throws (network, retries exhausted, bad JSON)
//     -> we let it bubble. There's no useful run without a post id.
//   - A single comment fetch throws -> fetchFailed++, continue.
//   - A single comment parses to nothing useful -> parseFailed++, continue.

import { createHttpClient, type HttpClient } from "../../http/index.ts";
import type { Collector, CollectorResult } from "../types.ts";
import { findMonthlyPost } from "./algolia.ts";
import { fetchComment, fetchStory } from "./firebase.ts";
import { parseComment } from "./parse.ts";

export const HN_SOURCE = "hn_who_is_hiring";

export interface HnCollectorDeps {
  client?: HttpClient;
  // `now` is injected so tests pin freshness + reference month. Production
  // takes the real wall clock.
  now?: () => Date;
  // Optional warn channel for "no thread found yet this month". Defaults to
  // console.warn; tests can capture lines via a spy.
  warn?: (line: string) => void;
}

export function createHnCollector(deps: HnCollectorDeps = {}): Collector {
  const client = deps.client ?? createHttpClient();
  const nowFn = deps.now ?? (() => new Date());
  const warn = deps.warn ?? ((line) => console.warn(line));

  return {
    source: HN_SOURCE,
    async collect(input): Promise<CollectorResult> {
      const now = nowFn();
      const monthly = await findMonthlyPost({ client, reference: now });
      if (!monthly) {
        warn(
          `[hn] no monthly thread found for ${now.toISOString().slice(0, 7)}; returning 0 leads`,
        );
        return { leads: [], parseFailed: 0, fetchFailed: 0 };
      }

      const story = await fetchStory(client, monthly.postId);
      const kids = (story.kids ?? []).slice(0, input.limit);

      const leads = [];
      let parseFailed = 0;
      let fetchFailed = 0;

      for (const kidId of kids) {
        let comment;
        try {
          comment = await fetchComment(client, kidId);
        } catch {
          // We swallow the error after counting it. The collector contract
          // is "return what you got"; raising would abort the whole run
          // and lose every comment processed before this one.
          fetchFailed++;
          continue;
        }
        const result = parseComment(comment, {
          postTitle: monthly.title,
          now,
        });
        if (result.kind === "ok") {
          leads.push(result.lead);
        } else {
          parseFailed++;
        }
      }

      return { leads, parseFailed, fetchFailed };
    },
  };
}

// Default production instance. Lazy so importers that only want the type or
// the factory don't pay for createHttpClient's setup.
export const hnCollector: Collector = createHnCollector();
