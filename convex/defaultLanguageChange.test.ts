/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { ConvexError } from "convex/values"
import { api, internal } from "./_generated/api"
import type { Doc, Id } from "./_generated/dataModel"
import { convexTest } from "../convexTestWithExplicitAdmin"
import { LANGUAGE_LIFECYCLE_RETRY_DELAY_MS } from "./cms/languageLifecycle"
import {
  assertReleaseExecutionEligible,
  classifySiteLanguageState,
} from "./lib/language/state"
import schema from "./schema"

// U2 (routing rework, ADR-0053 amendment 2026-11-02): `setDefaultLanguage`, a
// silent one-step default language change. The owner's words: "setting
// default locale only changes how pages url are handled by proxy.ts" and "this
// should happen silently and automatically".

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "u2-owner",
  tokenIdentifier: "https://convex.test|u2-owner",
}
const STRANGER = {
  subject: "u2-stranger",
  tokenIdentifier: "https://convex.test|u2-stranger",
}
const FIXED_NOW = Date.UTC(2026, 10, 2, 12, 0, 0)
const ORIGIN = "https://site.example.com"

type T = ReturnType<typeof convexTest>
type Caller = ReturnType<T["withIdentity"]>
type Site = {
  t: T
  owner: Caller
  homeId: Id<"pages">
  aboutId: Id<"pages">
}
type Outcome = { ok: unknown } | { error: string }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(FIXED_NOW)
  vi.stubEnv("REVALIDATE_SECRET", "test-revalidation-secret")
  vi.stubEnv("SITE_URL", "")
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function outcome(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: (await run()) ?? null }
  } catch (error) {
    if (error instanceof ConvexError) return { error: String(error.data) }
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
const refused = (code: string) => ({ error: code })
// B1 (owner 2026-11-02, Convex application results): a stale token detected
// before the first write is a structured result, not a thrown error.
const STALE_RESULT = {
  ok: { ok: false, code: "SITE_LANGUAGE_VERSION_CHANGED" },
}

async function drain(t: T) {
  await t.finishAllScheduledFunctions(vi.runAllTimers)
}

async function everyRow(t: T) {
  return t.run(async (ctx) => {
    const rows: Record<string, unknown[]> = {}
    for (const table of Object.keys(schema.tables).sort()) {
      rows[table] = await ctx.db
        .query(table as keyof typeof schema.tables)
        .collect()
    }
    return rows
  })
}

async function refusalWritesNothing(t: T, run: () => Promise<unknown>) {
  const before = await everyRow(t)
  const result = await outcome(run)
  expect(await everyRow(t)).toEqual(before)
  return result
}

async function generations(t: T, pageId: Id<"pages">, locale: string) {
  return t.run(async (ctx) => ({
    state: await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", locale)
      )
      .unique(),
    shared: await ctx.db
      .query("pageSharedDrafts")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .unique(),
    page: await ctx.db
      .query("pagePublicationPageStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .unique(),
  }))
}

async function publishArgs(t: T, pageId: Id<"pages">, locale: string) {
  const { state, shared, page } = await generations(t, pageId, locale)
  return {
    pageId,
    locale,
    expectedDraftGeneration: state!.draftGeneration,
    expectedSharedDraftGeneration: shared!.generation,
    expectedPublicGeneration: state!.publicGeneration,
    expectedLifecycleGeneration: page!.lifecycleGeneration,
    expectedReleaseGeneration: state!.releaseGeneration,
  }
}

async function createPage(owner: Caller, slug: string, locales: string[]) {
  return owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug,
    title: slug,
    content: Object.fromEntries(
      locales.map((locale) => [
        locale,
        { title: `${slug} ${locale}`, slices: [] },
      ])
    ),
  })
}

async function publish(
  site: Pick<Site, "t" | "owner">,
  pageId: Id<"pages">,
  locale: string
) {
  await site.owner.mutation(
    api.cms.publication.publishLocale,
    await publishArgs(site.t, pageId, locale)
  )
  await drain(site.t)
}

async function withdraw(
  site: Pick<Site, "t" | "owner">,
  pageId: Id<"pages">,
  locale: string
) {
  const { state, page } = await generations(site.t, pageId, locale)
  await site.owner.mutation(api.cms.publication.withdrawLocale, {
    pageId,
    locale,
    expectedSnapshotId: state!.currentSnapshotId!,
    expectedPublicGeneration: state!.publicGeneration,
    expectedLifecycleGeneration: page!.lifecycleGeneration,
  })
  await drain(site.t)
}

/**
 * Snapshot authority, an `en` default with `fr` enabled, a home Page and an
 * `about` Page published in both languages, and multilingual authority adopted.
 */
