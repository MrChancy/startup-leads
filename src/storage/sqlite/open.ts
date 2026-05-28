import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LeadRepository } from "../../types/index.ts";
import { runMigrations } from "./migrations.ts";
import { createSqliteLeadRepository } from "./repository.ts";

export interface OpenedRepository {
  repo: LeadRepository;
  close(): void;
}

export function openLeadRepository(dbPath: string): OpenedRepository {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  runMigrations(db);
  const repo = createSqliteLeadRepository(db);
  return { repo, close: () => db.close() };
}
