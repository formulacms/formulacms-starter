/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { api, internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import migrationsTest from "@convex-dev/migrations/test"
import { convexTest } from "../convexTestWithExplicitAdmin"
import {
  digestLocalePublicationCandidate,
  reconstructLocalePublicationCandidate,
  serializeLocalePublicationCandidate,
} from "./lib/publishing/localeCandidate"
import { ensurePageBackfilled } from "./lib/publishing/perLanguageBackfill"
import schema from "./schema"

// ADR-0037 amendment (2026-11-17): the social share title and description,
// noindex, nofollow, structured data, keywords, card excerpt and post category
// belong to each language. These tests cover the one-time backfill of the old
// shared values, the readers of snapshots written before the change, and the
// writers that follow it. Library behavior (the migrations component, Convex
// transactions) is not tested here.

const modules = import.meta.glob("./**/*.ts")
const OWNER = { subject: "plf-owner", tokenIdentifier: "plf-owner" }
const FIXED_NOW = Date.UTC(2026, 10, 17, 12, 0, 0)

type T = ReturnType<typeof convexTest>
type Caller = ReturnType<T["withIdentity"]>
type Site = { t: T; owner: Caller; locales: string[] }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(FIXED_NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

async function drain(t: T) {
  await t.finishAllScheduledFunctions(vi.runAllTimers, 2_000)
}

async function clocks(site: Site, pageId: Id<"pages">, locale: string) {
  return site.t.run(async (ctx) => {
    const state = await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", locale)
      )
      .unique()
    const shared = (await ctx.db
      .query("pageSharedDrafts")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .unique())!
    const page = (await ctx.db
      .query("pagePublicationPageStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .unique())!
    return { state, shared, page }
  })
}

async function publish(site: Site, pageId: Id<"pages">, locale: string) {
  const { state, shared, page } = await clocks(site, pageId, locale)
  await site.owner.mutation(api.cms.publication.publishLocale, {
    pageId,
    locale,
    expectedDraftGeneration: state!.draftGeneration,
    expectedSharedDraftGeneration: shared.generation,
    expectedPublicGeneration: state!.publicGeneration,
    expectedLifecycleGeneration: page.lifecycleGeneration,
    expectedReleaseGeneration: state!.releaseGeneration,
  })
}

async function createPage(
  site: Site,
  slug: string,
  locales: readonly string[] = site.locales
): Promise<Id<"pages">> {
  return site.owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug,
    title: slug,
    content: Object.fromEntries(
      locales.map((locale) => [
        locale,
        { title: `${slug} ${locale}`, blocks: [] },
      ])
    ),
  })
}

/** Snapshot authority, `locales` enabled, the first as the default. */
async function snapshotSite(locales: readonly string[]): Promise<Site> {
  const t = convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
    publicationAuthority: "missing",
  })
  migrationsTest.register(t)
  const owner = t.withIdentity(OWNER)
  await owner.mutation(api.cms.publication.initializeEmptySnapshotAuthority, {})
  const site = { t, owner, locales: [...locales] }
  const homeId = await createPage(site, "home")
  await t.run((ctx) =>
    ctx.db.insert("siteSettings", {
      siteName: "PLF site",
      siteUrl: "",
      defaultLocale: locales[0]!,
      enabledLocales: [...locales],
      homePageId: homeId,
      updatedAt: FIXED_NOW,
    })
  )
  await publish(site, homeId, locales[0]!)
  await drain(t)
  return site
}

const LEGACY_SEO = {
  noIndex: true,
  ogTitle: "Social title",
  ogDescription: "Social description",
  structuredData: '{"@type":"Thing"}',
  keywords: ["alpha"],
  focusKeyword: "alpha",
  metaTitle: "Legacy meta title",
  metaDescription: "Legacy meta description",
  ogImage: "/shared-social.png",
} as const

