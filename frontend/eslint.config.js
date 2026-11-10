import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import moduleBoundaries from "./eslint-rules/module-boundaries.js";

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended, prettier],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      australis: { rules: { "module-boundaries": moduleBoundaries } },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // Modules expose a public surface through index.ts; no deep imports into other modules.
      // The rule resolves relative paths, so "../health/api" is caught as well as "modules/x/y".
      "australis/module-boundaries": "error",
    },
  },
  {
    files: ["eslint-rules/**/*.js", "*.config.{js,ts}"],
    languageOptions: { globals: globals.node },
  },
);
