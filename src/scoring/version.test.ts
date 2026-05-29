import { test, expect } from "bun:test";
import { SCORER_VERSION } from "./version.ts";

// Pinned at "1.0.0" by spec; bumping requires updating this test on purpose
// so reviewers see the version change land alongside the rule change.
test("SCORER_VERSION is the semver string 1.0.0", () => {
  expect(SCORER_VERSION).toBe("1.0.0");
});
