// End-to-end tests for the GitHub public-profile enricher. One test per AC
// in the issue body; baseline behaviour (dry-run, per-company errors,
// idempotency, re-score) is covered below the AC block.

import { test, expect } from "bun:test";
import { createInMemoryRepository } from "../../storage/index.ts";
import type { CollectedLead } from "../../types/index.ts";
import { HttpError, HttpRetryExhaustedError } from "../../http/index.ts";
import { loadFixture, makeFakeHttpClient } from "./test-support.ts";
import { runEnrichGithub } from "./index.ts";

function lead(over: Partial<CollectedLead> = {}): CollectedLead {
  return {
    companyName: "Acme AI",
    domain: "acme.ai",
    directionTags: ["backend"],
    jobs: [{ title: "Backend Engineer", freshness: "unknown" }],
    contacts: [
      // The discovery path: HN parser already wrote this kind of row.
      {
        contactType: "github",
        value: "github.com/acme-ai",
        profileUrl: "https://github.com/acme-ai",
        riskLevel: "medium",
      },
    ],
    source: {
      sourceType: "hn_who_is_hiring",
      sourceUrl: "https://news.ycombinator.com/item?id=1",
      retrievedAt: new Date().toISOString(),
    },
    ...over,
  };
}

// Shorthand: build a UrlMap for one org + N profiles using the recorded
// fixtures. Each test customizes whichever subset it needs.
function membersUrl(slug: string): string {
  return `https://api.github.com/orgs/${slug}/public_members`;
}

function profileUrl(login: string): string {
  return `https://api.github.com/users/${login}`;
}

// ----- AC 1: org member list goes through HttpClient ----------------------

test("AC1: lists org public members via HttpClient", async () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "test", limit: 1 });
  repo.upsertCollectedLead(lead(), run.id);

  const members = loadFixture("members.json");
  const { client, calls } = makeFakeHttpClient({
    [membersUrl("acme-ai")]: members,
    // Real members.json has 5 logins; mock each profile call.
    [profileUrl("1st1")]: loadFixture("profile-without-email.json"),
    [profileUrl("alex-grover")]: loadFixture("profile-with-email.json"),
    [profileUrl("anatrajkovska")]: loadFixture("profile-without-email.json"),
    [profileUrl("atinux")]: loadFixture("profile-with-blog.json"),
    [profileUrl("benjamincanac")]: loadFixture("profile-without-email.json"),
  });

  await runEnrichGithub({
    repo,
    http: client,
    confirm: true,
    now: () => new Date("2026-05-28T00:00:00.000Z"),
    env: {},
  });

  // The first call must be /orgs/<slug>/public_members.
  expect(calls[0]?.url).toBe(membersUrl("acme-ai"));
});

// ----- AC 2: extract profile email + profile URL ---------------------------

test("AC2a: a profile with `email` set persists one email contact pointing at the new source", async () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "test", limit: 1 });
  const acme = repo.upsertCollectedLead(lead(), run.id);

  // One-member fixture so we don't have to mock four other profiles.
  const oneMember = JSON.stringify([
    { login: "alex-grover", html_url: "https://github.com/alex-grover" },
  ]);
  const { client } = makeFakeHttpClient({
    [membersUrl("acme-ai")]: oneMember,
    [profileUrl("alex-grover")]: loadFixture("profile-with-email.json"),
  });

  await runEnrichGithub({
    repo,
    http: client,
    confirm: true,
    now: () => new Date(),
    env: {},
  });

  const newRows = db
    .query<
      {
        contact_type: string;
        value: string;
        profile_url: string | null;
        source_id: number | null;
      },
      [number]
    >(
      "SELECT contact_type, value, profile_url, source_id FROM contacts WHERE company_id = ? AND source_id IS NOT NULL AND source_id > 0 ORDER BY id",
    )
    .all(acme.companyId)
    .filter((r) => r.contact_type === "email");

  expect(newRows).toHaveLength(1);
  expect(newRows[0]?.value).toBe("alex@example.com");
  expect(newRows[0]?.profile_url).toBe("https://github.com/alex-grover");
  expect(newRows[0]?.source_id).toBeGreaterThan(0);
});

