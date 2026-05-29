import { test, expect } from "bun:test";
import { fakeCollector } from "./fake.ts";

test("fakeCollector advertises source = 'fake'", () => {
  expect(fakeCollector.source).toBe("fake");
});

test("fakeCollector returns three leads spanning the decision space", async () => {
  // Three leads so TB-2's decision-distribution report has something
  // visible to print without needing a real collector.
  const leads = await fakeCollector.collect({ limit: 50 });
  expect(leads).toHaveLength(3);

  const names = leads.map((l) => l.companyName);
  expect(names).toEqual(["Acme AI", "Beta Cloud", "Gamma Labs"]);

  // Spot-check the freshness mix so a refactor that flattens all leads to
  // 'fresh' (which would kill the distribution) trips the test.
  const freshnessMix = leads.map((l) => l.jobs[0]?.freshness);
  expect(freshnessMix).toEqual(["fresh", "usable", "stale"]);

  // Acme keeps a low-risk contact so accepted_for_feishu can fire.
  const acme = leads[0]!;
  expect(acme.contacts).toHaveLength(1);
  expect(acme.contacts[0]!.riskLevel).toBe("low");

  // Beta / Gamma have no contacts (drives needs_review / stale decision).
  expect(leads[1]!.contacts).toHaveLength(0);
  expect(leads[2]!.contacts).toHaveLength(0);

  // Every lead uses a valid direction tag from the spec enum (no
  // 'ai-application' or similar legacy values).
  for (const lead of leads) {
    for (const tag of lead.directionTags ?? []) {
      expect([
        "backend",
        "ai-app",
        "ai-infra",
        "ai-native",
        "devtools",
        "overseas",
        "remote-friendly",
        "china-timezone",
      ]).toContain(tag);
    }
  }
});