async function mlSite(): Promise<Site> {
  const t = convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
    publicationAuthority: "missing",
  })
  const owner = t.withIdentity(OWNER)
  await owner.mutation(api.cms.publication.initializeEmptySnapshotAuthority, {})
  const homeId = await createPage(owner, "home", ["en", "fr"])
  const aboutId = await createPage(owner, "about", ["en", "fr"])
  await t.run((ctx) =>
    ctx.db.insert("siteSettings", {
      siteName: "U2 site",
      siteUrl: "",
      defaultLocale: "en",
      enabledLocales: ["en", "fr"],
      homePageId: homeId,
      updatedAt: FIXED_NOW,
    })
  )
  const site = { t, owner, homeId, aboutId }
  for (const pageId of [homeId, aboutId]) {
    for (const locale of ["en", "fr"]) await publish(site, pageId, locale)
  }
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query("cmsModuleState").collect()) {
      await ctx.db.delete(row._id)
    }
  })
  await owner.mutation(api.cms.modules.commit, {
    expectedConfigurationVersion: 0,
    changes: [{ moduleId: "multilingual", enabled: true }],
  })
  const preview = await owner.query(api.cms.multilingual.previewAdoption, {})
  if (!preview.canAdopt) throw new ConvexError(preview.blockerCode)
  const { canAdopt, defaultLocale, enabledLocales, ...tokens } = preview
  void canAdopt
  void defaultLocale
  void enabledLocales
  await owner.mutation(api.cms.multilingual.adoptMultilingualAuthority, tokens)
  await drain(t)
  return site
}

async function authorityRow(t: T) {
  return (await t.run((ctx) => ctx.db.query("siteLanguageAuthority").unique()))!
}
async function settingsRow(t: T) {
  return (await t.run((ctx) => ctx.db.query("siteSettings").unique()))!
}
async function intentRows(t: T) {
  return t.run((ctx) =>
    ctx.db.query("siteLanguageLifecycleIntents").collect()
  )
}

async function tokens(t: T) {
  const authority = await authorityRow(t)
  const moduleState = (await t.run((ctx) =>
    ctx.db.query("cmsModuleState").first()
  ))!
  return {
    expectedAuthorityVersion: authority.version,
    expectedModuleConfigurationVersion: moduleState.configurationVersion,
  }
}

async function setDefault(
  site: Pick<Site, "t" | "owner">,
  toLocale: string,
  override: Partial<Awaited<ReturnType<typeof tokens>>> = {}
) {
  return site.owner.mutation(api.cms.multilingual.setDefaultLanguage, {
    toLocale,
    ...(await tokens(site.t)),
    ...override,
  })
}

async function resolveAs(t: T, locale: string, path: string) {
  const { languageVersion } = await t.query(api.cms.settings.getSiteConfig, {})
  return t.query(api.cms.pages.resolveHistoricalPublishedPath, {
    locale,
    path,
    languageVersion,
  })
}

async function localeState(t: T, pageId: Id<"pages">, locale: string) {
  return (await generations(t, pageId, locale)).state!
}

function setCutover(t: T, phase: "preparing" | "snapshot_active") {
  return t.run(async (ctx) => {
    const row = (await ctx.db.query("pagePublicationCutover").unique())!
    await ctx.db.patch(row._id, { phase })
  })
}

/** F09's last committed transition into `targetLocale`, with its routes. */
async function storeF09Continuity(
  t: T,
  targetLocale: string,
  routes: readonly { fromPath: string; pageId: Id<"pages"> }[]
) {
  return t.run(async (ctx) => {
    const owner = (await ctx.db
      .query("cmsOwner")
      .withIndex("by_key", (q) => q.eq("key", "owner"))
      .unique())!
    const transitionId = await ctx.db.insert("siteLanguageTransitions", {
      mode: "correct_label",
      sourceLocale: "nl",
      targetLocale,
      phase: "committed",
      generation: 1,
      startAuthorityVersion: 1,
      startSettingsUpdatedAt: FIXED_NOW,
      shortPath: false,
      sourcePublicSetVersion: 0,
      preparedSetVersion: 0,
      pageCount: 1,
      targetCount: 1,
      withdrawCount: 0,
      redirectCount: 0,
      unresolvedCount: 0,
      blockedCount: 0,
      targetDrafts: "retained",
      committedAt: FIXED_NOW,
      attribution: {
        kind: "owner",
        ownerId: owner._id,
        authId: owner.authId,
        tokenIdentifier: owner.tokenIdentifier,
      },
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    })
    for (const route of routes) {
      await ctx.db.insert("siteLanguageTransitionRoutes", {
        transitionId,
        ...route,
        origin: "source_current",
        createdAt: FIXED_NOW,
      })
    }
    const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
    await ctx.db.patch(authority._id, {
      lastCommittedTransitionId: transitionId,
    })
    return transitionId
  })
}

