/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { describe, expect, test, vi } from "vitest"
import { api, internal } from "./_generated/api"
import schema from "./schema"
import { seedCommunityOwner } from "../convexTestWithExplicitAdmin"
import actionRetrierTest from "@convex-dev/action-retrier/test"
import { enableAuthSessions } from "../test-utils/convexAuthFixtures"
import rateLimiterTest from "@convex-dev/rate-limiter/test"
import type { RunId } from "@convex-dev/action-retrier"
import { EmailAdapterError } from "@opencoredev/email-sdk"
import { rateLimiter } from "./lib/rateLimits"
import { hashAuthClientIdentity } from "./email"

// The SMTP adapter of the Email SDK opens a socket; replace it for the whole
// file. Resend tests never reach it.
const smtpMock = vi.hoisted(() => {
  const send = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    adapter: "smtp",
    id: "smtp-queue-id",
  }))
  const factory = vi.fn((options: unknown) => {
    void options
    return {
      name: "smtp",
      capabilities: {
        repeatedHeaders: true,
        idempotency: "message_id",
        scheduling: false,
        personalized: "expanded",
      },
      send,
    }
  })
  return { send, factory }
})
vi.mock("@opencoredev/email-sdk/smtp", () => ({ smtp: smtpMock.factory }))

const modules = import.meta.glob("./**/*.ts")

/** The one durable Community owner; both identity fields are explicit. */
const OWNER_ID = "owner-1"
const ownerIdentity = {
  subject: OWNER_ID,
  tokenIdentifier: "owner-1",
  name: "Owner",
  email: "admin@example.com",
}

const EMAIL_ENV_KEYS = [
  "EMAIL_SMTP_HOST",
  "EMAIL_SMTP_PORT",
  "EMAIL_SMTP_USER",
  "EMAIL_SMTP_PASSWORD",
  "CMS_SECRET_KEY",
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
  return enableAuthSessions(t)
}

async function withEmailEnv<T>(
  overrides: Partial<Record<(typeof EMAIL_ENV_KEYS)[number], string>>,
  run: () => Promise<T>
): Promise<T> {
  for (const key of EMAIL_ENV_KEYS) vi.stubEnv(key, undefined)
  for (const [key, value] of Object.entries(overrides)) {
    vi.stubEnv(key, value)
  }

  try {
    return await run()
  } finally {
    vi.unstubAllEnvs()
  }
}

async function seedOwner(t: ReturnType<typeof makeTest>) {
  await seedCommunityOwner(t, ownerIdentity)
  // The owner test email goes to the stored notification email (ADR-0056 rule 5).
  await t.run(async (ctx) => {
    const owner = await ctx.db.query("cmsOwner").unique()
    await ctx.db.patch("cmsOwner", owner!._id, {
      notificationEmail: ownerIdentity.email,
    })
  })
}

const SENDER = {
  senderAddress: "sender@example.test",
  senderName: "FormulaCMS",
} as const

type OwnerSite = ReturnType<ReturnType<typeof makeTest>["withIdentity"]>

