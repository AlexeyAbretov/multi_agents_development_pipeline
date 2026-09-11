import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import stylistic from "@stylistic/eslint-plugin";

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
    },
    rules: {
      curly: ["error", "all"],
      "func-style": ["error", "declaration", { allowArrowFunctions: true }],
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
      "@stylistic/brace-style": ["error", "1tbs", { allowSingleLine: false }],
      "@stylistic/indent": ["error", 2],
      "@stylistic/quotes": ["error", "double", { avoidEscape: true }],
      "@stylistic/semi": ["error", "always"],
      "@stylistic/no-trailing-spaces": "error",
      "@stylistic/eol-last": ["error", "always"],
      "@stylistic/padded-blocks": ["error", "never"],
      "@stylistic/space-before-function-paren": [
        "error",
        { anonymous: "always", named: "never", asyncArrow: "always" },
      ],
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "*", next: "return" },
        { blankLine: "always", prev: ["const", "let", "var"], next: "*" },
        { blankLine: "any", prev: ["const", "let", "var"], next: ["const", "let", "var"] },
        { blankLine: "always", prev: "block-like", next: "*" },
        { blankLine: "always", prev: "*", next: "if" },
      ],
    },
  },
];
