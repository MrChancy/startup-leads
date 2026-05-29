import type { CollectedLead } from "../types/index.ts";

// TB-3b: collectors now report parse / fetch failures alongside leads so the
// orchestrator can attribute them to the run (parse_failed / fetch_failed
// events). Fake collectors hard-code 0 for both, which is honest — they have
// no network and no parser. Real collectors (HN, careers, GitHub) MUST count
// every comment / page they decided to drop, never "0 because it's
// inconvenient" (CLAUDE.local.md I-1).
export interface CollectorResult {
  leads: CollectedLead[];
  parseFailed: number;
  fetchFailed: number;
}

export interface CollectInput {
  limit: number;
}

export interface Collector {
  readonly source: string;
  collect(input: CollectInput): Promise<CollectorResult>;
}
