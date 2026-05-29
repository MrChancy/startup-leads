import { test, expect } from "bun:test";
import { fakeCollector } from "./fake.ts";

test("fakeCollector advertises source = 'fake'", () => {
  expect(fakeCollector.source).toBe("fake");
});

test("fakeCollector returns one Acme AI lead", async () => {
  const leads = await fakeCollector.collect({ limit: 50 });
  expect(leads).toHaveLength(1);
  const lead = leads[0]!;
  expect(lead.companyName).toBe("Acme AI");
  expect(lead.domain).toBe("acme.ai");
  expect(lead.jobs).toHaveLength(1);
  expect(lead.jobs[0]!.title).toBe("Backend Engineer");
  expect(lead.jobs[0]!.freshness).toBe("fresh");
  expect(lead.contacts).toHaveLength(0);
  expect(lead.source.sourceType).toBe("fake");
});
