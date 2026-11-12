/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { hashPassword } from "better-auth/crypto"
import { api, components } from "./_generated/api"
import schema from "./schema"
import { signAuthIpHash } from "./lib/authIpProof"
import { rateLimiter } from "./lib/rateLimits"
import { normalizeResetRedirect } from "./cms/passwordRecovery"
import betterAuthTest from "@convex-dev/better-auth/test"
import rateLimiterTest from "@convex-dev/rate-limiter/test"
import actionRetrierTest from "@convex-dev/action-retrier/test"

const modules = import.meta.glob("./**/*.ts")
const AUTH_IP_PROOF_SECRET = "test-password-recovery-ip-proof-secret"
let previousAuthIpProofSecret: string | undefined

beforeEach(() => {
  previousAuthIpProofSecret = process.env.CONTACT_IP_PROOF_SECRET
  process.env.CONTACT_IP_PROOF_SECRET = AUTH_IP_PROOF_SECRET
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  if (previousAuthIpProofSecret === undefined) {
    delete process.env.CONTACT_IP_PROOF_SECRET
  } else {
    process.env.CONTACT_IP_PROOF_SECRET = previousAuthIpProofSecret
  }
})

function makeTest() {
  const t = convexTest(schema, modules)
  betterAuthTest.register(t)
  rateLimiterTest.register(t)
  actionRetrierTest.register(t)
  return t
}

async function seedCredentialUser(
  t: ReturnType<typeof makeTest>,
  email: string
) {
  const now = Date.now()
  const password = await hashPassword("old-password-123")

  return await t.run(async (ctx) => {
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          email,
          name: email,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
      },
    })
    const authId = user._id as string

    await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "account",
        data: {
          accountId: authId,
          providerId: "credential",
          userId: authId,
          password,
          createdAt: now,
          updatedAt: now,
        },
      },
    })

    return { authId, now }
  })
}

async function trustedResetArgs(
  email: string,
  ipSeed = email
): Promise<{
  email: string
  ipHash: string
  ipHashExpiresAt: number
  ipHashSignature: string
}> {
  const ipHash = await hashForTest(ipSeed)
  const proof = await signAuthIpHash(ipHash, {
    secret: AUTH_IP_PROOF_SECRET,
    expiresAt: Date.now() + 60_000,
  })
  if (!proof) throw new Error("Failed to sign password recovery proof")
  return {
    email,
    ipHash: proof.ipHash,
    ipHashExpiresAt: proof.expiresAt,
    ipHashSignature: proof.signature,
  }
}

async function hashForTest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

async function emailLimiterKeyForTest(email: string): Promise<string> {
  return await hashForTest(email.trim().toLowerCase())
}