/**
 * Put the pre-upgrade shape on a page: old shared values in the Shared Draft,
 * and no backfill marker. New pages are born with the marker, so a test of the
 * upgrade removes it.
 */
async function makeLegacy(
  site: Site,
  pageId: Id<"pages">,
  shared: { seo?: Record<string, unknown>; cardExcerpt?: string } = {
    seo: { ...LEGACY_SEO },
    cardExcerpt: "Legacy card excerpt",
  }
) {
  await site.t.run(async (ctx) => {
    const draft = (await ctx.db
      .query("pageSharedDrafts")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .unique())!
    await ctx.db.patch("pageSharedDrafts", draft._id, {
      system: {
        ...draft.system,
        ...(shared.seo ? { seo: shared.seo } : {}),
        ...(shared.cardExcerpt ? { cardExcerpt: shared.cardExcerpt } : {}),
      },
    } as never)
    const state = (await ctx.db
      .query("pagePublicationPageStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .unique())!
    await ctx.db.patch("pagePublicationPageStates", state._id, {
      perLanguageFieldsBackfill: undefined,
    })
  })
}

/**
 * Rewrite the current snapshot of a language into the pre-upgrade shape: the
 * old values in the shared blocks and none in the Localized Content.
 */
async function makeSnapshotLegacy(
  site: Site,
  pageId: Id<"pages">,
  locale: string,
  shared: {
    seo?: Record<string, unknown>
    cardExcerpt?: string
    category?: string
  } = { seo: { ...LEGACY_SEO }, cardExcerpt: "Legacy card excerpt" }
) {
  await site.t.run(async (ctx) => {
    const state = (await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", locale)
      )
      .unique())!
    const snapshot = (await ctx.db.get(
      "pagePublishedSnapshots",
      state.currentSnapshotId!
    ))!
    const candidate = (await ctx.db.get(
      "pageLocalePublicationCandidates",
      snapshot.candidateId
    ))!
    const payload = (await reconstructLocalePublicationCandidate(candidate))!
    delete payload.localized.content.seo
    delete payload.localized.content.cardExcerpt
    delete payload.localized.content.category
    if (shared.seo) payload.shared.system.seo = shared.seo
    if (shared.cardExcerpt)
      payload.shared.system.cardExcerpt = shared.cardExcerpt
    if (shared.category) payload.shared.descriptor.category = shared.category
    const { payloadJson, payloadBytes } =
      serializeLocalePublicationCandidate(payload)
    const digest = await digestLocalePublicationCandidate(payloadJson)
    await ctx.db.patch("pageLocalePublicationCandidates", candidate._id, {
      payloadJson,
      payloadBytes,
      digest,
    })
    await ctx.db.patch("pagePublishedSnapshots", snapshot._id, {
      candidateDigest: digest,
    })
  })
}

async function publicSeo(site: Site, pageId: Id<"pages">, locale: string) {
  const page = await site.t.query(api.cms.pages.getPublicPageById, {
    id: pageId,
    locale,
    languageVersion: 0,
  })
  return page ? { seo: page.seo, content: page.content[locale] } : null
}

function alternatesOf(site: Site, pageId: Id<"pages">) {
  return site.t.query(api.cms.pages.getPublicLocaleAlternates, {
    pageId,
    languageVersion: 0,
  })
}

/** The sitemap entries of a page in every enabled language, as the sitemap reader renders them. */
async function sitemapOf(site: Site, pageId: Id<"pages">) {
  return site.t.run(async (ctx) => {
    const { renderSitemapRows } = await import("./cms/pages")
    const settings = (await ctx.db.query("siteSettings").unique())!
    const cfg = {
      defaultLocale: settings.defaultLocale,
      enabledLocales: settings.enabledLocales,
      homePageId: settings.homePageId ?? null,
    }
    const out: Record<string, unknown> = {}
    for (const locale of settings.enabledLocales) {
      const row = (await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", locale)
        )
        .unique())!
      out[locale] = await renderSitemapRows(ctx, [row], locale, cfg)
    }
    return out as Record<
      string,
      Array<{ url: string; alternates: Array<{ locale: string; url: string }> }>
    >
  })
}

