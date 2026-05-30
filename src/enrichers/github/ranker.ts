// Pure ranker for GitHub-sourced contacts.
//
// One-line rule: an explicit email beats a github-only profile; within the
// same contactType, a profile with a real `name` beats an anonymous one;
// ties keep input order (stable). The top three get rank 1/2/3
// ("recommended"); everyone else gets 4+ — still stored, just demoted.

export type GithubContactType = "email" | "github";

export interface GithubCandidate {
  contactType: GithubContactType;
  value: string;
  profileUrl: string | null;
  name: string | null;
  riskLevel: "low" | "medium";
}

export interface RankedGithubContact extends GithubCandidate {
  priorityRank: number;
}

// Sort key: lower is better (rank 1). We blend two binary signals into a
// single number so the comparator stays a one-liner and the rule survives
// future tweaks (e.g. adding "has bio" → add another bit, keep input order
// intact for ties).
function rankKey(c: GithubCandidate): number {
  const emailFirst = c.contactType === "email" ? 0 : 1;
  const namedFirst = c.name && c.name.trim().length > 0 ? 0 : 1;
  // Email-vs-not is the dominant signal: it occupies the high bit so a
  // named-anonymous github user can never outrank an anonymous emailer.
  return emailFirst * 2 + namedFirst;
}

export function rankGithubContacts(
  candidates: ReadonlyArray<GithubCandidate>,
): RankedGithubContact[] {
  // Pair each candidate with its original index so a stable sort lives even
  // on engines that don't guarantee it. Array.prototype.sort is stable in
  // V8/JSC but we don't depend on that here.
  const indexed = candidates.map((c, i) => ({ c, i, key: rankKey(c) }));
  indexed.sort((a, b) => a.key - b.key || a.i - b.i);
  return indexed.map(({ c }, idx) => ({ ...c, priorityRank: idx + 1 }));
}
