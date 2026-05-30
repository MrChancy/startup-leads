// GitHub public-profile enricher. For each company that already has a
// `contact_type='github'` row (the HN parser harvests these from comment
// text), call /orgs/<slug>/public_members and each member's /users/<login>,
// then persist any explicit email + profile URL the user opted in to.
//
// Invariants (see also CLAUDE.local.md):
//   * S-2 (transaction discipline): the per-company write — sources + N
//     contacts + re-score lead_scores row — is wrapped in repo.withTransaction
//     so a partial failure rolls back the whole company's update.
//   * T-2 (per-item try/catch): one company's HTTP throw never aborts the
//     run; remaining companies still get their chance and the runs row ends
//     'partial' when any company errored.
//   * I-1 (interface honesty): every member fetched produces either an
//     email contact (when profile.email is set) OR a github contact (when
//     it isn't). Profiles where the API gave us nothing usable (no login,
//     somehow no html_url) are silently skipped, not faked.
//   * NEVER synthesize emails. `<login>@<company>` is exactly the heuristic
//     the spec forbids; we only write what the API returned verbatim.
//   * Rate-limit awareness: GitHub uses 429 (retryable, surfaces as
//     HttpRetryExhaustedError after MAX_RETRIES) OR 403 with body
//     mentioning "rate limit" (not retryable). Either trips the
//     rate-limited flag for the remainder of the run; further companies
//     skip the network and persist a `fetch_status='deferred'` sources row.
//   * GITHUB_TOKEN is passed as `Authorization: Bearer <token>` when set.
//     Empty / unset means no Authorization header (60 req/h unauth limit).

import {
  HttpError,
  HttpRetryExhaustedError,
  HttpTimeoutError,
  type HttpClient,
  type HttpOptions,
} from "../../http/index.ts";
import { scoreCompany } from "../../scoring/score.ts";
import type {
  GithubEnrichmentContact,
  GithubOrgCandidate,
  LeadRepository,
} from "../../types/index.ts";
import { rankGithubContacts, type GithubCandidate } from "./ranker.ts";

export interface EnrichGithubInput {
  repo: LeadRepository;
  http: HttpClient;
  // Dry-run flag, UX-aligned with the careers enricher and purge.
  confirm: boolean;
  // Injected clock so re-score freshness math is deterministic in tests.
  now: () => Date;
  // We accept env as a parameter instead of reading process.env directly so
  // tests don't have to mutate the global. Production wiring in cli/index.ts
  // passes process.env.
  env: Record<string, string | undefined>;
}

export interface EnrichGithubResult {
  // Companies the repo nominated (one (companyId, orgSlug) per company).
  orgsEligible: number;
  // Companies we'd probe in confirm mode. Equals orgsEligible in v1; kept
  // as its own field so dry-run output and confirm output share one shape.
  orgsToProbe: number;
  // Companies whose org call actually went out.
  orgsProbed: number;
  // Companies whose profiles produced ≥1 stored contact.
  orgsMatched: number;
  // Companies where 403/429 forced us to record a deferred sources row.
  // Includes both the trigger and every subsequent company we skipped.
  companiesDeferred: number;
  // Companies that threw an unexpected error (non-HTTP, post-fetch parse,
  // etc.). One stderr line per occurrence; the runs row finishes 'partial'.
  companyErrors: number;
  // Total contact rows the enricher created (excluding dedupe skips).
  contactsCreated: number;
  // Per-org plan, used by dry-run output to show what would be probed.
  plan: Array<{ companyId: number; orgSlug: string }>;
}

export const ENRICH_GITHUB_SOURCE = "enrich:github";

const GITHUB_API_BASE = "https://api.github.com";

// GitHub defaults to 30 per page on /public_members. We don't paginate
// in v1 — 30 candidate members per company is more than enough input for
// the ranker to pick a top-3 from, and v1's unauth quota is 60 req/h
// anyway. If we ever need more we add `?per_page=100` here.

interface GithubProfile {
  // login is mandatory on every real /users/<login> response; we filter
  // missing values defensively.
  login?: string | null;
  // name is null for many real profiles (e.g. some Vercel members had null).
  name?: string | null;
  // email is null for users who haven't opted into public email.
  email?: string | null;
  // html_url is the profile URL we expose as profile_url on the contact row.
  html_url?: string | null;
}