async function draftRow(site: Site, pageId: Id<"pages">, locale: string) {
  return site.t.run((ctx) =>
    ctx.db
      .query("pageLocaleDrafts")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", locale)
      )
      .unique()
  )
}

async function saveLocale(
  site: Site,
  pageId: Id<"pages">,
  locale: string,
  extra: { seo?: Record<string, unknown>; cardExcerpt?: string } = {},
  title = `edited ${locale}`
) {
  const { state, page } = await clocks(site, pageId, locale)
  return site.owner.mutation(api.cms.publication.saveLocaleDraft, {
    pageId,
    locale,
    slug: "about",
    draft: {
      pageType: "landing-page",
      localized: { title },
      blocks: [],
      ...extra,
    } as never,
    expectedDraftGeneration: state?.draftGeneration ?? 0,
    expectedLifecycleGeneration: page.lifecycleGeneration,
  })
}

async function runBackfill(site: Site) {
  const result = await site.t.mutation(
    internal.lib.publishing.perLanguageBackfill
      .startPerLanguageFieldsBackfillIfNeeded,
    {}
  )
  await drain(site.t)
  return result
}

describe("backfill of the old shared values into Working Drafts", () => {
  test("two languages: text goes to the legacy language only, noindex to every draft", async () => {
    const site = await snapshotSite(["en", "fr"])
    const pageId = await createPage(site, "about")
    await makeLegacy(site, pageId)
    const sharedBefore = (await clocks(site, pageId, "en")).shared

    expect(await runBackfill(site)).toBe("started")

    const en = await draftRow(site, pageId, "en")
    const fr = await draftRow(site, pageId, "fr")
    expect(en!.content).toMatchObject({
      seo: {
        noIndex: true,
        ogTitle: "Social title",
        ogDescription: "Social description",
        structuredData: '{"@type":"Thing"}',
        keywords: ["alpha"],
        focusKeyword: "alpha",
      },
      cardExcerpt: "Legacy card excerpt",
      // The legacy meta text fills the empty meta only.
      metaTitle: "Legacy meta title",
      metaDescription: "Legacy meta description",
    })
    expect(fr!.content.seo).toEqual({ noIndex: true })
    expect(fr!.content).not.toHaveProperty("cardExcerpt")
    expect(fr!.content).not.toHaveProperty("metaTitle")
    // Published Snapshots and the Shared Draft are never rewritten.
    expect((await clocks(site, pageId, "en")).shared).toEqual(sharedBefore)
    const settings = await site.t.run((ctx) =>
      ctx.db.query("siteSettings").unique()
    )
    expect(settings!.legacySharedFieldsLocale).toBe("en")
    const marker = (await clocks(site, pageId, "en")).page
      .perLanguageFieldsBackfill
    expect(marker).toMatchObject({ draftsWritten: 2, skippedNoDraft: 0 })
  })

  test("a single-language site gets its values in the one draft", async () => {
    const site = await snapshotSite(["en"])
    const pageId = await createPage(site, "about")
    await makeLegacy(site, pageId)
    await runBackfill(site)
    expect((await draftRow(site, pageId, "en"))!.content).toMatchObject({
      seo: { noIndex: true, ogTitle: "Social title" },
      cardExcerpt: "Legacy card excerpt",
    })
  })

  test("the own value of a draft is never overwritten", async () => {
    const site = await snapshotSite(["en"])
    const pageId = await createPage(site, "about")
    await saveLocale(site, pageId, "en", {
      seo: { ogTitle: "Own title" },
      cardExcerpt: "Own excerpt",
    })
    await makeLegacy(site, pageId)
    await runBackfill(site)
    expect((await draftRow(site, pageId, "en"))!.content).toMatchObject({
      seo: { ogTitle: "Own title", ogDescription: "Social description" },
      cardExcerpt: "Own excerpt",
    })
  })

  test("a value the owner cleared is not refilled by a second run", async () => {
    const site = await snapshotSite(["en"])
    const pageId = await createPage(site, "about")
    await makeLegacy(site, pageId)
    await runBackfill(site)
    // The owner clears every value (an empty seo block clears; no excerpt).
    await saveLocale(site, pageId, "en", { seo: {}, cardExcerpt: "" })
    const cleared = (await draftRow(site, pageId, "en"))!.content
    expect(cleared).not.toHaveProperty("seo")
    expect(cleared).not.toHaveProperty("cardExcerpt")

    expect(await site.t.run((ctx) => ensurePageBackfilled(ctx, pageId))).toBe(
      "already_done"
    )
    await runBackfill(site)
    expect((await draftRow(site, pageId, "en"))!.content).toEqual(cleared)
  })

  test("a page published without a draft is untouched and counted", async () => {
    const site = await snapshotSite(["en", "fr"])
    const pageId = await createPage(site, "about")
    await publish(site, pageId, "en")
    await publish(site, pageId, "fr")
    await drain(site.t)
    expect(await draftRow(site, pageId, "en")).toBeNull()
    await makeLegacy(site, pageId)
    const before = await clocks(site, pageId, "en")

    await runBackfill(site)

    // No draft was created, the clocks did not move: nothing becomes
    // "Unpublished changes".
    expect(await draftRow(site, pageId, "en")).toBeNull()
    expect(await draftRow(site, pageId, "fr")).toBeNull()
    const after = await clocks(site, pageId, "en")
    expect(after.state).toEqual(before.state)
    expect(after.shared).toEqual(before.shared)
    expect(after.page.perLanguageFieldsBackfill).toMatchObject({
      draftsWritten: 0,
      skippedNoDraft: 1,
    })
    const edit = await site.owner.query(api.cms.pages.getForEdit, {
      id: pageId,
    })
    expect(edit!.hasStaging).toBe(false)
  })

  test("a draft is patched in place: no generation, time or badge change", async () => {
    const site = await snapshotSite(["en"])
    const pageId = await createPage(site, "about")
    await makeLegacy(site, pageId)
    const draftBefore = (await draftRow(site, pageId, "en"))!
    const stateBefore = (await clocks(site, pageId, "en")).state
    const editBefore = await site.owner.query(api.cms.pages.getForEdit, {
      id: pageId,
    })

    await runBackfill(site)

    const draftAfter = (await draftRow(site, pageId, "en"))!
    expect(draftAfter.generation).toBe(draftBefore.generation)
    expect(draftAfter.updatedAt).toBe(draftBefore.updatedAt)
    expect(draftAfter.updatedBy).toEqual(draftBefore.updatedBy)
    expect((await clocks(site, pageId, "en")).state).toEqual(stateBefore)
    const editAfter = await site.owner.query(api.cms.pages.getForEdit, {
      id: pageId,
    })
    expect(editAfter!.hasStaging).toBe(editBefore!.hasStaging)
    // The editor shows the same values before and after the backfill reached it.
    expect(editAfter!.page.content?.en).toEqual(editBefore!.page.content?.en)
  })

  test("the dry run counts the work and writes nothing", async () => {
    const site = await snapshotSite(["en", "fr"])
    const pageId = await createPage(site, "about")
    await makeLegacy(site, pageId)
    const count = await site.t.query(
      internal.lib.publishing.perLanguageBackfill
        .countPerLanguageFieldsBackfill,
      { paginationOpts: { numItems: 50, cursor: null } }
    )
    expect(count).toMatchObject({
      pending: 1,
      draftsToWrite: 2,
      pagesWithOldTextAndNoDraft: 0,
      isDone: true,
    })
    expect((await draftRow(site, pageId, "en"))!.content).not.toHaveProperty(
      "seo"
    )
    expect(
      (await clocks(site, pageId, "en")).page.perLanguageFieldsBackfill
    ).toBeUndefined()
  })

  test("saving an unmigrated page copies its old values first (migrate on touch)", async () => {
    const site = await snapshotSite(["en", "fr"])
    const pageId = await createPage(site, "about")
    await makeLegacy(site, pageId)
    // The save sends no seo: the stored (backfilled) values stay.
    await saveLocale(site, pageId, "en", {}, "New title")
    const content = (await draftRow(site, pageId, "en"))!.content
    expect(content).toMatchObject({
      title: "New title",
      seo: { noIndex: true, ogTitle: "Social title" },
      cardExcerpt: "Legacy card excerpt",
    })
    expect(
      (await clocks(site, pageId, "en")).page.perLanguageFieldsBackfill
    ).toBeDefined()
    // The other language got the robots choice only.
    expect((await draftRow(site, pageId, "fr"))!.content.seo).toEqual({
      noIndex: true,
    })
  })
})