test("AC2b: a profile with `email: null` persists a github contact only (no email row)", async () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "test", limit: 1 });
  const acme = repo.upsertCollectedLead(lead(), run.id);

  const oneMember = JSON.stringify([
    { login: "1st1", html_url: "https://github.com/1st1" },
  ]);
  const { client } = makeFakeHttpClient({
    [membersUrl("acme-ai")]: oneMember,
    [profileUrl("1st1")]: loadFixture("profile-without-email.json"),
  });

  await runEnrichGithub({
    repo,
    http: client,
    confirm: true,
    now: () => new Date(),
    env: {},
  });

  // Count rows the enricher created (source_id pointing at the github source).
  const githubSourceId = db
    .query<{ id: number }, []>(
      "SELECT id FROM sources WHERE source_type = 'github_profile' ORDER BY id DESC LIMIT 1",
    )
    .get()?.id;
  expect(githubSourceId).toBeGreaterThan(0);

  const created = db
    .query<{ contact_type: string; value: string }, [number, number]>(
      "SELECT contact_type, value FROM contacts WHERE company_id = ? AND source_id = ? ORDER BY id",
    )
    .all(acme.companyId, githubSourceId!);
  // Exactly one new row, contact_type=github, value=github.com/<login>.
  expect(created).toHaveLength(1);
  expect(created[0]?.contact_type).toBe("github");
  expect(created[0]?.value).toBe("github.com/1st1");
});

// ----- AC 3: never synthesize <user>@<company> emails ----------------------

test("AC3: a null-email profile never produces a synthesized <login>@<company> email", async () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "test", limit: 1 });
  const acme = repo.upsertCollectedLead(lead(), run.id);

  const oneMember = JSON.stringify([
    { login: "atinux", html_url: "https://github.com/atinux" },
  ]);
  const { client } = makeFakeHttpClient({
    [membersUrl("acme-ai")]: oneMember,
    // profile-with-blog: email=null, company="@nuxt . @vercel".
    [profileUrl("atinux")]: loadFixture("profile-with-blog.json"),
  });

  await runEnrichGithub({
    repo,
    http: client,
    confirm: true,
    now: () => new Date(),
    env: {},
  });

  const allRows = db
    .query<{ contact_type: string; value: string }, [number]>(
      "SELECT contact_type, value FROM contacts WHERE company_id = ?",
    )
    .all(acme.companyId);

  // No row should be an email, period — there was no email on the profile,
  // so the enricher must not have invented one.
  const emails = allRows.filter((r) => r.contact_type === "email");
  expect(emails).toHaveLength(0);
  // And no row's value should match login@anything (the heuristic we forbid).
  for (const row of allRows) {
    expect(row.value).not.toMatch(/^atinux@/i);
  }
});

// ----- AC 4: 1-3 recommended, extras stored at lower priority_rank ---------

// Helper: take a real profile fixture and rewrite its login + html_url so
// multiple profile responses don't collapse into one contact via the
// (company, type, value) dedup. We preserve every other field so the body
// still mirrors a real GitHub response shape (W-5).
function reLogin(fixtureBody: string, login: string): string {
  const obj = JSON.parse(fixtureBody);
  obj.login = login;
  obj.html_url = `https://github.com/${login}`;
  return JSON.stringify(obj);
}

test("AC4: a 5-member org persists all five with priority_rank 1..5 (top 3 are recommended)", async () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "test", limit: 1 });
  const acme = repo.upsertCollectedLead(lead(), run.id);

  // Real 5-member fixture (each login distinct → each profile distinct).
  const baseNoEmail = loadFixture("profile-without-email.json");
  const baseEmail = loadFixture("profile-with-email.json");
  const baseBlog = loadFixture("profile-with-blog.json");
  const { client } = makeFakeHttpClient({
    [membersUrl("acme-ai")]: loadFixture("members.json"),
    [profileUrl("1st1")]: reLogin(baseNoEmail, "1st1"),
    // alex-grover has email → top.
    [profileUrl("alex-grover")]: reLogin(baseEmail, "alex-grover"),
    [profileUrl("anatrajkovska")]: reLogin(baseNoEmail, "anatrajkovska"),
    [profileUrl("atinux")]: reLogin(baseBlog, "atinux"),
    [profileUrl("benjamincanac")]: reLogin(baseNoEmail, "benjamincanac"),
  });

  await runEnrichGithub({
    repo,
    http: client,
    confirm: true,
    now: () => new Date(),
    env: {},
  });

  const ranks = db
    .query<{ priority_rank: number | null }, [number]>(
      "SELECT priority_rank FROM contacts WHERE company_id = ? AND priority_rank IS NOT NULL ORDER BY priority_rank",
    )
    .all(acme.companyId)
    .map((r) => r.priority_rank);

  expect(ranks).toEqual([1, 2, 3, 4, 5]);
});

