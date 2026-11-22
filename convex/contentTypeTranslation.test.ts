/// <reference types="vite/client" />

import { blockProfile } from "@/test-utils/block-profile"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { ConvexError } from "convex/values"
import { api } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { convexTest } from "../convexTestWithExplicitAdmin"
import schema from "./schema"

// ADR-0037 amendment (2026-11-17), clauses 3, 4 and 7: the translation switch
// per content type. Off hides a type's versions in every language but the one
// pinned when it was turned off, at the one public snapshot reader; nothing is
// deleted and on again restores them without a republish.

const modules = import.meta.glob("./**/*.ts")
const OWNER = { subject: "ctt-owner", tokenIdentifier: "ctt-owner" }
const FIXED_NOW = Date.UTC(2026, 10, 17, 12, 0, 0)

type T = ReturnType<typeof convexTest>
type Caller = ReturnType<T["withIdentity"]>
type Site = {
  t: T
  owner: Caller
  homeId: Id<"pages">
  aboutId: Id<"pages">
  teamId: Id<"pages">
  contactId: Id<"pages">
  authorId: Id<"pages">
  postId: Id<"pages">
}

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

async function drain(t: T) {
  await t.finishAllScheduledFunctions(vi.runAllTimers)
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

/** Draft a locale with its own slug, then publish it. */
async function publishTranslated(
  site: Pick<Site, "t" | "owner">,
  pageId: Id<"pages">,
  locale: string,
  slug: string
) {
  const { state, page } = await generations(site.t, pageId, locale)
  await site.owner.mutation(api.cms.publication.saveLocaleDraft, {
    pageId,
    locale,
    slug,
    draft: {
      pageType: "landing-page",
      localized: { title: `${slug} ${locale}` },
      blocks: [],
    } as never,
    expectedDraftGeneration: state?.draftGeneration ?? 0,
    expectedLifecycleGeneration: page!.lifecycleGeneration,
  })
  await publish(site, pageId, locale)
}

const bodyBlock = (id: string, text: string) => ({
  id,
  type: "rich-text-body" as const,
  enabled: true,
  primary: {
    body: JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    }),
  },
})

const bothLanguages = (title: string) => ({
  en: { title, blocks: [] },
  fr: { title: `${title} fr`, blocks: [] },
})

