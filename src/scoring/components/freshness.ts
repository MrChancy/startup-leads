import type { FreshnessStatus } from "../../types/index.ts";
import type { ScoreCompanyInput } from "../types.ts";
import type { ComponentResult } from "./job-match.ts";

export const FRESHNESS_MAX = 15;

// Per-status weights. "fresh" earns the cap; "usable" earns most of it (gated
// by careers-page enrichment in TB-5 so a candidate page is still pushable);
// "stale" / "unknown" score nothing — stale is also a decision override (see
// decision.ts), unknown is just signal-less.
const STATUS_POINTS: Record<FreshnessStatus, number> = {
  fresh: 15,
  usable: 10,
  stale: 0,
  unknown: 0,
};

export function scoreFreshness(input: ScoreCompanyInput): ComponentResult {
  if (input.jobs.length === 0) {
    return {
      points: 0,
      entries: [
        {
          component: "freshness",
          points: 0,
          evidenceSourceId: input.primarySourceId,
          note: "no jobs found",
        },
      ],
    };
  }

  // Take the freshest job to represent the company. A startup with even one
  // fresh listing reads as actively hiring; older jobs alongside it are not
  // a penalty.
  let bestJob = input.jobs[0]!;
  for (const job of input.jobs) {
    if (STATUS_POINTS[job.freshness] > STATUS_POINTS[bestJob.freshness]) {
      bestJob = job;
    }
  }

  const points = STATUS_POINTS[bestJob.freshness];
  const note =
    bestJob.freshness === "unknown"
      ? "freshness unknown (no posted date)"
      : `freshest job: ${bestJob.freshness}`;

  return {
    points,
    entries: [
      {
        component: "freshness",
        points,
        evidenceSourceId: bestJob.evidenceSourceId,
        note,
      },
    ],
  };
}
