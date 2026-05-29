import type { DirectionTag } from "../../types/direction-tags.ts";
import { isDirectionTag } from "../../types/direction-tags.ts";
import type {
  MatchReasonEntry,
  ScoreCompanyInput,
} from "../types.ts";
import type { ComponentResult } from "./job-match.ts";

export const DIRECTION_MAX = 25;

// Per-tag weights for v1. "AI-native / ai-app / ai-infra / backend" are core
// targets and worth more; "remote-friendly / china-timezone / devtools /
// overseas" are accelerants but not the buy signal by themselves.
const TAG_WEIGHTS: Record<DirectionTag, number> = {
  "ai-native": 25,
  "ai-app": 20,
  "ai-infra": 20,
  backend: 18,
  devtools: 10,
  overseas: 8,
  "remote-friendly": 8,
  "china-timezone": 6,
};

export function scoreDirection(input: ScoreCompanyInput): ComponentResult {
  if (input.directionTags.length === 0) {
    return {
      points: 0,
      entries: [
        {
          component: "direction",
          points: 0,
          evidenceSourceId: input.primarySourceId,
          note: "no direction tags",
        },
      ],
    };
  }

  const entries: MatchReasonEntry[] = [];
  let total = 0;

  for (const tag of input.directionTags) {
    if (!isDirectionTag(tag)) {
      entries.push({
        component: "direction",
        points: 0,
        evidenceSourceId: input.primarySourceId,
        note: `ignored unknown tag '${tag}'`,
      });
      continue;
    }
    const raw = TAG_WEIGHTS[tag];
    const remaining = Math.max(0, DIRECTION_MAX - total);
    const points = Math.min(raw, remaining);
    entries.push({
      component: "direction",
      points,
      evidenceSourceId: input.primarySourceId,
      note:
        points === 0
          ? `tag '${tag}' matched (capped)`
          : `tag '${tag}' matched`,
    });
    total += points;
  }

  return { points: total, entries };
}
