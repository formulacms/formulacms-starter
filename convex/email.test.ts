/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { describe, expect, test, vi } from "vitest"
import { api, internal } from "./_generated/api"
import schema from "./schema"
import { seedCommunityOwner } from "../convexTestWithExplicitAdmin"
import actionRetrierTest from "@convex-dev/action-retrier/test"
import betterAuthTest from "@convex-dev/better-auth/test"
import rateLimiterTest from "@convex-dev/rate-limiter/test"
import type { RunId } from "@convex-dev/action-retrier"
import { hashAuthClientIdentity } from "./lib/authIpProof"
import { rateLimiter } from "./lib/rateLimits"

const modules = import.meta.glob("./**/*.ts")

/** The one durable Community owner; both identity fields are explicit. */
const OWNER_ID = "owner-1"
const ownerIdentity = {
  subject: OWNER_ID,
  tokenIdentifier: "https://convex.test|owner-1",
  name: "Owner",
  email: "admin@example.com",
}

const EMAIL_ENV_KEYS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "SMTP_FROM_ADDRESS",
  "SMTP_FROM_NAME",
  "RESEND_API_KEY",
] as const

function makeTest() {
  const t = convexTest(schema, modules)
  rateLimiterTest.register(t)
  actionRetrierTest.register(t)
  betterAuthTest.register(t)
  return t
}

