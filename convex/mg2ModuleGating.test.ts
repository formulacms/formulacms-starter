/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { makeFunctionReference, type FunctionReference } from "convex/server"
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest"
import { api, internal } from "./_generated/api"
import type { TableNames } from "./_generated/dataModel"
import schema from "./schema"

const readiness = vi.hoisted(() => ({ setup: false }))
vi.mock("./lib/language/multilingual", async (original) => ({
  ...(await original<typeof import("./lib/language/multilingual")>()),
  resolveMultilingualModuleReadiness: () =>
    readiness.setup
      ? { readiness: "needs_setup", setup: "required" }
      : { readiness: "ready", setup: "not_required" },
}))
beforeEach(() => {
  vi.useFakeTimers()
  readiness.setup = false
})
afterEach(() => {
  vi.useRealTimers()
})
const modules = import.meta.glob("./**/*.ts")
const identity = {
  subject: "mg2-owner",
  tokenIdentifier: "https://issuer.test|mg2-owner",
}
const changes = [
  { moduleId: "multilingual", enabled: false },
  { moduleId: "redirects", enabled: false },
]
async function fixture(enabled = false, locales = ["en"], adopted = false) {
  const t = convexTest(schema, modules)
  await t.run(async (ctx) => {
    await ctx.db.insert("cmsOwner", {
      key: "owner",
      authId: identity.subject,
      tokenIdentifier: identity.tokenIdentifier,
      establishedAt: 1,
      updatedAt: 1,
    })
    await ctx.db.insert("pagePublicationCutover", {
      key: "published-snapshot-v1",
      phase: "snapshot_active",
      revision: 1,
      updatedAt: 1,
    })
    await ctx.db.insert("siteSettings", {
      siteName: "MG2",
      siteUrl: "",
      defaultLocale: "en",
      enabledLocales: locales,
      updatedAt: 10,
    })
    await ctx.db.insert("siteLanguageAuthority", {
      key: "site-language-v1",
      mode: adopted ? "multilingual" : "single",
      currentLocale: "en",
      ...(adopted ? { enabledLocales: locales } : {}),
      version: 3,
      updatedAt: 1,
    })
    await ctx.db.insert("cmsModuleState", {
      key: "owner",
      configurationVersion: 4,
      enabledModules: enabled
        ? [
            { moduleId: "multilingual", configVersion: 1 },
            { moduleId: "redirects", configVersion: 1 },
          ]
        : [],
    })
  })
  return { t, owner: t.withIdentity(identity) }
}
async function snapshot(t: Awaited<ReturnType<typeof fixture>>["t"]) {
  return t.run(async (ctx) => {
    const rows = await Promise.all(
      (Object.keys(schema.tables) as TableNames[]).map(async (table) => [
        table,
        await ctx.db.query(table).collect(),
      ])
    )
    return {
      rows,
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }
  })
}
const tokens = {
  expectedSettingsUpdatedAt: 10,
  expectedModuleConfigurationVersion: 4,
  expectedAuthorityVersion: 3,
}
const previewId = "99999siteLanguageImpactPreviews"
const migrationId = "99999siteDefaultLanguageMigrations"
const claim = {
  previewId,
  expectedDigest: "digest",
  expectedCount: { publicPages: 0, routes: 0, manualRules: 0, menus: 0 },
}
export const guardedCalls = [
  ["multilingual:previewAdoption", "query", {}],
  ["multilingual:adoptMultilingualAuthority", "mutation", tokens],
  [
    "multilingual:returnToSingleLanguage",
    "mutation",
    { expectedAuthorityVersion: 3 },
  ],
  [
    "multilingual:addLanguage",
    "mutation",
    {
      locale: "fr",
      expectedAuthorityVersion: 3,
      expectedModuleConfigurationVersion: 4,
    },
  ],
  ["multilingual:removeLanguage", "mutation", claim],
  ["multilingual:needsReviewToAddLanguage", "query", { locale: "fr" }],
  ["multilingual:addSiteLanguage", "mutation", { locale: "fr", ...tokens }],
  [
    "multilingual:prepareLanguageReview",
    "mutation",
    { locale: "fr", ...tokens },
  ],
  ["multilingual:prepareLanguageChange", "mutation", tokens],
  ["multilingual:removeLastExtraLanguage", "mutation", claim],
  [
    "multilingual:startLanguageImpactPreview",
    "mutation",
    { kind: "remove", locale: "fr" },
  ],
  ["multilingual:listLanguageImpact", "query", { previewId, ordinal: 0 }],
  [
    "multilingual:recordLanguageImpactReview",
    "mutation",
    { previewId, ordinal: 0, pageDigest: "digest" },
  ],
  [
    "multilingual:startDefaultLanguageMigration",
    "mutation",
    {
      toLocale: "fr",
      expectedAuthorityVersion: 3,
      expectedModuleConfigurationVersion: 4,
    },
  ],
  [
    "multilingual:setDefaultLanguage",
    "mutation",
    {
      toLocale: "fr",
      expectedAuthorityVersion: 3,
      expectedModuleConfigurationVersion: 4,
    },
  ],
  [
    "multilingual:continueDefaultLanguageMigration",
    "mutation",
    { migrationId, expectedGeneration: 1 },
  ],
  [
    "multilingual:listDefaultLanguageRoutes",
    "query",
    {
      migrationId,
      generation: 1,
      filter: "all",
      paginationOpts: { cursor: null, numItems: 10 },
    },
  ],
  [
    "multilingual:listDefaultMigrationDisclosure",
    "query",
    { migrationId, generation: 1, ordinal: 0 },
  ],
  [
    "multilingual:recordDefaultMigrationReview",
    "mutation",
    { migrationId, expectedGeneration: 1, ordinal: 0, pageDigest: "digest" },
  ],
  [
    "multilingual:activateDefaultLanguageMigration",
    "mutation",
    {
      migrationId,
      expectedGeneration: 1,
      expectedReadinessVersion: 1,
      expectedAuthorityVersion: 3,
    },
  ],
  [
    "multilingual:cancelDefaultLanguageMigration",
    "mutation",
    { migrationId, expectedGeneration: 1 },
  ],
  ["redirects:list", "query", {}],
  [
    "redirects:listPaginated",
    "query",
    { paginationOpts: { cursor: null, numItems: 10 } },
  ],
  [
    "redirects:create",
    "mutation",
    { fromPath: "/before", toPath: "/after", statusCode: 301 },
  ],
  ["redirects:remove", "mutation", { id: "99999redirects" }],
] as const

