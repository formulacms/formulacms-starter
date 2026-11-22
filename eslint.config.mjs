import { defineConfig, globalIgnores } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"
import jsxA11y from "eslint-plugin-jsx-a11y"
import tseslint from "typescript-eslint"
import convexPlugin from "@convex-dev/eslint-plugin"

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Convex rules with type information (https://docs.convex.dev/linting/eslint),
  // scoped to the root convex/ folder. A finding you keep on purpose gets an
  // inline `// eslint-disable-next-line <rule> -- <reason>` on that line.
  {
    files: ["convex/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  ...convexPlugin.configs.recommended.map((config) => ({
    ...config,
    files: ["convex/**/*.ts"],
  })),
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
    files: ["components/blocks/*.tsx", "components/blocks/presentations/*.tsx"],
    ignores: [
      "**/*.test.tsx",
      "**/render-helpers.tsx",
      "**/rich-text-content.tsx",
      "**/contact-form-client.tsx",
      "**/site-search-client.tsx",
      "**/block-list.tsx",
      "**/block-registry.tsx",
      "**/fallback-block.tsx",
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
    "convex/_generated/**",
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