interface GithubMember {
  login?: string | null;
  html_url?: string | null;
}

export async function runEnrichGithub(
  input: EnrichGithubInput,
): Promise<EnrichGithubResult & { runId: string | null }> {
  const { repo, http, confirm, now, env } = input;

  const candidates = repo.listGithubOrgCandidates();
  const result: EnrichGithubResult = {
    orgsEligible: candidates.length,
    orgsToProbe: candidates.length,
    orgsProbed: 0,
    orgsMatched: 0,
    companiesDeferred: 0,
    companyErrors: 0,
    contactsCreated: 0,
    plan: candidates.map((c) => ({
      companyId: c.companyId,
      orgSlug: c.orgSlug,
    })),
  };

  if (!confirm) {
    // Dry-run: no runs row (no audit to write), no network, no DB writes.
    return { ...result, runId: null };
  }

  const enrichRun = repo.startRun({
    source: ENRICH_GITHUB_SOURCE,
    limit: 0,
  });
  const httpOpts = makeHttpOpts(env);

  // Shared state: once we trip the rate limit, every subsequent company is
  // recorded as deferred with no further API calls.
  let rateLimited = false;

  for (const cand of candidates) {
    if (rateLimited) {
      // Skip the network entirely, persist the deferred marker, move on.
      recordDeferred(repo, cand, "rate_limited", "rate limit hit earlier in run");
      result.companiesDeferred++;
      continue;
    }

    // T-2: per-company try/catch so one unexpected throw doesn't abort
    // the loop or leave the runs row stuck on 'partial' for an unrelated
    // reason.
    try {
      const outcome = await processCompany({
        repo,
        http,
        httpOpts,
        cand,
        runId: enrichRun.id,
        now,
      });
      if (outcome === "rate_limited") {
        rateLimited = true;
        result.companiesDeferred++;
      } else {
        result.orgsProbed++;
        if (outcome.contactsCreated > 0) {
          result.orgsMatched++;
        }
        result.contactsCreated += outcome.contactsCreated;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `enrich github: company #${cand.companyId} failed — ${msg}\n`,
      );
      result.companyErrors++;
    }
  }

  repo.finishRun(
    enrichRun.id,
    result.companyErrors > 0 || result.companiesDeferred > 0
      ? "partial"
      : "completed",
  );
  return { ...result, runId: enrichRun.id };
}

interface ProcessCompanyArgs {
  repo: LeadRepository;
  http: HttpClient;
  httpOpts: HttpOptions;
  cand: GithubOrgCandidate;
  runId: string;
  now: () => Date;
}

type ProcessOutcome = "rate_limited" | { contactsCreated: number };