describe("MG2 C6 behavior", () => {
  test.each(guardedCalls)(
    "off refuses %s before domain work",
    async (name, kind, args) => {
      const { t, owner } = await fixture()
      const before = await snapshot(t)
      const reference = makeFunctionReference<"query" | "mutation">(
        `cms/${name}`
      )
      await expect(
        kind === "query"
          ? owner.query(reference as FunctionReference<"query">, args)
          : owner.mutation(reference as FunctionReference<"mutation">, args)
      ).rejects.toThrow("CMS_MODULE_DISABLED")
      expect(await snapshot(t)).toEqual(before)
    }
  )
  test.each([false, true])(
    "scheduled scans do nothing when unavailable, needs setup=%s",
    async (setup) => {
      const { t } = await fixture(setup)
      readiness.setup = setup
      try {
        const before = await snapshot(t)
        await t.mutation(internal.cms.multilingual.stepLanguageImpactPreview, {
          previewId: previewId as never,
          generation: 1,
        })
        await t.mutation(
          internal.cms.multilingual.stepDefaultLanguageMigration,
          { migrationId: migrationId as never, generation: 1 }
        )
        expect(await snapshot(t)).toEqual(before)
      } finally {
        readiness.setup = false
      }
    }
  )
  test("setup remains reachable when enabled but not ready", async () => {
    const { t, owner } = await fixture(true)
    readiness.setup = true
    try {
      expect(
        await owner.query(api.cms.multilingual.previewAdoption, {})
      ).toMatchObject({ canAdopt: true })
      await owner.mutation(
        api.cms.multilingual.adoptMultilingualAuthority,
        tokens
      )
      await owner.mutation(api.cms.multilingual.returnToSingleLanguage, {
        expectedAuthorityVersion: 4,
      })
      expect(
        await t.run((ctx) => ctx.db.query("siteLanguageAuthority").unique())
      ).toMatchObject({ mode: "single", version: 5 })
    } finally {
      readiness.setup = false
    }
  })
  test("core Languages read works off", async () => {
    const { owner } = await fixture()
    expect(
      await owner.query(api.cms.multilingual.getMultilingualState, {})
    ).toMatchObject({ moduleEnabled: false, enabledLocales: ["en"] })
  })
})

