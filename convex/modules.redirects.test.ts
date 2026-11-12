/// <reference types="vite/client" />

import { beforeEach, describe, expect, test, vi } from "vitest"
import { api } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { convexTest } from "../convexTestWithExplicitAdmin"
import { enableRedirectsForTest } from "../redirectsTestHelpers"
import {
  resolveModuleGuardState,
  resolveModuleReadiness,
} from "./lib/modules/state"
import schema from "./schema"

// M01d: the Redirects disable blocker (recovery design RG10, RG11, B7, B9,
// C8–C10; M01d-P1–P7). Behavior is driven through the registered
// `cms.modules`, `cms.redirects`, `cms.publication` and `cms.pages` entry
// points. Direct writes only seed rows that no guarded entry can produce.
const modules = import.meta.glob("./**/*.ts")

// P5 observable: count every evaluation of the real blocker, and optionally
// make it throw, without changing what it reads.
const blockerProbe = vi.hoisted(() => ({
  calls: 0,
  failure: null as Error | null,
}))

vi.mock("./lib/redirects/disableBlocker", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./lib/redirects/disableBlocker")>()
  return {
    ...actual,
    readRedirectsDisableBlockers: async (
      ctx: Parameters<typeof actual.readRedirectsDisableBlockers>[0]
    ) => {
      blockerProbe.calls += 1
      if (blockerProbe.failure) throw blockerProbe.failure
      return await actual.readRedirectsDisableBlockers(ctx)
    },
  }
})

beforeEach(() => {
  blockerProbe.calls = 0
  blockerProbe.failure = null
})

