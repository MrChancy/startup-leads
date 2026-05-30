import type { FreshnessStatus, RiskLevel } from "../types/index.ts";
import type { CompanyLead, TopContact, TopJob } from "./client.ts";

// Deterministic mapper: lead → flat Lark Bitable fields. Pure function. No
// IO. Same input → byte-identical output (golden fixture pins this).
//
// Truncation rules (spec § 推送行为规则: "1-3 条 top jobs 与 1-3 条推荐联系人"):
//
//   Jobs:
//     1. freshness DESC, where fresh > usable > unknown > stale.
//        Even though the upstream query filters unknown/stale, the rank is
//        complete so a future relaxation can't silently reorder.
//     2. sourcePostedAt DESC (newest first). null treated as -Infinity so
//        dated rows always win the tie.
//     3. Take first 3.
//
//   Contacts:
//     1. priorityRank ASC (1 is highest). null treated as +Infinity so
//        ranked rows always win.
//     2. riskLevel ASC, where low > medium > high (blocked is filtered out
//        upstream by the scorer / repo write rules).
//     3. Take first 3.

const FRESHNESS_RANK: Record<FreshnessStatus, number> = {
  fresh: 3,
  usable: 2,
  unknown: 1,
  stale: 0,
};

const RISK_RANK: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  blocked: 3,
};

export function truncateJobs(jobs: readonly TopJob[]): TopJob[] {
  // Slice first so we never mutate the caller's array.
  const sorted = [...jobs].sort((a, b) => {
    const fr = FRESHNESS_RANK[b.freshness] - FRESHNESS_RANK[a.freshness];
    if (fr !== 0) return fr;
    const aT = a.sourcePostedAt ? Date.parse(a.sourcePostedAt) : -Infinity;
    const bT = b.sourcePostedAt ? Date.parse(b.sourcePostedAt) : -Infinity;
    return bT - aT; // newest first
  });
  return sorted.slice(0, 3);
}

export function truncateContacts(contacts: readonly TopContact[]): TopContact[] {
  const sorted = [...contacts].sort((a, b) => {
    const aR = a.priorityRank ?? Number.POSITIVE_INFINITY;
    const bR = b.priorityRank ?? Number.POSITIVE_INFINITY;
    if (aR !== bR) return aR - bR;
    return RISK_RANK[a.riskLevel] - RISK_RANK[b.riskLevel];
  });
  return sorted.slice(0, 3);
}

// The flat field map sent to (or asserted against) Lark Bitable. Field
// names match spec § 飞书记录字段 exactly so reviewers reading either side
// can cross-reference without a translation table.
//
// Returns Record<string, unknown> rather than a strict interface because
// Lark Bitable fields are heterogeneous (string, number, array, object) and
// the in-memory client just echoes them back without inspection. The golden
// fixture is what pins the actual shape.
export function mapToFeishuFields(lead: CompanyLead): Record<string, unknown> {
  const topJobs = truncateJobs(lead.topJobs);
  const topContacts = truncateContacts(lead.topContacts);
  return {
    Company: lead.name,
    Website: lead.website,
    Domain: lead.domain,
    "Direction Tags": [...lead.directionTags],
    "Top Jobs": topJobs.map((j) => ({
      title: j.title,
      url: j.jobUrl,
      location: j.location,
      remote_policy: j.remotePolicy,
      freshness: j.freshness,
      source_posted_at: j.sourcePostedAt,
    })),
    "Remote / Location": lead.remoteLocation,
    Freshness: lead.freshness,
    Score: lead.score,
    "Scorer Version": lead.scorerVersion,
    "Match Reason": lead.matchReason.map((entry) => ({
      component: entry.component,
      points: entry.points,
      evidence_source_id: entry.evidenceSourceId,
      note: entry.note,
    })),
    "Recommended Contacts": topContacts.map((c) => ({
      name: c.name,
      title: c.title,
      contact_type: c.contactType,
      value: c.value,
      profile_url: c.profileUrl,
      risk_level: c.riskLevel,
      priority_rank: c.priorityRank,
    })),
    // Single rolled-up risk for at-a-glance scanning. Worst (highest rank)
    // of the kept contacts wins so a "low + medium" team reads as medium.
    "Contact Risk": topContacts.length === 0
      ? null
      : topContacts.reduce<RiskLevel>(
          (worst, c) => (RISK_RANK[c.riskLevel] > RISK_RANK[worst] ? c.riskLevel : worst),
          topContacts[0]!.riskLevel,
        ),
    Sources: [...lead.sources],
    // Status starts as a placeholder; TB-8 will update it post-push and the
    // human review loop will flip it through the spec'd values. Dry-run
    // always emits the initial "queued" state.
    Status: "queued",
    "Last Checked At": lead.lastCheckedAt,
    "Local ID": lead.localId,
    // Free-form reviewer notes. The pipeline never writes here; it stays
    // empty until a human edits the record. Emitting "" (rather than
    // omitting the key) is deliberate: the field must EXIST in the create
    // payload or Bitable refuses to display the column.
    "Review Notes": "",
  };
}

// Payload envelope. v1 wraps the field map in a `fields` key matching the
// Lark Bitable create-record request body so the dry-run output and the
// real push payload are the same shape end-to-end (TB-8 won't have to
// rewrap on its way to the API).
export interface FeishuPayload {
  localId: string;
  fields: Record<string, unknown>;
}

export function mapToFeishuPayload(lead: CompanyLead): FeishuPayload {
  return {
    localId: lead.localId,
    fields: mapToFeishuFields(lead),
  };
}