describe("MG2 exact atomic Apply", () => {
  test("one adopted locale returns and both flags change together", async () => {
    const { t, owner } = await fixture(true, ["en"], true)
    const preview = await owner.query(api.cms.modules.preview, { changes })
    expect(preview.blockers).toEqual([])
    expect(preview).toMatchObject({
      multilingualCommandTokens: {
        settingsUpdatedAt: 10,
        moduleConfigurationVersion: 4,
        authorityVersion: 3,
      },
    })
    const result = await owner.mutation(api.cms.modules.commit, {
      expectedConfigurationVersion: 4,
      changes,
      multilingualCommandTokens: (
        preview as unknown as {
          multilingualCommandTokens: {
            settingsUpdatedAt: number
            moduleConfigurationVersion: number
            authorityVersion: number
          }
        }
      ).multilingualCommandTokens,
    } as never)
    expect(result).toMatchObject({ committed: true, configurationVersion: 5 })
    expect(
      await t.run((ctx) => ctx.db.query("cmsModuleState").unique())
    ).toMatchObject({ configurationVersion: 5, enabledModules: [] })
    expect(
      await t.run((ctx) => ctx.db.query("siteLanguageAuthority").unique())
    ).toMatchObject({ mode: "single", version: 4 })
    expect(
      await t.run((ctx) =>
        ctx.db.query("siteLanguageLifecycleIntents").collect()
      )
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operationId: "return_to_single:v4" }),
        expect.objectContaining({ operationId: "module_toggle:c5" }),
      ])
    )
  })
  test.each([
    "two locales",
    "saved redirects",
    "stale config",
    "stale authority",
    "stale settings",
    "integrity",
  ])("%s refuses without any write", async (scenario) => {
    const { t, owner } = await fixture(
      true,
      scenario === "two locales" ? ["en", "fr"] : ["en"],
      true
    )
    const preview = await owner.query(api.cms.modules.preview, { changes })
    if (scenario === "saved redirects")
      await t.run((ctx) =>
        ctx.db.insert("redirects", {
          fromPath: "/old",
          toPath: "/new",
          statusCode: 301,
          createdAt: 1,
          updatedAt: 1,
          origin: "manual",
        })
      )
    if (scenario === "stale authority")
      await t.run(async (ctx) => {
        const row = (await ctx.db.query("siteLanguageAuthority").unique())!
        await ctx.db.patch("siteLanguageAuthority", row._id, { version: 4 })
      })
    if (scenario === "stale settings")
      await t.run(async (ctx) => {
        const row = (await ctx.db.query("siteSettings").unique())!
        await ctx.db.patch("siteSettings", row._id, { updatedAt: 11 })
      })
    if (scenario === "integrity")
      await t.run((ctx) =>
        ctx.db.insert("siteLanguageAuthority", {
          key: "site-language-v1",
          mode: "single",
          currentLocale: "en",
          version: 3,
          updatedAt: 1,
        })
      )
    const before = await snapshot(t)
    const code =
      scenario === "stale config"
        ? "CMS_MODULE_CONFIGURATION_STALE"
        : scenario === "stale authority" || scenario === "stale settings"
          ? "LANGUAGE_OPERATION_STALE"
          : scenario === "integrity"
            ? "SITE_LANGUAGE_AUTHORITY_INVALID"
            : "CMS_MODULE_TRANSITION_BLOCKED"
    await expect(
      owner.mutation(api.cms.modules.commit, {
        expectedConfigurationVersion: scenario === "stale config" ? 3 : 4,
        changes,
        multilingualCommandTokens: (
          preview as unknown as { multilingualCommandTokens: unknown }
        ).multilingualCommandTokens,
      } as never)
    ).rejects.toThrow(code)
    expect(await snapshot(t)).toEqual(before)
    if (scenario === "two locales")
      expect(preview.blockers).toContainEqual({
        code: "MULTILINGUAL_AUTHORITY_ACTIVE",
        moduleId: "multilingual",
        locales: ["en", "fr"],
      })
  })
})

