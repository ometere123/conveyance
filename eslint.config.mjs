import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // .pytest_cache and __pycache__ hold no JS/TS and are written by the Python
  // test run. ESLint walked into them anyway and aborted the whole lint step on
  // Windows with EPERM while reading .pytest_cache, so excluding them is a
  // correctness fix, not just a speed one.
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".pytest_cache/**",
    "**/__pycache__/**",
  ]),
]);

export default eslintConfig;
