/// <reference types="vite/client" />

import { describe, expect, test } from "vitest"
import { api } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { convexTest } from "../convexTestWithExplicitAdmin"
import { enableRedirectsForTest } from "../redirectsTestHelpers"
import { resolveModuleGuardState } from "./lib/modules/state"
import schema from "./schema"

// M01b: the Redirects module guard (recovery design RG6, RG7, RG9; M01b-P1–P7).
// Behavior is driven through the registered `cms.redirects`, `cms.modules`,
// `cms.publication` and `cms.pages` entry points. Direct writes only seed rows
// or corrupt state that no entry point can produce.
const modules = import.meta.glob("./**/*.ts")

const OWNER = {
  subject: "m01b-owner",
  tokenIdentifier: "https://convex.test|m01b-owner",
  email: "m01b-owner@example.com",
}
const UNRELATED = {
  subject: "m01b-unrelated",
  tokenIdentifier: "https://convex.test|m01b-unrelated",
  email: "m01b-unrelated@example.com",
}

function app(publicationAuthority?: "missing") {
  return convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
    ...(publicationAuthority ? { publicationAuthority } : {}),
  })
}

type App = ReturnType<typeof app>
type Caller = ReturnType<App["withIdentity"]>

function privateCalls(caller: Caller, ruleId: Id<"redirects">) {
  return {
    list: () => caller.query(api.cms.redirects.list, {}),
    listPaginated: () =>
      caller.query(api.cms.redirects.listPaginated, {
        paginationOpts: { numItems: 10, cursor: null },
      }),
    create: () =>
      caller.mutation(api.cms.redirects.create, {
        fromPath: "/guarded-create",
        toPath: "/guarded-target",
        statusCode: 301,
      }),
    remove: () => caller.mutation(api.cms.redirects.remove, { id: ruleId }),
  }
}

async function expectEveryPrivateEntryRejects(
  caller: Caller,
  ruleId: Id<"redirects">,
  code: string
) {
  for (const [name, call] of Object.entries(privateCalls(caller, ruleId))) {
    await expect(call(), name).rejects.toThrow(code)
  }
}

async function seedRule(
  t: App,
  row: {
    fromPath: string
    toPath: string
    locale?: string
    statusCode: 301 | 302
    origin?: "manual"
  }
): Promise<Id<"redirects">> {
  return await t.run((ctx) => {
    const now = Date.now()
    return ctx.db.insert("redirects", {
      ...row,
      createdAt: now,
      updatedAt: now,
    })
  })
}

function redirectRows(t: App) {
  return t.run((ctx) => ctx.db.query("redirects").collect())
}

function redirectsGuard(t: App) {
  return t.run((ctx) => resolveModuleGuardState(ctx, "redirects"))
}

describe("M01b Redirects private entries", () => {
  test("P1: a fresh install rejects the owner with CMS_MODULE_DISABLED; non-owners get owner denial in either state", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const unrelated = t.withIdentity(UNRELATED)
    const ruleId = await seedRule(t, {
      fromPath: "/p1-seeded",
      toPath: "/p1-target",
      statusCode: 301,
      origin: "manual",
    })
    const before = await redirectRows(t)

    await expect(redirectsGuard(t)).resolves.toMatchObject({ effective: false })
    await expectEveryPrivateEntryRejects(owner, ruleId, "CMS_MODULE_DISABLED")
    expect(await redirectRows(t)).toEqual(before)

    await expectEveryPrivateEntryRejects(
      unrelated,
      ruleId,
      "CMS_OWNER_REQUIRED"
    )
    await expectEveryPrivateEntryRejects(t, ruleId, "UNAUTHENTICATED")

    await enableRedirectsForTest(owner)
    await expectEveryPrivateEntryRejects(
      unrelated,
      ruleId,
      "CMS_OWNER_REQUIRED"
    )
    await expectEveryPrivateEntryRejects(t, ruleId, "UNAUTHENTICATED")
    expect(await redirectRows(t)).toEqual(before)
  })

  test("P2: a real F07 enable opens the private entries, and a disable with no rules closes them again", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)

    await enableRedirectsForTest(owner)
    const id = await owner.mutation(api.cms.redirects.create, {
      fromPath: "/p2-old",
      toPath: "/p2-new",
      statusCode: 301,
    })
    expect(
      (await owner.query(api.cms.redirects.list, {})).map((row) => row._id)
    ).toEqual([id])
    const paginated = await owner.query(api.cms.redirects.listPaginated, {
      paginationOpts: { numItems: 10, cursor: null },
    })
    expect(paginated.page.map((row) => row._id)).toEqual([id])
    await expect(
      owner.mutation(api.cms.redirects.remove, { id })
    ).resolves.toBeNull()
    await expect(owner.query(api.cms.redirects.list, {})).resolves.toEqual([])

    await expect(
      owner.mutation(api.cms.modules.commit, {
        expectedConfigurationVersion: 1,
        changes: [{ moduleId: "redirects", enabled: false }],
      })
    ).resolves.toMatchObject({ committed: true, configurationVersion: 2 })
    await expect(redirectsGuard(t)).resolves.toMatchObject({ effective: false })

    const probeId = await seedRule(t, {
      fromPath: "/p2-probe",
      toPath: "/p2-probe-target",
      statusCode: 302,
    })
    const before = await redirectRows(t)
    await expectEveryPrivateEntryRejects(owner, probeId, "CMS_MODULE_DISABLED")
    expect(await redirectRows(t)).toEqual(before)
  })
})