describe("MG2 preview agreement and transactional seams", () => {
  test.each([
    "one adopted locale",
    "two adopted locales",
    "saved redirects",
    "unadopted disable",
  ])("preview agrees with Apply: %s", async (scenario) => {
    const { t, owner } = await fixture(
      true,
      scenario === "two adopted locales" ? ["en", "fr"] : ["en"],
      scenario !== "unadopted disable"
    )
    if (scenario === "saved redirects")
      await t.run((ctx) =>
        ctx.db.insert("redirects", {
          fromPath: "/old",
          toPath: "/new",
          statusCode: 301,
          createdAt: 1,
          updatedAt: 1,
          origin: "manual",
        })
      )
    const preview = await owner.query(api.cms.modules.preview, { changes })
    const blocked =
      scenario === "two adopted locales" || scenario === "saved redirects"
    expect(preview.blockers.length > 0).toBe(blocked)
    const before = await snapshot(t)
    const apply = owner.mutation(api.cms.modules.commit, {
      expectedConfigurationVersion: 4,
      changes,
      multilingualCommandTokens: preview.multilingualCommandTokens,
    })
    if (blocked) {
      await expect(apply).rejects.toThrow("CMS_MODULE_TRANSITION_BLOCKED")
      expect(await snapshot(t)).toEqual(before)
    } else
      expect(await apply).toMatchObject({
        committed: true,
        configurationVersion: 5,
      })
  })
  test("enable writes flags only and never adopts authority", async () => {
    const { t, owner } = await fixture()
    const authority = await t.run((ctx) =>
      ctx.db.query("siteLanguageAuthority").unique()
    )
    const settings = await t.run((ctx) => ctx.db.query("siteSettings").unique())
    const enable = [{ moduleId: "multilingual", enabled: true }]
    const preview = await owner.query(api.cms.modules.preview, {
      changes: enable,
    })
    expect(preview.blockers).toEqual([])
    expect(preview.multilingualCommandTokens).toBeNull()
    await owner.mutation(api.cms.modules.commit, {
      expectedConfigurationVersion: 4,
      changes: enable,
    })
    expect(
      await t.run((ctx) => ctx.db.query("siteLanguageAuthority").unique())
    ).toEqual(authority)
    expect(await t.run((ctx) => ctx.db.query("siteSettings").unique())).toEqual(
      settings
    )
  })
  test("open default migration blocks preview and Apply without writes", async () => {
    const { t, owner } = await fixture(true, ["en", "fr"], true)
    await owner.mutation(api.cms.multilingual.startDefaultLanguageMigration, {
      toLocale: "fr",
      expectedAuthorityVersion: 3,
      expectedModuleConfigurationVersion: 4,
    })
    const preview = await owner.query(api.cms.modules.preview, { changes })
    expect(preview.blockers).toContainEqual({
      code: "LANGUAGE_OPERATION_OPEN",
      moduleId: "multilingual",
      kind: "default_migration",
    })
    const before = await snapshot(t)
    await expect(
      owner.mutation(api.cms.modules.commit, {
        expectedConfigurationVersion: 4,
        changes,
        multilingualCommandTokens: preview.multilingualCommandTokens,
      })
    ).rejects.toThrow("CMS_MODULE_TRANSITION_BLOCKED")
    expect(await snapshot(t)).toEqual(before)
  })
  test("late flag-writer refusal rolls back the preceding return and its intent", async () => {
    const { t, owner } = await fixture(true, ["en"], true)
    await t.run((ctx) =>
      ctx.db.insert("siteLanguageLifecycleIntents", {
        operationId: "module_toggle:c5",
        operationKind: "module_toggle",
        locales: ["en"],
        capturedAuthorityVersion: 3,
        phase: "tags_and_layout",
        status: "pending",
        attempts: 0,
        createdAt: 1,
        updatedAt: 1,
      })
    )
    const preview = await owner.query(api.cms.modules.preview, { changes })
    const before = await snapshot(t)
    await expect(
      owner.mutation(api.cms.modules.commit, {
        expectedConfigurationVersion: 4,
        changes,
        multilingualCommandTokens: preview.multilingualCommandTokens,
      })
    ).rejects.toThrow("LANGUAGE_LIFECYCLE_INTENT_DUPLICATE")
    expect(await snapshot(t)).toEqual(before)
  })
  test("missing authority token refuses the required return without writes", async () => {
    const { t, owner } = await fixture(true, ["en"], true)
    const before = await snapshot(t)
    await expect(
      owner.mutation(api.cms.modules.commit, {
        expectedConfigurationVersion: 4,
        changes,
      })
    ).rejects.toThrow("LANGUAGE_OPERATION_STALE")
    expect(await snapshot(t)).toEqual(before)
  })
  test.each(["impact", "migration"] as const)(
    "admitted %s step re-gates before writes/scheduling",
    async (kind) => {
      const { t, owner } = await fixture(true, ["en", "fr"], true)
      const id =
        kind === "impact"
          ? (
              await owner.mutation(
                api.cms.multilingual.startLanguageImpactPreview,
                { kind: "remove", locale: "fr" }
              )
            ).previewId
          : (
              await owner.mutation(
                api.cms.multilingual.startDefaultLanguageMigration,
                {
                  toLocale: "fr",
                  expectedAuthorityVersion: 3,
                  expectedModuleConfigurationVersion: 4,
                }
              )
            ).migrationId
      await t.run(async (ctx) => {
        const state = (await ctx.db.query("cmsModuleState").unique())!
        await ctx.db.patch("cmsModuleState", state._id, { enabledModules: [] })
      })
      const before = await snapshot(t)
      if (kind === "impact")
        await t.mutation(internal.cms.multilingual.stepLanguageImpactPreview, {
          previewId: id as never,
          generation: 1,
        })
      else
        await t.mutation(
          internal.cms.multilingual.stepDefaultLanguageMigration,
          { migrationId: id as never, generation: 1 }
        )
      expect(await snapshot(t)).toEqual(before)
    }
  )
})

test.each(["impact", "migration"] as const)(
  "admitted ready %s worker is withheld by readiness before writes",
  async (kind) => {
    const { t, owner } = await fixture(true, ["en", "fr"], true)
    const id =
      kind === "impact"
        ? (
            await owner.mutation(
              api.cms.multilingual.startLanguageImpactPreview,
              { kind: "remove", locale: "fr" }
            )
          ).previewId
        : (
            await owner.mutation(
              api.cms.multilingual.startDefaultLanguageMigration,
              {
                toLocale: "fr",
                expectedAuthorityVersion: 3,
                expectedModuleConfigurationVersion: 4,
              }
            )
          ).migrationId
    readiness.setup = true
    const before = await snapshot(t)
    if (kind === "impact")
      await t.mutation(internal.cms.multilingual.stepLanguageImpactPreview, {
        previewId: id as never,
        generation: 1,
      })
    else
      await t.mutation(internal.cms.multilingual.stepDefaultLanguageMigration, {
        migrationId: id as never,
        generation: 1,
      })
    expect(await snapshot(t)).toEqual(before)
  }
)
