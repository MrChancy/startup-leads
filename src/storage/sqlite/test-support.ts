import { Database } from "bun:sqlite";
import type { LeadRepository } from "../../types/index.ts";
import { runMigrations } from "./migrations.ts";
import { createSqliteLeadRepository } from "./repository.ts";

// Test-only helper. Centralizes the bun:sqlite import so test files don't
// need it themselves; `db` is exposed for ad-hoc verification queries that
// don't deserve a dedicated `peek` method.
export interface InMemoryRepository {
  repo: LeadRepository;
  db: Database;
  peek: {
    runRow(
      runId: string,
    ): { status: string; source: string; limitValue: number } | null;
    companyCount(): number;
  };
  close(): void;
}

export function createInMemoryRepository(): InMemoryRepository {
  const db = new Database(":memory:");
  runMigrations(db);
  const repo = createSqliteLeadRepository(db);

  return {
    repo,
    db,
    peek: {
      runRow(runId) {
        const row = db
          .query<
            { status: string; source: string; limit_value: number },
            [string]
          >("SELECT status, source, limit_value FROM runs WHERE id = ?")
          .get(runId);
        if (!row) {
          return null;
        }
        return {
          status: row.status,
          source: row.source,
          limitValue: row.limit_value,
        };
      },
      companyCount() {
        const row = db
          .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM companies")
          .get();
        return row?.c ?? 0;
      },
    },
    close: () => db.close(),
  };
}