// ----- AC 5: risk level low/medium for public profile ----------------------

test("AC5: every github-sourced contact is risk low or medium", async () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "test", limit: 1 });
  const acme = repo.upsertCollectedLead(lead(), run.id);

  const baseNoEmail = loadFixture("profile-without-email.json");
  const baseEmail = loadFixture("profile-with-email.json");
  const baseBlog = loadFixture("profile-with-blog.json");
  const { client } = makeFakeHttpClient({
    [membersUrl("acme-ai")]: loadFixture("members.json"),
    [profileUrl("1st1")]: reLogin(baseNoEmail, "1st1"),
    [profileUrl("alex-grover")]: reLogin(baseEmail, "alex-grover"),
    [profileUrl("anatrajkovska")]: reLogin(baseNoEmail, "anatrajkovska"),
    [profileUrl("atinux")]: reLogin(baseBlog, "atinux"),
    [profileUrl("benjamincanac")]: reLogin(baseNoEmail, "benjamincanac"),
  });

  await runEnrichGithub({
    repo,
    http: client,
    confirm: true,
    now: () => new Date(),
    env: {},
  });

  // Pick the rows the enricher created (source_id pointing at our github source).
  const githubSourceIds = db
    .query<{ id: number }, []>(
      "SELECT id FROM sources WHERE source_type = 'github_profile'",
    )
    .all()
    .map((r) => r.id);
  const placeholders = githubSourceIds.map(() => "?").join(",");
  const rows = db
    .query<{ risk_level: string | null }, number[]>(
      `SELECT risk_level FROM contacts WHERE company_id = ${acme.companyId} AND source_id IN (${placeholders})`,
    )
    .all(...githubSourceIds);

  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(r.risk_level).not.toBeNull();
    expect(["low", "medium"]).toContain(r.risk_level as string);
  }
});

// ----- AC 6: 429 → enrichment_deferred, remaining items skipped -----------

test("AC6: 429 on the org call records a deferred source and skips the rest of the run", async () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "test", limit: 1 });
  const acme = repo.upsertCollectedLead(lead(), run.id);
  const beta = repo.upsertCollectedLead(
    lead({
      companyName: "Beta",
      domain: "beta.co",
      contacts: [
        {
          contactType: "github",
          value: "github.com/beta-org",
          riskLevel: "medium",
        },
      ],
    }),
    run.id,
  );

  // First org call exhausts retries → HttpRetryExhaustedError 429.
  const { client, calls } = makeFakeHttpClient({
    [membersUrl("acme-ai")]: new HttpRetryExhaustedError(
      membersUrl("acme-ai"),
      4,
      429,
      "API rate limit exceeded",
    ),
    // Beta's org call MUST NOT be made — but include it in the map so a
    // bug that does make the call surfaces as "unmapped url" only when
    // the bug is something else.
  });

  const result = await runEnrichGithub({
    repo,
    http: client,
    confirm: true,
    now: () => new Date(),
    env: {},
  });

  // The runs row finishes 'partial' (we partially completed: we skipped beta).
  expect(result.runId).toBeTruthy();
  const runStatus = db
    .query<{ status: string }, [string]>(
      "SELECT status FROM runs WHERE id = ?",
    )
    .get(result.runId!)?.status;
  expect(runStatus).toBe("partial");

  // Both companies got a deferred sources row.
  const deferredRows = db
    .query<{ c: number }, []>(
      "SELECT COUNT(*) AS c FROM sources WHERE source_type = 'github_profile' AND fetch_status = 'deferred'",
    )
    .get();
  expect(deferredRows?.c).toBe(2);

  // The acme org call happened; beta's org call must NOT have happened.
  const calledUrls = calls.map((c) => c.url);
  expect(calledUrls).toContain(membersUrl("acme-ai"));
  expect(calledUrls).not.toContain(membersUrl("beta-org"));

  // Per-company result counters.
  expect(result.companiesDeferred).toBeGreaterThanOrEqual(2);
  expect(result.contactsCreated).toBe(0);

  // Touch beta to silence unused-var.
  expect(beta.companyId).toBeGreaterThan(0);
  expect(acme.companyId).toBeGreaterThan(0);
});

