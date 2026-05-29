import type { ScoreCompanyInput, ScoreContact } from "../types.ts";
import type { ComponentResult } from "./job-match.ts";

export const CONTACT_MAX = 15;

// Per-risk weights. Blocked never scores (and triggers a decision override
// upstream); high-risk also zeroes (manual review only); low-risk earns the
// full cap; medium earns a usable middle.
const RISK_POINTS: Record<ScoreContact["riskLevel"], number> = {
  low: 15,
  medium: 8,
  high: 0,
  blocked: 0,
};

export function scoreContact(input: ScoreCompanyInput): ComponentResult {
  if (input.contacts.length === 0) {
    return {
      points: 0,
      entries: [
        {
          component: "contact",
          points: 0,
          evidenceSourceId: input.primarySourceId,
          note: "no contacts found",
        },
      ],
    };
  }

  // Best-contact scoring: a startup with one usable email shouldn't be
  // penalised for also having a stale LinkedIn lying around.
  let best = input.contacts[0]!;
  for (const contact of input.contacts) {
    if (RISK_POINTS[contact.riskLevel] > RISK_POINTS[best.riskLevel]) {
      best = contact;
    }
  }

  const points = RISK_POINTS[best.riskLevel];
  const onlyBlocked = input.contacts.every((c) => c.riskLevel === "blocked");

  const note = onlyBlocked
    ? "all contacts blocked"
    : `best contact: ${best.contactType} (risk=${best.riskLevel})`;

  return {
    points,
    entries: [
      {
        component: "contact",
        points,
        evidenceSourceId: best.evidenceSourceId,
        note,
      },
    ],
  };
}