describe("M01b Redirects public entries", () => {
  test("P3: while disabled, resolve returns null and listActiveKeys returns [] whatever rows the table holds", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    // Manual, pre-provenance, and a locale-scoped retired-slug shape: the skip
    // must not depend on provenance or path shape.
    await seedRule(t, {
      fromPath: "/p3-manual",
      toPath: "/p3-target",
      statusCode: 301,
      origin: "manual",
    })
    await seedRule(t, {
      fromPath: "/p3-unresolved",
      toPath: "https://example.com/p3",
      statusCode: 302,
    })
    await seedRule(t, {
      fromPath: "/p3-old-slug",
      toPath: "/p3-new-slug",
      locale: "en",
      statusCode: 301,
    })

    for (const args of [
      { path: "/p3-manual", languageVersion: 0 },
      { path: "/p3-unresolved", languageVersion: 0 },
      { path: "/p3-old-slug", locale: "en", languageVersion: 0 },
      { path: "/p3-manual", locale: "en", languageVersion: 0 },
    ]) {
      await expect(
        t.query(api.cms.redirects.resolve, args),
        JSON.stringify(args)
      ).resolves.toBeNull()
    }
    await expect(
      t.query(api.cms.redirects.listActiveKeys, { languageVersion: 0 })
    ).resolves.toEqual([])
    expect(await redirectRows(t)).toHaveLength(3)

    // The same rows serve once enabled, so the withheld results above came
    // from module state and not from a missing match.
    await enableRedirectsForTest(owner)
    await expect(
      t.query(api.cms.redirects.resolve, {
        languageVersion: 0,
        path: "/p3-manual",
      })
    ).resolves.toEqual({ destination: "/p3-target", statusCode: 301 })
    await expect(
      t.query(api.cms.redirects.resolve, {
        languageVersion: 0,
        path: "/p3-unresolved",
      })
    ).resolves.toEqual({
      destination: "https://example.com/p3",
      statusCode: 302,
    })
    await expect(
      t.query(api.cms.redirects.resolve, {
        languageVersion: 0,
        path: "/p3-old-slug",
        locale: "en",
      })
    ).resolves.toEqual({ destination: "/p3-new-slug", statusCode: 301 })
    expect(
      await t.query(api.cms.redirects.listActiveKeys, { languageVersion: 0 })
    ).toHaveLength(3)
  })

  test.each([
    {
      name: "duplicate owner rows",
      corrupt: async (t: App) => {
        await t.run(async (ctx) => {
          await ctx.db.insert("cmsModuleState", {
            key: "owner",
            configurationVersion: 5,
            enabledModules: [{ moduleId: "redirects", configVersion: 1 }],
          })
        })
      },
    },
    {
      name: "an unsupported config version",
      corrupt: async (t: App) => {
        await t.run(async (ctx) => {
          const row = await ctx.db.query("cmsModuleState").unique()
          await ctx.db.patch(row!._id, {
            enabledModules: [{ moduleId: "redirects", configVersion: 999 }],
          })
        })
      },
    },
    {
      name: "an unknown module ID",
      corrupt: async (t: App) => {
        await t.run(async (ctx) => {
          const row = await ctx.db.query("cmsModuleState").unique()
          await ctx.db.patch(row!._id, {
            enabledModules: [
              { moduleId: "redirects", configVersion: 1 },
              { moduleId: "not-a-module", configVersion: 1 },
            ],
          })
        })
      },
    },
  ])(
    "P4: invalid module state ($name) throws CMS_MODULE_STATE_INVALID instead of null, [] or disabled",
    async ({ corrupt }) => {
      const t = app()
      const owner = t.withIdentity(OWNER)
      const unrelated = t.withIdentity(UNRELATED)
      await enableRedirectsForTest(owner)
      const ruleId = await owner.mutation(api.cms.redirects.create, {
        fromPath: "/p4-old",
        toPath: "/p4-new",
        statusCode: 301,
      })
      await expect(
        t.query(api.cms.redirects.resolve, {
          languageVersion: 0,
          path: "/p4-old",
        })
      ).resolves.toEqual({ destination: "/p4-new", statusCode: 301 })

      await corrupt(t)
      const before = await redirectRows(t)

      await expect(
        t.query(api.cms.redirects.resolve, {
          languageVersion: 0,
          path: "/p4-old",
        })
      ).rejects.toThrow("CMS_MODULE_STATE_INVALID")
      await expect(
        t.query(api.cms.redirects.resolve, {
          languageVersion: 0,
          path: "/p4-missing",
        })
      ).rejects.toThrow("CMS_MODULE_STATE_INVALID")
      await expect(
        t.query(api.cms.redirects.listActiveKeys, { languageVersion: 0 })
      ).rejects.toThrow("CMS_MODULE_STATE_INVALID")

      // Owner first, then state (RG7).
      await expectEveryPrivateEntryRejects(
        owner,
        ruleId,
        "CMS_MODULE_STATE_INVALID"
      )
      await expectEveryPrivateEntryRejects(
        unrelated,
        ruleId,
        "CMS_OWNER_REQUIRED"
      )
      await expectEveryPrivateEntryRejects(t, ruleId, "UNAUTHENTICATED")
      expect(await redirectRows(t)).toEqual(before)
    }
  )

  test("P5: duplicate Email settings do not fail the enabled Redirects entries", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await enableRedirectsForTest(owner)
    const id = await owner.mutation(api.cms.redirects.create, {
      fromPath: "/p5-old",
      toPath: "/p5-new",
      statusCode: 302,
    })
    await t.run(async (ctx) => {
      await ctx.db.insert("emailSettings", {
        provider: "console",
        schemaVersion: 1,
        updatedAt: 1,
      })
      await ctx.db.insert("emailSettings", {
        provider: "console",
        schemaVersion: 1,
        updatedAt: 2,
      })
    })

    // The broad resolver really fails here (counterexample C3 is live).
    await expect(
      owner.query(api.cms.modules.preview, { changes: [] })
    ).rejects.toThrow("CMS_EMAIL_PROVIDER_MIGRATION_SOURCE_INVALID")

    await expect(
      t.query(api.cms.redirects.resolve, {
        languageVersion: 0,
        path: "/p5-old",
      })
    ).resolves.toEqual({ destination: "/p5-new", statusCode: 302 })
    const listed = await owner.query(api.cms.redirects.listPaginated, {
      paginationOpts: { numItems: 10, cursor: null },
    })
    expect(listed.page.map((row) => row._id)).toEqual([id])
    // RG10: Redirects declares no setup and is always ready.
    await expect(redirectsGuard(t)).resolves.toEqual({
      moduleId: "redirects",
      effective: true,
      readiness: "ready",
      setup: "not_required",
    })
  })
})

