import type { CollectedLead } from "../types/index.ts";
import type { Collector } from "./types.ts";

// TB-1/TB-2 only. Three hardcoded leads spanning the decision space so the
// scoring pipeline produces visible distribution without needing real
// collectors. TB-3b's HN collector will replace this entirely.
//
// - Acme AI:   strong signal (backend engineer + AI-native + low-risk
//              contact + fresh) → accepted_for_feishu band.
// - Beta Cloud: mid signal (devtools + no contacts + usable) → typically
//              local_only or needs_review depending on score band.
// - Gamma Labs: weak signal (stale jobs only) → stale override.
export const fakeCollector: Collector = {
  source: "fake",
  async collect() {
    const retrievedAt = new Date().toISOString();
    const leads: CollectedLead[] = [
      {
        companyName: "Acme AI",
        domain: "acme.ai",
        description: "AI-native infra startup.",
        directionTags: ["ai-native", "ai-infra"],
        jobs: [
          {
            title: "Backend Engineer",
            jobUrl: "https://acme.ai/jobs/backend-engineer",
            location: "Remote",
            remotePolicy: "remote",
            freshness: "fresh",
          },
        ],
        contacts: [
          {
            name: "Alice",
            title: "CTO",
            contactType: "email",
            value: "alice@acme.ai",
            riskLevel: "low",
          },
        ],
        source: {
          sourceType: "fake",
          sourceUrl: "fake://acme",
          sourceTitle: "Fake Collector",
          retrievedAt,
        },
      },
      {
        companyName: "Beta Cloud",
        domain: "beta.cloud",
        description: "Developer tools company.",
        directionTags: ["devtools"],
        jobs: [
          {
            title: "Software Engineer",
            jobUrl: "https://beta.cloud/jobs/swe",
            freshness: "usable",
          },
        ],
        contacts: [],
        source: {
          sourceType: "fake",
          sourceUrl: "fake://beta",
          sourceTitle: "Fake Collector",
          retrievedAt,
        },
      },
      {
        companyName: "Gamma Labs",
        domain: "gamma.labs",
        description: "Stale postings, demoes the stale override.",
        directionTags: ["backend"],
        jobs: [
          {
            title: "Senior Backend Engineer",
            jobUrl: "https://gamma.labs/jobs/senior-be",
            freshness: "stale",
          },
        ],
        contacts: [],
        source: {
          sourceType: "fake",
          sourceUrl: "fake://gamma",
          sourceTitle: "Fake Collector",
          retrievedAt,
        },
      },
    ];
    return leads;
  },
};