/**
 * Snapshot authority, `en` default with `fr` enabled, multilingual authority
 * adopted. Published in both languages: the home page and `about` (both
 * landing pages; `about` is `/about` in English and `/a-propos` in French with
 * the old French address `/apropos-old` kept), `team` (a `page` under `about`),
 * `contact` (a `page`), an author and a post that credits her.
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
  const homeId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "home",
    title: "home",
    content: bothLanguages("home"),
  })
  const aboutId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "about",
    title: "about",
    content: bothLanguages("about"),
  })
  await t.run((ctx) =>
    ctx.db.insert("siteSettings", {
      siteName: "Switch site",
      siteUrl: "",
      defaultLocale: "en",
      enabledLocales: ["en", "fr"],
      homePageId: homeId,
      updatedAt: FIXED_NOW,
    })
  )
  const base = { t, owner }
  for (const locale of ["en", "fr"]) await publish(base, homeId, locale)
  await publish(base, aboutId, "en")
  await publishTranslated(base, aboutId, "fr", "apropos-old")
  await publishTranslated(base, aboutId, "fr", "a-propos")
  const teamId = await owner.mutation(api.cms.pages.create, {
    pageType: "page",
    status: "draft",
    slug: "team",
    title: "team",
    parentId: aboutId,
    content: bothLanguages("team"),
  })
  const contactId = await owner.mutation(api.cms.pages.create, {
    pageType: "page",
    status: "draft",
    slug: "contact",
    title: "contact",
    content: bothLanguages("contact"),
  })
  const authorId = await owner.mutation(api.cms.pages.create, {
    pageType: "author",
    status: "draft",
    slug: "ada",
    title: "Ada",
    name: "Ada",
    content: bothLanguages("Ada"),
  })
  const postId = await owner.mutation(api.cms.pages.create, {
    pageType: "post",
    status: "draft",
    slug: "proof",
    title: "Proof",
    authorIds: [authorId],
    content: {
      en: { title: "Proof", blocks: [bodyBlock("pe", "English proof")] },
      fr: { title: "Preuve", blocks: [bodyBlock("pf", "Preuve")] },
    },
  })
  for (const pageId of [teamId, contactId, authorId, postId]) {
    for (const locale of ["en", "fr"]) await publish(base, pageId, locale)
  }
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query("cmsModuleState").collect()) {
      await ctx.db.delete("cmsModuleState", row._id)
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
  return { t, owner, homeId, aboutId, teamId, contactId, authorId, postId }
}

async function languageVersion(t: T) {
  return (await t.query(api.cms.settings.getSiteConfig, {})).languageVersion
}

async function resolvePath(t: T, locale: string, path: string) {
  return t.query(api.cms.pages.resolveLocalizedPathQuery, {
    path,
    locale,
    languageVersion: await languageVersion(t),
  })
}

async function resolveHistorical(t: T, locale: string, path: string) {
  return t.query(api.cms.pages.resolveHistoricalPublishedPath, {
    locale,
    path,
    languageVersion: await languageVersion(t),
  })
}

async function alternates(t: T, pageId: Id<"pages">) {
  return t.query(api.cms.pages.getPublicLocaleAlternates, {
    pageId,
    languageVersion: await languageVersion(t),
  })
}

async function publicPage(t: T, id: Id<"pages">, locale: string) {
  return t.query(api.cms.pages.getPublicPageById, {
    id,
    locale,
    languageVersion: await languageVersion(t),
  })
}

async function cards(t: T, ids: Id<"pages">[], locale: string) {
  return t.query(api.cms.pages.getPublicRelationCardsByIds, {
    ids,
    locale,
    languageVersion: await languageVersion(t),
  })
}

async function sitemapUrls(t: T, locale: string) {
  const version = await languageVersion(t)
  const index = await t.query(api.cms.pages.getSitemapIndex, {
    languageVersion: version,
  })
  const urls: { url: string; alternates: string[] }[] = []
  const entry = index.locales.find((row) => row.locale === locale)!
  for (let ordinal = 0; ordinal < entry.partitions; ordinal++) {
    const child = await t.query(api.cms.pages.getSitemapChild, {
      languageVersion: version,
      manifestVersion: index.manifestVersion,
      locale,
      ordinal,
    })
    if (child.status !== "ok") throw new Error(`sitemap child ${child.status}`)
    for (const row of child.entries) {
      urls.push({
        url: row.url,
        alternates: row.alternates.map((alternate) => alternate.url),
      })
    }
  }
  return urls
}

async function menuIds(t: T, locale: string) {
  const menu = await t.query(api.cms.menus.getWithResolvedLinks, {
    slug: "main",
    locale,
    languageVersion: await languageVersion(t),
  })
  // The reader keeps every item; one whose page is not public in this
  // language has no address, and the menu does not show it.
  return (menu?.nav ?? [])
    .filter((item) => item.target?.url !== undefined)
    .map((item) => item.id)
}

async function addMenu(site: Site) {
  await site.owner.mutation(api.cms.menus.createCanonical, { slug: "main" })
  const nav = (withFr: boolean) =>
    [
      ["home", site.homeId],
      ["about", site.aboutId],
      ["contact", site.contactId],
    ].map(([id, pageId]) => ({
      id: id as string,
      label: (withFr
        ? { en: id as string, fr: `${id} fr` }
        : { en: id as string }) as Record<string, string>,
      target: { type: "internal" as const, pageId: pageId as Id<"pages"> },
    }))
  for (const locale of ["en", "fr"]) {
    await site.owner.mutation(api.cms.menus.saveCanonical, {
      slug: "main",
      locale,
      nav: nav(locale === "fr"),
    })
  }
}

const switchOff = (site: Pick<Site, "owner">, pageType: "landing-page" | "author") =>
  site.owner.mutation(api.cms.contentTypes.setContentTypeTranslation, {
    pageType,
    translated: false,
  })
const switchOn = (site: Pick<Site, "owner">, pageType: "landing-page" | "author") =>
  site.owner.mutation(api.cms.contentTypes.setContentTypeTranslation, {
    pageType,
    translated: true,
  })

async function settingsRow(t: T) {
  return (await t.run((ctx) => ctx.db.query("siteSettings").unique()))!
}

describe("translation switch: the public readers", () => {
  test("an absent list means every type is translated", blockProfile(["rich-text-body"]), async () => {
    const site = await mlSite()
    expect((await settingsRow(site.t)).untranslatedContentTypes).toBeUndefined()
    await expect(
      site.owner.query(api.cms.contentTypes.getUntranslatedContentTypes, {})
    ).resolves.toEqual([])
    expect(await resolvePath(site.t, "fr", "/a-propos")).toBe(site.aboutId)
    expect((await alternates(site.t, site.aboutId)).map((a) => a.locale)).toEqual(
      ["en", "fr"]
    )
    expect(await publicPage(site.t, site.aboutId, "fr")).not.toBeNull()
  })

  test("off hides the other languages from path lookup, alternates, page reads, sitemap, menu and cards", blockProfile(["rich-text-body"]), async () => {
    const site = await mlSite()
    await addMenu(site)
    const before = {
      menuFr: await menuIds(site.t, "fr"),
      sitemapFr: await sitemapUrls(site.t, "fr"),
      sitemapEn: await sitemapUrls(site.t, "en"),
    }
    expect(before.menuFr).toEqual(["home", "about", "contact"])
    expect(before.sitemapFr.map((row) => row.url)).toContain("/fr/a-propos")

    await expect(switchOff(site, "landing-page")).resolves.toEqual([
      { pageType: "landing-page", locale: "en" },
    ])
    await drain(site.t)

    // Path lookup: the English address still resolves, the French one is gone.
    expect(await resolvePath(site.t, "en", "/about")).toBe(site.aboutId)
    expect(await resolvePath(site.t, "fr", "/a-propos")).toBeNull()
    // The hidden page's child (another type) is gone in French too.
    expect(await resolvePath(site.t, "en", "/about/team")).toBe(site.teamId)
    expect(await resolvePath(site.t, "fr", "/a-propos/team")).toBeNull()
    // The other type is untouched.
    expect(await resolvePath(site.t, "fr", "/contact")).toBe(site.contactId)

    // Alternates: English lists only itself; no French version.
    expect(await alternates(site.t, site.aboutId)).toEqual([
      { locale: "en", url: "/about", indexable: true },
    ])
    expect(await publicPage(site.t, site.aboutId, "fr")).toBeNull()
    expect(await publicPage(site.t, site.aboutId, "en")).not.toBeNull()

    // Sitemap rows and their alternates.
    const sitemapFr = await sitemapUrls(site.t, "fr")
    expect(sitemapFr.map((row) => row.url)).not.toContain("/fr/a-propos")
    expect(sitemapFr.map((row) => row.url)).toContain("/fr/contact")
    const aboutEn = (await sitemapUrls(site.t, "en")).find(
      (row) => row.url === "/about"
    )
    expect(aboutEn?.alternates).toEqual(["/about"])

    // Menu: the hidden page's item is gone in French only.
    expect(await menuIds(site.t, "fr")).toEqual(["home", "contact"])
    expect(await menuIds(site.t, "en")).toEqual(before.menuFr)

    // Relation cards.
    const frCards = await cards(site.t, [site.aboutId, site.contactId], "fr")
    expect(frCards[site.aboutId]).toBeNull()
    expect(frCards[site.contactId]).not.toBeNull()
    const enCards = await cards(site.t, [site.aboutId], "en")
    expect(enCards[site.aboutId]).not.toBeNull()
  })

  test("the home page stays in every language", blockProfile(["rich-text-body"]), async () => {
    const site = await mlSite()
    await switchOff(site, "landing-page")
    await drain(site.t)
    expect(await resolvePath(site.t, "fr", "/")).toBe(site.homeId)
    expect((await alternates(site.t, site.homeId)).map((a) => a.locale)).toEqual(
      ["en", "fr"]
    )
    expect(await publicPage(site.t, site.homeId, "fr")).not.toBeNull()
  })

  test("a credited author vanishes from the other languages' byline and cards", blockProfile(["rich-text-body"]), async () => {
    const site = await mlSite()
    const read = async (locale: string) =>
      site.t.query(api.cms.pages.getPublicByline, {
        authorPageId: site.authorId,
        locale,
        languageVersion: await languageVersion(site.t),
      })
    expect(await read("fr")).not.toBeNull()
    await switchOff(site, "author")
    await drain(site.t)
    expect(await read("fr")).toBeNull()
    expect(await read("en")).not.toBeNull()
    expect((await cards(site.t, [site.authorId], "fr"))[site.authorId]).toBeNull()
  })

  test("an old address of a hidden version answers not found, never a redirect", blockProfile(["rich-text-body"]), async () => {
    const site = await mlSite()
    // Before: the old French address redirects to the current one.
    expect(await resolveHistorical(site.t, "fr", "/apropos-old")).toMatchObject({
      disposition: "historical_redirect",
      locale: "fr",
      destinationPath: "/a-propos",
    })
    await switchOff(site, "landing-page")
    await drain(site.t)
    for (const path of ["/apropos-old", "/a-propos"]) {
      expect(await resolveHistorical(site.t, "fr", path)).toEqual({
        authority: "snapshot_active",
        disposition: "historical_unavailable",
      })
    }
    // The English address is unaffected.
    expect(await resolveHistorical(site.t, "en", "/about")).toMatchObject({
      disposition: "current",
    })
  })

  test("on again restores every version without a republish", blockProfile(["rich-text-body"]), async () => {
    const site = await mlSite()
    const before = await generations(site.t, site.aboutId, "fr")
    await switchOff(site, "landing-page")
    await drain(site.t)
    expect(await resolvePath(site.t, "fr", "/a-propos")).toBeNull()
    await expect(switchOn(site, "landing-page")).resolves.toEqual([])
    await drain(site.t)
    expect(await resolvePath(site.t, "fr", "/a-propos")).toBe(site.aboutId)
    expect((await alternates(site.t, site.aboutId)).map((a) => a.locale)).toEqual(
      ["en", "fr"]
    )
    // Nothing was published, deleted or rewritten.
    expect(await generations(site.t, site.aboutId, "fr")).toEqual(before)
    expect((await settingsRow(site.t)).untranslatedContentTypes).toEqual([])
  })
})

describe("translation switch: entries that have no effect", () => {
  test("an entry for a language that is not enabled hides nothing", blockProfile(["rich-text-body"]), async () => {
    const site = await mlSite()
    await site.t.run(async (ctx) => {
      const settings = (await ctx.db.query("siteSettings").first())!
      await ctx.db.patch("siteSettings", settings._id, {
        untranslatedContentTypes: [{ pageType: "landing-page", locale: "de" }],
      })
    })
    expect(await resolvePath(site.t, "fr", "/a-propos")).toBe(site.aboutId)
    expect(await resolvePath(site.t, "en", "/about")).toBe(site.aboutId)
  })

  test("a site back to one language ignores the entry", async () => {
    const t = convexTest({
      schema,
      modules,
      ownerIdentity: OWNER,
      publicationAuthority: "missing",
    })
    const owner = t.withIdentity(OWNER)
    await owner.mutation(
      api.cms.publication.initializeEmptySnapshotAuthority,
      {}
    )
    const homeId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "home",
      title: "home",
      content: { en: { title: "home", blocks: [] } },
    })
    const aboutId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "about",
      title: "about",
      content: { en: { title: "about", blocks: [] } },
    })
    await t.run((ctx) =>
      ctx.db.insert("siteSettings", {
        siteName: "One language",
        siteUrl: "",
        defaultLocale: "en",
        enabledLocales: ["en"],
        homePageId: homeId,
        // Left over from when French was a language of this site.
        untranslatedContentTypes: [{ pageType: "landing-page", locale: "fr" }],
        updatedAt: FIXED_NOW,
      })
    )
    await publish({ t, owner }, homeId, "en")
    await publish({ t, owner }, aboutId, "en")
    expect(await resolvePath(t, "en", "/about")).toBe(aboutId)
  })

  test("Make default keeps the public text and the hidden set; no redirect lands on a hidden page", blockProfile(["rich-text-body"]), async () => {
    const site = await mlSite()
    await switchOff(site, "landing-page")
    await drain(site.t)
    const authority = (await site.t.run((ctx) =>
      ctx.db.query("siteLanguageAuthority").unique()
    ))!
    const moduleState = (await site.t.run((ctx) =>
      ctx.db.query("cmsModuleState").first()
    ))!
    await site.owner.mutation(api.cms.multilingual.setDefaultLanguage, {
      toLocale: "fr",
      expectedAuthorityVersion: authority.version,
      expectedModuleConfigurationVersion: moduleState.configurationVersion,
    })
    await drain(site.t)

    // The entry still pins English; French is still hidden, English public.
    expect((await settingsRow(site.t)).untranslatedContentTypes).toEqual([
      { pageType: "landing-page", locale: "en" },
    ])
    expect(await resolvePath(site.t, "en", "/about")).toBe(site.aboutId)
    expect(await resolvePath(site.t, "fr", "/a-propos")).toBeNull()
    expect(
      (await publicPage(site.t, site.aboutId, "en"))?.content?.en
    ).toMatchObject({ title: "about" })
    expect(await publicPage(site.t, site.aboutId, "fr")).toBeNull()
    // Old unprefixed English address: it may redirect to the English page,
    // never to a French one.
    const old = await resolveHistorical(site.t, "fr", "/about")
    if (old.authority === "snapshot_active" && old.disposition === "historical_redirect") {
      expect(old.locale).toBe("en")
    } else {
      expect(old).toMatchObject({ authority: "snapshot_active" })
    }
    // The old French-only address stays not found.
    expect(await resolveHistorical(site.t, "fr", "/apropos-old")).toEqual({
      authority: "snapshot_active",
      disposition: "historical_unavailable",
    })
  })
})

async function makeDefault(site: Pick<Site, "t" | "owner">, toLocale: string) {
  const authority = (await site.t.run((ctx) =>
    ctx.db.query("siteLanguageAuthority").unique()
  ))!
  const moduleState = (await site.t.run((ctx) =>
    ctx.db.query("cmsModuleState").first()
  ))!
  await site.owner.mutation(api.cms.multilingual.setDefaultLanguage, {
    toLocale,
    expectedAuthorityVersion: authority.version,
    expectedModuleConfigurationVersion: moduleState.configurationVersion,
  })
  await drain(site.t)
}

describe("translation switch: default language changes", () => {
  test("a hidden version's continuity address answers not found, never a redirect into the kept language", blockProfile(["rich-text-body"]), async () => {
    const site = await mlSite()
    // A stored M05 continuity set: French was the default before, `/a-propos`
    // was its unprefixed address of `about`.
    await site.t.run(async (ctx) => {
      const owner = (await ctx.db.query("cmsOwner").unique())!
      const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
      const moduleState = (await ctx.db.query("cmsModuleState").unique())!
      const freshness = { routeClaimVersion: 0, publicationSetVersion: 0 }
      const migrationId = await ctx.db.insert("siteDefaultLanguageMigrations", {
        fromLocale: "fr",
        toLocale: "en",
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
          rows: 1,
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
      await ctx.db.insert("siteDefaultLanguageRoutes", {
        migrationId,
        generation: 1,
        pageId: site.aboutId,
        locale: "fr",
        fromPath: "/old-french-default",
        origin: "old_default_current",
        createdAt: FIXED_NOW,
      })
      await ctx.db.patch("siteLanguageAuthority", authority._id, {
        continuityPointer: { migrationId, generation: 1 },
      })
    })
    // Control: with the type translated the address redirects.
    expect(await resolveHistorical(site.t, "en", "/old-french-default")).toMatchObject({
      disposition: "historical_redirect",
      locale: "en",
    })
    await switchOff(site, "landing-page")
    await drain(site.t)
    expect(await resolveHistorical(site.t, "en", "/old-french-default")).toEqual({
      authority: "snapshot_active",
      disposition: "historical_unavailable",
    })
  })

  test("after default changes back, nothing redirects into a hidden version", blockProfile(["rich-text-body"]), async () => {
    const site = await mlSite()
    await switchOff(site, "landing-page")
    await drain(site.t)
    await makeDefault(site, "fr")
    await makeDefault(site, "en")
    for (const [locale, path] of [
      ["en", "/a-propos"],
      ["en", "/apropos-old"],
      ["fr", "/a-propos"],
    ] as const) {
      expect(await resolveHistorical(site.t, locale, path)).not.toMatchObject({
        disposition: "historical_redirect",
      })
    }
    // A French request for the English address goes to the English page.
    expect(await resolveHistorical(site.t, "fr", "/about")).toMatchObject({
      disposition: "unclaimed",
      selfHeal: { locale: "en", destinationPath: "/about" },
    })
  })
})

describe("translation switch: the owner command", () => {
  test("off pins the current default language and is idempotent", blockProfile(["rich-text-body"]), async () => {
    const site = await mlSite()
    await expect(switchOff(site, "landing-page")).resolves.toEqual([
      { pageType: "landing-page", locale: "en" },
    ])
    const first = await settingsRow(site.t)
    await expect(switchOff(site, "landing-page")).resolves.toEqual([
      { pageType: "landing-page", locale: "en" },
    ])
    expect((await settingsRow(site.t)).updatedAt).toBe(first.updatedAt)
    await expect(switchOn(site, "author")).resolves.toEqual([
      { pageType: "landing-page", locale: "en" },
    ])
    await expect(
      site.owner.query(api.cms.contentTypes.getUntranslatedContentTypes, {})
    ).resolves.toEqual([{ pageType: "landing-page", locale: "en" }])
  })

  test("on with no entry changes nothing and needs no guard", blockProfile(["rich-text-body"]), async () => {
    const site = await mlSite()
    await site.t.run(async (ctx) => {
      const row = (await ctx.db.query("cmsModuleState").first())!
      await ctx.db.patch("cmsModuleState", row._id, { enabledModules: [] })
    })
    await expect(switchOn(site, "author")).resolves.toEqual([])
    expect((await settingsRow(site.t)).untranslatedContentTypes).toBeUndefined()
  })

  test("off is refused while a language change runs", blockProfile(["rich-text-body"]), async () => {
    const site = await mlSite()
    await site.t.run(async (ctx) => {
      const owner = (await ctx.db.query("cmsOwner").unique())!
      const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
      const moduleState = (await ctx.db.query("cmsModuleState").unique())!
      const freshness = { routeClaimVersion: 0, publicationSetVersion: 0 }
      const id = await ctx.db.insert("siteDefaultLanguageMigrations", {
        fromLocale: "en",
        toLocale: "fr",
        phase: "enumerating",
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
      await ctx.db.patch("siteLanguageAuthority", authority._id, {
        activeDefaultMigrationId: id,
      })
    })
    await expect(switchOff(site, "landing-page")).rejects.toThrow(
      "LANGUAGE_OPERATION_OPEN"
    )
    expect((await settingsRow(site.t)).untranslatedContentTypes).toBeUndefined()
  })

  // Finding 4 (round 1): turning translation on changes which versions are
  // public just as off does, so both directions apply the same four refusals.
  const blockers: Array<[string, string, (site: Site) => Promise<void>]> = [
    [
      "Multilingual is off",
      "MULTILINGUAL_MODULE_NOT_ENABLED",
      async (site) => {
        await site.t.run(async (ctx) => {
          const row = (await ctx.db.query("cmsModuleState").first())!
          await ctx.db.patch("cmsModuleState", row._id, { enabledModules: [] })
        })
      },
    ],
    [
      "a permanent delete runs",
      "PAGE_PURGE_IN_PROGRESS",
      async (site) => {
        await site.t.run(async (ctx) => {
          await ctx.db.insert("pagePurges", {
            pageId: site.contactId,
            requestedAt: FIXED_NOW,
            startedAt: FIXED_NOW,
            phase: "queued",
            updatedAt: FIXED_NOW,
            attempts: 0,
            slug: "contact",
            localizedTitles: {},
          })
        })
      },
    ],
    [
      "a default language change is open",
      "LANGUAGE_OPERATION_OPEN",
      async (site) => {
        await site.t.run(async (ctx) => {
          const owner = (await ctx.db.query("cmsOwner").unique())!
          const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
          const moduleState = (await ctx.db.query("cmsModuleState").unique())!
          const freshness = { routeClaimVersion: 0, publicationSetVersion: 0 }
          const id = await ctx.db.insert("siteDefaultLanguageMigrations", {
            fromLocale: "en",
            toLocale: "fr",
            phase: "enumerating",
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
          await ctx.db.patch("siteLanguageAuthority", authority._id, {
            activeDefaultMigrationId: id,
          })
        })
      },
    ],
    [
      "a language transition is open",
      "LANGUAGE_OPERATION_OPEN",
      async (site) => {
        // M6 keeps an open F09 transition and the enabled module apart, so
        // the state is constructed as the Multilingual tests construct it: a
        // single-language authority naming an open transition, module on.
        await site.t.run(async (ctx) => {
          const owner = (await ctx.db.query("cmsOwner").unique())!
          const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
          const settings = (await ctx.db.query("siteSettings").unique())!
          await ctx.db.patch("siteSettings", settings._id, {
            enabledLocales: ["en"],
          })
          const transitionId = await ctx.db.insert("siteLanguageTransitions", {
            mode: "correct_label",
            sourceLocale: "en",
            targetLocale: "fr",
            phase: "preparing",
            generation: 1,
            startAuthorityVersion: authority.version,
            startSettingsUpdatedAt: settings.updatedAt,
            shortPath: false,
            sourcePublicSetVersion: 0,
            preparedSetVersion: 0,
            pageCount: 0,
            targetCount: 0,
            withdrawCount: 0,
            redirectCount: 0,
            unresolvedCount: 0,
            blockedCount: 0,
            targetDrafts: "retained",
            attribution: {
              kind: "owner",
              ownerId: owner._id,
              authId: owner.authId,
              tokenIdentifier: owner.tokenIdentifier,
            },
            createdAt: FIXED_NOW,
            updatedAt: FIXED_NOW,
          } as never)
          await ctx.db.delete("siteLanguageAuthority", authority._id)
          await ctx.db.insert("siteLanguageAuthority", {
            key: "site-language-v1",
            version: authority.version,
            currentLocale: "en",
            activeTransitionId: transitionId,
            updatedAt: FIXED_NOW,
          } as never)
        })
      },
    ],
  ]
  describe.each(["off", "on"] as const)("turning translation %s", (direction) => {
    test.each(blockers)(
      "is refused while %s, and the settings stay unchanged",
      blockProfile(["rich-text-body"]),
      async (_name, code, block) => {
        const site = await mlSite()
        // "on" needs a live entry to change; the entry is added before the blocker.
        if (direction === "on") await switchOff(site, "landing-page")
        const before = await settingsRow(site.t)
        await block(site)
        const change =
          direction === "off"
            ? switchOff(site, "landing-page")
            : switchOn(site, "landing-page")
        await expect(change).rejects.toThrow(code)
        const after = await settingsRow(site.t)
        expect(after.untranslatedContentTypes).toEqual(
          before.untranslatedContentTypes
        )
        expect(after.updatedAt).toBe(before.updatedAt)
      }
    )
  })

  test("the command needs the owner", blockProfile(["rich-text-body"]), async () => {
    const site = await mlSite()
    await expect(
      site.t.mutation(api.cms.contentTypes.setContentTypeTranslation, {
        pageType: "landing-page",
        translated: false,
      })
    ).rejects.toThrow()
  })
})

describe("translation switch: guards", () => {
  test("publishing into a hidden language is refused; the kept language, withdraw and drafts are not", blockProfile(["rich-text-body"]), async () => {
    const site = await mlSite()
    const soloId = await site.owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "solo",
      title: "solo",
      content: bothLanguages("solo"),
    })
    for (const locale of ["en", "fr"]) await publish(site, soloId, locale)
    const draftId = await site.owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "later",
      title: "later",
      content: bothLanguages("later"),
    })
    await switchOff(site, "landing-page")
    await drain(site.t)
    await expect(
      site.owner.mutation(
        api.cms.publication.publishLocale,
        await publishArgs(site.t, draftId, "fr")
      )
    ).rejects.toThrow("CONTENT_TYPE_TRANSLATION_OFF")
    // Saving a draft in the hidden language stays allowed.
    const { state, page } = await generations(site.t, draftId, "fr")
    await site.owner.mutation(api.cms.publication.saveLocaleDraft, {
      pageId: draftId,
      locale: "fr",
      slug: "plus-tard",
      draft: {
        pageType: "landing-page",
        localized: { title: "plus tard" },
        blocks: [],
      } as never,
      expectedDraftGeneration: state!.draftGeneration,
      expectedLifecycleGeneration: page!.lifecycleGeneration,
    })
    // The kept language publishes.
    await publish(site, draftId, "en")
    expect(await resolvePath(site.t, "en", "/later")).toBe(draftId)
    // Withdrawing the hidden version stays allowed.
    const solo = await generations(site.t, soloId, "fr")
    await site.owner.mutation(api.cms.publication.withdrawLocale, {
      pageId: soloId,
      locale: "fr",
      expectedSnapshotId: solo.state!.currentSnapshotId!,
      expectedPublicGeneration: solo.state!.publicGeneration,
      expectedLifecycleGeneration: solo.page!.lifecycleGeneration,
    })
    expect(
      (await generations(site.t, soloId, "fr")).state!.hasCurrentSnapshot
    ).toBe(false)
    // The home page is exempt from the guard.
    const homeFr = await generations(site.t, site.homeId, "fr")
    expect(homeFr.state!.hasCurrentSnapshot).toBe(true)
  })
})

describe("translation switch: links to a one-language type", () => {
  const newPost = (site: Site, slug: string, authorId: Id<"pages">) =>
    site.owner.mutation(api.cms.pages.create, {
      pageType: "post",
      status: "draft",
      slug,
      title: slug,
      authorIds: [authorId],
      content: {
        en: { title: slug, blocks: [bodyBlock(`${slug}-e`, "English")] },
        fr: { title: `${slug} fr`, blocks: [bodyBlock(`${slug}-f`, "Français")] },
      },
    })

  test("a French post naming an author of a one-language type publishes and shows no byline", blockProfile(["rich-text-body"]), async () => {
    const site = await mlSite()
    await switchOff(site, "author")
    await drain(site.t)
    const postId = await newPost(site, "linked", site.authorId)
    await publish(site, postId, "en")
    await publish(site, postId, "fr")
    // The row still records the link, so counts and deletion guards work.
    const rows = await site.t.run((ctx) =>
      ctx.db
        .query("pagePublicationDocumentReferences")
        .withIndex("by_targetId_and_sourceKind_and_locale", (q) =>
          q
            .eq("targetId", site.authorId)
            .eq("sourceKind", "current_public")
            .eq("locale", "fr")
        )
        .collect()
    )
    expect(rows.some((row) => row.pageId === postId)).toBe(true)
    // Public readers leave the author out in French, not in English.
    const read = async (locale: string) =>
      site.t.query(api.cms.pages.getPublicByline, {
        authorPageId: site.authorId,
        locale,
        languageVersion: await languageVersion(site.t),
      })
    expect(await read("fr")).toBeNull()
    expect(await read("en")).not.toBeNull()
    expect(
      (await cards(site.t, [site.authorId], "fr"))[site.authorId]
    ).toBeNull()
    expect(await publicPage(site.t, postId, "fr")).not.toBeNull()
    expect(
      (await cards(site.t, [site.authorId], "en"))[site.authorId]
    ).not.toBeNull()
  })

  test("a French post naming an author of a translated type with no French version still fails", blockProfile(["rich-text-body"]), async () => {
    const site = await mlSite()
    const soloAuthor = await site.owner.mutation(api.cms.pages.create, {
      pageType: "author",
      status: "draft",
      slug: "bob",
      title: "Bob",
      name: "Bob",
      content: { en: { title: "Bob", blocks: [] } },
    })
    await publish(site, soloAuthor, "en")
    const postId = await newPost(site, "needs-fr-author", soloAuthor)
    await publish(site, postId, "en")
    await expect(
      site.owner.mutation(
        api.cms.publication.publishLocale,
        await publishArgs(site.t, postId, "fr")
      )
    ).rejects.toThrow("PUBLICATION_REFERENCE_TARGET_LOCALE_UNAVAILABLE")
  })
})

// Finding 3 (round 1): the public reader also hides a page whose ancestor's
// type is switched off, so a link to such a page must not block publishing,
// while a page that simply has no version in that language still does.
describe("translation switch: links to a page hidden through an ancestor", () => {
  // A post that credits `authorId` (a relation, checked by both the checklist
  // and publishing).
  const linker = (
    site: Site,
    slug: string,
    refs: { authorId?: Id<"pages"> }
  ) =>
    site.owner.mutation(api.cms.pages.create, {
      pageType: "post",
      status: "draft",
      slug,
      title: slug,
      ...(refs.authorId ? { authorIds: [refs.authorId] } : {}),
      content: {
        en: {
          title: slug,
          blocks: [
            bodyBlock(`${slug}-eb`, "English"),
          ],
        },
        fr: {
          title: `${slug} fr`,
          blocks: [
            bodyBlock(`${slug}-fb`, "Français"),
          ],
        },
      },
    })
  const childAuthor = async (
    site: Site,
    slug: string,
    locales: string[],
    parentId: Id<"pages"> = site.aboutId
  ) => {
    const id = await site.owner.mutation(api.cms.pages.create, {
      pageType: "author",
      status: "draft",
      slug,
      title: slug,
      name: slug,
      parentId,
      content: Object.fromEntries(
        locales.map((locale) => [locale, { title: `${slug} ${locale}`, blocks: [] }])
      ),
    })
    for (const locale of locales) await publish(site, id, locale)
    return id
  }
  const frChecklistCodes = async (site: Site, pageId: Id<"pages">) =>
    (
      await site.owner.query(api.cms.pages.getPrePublishChecklist, {
        pageId,
        locale: "fr",
      })
    ).blockers.map((item) => item.code)
  const profile = blockProfile(["rich-text-body"])

  test("publish and the checklist accept a credit to an author below a hidden parent", profile, async () => {
    const site = await mlSite()
    const authorId = await childAuthor(site, "kid", ["en", "fr"])
    const postId = await linker(site, "by-kid", { authorId })
    await publish(site, postId, "en")
    // Control: before the switch, the credit resolves in French.
    expect(await frChecklistCodes(site, postId)).not.toContain(
      "archived_relation_target"
    )
    await switchOff(site, "landing-page")
    await drain(site.t)
    // The author's own type is still translated, but the reader hides it.
    expect(await publicPage(site.t, authorId, "fr")).toBeNull()
    expect(await frChecklistCodes(site, postId)).not.toContain(
      "archived_relation_target"
    )
    await publish(site, postId, "fr")
    expect(await publicPage(site.t, postId, "fr")).not.toBeNull()
  })

  test("the frozen ancestry decides, not the draft parent", profile, async () => {
    const site = await mlSite()
    const authorId = await childAuthor(site, "mover", ["en", "fr"])
    await switchOff(site, "landing-page")
    await drain(site.t)
    // The draft parent is cleared but never republished: the hidden ancestor
    // is still in French's frozen ancestry, so the credit is still accepted.
    const now = await generations(site.t, authorId, "fr")
    await site.owner.mutation(api.cms.publication.saveEditorDraft, {
      pageId: authorId,
      expectedLifecycleGeneration: now.page!.lifecycleGeneration,
      shared: { expectedGeneration: now.shared!.generation, clearParent: true },
    })
    const postId = await linker(site, "by-mover", { authorId })
    await publish(site, postId, "en")
    expect(await frChecklistCodes(site, postId)).not.toContain(
      "archived_relation_target"
    )
    await publish(site, postId, "fr")
    expect(await publicPage(site.t, postId, "fr")).not.toBeNull()
  })

  test("control: an author with no French version still blocks, even with a hidden draft parent", profile, async () => {
    const site = await mlSite()
    const authorId = await childAuthor(site, "solo", ["en"])
    await switchOff(site, "landing-page")
    await drain(site.t)
    const postId = await linker(site, "by-solo", { authorId })
    await publish(site, postId, "en")
    expect(await frChecklistCodes(site, postId)).toContain(
      "archived_relation_target"
    )
    await expect(
      site.owner.mutation(
        api.cms.publication.publishLocale,
        await publishArgs(site.t, postId, "fr")
      )
    ).rejects.toThrow("PUBLICATION_REFERENCE_TARGET_LOCALE_UNAVAILABLE")
  })

  // Round 2: the author's frozen ancestry names only its parent P, but P was
  // moved below a landing page and republished in French. The reader recurses
  // through P's current publication, so the switch-hidden answer must come from
  // the reader, not from a second walk of the frozen ancestry.
  test("a credit to an author whose parent was moved below a hidden page is accepted", profile, async () => {
    const site = await mlSite()
    const parentId = site.contactId
    const authorId = await childAuthor(site, "reparented", ["en", "fr"], parentId)
    // Give the author's French version a new address first, so its old one is
    // a historical address (published before the parent moves).
    const beforeMove = (await generations(site.t, authorId, "fr")).state!
    const oldPath = beforeMove.currentPath!
    const authorNow = await generations(site.t, authorId, "fr")
    await site.owner.mutation(api.cms.publication.saveLocaleDraft, {
      pageId: authorId,
      locale: "fr",
      slug: "reparente",
      draft: {
        pageType: "author",
        localized: { title: "reparented fr" },
        blocks: [],
      } as never,
      expectedDraftGeneration: authorNow.state!.draftGeneration,
      expectedLifecycleGeneration: authorNow.page!.lifecycleGeneration,
    })
    await publish(site, authorId, "fr")
    expect(await resolveHistorical(site.t, "fr", oldPath)).toMatchObject({
      disposition: "historical_redirect",
    })
    // Move P below the landing page and publish French P only. The author's
    // snapshots are not republished: they still name P as the only ancestor.
    const parentNow = await generations(site.t, parentId, "fr")
    await site.owner.mutation(api.cms.publication.saveEditorDraft, {
      pageId: parentId,
      expectedLifecycleGeneration: parentNow.page!.lifecycleGeneration,
      shared: {
        expectedGeneration: parentNow.shared!.generation,
        parentId: site.aboutId,
      },
    })
    await publish(site, parentId, "fr")
    const postId = await linker(site, "by-reparented", { authorId })
    await publish(site, postId, "en")
    expect(await publicPage(site.t, authorId, "fr")).not.toBeNull()
    await switchOff(site, "landing-page")
    await drain(site.t)
    // The reader hides the author through P's current chain.
    expect(await publicPage(site.t, authorId, "fr")).toBeNull()
    expect(await publicPage(site.t, authorId, "en")).not.toBeNull()
    expect(await frChecklistCodes(site, postId)).not.toContain(
      "archived_relation_target"
    )
    await publish(site, postId, "fr")
    expect(await publicPage(site.t, postId, "fr")).not.toBeNull()
    // The old address of the hidden author answers not found.
    expect(await resolveHistorical(site.t, "fr", oldPath)).toEqual({
      authority: "snapshot_active",
      disposition: "historical_unavailable",
    })
  })

  test("sweep: an old address of a page below a hidden parent keeps answering not found", profile, async () => {
    const site = await mlSite()
    const before = (await generations(site.t, site.teamId, "fr")).state!
    const oldPath = before.currentPath!
    // Move the French team page to a new address so the old one is historical.
    const now = await generations(site.t, site.teamId, "fr")
    await site.owner.mutation(api.cms.publication.saveLocaleDraft, {
      pageId: site.teamId,
      locale: "fr",
      slug: "equipe",
      draft: {
        pageType: "page",
        localized: { title: "team fr" },
        blocks: [],
      } as never,
      expectedDraftGeneration: now.state!.draftGeneration,
      expectedLifecycleGeneration: now.page!.lifecycleGeneration,
    })
    await publish(site, site.teamId, "fr")
    expect(await resolveHistorical(site.t, "fr", oldPath)).toMatchObject({
      disposition: "historical_redirect",
    })
    await switchOff(site, "landing-page")
    await drain(site.t)
    expect(await resolveHistorical(site.t, "fr", oldPath)).toEqual({
      authority: "snapshot_active",
      disposition: "historical_unavailable",
    })
  })

  test("a continuity address of a page below a hidden parent answers not found", profile, async () => {
    const site = await mlSite()
    await site.t.run(async (ctx) => {
      const owner = (await ctx.db.query("cmsOwner").unique())!
      const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
      const moduleState = (await ctx.db.query("cmsModuleState").unique())!
      const freshness = { routeClaimVersion: 0, publicationSetVersion: 0 }
      const migrationId = await ctx.db.insert("siteDefaultLanguageMigrations", {
        fromLocale: "fr",
        toLocale: "en",
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
          rows: 1,
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
      await ctx.db.insert("siteDefaultLanguageRoutes", {
        migrationId,
        generation: 1,
        pageId: site.teamId,
        locale: "fr",
        fromPath: "/old-french-team",
        origin: "old_default_current",
        createdAt: FIXED_NOW,
      })
      await ctx.db.patch("siteLanguageAuthority", authority._id, {
        continuityPointer: { migrationId, generation: 1 },
      })
    })
    expect(await resolveHistorical(site.t, "en", "/old-french-team")).toMatchObject({
      disposition: "historical_redirect",
      locale: "en",
    })
    await switchOff(site, "landing-page")
    await drain(site.t)
    expect(await resolveHistorical(site.t, "en", "/old-french-team")).toEqual({
      authority: "snapshot_active",
      disposition: "historical_unavailable",
    })
  })
})

describe("translation switch: impact", () => {
  test("counts what an off switch hides, with N+ when bounded", blockProfile(["rich-text-body"]), async () => {
    const site = await mlSite()
    const impact = (pageType: "landing-page" | "author") =>
      site.owner.query(api.cms.contentTypes.getContentTypeTranslationImpact, {
        pageType,
      })
    // landing-page: `about` in French (home is exempt). One child page of
    // another type (`team`) is published in French under it.
    await expect(impact("landing-page")).resolves.toEqual({
      keptLocale: "en",
      hiddenVersions: { count: 1, capped: false },
      linkingPages: { count: 0, capped: false },
      childPages: { count: 1, capped: false },
    })
    // author: Ada in French; the post credits her in French.
    await expect(impact("author")).resolves.toEqual({
      keptLocale: "en",
      hiddenVersions: { count: 1, capped: false },
      linkingPages: { count: 1, capped: false },
      childPages: { count: 0, capped: false },
    })
    // Once off, the kept language is the pinned one.
    await switchOff(site, "author")
    await expect(impact("author")).resolves.toMatchObject({ keptLocale: "en" })
  })

  test("a count above the usage cap is reported as capped", blockProfile(["rich-text-body"]), async () => {
    const site = await mlSite()
    // 30 more French versions of one type, cloned from `about`.
    await site.t.run(async (ctx) => {
      const strip = <R extends { _id: unknown; _creationTime: number }>(
        row: R
      ) => {
        const copy = { ...row } as Record<string, unknown>
        delete copy._id
        delete copy._creationTime
        return copy
      }
      const fr = (await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", site.aboutId).eq("locale", "fr")
        )
        .unique())!
      const lifecycle = (await ctx.db
        .query("pagePublicationPageStates")
        .withIndex("by_pageId", (q) => q.eq("pageId", site.aboutId))
        .unique())!
      const about = (await ctx.db.get("pages", site.aboutId))!
      for (let index = 0; index < 30; index++) {
        const pageId = await ctx.db.insert("pages", {
          ...strip(about),
          slug: `bulk-${index}`,
        } as never)
        await ctx.db.insert("pagePublicationPageStates", {
          ...strip(lifecycle),
          pageId,
        } as never)
        await ctx.db.insert("pageLocalePublicationStates", {
          ...strip(fr),
          pageId,
        } as never)
      }
    })
    const impact = await site.owner.query(
      api.cms.contentTypes.getContentTypeTranslationImpact,
      { pageType: "landing-page" }
    )
    expect(impact.hiddenVersions).toEqual({ count: 25, capped: true })
  })
})