test("AC6b: a 403 with 'rate limit' body is treated the same as 429", async () => {
  // GitHub's unauth rate limit returns 403 (not 429) with a body that
  // mentions "rate limit". HttpClient does not retry 403, so the enricher
  // sees HttpError with status=403 directly.
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "test", limit: 1 });
  repo.upsertCollectedLead(lead(), run.id);

  const { client } = makeFakeHttpClient({
    [membersUrl("acme-ai")]: {
      status: 403,
      body: '{"message":"API rate limit exceeded for IP 1.2.3.4"}',
    },
  });

  const result = await runEnrichGithub({
    repo,
    http: client,
    confirm: true,
    now: () => new Date(),
    env: {},
  });

  const deferredCount = db
    .query<{ c: number }, []>(
      "SELECT COUNT(*) AS c FROM sources WHERE source_type = 'github_profile' AND fetch_status = 'deferred'",
    )
    .get();
  expect(deferredCount?.c).toBe(1);
  expect(result.companiesDeferred).toBeGreaterThanOrEqual(1);
});

// ----- AC 7: GITHUB_TOKEN consumed ----------------------------------------

test("AC7a: GITHUB_TOKEN env var is forwarded as Authorization header on every call", async () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "test", limit: 1 });
  repo.upsertCollectedLead(lead(), run.id);

  const oneMember = JSON.stringify([
    { login: "1st1", html_url: "https://github.com/1st1" },
  ]);
  const { client, calls } = makeFakeHttpClient({
    [membersUrl("acme-ai")]: oneMember,
    [profileUrl("1st1")]: loadFixture("profile-without-email.json"),
  });

  await runEnrichGithub({
    repo,
    http: client,
    confirm: true,
    now: () => new Date(),
    env: { GITHUB_TOKEN: "ghp_test" },
  });

  // Every recorded call must carry the Authorization header. GitHub's REST
  // docs accept `Authorization: token <PAT>` (legacy) and `Bearer <PAT>`;
  // we pick one and assert. The test fixture is the contract — pick the
  // format that real GitHub returns 200 for in W-4 smoke.
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) {
    expect(c.headers["Authorization"]).toBe("Bearer ghp_test");
  }
});

test("AC7b: absent GITHUB_TOKEN means no Authorization header is sent", async () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "test", limit: 1 });
  repo.upsertCollectedLead(lead(), run.id);

  const oneMember = JSON.stringify([
    { login: "1st1", html_url: "https://github.com/1st1" },
  ]);
  const { client, calls } = makeFakeHttpClient({
    [membersUrl("acme-ai")]: oneMember,
    [profileUrl("1st1")]: loadFixture("profile-without-email.json"),
  });

  await runEnrichGithub({
    repo,
    http: client,
    confirm: true,
    now: () => new Date(),
    env: {},
  });

  for (const c of calls) {
    expect(c.headers["Authorization"]).toBeUndefined();
  }
});

// ----- AC 8: every enrichment writes a sources row -------------------------

test("AC8: a successful org enrichment writes a sources row, and new contacts point at it", async () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "test", limit: 1 });
  const acme = repo.upsertCollectedLead(lead(), run.id);

  const oneMember = JSON.stringify([
    { login: "1st1", html_url: "https://github.com/1st1" },
  ]);
  const { client } = makeFakeHttpClient({
    [membersUrl("acme-ai")]: oneMember,
    [profileUrl("1st1")]: loadFixture("profile-without-email.json"),
  });

  await runEnrichGithub({
    repo,
    http: client,
    confirm: true,
    now: () => new Date(),
    env: {},
  });

  const sourceRow = db
    .query<
      { id: number; source_type: string; fetch_status: string | null },
      []
    >(
      "SELECT id, source_type, fetch_status FROM sources WHERE source_type = 'github_profile'",
    )
    .get();
  expect(sourceRow?.fetch_status).toBe("success");

  const newContact = db
    .query<{ source_id: number | null }, [number, number]>(
      "SELECT source_id FROM contacts WHERE company_id = ? AND source_id = ?",
    )
    .get(acme.companyId, sourceRow!.id);
  // The new contact's source_id points at the github sources row.
  expect(newContact?.source_id).toBe(sourceRow!.id);
});

