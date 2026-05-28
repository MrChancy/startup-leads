// Public storage surface.
// Callers outside src/storage/sqlite/ only see this file — never bun:sqlite.

export type {
  LeadRepository,
  RunRecord,
  RunCounts,
  RunStatus,
  StoredLeadResult,
  CollectedLead,
  CollectedJob,
  CollectedContact,
  FreshnessStatus,
} from "../types/index.ts";

export { openLeadRepository } from "./sqlite/open.ts";
export { createInMemoryRepository } from "./sqlite/test-support.ts";
