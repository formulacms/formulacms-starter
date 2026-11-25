/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
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

describe("site URL validation", () => {
  const bootstrapArgs = {
    siteName: "Site address check",
    timezone: "UTC",
    defaultLocale: "en",
  }
  const originalSettings = {
    siteName: "Original site",
    siteUrl: "https://original.example.com",
    timezone: "UTC",
    dateFormat: "PP",
    defaultLocale: "en",
    enabledLocales: ["en"],
    updatedAt: 1,
  }
  const invalidSiteUrls = [
    "https:example.com",
    "https:/example.com",
    "http:example.com",
    "http//127.0.0.1:3000",
    "127.0.0.1:3000",
    "ftp://x.test",
    "https://",
    " ",
  ]
  const acceptedSiteUrls = [
    { input: "https://example.com/", stored: "https://example.com" },
    { input: "http://127.0.0.1:3000", stored: "http://127.0.0.1:3000" },
    { input: "  https://example.com/  ", stored: "https://example.com" },
    { input: "https://example.com///", stored: "https://example.com//" },
    { input: "", stored: "" },
  ]

  // Accepted writes schedule revalidation, which is outside this suite.
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function makeSettingsTest() {
    const t = convexTest({ schema, modules, ownerIdentity })
    await t.run(async (ctx) => {
      await ctx.db.insert("siteSettings", originalSettings)
    })
    return t
  }

  async function readSettingsRows(t: ReturnType<typeof makeTest>) {
    return await t.run(async (ctx) => {
      return await ctx.db.query("siteSettings").take(2)
    })
  }

  test.each(invalidSiteUrls)(
    "updateSettings refuses %s without changing settings",
    async (siteUrl) => {
      const t = await makeSettingsTest()
      const before = await readSettingsRows(t)
      expect(before).toHaveLength(1)

      await expect(
        t.withIdentity(ownerIdentity).mutation(api.cms.settings.updateSettings, {
          siteName: "Must not persist",
          siteUrl,
        })
      ).rejects.toMatchObject({ data: { code: "SITE_URL_INVALID" } })
      await expect(readSettingsRows(t)).resolves.toEqual(before)
    }
  )

  test.each(acceptedSiteUrls)(
    "updateSettings accepts site URL $input",
    async ({ input, stored }) => {
      const t = await makeSettingsTest()

      await t
        .withIdentity(ownerIdentity)
        .mutation(api.cms.settings.updateSettings, { siteUrl: input })

      await expect(readSettingsRows(t)).resolves.toMatchObject([
        { siteUrl: stored },
      ])
    }
  )

  test("updateSettings leaves an omitted site URL unchanged", async () => {
    const t = await makeSettingsTest()

    await t
      .withIdentity(ownerIdentity)
      .mutation(api.cms.settings.updateSettings, { siteName: "Renamed" })

    await expect(readSettingsRows(t)).resolves.toMatchObject([
      { siteName: "Renamed", siteUrl: originalSettings.siteUrl },
    ])
  })

  test.each(invalidSiteUrls)(
    "bootstrapInstallation refuses %s without writing",
    async (siteUrl) => {
      const t = makeBootstrapTest()

      await expect(
        t
          .withIdentity(ownerIdentity)
          .mutation(api.cms.settings.bootstrapInstallation, {
            ...bootstrapArgs,
            siteUrl,
          })
      ).rejects.toMatchObject({ data: { code: "SITE_URL_INVALID" } })
      await expect(
        t.run(async (ctx) => ({
          settings: await ctx.db.query("siteSettings").take(1),
          pages: await ctx.db.query("pages").take(1),
          publication: await ctx.db.query("pagePublicationCutover").take(1),
          language: await ctx.db.query("siteLanguageAuthority").take(1),
        }))
      ).resolves.toEqual({
        settings: [],
        pages: [],
        publication: [],
        language: [],
      })
    }
  )

  test.each([...acceptedSiteUrls, { input: undefined, stored: "" }])(
    "bootstrapInstallation accepts site URL $input",
    async ({ input, stored }) => {
      const t = makeBootstrapTest()

      await expect(
        t
          .withIdentity(ownerIdentity)
          .mutation(api.cms.settings.bootstrapInstallation, {
            ...bootstrapArgs,
            ...(input !== undefined && { siteUrl: input }),
          })
      ).resolves.toMatchObject({ phase: "snapshot_active" })
      await expect(readSettingsRows(t)).resolves.toMatchObject([
        { siteUrl: stored },
      ])
    }
  )
})
