import { test, expect } from "bun:test";
import {
  DIRECTION_TAGS,
  isDirectionTag,
  type DirectionTag,
} from "./direction-tags.ts";

test("DIRECTION_TAGS contains exactly the spec's enum members", () => {
  // Spec § 方向标签枚举.
  // Cast the received to string[] so the expected literal doesn't need to
  // widen — toEqual infers its parameter from the received side.
  expect(([...DIRECTION_TAGS] as string[]).sort()).toEqual(
    [
      "backend",
      "ai-app",
      "ai-infra",
      "ai-native",
      "devtools",
      "overseas",
      "remote-friendly",
      "china-timezone",
    ].sort(),
  );
});

test("isDirectionTag accepts known tags", () => {
  expect(isDirectionTag("backend")).toBe(true);
  expect(isDirectionTag("ai-app")).toBe(true);
});

test("isDirectionTag rejects unknown tags", () => {
  expect(isDirectionTag("ai-application")).toBe(false);
  expect(isDirectionTag("")).toBe(false);
  expect(isDirectionTag("BACKEND")).toBe(false);
});

test("DirectionTag type widens to string for assignability", () => {
  // Compile-time sanity check: each enum value is a DirectionTag.
  const tags: DirectionTag[] = ["backend", "ai-app", "ai-infra"];
  expect(tags).toHaveLength(3);
});
