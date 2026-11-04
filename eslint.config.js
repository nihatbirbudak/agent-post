// ESLint settings: the recommended rules for Node.js ES modules, plus a few rules that keep the code plain.

import js from "@eslint/js";

const NODE_GLOBALS = {
  process: "readonly",
  Buffer: "readonly",
  console: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  URL: "readonly",
  SharedArrayBuffer: "readonly",
  Atomics: "readonly",
};

export default [
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: NODE_GLOBALS },
    rules: {
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-control-regex": "off",
    },
  },
];