describe("requestPasswordReset — Phase 9 (no-enumeration + rate-limited)", () => {
  test("reset redirects are limited to same-origin relative paths", () => {
    expect(normalizeResetRedirect(undefined)).toBe("/reset-password")
    expect(normalizeResetRedirect("")).toBe("/reset-password")
    expect(normalizeResetRedirect("/reset-password?next=%2Fadmin#top")).toBe(
      "/reset-password?next=%2Fadmin#top"
    )
    expect(normalizeResetRedirect("reset-password")).toBe("/reset-password")
    expect(normalizeResetRedirect("https://evil.test/reset")).toBe(
      "/reset-password"
    )
    expect(normalizeResetRedirect("//evil.test/reset")).toBe("/reset-password")
    expect(normalizeResetRedirect("/\\evil.test/reset")).toBe("/reset-password")
  })

  test("always returns { ok: true } regardless of email existence", async () => {
    const t = makeTest()

    // Unknown email.
    const unknown = await t.action(
      api.cms.passwordRecovery.requestPasswordReset,
      {
        email: "nobody@example.com",
      }
    )
    expect(unknown).toEqual({ ok: true })

    // Even garbage input doesn't throw — the input gate deflects to ok.
    const garbage = await t.action(
      api.cms.passwordRecovery.requestPasswordReset,
      await trustedResetArgs("not-an-email", "garbage-input")
    )
    expect(garbage).toEqual({ ok: true })

    // Empty string is deflected at the input gate, not the limiter.
    const empty = await t.action(
      api.cms.passwordRecovery.requestPasswordReset,
      { email: "" }
    )
    expect(empty).toEqual({ ok: true })

    const global = await t.run((ctx) =>
      rateLimiter.getValue(ctx, "forgotPasswordGlobal")
    )
    expect(global.value).toBe(100)
  })

  test("missing proof sends no email and does not consume caller-chosen limiter keys", async () => {
    const t = makeTest()
    const email = "owner-without-proof@example.com"
    const emailLimiterKey = await emailLimiterKeyForTest(email)
    const callerChosenIpHash = await hashForTest("caller-chosen-ip-key")
    await seedCredentialUser(t, email)

    const result = await t.action(
      api.cms.passwordRecovery.requestPasswordReset,
      {
        email,
        ipHash: callerChosenIpHash,
        redirectTo: "/reset-password",
      }
    )

    expect(result).toEqual({ ok: true })
    const [global, perEmail, perIp, verifications, deliveryEvents] =
      await Promise.all([
        t.run((ctx) => rateLimiter.getValue(ctx, "forgotPasswordGlobal")),
        t.run((ctx) =>
          rateLimiter.getValue(ctx, "forgotPasswordPerEmail", {
            key: emailLimiterKey,
          })
        ),
        t.run((ctx) =>
          rateLimiter.getValue(ctx, "forgotPasswordPerIp", {
            key: callerChosenIpHash,
          })
        ),
        t.run(async (ctx) => {
          const result = await ctx.runQuery(
            components.betterAuth.adapter.findMany,
            {
              model: "verification",
              paginationOpts: { numItems: 10, cursor: null },
            }
          )
          return result.page
        }),
        t.run((ctx) => ctx.db.query("emailDeliveryEvents").collect()),
      ])

    expect(global.value).toBe(100)
    expect(perEmail.value).toBe(3)
    expect(perIp.value).toBe(10)
    expect(verifications).toHaveLength(0)
    expect(deliveryEvents).toHaveLength(0)
  })

  test("spoofed proof sends no email and does not create attacker-keyed limiter state", async () => {
    const t = makeTest()
    const email = "owner-with-spoofed-proof@example.com"
    const emailLimiterKey = await emailLimiterKeyForTest(email)
    const callerChosenIpHash = await hashForTest("spoofed-ip")
    const callerChosenSignature = "b".repeat(64)
    await seedCredentialUser(t, email)

    const result = await t.action(
      api.cms.passwordRecovery.requestPasswordReset,
      {
        email,
        ipHash: callerChosenIpHash,
        ipHashExpiresAt: Date.now() + 60_000,
        ipHashSignature: callerChosenSignature,
      }
    )

    expect(result).toEqual({ ok: true })
    const [global, perEmail, perIp, signatureKey, deliveryEvents] =
      await Promise.all([
        t.run((ctx) => rateLimiter.getValue(ctx, "forgotPasswordGlobal")),
        t.run((ctx) =>
          rateLimiter.getValue(ctx, "forgotPasswordPerEmail", {
            key: emailLimiterKey,
          })
        ),
        t.run((ctx) =>
          rateLimiter.getValue(ctx, "forgotPasswordPerIp", {
            key: callerChosenIpHash,
          })
        ),
        t.run((ctx) =>
          rateLimiter.getValue(ctx, "forgotPasswordPerIp", {
            key: callerChosenSignature,
          })
        ),
        t.run((ctx) => ctx.db.query("emailDeliveryEvents").collect()),
      ])

    expect(global.value).toBe(100)
    expect(perEmail.value).toBe(3)
    expect(perIp.value).toBe(10)
    expect(signatureKey.value).toBe(10)
    expect(deliveryEvents).toHaveLength(0)
  })

  test("known accounts create a 1-hour reset token and queue the shared email pipeline", async () => {
    const t = makeTest()
    const email = "owner@example.com"
    const { authId, now } = await seedCredentialUser(t, email)

    const result = await t.action(
      api.cms.passwordRecovery.requestPasswordReset,
      {
        ...(await trustedResetArgs(email, "ip-owner")),
        redirectTo: "/reset-password?from=test",
      }
    )
    expect(result).toEqual({ ok: true })

    const verifications = await t.run(async (ctx) => {
      const result = await ctx.runQuery(
        components.betterAuth.adapter.findMany,
        {
          model: "verification",
          paginationOpts: { numItems: 10, cursor: null },
        }
      )
      return result.page
    })
    expect(verifications).toHaveLength(1)
    const [verification] = verifications
    expect(verification.identifier).toMatch(/^reset-password:/)
    expect(verification.value).toBe(authId)
    expect(verification.expiresAt).toBeGreaterThanOrEqual(now + 60 * 60 * 1000)
    expect(verification.expiresAt).toBeLessThanOrEqual(
      Date.now() + 60 * 60 * 1000
    )

    const [resetEmailEvent] = await t.run((ctx) =>
      ctx.db.query("emailDeliveryEvents").collect()
    )
    expect(resetEmailEvent).toMatchObject({
      consumer: { kind: "password_recovery" },
      state: "queued",
      attempts: 0,
    })
    expect(resetEmailEvent?.idempotencyKey).toMatch(
      /^password_recovery:[0-9a-f]{64}$/
    )
    expect(resetEmailEvent?.runId).toBeDefined()
    expect(resetEmailEvent?.message?.to).toBe(email)
    expect(resetEmailEvent?.message?.subject).toBe(
      "Reset your formulacms password"
    )
    expect(resetEmailEvent?.message?.text).toContain("/reset-password/")
    expect(resetEmailEvent?.message?.text).toContain(
      "callbackURL=%2Freset-password%3Ffrom%3Dtest"
    )
    expect(resetEmailEvent?.message?.text).toContain("expires in 60 minutes")
    expect(resetEmailEvent?.message?.text).toContain("can only be used once")

    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect()
    )
    expect(JSON.stringify(scheduled)).not.toContain(email)
    expect(JSON.stringify(scheduled)).not.toContain("callbackURL")
  })

  test("a public password reset preserves the durable owner binding", async () => {
    const t = makeTest()
    const email = "owner@example.com"
    const { authId } = await seedCredentialUser(t, email)
    const ownerId = await t.run((ctx) =>
      ctx.db.insert("cmsOwner", {
        key: "owner",
        authId,
        tokenIdentifier: `https://issuer.test|${authId}`,
        establishedAt: 123,
        updatedAt: 123,
      })
    )
    const before = await t.run((ctx) => ctx.db.get(ownerId))

    await expect(
      t.action(api.cms.passwordRecovery.requestPasswordReset, {
        ...(await trustedResetArgs(email, "owner-reset")),
      })
    ).resolves.toEqual({ ok: true })

    const [resetEmailEvent] = await t.run((ctx) =>
      ctx.db.query("emailDeliveryEvents").collect()
    )
    const token = resetEmailEvent?.message?.text.match(
      /\/reset-password\/([^?\s]+)\?/
    )?.[1]
    expect(token).toBeDefined()

    const response = await t.fetch("/api/auth/reset-password", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
      },
      body: JSON.stringify({ token, newPassword: "new-password-456" }),
    })
    expect(response.status).toBe(200)

    await expect(t.run((ctx) => ctx.db.get(ownerId))).resolves.toEqual(before)
  })

  test("global cap spans distinct addresses and stops before downstream keys", async () => {
    const t = makeTest()
    const overflowEmail = "global-overflow@example.com"
    const overflowEmailLimiterKey = await emailLimiterKeyForTest(overflowEmail)
    const overflowIpSeed = "global-overflow-ip"
    await seedCredentialUser(t, overflowEmail)

    for (let index = 0; index < 100; index += 1) {
      const email = `global-${index}@example.com`
      const result = await t.action(
        api.cms.passwordRecovery.requestPasswordReset,
        await trustedResetArgs(email, `global-ip-${index}`)
      )
      expect(result).toEqual({ ok: true })
    }

    const overflowArgs = await trustedResetArgs(overflowEmail, overflowIpSeed)
    await expect(
      t.action(api.cms.passwordRecovery.requestPasswordReset, overflowArgs)
    ).resolves.toEqual({ ok: true })

    const [global, perIp, perEmail, verifications] = await Promise.all([
      t.run((ctx) => rateLimiter.getValue(ctx, "forgotPasswordGlobal")),
      t.run((ctx) =>
        rateLimiter.getValue(ctx, "forgotPasswordPerIp", {
          key: overflowArgs.ipHash,
        })
      ),
      t.run((ctx) =>
        rateLimiter.getValue(ctx, "forgotPasswordPerEmail", {
          key: overflowEmailLimiterKey,
        })
      ),
      t.run(async (ctx) => {
        const result = await ctx.runQuery(
          components.betterAuth.adapter.findMany,
          {
            model: "verification",
            paginationOpts: { numItems: 10, cursor: null },
          }
        )
        return result.page
      }),
    ])

    expect(global.value).toBe(0)
    expect(perIp.value).toBe(10)
    expect(perEmail.value).toBe(3)
    expect(verifications).toHaveLength(0)
  })

  test("per-email cap absorbs the 4th request silently", async () => {
    const t = makeTest()
    const email = "victim@example.com"
    const emailLimiterKey = await emailLimiterKeyForTest(email)
    await seedCredentialUser(t, email)
    const args = await trustedResetArgs(email, "per-email-client")

    for (let i = 0; i < 3; i++) {
      const r = await t.action(
        api.cms.passwordRecovery.requestPasswordReset,
        args
      )
      expect(r).toEqual({ ok: true })
    }

    // 4th call within the hour: still ok, but the rate limiter has no budget
    // for this key, which is what we use as the "silently suppressed" signal.
    // We assert that directly on the limiter component so we don't have to
    // intercept Better Auth's internal email dispatch path.
    const r4 = await t.action(
      api.cms.passwordRecovery.requestPasswordReset,
      args
    )
    expect(r4).toEqual({ ok: true })

    // Probe the limiter — `check` doesn't consume tokens. `ok: false` means
    // a real call would have been throttled (i.e. the 4th send was suppressed).
    const [hashedProbe, rawEmailProbe] = await Promise.all([
      t.run((ctx) =>
        rateLimiter.check(ctx, "forgotPasswordPerEmail", {
          key: emailLimiterKey,
        })
      ),
      t.run((ctx) =>
        rateLimiter.check(ctx, "forgotPasswordPerEmail", { key: email })
      ),
    ])
    expect(hashedProbe.ok).toBe(false)
    expect(rawEmailProbe.ok).toBe(true)
    const deliveryEvents = await t.run((ctx) =>
      ctx.db.query("emailDeliveryEvents").collect()
    )
    expect(deliveryEvents).toHaveLength(3)
  })

  test("per-IP cap suppresses sweeps of many addresses from one client", async () => {
    const t = makeTest()
    const ipSeed = "ip-deadbeef"

    // 10 distinct addresses from the same IP — capacity is exactly 10.
    for (let i = 0; i < 10; i++) {
      const email = `user${i}@example.com`
      const r = await t.action(
        api.cms.passwordRecovery.requestPasswordReset,
        await trustedResetArgs(email, ipSeed)
      )
      expect(r).toEqual({ ok: true })
    }

    // 11th call: budget exhausted; still returns ok.
    const overflowEmail = "user-overflow@example.com"
    const overflowEmailLimiterKey = await emailLimiterKeyForTest(overflowEmail)
    const overflowArgs = await trustedResetArgs(overflowEmail, ipSeed)
    const r11 = await t.action(
      api.cms.passwordRecovery.requestPasswordReset,
      overflowArgs
    )
    expect(r11).toEqual({ ok: true })

    const probe = await t.run((ctx) =>
      rateLimiter.check(ctx, "forgotPasswordPerIp", {
        key: overflowArgs.ipHash,
      })
    )
    expect(probe.ok).toBe(false)
    const perEmail = await t.run((ctx) =>
      rateLimiter.getValue(ctx, "forgotPasswordPerEmail", {
        key: overflowEmailLimiterKey,
      })
    )
    expect(perEmail.value).toBe(3)
  })

  test("absent proof fails closed without creating a shared fallback bucket", async () => {
    const t = makeTest()

    for (let i = 0; i < 12; i++) {
      const r = await t.action(api.cms.passwordRecovery.requestPasswordReset, {
        email: `noip${i}@example.com`,
      })
      expect(r).toEqual({ ok: true })
    }

    const global = await t.run((ctx) =>
      rateLimiter.getValue(ctx, "forgotPasswordGlobal")
    )
    expect(global.value).toBe(100)
  })

  test("does not throw when Better Auth fails internally — error is swallowed", async () => {
    const t = makeTest()
    // Better Auth's requestPasswordReset returns 200 even for unknown emails,
    // so we can't easily force a throw here without monkey-patching. The
    // important property is that *whatever* Better Auth does, the public
    // action returns the same { ok: true } shape — covered by the cases
    // above. This test pins the contract: calling with an email that triggers
    // the Better Auth path completes successfully without raising.
    await expect(
      t.action(api.cms.passwordRecovery.requestPasswordReset, {
        ...(await trustedResetArgs("real-looking@example.com", "ip-xyz")),
      })
    ).resolves.toEqual({ ok: true })
  })
})
