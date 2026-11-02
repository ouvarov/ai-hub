import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.wrangler/**",
      // Generated files — owned by scripts, not hand-edited.
      "skill-runner/src/bundled-docs.ts",
      "skill-runner/src/vault-keys.generated.ts",
      "**/*.config.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain .js files are CommonJS Node build scripts (e.g. bundle-docs.js,
    // run via `node`). Don't force ESM import syntax on them.
    files: ["**/*.js"],
    languageOptions: { sourceType: "commonjs" },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.worker },
    },
    rules: {
      // The platform deliberately uses `any` at framework boundaries
      // (e.g. Skill<any, any>, MCP payload casts). Not worth blocking on.
      "@typescript-eslint/no-explicit-any": "off",
      // Unused vars are a real signal (see #202 item 4); allow _-prefixed on purpose.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
);
