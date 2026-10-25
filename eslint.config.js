import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "fixtures/**", "packages/*/test/fixtures/**", "site/.vitepress/cache/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["**/bin/*.js"], languageOptions: { globals: { process: "readonly" } } },
  { files: ["brand/*.mjs"], languageOptions: { globals: { console: "readonly" } } },
);