async function withEmailEnv<T>(
  overrides: Partial<Record<(typeof EMAIL_ENV_KEYS)[number], string>>,
  run: () => Promise<T>
): Promise<T> {
  const previous = new Map<string, string | undefined>()
  for (const key of EMAIL_ENV_KEYS) {
    previous.set(key, process.env[key])
    delete process.env[key]
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  try {
    return await run()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

async function seedOwner(t: ReturnType<typeof makeTest>) {
  await seedCommunityOwner(t, ownerIdentity)
}

describe("email settings", () => {
  test("resolves both missing and stored SMTP settings to non-delivery", async () => {
    await withEmailEnv({}, async () => {
      const t = makeTest()

      const fallback = await t.query(internal.email.getResolvedSettings, {})
      expect(fallback).toMatchObject({ provider: "console" })

      await t.run(async (ctx) => {
        await ctx.db.insert("emailSettings", {
          provider: "smtp",
          fromAddress: "owner@example.com",
          fromName: "Owner",
          smtpHost: "smtp.example.com",
          smtpPort: 587,
          smtpSecure: false,
          smtpUser: "smtp-user",
          smtpPasswordCiphertext: "encrypted-envelope",
          schemaVersion: 1,
          updatedAt: Date.now(),
        })
      })

      const resolved = await t.query(internal.email.getResolvedSettings, {})
      expect(resolved).toEqual({ provider: "console" })
    })
  })

  test("stale SMTP environment variables cannot reactivate delivery", async () => {
    await withEmailEnv(
      {
        SMTP_HOST: "smtp.env.example.com",
        SMTP_PORT: "2525",
        SMTP_SECURE: "true",
        SMTP_USER: "env-user",
        SMTP_PASSWORD: "env-password",
        SMTP_FROM_ADDRESS: "ops@example.com",
        SMTP_FROM_NAME: "Ops",
      },
      async () => {
        const t = makeTest()

        await t.run(async (ctx) => {
          await ctx.db.insert("emailSettings", {
            provider: "console",
            fromAddress: "db@example.com",
            fromName: "DB",
            schemaVersion: 1,
            updatedAt: Date.now(),
          })
        })

        const resolved = await t.query(internal.email.getResolvedSettings, {})
        expect(resolved).toEqual({ provider: "console" })
      }
    )
  })

  test("incomplete SMTP database settings fall back to console without throwing", async () => {
    await withEmailEnv({}, async () => {
      const t = makeTest()

      await t.run(async (ctx) => {
        await ctx.db.insert("emailSettings", {
          provider: "smtp",
          fromAddress: "owner@example.com",
          fromName: "Owner",
          smtpUser: "smtp-user",
          schemaVersion: 1,
          updatedAt: Date.now(),
        })
      })

      const resolved = await t.query(internal.email.getResolvedSettings, {})
      expect(resolved).toEqual({ provider: "console" })
    })
  })

  test("keeps stored SMTP credentials outside the successor delivery path", async () => {
    await withEmailEnv({}, async () => {
      const t = makeTest()

      await t.run(async (ctx) => {
        await ctx.db.insert("emailSettings", {
          provider: "smtp",
          fromAddress: "owner@example.com",
          fromName: "Owner",
          smtpHost: "smtp.example.com",
          smtpPort: 587,
          smtpSecure: false,
          smtpUser: "smtp-user",
          smtpPasswordCiphertext: "not-a-valid-ciphertext-envelope",
          schemaVersion: 1,
          updatedAt: Date.now(),
        })
      })

      const queued = await t.mutation(internal.email.enqueueDelivery, {
        consumer: {
          kind: "owner_test",
          providerId: "resend",
          configurationVersion: 1,
        },
        idempotencyKey: "owner_test:legacy-smtp-credentials",
        message: {
          to: "owner@example.com",
          subject: "Test",
          text: "This should fail before SMTP delivery.",
        },
      })
      const result = await t.action(internal.emailNode.sendEmail, {
        eventId: queued.eventId,
      })

      expect(result).toEqual({ state: "failed", reason: "not_configured" })
    })
  })

  test("returns non-delivery instead of opening the configured SMTP path", async () => {
    await withEmailEnv({ SMTP_HOST: "127.0.0.1" }, async () => {
      const t = makeTest()
      const queued = await t.mutation(internal.email.enqueueDelivery, {
        consumer: {
          kind: "owner_test",
          providerId: "resend",
          configurationVersion: 1,
        },
        idempotencyKey: "owner_test:stale-smtp-environment",
        message: {
          to: "lead@example.com",
          subject: "Retired contact notification",
          text: "This must not open an SMTP connection.",
        },
      })
      const result = await t.action(internal.emailNode.sendEmail, {
        eventId: queued.eventId,
      })

      expect(result).toEqual({
        state: "failed",
        reason: "not_configured",
      })
    })
  })

  test("deduplicates the same stable event key and rejects conflicting reuse", async () => {
    const t = makeTest()
    const request = {
      consumer: { kind: "password_recovery" as const },
      idempotencyKey: "password_recovery:stable-event",
      message: {
        to: "owner@example.test",
        subject: "Reset password",
        text: "private-reset-link",
      },
    }

    const first = await t.mutation(internal.email.enqueueDelivery, request)
    const second = await t.mutation(internal.email.enqueueDelivery, request)
    expect(second).toEqual(first)
    await expect(
      t.mutation(internal.email.enqueueDelivery, {
        ...request,
        message: { ...request.message, text: "different-private-reset-link" },
      })
    ).rejects.toThrow("CMS_EMAIL_DELIVERY_IDEMPOTENCY_CONFLICT")

    const events = await t.run((ctx) =>
      ctx.db.query("emailDeliveryEvents").collect()
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.runId).toBe(first.runId)
  })

  // FR2b row F: the contact-routing case moved to
  // convex/formSubmissions.boundaries.test.ts with its Forms producer.
  test("keeps the owner test authorized but reports non-delivery", async () => {
    await withEmailEnv({ SMTP_HOST: "127.0.0.1" }, async () => {
      const t = makeTest()
      await seedOwner(t)

      const result = await t
        .withIdentity(ownerIdentity)
        .action(api.email.sendTestEmail, {})

      expect(result).toEqual({
        status: "blocked",
        reason: "not_configured",
      })
    })
  })

  test("checks provider readiness before consuming the owner-test limit", async () => {
    await withEmailEnv({}, async () => {
      const t = makeTest()
      await seedOwner(t)
      await t.run((ctx) =>
        ctx.db.insert("emailProviderState", {
          key: "owner",
          provider: {
            kind: "active",
            providerId: "resend",
            configuration: {},
          },
          sender: { address: "sender@example.test", name: "FormulaCMS" },
          configurationVersion: 1,
          updatedAt: Date.now(),
        })
      )

      const result = await t
        .withIdentity(ownerIdentity)
        .action(api.email.sendTestEmail, {})
      expect(result).toEqual({
        status: "blocked",
        reason: "needs_setup",
      })
      const ownerKey = await hashAuthClientIdentity(
        ownerIdentity.tokenIdentifier
      )
      const limit = await t.run((ctx) =>
        rateLimiter.getValue(ctx, "emailOwnerTestPerOwner", {
          key: ownerKey,
        })
      )
      expect(limit.value).toBe(5)
    })
  })

  test("queues only five owner-derived tests per hour", async () => {
    await withEmailEnv({ RESEND_API_KEY: "test-resend-key" }, async () => {
      const fetchSpy = vi.fn(
        async (_input: string | URL | Request, _init?: RequestInit) => {
          void _input
          void _init
          return new Response(JSON.stringify({ id: "resend-test-id" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }
      )
      vi.stubGlobal("fetch", fetchSpy)
      const t = makeTest()
      try {
        await seedOwner(t)
        await t.run((ctx) =>
          ctx.db.insert("emailProviderState", {
            key: "owner",
            provider: {
              kind: "active",
              providerId: "resend",
              configuration: {},
            },
            sender: { address: "sender@example.test", name: "FormulaCMS" },
            configurationVersion: 1,
            updatedAt: Date.now(),
          })
        )
        const asOwner = t.withIdentity(ownerIdentity)

        for (let attempt = 0; attempt < 5; attempt += 1) {
          await expect(
            asOwner.action(api.email.sendTestEmail, {})
          ).resolves.toEqual({
            status: "queued",
            configurationVersion: 1,
          })
        }
        await expect(
          asOwner.action(api.email.sendTestEmail, {})
        ).resolves.toEqual({
          status: "blocked",
          reason: "rate_limited",
        })

        // Convex-test needs more than its 20 idle turns to prove the future
        // retention timers are not due after draining the five immediate jobs.
        await t.finishAllScheduledFunctions(() => undefined, 40)
        const events = await t.run((ctx) =>
          ctx.db.query("emailDeliveryEvents").collect()
        )
        expect(events).toHaveLength(5)
        expect(
          events.every((event) => event.consumer.kind === "owner_test")
        ).toBe(true)
        expect(
          events.every(
            (event) =>
              event.state === "provider_accepted" && event.message === undefined
          )
        ).toBe(true)
        expect(fetchSpy).toHaveBeenCalledTimes(5)
        expect(
          fetchSpy.mock.calls.every(([, init]) =>
            String(init?.body).includes(ownerIdentity.email)
          )
        ).toBe(true)
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })

  test("requires sign-in before sending an operational alert test", async () => {
    const t = makeTest()
    await seedOwner(t)

    await expect(t.action(api.email.sendTestEmail, {})).rejects.toThrow(
      "UNAUTHENTICATED"
    )
  })

  test("keeps provider settings owner-only and secret-clean", async () => {
    await withEmailEnv({ RESEND_API_KEY: "secret-resend-key" }, async () => {
      const t = makeTest()
      await seedOwner(t)

      await expect(
        t.query(api.email.getEmailProviderSettings, {})
      ).rejects.toThrow("UNAUTHENTICATED")
      await expect(
        t
          .withIdentity({
            subject: "not-owner",
            tokenIdentifier: "https://convex.test|not-owner",
            email: "not-owner@example.test",
          })
          .query(api.email.getEmailProviderSettings, {})
      ).rejects.toThrow("CMS_OWNER_REQUIRED")

      const settings = await t
        .withIdentity(ownerIdentity)
        .query(api.email.getEmailProviderSettings, {})
      expect(settings).toMatchObject({
        configuredProviderId: null,
        activeProviderId: null,
        readiness: "fallback",
        configurationVersion: 0,
      })
      expect(settings.catalogue).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "resend",
            registered: true,
            bundled: true,
          }),
          expect.objectContaining({
            id: "custom",
            registered: false,
            bundled: false,
          }),
        ])
      )
      expect(JSON.stringify(settings)).not.toContain("secret-resend-key")
      expect(JSON.stringify(settings)).not.toContain("RESEND_API_KEY")
    })
  })

  test("binds activation to a short-lived provider-accepted test receipt", async () => {
    await withEmailEnv({ RESEND_API_KEY: "test-resend-key" }, async () => {
      const fetchSpy = vi.fn(
        async (_input: string | URL | Request, _init?: RequestInit) => {
          void _input
          void _init
          return new Response(JSON.stringify({ id: "resend-e05-id" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }
      )
      vi.stubGlobal("fetch", fetchSpy)
      const t = makeTest()
      try {
        await seedOwner(t)
        const asOwner = t.withIdentity(ownerIdentity)

        await expect(
          asOwner.mutation(api.email.saveEmailProviderConfiguration, {
            providerId: "resend",
            senderAddress: "sender@example.test",
            senderName: "FormulaCMS",
          })
        ).resolves.toEqual({
          providerId: "resend",
          configurationVersion: 1,
          status: "configured",
        })
        await expect(
          asOwner.mutation(api.email.activateEmailProvider, {
            providerId: "resend",
          })
        ).rejects.toThrow("CMS_EMAIL_PROVIDER_TEST_REQUIRED")

        await expect(
          asOwner.action(api.email.sendTestEmail, {})
        ).resolves.toEqual({
          status: "queued",
          configurationVersion: 1,
        })
        await t.finishAllScheduledFunctions(() => undefined, 40)

        const accepted = await asOwner.query(
          api.email.getEmailProviderSettings,
          {}
        )
        expect(accepted).toMatchObject({
          configuredProviderId: "resend",
          activeProviderId: null,
          readiness: "ready",
          configurationVersion: 1,
          lastTest: { state: "provider_accepted" },
        })
        expect(accepted.lastTest?.state).toBe("provider_accepted")
        if (accepted.lastTest?.state !== "provider_accepted") {
          throw new Error("Expected a provider-accepted owner test")
        }
        expect(accepted.lastTest.receiptExpiresAt).toBeGreaterThan(Date.now())
        expect(JSON.stringify(accepted)).not.toContain("activationReceiptId")

        const receipt = await t.run(async (ctx) => {
          const [row] = await ctx.db
            .query("emailProviderActivationReceipts")
            .collect()
          return row
        })
        expect(receipt).toMatchObject({
          providerId: "resend",
          configurationVersion: 1,
        })
        expect(receipt?.consumedAt).toBeUndefined()

        await expect(
          asOwner.mutation(api.email.activateEmailProvider, {
            providerId: "resend",
          })
        ).resolves.toEqual({
          providerId: "resend",
          configurationVersion: 1,
          status: "active",
        })
        expect(
          await t.run(async (ctx) => {
            if (!receipt) return undefined
            return (await ctx.db.get(receipt._id))?.consumedAt
          })
        ).toEqual(expect.any(Number))

        await expect(
          asOwner.mutation(api.email.saveEmailProviderConfiguration, {
            providerId: "resend",
            senderAddress: "changed-sender@example.test",
            senderName: "FormulaCMS",
          })
        ).resolves.toEqual({
          providerId: "resend",
          configurationVersion: 2,
          status: "configured",
        })
        const changed = await asOwner.query(
          api.email.getEmailProviderSettings,
          {}
        )
        expect(changed.lastTest).toBeUndefined()
        expect(changed.activeProviderId).toBeNull()
        await expect(
          asOwner.mutation(api.email.activateEmailProvider, {
            providerId: "resend",
          })
        ).rejects.toThrow("CMS_EMAIL_PROVIDER_TEST_REQUIRED")
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })

  test("rejects consumed and expired activation receipts", async () => {
    await withEmailEnv({ RESEND_API_KEY: "test-resend-key" }, async () => {
      const t = makeTest()
      await seedOwner(t)
      const asOwner = t.withIdentity(ownerIdentity)

      const receiptId = await t.run(async (ctx) => {
        const now = Date.now()
        const eventId = await ctx.db.insert("emailDeliveryEvents", {
          consumer: {
            kind: "owner_test",
            providerId: "resend",
            configurationVersion: 1,
          },
          idempotencyKey: "owner_test:consumed-receipt",
          messageFingerprint: "a".repeat(64),
          state: "provider_accepted",
          providerId: "resend",
          attempts: 1,
          createdAt: now,
          updatedAt: now,
          expiresAt: now + 60_000,
        })
        const receiptId = await ctx.db.insert(
          "emailProviderActivationReceipts",
          {
            providerId: "resend",
            configurationVersion: 1,
            deliveryEventId: eventId,
            issuedAt: now - 1_000,
            expiresAt: now + 60_000,
            consumedAt: now,
          }
        )
        await ctx.db.insert("emailProviderState", {
          key: "owner",
          provider: {
            kind: "configured",
            providerId: "resend",
            configuration: {},
          },
          sender: { address: "sender@example.test" },
          configurationVersion: 1,
          lastTest: {
            providerId: "resend",
            configurationVersion: 1,
            state: "provider_accepted",
            activationReceiptId: receiptId,
            receiptExpiresAt: now + 60_000,
            updatedAt: now,
          },
          updatedAt: now,
        })
        return receiptId
      })

      await expect(
        asOwner.mutation(api.email.activateEmailProvider, {
          providerId: "resend",
        })
      ).rejects.toThrow("CMS_EMAIL_PROVIDER_TEST_REQUIRED")

      await t.run(async (ctx) => {
        const now = Date.now()
        await ctx.db.patch(receiptId, {
          consumedAt: undefined,
          expiresAt: now - 1,
        })
        const state = await ctx.db.query("emailProviderState").unique()
        if (!state) throw new Error("Missing provider state")
        await ctx.db.patch(state._id, {
          lastTest: {
            providerId: "resend",
            configurationVersion: 1,
            state: "provider_accepted",
            activationReceiptId: receiptId,
            receiptExpiresAt: now - 1,
            updatedAt: now,
          },
        })
      })
      await expect(
        asOwner.mutation(api.email.activateEmailProvider, {
          providerId: "resend",
        })
      ).rejects.toThrow("CMS_EMAIL_PROVIDER_TEST_REQUIRED")
    })
  })

  test("lets the owner turn the active provider off and requires a new test to turn it on", async () => {
    await withEmailEnv({ RESEND_API_KEY: "test-resend-key" }, async () => {
      const fetchSpy = vi.fn(
        async (_input: string | URL | Request, _init?: RequestInit) => {
          void _input
          void _init
          return new Response(JSON.stringify({ id: "resend-off-id" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }
      )
      vi.stubGlobal("fetch", fetchSpy)
      const t = makeTest()
      try {
        await seedOwner(t)
        const asOwner = t.withIdentity(ownerIdentity)
        await asOwner.mutation(api.email.saveEmailProviderConfiguration, {
          providerId: "resend",
          senderAddress: "sender@example.test",
          senderName: "FormulaCMS",
        })
        await asOwner.action(api.email.sendTestEmail, {})
        await t.finishAllScheduledFunctions(() => undefined, 40)
        await asOwner.mutation(api.email.activateEmailProvider, {
          providerId: "resend",
        })
        await expect(
          t.query(internal.email.getResolvedSettings, {})
        ).resolves.toMatchObject({
          provider: "resend",
          fromAddress: "sender@example.test",
        })

        await expect(
          asOwner.mutation(api.email.deactivateEmailProvider, {
            providerId: "resend",
          })
        ).resolves.toEqual({
          providerId: "resend",
          configurationVersion: 2,
          status: "configured",
        })
        const off = await asOwner.query(api.email.getEmailProviderSettings, {})
        expect(off).toMatchObject({
          configuredProviderId: "resend",
          activeProviderId: null,
          configurationVersion: 2,
          sender: { address: "sender@example.test", name: "FormulaCMS" },
        })
        expect(off.lastTest).toBeUndefined()
        await expect(
          t.query(internal.email.getResolvedSettings, {})
        ).resolves.toEqual({ provider: "console" })
        await expect(
          asOwner.mutation(api.email.activateEmailProvider, {
            providerId: "resend",
          })
        ).rejects.toThrow("CMS_EMAIL_PROVIDER_TEST_REQUIRED")

        await expect(
          asOwner.action(api.email.sendTestEmail, {})
        ).resolves.toEqual({ status: "queued", configurationVersion: 2 })
        await t.finishAllScheduledFunctions(() => undefined, 40)
        await expect(
          asOwner.mutation(api.email.activateEmailProvider, {
            providerId: "resend",
          })
        ).resolves.toEqual({
          providerId: "resend",
          configurationVersion: 2,
          status: "active",
        })
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })

  test("turning a provider off clears its test, refuses non-owners and ignores a provider that is already off", async () => {
    const t = makeTest()
    await seedOwner(t)
    const asOwner = t.withIdentity(ownerIdentity)
    const readRow = () =>
      t.run((ctx) => ctx.db.query("emailProviderState").unique())
    const now = Date.now()
    await t.run((ctx) =>
      ctx.db.insert("emailProviderState", {
        key: "owner",
        provider: { kind: "active", providerId: "resend", configuration: {} },
        sender: { address: "sender@example.test" },
        configurationVersion: 4,
        lastTest: {
          providerId: "resend",
          configurationVersion: 4,
          state: "queued",
          updatedAt: now,
        },
        updatedAt: now,
      })
    )
    const before = await readRow()

    await expect(
      t
        .withIdentity({
          subject: "someone-else",
          tokenIdentifier: "https://convex.test|someone-else",
          name: "Someone",
          email: "someone@example.com",
        })
        .mutation(api.email.deactivateEmailProvider, { providerId: "resend" })
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
    await expect(
      t.mutation(api.email.deactivateEmailProvider, { providerId: "resend" })
    ).rejects.toThrow("UNAUTHENTICATED")
    expect(await readRow()).toEqual(before)

    await expect(
      asOwner.mutation(api.email.deactivateEmailProvider, {
        providerId: "resend",
      })
    ).resolves.toEqual({
      providerId: "resend",
      configurationVersion: 5,
      status: "configured",
    })
    const off = await readRow()
    expect(off).toMatchObject({
      provider: { kind: "configured", providerId: "resend" },
      sender: { address: "sender@example.test" },
      configurationVersion: 5,
    })
    expect(off?.lastTest).toBeUndefined()

    // Already off: no write and no version change, like activating an active provider.
    await expect(
      asOwner.mutation(api.email.deactivateEmailProvider, {
        providerId: "resend",
      })
    ).resolves.toEqual({
      providerId: "resend",
      configurationVersion: 5,
      status: "configured",
    })
    expect(await readRow()).toEqual(off)

    // No provider stored at all: refused, like activation.
    const empty = makeTest()
    await seedOwner(empty)
    await expect(
      empty
        .withIdentity(ownerIdentity)
        .mutation(api.email.deactivateEmailProvider, { providerId: "resend" })
    ).rejects.toThrow("CMS_EMAIL_PROVIDER_CONFIGURATION_REQUIRED")
  })

  test("clears message content and projects unknown contact delivery as failed", async () => {
    const t = makeTest()
    const runId = "run-email-failed" as RunId
    const submissionId = await t.run((ctx) =>
      ctx.db.insert("formSubmissions", {
        form: "contact",
        payload: {
          name: "Ada Lovelace",
          email: "ada@example.com",
          message: "Please tell me more about the starter.",
        },
        sourcePath: "/contact",
        sourceLocale: "en",
        notifyStatus: "pending",
        notifyAttempts: 0,
        notifyRunId: runId,
        schemaVersion: 1,
        createdAt: Date.now(),
      })
    )

    const eventId = await t.run((ctx) =>
      ctx.db.insert("emailDeliveryEvents", {
        consumer: { kind: "contact", submissionId },
        idempotencyKey: `contact:${submissionId}`,
        messageFingerprint: "a".repeat(64),
        message: {
          to: "owner@example.com",
          subject: "Contact submission",
          text: "private-contact-message",
        },
        state: "queued",
        providerId: "resend",
        runId,
        attempts: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      })
    )

    await t.mutation(internal.email._recordDeliveryResult, {
      runId,
      result: {
        type: "success",
        returnValue: {
          state: "unknown",
          providerId: "resend",
          reason: "delivery_unknown",
        },
      },
    })

    const [row, event] = await t.run(
      async (ctx) =>
        await Promise.all([ctx.db.get(submissionId), ctx.db.get(eventId)])
    )
    expect(row?.notifyStatus).toBe("failed")
    expect(row?.notifyError).toBe("delivery_unknown")
    expect(row?.notifyAttempts).toBe(1)
    expect(row?.notifiedAt).toBeUndefined()
    expect(event?.state).toBe("unknown")
    expect(event?.failureReason).toBe("delivery_unknown")
    expect(event?.message).toBeUndefined()
  })
})
