// Tests for the GitHub contact ranker — pure function, no I/O.
//
// The ranker decides who gets priority_rank 1, 2, 3 (recommended) and who
// lands at 4+ (stored but not surfaced as top picks). The TB-10 issue caps
// the "recommended" set at 1-3 per company; everyone above 3 is still
// persisted so a human can scan deeper later.

import { test, expect } from "bun:test";
import { rankGithubContacts, type GithubCandidate } from "./ranker.ts";

function cand(over: Partial<GithubCandidate> = {}): GithubCandidate {
  return {
    contactType: "github",
    value: "github.com/anon",
    profileUrl: "https://github.com/anon",
    name: null,
    riskLevel: "medium",
    ...over,
  };
}

test("contacts with an explicit email rank above github-only profiles", () => {
  // Email is more directly actionable than a profile URL — having one is the
  // strongest signal a profile owner wants to be reachable.
  const ranked = rankGithubContacts([
    cand({ contactType: "github", value: "github.com/alice" }),
    cand({
      contactType: "email",
      value: "bob@example.com",
      riskLevel: "low",
    }),
  ]);
  expect(ranked[0]?.value).toBe("bob@example.com");
  expect(ranked[0]?.priorityRank).toBe(1);
  expect(ranked[1]?.value).toBe("github.com/alice");
  expect(ranked[1]?.priorityRank).toBe(2);
});

test("within the same contactType, named profiles rank above anonymous ones", () => {
  const ranked = rankGithubContacts([
    cand({ value: "github.com/anon", name: null }),
    cand({ value: "github.com/named", name: "Real Name" }),
  ]);
  expect(ranked[0]?.value).toBe("github.com/named");
  expect(ranked[1]?.value).toBe("github.com/anon");
});

test("ties preserve input order (stable sort)", () => {
  // Both are github-only, both anonymous; order should match the input.
  const ranked = rankGithubContacts([
    cand({ value: "github.com/a" }),
    cand({ value: "github.com/b" }),
    cand({ value: "github.com/c" }),
  ]);
  expect(ranked.map((c) => c.value)).toEqual([
    "github.com/a",
    "github.com/b",
    "github.com/c",
  ]);
});

test("assigns sequential priority_rank starting at 1", () => {
  const ranked = rankGithubContacts([cand(), cand(), cand(), cand(), cand()]);
  expect(ranked.map((c) => c.priorityRank)).toEqual([1, 2, 3, 4, 5]);
});

test("empty input yields empty output", () => {
  expect(rankGithubContacts([])).toEqual([]);
});
