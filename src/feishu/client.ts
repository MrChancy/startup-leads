// Public Feishu client surface. v1 has two implementations:
//   - InMemoryFeishuClient (this PR, TB-6): keeps records in a Map so dry-run,
//     unit tests, and offline development never touch the network.
//   - LarkCliFeishuClient   (TB-7, behind HITL gate): shells out to lark-cli
//     for the real Lark Bitable API.
//
// Both share this interface so the dry-run CLI path and the real push path
// (TB-8) can be wired against identical types — TB-8 just swaps the
// implementation. Per spec "推送行为规则", the caller is responsible for the
// upsert lookup order (Local ID → Domain → create); the client only exposes
// the primitives so the caller can build that flow.

export interface ProvisionInput {
  // Human-readable name for the new Bitable app. Real client renders this in
  // the Lark UI; in-memory client just echoes it in ProvisionResult so a test
  // can assert provision() was called with the right input.
  name: string;
}

export interface ProvisionResult {
  appToken: string;
  tableId: string;
  // Map from logical field name (e.g. "Company", "Score", "Scorer Version")
  // to its Lark Bitable field id. The real client gets these from the API
  // response. v1 dry-run never reads from this map — it's here so TB-8 can
  // build the right field-by-id payload without re-provisioning.
  fieldIds: Record<string, string>;
}

// One company's worth of data, already truncated and ordered by the mapper.
// The client treats this as opaque: it just hands fields to the backend.
export interface CompanyLead {
  // Internal company.id. Used to derive localId (`company-<id>`) so the
  // upsert lookup remains stable across re-provisioning.
  companyId: number;
  // The "Local ID" field in the Bitable record. Spec: "Local ID" is the
  // first lookup key in the upsert flow, so it must be deterministic per
  // company and survive a re-provision.
  localId: string;
  name: string;
  domain: string | null;
  website: string | null;
  description: string | null;
  directionTags: readonly string[];
  topJobs: readonly TopJob[];
  topContacts: readonly TopContact[];
  // Free-form human description ("Remote / Berlin", "On-site SF"). The
  // mapper derives this from the top jobs' location + remote_policy fields;
  // the client just echoes it.
  remoteLocation: string | null;
  // Company-level freshness rolls up the max of the top jobs' freshness.
  // The mapper computes this so the client doesn't need to know the order.
  freshness: import("../types/index.ts").FreshnessStatus;
  score: number;
  scorerVersion: string;
  matchReason: readonly import("../types/index.ts").LeadScoreMatchReasonEntry[];
  // Source URLs ("https://news.ycombinator.com/item?id=...", company careers
  // page, etc.) extracted from the sources table. One per row.
  sources: readonly string[];
  // ISO timestamp of the latest lead_scores row for this company. Spec
  // "Last Checked At".
  lastCheckedAt: string;
}

export interface TopJob {
  title: string;
  jobUrl: string | null;
  location: string | null;
  remotePolicy: string | null;
  freshness: import("../types/index.ts").FreshnessStatus;
  // ISO timestamp the source posted the job. Used as the secondary sort
  // key inside the mapper.
  sourcePostedAt: string | null;
}

export interface TopContact {
  name: string | null;
  title: string | null;
  contactType: string;
  value: string;
  profileUrl: string | null;
  riskLevel: import("../types/index.ts").RiskLevel;
  // Lower rank == higher priority. null means "ranker hasn't run yet".
  priorityRank: number | null;
}

export interface FeishuRecord {
  recordId: string;
  localId: string;
  // The full set of fields as they were last upserted. Real client returns
  // exactly what the API returned; in-memory client returns the payload
  // it was handed at upsert time.
  fields: Record<string, unknown>;
}

export interface PushResult {
  recordId: string;
  // true on create, false on update. TB-8 uses this to drive the
  // push_events.status column.
  created: boolean;
}

export interface FeishuClient {
  // Idempotent: calling provision() twice returns a (possibly new) result;
  // the in-memory impl resets internal state so tests can re-run cleanly.
  provision(input: ProvisionInput): Promise<ProvisionResult>;
  upsertCompanyLead(lead: CompanyLead): Promise<PushResult>;
  // Spec: upsert order is Local ID first, then Domain. Both lookups return
  // null on miss; the caller decides whether to call upsertCompanyLead next.
  findRecordByLocalId(localId: string): Promise<FeishuRecord | null>;
  findRecordByDomain(domain: string): Promise<FeishuRecord | null>;
}
