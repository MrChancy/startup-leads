import type {
  MatchReasonEntry,
  ScoreCompanyInput,
  ScoreJob,
} from "../types.ts";

// Spec § 评分: job match is 35 points and the largest single signal.
// v1.0.0 rules are intentionally word-list based — the goal is "behaves
// deterministically and reads obviously", not "covers every JD phrasing".
// TB-5 / TB-11 will tune the lexicon once we have real HN data.

export const JOB_MATCH_MAX = 35;

interface RolePattern {
  // Higher-confidence patterns checked first. The first match wins per job.
  readonly tier: "primary" | "secondary";
  readonly keywords: readonly string[];
  readonly label: string;
}

const ROLE_PATTERNS: readonly RolePattern[] = [
  // Tier "primary" hits the cap on a single role. Backend / infrastructure /
  // platform / AI engineer are the v1 target hires.
  { tier: "primary", keywords: ["backend engineer"], label: "backend engineer" },
  {
    tier: "primary",
    keywords: ["infrastructure engineer", "infra engineer"],
    label: "infrastructure engineer",
  },
  { tier: "primary", keywords: ["platform engineer"], label: "platform engineer" },
  { tier: "primary", keywords: ["ai engineer"], label: "ai engineer" },
  {
    tier: "primary",
    keywords: ["machine learning engineer", "ml engineer"],
    label: "machine learning engineer",
  },
  {
    tier: "primary",
    keywords: ["staff software engineer", "staff engineer"],
    label: "staff software engineer",
  },
  // Tier "secondary" is "adjacent" — partial credit. AI product / dev tools /
  // SRE land here so a careers page with 3 of these still totals well.
  { tier: "secondary", keywords: ["ai product"], label: "ai product role" },
  { tier: "secondary", keywords: ["full stack", "fullstack"], label: "full-stack" },
  {
    tier: "secondary",
    keywords: ["site reliability", "sre"],
    label: "site reliability",
  },
  { tier: "secondary", keywords: ["devtools", "developer tools"], label: "devtools" },
  { tier: "secondary", keywords: ["software engineer"], label: "software engineer" },
];

const PRIMARY_POINTS = 35;
const SECONDARY_POINTS = 15;

function classifyJob(job: ScoreJob): RolePattern | null {
  const title = job.title.toLowerCase();
  for (const pattern of ROLE_PATTERNS) {
    if (pattern.keywords.some((kw) => title.includes(kw))) {
      return pattern;
    }
  }
  return null;
}

export interface ComponentResult {
  points: number;
  entries: MatchReasonEntry[];
}

export function scoreJobMatch(input: ScoreCompanyInput): ComponentResult {
  if (input.jobs.length === 0) {
    return {
      points: 0,
      entries: [
        {
          component: "job_match",
          points: 0,
          evidenceSourceId: input.primarySourceId,
          note: "no jobs found",
        },
      ],
    };
  }

  const entries: MatchReasonEntry[] = [];
  let total = 0;
  let matched = 0;

  for (const job of input.jobs) {
    const match = classifyJob(job);
    if (!match) continue;

    const raw = match.tier === "primary" ? PRIMARY_POINTS : SECONDARY_POINTS;
    const remaining = Math.max(0, JOB_MATCH_MAX - total);
    const points = Math.min(raw, remaining);

    entries.push({
      component: "job_match",
      points,
      evidenceSourceId: job.evidenceSourceId,
      note:
        points === 0
          ? `title:'${job.title}' matches ${match.label} (capped)`
          : `title:'${job.title}' matches ${match.label}`,
    });
    total += points;
    matched += 1;
  }

  if (matched === 0) {
    entries.push({
      component: "job_match",
      points: 0,
      evidenceSourceId: input.jobs[0]?.evidenceSourceId ?? input.primarySourceId,
      note: `no target roles in ${input.jobs.length} job(s)`,
    });
  }

  return { points: total, entries };
}
