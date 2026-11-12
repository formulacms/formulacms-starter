/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { api } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { convexTest } from "../convexTestWithExplicitAdmin"
import { SUPPORTED_LOCALES } from "../lib/i18n/config"
import {
  digestLocalePublicationCandidate,
  reconstructLocalePublicationCandidate,
  serializeLocalePublicationCandidate,
} from "./lib/publishing/localeCandidate"
import schema from "./schema"

// M05 C5 (FR1c): `getPublicLocaleAlternates`, the navigation and SEO reader
// behind the switcher, hreflang/x-default, canonical and revalidation. Proofs
// P13a and P20 at the reader boundary; the rendered halves live in the public
// page, switcher and layout tests.

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "c5-owner",
  tokenIdentifier: "https://convex.test|c5-owner",
}
const FIXED_NOW = Date.UTC(2026, 8, 23, 12, 0, 0)

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

async function publish(site: Site, pageId: Id<"pages">, locale: string) {
  const args = await site.t.run(async (ctx) => {
    const state = (await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", locale)
      )
      .unique())!
    const shared = (await ctx.db
      .query("pageSharedDrafts")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .unique())!
    const page = (await ctx.db
      .query("pagePublicationPageStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .unique())!
    return {
      pageId,
      locale,
      expectedDraftGeneration: state.draftGeneration,
      expectedSharedDraftGeneration: shared.generation,
      expectedPublicGeneration: state.publicGeneration,
      expectedLifecycleGeneration: page.lifecycleGeneration,
      expectedReleaseGeneration: state.releaseGeneration,
    }
  })
  await site.owner.mutation(api.cms.publication.publishLocale, args)
}

async function createPage(
  site: Site,
  slug: string,
  parentId?: Id<"pages">
): Promise<Id<"pages">> {
  return site.owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug,
    title: slug,
    ...(parentId === undefined ? {} : { parentId }),
    content: Object.fromEntries(
      site.locales.map((locale) => [
        locale,
        { title: `${slug} ${locale}`, slices: [] },
      ])
    ),
  })
}

/**
 * Snapshot authority at language version 0, `locales` enabled with the first
 * as the default (chosen in Admin → Languages). The home is published in the
 * default language.
 */