describe("the readiness checklist", () => {
  async function seoWarnings(site: Site, pageId: Id<"pages">, locale: string) {
    const checklist = await site.owner.query(
      api.cms.pages.getPrePublishChecklist,
      { pageId, locale }
    )
    return checklist.warnings
      .map((item) => item.code)
      .filter((code) => code.startsWith("missing_seo_"))
  }

  test("each language is checked against its own meta text, before and after the backfill", async () => {
    const site = await snapshotSite(["en", "fr"])
    const pageId = await createPage(site, "about")
    await makeLegacy(site, pageId)

    // The old shared meta text counts for the legacy language only.
    expect(await seoWarnings(site, pageId, "en")).toEqual([])
    expect(await seoWarnings(site, pageId, "fr")).toEqual([
      "missing_seo_title",
      "missing_seo_description",
    ])

    await runBackfill(site)
    expect(await seoWarnings(site, pageId, "en")).toEqual([])
    expect(await seoWarnings(site, pageId, "fr")).toEqual([
      "missing_seo_title",
      "missing_seo_description",
    ])
  })
})

describe("readers of snapshots written before the change", () => {
  async function oldPublishedSite() {
    const site = await snapshotSite(["en", "fr"])
    const pageId = await createPage(site, "about")
    await publish(site, pageId, "en")
    await publish(site, pageId, "fr")
    await drain(site.t)
    await makeSnapshotLegacy(site, pageId, "en")
    await makeSnapshotLegacy(site, pageId, "fr")
    await makeLegacy(site, pageId)
    return { site, pageId }
  }

  test("the default language shows the old text; the other language shows none of it", async () => {
    const { site, pageId } = await oldPublishedSite()
    const en = await publicSeo(site, pageId, "en")
    expect(en!.seo).toMatchObject({
      ogTitle: "Social title",
      ogDescription: "Social description",
      structuredData: '{"@type":"Thing"}',
      ogImage: "/shared-social.png",
    })
    expect(en!.content).toMatchObject({ metaTitle: "Legacy meta title" })
    const fr = await publicSeo(site, pageId, "fr")
    expect(fr!.seo).toEqual({ noIndex: true, ogImage: "/shared-social.png" })
    expect(fr!.content).not.toHaveProperty("metaTitle")
    expect(JSON.stringify(fr)).not.toContain("Social title")
    expect(JSON.stringify(fr)).not.toContain("Legacy")
  })

  test("a noindex page stays noindex in every language and out of hreflang", async () => {
    const { site, pageId } = await oldPublishedSite()
    expect((await publicSeo(site, pageId, "en"))!.seo?.noIndex).toBe(true)
    expect((await publicSeo(site, pageId, "fr"))!.seo?.noIndex).toBe(true)
    expect(await alternatesOf(site, pageId)).toEqual([
      { locale: "en", url: "/about", indexable: false },
      { locale: "fr", url: "/fr/about", indexable: false },
    ])
  })

  test("a noindex page before the upgrade has no sitemap entry in any language", async () => {
    const { site, pageId } = await oldPublishedSite()
    expect(await sitemapOf(site, pageId)).toEqual({ en: [], fr: [] })
  })

  test("Make default after the upgrade does not move old text to another language", async () => {
    const { site, pageId } = await oldPublishedSite()
    await runBackfill(site)
    await site.t.run(async (ctx) => {
      const settings = (await ctx.db.query("siteSettings").unique())!
      await ctx.db.patch("siteSettings", settings._id, { defaultLocale: "fr" })
    })
    expect((await publicSeo(site, pageId, "en"))!.seo?.ogTitle).toBe(
      "Social title"
    )
    expect((await publicSeo(site, pageId, "fr"))!.seo?.ogTitle).toBeUndefined()
  })

  test("before the upgrade records it, the legacy language is the default language", async () => {
    const { site, pageId } = await oldPublishedSite()
    const settings = await site.t.run((ctx) =>
      ctx.db.query("siteSettings").unique()
    )
    expect(settings!.legacySharedFieldsLocale).toBeUndefined()
    expect((await publicSeo(site, pageId, "en"))!.seo?.ogTitle).toBe(
      "Social title"
    )
  })

  test("a card excerpt and a category follow the same language rule", async () => {
    const { site, pageId } = await oldPublishedSite()
    await makeSnapshotLegacy(site, pageId, "en", {
      seo: { ...LEGACY_SEO },
      cardExcerpt: "Legacy card excerpt",
      category: "Old category",
    })
    const projection = await site.t.run(async (ctx) => {
      const { readCurrentSnapshotProjection } =
        await import("./lib/publishing/snapshots")
      return {
        en: await readCurrentSnapshotProjection(ctx, pageId, "en"),
        fr: await readCurrentSnapshotProjection(ctx, pageId, "fr"),
      }
    })
    expect(projection.en!.payload.localized.content).toMatchObject({
      cardExcerpt: "Legacy card excerpt",
      category: "Old category",
    })
    expect(projection.fr!.payload.localized.content).not.toHaveProperty(
      "cardExcerpt"
    )
    expect(projection.fr!.payload.localized.content).not.toHaveProperty(
      "category"
    )
  })
})