// ----- Baseline: dry-run, errors, idempotency, re-score --------------------

test("dry-run: no HTTP calls, no writes, but the plan reports what would be probed", async () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "test", limit: 1 });
  repo.upsertCollectedLead(lead(), run.id);

  const { client, calls } = makeFakeHttpClient({});

  const result = await runEnrichGithub({
    repo,
    http: client,
    confirm: false,
    now: () => new Date(),
    env: {},
  });

  expect(calls).toEqual([]);
  expect(result.orgsToProbe).toBe(1);
  expect(result.plan[0]?.orgSlug).toBe("acme-ai");

  const sourcesCount = db
    .query<{ c: number }, []>(
      "SELECT COUNT(*) AS c FROM sources WHERE source_type = 'github_profile'",
    )
    .get();
  expect(sourcesCount?.c).toBe(0);
});

test("per-company try/catch: one company's unexpected error doesn't abort the run (T-2)", async () => {
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "test", limit: 1 });
  repo.upsertCollectedLead(lead(), run.id);
  repo.upsertCollectedLead(
    lead({
      companyName: "Beta",
      domain: "beta.co",
      contacts: [
        {
          contactType: "github",
          value: "github.com/beta-org",
          riskLevel: "medium",
        },
      ],
    }),
    run.id,
  );
  repo.upsertCollectedLead(
    lead({
      companyName: "Gamma",
      domain: "gamma.co",
      contacts: [
        {
          contactType: "github",
          value: "github.com/gamma-org",
          riskLevel: "medium",
        },
      ],
    }),
    run.id,
  );

  // acme: OK. beta: unexpected throw (something non-HTTP). gamma: OK.
  const oneMember = JSON.stringify([
    { login: "1st1", html_url: "https://github.com/1st1" },
  ]);
  const { client } = makeFakeHttpClient({
    [membersUrl("acme-ai")]: oneMember,
    [profileUrl("1st1")]: loadFixture("profile-without-email.json"),
    [membersUrl("beta-org")]: new Error("unexpected blow-up"),
    [membersUrl("gamma-org")]: oneMember,
    // Same login fixture reused for gamma's profile call.
  });

  const result = await runEnrichGithub({
    repo,
    http: client,
    confirm: true,
    now: () => new Date(),
    env: {},
  });

  // acme + gamma succeed; beta logs companyErrors but the loop continues.
  expect(result.companyErrors).toBe(1);
  expect(result.orgsProbed).toBe(2);
});

