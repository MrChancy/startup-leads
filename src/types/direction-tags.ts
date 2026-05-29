// Spec § 方向标签枚举. Fixed enum; unknown tags are rejected at the storage
// boundary (TB-4) and ignored with a warning at the scoring boundary (here +
// TB-2). Adding a tag that changes scoring weights requires a SCORER_VERSION
// bump.

export const DIRECTION_TAGS = [
  "backend",
  "ai-app",
  "ai-infra",
  "ai-native",
  "devtools",
  "overseas",
  "remote-friendly",
  "china-timezone",
] as const;

export type DirectionTag = (typeof DIRECTION_TAGS)[number];

export function isDirectionTag(tag: string): tag is DirectionTag {
  return (DIRECTION_TAGS as readonly string[]).includes(tag);
}
