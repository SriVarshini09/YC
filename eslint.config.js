import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "fixtures/**", "packages/*/test/fixtures/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["**/bin/*.js"], languageOptions: { globals: { process: "readonly" } } },
  {
    files: ["research/scripts/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", fetch: "readonly", setTimeout: "readonly", AbortSignal: "readonly", URL: "readonly" },
    },
  },
);