test("T-2: a recordDeferred throw in the rate-limited skip branch does NOT abort the loop", async () => {
  // pr-review LOW #1 (CLAUDE.local.md T-2): once the first company trips
  // the rate limit, every subsequent company hits a tiny "skip branch"
  // that writes a deferred sources row. If THAT write throws (disk full,
  // FK violation, anything), the loop must keep going and the remaining
  // companies must still get their deferred markers — same per-item
  // guarantee the "real processCompany" branch already enjoys.
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "test", limit: 1 });
  // Three orgs: A trips rate limit on its members fetch; B's skip-branch
  // deferred write blows up; C must still get its deferred marker.
  repo.upsertCollectedLead(
    lead({
      companyName: "A",
      domain: "a.co",
      contacts: [
        { contactType: "github", value: "github.com/a-org", riskLevel: "medium" },
      ],
    }),
    run.id,
  );
  repo.upsertCollectedLead(
    lead({
      companyName: "B",
      domain: "b.co",
      contacts: [
        { contactType: "github", value: "github.com/b-org", riskLevel: "medium" },
      ],
    }),
    run.id,
  );
  repo.upsertCollectedLead(
    lead({
      companyName: "C",
      domain: "c.co",
      contacts: [
        { contactType: "github", value: "github.com/c-org", riskLevel: "medium" },
      ],
    }),
    run.id,
  );

  const { client } = makeFakeHttpClient({
    // GitHub's unauth rate-limit returns 403 with body mentioning "rate limit"
    // (see AC6b); that's the shape isRateLimitError recognises from a single
    // non-retried response (HttpClient doesn't retry 403).
    [membersUrl("a-org")]: {
      status: 403,
      body: '{"message":"API rate limit exceeded for IP 1.2.3.4"}',
    },
    // b-org / c-org members URLs are never called — they're in the skip
    // branch. Leaving them unmapped is the strongest assertion that we
    // never re-hit the API after the rate-limit flag is set.
  });

  // Wrap recordGithubEnrichment so only B's deferred write throws.
  const orig = repo.recordGithubEnrichment.bind(repo);
  repo.recordGithubEnrichment = (input) => {
    if (input.fetchStatus === "deferred" && input.orgSlug === "b-org") {
      throw new Error("simulated disk-full on B's deferred write");
    }
    return orig(input);
  };

  const result = await runEnrichGithub({
    repo,
    http: client,
    confirm: true,
    now: () => new Date(),
    env: {},
  });

  // A: deferred via 429 path. B: error (forced throw). C: deferred via skip.
  expect(result.companyErrors).toBe(1);
  const deferredRows = db
    .query<{ c: number }, []>(
      "SELECT COUNT(*) AS c FROM sources WHERE source_type='github_profile' AND fetch_status='deferred'",
    )
    .get();
  expect(deferredRows?.c).toBe(2);
  // Runs row reflects mixed outcome.
  const runStatus = db
    .query<{ status: string }, [string]>(
      "SELECT status FROM runs WHERE id = ?",
    )
    .get(result.runId!)?.status;
  expect(runStatus).toBe("partial");
});

test("T-2: a per-profile fetch failure mid-org is logged to stderr (no silent void err)", async () => {
  // pr-review LOW #2 (CLAUDE.local.md T-2): "不要 void err" — swallowing
  // a profile-fetch exception with bare `continue` hides real bugs
  // (e.g. a parser crash masquerading as a network failure). The catch
  // must at minimum stderr-log the failure so operators see it.
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "test", limit: 1 });
  repo.upsertCollectedLead(lead(), run.id);

  const members = JSON.stringify([
    { login: "good-user", html_url: "https://github.com/good-user" },
    { login: "ghost-user", html_url: "https://github.com/ghost-user" },
  ]);
  const { client } = makeFakeHttpClient({
    [membersUrl("acme-ai")]: members,
    [profileUrl("good-user")]: loadFixture("profile-with-email.json"),
    [profileUrl("ghost-user")]: {
      status: 500,
      body: '{"message":"server panic"}',
    },
  });

  const writes: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write;

  try {
    await runEnrichGithub({
      repo,
      http: client,
      confirm: true,
      now: () => new Date(),
      env: {},
    });
  } finally {
    process.stderr.write = origWrite;
  }

  // The failure must appear on stderr in some recognisable form.
  expect(writes.some((w) => w.includes("ghost-user"))).toBe(true);
});

test("404 from org call (private/user account) is silent, not an error", async () => {
  // GitHub returns 404 when the slug is a user or a private org. We treat
  // that as "nothing to enrich here" — not a failure — so the runs row
  // can still finish 'completed' if no other company errored.
  const { repo } = createInMemoryRepository();
  const run = repo.startRun({ source: "test", limit: 1 });
  repo.upsertCollectedLead(lead(), run.id);

  const { client } = makeFakeHttpClient({
    [membersUrl("acme-ai")]: { status: 404, body: '{"message":"Not Found"}' },
  });

  const result = await runEnrichGithub({
    repo,
    http: client,
    confirm: true,
    now: () => new Date(),
    env: {},
  });

  expect(result.companyErrors).toBe(0);
  expect(result.companiesDeferred).toBe(0);
  expect(result.contactsCreated).toBe(0);
});

test("idempotency: running enrich twice does not duplicate contacts", async () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "test", limit: 1 });
  const acme = repo.upsertCollectedLead(lead(), run.id);

  const oneMember = JSON.stringify([
    { login: "1st1", html_url: "https://github.com/1st1" },
  ]);
  const fixtures = {
    [membersUrl("acme-ai")]: oneMember,
    [profileUrl("1st1")]: loadFixture("profile-without-email.json"),
  };

  for (let i = 0; i < 2; i++) {
    const { client } = makeFakeHttpClient(fixtures);
    await runEnrichGithub({
      repo,
      http: client,
      confirm: true,
      now: () => new Date(),
      env: {},
    });
  }

  const oneStOneRows = db
    .query<{ c: number }, [number]>(
      "SELECT COUNT(*) AS c FROM contacts WHERE company_id = ? AND contact_type = 'github' AND value = 'github.com/1st1'",
    )
    .get(acme.companyId);
  expect(oneStOneRows?.c).toBe(1);
});

