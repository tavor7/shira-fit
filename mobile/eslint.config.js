const expoConfig = require("eslint-config-expo/flat");
const typescriptEslint = require("@typescript-eslint/eslint-plugin");
const pluginReactHooks = require("eslint-plugin-react-hooks");
const { defineConfig } = require("eslint/config");

module.exports = defineConfig([
  {
    ignores: ["dist/**", ".expo/**", "node_modules/**"],
  },
  ...expoConfig,
  {
    // Phase 3 of the remediation plan: keep the linter permissive while the
    // codebase has no lint history. Only promote rules that catch real bugs
    // cheaply to "error" (unused vars, rules-of-hooks); everything else
    // stays at eslint-config-expo's default (mostly "warn"). No
    // max-lines/complexity rule yet — two known 2000+ line files are still
    // mid-extraction (remediation plan Phase 4); that rule would just
    // generate permanent noise until then. Tighten incrementally later.
    files: ["**/*.ts", "**/*.tsx"],
    plugins: {
      "@typescript-eslint": typescriptEslint,
      "react-hooks": pluginReactHooks,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { vars: "all", args: "none", ignoreRestSiblings: true, caughtErrors: "all" },
      ],
      "react-hooks/rules-of-hooks": "error",
    },
  },
  {
    files: ["**/*.js", "**/*.jsx"],
    rules: {
      "no-unused-vars": [
        "error",
        {
          vars: "all",
          args: "none",
          ignoreRestSiblings: true,
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
]);
