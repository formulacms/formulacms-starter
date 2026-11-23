/// <reference types="vite/client" />
import { describe, expect, test } from "vitest"
import { api, internal } from "./_generated/api"
import schema from "./schema"
import { convexTest } from "../convexTestWithExplicitAdmin"

const modules = import.meta.glob("./**/*.ts")

/** The one durable Community owner; both identity fields are explicit. */
const ownerIdentity = {
  subject: "owner-1",
  tokenIdentifier: "owner-1",
  name: "Owner",
  email: "owner@example.com",
}

function makeTest() {
  return convexTest({
    schema,
    modules,
  })
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