describe("writers after the change", () => {
  test("a language's noindex removes only that language from hreflang", async () => {
    const site = await snapshotSite(["en", "fr"])
    const pageId = await createPage(site, "about")
    await saveLocale(site, pageId, "fr", { seo: { noIndex: true } })
    await publish(site, pageId, "en")
    await publish(site, pageId, "fr")
    await drain(site.t)
    expect(await alternatesOf(site, pageId)).toEqual([
      { locale: "en", url: "/about", indexable: true },
      { locale: "fr", url: "/fr/about", indexable: false },
    ])
    expect((await publicSeo(site, pageId, "en"))!.seo?.noIndex).toBeUndefined()
    expect((await publicSeo(site, pageId, "fr"))!.seo?.noIndex).toBe(true)
    // The sitemap drops only French, and French leaves the English alternates.
    const sitemap = await sitemapOf(site, pageId)
    expect(sitemap.fr).toEqual([])
    expect(sitemap.en).toHaveLength(1)
    expect(sitemap.en[0]!.url).toBe("/about")
    expect(sitemap.en[0]!.alternates).toEqual([{ locale: "en", url: "/about" }])
  })

  test("publishing before the backfill reaches a page keeps its values", async () => {
    const site = await snapshotSite(["en", "fr"])
    const pageId = await createPage(site, "about")
    await makeLegacy(site, pageId)
    await publish(site, pageId, "en")
    await publish(site, pageId, "fr")
    await drain(site.t)

    expect((await publicSeo(site, pageId, "en"))!.seo).toMatchObject({
      noIndex: true,
      ogTitle: "Social title",
      ogImage: "/shared-social.png",
    })
    expect((await publicSeo(site, pageId, "fr"))!.seo).toEqual({
      noIndex: true,
      ogImage: "/shared-social.png",
    })
    // The new snapshot owns its values: the shared block carries none.
    const payload = await site.t.run(async (ctx) => {
      const state = (await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", "en")
        )
        .unique())!
      const snapshot = (await ctx.db.get(
        "pagePublishedSnapshots",
        state.currentSnapshotId!
      ))!
      const candidate = (await ctx.db.get(
        "pageLocalePublicationCandidates",
        snapshot.candidateId
      ))!
      return (await reconstructLocalePublicationCandidate(candidate))!
    })
    expect(payload.shared.system.seo).toEqual({ ogImage: "/shared-social.png" })
    expect(payload.shared.system).not.toHaveProperty("cardExcerpt")
  })

  test("unchecking noindex takes effect on a page that was noindex before the upgrade", async () => {
    const site = await snapshotSite(["en"])
    const pageId = await createPage(site, "about")
    await publish(site, pageId, "en")
    await drain(site.t)
    await makeSnapshotLegacy(site, pageId, "en")
    await makeLegacy(site, pageId)
    expect((await publicSeo(site, pageId, "en"))!.seo?.noIndex).toBe(true)

    // The owner opens the page, unchecks noindex (the editor sends no noindex)
    // and publishes.
    await saveLocale(site, pageId, "en", { seo: { ogTitle: "Social title" } })
    await publish(site, pageId, "en")
    await drain(site.t)
    const seo = (await publicSeo(site, pageId, "en"))!.seo
    expect(seo?.noIndex).toBeUndefined()
    expect(seo?.ogTitle).toBe("Social title")
  })

  test("editing the title of an old page with no draft keeps its values through save and publish", async () => {
    const site = await snapshotSite(["en", "fr"])
    const pageId = await createPage(site, "about")
    await publish(site, pageId, "en")
    await publish(site, pageId, "fr")
    await drain(site.t)
    await makeSnapshotLegacy(site, pageId, "en")
    await makeSnapshotLegacy(site, pageId, "fr")
    await makeLegacy(site, pageId)
    expect(await draftRow(site, pageId, "en")).toBeNull()

    // A save that sends no seo (an editor from before the change).
    await saveLocale(site, pageId, "en", {}, "Renamed")
    await publish(site, pageId, "en")
    await drain(site.t)

    const en = await publicSeo(site, pageId, "en")
    expect(en!.seo).toMatchObject({
      noIndex: true,
      ogTitle: "Social title",
      ogDescription: "Social description",
    })
    expect(en!.content).toMatchObject({ title: "Renamed" })
    // The French snapshot is still the old one and still has no English text.
    const fr = await publicSeo(site, pageId, "fr")
    expect(fr!.seo?.ogTitle).toBeUndefined()
    expect(fr!.seo?.noIndex).toBe(true)
  })

  test("a shared save no longer writes the moved values, and ignores them", async () => {
    const site = await snapshotSite(["en"])
    const pageId = await createPage(site, "about")
    const { shared, page } = await clocks(site, pageId, "en")
    await site.owner.mutation(api.cms.publication.saveSharedDraft, {
      pageId,
      expectedSharedDraftGeneration: shared.generation,
      expectedLifecycleGeneration: page.lifecycleGeneration,
      seo: { noIndex: true, ogTitle: "Ignored", ogImage: "/kept.png" },
      cardExcerpt: "Ignored",
    })
    const after = (await clocks(site, pageId, "en")).shared
    expect(after.system).toMatchObject({ seo: { ogImage: "/kept.png" } })
    expect(after.system).not.toHaveProperty("cardExcerpt")
  })

  test("a new page keeps the values it was created with in each of its languages", async () => {
    const site = await snapshotSite(["en", "fr"])
    const pageId = await site.owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "created",
      title: "Created",
      content: {
        en: { title: "Created", blocks: [] },
        fr: { title: "Créé", blocks: [] },
      },
      seo: { noIndex: true, ogTitle: "Created social", ogImage: "/c.png" },
      cardExcerpt: "Created excerpt",
    })
    for (const locale of ["en", "fr"]) {
      expect((await draftRow(site, pageId, locale))!.content).toMatchObject({
        seo: { noIndex: true, ogTitle: "Created social" },
        cardExcerpt: "Created excerpt",
      })
    }
    const { shared, page } = await clocks(site, pageId, "en")
    expect(shared.system).toMatchObject({ seo: { ogImage: "/c.png" } })
    expect(shared.system).not.toHaveProperty("cardExcerpt")
    // Born marked: never backfilled.
    expect(page.perLanguageFieldsBackfill).toBeDefined()
  })

  test("the post category is a language's own text", async () => {
    const site = await snapshotSite(["en", "fr"])
    const pageId = await site.owner.mutation(api.cms.pages.create, {
      pageType: "post",
      status: "draft",
      slug: "a-post",
      title: "A post",
      category: "News",
      content: {
        en: { title: "A post", blocks: [] },
        fr: { title: "Un article", blocks: [] },
      },
    })
    expect((await draftRow(site, pageId, "en"))!.content).toMatchObject({
      category: "News",
    })
    // The first language copied the value in every language created with it;
    // the French text is the owner's to change.
    const { state, page } = await clocks(site, pageId, "fr")
    await site.owner.mutation(api.cms.publication.saveLocaleDraft, {
      pageId,
      locale: "fr",
      slug: "un-article",
      draft: {
        pageType: "post",
        localized: { title: "Un article", category: "Actualités" },
        blocks: [],
      } as never,
      expectedDraftGeneration: state!.draftGeneration,
      expectedLifecycleGeneration: page.lifecycleGeneration,
    })
    expect((await draftRow(site, pageId, "fr"))!.content).toMatchObject({
      category: "Actualités",
    })
    expect((await draftRow(site, pageId, "en"))!.content).toMatchObject({
      category: "News",
    })
  })
})