const OWNER = {
  subject: "m01d-owner",
  tokenIdentifier: "https://convex.test|m01d-owner",
  email: "m01d-owner@example.com",
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

const BLOCKED = "CMS_MODULE_TRANSITION_BLOCKED"

async function seedRule(
  t: App,
  row: {
    fromPath: string
    toPath?: string
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

function moduleStateRows(t: App) {
  return t.run((ctx) => ctx.db.query("cmsModuleState").collect())
}

function redirectsGuard(t: App) {
  return t.run((ctx) => resolveModuleGuardState(ctx, "redirects"))
}

function previewRedirects(owner: Caller, enabled: boolean) {
  return owner.query(api.cms.modules.preview, {
    changes: [{ moduleId: "redirects", enabled }],
  })
}

function commitRedirects(owner: Caller, version: number, enabled: boolean) {
  return owner.mutation(api.cms.modules.commit, {
    expectedConfigurationVersion: version,
    changes: [{ moduleId: "redirects", enabled }],
  })
}

describe("M01d Redirects disable blocker", () => {
  test("P1: the blocker appears in preview and is rechecked in commit, so a stale preview cannot bypass a newly created rule", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await enableRedirectsForTest(owner)

    const stale = await previewRedirects(owner, false)
    expect(stale.changes).toEqual([
      { moduleId: "redirects", fromEnabled: true, toEnabled: false },
    ])
    expect(stale.blockers).toEqual([])

    const ruleId = await owner.mutation(api.cms.redirects.create, {
      fromPath: "/p1-new",
      toPath: "/p1-target",
      statusCode: 301,
    })
    // Creating a rule does not advance the configuration version, so only the
    // commit's own blocker read can refuse the stale reviewed transition.
    await expect(
      owner.mutation(api.cms.modules.commit, {
        expectedConfigurationVersion: stale.configurationVersion,
        changes: stale.changes.map(({ moduleId, toEnabled }) => ({
          moduleId,
          enabled: toEnabled,
        })),
      })
    ).rejects.toThrow(BLOCKED)
    await expect(redirectsGuard(t)).resolves.toMatchObject({ effective: true })
    expect(await moduleStateRows(t)).toMatchObject([
      {
        configurationVersion: 1,
        enabledModules: [{ moduleId: "redirects", configVersion: 1 }],
      },
    ])

    await expect(previewRedirects(owner, false)).resolves.toMatchObject({
      blockers: [
        {
          code: "REDIRECT_RULES_PRESENT",
          moduleId: "redirects",
          ruleCount: 1,
          moreRules: false,
          rules: [{ ruleId, fromPath: "/p1-new" }],
        },
      ],
    })
  })

  test("names every row by ID, source path and language, in source-path order, without reading destination or provenance", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await enableRedirectsForTest(owner)
    const localized = await seedRule(t, {
      fromPath: "/b-localized",
      toPath: "/b-target",
      locale: "fr",
      statusCode: 302,
      origin: "manual",
    })
    // Unresolved provenance and no destination at all: still an active rule.
    const unresolved = await seedRule(t, {
      fromPath: "/a-unresolved",
      statusCode: 301,
    })

    const preview = await previewRedirects(owner, false)
    expect(preview.blockers).toEqual([
      {
        code: "REDIRECT_RULES_PRESENT",
        moduleId: "redirects",
        ruleCount: 2,
        moreRules: false,
        rules: [
          { ruleId: unresolved, fromPath: "/a-unresolved" },
          { ruleId: localized, fromPath: "/b-localized", locale: "fr" },
        ],
      },
    ])
    await expect(commitRedirects(owner, 1, false)).rejects.toThrow(BLOCKED)
  })

  test("lists at most 100 identities and flags that more rules exist", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await enableRedirectsForTest(owner)
    await t.run(async (ctx) => {
      const now = Date.now()
      for (let index = 0; index < 101; index += 1) {
        await ctx.db.insert("redirects", {
          fromPath: `/bulk-${String(index).padStart(3, "0")}`,
          toPath: "/bulk-target",
          statusCode: 301,
          createdAt: now,
          updatedAt: now,
          origin: "manual",
        })
      }
    })

    const [blocker] = (await previewRedirects(owner, false)).blockers
    expect(blocker).toMatchObject({
      code: "REDIRECT_RULES_PRESENT",
      ruleCount: 101,
      moreRules: true,
    })
    const rules = blocker && "rules" in blocker ? blocker.rules : []
    expect(rules).toHaveLength(100)
    expect(rules[0]?.fromPath).toBe("/bulk-000")
    expect(rules[99]?.fromPath).toBe("/bulk-099")
    await expect(commitRedirects(owner, 1, false)).rejects.toThrow(BLOCKED)
  })

  test("P2: enable, refused disable, disable and re-enable write or delete no redirects rows", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    // A retained row that predates enablement.
    const retainedId = await seedRule(t, {
      fromPath: "/p2-retained",
      toPath: "/p2-target",
      statusCode: 301,
    })
    const initial = await redirectRows(t)
    expect(initial).toHaveLength(1)

    await enableRedirectsForTest(owner)
    expect(await redirectRows(t)).toEqual(initial)

    await expect(commitRedirects(owner, 1, false)).rejects.toThrow(BLOCKED)
    expect(await redirectRows(t)).toEqual(initial)

    await owner.mutation(api.cms.redirects.remove, { id: retainedId })
    expect(await redirectRows(t)).toEqual([])
    await expect(commitRedirects(owner, 1, false)).resolves.toMatchObject({
      committed: true,
      configurationVersion: 2,
    })
    expect(await redirectRows(t)).toEqual([])

    // A row retained while disabled survives re-enable unchanged, and enable
    // restores nothing that the owner removed.
    await seedRule(t, {
      fromPath: "/p2-while-off",
      toPath: "/p2-target",
      statusCode: 302,
    })
    const whileOff = await redirectRows(t)
    await expect(commitRedirects(owner, 2, true)).resolves.toMatchObject({
      committed: true,
      configurationVersion: 3,
    })
    expect(await redirectRows(t)).toEqual(whileOff)
  })

  test("P3: a present manual rule blocks disable and keeps resolving; after owner removal disable commits; re-enable restores nothing and a new rule resolves", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await enableRedirectsForTest(owner)
    const ruleId = await owner.mutation(api.cms.redirects.create, {
      fromPath: "/p3-old",
      toPath: "/p3-new",
      statusCode: 301,
    })

    await expect(previewRedirects(owner, false)).resolves.toMatchObject({
      blockers: [
        {
          code: "REDIRECT_RULES_PRESENT",
          ruleCount: 1,
          rules: [{ ruleId, fromPath: "/p3-old" }],
        },
      ],
    })
    await expect(commitRedirects(owner, 1, false)).rejects.toThrow(BLOCKED)
    expect((await redirectRows(t)).map((row) => row._id)).toEqual([ruleId])
    await expect(
      t.query(api.cms.redirects.resolve, {
        languageVersion: 0,
        path: "/p3-old",
      })
    ).resolves.toEqual({ destination: "/p3-new", statusCode: 301 })

    await owner.mutation(api.cms.redirects.remove, { id: ruleId })
    await expect(previewRedirects(owner, false)).resolves.toMatchObject({
      blockers: [],
    })
    await expect(commitRedirects(owner, 1, false)).resolves.toMatchObject({
      committed: true,
      configurationVersion: 2,
    })
    await expect(commitRedirects(owner, 2, true)).resolves.toMatchObject({
      committed: true,
      configurationVersion: 3,
    })
    expect(await redirectRows(t)).toEqual([])
    await expect(
      t.query(api.cms.redirects.resolve, {
        languageVersion: 0,
        path: "/p3-old",
      })
    ).resolves.toBeNull()

    await owner.mutation(api.cms.redirects.create, {
      fromPath: "/p3-after",
      toPath: "/p3-after-target",
      statusCode: 302,
    })
    await expect(
      t.query(api.cms.redirects.resolve, {
        languageVersion: 0,
        path: "/p3-after",
      })
    ).resolves.toEqual({ destination: "/p3-after-target", statusCode: 302 })
  })

  test("P6: after a disable commit the next resolve returns null, even for a retained row", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await enableRedirectsForTest(owner)
    const ruleId = await owner.mutation(api.cms.redirects.create, {
      fromPath: "/p6-old",
      toPath: "/p6-new",
      statusCode: 301,
    })
    await expect(
      t.query(api.cms.redirects.resolve, {
        languageVersion: 0,
        path: "/p6-old",
      })
    ).resolves.toEqual({ destination: "/p6-new", statusCode: 301 })
    await owner.mutation(api.cms.redirects.remove, { id: ruleId })
    await expect(commitRedirects(owner, 1, false)).resolves.toMatchObject({
      committed: true,
    })

    // The same source path retained while disabled, as a stale key set would
    // still route it to `resolve`: the disabled guard withholds it.
    await seedRule(t, {
      fromPath: "/p6-old",
      toPath: "/p6-new",
      statusCode: 301,
      origin: "manual",
    })
    await expect(
      t.query(api.cms.redirects.resolve, {
        languageVersion: 0,
        path: "/p6-old",
      })
    ).resolves.toBeNull()
    await expect(
      t.query(api.cms.redirects.listActiveKeys, { languageVersion: 0 })
    ).resolves.toEqual([])
  })

  test("P7: Redirects reports ready/not_required in both states and registers no readiness provider", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    expect(
      await t.run(async (ctx) => [
        ...(await resolveModuleReadiness(ctx, new Set())).keys(),
      ])
    ).toEqual(["email", "multilingual", "ai"])

    for (const enabled of [false, true]) {
      if (enabled) await enableRedirectsForTest(owner)
      await expect(redirectsGuard(t)).resolves.toEqual({
        moduleId: "redirects",
        effective: enabled,
        readiness: "ready",
        setup: "not_required",
      })
      const current = await owner.query(api.cms.modules.preview, {
        changes: [],
      })
      expect(
        current.readiness.find((module) => module.moduleId === "redirects")
      ).toMatchObject({ enabled, readiness: "ready", setup: "not_required" })
    }
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
    slug: "m01d-page",
    title: "M01d page",
    content: { en: { title: "English v1", slices: [] } },
  })
  await t.run(async (ctx) => {
    await ctx.db.insert("siteSettings", {
      siteName: "M01d test",
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
  // A second draft generation under a new slug retires `/m01d-page`.
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
      slug: "m01d-page-v2",
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
  const second = await owner.mutation(api.cms.publication.publishLocale, {
    pageId,
    locale: "en",
    expectedDraftGeneration: 2,
    expectedSharedDraftGeneration: 1,
    expectedPublicGeneration: 1,
    expectedLifecycleGeneration: 1,
    expectedReleaseGeneration: 1,
  })
  return { pageId, second }
}

describe("M01d required Publication stays outside the blocker", () => {
  test("P4: Historical Locale routes never enter the blocker; disable commits and the historical URL still resolves", async () => {
    const t = app("missing")
    const owner = t.withIdentity(OWNER)
    const { pageId, second } = await installHistoricalFixture(t, owner)
    await enableRedirectsForTest(owner)

    expect(
      await t.run(
        async (ctx) =>
          (await ctx.db.query("pageHistoricalLocaleRoutes").collect()).length
      )
    ).toBeGreaterThan(0)
    expect(await redirectRows(t)).toEqual([])

    await expect(previewRedirects(owner, false)).resolves.toMatchObject({
      blockers: [],
    })
    await expect(commitRedirects(owner, 1, false)).resolves.toMatchObject({
      committed: true,
      configurationVersion: 2,
    })
    await expect(
      t.query(api.cms.pages.resolveHistoricalPublishedPath, {
        languageVersion: 0,
        locale: "en",
        path: "/m01d-page",
      })
    ).resolves.toMatchObject({
      authority: "snapshot_active",
      disposition: "historical_redirect",
      pageId,
      locale: "en",
      snapshotId: second.snapshotId,
      destinationPath: "/m01d-page-v2",
      statusCode: 307,
    })
  })
})

describe("M01d blocker evaluation scope", () => {
  test("P5: a transition that does not change Redirects never evaluates the blocker; a Redirects disable evaluates it in preview and again in commit", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    // A row that would block, so any evaluation would be visible as a blocker.
    await seedRule(t, {
      fromPath: "/p5-rule",
      toPath: "/p5-target",
      statusCode: 301,
      origin: "manual",
    })

    // Settings › Modules' own current-state read.
    await expect(
      owner.query(api.cms.modules.preview, { changes: [] })
    ).resolves.toMatchObject({ blockers: [] })
    // Disabling an already-disabled Redirects: same module, no change.
    await expect(previewRedirects(owner, false)).resolves.toMatchObject({
      changes: [],
      blockers: [],
    })
    await expect(commitRedirects(owner, 0, false)).resolves.toMatchObject({
      committed: false,
      configurationVersion: 0,
    })
    // The only other transition the catalog allows: a required module request.
    await expect(
      owner.query(api.cms.modules.preview, {
        changes: [{ moduleId: "publication", enabled: false }],
      })
    ).resolves.toMatchObject({
      changes: [],
      blockers: [
        {
          code: "REQUIRED_MODULE",
          moduleId: "publication",
          relatedModuleId: "publication",
        },
      ],
    })
    await expect(
      owner.mutation(api.cms.modules.commit, {
        expectedConfigurationVersion: 0,
        changes: [{ moduleId: "publication", enabled: false }],
      })
    ).rejects.toThrow(BLOCKED)
    // Enabling Redirects, then a no-op enable while enabled.
    await expect(previewRedirects(owner, true)).resolves.toMatchObject({
      blockers: [],
    })
    await enableRedirectsForTest(owner)
    await expect(commitRedirects(owner, 1, true)).resolves.toMatchObject({
      committed: false,
      configurationVersion: 1,
    })
    expect(blockerProbe.calls).toBe(0)

    await expect(previewRedirects(owner, false)).resolves.toMatchObject({
      blockers: [{ code: "REDIRECT_RULES_PRESENT", ruleCount: 1 }],
    })
    expect(blockerProbe.calls).toBe(1)
    await expect(commitRedirects(owner, 1, false)).rejects.toThrow(BLOCKED)
    expect(blockerProbe.calls).toBe(2)
  })

  test("a failing blocker read fails only a Redirects-disabling preview or commit, atomically, and never reads as no blockers", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await enableRedirectsForTest(owner)
    blockerProbe.failure = new Error("m01d blocker read failed")

    await expect(previewRedirects(owner, false)).rejects.toThrow(
      "m01d blocker read failed"
    )
    await expect(commitRedirects(owner, 1, false)).rejects.toThrow(
      "m01d blocker read failed"
    )
    await expect(redirectsGuard(t)).resolves.toMatchObject({ effective: true })
    expect(await moduleStateRows(t)).toMatchObject([
      { configurationVersion: 1 },
    ])

    // Requests that do not change Redirects are unaffected by the failure.
    await expect(
      owner.query(api.cms.modules.preview, { changes: [] })
    ).resolves.toMatchObject({ blockers: [] })
    await expect(commitRedirects(owner, 1, true)).resolves.toMatchObject({
      committed: false,
    })
    expect(blockerProbe.calls).toBe(2)
  })
})
