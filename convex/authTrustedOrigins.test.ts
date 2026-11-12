/// <reference types="vite/client" />
// Regression cover for the local-dev origin perimeter.
//
// Better Auth runs inside Convex, so it reads the *Convex deployment* env, not
// `.env.local`. With no explicit `trustedOrigins`, Better Auth trusts exactly
// one origin — the one `BETTER_AUTH_URL` names. `next dev` walks to the next
// free port whenever 3000 is taken (3001, 3002, …), so every sign-in from a
// walked port was rejected with 403 INVALID_ORIGIN.
//
// The policy under test widens the perimeter to *any loopback port*, and only
// when this deployment is itself configured for loopback. A deployed
// `BETTER_AUTH_URL` never opts in, so production stays pinned to one origin.
import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createAuth, loopbackDevTrustedOrigins } from "./auth"
import schema from "./schema"
import betterAuthTest from "@convex-dev/better-auth/test"
import rateLimiterTest from "@convex-dev/rate-limiter/test"

const modules = import.meta.glob("./**/*.ts")

const envSnapshot = new Map<string, string | undefined>()
const MANAGED_KEYS = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "CONVEX_SITE_URL",
] as const

function makeTest() {
  const t = convexTest(schema, modules)
  betterAuthTest.register(t)
  rateLimiterTest.register(t)
  return t
}

/**
 * Driving this through `t.fetch("/api/auth/sign-in/email")` would prove
 * nothing: Better Auth sets `skipOriginCheck` to true whenever `isTest()` is
 * true, so the origin middleware waves every request through under Vitest.
 *
 * So ask the resolved auth context directly. `context.isTrustedOrigin` runs the
 * same `trustedOrigins.some(matchesOriginPattern)` that the origin middleware
 * runs in production, over the list Better Auth actually built from our
 * `createAuth` options — so this covers the wiring, not just the policy.
 */
async function isTrustedOrigin(origin: string) {
  return await makeTest().run(async (ctx) => {
    const context = await createAuth(ctx).$context
    return context.isTrustedOrigin(origin)
  })
}

describe("local-dev trusted origins", () => {
  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      envSnapshot.set(key, process.env[key])
    }
    process.env.BETTER_AUTH_SECRET =
      "test-better-auth-secret-at-least-32-characters"
    process.env.CONVEX_SITE_URL = "http://localhost:3000"
    process.env.BETTER_AUTH_URL = "http://localhost:3000"
  })

  afterEach(() => {
    for (const [key, value] of envSnapshot) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    envSnapshot.clear()
  })

  describe("policy", () => {
    test("a loopback BETTER_AUTH_URL opts into any loopback port", () => {
      process.env.BETTER_AUTH_URL = "http://localhost:3000"
      expect(loopbackDevTrustedOrigins()).toEqual([
        "http://localhost:*",
        "http://127.0.0.1:*",
        "http://[::1]:*",
      ])
    })

    test("127.0.0.1 and [::1] deployments opt in too", () => {
      process.env.BETTER_AUTH_URL = "http://127.0.0.1:3000"
      expect(loopbackDevTrustedOrigins()).not.toHaveLength(0)
      process.env.BETTER_AUTH_URL = "http://[::1]:3000"
      expect(loopbackDevTrustedOrigins()).not.toHaveLength(0)
    })

    test("a deployed BETTER_AUTH_URL stays pinned to its single origin", () => {
      process.env.BETTER_AUTH_URL = "https://example.com"
      expect(loopbackDevTrustedOrigins()).toEqual([])
    })

    test("https on a loopback host does not opt in", () => {
      // An https loopback origin means a real TLS setup, not `next dev`.
      process.env.BETTER_AUTH_URL = "https://localhost:3000"
      expect(loopbackDevTrustedOrigins()).toEqual([])
    })

    test("a lookalike host does not opt in", () => {
      process.env.BETTER_AUTH_URL = "https://localhost.evil.com"
      expect(loopbackDevTrustedOrigins()).toEqual([])
    })

    test("unset and unparseable values opt in to nothing", () => {
      delete process.env.BETTER_AUTH_URL
      expect(loopbackDevTrustedOrigins()).toEqual([])
      process.env.BETTER_AUTH_URL = "not-a-url"
      expect(loopbackDevTrustedOrigins()).toEqual([])
    })
  })

  describe("origin matching on a loopback deployment", () => {
    test("accepts a walked dev port — the bug this fixes", async () => {
      expect(await isTrustedOrigin("http://localhost:3001")).toBe(true)
      expect(await isTrustedOrigin("http://localhost:3002")).toBe(true)
      expect(await isTrustedOrigin("http://localhost:54321")).toBe(true)
    })

    test("accepts the configured dev port", async () => {
      expect(await isTrustedOrigin("http://localhost:3000")).toBe(true)
    })

    test("accepts the other loopback spellings", async () => {
      expect(await isTrustedOrigin("http://127.0.0.1:3001")).toBe(true)
      expect(await isTrustedOrigin("http://[::1]:3001")).toBe(true)
    })

    test("rejects a remote origin", async () => {
      expect(await isTrustedOrigin("https://evil.example.com")).toBe(false)
    })

    test("rejects a loopback lookalike host", async () => {
      expect(await isTrustedOrigin("http://localhost.evil.com:3001")).toBe(
        false
      )
      expect(await isTrustedOrigin("http://notlocalhost:3001")).toBe(false)
    })

    test("rejects a remote origin with loopback in the path", async () => {
      expect(await isTrustedOrigin("http://evil.com/localhost:3000")).toBe(
        false
      )
    })

    test("rejects https on a loopback port", async () => {
      // The wildcards are http-only; an https loopback origin is not implied.
      expect(await isTrustedOrigin("https://localhost:3001")).toBe(false)
    })
  })

  describe("origin matching on a deployed deployment", () => {
    beforeEach(() => {
      process.env.BETTER_AUTH_URL = "https://example.com"
    })

    test("accepts only its own origin", async () => {
      expect(await isTrustedOrigin("https://example.com")).toBe(true)
    })

    test("does not trust loopback ports", async () => {
      expect(await isTrustedOrigin("http://localhost:3000")).toBe(false)
      expect(await isTrustedOrigin("http://localhost:3001")).toBe(false)
      expect(await isTrustedOrigin("http://127.0.0.1:3001")).toBe(false)
    })
  })
})
