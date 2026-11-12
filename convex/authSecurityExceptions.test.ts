/// <reference types="vite/client" />
import betterAuthTest from "@convex-dev/better-auth/test"
import rateLimiterTest from "@convex-dev/rate-limiter/test"
import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createAuth } from "./auth"
import schema from "./schema"

const modules = import.meta.glob("./**/*.ts")
const envSnapshot = new Map<string, string | undefined>()
const MANAGED_KEYS = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "CONVEX_SITE_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
] as const

// These opt-in plugins are the prerequisites for the three dated Better Auth
// audit exceptions in pnpm-workspace.yaml. Enabling one requires fresh exposure
// analysis and removal/reconsideration of its exception before this guard changes.
const FORBIDDEN_PLUGINS = [
  "magic-link",
  "oauth-proxy",
  "device-authorization",
] as const
const FORBIDDEN_ENDPOINTS = [
  ["signInMagicLink", "/sign-in/magic-link"],
  ["magicLinkVerify", "/magic-link/verify"],
  ["oAuthProxy", "/oauth-proxy-callback"],
  ["deviceCode", "/device/code"],
  ["deviceToken", "/device/token"],
  ["deviceVerify", "/device"],
  ["deviceApprove", "/device/approve"],
  ["deviceDeny", "/device/deny"],
] as const

function makeTest() {
  const t = convexTest(schema, modules)
  betterAuthTest.register(t)
  rateLimiterTest.register(t)
  return t
}

describe("Better Auth audit exception prerequisites", () => {
  beforeEach(() => {
    for (const key of MANAGED_KEYS) envSnapshot.set(key, process.env[key])
    process.env.BETTER_AUTH_SECRET =
      "test-better-auth-secret-at-least-32-characters"
    process.env.BETTER_AUTH_URL = "http://localhost:3000"
    process.env.CONVEX_SITE_URL = "http://localhost:3000"
    delete process.env.GOOGLE_CLIENT_ID
    delete process.env.GOOGLE_CLIENT_SECRET
  })

  afterEach(() => {
    for (const [key, value] of envSnapshot) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    envSnapshot.clear()
  })

  test.each([false, true])(
    "the real factory excludes advisory plugins and endpoints (Google enabled: %s)",
    async (googleEnabled) => {
      if (googleEnabled) {
        process.env.GOOGLE_CLIENT_ID = "test-google-client"
        process.env.GOOGLE_CLIENT_SECRET = "test-google-secret"
      }

      await makeTest().run(async (ctx) => {
        const auth = createAuth(ctx)
        const context = await auth.$context
        const plugins = context.options.plugins ?? []
        const pluginIds = plugins.map((plugin) => plugin.id)
        const endpoints = plugins.flatMap((plugin) =>
          Object.entries(plugin.endpoints ?? {})
        )
        const endpointNames = endpoints.map(([name]) => name)
        const endpointPaths = endpoints.map(([, endpoint]) => endpoint.path)

        expect(pluginIds).toContain("convex")
        expect(auth.options.emailAndPassword?.enabled).toBe(true)
        expect(auth.options.database).toBeDefined()
        expect(context.oauthConfig.storeStateStrategy).toBe("database")
        expect(context.socialProviders.map((provider) => provider.id)).toEqual(
          googleEnabled ? ["google"] : []
        )
        expect(Boolean(auth.options.socialProviders?.google)).toBe(
          googleEnabled
        )

        for (const id of FORBIDDEN_PLUGINS) expect(pluginIds).not.toContain(id)
        for (const [name, path] of FORBIDDEN_ENDPOINTS) {
          expect(endpointNames).not.toContain(name)
          expect(endpointPaths).not.toContain(path)
          expect(auth.api).not.toHaveProperty(name)
        }
      })
    }
  )
})
