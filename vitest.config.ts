import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

// Mirror the `@/*` -> project-root path alias from tsconfig so tests can import
// shared modules the same way app code does. Vitest projects each carry their
// own resolve config, so the alias is declared per project rather than at root.
const alias = {
  "@": fileURLToPath(new URL(".", import.meta.url)),
  "server-only": fileURLToPath(
    new URL("./vitest.server-only.ts", import.meta.url)
  ),
}

// Establish an offline revalidation baseline before application modules load,
// regardless of the environment inherited from the invoking shell or CI.
const revalidationEnv = { REVALIDATE_SECRET: "", SITE_URL: "" }

export default defineConfig({
  test: {
    // `environmentMatchGlobs` was removed in Vitest 4; the supported way to run
    // different files under different environments is `projects`. We split by
    // file extension: `.test.ts` (pure logic + Convex) stays on edge-runtime,
    // `.test.tsx` (React component tests) runs under jsdom with jest-dom.
    projects: [
      {
        resolve: { alias },
        test: {
          env: revalidationEnv,
          name: "edge",
          environment: "edge-runtime",
          // next-intl's middleware imports `next/server` without an extension,
          // which Node's ESM resolver rejects; Vite resolves it when inlined.
          server: { deps: { inline: ["next-intl"] } },
          include: ["**/*.test.ts"],
          exclude: [
            "**/node_modules/**",
            "**/.reference/**",
            "**/.kilo/**",
            "**/.handoffs/**",
            "**/scripts/starter/overlay/convex/edition/roles.test.ts",
            "**/*.node.test.ts",
            "**/*.test.tsx",
          ],
          testTimeout: 20_000,
        },
      },
      {
        resolve: { alias },
        test: {
          env: revalidationEnv,
          name: "node",
          environment: "node",
          include: ["**/*.node.test.ts"],
          exclude: ["**/node_modules/**", "**/.reference/**", "**/.kilo/**", "**/.handoffs/**"],
          testTimeout: 20_000,
        },
      },
      {
        resolve: { alias },
        test: {
          env: revalidationEnv,
          name: "dom",
          environment: "jsdom",
          include: ["**/*.test.tsx"],
          exclude: ["**/node_modules/**", "**/.reference/**", "**/.kilo/**", "**/.handoffs/**"],
          setupFiles: ["./vitest.setup.dom.ts"],
          testTimeout: 20_000,
        },
      },
    ],
  },
})