/** A committed C3b generation 1 with pointed rows, named by the authority. */
async function storePointedGeneration(
  t: T,
  fromLocale: string,
  toLocale: string,
  rows: readonly { fromPath: string; pageId: Id<"pages"> }[]
) {
  return t.run(async (ctx) => {
    const owner = (await ctx.db.query("cmsOwner").unique())!
    const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
    const moduleState = (await ctx.db.query("cmsModuleState").unique())!
    const freshness = { routeClaimVersion: 0, publicationSetVersion: 0 }
    const migrationId = await ctx.db.insert("siteDefaultLanguageMigrations", {
      fromLocale,
      toLocale,
      phase: "committed",
      generation: 1,
      captured: {
        authorityVersion: authority.version,
        moduleConfigurationVersion: moduleState.configurationVersion,
        site: freshness,
        from: freshness,
        to: freshness,
      },
      counts: {
        rows: rows.length,
        shadowedByCurrent: 0,
        shadowedByHistorical: 0,
        manualRulesShadowed: 0,
        manualRulesShifted: 0,
        manualRulesUnprefixed: 0,
        carriedShadowedSkipped: 0,
        blockers: 0,
      },
      disclosurePageCount: 0,
      reviewedThroughOrdinal: -1,
      committedAt: FIXED_NOW,
      committedAuthorityVersion: authority.version,
      attribution: {
        kind: "owner",
        ownerId: owner._id,
        authId: owner.authId,
        tokenIdentifier: owner.tokenIdentifier,
      },
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    })
    for (const row of rows) {
      await ctx.db.insert("siteDefaultLanguageRoutes", {
        migrationId,
        generation: 1,
        pageId: row.pageId,
        locale: fromLocale,
        fromPath: row.fromPath,
        origin: "old_default_current",
        createdAt: FIXED_NOW,
      })
    }
    await ctx.db.patch(authority._id, {
      continuityPointer: { migrationId, generation: 1 },
    })
    return migrationId
  })
}

async function seedMigration(
  t: T,
  phase: "enumerating" | "validating" | "ready"
) {
  return t.run(async (ctx) => {
    const owner = (await ctx.db.query("cmsOwner").unique())!
    const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
    const moduleState = (await ctx.db.query("cmsModuleState").unique())!
    const freshness = { routeClaimVersion: 0, publicationSetVersion: 0 }
    const id = await ctx.db.insert("siteDefaultLanguageMigrations", {
      fromLocale: "en",
      toLocale: "fr",
      phase,
      generation: 1,
      captured: {
        authorityVersion: authority.version,
        moduleConfigurationVersion: moduleState.configurationVersion,
        site: freshness,
        from: freshness,
        to: freshness,
      },
      counts: {
        rows: 0,
        shadowedByCurrent: 0,
        shadowedByHistorical: 0,
        manualRulesShadowed: 0,
        manualRulesShifted: 0,
        manualRulesUnprefixed: 0,
        carriedShadowedSkipped: 0,
        blockers: 0,
      },
      disclosurePageCount: 0,
      reviewedThroughOrdinal: -1,
      attribution: {
        kind: "owner",
        ownerId: owner._id,
        authId: owner.authId,
        tokenIdentifier: owner.tokenIdentifier,
      },
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    })
    await ctx.db.patch(authority._id, { activeDefaultMigrationId: id })
    return id
  })
}

/** Clones a published release row for `(pageId, locale)` with a new status. */
async function seedRelease(
  t: T,
  pageId: Id<"pages">,
  locale: string,
  status: "pending" | "held"
): Promise<Id<"pageLocalePublicationReleases">> {
  return t.run(async (ctx) => {
    const release = (await ctx.db
      .query("pageLocalePublicationReleases")
      .withIndex("by_pageId_and_locale_and_status", (q) =>
        q.eq("pageId", pageId).eq("locale", locale).eq("status", "published")
      )
      .first())!
    const { _id, _creationTime, publishedSnapshotId, publishedAt, ...row } =
      release
    void _id
    void _creationTime
    void publishedSnapshotId
    void publishedAt
    return ctx.db.insert("pageLocalePublicationReleases", {
      ...row,
      status,
      ...(status === "held"
        ? { holdReason: "LOCALE_NOT_ENABLED", heldAt: FIXED_NOW }
        : {}),
    })
  })
}

