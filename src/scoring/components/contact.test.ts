import { test, expect } from "bun:test";
import { scoreContact } from "./contact.ts";
import { makeContact, makeTestCompany } from "../test-support.ts";

test("no contacts scores 0 with an explanatory note (not undefined)", () => {
  // CLAUDE.local.md I-2: 'not found' != '0 score silently'. Must surface
  // the note so reviewers can tell apart "no contact data yet" from "we
  // looked and found bad ones".
  const result = scoreContact(makeTestCompany({ contacts: [] }));
  expect(result.points).toBe(0);
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]?.note).toMatch(/no contacts/i);
});

test("a single low-risk email contact hits the cap", () => {
  const result = scoreContact(
    makeTestCompany({
      contacts: [
        makeContact({ contactType: "email", riskLevel: "low" }),
      ],
    }),
  );
  expect(result.points).toBe(15);
});

test("a medium-risk contact scores partial credit", () => {
  const result = scoreContact(
    makeTestCompany({
      contacts: [
        makeContact({ contactType: "linkedin", riskLevel: "medium" }),
      ],
    }),
  );
  expect(result.points).toBeGreaterThan(0);
  expect(result.points).toBeLessThan(15);
});

test("high-risk contacts score 0", () => {
  const result = scoreContact(
    makeTestCompany({
      contacts: [
        makeContact({ contactType: "linkedin", riskLevel: "high" }),
      ],
    }),
  );
  expect(result.points).toBe(0);
});

test("blocked contacts contribute 0 and are flagged for the override path", () => {
  // The decision layer turns "any blocked contact" into blocked_contact
  // regardless of score; the component itself only confirms 0 points.
  const result = scoreContact(
    makeTestCompany({
      contacts: [
        makeContact({ riskLevel: "blocked" }),
      ],
    }),
  );
  expect(result.points).toBe(0);
  expect(result.entries[0]?.note).toMatch(/blocked/i);
});

test("only-blocked contacts is distinguishable from no contacts", () => {
  const blocked = scoreContact(
    makeTestCompany({
      contacts: [makeContact({ riskLevel: "blocked" })],
    }),
  );
  const empty = scoreContact(makeTestCompany({ contacts: [] }));
  expect(blocked.entries[0]?.note).not.toBe(empty.entries[0]?.note);
});

test("multiple contacts pick the best one (low-risk wins over high-risk)", () => {
  const result = scoreContact(
    makeTestCompany({
      contacts: [
        makeContact({ riskLevel: "high" }),
        makeContact({ riskLevel: "low" }),
      ],
    }),
  );
  expect(result.points).toBe(15);
});
