import type { CollectedLead } from "../types/index.ts";
import type { Collector } from "./types.ts";

// TB-1 only. Hardcoded so the walking skeleton has something to collect
// before real HN/YC/careers collectors land.
export const fakeCollector: Collector = {
  source: "fake",
  async collect() {
    const retrievedAt = new Date().toISOString();
    const lead: CollectedLead = {
      companyName: "Acme AI",
      domain: "acme.ai",
      description: "Hardcoded fake company used by the walking skeleton.",
      directionTags: ["ai-application"],
      jobs: [
        {
          title: "Backend Engineer",
          jobUrl: "https://acme.ai/jobs/backend-engineer",
          location: "Remote",
          remotePolicy: "remote",
          freshness: "fresh",
        },
      ],
      contacts: [],
      source: {
        sourceType: "fake",
        sourceUrl: "fake://acme",
        sourceTitle: "Fake Collector",
        retrievedAt,
      },
    };
    return [lead];
  },
};