test("idempotency: the second run reports contactsCreated=0 and does NOT append a re-score row (C3)", async () => {
  // Counter honesty + careers C3 lesson: a re-run that finds every
  // candidate already on file must report 0 new contacts AND must not
  // write a fresh lead_scores row attributing a stale decision to the
  // enrich run. The sources row IS still written (audit signal that the
  // probe happened); only the contacts + lead_scores writes are gated.
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "test", limit: 1 });
  const acme = repo.upsertCollectedLead(lead(), run.id);

  const oneMember = JSON.stringify([
    { login: "1st1", html_url: "https://github.com/1st1" },
  ]);
  const fixtures = {
    [membersUrl("acme-ai")]: oneMember,
    [profileUrl("1st1")]: loadFixture("profile-without-email.json"),
  };

  const { client: c1 } = makeFakeHttpClient(fixtures);
  const first = await runEnrichGithub({
    repo,
    http: c1,
    confirm: true,
    now: () => new Date(),
    env: {},
  });
  expect(first.contactsCreated).toBe(1);

  const scoreRowsAfterFirst = db
    .query<{ c: number }, [number]>(
      "SELECT COUNT(*) AS c FROM lead_scores WHERE company_id = ?",
    )
    .get(acme.companyId)?.c ?? 0;

  const { client: c2 } = makeFakeHttpClient(fixtures);
  const second = await runEnrichGithub({
    repo,
    http: c2,
    confirm: true,
    now: () => new Date(),
    env: {},
  });
  // Counter must reflect actual DB change, not "would-be candidates."
  expect(second.contactsCreated).toBe(0);

  const scoreRowsAfterSecond = db
    .query<{ c: number }, [number]>(
      "SELECT COUNT(*) AS c FROM lead_scores WHERE company_id = ?",
    )
    .get(acme.companyId)?.c ?? 0;
  expect(scoreRowsAfterSecond).toBe(scoreRowsAfterFirst);
});

test("re-score: a new lead_scores row appends after a successful enrichment", async () => {
  const { repo, db } = createInMemoryRepository();
  const run = repo.startRun({ source: "test", limit: 1 });
  const acme = repo.upsertCollectedLead(lead(), run.id);
  // Baseline score the collect path would have written.
  repo.writeLeadScore({
    companyId: acme.companyId,
    runId: run.id,
    score: 10,
    jobMatchScore: 5,
    directionScore: 5,
    freshnessScore: 0,
    contactScore: 0,
    actionabilityScore: 0,
    matchReason: [],
    decision: "local_only",
    scorerVersion: "1.0.0",
  });

  const oneMember = JSON.stringify([
    { login: "alex-grover", html_url: "https://github.com/alex-grover" },
  ]);
  const { client } = makeFakeHttpClient({
    [membersUrl("acme-ai")]: oneMember,
    [profileUrl("alex-grover")]: loadFixture("profile-with-email.json"),
  });

  await runEnrichGithub({
    repo,
    http: client,
    confirm: true,
    now: () => new Date(),
    env: {},
  });

  const rows = db
    .query<{ contact_score: number; created_at: string }, [number]>(
      "SELECT contact_score, created_at FROM lead_scores WHERE company_id = ? ORDER BY id",
    )
    .all(acme.companyId);
  // Baseline + re-score row.
  expect(rows.length).toBeGreaterThanOrEqual(2);
  // The re-score reflects the new low-risk email contact: contact_score > 0.
  expect(rows.at(-1)!.contact_score).toBeGreaterThan(rows[0]!.contact_score);
});

// touch HttpError so the import is not flagged as unused on lint runs that
// drop tests; the type is referenced by makeFakeHttpClient's internals.
test("HttpError shape stays compatible", () => {
  const e = new HttpError("u", 500, "b");
  expect(e.status).toBe(500);
});