describe("U2 setDefaultLanguage: the silent change", () => {
  test("1. commits exactly the authority, settings and one default_change intent", async () => {
    const site = await mlSite()
    const { t, owner } = site
    const staleVersion = (await t.query(api.cms.settings.getSiteConfig, {}))
      .languageVersion
    const authorityBefore = await authorityRow(t)
    const settingsBefore = await settingsRow(t)
    const before = await everyRow(t)
    const intentsBefore = await intentRows(t)
    const scheduledBefore = (
      await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())
    ).length
    // M05 A5: a legacy single description exists, so it moves to D.
    await t.run((ctx) =>
      ctx.db.patch(settingsBefore._id, {
        siteDescription: "Une description",
        siteDescriptions: { fr: "Deja francais" },
      } as never)
    )
    const settingsSeeded = await settingsRow(t)
    const beforeSwitch = await everyRow(t)

    const result = await outcome(() => setDefault(site, "fr"))
    expect(result).toEqual({
      ok: { ok: true, authorityVersion: authorityBefore.version + 1 },
    })

    const after = await everyRow(t)
    for (const table of [
      "siteLanguageAuthority",
      "siteSettings",
      "siteLanguageLifecycleIntents",
    ]) {
      delete beforeSwitch[table]
      delete after[table]
    }
    expect(after).toEqual(beforeSwitch)
    void before

    const authority = await authorityRow(t)
    // One commit: both rows carry the same timestamp.
    const at = authority.updatedAt
    expect(at).toBeGreaterThanOrEqual(FIXED_NOW)
    expect(authority).toEqual({
      ...authorityBefore,
      currentLocale: "fr",
      version: authorityBefore.version + 1,
      updatedAt: at,
    })
    // Both arrays keep their order in both rows; continuity stays unchanged.
    expect(authority.enabledLocales).toEqual(["en", "fr"])
    expect(authority.continuityPointer).toBeUndefined()
    expect(authority.activeDefaultMigrationId).toBeUndefined()
    expect(authority.lastCommittedTransitionId).toBe(
      authorityBefore.lastCommittedTransitionId
    )
    const settings = await settingsRow(t)
    expect(settings).toMatchObject({
      defaultLocale: "fr",
      enabledLocales: ["en", "fr"],
      updatedAt: at,
    })
    // The existing key wins (fr stays), and D gets the legacy description.
    expect(settings.siteDescriptions).toMatchObject({
      en: "Une description",
      fr: "Deja francais",
    })
    expect(settings.siteDescription).toBeUndefined()
    void settingsSeeded

    const added = (await intentRows(t)).filter(
      (row) => !intentsBefore.some((old) => old._id === row._id)
    )
    expect(added).toMatchObject([
      {
        operationId: `default_change:v${authorityBefore.version + 1}`,
        operationKind: "default_change",
        locales: ["en", "fr"],
        capturedAuthorityVersion: authorityBefore.version + 1,
        phase: "tags_and_layout",
        status: "pending",
        attempts: 0,
      },
    ])
    expect(added[0]).not.toHaveProperty("migrationId")
    expect(
      (
        await t.run((ctx) =>
          ctx.db.system.query("_scheduled_functions").collect()
        )
      ).length
    ).toBe(scheduledBefore)

    // The classifier still accepts the row, and no route row exists.
    expect(
      await t.run(async (ctx) =>
        classifySiteLanguageState(
          await ctx.db.query("siteSettings").take(2),
          await ctx.db.query("siteLanguageAuthority").take(2),
          true
        )
      )
    ).toMatchObject({ kind: "multilingual", locale: "fr" })
    // A public read pinned to the old version retries.
    expect(
      await outcome(() =>
        t.query(api.cms.pages.resolveLocalizedPathQuery, {
          path: "about",
          locale: "en",
          languageVersion: staleVersion,
        })
      )
    ).toEqual(refused("SITE_LANGUAGE_VERSION_CHANGED"))
    void owner
  })

  test("2. each refusal is in order and writes nothing", async () => {
    const site = await mlSite()
    const { t, owner, homeId, aboutId } = site
    const go = (toLocale = "fr", override = {}) =>
      () =>
        setDefault(site, toLocale, override)

    // 1. owner only
    const stranger = t.withIdentity(STRANGER)
    const strangerResult = await refusalWritesNothing(t, async () =>
      stranger.mutation(api.cms.multilingual.setDefaultLanguage, {
        toLocale: "fr",
        ...(await tokens(t)),
      })
    )
    expect(strangerResult).toHaveProperty("error")

    // 2. snapshot authority before everything else
    await setCutover(t, "preparing")
    expect(
      await refusalWritesNothing(t, go("fr", { expectedAuthorityVersion: 999 }))
    ).toEqual(refused("LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY"))
    await setCutover(t, "snapshot_active")

    // 3. invalid state, then not adopted
    const authority = await authorityRow(t)
    await t.run((ctx) => ctx.db.patch(authority._id, { mode: "single" }))
    expect(await refusalWritesNothing(t, go())).toEqual(
      refused("SITE_LANGUAGE_AUTHORITY_INVALID")
    )
    await t.run((ctx) => ctx.db.patch(authority._id, { mode: "multilingual" }))
    const single = await mlSite()
    await single.t.run(async (ctx) => {
      for (const row of await ctx.db.query("cmsModuleState").collect()) {
        await ctx.db.delete(row._id)
      }
      for (const row of await ctx.db.query("siteLanguageAuthority").collect()) {
        await ctx.db.delete(row._id)
      }
    })
    expect(
      await refusalWritesNothing(single.t, () =>
        single.owner.mutation(api.cms.multilingual.setDefaultLanguage, {
          toLocale: "fr",
          expectedAuthorityVersion: 1,
          expectedModuleConfigurationVersion: 1,
        })
      )
    ).toEqual(refused("CMS_MODULE_DISABLED"))

    // 4. stale versions, either one
    const live = await tokens(t)
    expect(
      await refusalWritesNothing(
        t,
        go("fr", { expectedAuthorityVersion: live.expectedAuthorityVersion - 1 })
      )
    ).toEqual(STALE_RESULT)
    expect(
      await refusalWritesNothing(
        t,
        go("fr", {
          expectedModuleConfigurationVersion:
            live.expectedModuleConfigurationVersion + 1,
        })
      )
    ).toEqual(STALE_RESULT)

    // 5. an open C3b migration, whatever the target
    const migrationId = await seedMigration(t, "enumerating")
    expect(await refusalWritesNothing(t, go("xx"))).toEqual(
      refused("LANGUAGE_OPERATION_OPEN")
    )
    await t.run(async (ctx) => {
      await ctx.db.patch(authority._id, { activeDefaultMigrationId: undefined })
      await ctx.db.delete(migrationId)
    })

    // 6. the locale checks
    expect(await refusalWritesNothing(t, go("xx"))).toEqual(
      refused("LOCALE_UNSUPPORTED")
    )
    expect(await refusalWritesNothing(t, go("nl"))).toEqual(
      refused("LOCALE_NOT_ENABLED")
    )
    expect(await refusalWritesNothing(t, go("en"))).toEqual(
      refused("LOCALE_IS_DEFAULT")
    )

    // 7. the home rule is gone (owner 2026-11-02): publication readiness no
    // longer gates the switch; see test 2c for the unpublished-home cases.
    void homeId
    void aboutId

    // an unrelated pending release elsewhere does not refuse; neither does an
    // unreviewed, undisclosed site.
    expect(await outcome(() => setDefault(site, "fr"))).toMatchObject({
      ok: { ok: true, authorityVersion: expect.any(Number) },
    })
    void owner
  })

  test("2c. no published home is needed in the new default language", async () => {
    // Owner 2026-11-02: "default locale impacts only public facing pages urls
    // why do we need to create a page in english forst before switching?"
    const variants: Record<
      string,
      (site: Site) => Promise<void> | void
    > = {
      withdrawn: (site) => withdraw(site, site.homeId, "fr"),
      "no fr content at all": async (site) => {
        const other = await createPage(site.owner, "startseite", ["en"])
        await publish(site, other, "en")
        const settings = await settingsRow(site.t)
        await site.t.run((ctx) =>
          ctx.db.patch(settings._id, { homePageId: other })
        )
      },
      "draft only": async (site) => {
        const other = await createPage(site.owner, "accueil", ["en", "fr"])
        await publish(site, other, "en")
        const settings = await settingsRow(site.t)
        await site.t.run((ctx) =>
          ctx.db.patch(settings._id, { homePageId: other })
        )
      },
      "delayed release": async (site) => {
        const releaseId = await seedRelease(
          site.t,
          site.aboutId,
          "fr",
          "pending"
        )
        const state = await localeState(site.t, site.homeId, "fr")
        await site.t.run((ctx) =>
          ctx.db.patch(state._id, { currentReleaseId: releaseId })
        )
      },
      "no home configured": async (site) => {
        const settings = await settingsRow(site.t)
        await site.t.run((ctx) =>
          ctx.db.patch(settings._id, { homePageId: undefined })
        )
      },
    }
    for (const [name, arrange] of Object.entries(variants)) {
      const site = await mlSite()
      const { t } = site
      await arrange(site)
      const authorityBefore = await authorityRow(t)
      const intentsBefore = await intentRows(t)
      const beforeSwitch = await everyRow(t)

      expect(
        await outcome(() => setDefault(site, "fr")),
        name
      ).toEqual({
        ok: { ok: true, authorityVersion: authorityBefore.version + 1 },
      })

      // Content, routes and releases are untouched; only the authority, the
      // settings default and one default_change intent changed.
      const after = await everyRow(t)
      for (const table of [
        "siteLanguageAuthority",
        "siteSettings",
        "siteLanguageLifecycleIntents",
      ]) {
        delete beforeSwitch[table]
        delete after[table]
      }
      expect(after, name).toEqual(beforeSwitch)
      expect((await settingsRow(t)).defaultLocale, name).toBe("fr")
      const added = (await intentRows(t)).filter(
        (row) => !intentsBefore.some((old) => old._id === row._id)
      )
      expect(added, name).toHaveLength(1)
      expect(added[0], name).toMatchObject({
        operationKind: "default_change",
        status: "pending",
      })
    }
  }, 120_000)

  test("3. pending and held releases stay unchanged and both languages stay eligible", async () => {
    const site = await mlSite()
    const { t, aboutId } = site
    await seedRelease(t, aboutId, "en", "pending")
    await seedRelease(t, aboutId, "fr", "pending")
    await seedRelease(t, aboutId, "en", "held")
    await seedRelease(t, aboutId, "fr", "held")
    const releasesBefore = await t.run((ctx) =>
      ctx.db.query("pageLocalePublicationReleases").collect()
    )
    await setDefault(site, "fr")
    expect(
      await t.run((ctx) =>
        ctx.db.query("pageLocalePublicationReleases").collect()
      )
    ).toEqual(releasesBefore)
    const version = (await authorityRow(t)).version
    for (const locale of ["en", "fr"]) {
      for (const captured of [undefined, version]) {
        expect(
          await outcome(() =>
            t.run((ctx) =>
              assertReleaseExecutionEligible(ctx, {
                locale,
                ...(captured === undefined
                  ? {}
                  : { capturedLanguageVersion: captured }),
              })
            )
          )
        ).toEqual({ ok: null })
      }
    }
  })

  test("4. continuity: F09 rows resolve in N, else in the transition target; C3b pointers keep their locale", async () => {
    const site = await mlSite()
    const { t, aboutId } = site
    await storeF09Continuity(t, "en", [
      { fromPath: "/uber-uns", pageId: aboutId },
    ])
    // Before the switch (default en): the page in en.
    expect(await resolveAs(t, "en", "/uber-uns")).toMatchObject({
      disposition: "historical_redirect",
      locale: "en",
      destinationPath: "/about",
    })

    await setDefault(site, "fr")
    // Current in N: the same page in N.
    const frAbout = await localeState(t, aboutId, "fr")
    expect(await resolveAs(t, "fr", "/uber-uns")).toEqual({
      authority: "snapshot_active",
      disposition: "historical_redirect",
      pageId: aboutId,
      locale: "fr",
      snapshotId: frAbout.currentSnapshotId,
      publicGeneration: frAbout.publicGeneration,
      destinationPath: "/about",
      statusCode: 307,
    })

    // Not current in N: the validated projection in the transition target.
    await withdraw(site, aboutId, "fr")
    const enAbout = await localeState(t, aboutId, "en")
    expect(await resolveAs(t, "fr", "/uber-uns")).toEqual({
      authority: "snapshot_active",
      disposition: "historical_redirect",
      pageId: aboutId,
      locale: "en",
      snapshotId: enAbout.currentSnapshotId,
      publicGeneration: enAbout.publicGeneration,
      destinationPath: "/about",
      statusCode: 307,
    })

    // Unavailable in both: as today.
    await withdraw(site, aboutId, "en")
    expect(await resolveAs(t, "fr", "/uber-uns")).toEqual({
      authority: "snapshot_active",
      disposition: "historical_unavailable",
    })
    // A target that is not enabled is unavailable, not a guess.
    await publish(site, aboutId, "en")
    const transition = (await t.run((ctx) =>
      ctx.db.query("siteLanguageTransitions").first()
    ))!
    await withdraw(site, aboutId, "fr").catch(() => undefined)
    await t.run((ctx) => ctx.db.patch(transition._id, { targetLocale: "nl" }))
    expect(await resolveAs(t, "fr", "/uber-uns")).toEqual({
      authority: "snapshot_active",
      disposition: "historical_unavailable",
    })
  })

  test("4b. a C3b pointer suppresses F09 and pointed rows keep their own locale", async () => {
    const site = await mlSite()
    const { t, aboutId, homeId } = site
    await storeF09Continuity(t, "en", [
      { fromPath: "/uber-uns", pageId: aboutId },
    ])
    const migrationId = await storePointedGeneration(t, "en", "fr", [
      { fromPath: "/legacy-en", pageId: aboutId },
    ])
    expect(migrationId).toBeDefined()
    await setDefault(site, "fr")

    // The pointer suppresses F09 lookup entirely.
    expect(await resolveAs(t, "fr", "/uber-uns")).toEqual({
      authority: "snapshot_active",
      disposition: "unclaimed",
    })
    // U3 (D3a): the page in the request locale (fr) when current there.
    const frAbout = await localeState(t, aboutId, "fr")
    expect(await resolveAs(t, "fr", "/legacy-en")).toEqual({
      authority: "snapshot_active",
      disposition: "historical_redirect",
      pageId: aboutId,
      locale: "fr",
      snapshotId: frAbout.currentSnapshotId,
      publicGeneration: frAbout.publicGeneration,
      destinationPath: "/about",
      statusCode: 307,
    })

    // Post-switch retirement: a new N claim on a pointed path retires the row.
    const retireId = await createPage(site.owner, "retire-me", ["fr"])
    const row = await t.run(async (ctx) => {
      const migration = (await ctx.db
        .query("siteDefaultLanguageRoutes")
        .first())!
      return ctx.db.insert("siteDefaultLanguageRoutes", {
        migrationId: migration.migrationId,
        generation: 1,
        pageId: aboutId,
        locale: "en",
        fromPath: "/retire-me",
        origin: "old_default_current",
        createdAt: FIXED_NOW,
      })
    })
    await publish(site, retireId, "fr")
    expect(await resolveAs(t, "fr", "/retire-me")).toMatchObject({
      disposition: "current",
    })
    expect(
      (await t.run((ctx) => ctx.db.get(row)))!.retiredAt
    ).toEqual(expect.any(Number))
    await withdraw(site, retireId, "fr")
    expect(await resolveAs(t, "fr", "/retire-me")).toEqual({
      authority: "snapshot_active",
      disposition: "unclaimed",
    })
    void homeId
  })

  test("4c. known limit: an old pointed row answers again when N later unpublishes a path it never shadowed", async () => {
    const site = await mlSite()
    const { t, aboutId, owner } = site
    // fr already publishes /taken before the switch, so no claim retires or
    // shadows the pointed row for it.
    const takenId = await createPage(owner, "taken", ["fr"])
    await publish(site, takenId, "fr")
    await storePointedGeneration(t, "en", "fr", [
      { fromPath: "/taken", pageId: aboutId },
    ])
    await setDefault(site, "fr")
    expect(await resolveAs(t, "fr", "/taken")).toMatchObject({
      disposition: "current",
    })
    await withdraw(site, takenId, "fr")
    // U3 (D3a): about is current in fr, so the request locale wins.
    expect(await resolveAs(t, "fr", "/taken")).toMatchObject({
      disposition: "historical_redirect",
      pageId: aboutId,
      locale: "fr",
    })
  })

  test("5. F08 frozen home aliases validate independent of the current default", async () => {
    const site = await mlSite()
    const { t, homeId } = site
    const snapshotId = (await localeState(t, homeId, "fr")).currentSnapshotId!
    await t.run((ctx) =>
      ctx.db.insert("pageHistoricalLocaleRoutes", {
        pageId: homeId,
        locale: "fr",
        fromPath: "/accueil",
        createdFromSnapshotId: snapshotId,
        createdAt: FIXED_NOW,
      })
    )
    const expected = async () => {
      const state = await localeState(t, homeId, "fr")
      return {
        authority: "snapshot_active",
        disposition: "historical_redirect",
        pageId: homeId,
        locale: "fr",
        snapshotId: state.currentSnapshotId,
        publicGeneration: state.publicGeneration,
        destinationPath: "/",
        statusCode: 307,
      }
    }
    // fr is not the default: the localized alias is valid today.
    expect(await resolveAs(t, "fr", "/accueil")).toEqual(await expected())
    // en -> fr: the stored alias is still valid.
    await setDefault(site, "fr")
    expect(await resolveAs(t, "fr", "/accueil")).toEqual(await expected())
    // and back: fr -> en leaves it valid.
    await setDefault(site, "en")
    expect(await resolveAs(t, "fr", "/accueil")).toEqual(await expected())
    // A path that was never an alias stays unavailable.
    await t.run((ctx) =>
      ctx.db.insert("pageHistoricalLocaleRoutes", {
        pageId: homeId,
        locale: "fr",
        fromPath: "/nimporte-quoi",
        createdFromSnapshotId: snapshotId,
        createdAt: FIXED_NOW,
      })
    )
    expect(await resolveAs(t, "fr", "/nimporte-quoi")).toEqual({
      authority: "snapshot_active",
      disposition: "historical_unavailable",
    })
  })

  test("6. a later C3b start is refused up front when a silent switch superseded the F09 transition", async () => {
    const site = await mlSite()
    const { t, owner, aboutId } = site
    await storeF09Continuity(t, "en", [
      { fromPath: "/uber-uns", pageId: aboutId },
    ])
    const start = (toLocale: string) => async () =>
      owner.mutation(api.cms.multilingual.startDefaultLanguageMigration, {
        toLocale,
        ...(await tokens(t)),
      })
    // Control: F09 target equals the current default, so a start works.
    const control = await outcome(async () => {
      const result = await start("fr")()
      return typeof result.migrationId
    })
    expect(control).toEqual({ ok: "string" })
    await t.run(async (ctx) => {
      const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
      const migrationId = authority.activeDefaultMigrationId!
      await ctx.db.patch(authority._id, { activeDefaultMigrationId: undefined })
      await ctx.db.delete(migrationId)
    })
    await drain(t)

    await setDefault(site, "fr")
    expect(await refusalWritesNothing(t, start("en"))).toEqual(
      refused("DEFAULT_MIGRATION_SUPERSEDED")
    )
    // A pointer present, or a transition whose target is current, passes.
    const migrationId = await storePointedGeneration(t, "en", "fr", [])
    expect(migrationId).toBeDefined()
    expect(await outcome(start("en"))).toMatchObject({
      ok: { migrationId: expect.any(String) },
    })
  })
})

