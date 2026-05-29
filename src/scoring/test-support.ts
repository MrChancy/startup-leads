import type {
  ScoreCompanyInput,
  ScoreContact,
  ScoreJob,
} from "./types.ts";

// Default "now" used in every test so freshness math is deterministic.
export const FIXED_NOW = new Date("2025-06-01T00:00:00.000Z");

export function makeJob(overrides: Partial<ScoreJob> = {}): ScoreJob {
  return {
    title: "Backend Engineer",
    freshness: "fresh",
    evidenceSourceId: 1,
    ...overrides,
  };
}

export function makeContact(overrides: Partial<ScoreContact> = {}): ScoreContact {
  return {
    contactType: "email",
    riskLevel: "low",
    evidenceSourceId: 1,
    ...overrides,
  };
}

export function makeTestCompany(
  overrides: Partial<ScoreCompanyInput> = {},
): ScoreCompanyInput {
  return {
    companyId: 1,
    directionTags: ["backend"],
    jobs: [makeJob()],
    contacts: [makeContact()],
    excludedByRule: false,
    exclusionReason: null,
    primarySourceId: 1,
    now: FIXED_NOW,
    ...overrides,
  };
}
