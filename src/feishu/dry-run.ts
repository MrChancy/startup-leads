import type { FeishuPayload } from "./mapper.ts";

export interface DryRunOptions {
  minScore: number;
}

// Format the payload list for human review. Output shape:
//
//   Feishu dry-run: N candidates (min-score=M, threshold-inclusive)
//
//   --- company-<id> ---
//   { ...json payload... }
//
//   --- company-<id> ---
//   { ...json payload... }
//
// Deterministic so two `push-feishu --dry-run` invocations on the same
// state produce byte-identical output (S-3). No "pushed" / "sent" verbs
// anywhere — the operator must be able to tell at a glance this didn't
// write anywhere.
export function formatDryRun(
  payloads: readonly FeishuPayload[],
  options: DryRunOptions,
): string {
  if (payloads.length === 0) {
    return (
      `Feishu dry-run: no candidates ` +
      `(min-score=${options.minScore}). Nothing would be pushed.`
    );
  }
  const noun = payloads.length === 1 ? "candidate" : "candidates";
  const lines: string[] = [
    `Feishu dry-run: ${payloads.length} ${noun} ` +
      `(min-score=${options.minScore}). Nothing was written.`,
  ];
  for (const p of payloads) {
    lines.push("");
    lines.push(`--- ${p.localId} ---`);
    lines.push(JSON.stringify(p, null, 2));
  }
  return lines.join("\n");
}