describe("restoring an old snapshot", () => {
  test("restore maps the old shared values by the same rule", async () => {
    const site = await snapshotSite(["en", "fr"])
    const pageId = await createPage(site, "about")
    await publish(site, pageId, "en")
    await publish(site, pageId, "fr")
    await drain(site.t)
    await makeSnapshotLegacy(site, pageId, "en")
    await makeSnapshotLegacy(site, pageId, "fr")
    await makeLegacy(site, pageId)

    for (const locale of ["en", "fr"]) {
      const { state, shared, page } = await clocks(site, pageId, locale)
      await site.owner.mutation(api.cms.publication.restoreSnapshotAsDraft, {
        pageId,
        locale,
        snapshotId: state!.currentSnapshotId!,
        expectedDraftGeneration: state!.draftGeneration,
        expectedSharedDraftGeneration: shared.generation,
        expectedLifecycleGeneration: page.lifecycleGeneration,
        expectedPublicGeneration: state!.publicGeneration,
        expectedReleaseGeneration: state!.releaseGeneration,
      })
    }
    expect((await draftRow(site, pageId, "en"))!.content).toMatchObject({
      seo: { noIndex: true, ogTitle: "Social title" },
      cardExcerpt: "Legacy card excerpt",
    })
    expect((await draftRow(site, pageId, "fr"))!.content.seo).toEqual({
      noIndex: true,
    })
    expect((await draftRow(site, pageId, "fr"))!.content).not.toHaveProperty(
      "cardExcerpt"
    )
    // The restored Shared Draft keeps only the shared social image.
    expect((await clocks(site, pageId, "en")).shared.system).toMatchObject({
      seo: { ogImage: "/shared-social.png" },
    })
  })
})