async function installHistoricalFixture(t: App, owner: Caller) {
  await owner.mutation(api.cms.publication.initializeEmptySnapshotAuthority, {})
  const homePageId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "home",
    title: "Home",
    content: { en: { title: "Home", slices: [] } },
  })
  const pageId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "m01b-page",
    title: "M01b page",
    content: { en: { title: "English v1", slices: [] } },
  })
  await t.run(async (ctx) => {
    await ctx.db.insert("siteSettings", {
      siteName: "M01b test",
      siteUrl: "",
      defaultLocale: "en",
      enabledLocales: ["en"],
      homePageId,
      updatedAt: Date.now(),
    })
  })
  await owner.mutation(api.cms.publication.publishLocale, {
    pageId,
    locale: "en",
    expectedDraftGeneration: 1,
    expectedSharedDraftGeneration: 1,
    expectedPublicGeneration: 0,
    expectedLifecycleGeneration: 1,
    expectedReleaseGeneration: 0,
  })
  // A second draft generation under a new slug retires `/m01b-page`.
  await t.run(async (ctx) => {
    const state = await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", "en")
      )
      .unique()
    const ownerRow = await ctx.db
      .query("cmsOwner")
      .withIndex("by_key", (q) => q.eq("key", "owner"))
      .unique()
    if (!state || !ownerRow) throw new Error("publication fixture missing")
    const now = Date.now()
    await ctx.db.insert("pageLocaleDrafts", {
      pageId,
      locale: "en",
      pageType: "landing-page",
      generation: 2,
      slug: "m01b-page-v2",
      content: { title: "English v2", slices: [] },
      updatedBy: {
        kind: "owner",
        ownerId: ownerRow._id,
        authId: ownerRow.authId,
        tokenIdentifier: ownerRow.tokenIdentifier,
      },
      createdAt: now,
      updatedAt: now,
    })
    await ctx.db.patch(state._id, { draftGeneration: 2, updatedAt: now })
  })
  return pageId
}

