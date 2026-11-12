/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { ConvexError } from "convex/values"
import { api } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { convexTest } from "../convexTestWithExplicitAdmin"
import schema from "./schema"

// U3 (routing rework): the public resolver's self-heal candidate (chosen by site
// language order, never by browser language), plus the temporary (307) redirect status. Contract:
// `resolveHistoricalPublishedPath` in convex/cms/pages.ts.

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "u3-owner",
  tokenIdentifier: "https://convex.test|u3-owner",
}
const FIXED_NOW = Date.UTC(2026, 10, 2, 12, 0, 0)

type T = ReturnType<typeof convexTest>
type Caller = ReturnType<T["withIdentity"]>

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

async function publish(
  site: { t: T; owner: Caller },
  pageId: Id<"pages">,
  locale: string
) {
  const { state, shared, page } = await generations(site.t, pageId, locale)
  await site.owner.mutation(api.cms.publication.publishLocale, {
    pageId,
    locale,
    expectedDraftGeneration: state!.draftGeneration,
    expectedSharedDraftGeneration: shared!.generation,
    expectedPublicGeneration: state!.publicGeneration,
    expectedLifecycleGeneration: page!.lifecycleGeneration,
    expectedReleaseGeneration: state!.releaseGeneration,
  })
  await drain(site.t)
}

/** Draft a locale with its own (translated) slug, then publish it. */
async function publishTranslated(
  site: { t: T; owner: Caller },
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
      slices: [],
    } as never,
    expectedDraftGeneration: state?.draftGeneration ?? 0,
    expectedLifecycleGeneration: page!.lifecycleGeneration,
  })
  await publish(site, pageId, locale)
}

async function withdraw(
  site: { t: T; owner: Caller },
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

function createEnglishPage(owner: Caller, slug: string) {
  return owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug,
    title: slug,
    content: { en: { title: slug, slices: [] } },
  })
}

/**
 * Snapshot authority, `en` default with `fr` and `es` enabled (settings
 * order en, fr, es), a published home Page, multilingual authority adopted.
 */
async function site() {
  const t = convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
    publicationAuthority: "missing",
  })
  const owner = t.withIdentity(OWNER)
  await owner.mutation(api.cms.publication.initializeEmptySnapshotAuthority, {})
  const homeId = await createEnglishPage(owner, "home")
  await t.run((ctx) =>
    ctx.db.insert("siteSettings", {
      siteName: "U3 site",
      siteUrl: "",
      defaultLocale: "en",
      enabledLocales: ["en", "fr", "es"],
      homePageId: homeId,
      updatedAt: FIXED_NOW,
    })
  )
  const s = { t, owner, homeId }
  await publish(s, homeId, "en")
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
  return s
}

