import type {
  FreshnessStatus,
  LeadRepository,
  PushCandidate,
} from "../types/index.ts";
import type { CompanyLead, TopJob, TopContact } from "./client.ts";

// Build CompanyLead DTOs (the Feishu mapper's input) from the repo's
// PushCandidate rows. Pure adapter — exclusion / scoring / freshness
// filtering all lives in the repo (S-4 latest-row pattern is enforced
// there). This file only fans out the conversion.

export interface BuildPushCandidatesInput {
  repo: LeadRepository;
  minScore: number;
}

// Spec § 推送阈值: score >= 70 is the canonical Feishu cutoff. Kept here
// (not at the call sites) so the CLI and any future caller see one number.
export const DEFAULT_MIN_SCORE = 70;

// Stable per-company key used as the Bitable "Local ID". Format is part of
// the persistence contract — TB-8 will look records up by this id, so a
// later change here would require a one-time backfill. Tied to the SQLite
// company.id which is autoincrement and never reused (rows are deleted by
// purge, not recycled).
export function localIdFor(companyId: number): string {
  return `company-${companyId}`;
}

function rollUpFreshness(jobs: readonly TopJob[]): FreshnessStatus {
  // The mapper's truncateJobs uses fresh > usable > unknown > stale, and the
  // repo already excludes unknown/stale jobs, so a candidate company is
  // either "has fresh job" or "has only usable jobs". Defaults to "unknown"
  // when somehow no jobs come through (defensive — current SQL would also
  // exclude a 0-job company because it'd never have been scored, but the
  // mapper's Freshness field needs a value either way).
  if (jobs.some((j) => j.freshness === "fresh")) return "fresh";
  if (jobs.some((j) => j.freshness === "usable")) return "usable";
  return "unknown";
}

function buildRemoteLocation(jobs: readonly TopJob[]): string | null {
  // Pick the first non-null location/remote_policy pair so the dry-run
  // output isn't a uniformly empty column. The mapper just echoes this
  // field — formatting is cosmetic.
  for (const j of jobs) {
    if (j.location || j.remotePolicy) {
      return [j.remotePolicy, j.location].filter(Boolean).join(" · ");
    }
  }
  return null;
}

function toTopJob(j: PushCandidate["jobs"][number]): TopJob {
  return {
    title: j.title,
    jobUrl: j.jobUrl,
    location: j.location,
    remotePolicy: j.remotePolicy,
    freshness: j.freshness,
    sourcePostedAt: j.sourcePostedAt,
  };
}

function toTopContact(c: PushCandidate["contacts"][number]): TopContact {
  return {
    name: c.name,
    title: c.title,
    contactType: c.contactType,
    value: c.value,
    profileUrl: c.profileUrl,
    riskLevel: c.riskLevel,
    priorityRank: c.priorityRank,
  };
}

export function buildPushCandidates(
  input: BuildPushCandidatesInput,
): CompanyLead[] {
  const rows = input.repo.listPushCandidates({ minScore: input.minScore });
  return rows.map((row) => {
    const topJobs = row.jobs.map(toTopJob);
    const topContacts = row.contacts.map(toTopContact);
    // The "Website" field is what the dry-run / Lark record displays as a
    // clickable link. Prefer the domain (with https) but only when it
    // looks like a real hostname — synthetic keys like hn:hash aren't
    // clickable.
    const website =
      row.domain && !row.domain.includes(":")
        ? `https://${row.domain}`
        : null;
    return {
      companyId: row.companyId,
      localId: localIdFor(row.companyId),
      name: row.name,
      domain: row.domain,
      website,
      description: row.description,
      directionTags: row.directionTags,
      topJobs,
      topContacts,
      remoteLocation: buildRemoteLocation(topJobs),
      freshness: rollUpFreshness(topJobs),
      score: row.score,
      scorerVersion: row.scorerVersion,
      matchReason: row.matchReason,
      sources: row.sources,
      lastCheckedAt: row.lastCheckedAt,
    };
  });
}
