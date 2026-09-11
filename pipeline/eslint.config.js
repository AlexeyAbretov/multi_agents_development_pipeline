import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import stylistic from "@stylistic/eslint-plugin";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import simpleImportSort from "eslint-plugin-simple-import-sort";

/** Matches `.cursor/rules/typescript-functions.mdc` (see parseOwnerRepo, Elvis). */
export default [
  {
    ignores: ["dist/**", "test/**"],
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      ecmaVersion: "latest",
      sourceType: "module",
    },
    plugins: {
      "@stylistic": stylistic,
      "@typescript-eslint": tsPlugin,
      "simple-import-sort": simpleImportSort,
    },
    rules: {
      curly: ["error", "all"],
      "func-style": ["error", "declaration", { allowArrowFunctions: true }],
      "simple-import-sort/imports": [
        "error",
        {
          groups: [
            ["^\\u0000"],
            ["^node:"],
            ["^(?!@(?:providers|routes)(?:/|\\u0000|$))@?\\w"],
            ["^@(?:providers|routes)(?:/|\\u0000|$)"],
            ["^\\./"],
            ["^\\.\\."],
          ],
        },
      ],
      "simple-import-sort/exports": "error",
      "@typescript-eslint/prefer-optional-chain": "error",
      "@typescript-eslint/prefer-nullish-coalescing": [
        "error",
        {
          ignorePrimitives: {
            bigint: true,
            boolean: true,
            number: true,
            string: true,
          },
        },
      ],
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "*", next: "return" },
        { blankLine: "always", prev: ["const", "let", "var"], next: "*" },
        {
          blankLine: "any",
          prev: ["const", "let", "var"],
          next: ["const", "let", "var"],
        },
        { blankLine: "always", prev: "block-like", next: "*" },
        { blankLine: "always", prev: "*", next: "if" },
      ],
    },
  },
  eslintPluginPrettierRecommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      curly: ["error", "all"],
      "@stylistic/max-len": [
        "error",
        {
          code: 80,
          ignoreUrls: true,
          ignoreRegExpLiterals: true,
        },
      ],
    },
  },
];