async function resolve(t: T, locale: string, path: string) {
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

/** An `about` page: en `/about`, fr `/a-propos`; es optional. */
async function aboutPage(s: Awaited<ReturnType<typeof site>>, es = false) {
  const aboutId = await createEnglishPage(s.owner, "about")
  await publish(s, aboutId, "en")
  await publishTranslated(s, aboutId, "fr", "a-propos")
  if (es) await publishTranslated(s, aboutId, "es", "acerca")
  return aboutId
}

describe("U3 resolveHistoricalPublishedPath: self-heal", () => {
  test("self-heal candidate: D3a prefers the request locale when the page is published there", async () => {
    const s = await site()
    const aboutId = await aboutPage(s)
    const en = await localeState(s.t, aboutId, "en")
    expect(await resolve(s.t, "en", "/a-propos")).toEqual({
      authority: "snapshot_active",
      disposition: "unclaimed",
      selfHeal: {
        pageId: aboutId,
        locale: "en",
        destinationPath: "/about",
        snapshotId: en.currentSnapshotId,
        publicGeneration: en.publicGeneration,
      },
    })
  })

  test("self-heal candidate: otherwise the matched locale", async () => {
    const s = await site()
    const soloId = await createEnglishPage(s.owner, "solo")
    await publishTranslated(s, soloId, "fr", "seulement")
    const fr = await localeState(s.t, soloId, "fr")
    expect(await resolve(s.t, "en", "/seulement")).toEqual({
      authority: "snapshot_active",
      disposition: "unclaimed",
      selfHeal: {
        pageId: soloId,
        locale: "fr",
        destinationPath: "/seulement",
        snapshotId: fr.currentSnapshotId,
        publicGeneration: fr.publicGeneration,
      },
    })
  })

  test("self-heal ignores any browser language: the resolver takes no such argument", async () => {
    const s = await site()
    const aboutId = await aboutPage(s, true)
    const fr = await localeState(s.t, aboutId, "fr")
    const { languageVersion } = await s.t.query(api.cms.settings.getSiteConfig, {})
    // /a-propos is the fr path; the page is also published in en: D3a keeps
    // the request locale. An extra preferredLocale is rejected, not honoured.
    await expect(
      s.t.query(api.cms.pages.resolveHistoricalPublishedPath, {
        locale: "en",
        path: "/a-propos",
        languageVersion,
        preferredLocale: "es",
      } as never)
    ).rejects.toThrow()
    expect(fr.currentSnapshotId).toBeDefined()
  })

  test("default home unpublished, French home published: / heals to the French home, whatever the browser", async () => {
    const s = await site()
    await publishTranslated(s, s.homeId, "fr", "accueil")
    await withdraw(s, s.homeId, "en")
    const fr = await localeState(s.t, s.homeId, "fr")
    expect(await resolve(s.t, "en", "/")).toEqual({
      authority: "snapshot_active",
      disposition: "unclaimed",
      selfHeal: {
        pageId: s.homeId,
        locale: "fr",
        destinationPath: "/",
        snapshotId: fr.currentSnapshotId,
        publicGeneration: fr.publicGeneration,
      },
    })
  })

  test("site default is English, English home unpublished, French home published: / gives the French home", async () => {
    const s = await site()
    // site() already stores defaultLocale "en"; rewriting the settings row
    // after adoption breaks the language authority (SITE_LANGUAGE_AUTHORITY_INVALID).
    const settings = await s.t.run((ctx) => ctx.db.query("siteSettings").first())
    expect(settings?.defaultLocale).toBe("en")
    await publishTranslated(s, s.homeId, "fr", "accueil")
    await withdraw(s, s.homeId, "en")
    const fr = await localeState(s.t, s.homeId, "fr")
    expect(await resolve(s.t, "en", "/")).toMatchObject({
      disposition: "unclaimed",
      selfHeal: {
        pageId: s.homeId,
        locale: "fr",
        destinationPath: "/",
        snapshotId: fr.currentSnapshotId,
      },
    })
  })

  test("three languages: / heals to the first published home in site language order", async () => {
    const s = await site()
    await publishTranslated(s, s.homeId, "es", "inicio")
    await publishTranslated(s, s.homeId, "fr", "accueil")
    await withdraw(s, s.homeId, "en")
    expect(await resolve(s.t, "en", "/")).toMatchObject({
      selfHeal: { pageId: s.homeId, locale: "fr", destinationPath: "/" },
    })
    await withdraw(s, s.homeId, "fr")
    expect(await resolve(s.t, "en", "/")).toMatchObject({
      selfHeal: { pageId: s.homeId, locale: "es", destinationPath: "/" },
    })
  })

  test("non-home page, default version unpublished, French published: /about is NOT healed (no candidate, so not found); the French path heals", async () => {
    const s = await site()
    const aboutId = await aboutPage(s)
    await withdraw(s, aboutId, "en")
    // Self-heal matches by path: /about is no page's path in any other
    // language, so nothing is offered and the request stays unclaimed.
    expect(await resolve(s.t, "en", "/about")).toEqual({
      authority: "snapshot_active",
      disposition: "unclaimed",
    })
    // Only the French path itself reaches the French page.
    expect(await resolve(s.t, "en", "/a-propos")).toMatchObject({
      selfHeal: { pageId: aboutId, locale: "fr", destinationPath: "/a-propos" },
    })
  })

  test("non-home page with the same slug in both languages: default unpublished heals to French", async () => {
    const s = await site()
    const pageId = await createEnglishPage(s.owner, "contact")
    await publish(s, pageId, "en")
    await publishTranslated(s, pageId, "fr", "contact")
    await withdraw(s, pageId, "en")
    expect(await resolve(s.t, "en", "/contact")).toMatchObject({
      selfHeal: { pageId, locale: "fr", destinationPath: "/contact" },
    })
  })

  test("self-heal ties go to the first enabled locale in settings order", async () => {
    const s = await site()
    const aId = await createEnglishPage(s.owner, "a")
    const bId = await createEnglishPage(s.owner, "b")
    await publishTranslated(s, aId, "es", "compartido")
    await publishTranslated(s, bId, "fr", "compartido")
    // Settings order is en, fr, es: fr's page wins although es came first.
    const result = await resolve(s.t, "en", "/compartido")
    expect(result).toMatchObject({
      disposition: "unclaimed",
      selfHeal: { pageId: bId, locale: "fr", destinationPath: "/compartido" },
    })
  })

  test("self-heal finds an F08 historical path of another locale", async () => {
    const s = await site()
    const snapshotId = (await localeState(s.t, s.homeId, "en"))
      .currentSnapshotId!
    await publishTranslated(s, s.homeId, "fr", "accueil-fr")
    const frSnapshot = (await localeState(s.t, s.homeId, "fr"))
      .currentSnapshotId!
    void snapshotId
    // fr's frozen home alias `/accueil` (the home page's path is `/`).
    await s.t.run((ctx) =>
      ctx.db.insert("pageHistoricalLocaleRoutes", {
        pageId: s.homeId,
        locale: "fr",
        fromPath: "/accueil",
        createdFromSnapshotId: frSnapshot,
        createdAt: FIXED_NOW,
      })
    )
    const result = await resolve(s.t, "en", "/accueil")
    expect(result).toMatchObject({
      disposition: "unclaimed",
      selfHeal: { pageId: s.homeId, locale: "en", destinationPath: "/" },
    })
  })

  test("self-heal skips a locale whose projection is unavailable", async () => {
    const s = await site()
    const soloId = await createEnglishPage(s.owner, "solo")
    await publishTranslated(s, soloId, "fr", "seulement")
    const state = await localeState(s.t, soloId, "fr")
    await s.t.run((ctx) =>
      ctx.db.patch(state._id, { hasCurrentSnapshot: false })
    )
    expect(await resolve(s.t, "en", "/seulement")).toEqual({
      authority: "snapshot_active",
      disposition: "unclaimed",
    })
  })

  test("no self-heal for a path no page claims, nor when the URL is current", async () => {
    const s = await site()
    const aboutId = await aboutPage(s)
    expect(await resolve(s.t, "en", "/nothing-here")).toEqual({
      authority: "snapshot_active",
      disposition: "unclaimed",
    })
    expect(await resolve(s.t, "en", "/about")).not.toHaveProperty("selfHeal")
    void aboutId
  })

  test("historical_unavailable is terminal: no self-heal", async () => {
    const s = await site()
    const aboutId = await aboutPage(s)
    const snapshotId = (await localeState(s.t, aboutId, "en"))
      .currentSnapshotId!
    // A malformed reservation: the frozen path does not match fromPath.
    await s.t.run((ctx) =>
      ctx.db.insert("pageHistoricalLocaleRoutes", {
        pageId: aboutId,
        locale: "en",
        fromPath: "/a-propos",
        createdFromSnapshotId: snapshotId,
        createdAt: FIXED_NOW,
      })
    )
    expect(await resolve(s.t, "en", "/a-propos")).toEqual({
      authority: "snapshot_active",
      disposition: "historical_unavailable",
    })
  })
})

describe("U3 continuity: temporary status and D3a for pointed rows", () => {
  async function storePointed(
    t: T,
    rows: readonly { fromPath: string; pageId: Id<"pages"> }[]
  ) {
    return t.run(async (ctx) => {
      const owner = (await ctx.db.query("cmsOwner").unique())!
      const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
      const moduleState = (await ctx.db.query("cmsModuleState").unique())!
      const freshness = { routeClaimVersion: 0, publicationSetVersion: 0 }
      const migrationId = await ctx.db.insert("siteDefaultLanguageMigrations", {
        fromLocale: "es",
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
          locale: "fr",
          fromPath: row.fromPath,
          origin: "old_default_current",
          createdAt: FIXED_NOW,
        })
      }
      await ctx.db.patch(authority._id, {
        continuityPointer: { migrationId, generation: 1 },
      })
    })
  }

  test("a pointed C3b row applies D3a: the request locale first, else the row locale; 307", async () => {
    const s = await site()
    const aboutId = await aboutPage(s)
    await storePointed(s.t, [{ fromPath: "/ancien", pageId: aboutId }])
    const en = await localeState(s.t, aboutId, "en")
    // Current in the request locale (en): the page in en, not the row's fr.
    expect(await resolve(s.t, "en", "/ancien")).toEqual({
      authority: "snapshot_active",
      disposition: "historical_redirect",
      pageId: aboutId,
      locale: "en",
      snapshotId: en.currentSnapshotId,
      publicGeneration: en.publicGeneration,
      destinationPath: "/about",
      statusCode: 307,
    })
    // Not current in en: the row's own locale (fr).
    await withdraw(s, aboutId, "en")
    const fr = await localeState(s.t, aboutId, "fr")
    expect(await resolve(s.t, "en", "/ancien")).toEqual({
      authority: "snapshot_active",
      disposition: "historical_redirect",
      pageId: aboutId,
      locale: "fr",
      snapshotId: fr.currentSnapshotId,
      publicGeneration: fr.publicGeneration,
      destinationPath: "/a-propos",
      statusCode: 307,
    })
  })
})
