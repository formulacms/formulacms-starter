import { defineConfig, globalIgnores } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"
import jsxA11y from "eslint-plugin-jsx-a11y"

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // eslint-config-next already registers the jsx-a11y plugin instance
    // (via core-web-vitals) for all js/jsx/ts/tsx files, so re-declaring
    // `plugins` here (a different plugin object reference) would throw
    // "Cannot redefine plugin". Reuse that registration and only add the
    // plugin's recommended rule set, scoped to JSX/TSX files.
    files: ["**/*.{jsx,tsx}"],
    rules: jsxA11y.flatConfigs.recommended.rules,
  },
  {
    files: ["components/slices/*.tsx", "components/slices/presentations/*.tsx"],
    ignores: [
      "**/*.test.tsx",
      "**/render-helpers.tsx",
      "**/rich-text-content.tsx",
      "**/contact-form-client.tsx",
      "**/site-search-client.tsx",
      "**/slice-zone*.tsx",
      "**/fallback-slice.tsx",
      "**/heading-slot.tsx",
    ],
    rules: {
      "react/jsx-props-no-spreading": [
        "error",
        {
          html: "enforce",
          custom: "enforce",
          explicitSpread: "enforce",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".reference/**",
    "scripts/starter/overlay/**",
    // Local agent evidence (git-excluded via .git/info/exclude; never tracked).
    ".handoffs/**",
    // Plan 033 Phase 0 fixture checkouts are inert *source under test*, not
    // repository source: the legacy and mixed ones deliberately contain the
    // styling systems this repository forbids.
    "lib/design-system/__fixtures__/**",
  ]),
])

export default eslintConfig
