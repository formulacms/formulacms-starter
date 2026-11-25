/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { blockProfileAny, createInstalledSampleBlock } from "../test-utils/block-profile"
import { INSTALLED_BLOCK_TYPES } from "./lib/blocks"
import { convexTest } from "../convexTestWithExplicitAdmin"
import { api, internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import schema from "./schema"

const modules = import.meta.glob("./**/*.ts")
const OWNER = { subject: "home-owner", tokenIdentifier: "home-owner" }
const setup = { siteName: "Atelier Lune", timezone: "UTC", defaultLocale: "en" }
type T = ReturnType<typeof convexTest>
type Caller = ReturnType<T["withIdentity"]>
const apps: T[] = []

beforeEach(() => { vi.useFakeTimers() })
afterEach(async () => {
  try {
    for (const t of apps) await t.finishAllScheduledFunctions(vi.runAllTimers)
  } finally {
    apps.length = 0
    vi.useRealTimers()
  }
})

function app() {
  const t = convexTest({ schema, modules, ownerIdentity: OWNER, publicationAuthority: "missing" })
  apps.push(t)
  return { t, owner: t.withIdentity(OWNER) }
}

async function installed() {
  const f = app()
  await f.owner.mutation(api.cms.settings.bootstrapInstallation, setup)
  const config = await f.t.query(api.cms.settings.getSiteConfig, {})
  return { ...f, homeId: config.homePageId! }
}

async function rows(t: T, pageId: Id<"pages">, locale: string) {
  return t.run(async (ctx) => ({
    state: await ctx.db.query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) => q.eq("pageId", pageId).eq("locale", locale)).unique(),
    draft: await ctx.db.query("pageLocaleDrafts")
      .withIndex("by_pageId_and_locale", (q) => q.eq("pageId", pageId).eq("locale", locale)).unique(),
    shared: await ctx.db.query("pageSharedDrafts")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId)).unique(),
    page: await ctx.db.query("pagePublicationPageStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId)).unique(),
    snapshots: await ctx.db.query("pagePublishedSnapshots")
      .withIndex("by_pageId_and_locale_and_generation", (q) => q.eq("pageId", pageId).eq("locale", locale)).take(10),
  }))
}

async function publicHome(t: T, locale: string) {
  const { languageVersion } = await t.query(api.cms.settings.getSiteConfig, {})
  const pageId = await t.query(api.cms.pages.resolveLocalizedPathQuery, { path: "/", locale, languageVersion })
  return pageId ? t.query(api.cms.pages.getPublicPageById, { id: pageId, locale, languageVersion }) : null
}

async function enable(owner: Caller) {
  const changes = [{ moduleId: "multilingual", enabled: true }]
  const preview = await owner.query(api.cms.modules.preview, { changes })
  await owner.mutation(api.cms.modules.commit, { changes, expectedConfigurationVersion: preview.configurationVersion })
}

async function adopt(owner: Caller) {
  const preview = await owner.query(api.cms.multilingual.previewAdoption, {})
  if (!preview.canAdopt) throw new Error("Cannot adopt fixture")
  const { canAdopt, defaultLocale, enabledLocales, ...tokens } = preview
  void canAdopt; void defaultLocale; void enabledLocales
  await owner.mutation(api.cms.multilingual.adoptMultilingualAuthority, tokens)
}

/** Capture the outer language transaction, including a possible adoption. */
async function languageRows(t: T) {
  return t.run(async (ctx) => ({
    settings: await ctx.db.query("siteSettings").collect(),
    authority: await ctx.db.query("siteLanguageAuthority").collect(),
    modules: await ctx.db.query("cmsModuleState").collect(),
    states: await ctx.db.query("pageLocalePublicationStates").collect(),
    drafts: await ctx.db.query("pageLocaleDrafts").collect(),
    shared: await ctx.db.query("pageSharedDrafts").collect(),
    snapshots: await ctx.db.query("pagePublishedSnapshots").collect(),
    candidates: await ctx.db.query("pageLocalePublicationCandidates").collect(),
    references: await ctx.db.query("pagePublicationDocumentReferences").collect(),
    releases: await ctx.db.query("pageLocalePublicationReleases").collect(),
    previews: await ctx.db.query("siteLanguageImpactPreviews").collect(),
    lifecycleIntents: await ctx.db.query("siteLanguageLifecycleIntents").collect(),
    intents: await ctx.db.query("pagePublicationRevalidationIntents").collect(),
  }))
}

