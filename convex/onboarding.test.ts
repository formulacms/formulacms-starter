/// <reference types="vite/client" />
import { describe, expect, test } from "vitest"
import { api, internal } from "./_generated/api"
import schema from "./schema"
import { convexTest, seedCommunityOwner } from "../convexTestWithExplicitAdmin"

const modules = import.meta.glob("./**/*.ts")

/** The one durable Community owner; both identity fields are explicit. */
const ownerIdentity = {
  subject: "owner-1",
  tokenIdentifier: "https://convex.test|owner-1",
  name: "Owner",
  email: "owner@example.com",
}

const ONBOARDING_STEPS = ["account", "identity", "locales", "ai"] as const

function makeTest() {
  return convexTest(schema, modules)
}

async function makeOwnerTest() {
  const t = makeTest()
  await seedCommunityOwner(t, ownerIdentity)
  return t
}

function makeBootstrapTest() {
  return convexTest({
    schema,
    modules,
    ownerIdentity,
    publicationAuthority: "missing",
  })
}

describe("onboarding progress bookmarks", () => {
  test("reports all steps incomplete before onboarding starts", async () => {
    const t = makeTest()

    await expect(
      t.query(api.cms.settings.getOnboardingProgress, {})
    ).resolves.toEqual({
      account: false,
      identity: false,
      locales: false,
      ai: false,
      finished: false,
    })
  })

  test("marks steps idempotently and exposes resumable progress", async () => {
    const t = await makeOwnerTest()
    const asOwner = t.withIdentity(ownerIdentity)

    await asOwner.mutation(api.cms.settings.markOnboardingStep, {
      step: "account",
    })
    const first = await t.run((ctx) => ctx.db.query("siteSettings").first())
    expect(first?.onboardingAccountAt).toEqual(expect.any(Number))

    await asOwner.mutation(api.cms.settings.markOnboardingStep, {
      step: "account",
    })
    const second = await t.run((ctx) => ctx.db.query("siteSettings").first())
    expect(second?._id).toBe(first?._id)
    expect(second?.onboardingAccountAt).toBe(first?.onboardingAccountAt)

    await expect(
      t.query(api.cms.settings.getOnboardingProgress, {})
    ).resolves.toMatchObject({
      account: true,
      identity: false,
      locales: false,
      ai: false,
      finished: false,
    })
  })

  test("rejects finish when any started bookmark is missing", async () => {
    const t = await makeOwnerTest()
    const asOwner = t.withIdentity(ownerIdentity)

    await asOwner.mutation(api.cms.settings.markOnboardingStep, {
      step: "account",
    })

    await expect(
      asOwner.mutation(api.cms.settings.completeOnboarding, {
        siteName: "Studio",
        timezone: "UTC",
        defaultLocale: "en",
        enabledLocales: ["en"],
      })
    ).rejects.toThrow("ONBOARDING_INCOMPLETE")
  })

  test("rejects the retired email bookmark", async () => {
    const t = await makeOwnerTest()
    const asOwner = t.withIdentity(ownerIdentity)

    await expect(
      asOwner.mutation(api.cms.settings.markOnboardingStep, {
        step: "email",
      } as never)
    ).rejects.toThrow()
  })

  test("completes without an email bookmark and remembers skipped AI", async () => {
    const t = await makeOwnerTest()
    const asOwner = t.withIdentity(ownerIdentity)

    for (const step of ONBOARDING_STEPS) {
      await asOwner.mutation(api.cms.settings.markOnboardingStep, { step })
    }

    await expect(
      t.query(api.cms.settings.getOnboardingProgress, {})
    ).resolves.toMatchObject({
      ai: true,
      finished: false,
    })

    await asOwner.mutation(api.cms.settings.completeOnboarding, {
      siteName: "Studio",
      timezone: "UTC",
      defaultLocale: "en",
      enabledLocales: ["en"],
    })

    const settings = await t.run((ctx) => ctx.db.query("siteSettings").first())
    expect(settings?.onboardingEmailAt).toBeUndefined()
    expect(settings?.onboardingAiAt).toEqual(expect.any(Number))
    expect(settings?.onboardingCompletedAt).toEqual(expect.any(Number))
    expect(settings?.aiProvider).toBeUndefined()
    expect(settings?.aiDefaultModel).toBeUndefined()
  })
})

describe("Console-only setup", () => {
  const bootstrapArgs = {
    siteName: "Console-only site",
    timezone: "UTC",
    defaultLocale: "en",
  }

  test("fresh and exact-resume bootstrap leave email state absent", async () => {
    const t = makeBootstrapTest()
    const asOwner = t.withIdentity(ownerIdentity)

    const first = await asOwner.mutation(
      api.cms.settings.bootstrapInstallation,
      bootstrapArgs
    )
    await expectEmailStateAbsent(t)
    await expect(
      t.query(internal.email.getResolvedSettings, {})
    ).resolves.toEqual({ provider: "console" })

    await expect(
      asOwner.mutation(api.cms.settings.bootstrapInstallation, bootstrapArgs)
    ).resolves.toEqual(first)
    await expectEmailStateAbsent(t)
    await expect(
      t.query(internal.email.getResolvedSettings, {})
    ).resolves.toEqual({ provider: "console" })
  })

  test("bootstrap is independent of legacy or successor email rows", async () => {
    const t = makeBootstrapTest()
    const asOwner = t.withIdentity(ownerIdentity)

    await t.run(async (ctx) => {
      for (const updatedAt of [1, 2]) {
        await ctx.db.insert("emailSettings", {
          provider: "console",
          schemaVersion: 1,
          updatedAt,
        })
        await ctx.db.insert("emailProviderState", {
          key: "owner",
          provider: { kind: "fallback" },
          configurationVersion: 0,
          updatedAt,
        })
      }
    })

    await expect(
      asOwner.mutation(api.cms.settings.bootstrapInstallation, bootstrapArgs)
    ).resolves.toMatchObject({ phase: "snapshot_active" })
    await expect(emailRowCounts(t)).resolves.toEqual({
      legacy: 2,
      successor: 2,
    })
  })
})

async function emailRowCounts(t: ReturnType<typeof makeTest>) {
  return await t.run(async (ctx) => ({
    legacy: (await ctx.db.query("emailSettings").take(3)).length,
    successor: (await ctx.db.query("emailProviderState").take(3)).length,
  }))
}

async function expectEmailStateAbsent(t: ReturnType<typeof makeTest>) {
  await expect(emailRowCounts(t)).resolves.toEqual({ legacy: 0, successor: 0 })
}
