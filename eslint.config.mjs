import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // eve's dev runtime. Gitignored, but eslint does not read .gitignore, so a
    // bare `npm run lint` otherwise spends minutes on megabytes of generated
    // snapshots and never finishes.
    ".eve/**",
    // Vendored from AI Elements, not written here. Two of these files break
    // react-hooks rules that this project cannot fix: code-block.tsx accesses a
    // ref during render, shimmer.tsx creates a component during render. Both
    // are depended on, so they cannot be deleted the way the unused AI Elements
    // files were, and patching generated third-party code would be undone the
    // next time it is pulled in. Everything actually written here, under `app/`,
    // `agent/` and `scripts/`, is still linted.
    "components/ai-elements/**",
  ]),
]);

export default eslintConfig;