async function add(owner: Caller, command: "addLanguage" | "addSiteLanguage", preview?: {
  previewId: Id<"siteLanguageImpactPreviews">, expectedDigest: string,
  expectedCount: { publicPages: number, routes: number, manualRules: number, menus: number },
}) {
  const { commandTokens: tokens } = await owner.query(api.cms.multilingual.getMultilingualState, {})
  if (command === "addSiteLanguage") {
    const result = await owner.mutation(api.cms.multilingual.addSiteLanguage, {
      locale: "fr", expectedSettingsUpdatedAt: tokens.settingsUpdatedAt!,
      expectedAuthorityVersion: tokens.authorityVersion,
      expectedModuleConfigurationVersion: tokens.moduleConfigurationVersion,
    })
    expect(result.ok).toBe(true)
    return result
  }
  return owner.mutation(api.cms.multilingual.addLanguage, {
    locale: "fr", expectedAuthorityVersion: tokens.authorityVersion!,
    expectedModuleConfigurationVersion: tokens.moduleConfigurationVersion,
    ...(preview ? { preview } : {}),
  })
}

describe("B52 empty published Home", () => {
  test("fresh setup resolves Home publicly and exact retry does not publish twice", async () => {
    const { t, owner, homeId } = await installed()
    const before = await rows(t, homeId, "en")
    expect(before.state).toMatchObject({ hasCurrentSnapshot: true, publicGeneration: 1 })
    expect(before.draft).toBeNull()
    expect(before.snapshots).toHaveLength(1)
    expect(await publicHome(t, "en")).toMatchObject({ _id: homeId, content: { en: { title: "Atelier Lune", blocks: [] } } })
    await expect(owner.mutation(api.cms.settings.bootstrapInstallation, setup)).resolves.toMatchObject({ phase: "snapshot_active" })
    expect(await rows(t, homeId, "en")).toEqual(before)
  })

  test("setup retry preserves the published Home and the owner's newer draft", async () => {
    const { t, owner, homeId } = await installed()
    const published = await rows(t, homeId, "en")
    await owner.mutation(api.cms.publication.saveLocaleDraft, {
      pageId: homeId, locale: "en", slug: "home",
      expectedDraftGeneration: published.state!.draftGeneration,
      expectedLifecycleGeneration: published.page!.lifecycleGeneration,
      draft: { pageType: "landing-page", localized: { title: "Atelier Lune draft" }, blocks: [] },
    })
    const before = await rows(t, homeId, "en")
    expect(before.draft?.content).toMatchObject({ title: "Atelier Lune draft", blocks: [] })
    await expect(owner.mutation(api.cms.settings.bootstrapInstallation, setup)).resolves.toMatchObject({ phase: "snapshot_active" })
    const after = await rows(t, homeId, "en")
    expect(after.state?.currentSnapshotId).toBe(published.state!.currentSnapshotId)
    expect(after.state?.publicGeneration).toBe(published.state!.publicGeneration)
    expect(after.draft?.content).toMatchObject({ title: "Atelier Lune draft", blocks: [] })
    expect(after.snapshots).toHaveLength(1)
    expect(after).toEqual(before)
    expect(await publicHome(t, "en")).toMatchObject({ _id: homeId, content: { en: { title: "Atelier Lune", blocks: [] } } })
  })

  test("resuming a pre-B52 draft setup publishes exactly once", async () => {
    const { t, owner } = app()
    await owner.mutation(api.cms.publication.initializeEmptySnapshotAuthority, {})
    const homeId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page", status: "draft", slug: "home",
      content: { en: { title: "Atelier Lune", blocks: [] } },
    })
    await t.run(async (ctx) => {
      const now = Date.now()
      await ctx.db.insert("siteSettings", {
        ...setup, siteUrl: "", enabledLocales: ["en"], homePageId: homeId,
        onboardingCompletedAt: now, updatedAt: now,
      })
    })
    expect((await rows(t, homeId, "en")).state?.hasCurrentSnapshot).toBe(false)
    await owner.mutation(api.cms.settings.bootstrapInstallation, setup)
    const published = await rows(t, homeId, "en")
    expect(published.draft).toBeNull()
    expect(published.snapshots).toHaveLength(1)
    expect(await publicHome(t, "en")).toMatchObject({ _id: homeId, content: { en: { blocks: [] } } })
    await owner.mutation(api.cms.settings.bootstrapInstallation, setup)
    expect(await rows(t, homeId, "en")).toEqual(published)
  })

  test.each(["addLanguage", "addSiteLanguage"] as const)("%s publishes only the newly added French Home", async (command) => {
    const { t, owner, homeId } = await installed()
    await enable(owner)
    if (command === "addLanguage") await adopt(owner)
    const english = await rows(t, homeId, "en")
    await add(owner, command)
    expect(await rows(t, homeId, "en")).toEqual(english)
    expect((await rows(t, homeId, "fr")).state).toMatchObject({ hasCurrentSnapshot: true, publicGeneration: 1 })
    expect(await publicHome(t, "fr")).toMatchObject({ _id: homeId, content: { fr: { title: "Atelier Lune", blocks: [] } } })
  })

  test.each(["addLanguage", "addSiteLanguage"] as const)("%s rolls back when a retained Home address blocks publication", async (command) => {
    const { t, owner, homeId: oldHomeId } = await installed()
    await enable(owner)
    const homeId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page", status: "draft", slug: "new-home",
      content: { en: { title: "New Home", blocks: [] } },
    })
    // Like the migration fixtures, retain a former Home's root selection.
    await t.run(async (ctx) => {
      const state = (await ctx.db.query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) => q.eq("pageId", oldHomeId).eq("locale", "en")).unique())!
      const { _id, _creationTime, ...selection } = state
      void _id; void _creationTime
      await ctx.db.insert("pageLocalePublicationStates", { ...selection, locale: "fr" })
      const settings = (await ctx.db.query("siteSettings").unique())!
      await ctx.db.patch("siteSettings", settings._id, { homePageId: homeId })
    })
    let preview
    if (command === "addLanguage") {
      await adopt(owner)
      const { previewId } = await owner.mutation(api.cms.multilingual.startLanguageImpactPreview, { kind: "reveal", locale: "fr" })
      let row = await t.run((ctx) => ctx.db.get("siteLanguageImpactPreviews", previewId))
      while (row!.phase === "scanning") {
        await t.mutation(internal.cms.multilingual.stepLanguageImpactPreview, { previewId, generation: row!.generation })
        row = await t.run((ctx) => ctx.db.get("siteLanguageImpactPreviews", previewId))
      }
      expect(row!.phase).toBe("complete")
      for (let ordinal = 0; ordinal < row!.pageCount; ordinal++) {
        const page = await owner.query(api.cms.multilingual.listLanguageImpact, { previewId, ordinal })
        if (page.stale) throw new Error("Fixture preview became stale")
        await owner.mutation(api.cms.multilingual.recordLanguageImpactReview, { previewId, ordinal, pageDigest: page.digest })
      }
      preview = { previewId, expectedDigest: row!.digest, expectedCount: row!.count }
    }
    const before = await languageRows(t)
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(add(owner, command, preview)).rejects.toMatchObject({ data: "LANGUAGE_HOME_NOT_PUBLISHED" })
      expect(await languageRows(t)).toEqual(before)
      expect((await owner.query(api.cms.multilingual.getMultilingualState, {})).enabledLocales).not.toContain("fr")
      expect((await rows(t, homeId, "fr")).state).toBeNull()
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("fr"), "PAGE_ADDRESS_LOOKUP_LIMIT")
    } finally {
      warning.mockRestore()
    }
  })

  test.each(["kept", "withdrawn"] as const)("adding back French preserves its %s Home content", async (retained) => {
    const { t, owner, homeId } = await installed()
    await enable(owner)
    await add(owner, "addSiteLanguage")
    const original = await rows(t, homeId, "fr")
    const saved = await owner.mutation(api.cms.publication.saveLocaleDraft, {
      pageId: homeId, locale: "fr", slug: "accueil",
      expectedDraftGeneration: original.state!.draftGeneration,
      expectedLifecycleGeneration: original.page!.lifecycleGeneration,
      draft: { pageType: "landing-page", localized: { title: "Maison conservée" }, blocks: [] },
    })
    await owner.mutation(api.cms.publication.publishLocale, {
      pageId: homeId, locale: "fr", expectedDraftGeneration: saved.generation,
      expectedSharedDraftGeneration: original.shared!.generation,
      expectedPublicGeneration: original.state!.publicGeneration,
      expectedReleaseGeneration: original.state!.releaseGeneration,
      expectedLifecycleGeneration: original.page!.lifecycleGeneration,
    })
    if (retained === "withdrawn") {
      // Pre-existing private content, not a now-forbidden owner withdrawal.
      await t.run(async (ctx) => {
        const state = (await ctx.db.query("pageLocalePublicationStates")
          .withIndex("by_pageId_and_locale", (q) => q.eq("pageId", homeId).eq("locale", "fr")).unique())!
        await ctx.db.patch("pageLocalePublicationStates", state._id, {
          hasCurrentSnapshot: false, currentSnapshotId: undefined,
          currentReleaseId: undefined, currentPath: undefined,
          currentPublishedAt: undefined, pageType: undefined, publicSince: undefined,
          publicGeneration: state.publicGeneration + 1,
        })
      })
    }
    // A removed-language fixture retains all of the owner's publication rows.
    await t.run(async (ctx) => {
      const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
      const settings = (await ctx.db.query("siteSettings").unique())!
      await ctx.db.patch("siteLanguageAuthority", authority._id, { enabledLocales: ["en"], version: authority.version + 1 })
      await ctx.db.patch("siteSettings", settings._id, { enabledLocales: ["en"] })
    })
    const before = await rows(t, homeId, "fr")
    if (retained === "kept") {
      await add(owner, "addSiteLanguage")
    } else {
      const languageBefore = await languageRows(t)
      await expect(add(owner, "addSiteLanguage")).rejects.toMatchObject({ data: "LANGUAGE_HOME_NOT_PUBLISHED" })
      expect(await languageRows(t)).toEqual(languageBefore)
    }
    expect(await rows(t, homeId, "fr")).toEqual(before)
  })

  test.each(["one_language", "inactive", "draft_only", "no_home", "missing_home", "missing_shared", "duplicate_shared", "missing_page_state"] as const)("language add handles %s without exposing private content", async (skip) => {
    const { t, owner, homeId } = await installed()
    await enable(owner)
    await t.run(async (ctx) => {
      const settings = (await ctx.db.query("siteSettings").unique())!
      if (skip === "one_language") await ctx.db.patch("siteSettings", settings._id, { untranslatedContentTypes: [{ pageType: "landing-page", locale: "en" }] })
      if (skip === "no_home") await ctx.db.patch("siteSettings", settings._id, { homePageId: undefined })
      if (skip === "missing_home") await ctx.db.delete("pages", homeId)
      if (skip === "missing_shared" || skip === "duplicate_shared") {
        const shared = (await ctx.db.query("pageSharedDrafts").withIndex("by_pageId", (q) => q.eq("pageId", homeId)).unique())!
        if (skip === "missing_shared") await ctx.db.delete("pageSharedDrafts", shared._id)
        else {
          const { _id, _creationTime, ...copy } = shared
          void _id; void _creationTime
          await ctx.db.insert("pageSharedDrafts", copy)
        }
      }
      if (skip === "missing_page_state") {
        const page = (await ctx.db.query("pagePublicationPageStates").withIndex("by_pageId", (q) => q.eq("pageId", homeId)).unique())!
        await ctx.db.delete("pagePublicationPageStates", page._id)
      }
      if (skip === "inactive") {
        const page = await ctx.db.query("pagePublicationPageStates")
          .withIndex("by_pageId", (q) => q.eq("pageId", homeId)).unique()
        await ctx.db.patch("pagePublicationPageStates", page!._id, { lifecycleState: "archived" })
      }
      if (skip === "draft_only") {
        const draft = (await ctx.db.query("pageSharedDrafts").withIndex("by_pageId", (q) => q.eq("pageId", homeId)).unique())!
        await ctx.db.insert("pageLocaleDrafts", {
          pageId: homeId, locale: "fr", pageType: "landing-page", generation: 1,
          slug: "accueil", content: { title: "Texte conservé", blocks: [] },
          updatedBy: draft.updatedBy, createdAt: Date.now(), updatedAt: Date.now(),
        })
      }
    })
    const before = await languageRows(t)
    if (skip === "one_language") {
      await add(owner, "addSiteLanguage")
      expect((await rows(t, homeId, "fr")).state?.hasCurrentSnapshot).toBe(true)
      expect(await publicHome(t, "fr")).toMatchObject({ _id: homeId })
    } else if (skip === "no_home") {
      await add(owner, "addSiteLanguage")
      expect((await rows(t, homeId, "fr")).state).toBeNull()
    } else {
      await expect(add(owner, "addSiteLanguage")).rejects.toMatchObject({ data: "LANGUAGE_HOME_NOT_PUBLISHED" })
      expect(await languageRows(t)).toEqual(before)
    }
  })

  test("publishing English blocks leaves the French Home empty", blockProfileAny(INSTALLED_BLOCK_TYPES), async () => {
    const { t, owner, homeId } = await installed()
    await enable(owner)
    await add(owner, "addSiteLanguage")
    const french = await rows(t, homeId, "fr")
    const { state, shared, page } = await rows(t, homeId, "en")
    const saved = await owner.mutation(api.cms.publication.saveLocaleDraft, {
      pageId: homeId, locale: "en", slug: "home",
      expectedDraftGeneration: state!.draftGeneration, expectedLifecycleGeneration: page!.lifecycleGeneration,
      draft: { pageType: "landing-page", localized: { title: "Atelier Lune" }, blocks: [createInstalledSampleBlock(INSTALLED_BLOCK_TYPES[0]!)] },
    })
    await owner.mutation(api.cms.publication.publishLocale, {
      pageId: homeId, locale: "en", expectedDraftGeneration: saved.generation,
      expectedSharedDraftGeneration: shared!.generation, expectedPublicGeneration: state!.publicGeneration,
      expectedReleaseGeneration: state!.releaseGeneration, expectedLifecycleGeneration: page!.lifecycleGeneration,
    })
    expect(await publicHome(t, "en")).toMatchObject({ content: { en: { blocks: [expect.anything()] } } })
    expect(await publicHome(t, "fr")).toMatchObject({ content: { fr: { blocks: [] } } })
    expect(await rows(t, homeId, "fr")).toEqual(french)
  })
})