function publishSecondGeneration(owner: Caller, pageId: Id<"pages">) {
  return owner.mutation(api.cms.publication.publishLocale, {
    pageId,
    locale: "en",
    expectedDraftGeneration: 2,
    expectedSharedDraftGeneration: 1,
    expectedPublicGeneration: 1,
    expectedLifecycleGeneration: 1,
    expectedReleaseGeneration: 1,
  })
}

describe("M01b required Publication isolation", () => {
  test("P6: historical locale continuity resolves on a snapshot_active install while disabled Redirects withholds every row", async () => {
    const t = app("missing")
    const owner = t.withIdentity(OWNER)
    const pageId = await installHistoricalFixture(t, owner)
    const second = await publishSecondGeneration(owner, pageId)
    // A rule on the retired path itself, which disabled Redirects must not serve.
    await seedRule(t, {
      fromPath: "/m01b-page",
      toPath: "/elsewhere",
      locale: "en",
      statusCode: 302,
      origin: "manual",
    })

    await expect(redirectsGuard(t)).resolves.toMatchObject({ effective: false })
    await expect(
      t.query(api.cms.pages.resolveHistoricalPublishedPath, {
        languageVersion: 0,
        locale: "en",
        path: "/m01b-page",
      })
    ).resolves.toMatchObject({
      authority: "snapshot_active",
      disposition: "historical_redirect",
      pageId,
      locale: "en",
      snapshotId: second.snapshotId,
      destinationPath: "/m01b-page-v2",
      statusCode: 307,
    })
    await expect(
      t.query(api.cms.redirects.resolve, {
        languageVersion: 0,
        path: "/m01b-page",
        locale: "en",
      })
    ).resolves.toBeNull()
    await expect(
      t.query(api.cms.redirects.listActiveKeys, { languageVersion: 0 })
    ).resolves.toEqual([])
    await expect(owner.query(api.cms.redirects.list, {})).rejects.toThrow(
      "CMS_MODULE_DISABLED"
    )
  })

  test("P7: invalid module state does not stop publishing a locale or historical resolution", async () => {
    const t = app("missing")
    const owner = t.withIdentity(OWNER)
    const pageId = await installHistoricalFixture(t, owner)
    await t.run(async (ctx) => {
      for (const configurationVersion of [1, 2]) {
        await ctx.db.insert("cmsModuleState", {
          key: "owner",
          configurationVersion,
          enabledModules: [],
        })
      }
    })
    await expect(
      t.query(api.cms.redirects.resolve, {
        languageVersion: 0,
        path: "/m01b-page",
        locale: "en",
      })
    ).rejects.toThrow("CMS_MODULE_STATE_INVALID")

    const second = await publishSecondGeneration(owner, pageId)
    expect(second.publicGeneration).toBe(2)
    await expect(
      t.query(api.cms.pages.resolveHistoricalPublishedPath, {
        languageVersion: 0,
        locale: "en",
        path: "/m01b-page",
      })
    ).resolves.toMatchObject({
      authority: "snapshot_active",
      disposition: "historical_redirect",
      pageId,
      snapshotId: second.snapshotId,
      destinationPath: "/m01b-page-v2",
      statusCode: 307,
    })
  })
})