describe("U2 setDefaultLanguage: lifecycle drain", () => {
  async function withOrigin(site: Site) {
    await site.t.run(async (ctx) => {
      // Earlier module and adoption intents are not under test here.
      for (const row of await ctx.db
        .query("siteLanguageLifecycleIntents")
        .collect()) {
        await ctx.db.delete(row._id)
      }
      const settings = (await ctx.db.query("siteSettings").unique())!
      await ctx.db.patch(settings._id, { siteUrl: ORIGIN })
    })
  }
  function okFetch() {
    const fetchMock = vi.fn<
      (url: string, init: RequestInit) => Promise<Response>
    >(async () => new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchMock)
    return fetchMock
  }
  const bodies = (fetchMock: ReturnType<typeof okFetch>) =>
    fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init.body)))
  const runDrain = (t: T) =>
    t.action(internal.cms.languageLifecycle.drainLanguageLifecycleIntents, {})
  const sitemapBuilds = async (t: T) =>
    (
      await t.run((ctx) =>
        ctx.db.system.query("_scheduled_functions").collect()
      )
    ).filter((job) => job.name.includes("requestSitemapManifestBuild"))
  const defaultChange = async (t: T, version: number) =>
    (await intentRows(t)).find(
      (row) => row.operationId === `default_change:v${version}`
    ) as Doc<"siteLanguageLifecycleIntents">

  test("7. tags and layout, then roots, then the sitemap build, then complete", async () => {
    const site = await mlSite()
    const { t, owner } = site
    await withOrigin(site)
    await setDefault(site, "fr")
    const version = (await authorityRow(t)).version
    const fetchMock = okFetch()
    const buildsBefore = (await sitemapBuilds(t)).length
    await runDrain(t)
    // After the switch fr is unprefixed and en is prefixed.
    expect(bodies(fetchMock)).toEqual([
      {
        layoutPaths: ["/(public)/[locale]"],
        tags: ["cms:pages", "cms:menus", "cms:settings"],
      },
      { paths: ["/", "/en"] },
    ])
    expect(await defaultChange(t, version)).toMatchObject({
      status: "delivered",
      phase: "complete",
      attempts: 1,
    })
    expect((await sitemapBuilds(t)).length).toBe(buildsBefore + 1)
    expect(
      await owner.query(api.cms.languageLifecycle.getLanguageLifecycleStatus, {
        operationId: `default_change:v${version}`,
      })
    ).toMatchObject({
      updating: false,
      operation: {
        operationKind: "default_change",
        status: "delivered",
      },
    })
  })

  test("7a. the drain sequence is the same when the new default has no published home", async () => {
    const site = await mlSite()
    const { t, homeId } = site
    await withOrigin(site)
    await withdraw(site, homeId, "fr")
    await setDefault(site, "fr")
    const version = (await authorityRow(t)).version
    const fetchMock = okFetch()
    await runDrain(t)
    expect(bodies(fetchMock)).toEqual([
      {
        layoutPaths: ["/(public)/[locale]"],
        tags: ["cms:pages", "cms:menus", "cms:settings"],
      },
      { paths: ["/", "/en"] },
    ])
    expect(await defaultChange(t, version)).toMatchObject({
      status: "delivered",
      phase: "complete",
    })
  })

  test("7b. an HTTP failure retries the same intent from its phase", async () => {
    const site = await mlSite()
    const { t } = site
    await withOrigin(site)
    await setDefault(site, "fr")
    const version = (await authorityRow(t)).version
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 }))
    )
    await runDrain(t)
    const failed = await defaultChange(t, version)
    expect(failed).toMatchObject({
      status: "failed",
      phase: "tags_and_layout",
      attempts: 1,
    })
    vi.setSystemTime(failed.updatedAt + LANGUAGE_LIFECYCLE_RETRY_DELAY_MS + 1)
    const fetchMock = okFetch()
    await runDrain(t)
    expect(bodies(fetchMock)).toEqual([
      {
        layoutPaths: ["/(public)/[locale]"],
        tags: ["cms:pages", "cms:menus", "cms:settings"],
      },
      { paths: ["/", "/en"] },
    ])
    expect(await defaultChange(t, version)).toMatchObject({
      status: "delivered",
      phase: "complete",
      attempts: 2,
    })
  })

  test("7c. a rapid D to N to D completes both intents", async () => {
    const site = await mlSite()
    const { t } = site
    await withOrigin(site)
    await setDefault(site, "fr")
    await setDefault(site, "en")
    const versions = (await intentRows(t))
      .filter((row) => row.operationKind === "default_change")
      .map((row) => row.operationId)
    expect(versions).toHaveLength(2)
    const fetchMock = okFetch()
    for (let i = 0; i < 3; i += 1) {
      vi.setSystemTime(Date.now() + LANGUAGE_LIFECYCLE_RETRY_DELAY_MS + 1)
      await runDrain(t)
    }
    expect(fetchMock).toHaveBeenCalled()
    const changes = (await intentRows(t)).filter(
      (row) => row.operationKind === "default_change"
    )
    expect(changes.map((row) => [row.status, row.phase])).toEqual([
      ["delivered", "complete"],
      ["delivered", "complete"],
    ])
  })
})


test("enabled M05 without authority refuses as not adopted without writes", async () => {
  const { t, owner } = await mlSite()
  const expected = await tokens(t)
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query("siteLanguageAuthority").collect()) {
      await ctx.db.delete("siteLanguageAuthority", row._id)
    }
  })
  expect((await owner.query(api.cms.modules.effective, {})).modules)
    .toContainEqual({ id: "multilingual", outcome: "on" })
  expect(await refusalWritesNothing(t, () => owner.mutation(
    api.cms.multilingual.setDefaultLanguage,
    { toLocale: "fr", ...expected }
  ))).toEqual(refused("MULTILINGUAL_NOT_ADOPTED"))
})
