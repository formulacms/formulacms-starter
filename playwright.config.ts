import { defineConfig, devices } from "playwright/test"
import { projectsFor, selectE2ERun, serverModeFor } from "./e2e/selection"

// Server ownership. The caller always builds the app first (`.next`).
//
// Default (`FR6_E2E_SERVER` unset or `playwright`): Playwright starts this
// app's built Next production server for the whole run and refuses an existing
// one; the caller owns the local Convex process.
//
// External (`FR6_E2E_SERVER=external`): the caller owns BOTH Next and Convex.
// Playwright starts and stops nothing; its global setup only verifies that
// the explicitly named PUBLIC_BASE_URL origin answers and that a build exists.
// In FR6 runs the D10 launcher is that caller:
// - `convex-launch.sh <app> start` runs before the first spec or stage;
// - the same server stays up across stages, and the private operator checks
//   and the French state check run between stages against it;
// - `convex-launch.sh <app> stop` runs at the end;
// - `convex-launch.sh <app> reset` runs only for V01 attempts;
// - PUBLIC_BASE_URL=http://localhost:3000, which matches the launcher app's
//   BETTER_AUTH_URL and NEXT_PUBLIC_SITE_URL.
//
// Run selection comes from the environment, never from argv: Playwright
// re-imports this file in every worker without CLI arguments. With no
// FR6_E2E_DISPOSABLE_CASE only the `non-disposable` project exists. With it,
// only one `disposable` project exists and it matches exactly one spec: one
// stage per `check:e2e:specs:disposable` run, selected by
// FR6_E2E_DISPOSABLE_CASE + FR6_E2E_STAGE + FR6_E2E_START_STATE. Stages never
// replay their predecessors.
const base = new URL(process.env.PUBLIC_BASE_URL ?? "http://127.0.0.1:3000")
if (
  base.protocol !== "http:" ||
  !["127.0.0.1", "localhost"].includes(base.hostname) ||
  base.pathname !== "/" ||
  base.search ||
  base.hash ||
  base.username ||
  base.password
) {
  throw new Error("PUBLIC_BASE_URL must be a local HTTP origin with no path or credentials")
}
const port = Number(base.port || "80")
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PUBLIC_BASE_URL has an invalid port")
}
const selection = selectE2ERun(process.env)
const serverMode = serverModeFor(process.env)

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results/e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: base.origin,
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  projects: projectsFor(selection),
  ...(serverMode === "external"
    ? { globalSetup: "./e2e/global-setup.ts" }
    : {
        webServer: {
          command: `corepack pnpm exec next start -H 127.0.0.1 -p ${port}`,
          url: base.origin,
          reuseExistingServer: false,
          timeout: 120_000,
        },
      }),
})