async function snapshotSite(locales: readonly string[]): Promise<Site> {
  const t = convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
    publicationAuthority: "missing",
  })
  const owner = t.withIdentity(OWNER)
  await owner.mutation(api.cms.publication.initializeEmptySnapshotAuthority, {})
  const site = { t, owner, locales: [...locales] }
  const homeId = await createPage(site, "home")
  await t.run((ctx) =>
    ctx.db.insert("siteSettings", {
      siteName: "C5 site",
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

async function publishedPage(
  site: Site,
  slug: string,
  locales: readonly string[],
  parentId?: Id<"pages">
) {
  const pageId = await createPage(site, slug, parentId)
  for (const locale of locales) await publish(site, pageId, locale)
  await drain(site.t)
  return pageId
}

/** Marks the current `locale` snapshot `noIndex`, as a published draft would. */
async function markNoIndex(site: Site, pageId: Id<"pages">, locale: string) {
  await site.t.run(async (ctx) => {
    const state = (await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", locale)
      )
      .unique())!
    const snapshot = (await ctx.db.get(state.currentSnapshotId!))!
    const candidate = (await ctx.db.get(snapshot.candidateId))!
    const payload = (await reconstructLocalePublicationCandidate(candidate))!
    const system = payload.shared.system as { seo?: Record<string, unknown> }
    system.seo = { ...(system.seo ?? {}), noIndex: true }
    const { payloadJson, payloadBytes } =
      serializeLocalePublicationCandidate(payload)
    const digest = await digestLocalePublicationCandidate(payloadJson)
    await ctx.db.patch(candidate._id, { payloadJson, payloadBytes, digest })
    await ctx.db.patch(snapshot._id, { candidateDigest: digest })
  })
}

function alternatesOf(site: Site, pageId: Id<"pages">) {
  return site.t.query(api.cms.pages.getPublicLocaleAlternates, {
    pageId,
    languageVersion: 0,
  })
}

describe("M05 C5 getPublicLocaleAlternates (P13a, P20)", () => {
  test("three locales: every enabled version is listed (no two-row cap)", async () => {
    const site = await snapshotSite(["en", "fr", "de"])
    const pageId = await publishedPage(site, "about", ["en", "fr", "de"])

    await expect(alternatesOf(site, pageId)).resolves.toEqual([
      { locale: "en", url: "/about", indexable: true },
      { locale: "fr", url: "/fr/about", indexable: true },
      { locale: "de", url: "/de/about", indexable: true },
    ])
  })

  test("the home page is the bare language prefix in every non-default language", async () => {
    const site = await snapshotSite(["en", "fr", "de"])
    const homeId = await site.t.run(
      async (ctx) => (await ctx.db.query("siteSettings").unique())!.homePageId!
    )
    await publish(site, homeId, "fr")
    await publish(site, homeId, "de")
    await drain(site.t)

    await expect(alternatesOf(site, homeId)).resolves.toEqual([
      { locale: "en", url: "/", indexable: true },
      { locale: "fr", url: "/fr", indexable: true },
      { locale: "de", url: "/de", indexable: true },
    ])
  })

  test("the default language from settings is the unprefixed one", async () => {
    const site = await snapshotSite(["de", "en", "fr"])
    const pageId = await publishedPage(site, "about", ["de", "en", "fr"])

    await expect(alternatesOf(site, pageId)).resolves.toEqual([
      { locale: "de", url: "/about", indexable: true },
      { locale: "en", url: "/en/about", indexable: true },
      { locale: "fr", url: "/fr/about", indexable: true },
    ])
  })

  test("15 locales with a noIndex locale: all listed, the noIndex one switchable but not an SEO alternate", async () => {
    const locales = [...SUPPORTED_LOCALES] as string[]
    const site = await snapshotSite(locales)
    const pageId = await publishedPage(site, "about", locales)
    await markNoIndex(site, pageId, "ja")

    const alternates = await alternatesOf(site, pageId)
    expect(alternates.map(({ locale }) => locale)).toEqual(locales)
    expect(alternates.filter(({ indexable }) => !indexable)).toEqual([
      { locale: "ja", url: "/ja/about", indexable: false },
    ])
  })

  test("an unpublished or disabled language is absent; no fallback URL is invented", async () => {
    const site = await snapshotSite(["en", "fr", "de"])
    const pageId = await publishedPage(site, "about", ["en", "fr", "de"])
    const draftOnly = await publishedPage(site, "draft-only", ["en"])
    await site.t.run(async (ctx) => {
      const settings = (await ctx.db.query("siteSettings").unique())!
      await ctx.db.patch(settings._id, { enabledLocales: ["en", "de"] })
    })

    await expect(alternatesOf(site, pageId)).resolves.toEqual([
      { locale: "en", url: "/about", indexable: true },
      { locale: "de", url: "/de/about", indexable: true },
    ])
    await expect(alternatesOf(site, draftOnly)).resolves.toEqual([
      { locale: "en", url: "/draft-only", indexable: true },
    ])
  })

  test("a nested page's own URL is the path the public route resolves (canonical guard)", async () => {
    const site = await snapshotSite(["en", "fr", "de"])
    const parentId = await publishedPage(site, "company", ["en", "fr", "de"])
    const childId = await publishedPage(
      site,
      "team",
      ["en", "fr", "de"],
      parentId
    )

    const alternates = await alternatesOf(site, childId)
    expect(alternates.map(({ url }) => url)).toEqual([
      "/company/team",
      "/fr/company/team",
      "/de/company/team",
    ])
    for (const locale of ["en", "fr", "de"]) {
      await expect(
        site.t.query(api.cms.pages.resolveLocalizedPathQuery, {
          path: "/company/team",
          locale,
          languageVersion: 0,
        })
      ).resolves.toBe(childId)
      await expect(
        site.t.query(api.cms.pages.getPublicPageById, {
          id: childId,
          locale,
          languageVersion: 0,
        })
      ).resolves.not.toBeNull()
    }
  })

  test("an archived page has no alternates in any language", async () => {
    const site = await snapshotSite(["en", "fr"])
    const pageId = await publishedPage(site, "about", ["en", "fr"])
    await site.t.run(async (ctx) => {
      const state = (await ctx.db
        .query("pagePublicationPageStates")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique())!
      await ctx.db.patch(state._id, { lifecycleState: "archived" })
    })

    await expect(alternatesOf(site, pageId)).resolves.toEqual([])
  })

  test("a child locale is absent after its same-locale ancestor loses its current snapshot", async () => {
    const site = await snapshotSite(["en", "fr"])
    const parentId = await publishedPage(site, "company", ["en", "fr"])
    const childId = await publishedPage(site, "team", ["en", "fr"], parentId)
    await site.t.run(async (ctx) => {
      const parent = (await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", parentId).eq("locale", "fr")
        )
        .unique())!
      await ctx.db.patch(parent._id, {
        hasCurrentSnapshot: false,
        currentSnapshotId: undefined,
        currentPath: undefined,
        currentPublishedAt: undefined,
      })
    })

    await expect(alternatesOf(site, childId)).resolves.toEqual([
      { locale: "en", url: "/company/team", indexable: true },
    ])
    await expect(
      site.t.query(api.cms.pages.getPublicPageById, {
        id: childId,
        locale: "fr",
        languageVersion: 0,
      })
    ).resolves.toBeNull()
  })

  test("non-Page switcher Homes include only locales with a public Home", async () => {
    const site = await snapshotSite(["en", "fr"])
    const homeId = await site.t.run(
      async (ctx) => (await ctx.db.query("siteSettings").unique())!.homePageId!
    )
    const homes = () =>
      site.t.query(api.cms.pages.getPublicHomeLocaleAlternates, {
        languageVersion: 0,
      })
    await expect(homes()).resolves.toEqual([
      { locale: "en", url: "/", indexable: true },
    ])
    await publish(site, homeId, "fr")
    await drain(site.t)
    await expect(homes()).resolves.toEqual([
      { locale: "en", url: "/", indexable: true },
      { locale: "fr", url: "/fr", indexable: true },
    ])
  })

  test("more enabled locales than the catalog fails loudly", async () => {
    const site = await snapshotSite(["en"])
    await site.t.run(async (ctx) => {
      const settings = (await ctx.db.query("siteSettings").unique())!
      await ctx.db.patch(settings._id, {
        enabledLocales: [...SUPPORTED_LOCALES, "xx"],
      })
    })
    const homeId = await site.t.run(
      async (ctx) => (await ctx.db.query("siteSettings").unique())!.homePageId!
    )

    await expect(alternatesOf(site, homeId)).rejects.toThrow(
      "PUBLIC_LOCALE_ALTERNATE_BOUND_EXCEEDED"
    )
  })
})