/** Resend answers every request with an accepted message. */
function stubResendFetch(id: string) {
  const spy = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) => {
      void _input
      void _init
      return new Response(JSON.stringify({ id }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
  )
  vi.stubGlobal("fetch", spy)
  return spy
}

function readProviderRow(t: ReturnType<typeof makeTest>) {
  return t.run((ctx) => ctx.db.query("emailProviderState").unique())
}

/**
 * Queues one owner test and returns the run id of its event. Run it under fake
 * timers: the event then stays queued, as one that was already dispatched.
 */
async function queueOwnerTest(
  t: ReturnType<typeof makeTest>,
  asOwner: OwnerSite
): Promise<RunId> {
  const before = new Set(
    (await t.run((ctx) => ctx.db.query("emailDeliveryEvents").collect())).map(
      (event) => event._id
    )
  )
  await expect(asOwner.action(api.email.sendTestEmail, {})).resolves.toMatchObject(
    { status: "queued" }
  )
  const added = (
    await t.run((ctx) => ctx.db.query("emailDeliveryEvents").collect())
  ).filter((event) => !before.has(event._id))
  expect(added).toHaveLength(1)
  return added[0]!.runId as RunId
}

/** Delivers a finished run to the completion path, as Action Retrier does. */
async function deliver(
  t: ReturnType<typeof makeTest>,
  runId: RunId,
  returnValue: unknown
) {
  await t.mutation(internal.email._recordDeliveryResult, {
    runId,
    result: { type: "success", returnValue },
  })
}

const acceptedBy = (providerId: string) => ({
  state: "provider_accepted",
  providerId,
})
const unknownBy = (providerId: string) => ({
  state: "unknown",
  providerId,
  reason: "delivery_unknown",
})

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
            tokenIdentifier: "not-owner",
            email: "not-owner@example.test",
          })
          .query(api.email.getEmailProviderSettings, {})
      ).rejects.toThrow("CMS_OWNER_REQUIRED")

      const settings = await t
        .withIdentity(ownerIdentity)
        .query(api.email.getEmailProviderSettings, {})
      expect(settings).toMatchObject({
        enabledProviderId: null,
        activeProviderId: null,
        readiness: "fallback",
        configurationVersion: 0,
      })
      expect(settings.catalogue.map(({ id }) => id)).toEqual([
        "smtp",
        "resend",
        "custom",
      ])
      expect(settings.catalogue).toEqual([
        expect.objectContaining({ id: "smtp", registered: true, bundled: true }),
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
      // Variable names and presence flags are allowed; a value never is.
      expect(JSON.stringify(settings)).not.toContain("secret-resend-key")
    })
  })

  test("an accepted test makes the enabled provider active by itself; a changed sender makes it inactive", async () => {
    await withEmailEnv({ RESEND_API_KEY: "test-resend-key" }, async () => {
      stubResendFetch("resend-e05-id")
      const t = makeTest()
      try {
        await seedOwner(t)
        const asOwner = t.withIdentity(ownerIdentity)

        // Saving takes only the sender and enables nothing.
        await expect(
          asOwner.mutation(api.email.saveEmailProviderConfiguration, SENDER)
        ).resolves.toEqual({
          enabledProviderId: null,
          configurationVersion: 1,
          status: "disabled",
        })
        await expect(
          asOwner.mutation(api.email.enableEmailProvider, {
            providerId: "resend",
          })
        ).resolves.toEqual({
          enabledProviderId: "resend",
          configurationVersion: 2,
          status: "inactive",
        })
        // Enabled is not active: nothing is sent until a test is accepted.
        await expect(
          t.query(internal.email.getResolvedSettings, {})
        ).resolves.toEqual({ provider: "console" })

        await expect(
          asOwner.action(api.email.sendTestEmail, {})
        ).resolves.toEqual({ status: "queued", configurationVersion: 2 })
        await expect(
          asOwner.query(api.email.getEmailProviderSettings, {})
        ).resolves.toMatchObject({
          activeProviderId: null,
          lastTest: { providerId: "resend", state: "queued" },
        })
        await t.finishAllScheduledFunctions(() => undefined, 40)

        const accepted = await asOwner.query(
          api.email.getEmailProviderSettings,
          {}
        )
        expect(accepted).toMatchObject({
          enabledProviderId: "resend",
          activeProviderId: "resend",
          readiness: "ready",
          configurationVersion: 2,
        })
        expect(accepted.lastTest).toBeUndefined()
        expect(JSON.stringify(accepted)).not.toContain("activationReceiptId")
        // No activation receipt is written any more.
        expect(
          await t.run((ctx) =>
            ctx.db.query("emailProviderActivationReceipts").collect()
          )
        ).toEqual([])
        await expect(
          t.query(internal.email.getResolvedSettings, {})
        ).resolves.toMatchObject({
          provider: "resend",
          fromAddress: "sender@example.test",
        })

        // A changed sender keeps the choice and drops the result.
        await expect(
          asOwner.mutation(api.email.saveEmailProviderConfiguration, {
            senderAddress: "changed-sender@example.test",
            senderName: "FormulaCMS",
          })
        ).resolves.toEqual({
          enabledProviderId: "resend",
          configurationVersion: 3,
          status: "inactive",
        })
        const changed = await asOwner.query(
          api.email.getEmailProviderSettings,
          {}
        )
        expect(changed).toMatchObject({
          enabledProviderId: "resend",
          activeProviderId: null,
        })
        expect(changed.lastTest).toBeUndefined()
        await expect(
          t.query(internal.email.getResolvedSettings, {})
        ).resolves.toEqual({ provider: "console" })
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })

  describe("a late result for a test that was already dispatched", () => {
    // The Action Retrier completes a run after the owner changed the state.
    // The event stays queued here, and its accepted result is delivered by
    // hand, so the guard in the completion path is what is tested.
    const bothProviders = {
      EMAIL_SMTP_HOST: "mail.example.test",
      EMAIL_SMTP_USER: "test-user",
      EMAIL_SMTP_PASSWORD: "test-password",
      RESEND_API_KEY: "test-resend-key",
    } as const

    async function frozen(run: () => Promise<void>) {
      vi.useFakeTimers()
      try {
        await withEmailEnv(bothProviders, run)
      } finally {
        vi.useRealTimers()
      }
    }

    async function enabledWithQueuedTest(
      providerId: "smtp" | "resend" = "resend"
    ) {
      const t = makeTest()
      await seedOwner(t)
      const asOwner = t.withIdentity(ownerIdentity)
      await asOwner.mutation(api.email.saveEmailProviderConfiguration, SENDER)
      await asOwner.mutation(api.email.enableEmailProvider, { providerId })
      const runId = await queueOwnerTest(t, asOwner)
      return { t, asOwner, runId }
    }

    test("a disabled provider never becomes active", async () => {
      await frozen(async () => {
        const { t, asOwner, runId } = await enabledWithQueuedTest()
        await expect(
          asOwner.mutation(api.email.disableEmailProvider, {
            providerId: "resend",
          })
        ).resolves.toEqual({
          enabledProviderId: null,
          configurationVersion: 3,
          status: "disabled",
        })

        await deliver(t, runId, acceptedBy("resend"))

        const row = await readProviderRow(t)
        expect(row).toMatchObject({
          provider: { kind: "fallback" },
          configurationVersion: 3,
        })
        expect(row?.lastTest).toBeUndefined()
        await expect(
          t.query(internal.email.getResolvedSettings, {})
        ).resolves.toEqual({ provider: "console" })
      })
    })

    test("an accepted test of one provider never activates the other", async () => {
      await frozen(async () => {
        const { t, asOwner, runId } = await enabledWithQueuedTest("smtp")
        await expect(
          asOwner.mutation(api.email.enableEmailProvider, {
            providerId: "resend",
          })
        ).resolves.toEqual({
          enabledProviderId: "resend",
          configurationVersion: 3,
          status: "inactive",
        })

        await deliver(t, runId, acceptedBy("smtp"))

        expect(await readProviderRow(t)).toMatchObject({
          provider: { kind: "configured", providerId: "resend" },
          configurationVersion: 3,
        })
        await expect(
          t.query(internal.email.getResolvedSettings, {})
        ).resolves.toEqual({ provider: "console" })
      })
    })

    test("disable then enable of the same provider: the late result activates nothing", async () => {
      await frozen(async () => {
        const { t, asOwner, runId } = await enabledWithQueuedTest()
        await asOwner.mutation(api.email.disableEmailProvider, {
          providerId: "resend",
        })
        await expect(
          asOwner.mutation(api.email.enableEmailProvider, {
            providerId: "resend",
          })
        ).resolves.toEqual({
          enabledProviderId: "resend",
          configurationVersion: 4,
          status: "inactive",
        })

        await deliver(t, runId, acceptedBy("resend"))

        expect(await readProviderRow(t)).toMatchObject({
          provider: { kind: "configured", providerId: "resend" },
          configurationVersion: 4,
        })
        await expect(
          t.query(internal.email.getResolvedSettings, {})
        ).resolves.toEqual({ provider: "console" })
      })
    })

    test("a sender change after the test was dispatched: the late result activates nothing", async () => {
      await frozen(async () => {
        const { t, asOwner, runId } = await enabledWithQueuedTest()
        await expect(
          asOwner.mutation(api.email.saveEmailProviderConfiguration, {
            senderAddress: "changed-sender@example.test",
          })
        ).resolves.toEqual({
          enabledProviderId: "resend",
          configurationVersion: 3,
          status: "inactive",
        })

        await deliver(t, runId, acceptedBy("resend"))

        const row = await readProviderRow(t)
        expect(row).toMatchObject({
          provider: { kind: "configured", providerId: "resend" },
          sender: { address: "changed-sender@example.test" },
          configurationVersion: 3,
        })
        expect(row?.lastTest).toBeUndefined()
        await expect(
          t.query(internal.email.getResolvedSettings, {})
        ).resolves.toEqual({ provider: "console" })
      })
    })

    test("a late result of the current version still activates, even after a later failed test of that version", async () => {
      await frozen(async () => {
        const { t, asOwner, runId: first } = await enabledWithQueuedTest()
        const second = await queueOwnerTest(t, asOwner)
        await deliver(t, second, {
          state: "failed",
          providerId: "resend",
          reason: "provider_rejected",
        })
        expect(await readProviderRow(t)).toMatchObject({
          provider: { kind: "configured" },
          lastTest: { state: "failed" },
        })

        await deliver(t, first, acceptedBy("resend"))

        expect(await readProviderRow(t)).toMatchObject({
          provider: { kind: "active", providerId: "resend" },
        })
      })
    })

    test("a refused or uncertain result leaves an inactive provider inactive", async () => {
      await frozen(async () => {
        const { t, asOwner, runId } = await enabledWithQueuedTest()
        await deliver(t, runId, unknownBy("resend"))
        expect(await readProviderRow(t)).toMatchObject({
          provider: { kind: "configured", providerId: "resend" },
          lastTest: { state: "unknown", reason: "delivery_unknown" },
        })

        const next = await queueOwnerTest(t, asOwner)
        await deliver(t, next, {
          state: "failed",
          providerId: "resend",
          reason: "provider_rejected",
          category: "sign_in_refused",
        })
        expect(await readProviderRow(t)).toMatchObject({
          provider: { kind: "configured", providerId: "resend" },
          lastTest: { state: "failed", category: "sign_in_refused" },
        })
        await expect(
          t.query(internal.email.getResolvedSettings, {})
        ).resolves.toEqual({ provider: "console" })
      })
    })

    test("a queued, refused and unknown re-test each leave an active provider active", async () => {
      await frozen(async () => {
        const { t, asOwner, runId } = await enabledWithQueuedTest()
        await deliver(t, runId, acceptedBy("resend"))
        expect(await readProviderRow(t)).toMatchObject({
          provider: { kind: "active", providerId: "resend" },
        })
        const stillActive = async () => {
          expect(await readProviderRow(t)).toMatchObject({
            provider: { kind: "active", providerId: "resend" },
            configurationVersion: 2,
          })
          await expect(
            t.query(internal.email.getResolvedSettings, {})
          ).resolves.toMatchObject({ provider: "resend" })
        }

        const retest = await queueOwnerTest(t, asOwner)
        await stillActive()
        await expect(
          asOwner.query(api.email.getEmailProviderSettings, {})
        ).resolves.toMatchObject({
          activeProviderId: "resend",
          lastTest: { state: "queued" },
        })

        await deliver(t, retest, {
          state: "failed",
          providerId: "resend",
          reason: "provider_rejected",
        })
        await stillActive()
        await expect(
          asOwner.query(api.email.getEmailProviderSettings, {})
        ).resolves.toMatchObject({
          activeProviderId: "resend",
          lastTest: { state: "failed" },
        })

        const again = await queueOwnerTest(t, asOwner)
        await deliver(t, again, unknownBy("resend"))
        await stillActive()
        await expect(
          asOwner.query(api.email.getEmailProviderSettings, {})
        ).resolves.toMatchObject({
          activeProviderId: "resend",
          lastTest: { state: "unknown" },
        })
      })
    })
  })

  test("enabling needs no sender and no ready environment; enabling the enabled provider and saving the same sender write nothing", async () => {
    await withEmailEnv({}, async () => {
      const t = makeTest()
      await seedOwner(t)
      const asOwner = t.withIdentity(ownerIdentity)

      await expect(
        asOwner.mutation(api.email.enableEmailProvider, {
          providerId: "resend",
        })
      ).resolves.toEqual({
        enabledProviderId: "resend",
        configurationVersion: 1,
        status: "inactive",
      })
      await expect(
        asOwner.query(api.email.getEmailProviderSettings, {})
      ).resolves.toMatchObject({
        enabledProviderId: "resend",
        activeProviderId: null,
        readiness: "needs_setup",
      })
      expect((await readProviderRow(t))?.sender).toBeUndefined()
      // Enabled without a sender: no test can be sent, nothing is delivered.
      await expect(
        asOwner.action(api.email.sendTestEmail, {})
      ).resolves.toEqual({ status: "blocked", reason: "not_configured" })
      await expect(
        t.query(internal.email.getResolvedSettings, {})
      ).resolves.toEqual({ provider: "console" })

      const enabled = await readProviderRow(t)
      await expect(
        asOwner.mutation(api.email.enableEmailProvider, {
          providerId: "resend",
        })
      ).resolves.toEqual({
        enabledProviderId: "resend",
        configurationVersion: 1,
        status: "inactive",
      })
      expect(await readProviderRow(t)).toEqual(enabled)

      await asOwner.mutation(api.email.saveEmailProviderConfiguration, SENDER)
      const saved = await readProviderRow(t)
      expect(saved).toMatchObject({
        provider: { kind: "configured", providerId: "resend" },
        sender: { address: "sender@example.test", name: "FormulaCMS" },
        configurationVersion: 2,
      })
      await expect(
        asOwner.mutation(api.email.saveEmailProviderConfiguration, SENDER)
      ).resolves.toEqual({
        enabledProviderId: "resend",
        configurationVersion: 2,
        status: "inactive",
      })
      expect(await readProviderRow(t)).toEqual(saved)
      // The environment is still not ready, so the test is blocked.
      await expect(
        asOwner.action(api.email.sendTestEmail, {})
      ).resolves.toEqual({ status: "blocked", reason: "needs_setup" })
    })
  })

  test("saving a sender with nothing enabled keeps the Console fallback and blocks the test", async () => {
    await withEmailEnv({ RESEND_API_KEY: "test-resend-key" }, async () => {
      const t = makeTest()
      await seedOwner(t)
      const asOwner = t.withIdentity(ownerIdentity)

      await expect(
        asOwner.mutation(api.email.saveEmailProviderConfiguration, SENDER)
      ).resolves.toEqual({
        enabledProviderId: null,
        configurationVersion: 1,
        status: "disabled",
      })
      expect(await readProviderRow(t)).toMatchObject({
        provider: { kind: "fallback" },
        sender: { address: "sender@example.test" },
      })
      await expect(
        asOwner.query(api.email.getEmailProviderSettings, {})
      ).resolves.toMatchObject({
        enabledProviderId: null,
        activeProviderId: null,
        readiness: "fallback",
        sender: { address: "sender@example.test", name: "FormulaCMS" },
      })
      await expect(
        asOwner.action(api.email.sendTestEmail, {})
      ).resolves.toEqual({ status: "blocked", reason: "not_configured" })
      await expect(
        t.query(internal.email.getResolvedSettings, {})
      ).resolves.toEqual({ provider: "console" })
    })
  })

  test("rows written before the change keep their meaning", async () => {
    await withEmailEnv({ RESEND_API_KEY: "test-resend-key" }, async () => {
      const t = makeTest()
      await seedOwner(t)
      const asOwner = t.withIdentity(ownerIdentity)

      // A configured row with an accepted test and a live receipt reads as
      // enabled and inactive, with no test shown.
      const receiptId = await t.run(async (ctx) => {
        const now = Date.now()
        const eventId = await ctx.db.insert("emailDeliveryEvents", {
          consumer: {
            kind: "owner_test",
            providerId: "resend",
            configurationVersion: 1,
          },
          idempotencyKey: "owner_test:legacy-receipt",
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
            issuedAt: now,
            expiresAt: now + 60_000,
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
      const legacy = await asOwner.query(api.email.getEmailProviderSettings, {})
      expect(legacy).toMatchObject({
        enabledProviderId: "resend",
        activeProviderId: null,
        configurationVersion: 1,
      })
      expect(legacy.lastTest).toBeUndefined()
      expect(JSON.stringify(legacy)).not.toContain("provider_accepted")
      await expect(
        t.query(internal.email.getResolvedSettings, {})
      ).resolves.toEqual({ provider: "console" })

      // The scheduled expiry still removes the receipt and the stored test.
      await t.run(async (ctx) => {
        await ctx.db.patch("emailProviderActivationReceipts", receiptId, {
          expiresAt: Date.now() - 1,
        })
      })
      await t.mutation(internal.email._expireActivationReceipt, {
        activationReceiptId: receiptId,
      })
      expect(
        await t.run((ctx) =>
          ctx.db.get("emailProviderActivationReceipts", receiptId)
        )
      ).toBeNull()
      expect((await readProviderRow(t))?.lastTest).toBeUndefined()

      // An active row reads as enabled and active, and still sends.
      await t.run(async (ctx) => {
        const row = await ctx.db.query("emailProviderState").unique()
        await ctx.db.patch("emailProviderState", row!._id, {
          provider: { kind: "active", providerId: "resend", configuration: {} },
        })
      })
      await expect(
        asOwner.query(api.email.getEmailProviderSettings, {})
      ).resolves.toMatchObject({
        enabledProviderId: "resend",
        activeProviderId: "resend",
      })
      await expect(
        t.query(internal.email.getResolvedSettings, {})
      ).resolves.toMatchObject({
        provider: "resend",
        fromAddress: "sender@example.test",
      })
    })
  })

  test("disable then enable needs a new accepted test", async () => {
    await withEmailEnv({ RESEND_API_KEY: "test-resend-key" }, async () => {
      stubResendFetch("resend-off-id")
      const t = makeTest()
      try {
        await seedOwner(t)
        const asOwner = t.withIdentity(ownerIdentity)
        await asOwner.mutation(api.email.saveEmailProviderConfiguration, SENDER)
        await asOwner.mutation(api.email.enableEmailProvider, {
          providerId: "resend",
        })
        await asOwner.action(api.email.sendTestEmail, {})
        await t.finishAllScheduledFunctions(() => undefined, 40)
        await expect(
          t.query(internal.email.getResolvedSettings, {})
        ).resolves.toMatchObject({
          provider: "resend",
          fromAddress: "sender@example.test",
        })

        await expect(
          asOwner.mutation(api.email.disableEmailProvider, {
            providerId: "resend",
          })
        ).resolves.toEqual({
          enabledProviderId: null,
          configurationVersion: 3,
          status: "disabled",
        })
        const off = await asOwner.query(api.email.getEmailProviderSettings, {})
        expect(off).toMatchObject({
          enabledProviderId: null,
          activeProviderId: null,
          configurationVersion: 3,
          sender: { address: "sender@example.test", name: "FormulaCMS" },
        })
        expect(off.lastTest).toBeUndefined()
        await expect(
          t.query(internal.email.getResolvedSettings, {})
        ).resolves.toEqual({ provider: "console" })

        // Enabling again starts inactive: nothing is sent yet.
        await expect(
          asOwner.mutation(api.email.enableEmailProvider, {
            providerId: "resend",
          })
        ).resolves.toEqual({
          enabledProviderId: "resend",
          configurationVersion: 4,
          status: "inactive",
        })
        await expect(
          t.query(internal.email.getResolvedSettings, {})
        ).resolves.toEqual({ provider: "console" })

        await expect(
          asOwner.action(api.email.sendTestEmail, {})
        ).resolves.toEqual({ status: "queued", configurationVersion: 4 })
        await t.finishAllScheduledFunctions(() => undefined, 40)
        await expect(
          asOwner.query(api.email.getEmailProviderSettings, {})
        ).resolves.toMatchObject({
          enabledProviderId: "resend",
          activeProviderId: "resend",
          configurationVersion: 4,
        })
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })

  test("disabling clears the test, goes to fallback, refuses non-owners and ignores a provider that is not enabled", async () => {
    const t = makeTest()
    await seedOwner(t)
    const asOwner = t.withIdentity(ownerIdentity)
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
    const before = await readProviderRow(t)

    await expect(
      t
        .withIdentity({
          subject: "someone-else",
          tokenIdentifier: "someone-else",
          name: "Someone",
          email: "someone@example.com",
        })
        .mutation(api.email.disableEmailProvider, { providerId: "resend" })
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
    await expect(
      t.mutation(api.email.disableEmailProvider, { providerId: "resend" })
    ).rejects.toThrow("UNAUTHENTICATED")
    expect(await readProviderRow(t)).toEqual(before)

    // Another provider is the enabled one: the call writes nothing.
    await expect(
      asOwner.mutation(api.email.disableEmailProvider, { providerId: "smtp" })
    ).resolves.toEqual({
      enabledProviderId: "resend",
      configurationVersion: 4,
      status: "active",
    })
    expect(await readProviderRow(t)).toEqual(before)

    await expect(
      asOwner.mutation(api.email.disableEmailProvider, {
        providerId: "resend",
      })
    ).resolves.toEqual({
      enabledProviderId: null,
      configurationVersion: 5,
      status: "disabled",
    })
    const off = await readProviderRow(t)
    expect(off).toMatchObject({
      provider: { kind: "fallback" },
      sender: { address: "sender@example.test" },
      configurationVersion: 5,
    })
    expect(off?.lastTest).toBeUndefined()

    // Already disabled: no write and no version change.
    await expect(
      asOwner.mutation(api.email.disableEmailProvider, {
        providerId: "resend",
      })
    ).resolves.toEqual({
      enabledProviderId: null,
      configurationVersion: 5,
      status: "disabled",
    })
    expect(await readProviderRow(t)).toEqual(off)

    // Nothing stored at all: nothing to disable.
    const empty = makeTest()
    await seedOwner(empty)
    await expect(
      empty
        .withIdentity(ownerIdentity)
        .mutation(api.email.disableEmailProvider, { providerId: "resend" })
    ).resolves.toEqual({
      enabledProviderId: null,
      configurationVersion: 0,
      status: "disabled",
    })
    expect(await readProviderRow(empty)).toBeNull()
  })

  describe("SMTP provider", () => {
    const smtpEnvironment = {
      EMAIL_SMTP_HOST: "mail.example.test",
      EMAIL_SMTP_USER: "test-user",
      EMAIL_SMTP_PASSWORD: "test-password",
    } as const

    function resetSmtpMock() {
      smtpMock.factory.mockClear()
      smtpMock.send.mockReset()
      smtpMock.send.mockResolvedValue({ adapter: "smtp", id: "smtp-queue-id" })
    }

    // Sets the sender and enables SMTP: the state after the owner's two steps.
    async function saveSmtp(t: ReturnType<typeof makeTest>) {
      await seedOwner(t)
      const asOwner = t.withIdentity(ownerIdentity)
      await asOwner.mutation(api.email.saveEmailProviderConfiguration, SENDER)
      await asOwner.mutation(api.email.enableEmailProvider, {
        providerId: "smtp",
      })
      return asOwner
    }

    test("legacy SMTP state and legacy SMTP variables never activate the SMTP provider", async () => {
      resetSmtpMock()
      await withEmailEnv(
        {
          SMTP_HOST: "smtp.legacy.example.test",
          SMTP_PORT: "587",
          SMTP_SECURE: "false",
          SMTP_USER: "legacy-user",
          SMTP_PASSWORD: "legacy-password",
          SMTP_FROM_ADDRESS: "legacy@example.test",
          SMTP_FROM_NAME: "Legacy",
          CMS_SECRET_KEY: "legacy-secret-key",
          ...smtpEnvironment,
          EMAIL_SMTP_PORT: "587",
        },
        async () => {
          const t = makeTest()
          await seedOwner(t)
          await t.run(async (ctx) => {
            await ctx.db.insert("emailSettings", {
              provider: "smtp",
              fromAddress: "owner@example.test",
              fromName: "Owner",
              smtpHost: "smtp.legacy.example.test",
              smtpPort: 587,
              smtpSecure: false,
              smtpUser: "legacy-user",
              smtpPasswordCiphertext: "encrypted-envelope",
              schemaVersion: 1,
              updatedAt: Date.now(),
            })
            await ctx.db.insert("siteSettings", {
              siteName: "Legacy SMTP",
              siteUrl: "https://example.test",
              defaultLocale: "en",
              enabledLocales: ["en"],
              emailProvider: "smtp",
              emailFromAddress: "owner@example.test",
              updatedAt: 1,
            })
          })
          const asOwner = t.withIdentity(ownerIdentity)

          await expect(
            t.query(internal.email.getResolvedSettings, {})
          ).resolves.toEqual({ provider: "console" })
          await expect(
            asOwner.query(api.email.getEmailProviderSettings, {})
          ).resolves.toMatchObject({
            enabledProviderId: null,
            activeProviderId: null,
            readiness: "fallback",
          })
          await expect(
            asOwner.action(api.email.sendTestEmail, {})
          ).resolves.toEqual({ status: "blocked", reason: "not_configured" })
          await expect(
            asOwner.mutation(api.email.saveEmailProviderConfiguration, {
              senderAddress: "sender@example.test",
            })
          ).rejects.toThrow("CMS_EMAIL_PROVIDER_MIGRATION_REQUIRED")
          await expect(
            asOwner.mutation(api.email.enableEmailProvider, {
              providerId: "smtp",
            })
          ).rejects.toThrow("CMS_EMAIL_PROVIDER_MIGRATION_REQUIRED")
          expect(smtpMock.factory).not.toHaveBeenCalled()
          expect(smtpMock.send).not.toHaveBeenCalled()
        }
      )
    })

    test("runs sender, enable, check and owner test on SMTP and resolves to the smtp provider", async () => {
      resetSmtpMock()
      await withEmailEnv(smtpEnvironment, async () => {
        const t = makeTest()
        const asOwner = await saveSmtp(t)

        await expect(
          asOwner.action(api.email.checkEmailProviderConfiguration, {
            providerId: "smtp",
          })
        ).resolves.toEqual({
          providerId: "smtp",
          readiness: "ready",
          environment: [
            { name: "EMAIL_SMTP_HOST", required: true, present: true },
            { name: "EMAIL_SMTP_PORT", required: false, present: false },
            { name: "EMAIL_SMTP_USER", required: true, present: true },
            { name: "EMAIL_SMTP_PASSWORD", required: true, present: true },
          ],
        })
        // Enabled is not active: Console stays in use until a test is accepted.
        await expect(
          t.query(internal.email.getResolvedSettings, {})
        ).resolves.toEqual({ provider: "console" })

        await expect(
          asOwner.action(api.email.sendTestEmail, {})
        ).resolves.toEqual({ status: "queued", configurationVersion: 2 })
        await t.finishAllScheduledFunctions(() => undefined, 40)

        expect(smtpMock.send).toHaveBeenCalledTimes(1)
        expect(smtpMock.factory).toHaveBeenCalledWith({
          name: "smtp",
          host: "mail.example.test",
          port: 465,
          secure: true,
          requireTLS: false,
          auth: { user: "test-user", pass: "test-password" },
          timeoutMs: 15_000,
          tls: { rejectUnauthorized: true },
        })
        const accepted = await asOwner.query(
          api.email.getEmailProviderSettings,
          {}
        )
        expect(accepted).toMatchObject({
          enabledProviderId: "smtp",
          preselectedProviderId: "smtp",
          activeProviderId: "smtp",
          readiness: "ready",
        })
        expect(accepted.lastTest).toBeUndefined()
        await expect(
          t.query(internal.email.getResolvedSettings, {})
        ).resolves.toMatchObject({
          provider: "smtp",
          fromAddress: "sender@example.test",
        })
        await expect(
          asOwner.mutation(api.email.disableEmailProvider, {
            providerId: "smtp",
          })
        ).resolves.toMatchObject({ status: "disabled" })
        await expect(
          t.query(internal.email.getResolvedSettings, {})
        ).resolves.toEqual({ provider: "console" })
      })
    })

    test("a 535 sign-in reply fails the owner test with sign_in_refused after one attempt", async () => {
      resetSmtpMock()
      smtpMock.send.mockRejectedValue(
        new EmailAdapterError("535 5.7.8 raw server text", {
          adapter: "smtp",
          delivery: "not_sent",
          retryable: false,
          cause: Object.assign(new Error("535 5.7.8 raw server text"), {
            code: "EAUTH",
            responseCode: 535,
            command: "AUTH PLAIN",
          }),
        })
      )
      await withEmailEnv(smtpEnvironment, async () => {
        const t = makeTest()
        const asOwner = await saveSmtp(t)

        await asOwner.action(api.email.sendTestEmail, {})
        await t.finishAllScheduledFunctions(() => undefined, 40)

        expect(smtpMock.send).toHaveBeenCalledTimes(1)
        const settings = await asOwner.query(
          api.email.getEmailProviderSettings,
          {}
        )
        expect(settings.lastTest).toMatchObject({
          providerId: "smtp",
          state: "failed",
          reason: "provider_rejected",
          category: "sign_in_refused",
        })
        expect(JSON.stringify(settings)).not.toContain("raw server text")
        const events = await t.run((ctx) =>
          ctx.db.query("emailDeliveryEvents").collect()
        )
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
          state: "failed",
          failureReason: "provider_rejected",
          failureCategory: "sign_in_refused",
          attempts: 1,
        })
        expect(events[0]?.message).toBeUndefined()
      })
    })

    test("three 451 replies exhaust the retries and keep the category", async () => {
      resetSmtpMock()
      smtpMock.send.mockRejectedValue(
        new EmailAdapterError("451 raw server text", {
          adapter: "smtp",
          delivery: "not_sent",
          retryable: true,
          cause: Object.assign(new Error("451 raw server text"), {
            code: "EENVELOPE",
            responseCode: 451,
            command: "MAIL FROM",
          }),
        })
      )
      vi.useFakeTimers()
      try {
        await withEmailEnv(smtpEnvironment, async () => {
          const t = makeTest()
          const asOwner = await saveSmtp(t)

          await asOwner.action(api.email.sendTestEmail, {})
          await t.finishAllScheduledFunctions(
            () => vi.advanceTimersByTime(5_000),
            100
          )

          expect(smtpMock.send).toHaveBeenCalledTimes(3)
          const settings = await asOwner.query(
            api.email.getEmailProviderSettings,
            {}
          )
          expect(settings.lastTest).toMatchObject({
            providerId: "smtp",
            state: "failed",
            reason: "retry_exhausted",
            category: "sender_refused",
          })
          expect(JSON.stringify(settings)).not.toContain("raw server text")
        })
      } finally {
        vi.useRealTimers()
      }
    })

    test("enabling SMTP while Resend is active turns email off and clears the test", async () => {
      resetSmtpMock()
      await withEmailEnv(
        { ...smtpEnvironment, RESEND_API_KEY: "test-resend-key" },
        async () => {
          const t = makeTest()
          await seedOwner(t)
          const asOwner = t.withIdentity(ownerIdentity)
          const now = Date.now()
          await t.run((ctx) =>
            ctx.db.insert("emailProviderState", {
              key: "owner",
              provider: {
                kind: "active",
                providerId: "resend",
                configuration: {},
              },
              sender: { address: "sender@example.test" },
              configurationVersion: 3,
              lastTest: {
                providerId: "resend",
                configurationVersion: 3,
                state: "queued",
                updatedAt: now,
              },
              updatedAt: now,
            })
          )
          await expect(
            t.query(internal.email.getResolvedSettings, {})
          ).resolves.toMatchObject({ provider: "resend" })

          await expect(
            asOwner.mutation(api.email.enableEmailProvider, {
              providerId: "smtp",
            })
          ).resolves.toEqual({
            enabledProviderId: "smtp",
            configurationVersion: 4,
            status: "inactive",
          })
          const settings = await asOwner.query(
            api.email.getEmailProviderSettings,
            {}
          )
          expect(settings).toMatchObject({
            enabledProviderId: "smtp",
            activeProviderId: null,
            configurationVersion: 4,
          })
          expect(settings.lastTest).toBeUndefined()
          await expect(
            t.query(internal.email.getResolvedSettings, {})
          ).resolves.toEqual({ provider: "console" })
          // Email stays off until SMTP passes its own test, which is not
          // possible before a sender exists in the stored state.
          expect(settings.sender).toEqual({ address: "sender@example.test" })
        }
      )
    })

    test("lists variable names and presence but never values, and preselects SMTP or the configured provider", async () => {
      resetSmtpMock()
      await withEmailEnv(
        {
          EMAIL_SMTP_HOST: "mail.example.test",
          EMAIL_SMTP_PORT: "2525",
          EMAIL_SMTP_USER: "test-user",
          RESEND_API_KEY: "secret-resend-key",
        },
        async () => {
          const t = makeTest()
          await seedOwner(t)
          const asOwner = t.withIdentity(ownerIdentity)

          const fresh = await asOwner.query(
            api.email.getEmailProviderSettings,
            {}
          )
          expect(fresh.preselectedProviderId).toBe("smtp")
          expect(fresh.enabledProviderId).toBeNull()
          const smtpEntry = fresh.catalogue.find(({ id }) => id === "smtp")
          expect(smtpEntry).toMatchObject({
            readiness: "needs_setup",
            environment: [
              { name: "EMAIL_SMTP_HOST", required: true, present: true },
              { name: "EMAIL_SMTP_PORT", required: false, present: true },
              { name: "EMAIL_SMTP_USER", required: true, present: true },
              { name: "EMAIL_SMTP_PASSWORD", required: true, present: false },
            ],
          })
          expect(
            fresh.catalogue.find(({ id }) => id === "resend")
          ).toMatchObject({
            readiness: "ready",
            environment: [
              { name: "RESEND_API_KEY", required: true, present: true },
            ],
          })
          expect(
            fresh.catalogue.find(({ id }) => id === "custom")
          ).not.toHaveProperty("environment")
          for (const value of [
            "mail.example.test",
            "2525",
            "test-user",
            "secret-resend-key",
          ]) {
            expect(JSON.stringify(fresh)).not.toContain(value)
          }

          await asOwner.mutation(api.email.saveEmailProviderConfiguration, {
            senderAddress: "sender@example.test",
          })
          await asOwner.mutation(api.email.enableEmailProvider, {
            providerId: "resend",
          })
          const configured = await asOwner.query(
            api.email.getEmailProviderSettings,
            {}
          )
          expect(configured.preselectedProviderId).toBe("resend")
          expect(configured.enabledProviderId).toBe("resend")
        }
      )
    })
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
        await Promise.all([ctx.db.get("formSubmissions", submissionId), ctx.db.get("emailDeliveryEvents", eventId)])
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
