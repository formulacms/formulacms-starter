import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"
import wasmModule from "vite-plugin-wasm-module"

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
// Convex Auth reads CONVEX_CLOUD_URL when it mints and checks tokens; this is
// the default origin convex-test signs tokens for.
const revalidationEnv = {
  REVALIDATE_SECRET: "",
  SITE_URL: "",
  CONVEX_CLOUD_URL: "https://some-deployment.convex.cloud",
}

export default defineConfig({
  test: {
    // `environmentMatchGlobs` was removed in Vitest 4; the supported way to run
    // different files under different environments is `projects`. We split by
    // file extension: `.test.ts` (pure logic + Convex) stays on edge-runtime,
    // `.test.tsx` (React component tests) runs under jsdom with jest-dom.
    projects: [
      {
        plugins: [wasmModule()],
        resolve: { alias },
        test: {
          env: revalidationEnv,
          name: "edge",
          environment: "edge-runtime",
          // next-intl's middleware imports `next/server` without an extension,
          // which Node's ESM resolver rejects; Vite resolves it when inlined.
          // convex-test loads function modules dynamically; the Convex Auth
          // password hash is a .wasm import that `wasmModule` loads as a
          // WebAssembly.Module, as the Convex bundler does.
          server: {
            deps: {
              inline: ["next-intl", "convex-test", "password-hash-wasm"],
            },
          },
          include: ["**/*.test.ts"],
          exclude: [
            "**/node_modules/**",
            "**/.reference/**",
            "**/.kilo/**",
            "**/.handoffs/**",
            "**/*.node.test.ts",
            "**/*.test.tsx",
          ],
          testTimeout: 20_000,
        },
      },
      {
        plugins: [wasmModule()],
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
