import type { CollectedLead } from "../types/index.ts";

export interface Collector {
  readonly source: string;
  collect(input: { limit: number }): Promise<CollectedLead[]>;
}
