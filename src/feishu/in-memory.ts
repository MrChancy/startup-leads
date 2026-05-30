import type {
  CompanyLead,
  FeishuClient,
  FeishuRecord,
  ProvisionInput,
  ProvisionResult,
  PushResult,
} from "./client.ts";
import { mapToFeishuFields } from "./mapper.ts";

// Logical field name → opaque field id. The mapper emits the SAME keys, so
// the in-memory client's stored `fields` map is a direct match for what the
// real Lark API would echo back. Keeping the list here (not in client.ts)
// avoids a circular import and keeps the contract in one file with its
// only consumer.
const FIELD_NAMES = [
  "Company",
  "Website",
  "Domain",
  "Direction Tags",
  "Top Jobs",
  "Remote / Location",
  "Freshness",
  "Score",
  "Scorer Version",
  "Match Reason",
  "Recommended Contacts",
  "Contact Risk",
  "Sources",
  "Status",
  "Last Checked At",
  "Local ID",
  "Review Notes",
] as const;

// Generate a stable but readable field id for tests. Real Lark field ids
// are 7-char base62 like `fldXYZ`; ours just makes the name traceable.
function makeFieldId(name: string): string {
  return `fld_${name.replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase()}`;
}

interface InMemoryState {
  records: Map<string, FeishuRecord>;          // recordId → record
  byLocalId: Map<string, string>;               // localId   → recordId
  byDomain: Map<string, string>;                // domain    → recordId
  nextRecordId: number;
}

function freshState(): InMemoryState {
  return {
    records: new Map(),
    byLocalId: new Map(),
    byDomain: new Map(),
    nextRecordId: 1,
  };
}

export function createInMemoryFeishuClient(): FeishuClient {
  let state: InMemoryState | null = null;

  function requireProvisioned(): InMemoryState {
    if (!state) {
      throw new Error(
        "InMemoryFeishuClient: provision() must be called before any read or write",
      );
    }
    return state;
  }

  return {
    async provision(input: ProvisionInput): Promise<ProvisionResult> {
      // input.name is intentionally not echoed back — the in-memory fake
      // returns a fixed table identity so tests are deterministic. The
      // real client (TB-7) will use input.name as the new Bitable's title.
      void input;
      // Reset on every provision so tests don't leak between cases. The
      // real client wouldn't reset, but for an in-memory fake the only
      // way to "re-provision" is to start fresh.
      state = freshState();
      const fieldIds: Record<string, string> = {};
      for (const name of FIELD_NAMES) {
        fieldIds[name] = makeFieldId(name);
      }
      return {
        appToken: "memapp_startup_leads",
        tableId: "tbl_startup_leads",
        fieldIds,
      };
    },

    async upsertCompanyLead(lead: CompanyLead): Promise<PushResult> {
      const s = requireProvisioned();
      const fields = mapToFeishuFields(lead);
      const existingId = s.byLocalId.get(lead.localId);
      if (existingId) {
        const record: FeishuRecord = {
          recordId: existingId,
          localId: lead.localId,
          fields,
        };
        s.records.set(existingId, record);
        // Domain may have changed since the last upsert; refresh the index.
        // We deliberately do NOT prune the old domain entry — leads keep
        // historical aliases so a later findRecordByDomain still locates
        // the record under any prior key. (Real Lark Bitable behaves the
        // same way since it's just a column, not a unique index.)
        if (lead.domain) s.byDomain.set(lead.domain, existingId);
        return { recordId: existingId, created: false };
      }
      const recordId = `rec_${s.nextRecordId++}`;
      const record: FeishuRecord = {
        recordId,
        localId: lead.localId,
        fields,
      };
      s.records.set(recordId, record);
      s.byLocalId.set(lead.localId, recordId);
      // Skip indexing leads with no domain — an empty/null key would
      // collide every nameless lead onto the same record. The Local ID
      // path is sufficient for those.
      if (lead.domain) s.byDomain.set(lead.domain, recordId);
      return { recordId, created: true };
    },

    async findRecordByLocalId(localId: string): Promise<FeishuRecord | null> {
      const s = requireProvisioned();
      const recordId = s.byLocalId.get(localId);
      if (!recordId) return null;
      return s.records.get(recordId) ?? null;
    },

    async findRecordByDomain(domain: string): Promise<FeishuRecord | null> {
      const s = requireProvisioned();
      if (!domain) return null;
      const recordId = s.byDomain.get(domain);
      if (!recordId) return null;
      return s.records.get(recordId) ?? null;
    },
  };
}
