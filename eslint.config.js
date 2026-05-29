// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "data/**", "dist/**", "index.ts"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