async function processCompany(args: ProcessCompanyArgs): Promise<ProcessOutcome> {
  const { repo, http, httpOpts, cand, runId, now } = args;

  // 1. Fetch member list.
  const membersUrl = `${GITHUB_API_BASE}/orgs/${cand.orgSlug}/public_members`;
  let membersBody: string;
  try {
    const res = await http.get(membersUrl, httpOpts);
    membersBody = res.body;
  } catch (err) {
    if (isRateLimitError(err)) {
      // Record THIS company as deferred too; the caller flips the flag so
      // subsequent companies also defer without re-trying.
      recordDeferred(repo, cand, "rate_limited", errorMessage(err));
      return "rate_limited";
    }
    if (err instanceof HttpError && err.status === 404) {
      // Slug is a user account or a private/nonexistent org. Silent skip —
      // nothing to enrich here, but it isn't a failure either.
      return { contactsCreated: 0 };
    }
    // Known fetch failures: record a failed sources row so the audit
    // trail captures we tried, then continue with the next company.
    if (
      err instanceof HttpError ||
      err instanceof HttpTimeoutError
    ) {
      recordFailed(repo, cand, "fetch_failed", errorMessage(err));
      return { contactsCreated: 0 };
    }
    // Anything else is an unexpected bug — let it bubble to the
    // per-company try/catch so it gets visible (stderr + companyErrors)
    // instead of being silently logged as a "fetch failure".
    throw err;
  }

  const members = parseMembers(membersBody);
  if (members.length === 0) {
    // Org exists but has zero public members. Record a successful source
    // with zero contacts so the audit captures the empty result.
    repo.recordGithubEnrichment({
      companyId: cand.companyId,
      orgSlug: cand.orgSlug,
      fetchStatus: "success",
      contacts: [],
    });
    return { contactsCreated: 0 };
  }

  // 2. Fetch each profile. A rate-limit error mid-way trips the flag and
  // we record this company as deferred (we have partial data — better to
  // re-run later with a token than persist half a member list).
  const profiles: GithubProfile[] = [];
  for (const m of members) {
    if (!m.login) continue;
    const profileUrl = `${GITHUB_API_BASE}/users/${m.login}`;
    try {
      const res = await http.get(profileUrl, httpOpts);
      profiles.push(parseProfile(res.body));
    } catch (err) {
      if (isRateLimitError(err)) {
        recordDeferred(repo, cand, "rate_limited", errorMessage(err));
        return "rate_limited";
      }
      // A single profile 404 / transient failure: skip that profile,
      // continue with the rest. We don't want one ghost account to defer
      // an entire org's worth of contacts.
      continue;
    }
  }

  // 3. Turn profiles into candidate contacts. NEVER synthesize an email
  // when profile.email is null — drop to the github-only branch instead.
  const candidates: GithubCandidate[] = [];
  for (const p of profiles) {
    if (!p.login) continue;
    const profileUrl = p.html_url ?? `https://github.com/${p.login}`;
    if (p.email && p.email.trim().length > 0) {
      candidates.push({
        contactType: "email",
        value: p.email.trim(),
        profileUrl,
        name: p.name ?? null,
        // Public profile email is the user's explicit opt-in — low risk.
        riskLevel: "low",
      });
    } else {
      candidates.push({
        contactType: "github",
        value: `github.com/${p.login}`,
        profileUrl,
        name: p.name ?? null,
        // Profile URL only, no inbox yet — medium risk to nudge a
        // reviewer to confirm contact preference before reaching out.
        riskLevel: "medium",
      });
    }
  }

  const ranked = rankGithubContacts(candidates);

  // 4. Persist in one transaction (S-2 延伸): source + contacts + re-score
  // row should all roll back together if any step fails.
  let contactsCreated = 0;
  repo.withTransaction(() => {
    const { insertedCount } = repo.recordGithubEnrichment({
      companyId: cand.companyId,
      orgSlug: cand.orgSlug,
      fetchStatus: "success",
      contacts: ranked.map(
        (c): GithubEnrichmentContact => ({
          contactType: c.contactType,
          value: c.value,
          profileUrl: c.profileUrl,
          name: c.name,
          riskLevel: c.riskLevel,
          priorityRank: c.priorityRank,
        }),
      ),
    });
    contactsCreated = insertedCount;

    // Re-score only when a contact row actually landed. A re-run that finds
    // every candidate already on file (insertedCount === 0) MUST NOT append
    // a new lead_scores row — that would attribute a stale decision to the
    // enrich run (careers C3 lesson). The source row above still records
    // the successful probe, which is the audit signal that matters.
    if (contactsCreated > 0) {
      const scoreInput = repo.getCompanyScoreInput(cand.companyId, now());
      const newScore = scoreCompany({
        companyId: scoreInput.companyId,
        directionTags: scoreInput.directionTags,
        jobs: scoreInput.jobs,
        contacts: scoreInput.contacts,
        excludedByRule: scoreInput.excludedByRule,
        exclusionReason: scoreInput.exclusionReason,
        primarySourceId: scoreInput.primarySourceId,
        now: scoreInput.now,
      });
      repo.writeLeadScore({
        companyId: newScore.companyId,
        runId,
        score: newScore.score,
        jobMatchScore: newScore.jobMatchScore,
        directionScore: newScore.directionScore,
        freshnessScore: newScore.freshnessScore,
        contactScore: newScore.contactScore,
        actionabilityScore: newScore.actionabilityScore,
        matchReason: newScore.matchReason,
        decision: newScore.decision,
        scorerVersion: newScore.scorerVersion,
      });
    }
  });

  return { contactsCreated };
}

function makeHttpOpts(env: Record<string, string | undefined>): HttpOptions {
  const token = env["GITHUB_TOKEN"];
  if (token && token.length > 0) {
    return {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    };
  }
  // No token: send only Accept so the server uses the v3 JSON schema.
  return { headers: { Accept: "application/vnd.github+json" } };
}

// GitHub uses two distinct shapes for rate limiting: 429 (which our
// HttpClient retries and eventually surfaces as HttpRetryExhaustedError)
// and 403 with a body that mentions "rate limit" (not retried). Both mean
// the same thing for us: stop trying for the rest of this run.
function isRateLimitError(err: unknown): boolean {
  if (err instanceof HttpRetryExhaustedError && err.lastStatus === 429) {
    return true;
  }
  if (
    err instanceof HttpError &&
    err.status === 403 &&
    err.body &&
    /rate limit/i.test(err.body)
  ) {
    return true;
  }
  return false;
}

function recordDeferred(
  repo: LeadRepository,
  cand: GithubOrgCandidate,
  code: string,
  message: string,
) {
  repo.recordGithubEnrichment({
    companyId: cand.companyId,
    orgSlug: cand.orgSlug,
    fetchStatus: "deferred",
    errorCode: code,
    errorMessage: message,
    contacts: [],
  });
}

function recordFailed(
  repo: LeadRepository,
  cand: GithubOrgCandidate,
  code: string,
  message: string,
) {
  repo.recordGithubEnrichment({
    companyId: cand.companyId,
    orgSlug: cand.orgSlug,
    fetchStatus: "failed",
    errorCode: code,
    errorMessage: message,
    contacts: [],
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Defensive JSON parsing: we never trust the body shape implicitly. If the
// API returns something we don't recognise, we treat it as an empty list
// rather than throwing — a parse error inside processCompany would bubble
// up to the per-company try/catch and inflate companyErrors for a benign
// API surprise.
function parseMembers(body: string): GithubMember[] {
  try {
    const data = JSON.parse(body);
    if (!Array.isArray(data)) return [];
    return data
      .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null)
      .map((m) => ({
        login: typeof m["login"] === "string" ? (m["login"] as string) : null,
        html_url:
          typeof m["html_url"] === "string" ? (m["html_url"] as string) : null,
      }));
  } catch {
    return [];
  }
}

function parseProfile(body: string): GithubProfile {
  try {
    const data = JSON.parse(body);
    if (typeof data !== "object" || data === null) return {};
    const obj = data as Record<string, unknown>;
    return {
      login: typeof obj["login"] === "string" ? (obj["login"] as string) : null,
      name: typeof obj["name"] === "string" ? (obj["name"] as string) : null,
      email: typeof obj["email"] === "string" ? (obj["email"] as string) : null,
      html_url:
        typeof obj["html_url"] === "string" ? (obj["html_url"] as string) : null,
    };
  } catch {
    return {};
  }
}

export function formatEnrichGithubResult(
  result: EnrichGithubResult & { runId?: string | null },
  confirmed: boolean,
): string {
  const header = confirmed
    ? "GitHub enrichment:"
    : "GitHub enrichment plan (dry-run; pass --yes to probe):";
  const lines = [
    header,
    `  orgs eligible             : ${result.orgsEligible}`,
    `  orgs to probe             : ${result.orgsToProbe}`,
  ];
  if (confirmed) {
    lines.push(
      `  orgs probed               : ${result.orgsProbed}`,
      `  orgs matched (>=1 contact): ${result.orgsMatched}`,
      `  contacts created          : ${result.contactsCreated}`,
      `  companies deferred (429)  : ${result.companiesDeferred}`,
      `  company errors            : ${result.companyErrors}`,
    );
    if (result.runId) {
      lines.push(`  run id                    : ${result.runId}`);
    }
  }
  if (result.plan.length > 0) {
    lines.push("", confirmed ? "Probed:" : "Would probe:");
    for (const entry of result.plan) {
      lines.push(
        `  - company #${entry.companyId} via github.com/${entry.orgSlug}`,
      );
    }
  }
  return lines.join("\n");
}
