import { expectLegacyPanel as legacyPanel } from "@/test-utils/menu-panel"
import { mergeLocale, projectLocale, withAuthoredAlt } from "@/lib/admin/menu/locale-projection"
import type { NavItem } from "./lib/menu"
import { createSampleSlice } from "@/convex/lib/slices/sample"
/// <reference types="vite/client" />
import { sliceProfile } from "@/test-utils/slice-profile"
import { convexTest } from "../convexTestWithExplicitAdmin"
import { expect, test, describe, vi } from "vitest"
import { api, internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import type { FunctionArgs } from "convex/server"
import type { Slice } from "./lib/slices"
import { CONTENT_TYPES, isActiveContentType } from "./lib/contentTypes"
import schema from "./schema"
import actionRetrierTest from "@convex-dev/action-retrier/test"
import { approveDueEditionPagesForTest } from "../editionTestHelpers"

import { enableRedirectsForTest } from "../redirectsTestHelpers"

const canonicalBody = (text: string) =>
  JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        ...(text ? { content: [{ type: "text", text }] } : {}),
      },
    ],
  })

const modules = import.meta.glob("./**/*.ts")
const testimonialActive = isActiveContentType("testimonial")
const activeTestimonialTest = testimonialActive ? test : test.skip

const TEST_USER = {
  subject: "test-user",
  tokenIdentifier: "https://convex.test|test-user",
  name: "Test User",
  email: "test@example.com",
}

function pageTest() {
  return convexTest({
    schema,
    modules,
    ownerIdentity: TEST_USER,
  })
}

/**
 * Read a page's stored revisions newest first. Core writers record revisions
 * through `createPageRevision`; listing them is History (M06), so core tests
 * read the `pageRevisions` compatibility table directly.
 */
async function readPageRevisions(
  t: ReturnType<typeof pageTest>,
  pageId: Id<"pages">,
  limit: number
) {
  return t.run(async (ctx) => {
    const rows = await ctx.db
      .query("pageRevisions")
      .withIndex("by_pageId_and_revisionNumber", (q) => q.eq("pageId", pageId))
      .order("desc")
      .take(limit)
    return rows.map((row) => ({
      ...row,
      content:
        row.contentJson === undefined
          ? undefined
          : (JSON.parse(row.contentJson) as Record<string, { title?: string }>),
    }))
  })
}

async function createTestAuthor(
  t: ReturnType<typeof convexTest>,
  actor: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
  args: Omit<FunctionArgs<typeof api.cms.pages.create>, "pageType">
): Promise<Id<"pages">> {
  const { status, ...rest } = args
  const pageId = await actor.mutation(api.cms.pages.create, {
    ...rest,
    pageType: "author",
    status: "draft",
  })
  if (status === "published") {
    await actor.mutation(api.cms.pages.publish, { pageId })
  } else if (status === "archived") {
    await actor.mutation(api.cms.pages.update, {
      id: pageId,
      status: "archived",
    })
  }
  return pageId
}

/**
 * Schedule a page's publish via the ADR-0041 staging seam. Replaces the
 * legacy `pages.update({ scheduledAt })` calls after PR B moved
 * scheduling off `pages`. Acquires the editor lock first (with `force`)
 * because updateDraft requires it — tests don't route through the
 * editor's presence-based lock acquisition.
 */
async function scheduleViaDraft(
  asUser: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
  pageId: Id<"pages">,
  scheduledAt: number
) {
  await asUser.mutation(api.cms.pages.acquirePageEditorLock, {
    pageId,
    force: true,
  })
  await asUser.mutation(api.cms.pages.updateDraft, {
    pageId,
    scheduledAt,
  })
}

async function insertPilotFixturePages(
  t: ReturnType<typeof convexTest>,
  options: {
    start: number
    count: number
    status: "draft" | "published"
  }
): Promise<Id<"pages">[]> {
  return t.run(async (ctx) => {
    const now = Date.now()
    const ids: Id<"pages">[] = []
    for (let offset = 0; offset < options.count; offset += 1) {
      const index = options.start + offset
      ids.push(
        await ctx.db.insert("pages", {
          slug: `pilot-fixture-${index}`,
          pageType: "page",
          status: options.status,
          createdAt: now,
          updatedAt: now,
          ...(options.status === "published" ? { publishedAt: now } : {}),
          content: {
            en: { title: `Pilot fixture ${index}`, slices: [] },
          },
        })
      )
    }
    return ids
  })
}

/**
 * Compat helper for tests written against the retired
 * `updateLocaleContent` mutation (ADR-0041 Deploy 3 Narrow).
 *
 * Original semantics: write the locale bag onto `pages.content`
 * immediately (live) + mirror the same bag onto `pageStaging.content`
 * for non-published pages. Callers asserted `getById().content[locale]`
 * right after the call, so "immediately live" was load-bearing.
 *
 * New pipeline: `updateDraft` writes to staging only; `pages.publish`
 * promotes staging → live and deletes staging. This helper reproduces
 * the "immediately live" behavior by chaining lock + `updateDraft` +
 * `pages.publish`, which is the only way a save reaches
 * `pages.content` post-Deploy 2. Tests that specifically want the
 * draft-only working-copy semantics call `updateDraft` directly and
 * read via `getStagedPreviewById`.
 *
 * `expectedUpdatedAt` is deliberately ignored: the retired mutation
 * gated on `pages.updatedAt`, but `updateDraft`'s OCC token is
 * `pageStaging.updatedAt` (a different clock). The two disagree for
 * seeded-staging pages, and forwarding the page token would trip
 * `assertStagingFresh` spuriously. Tests that specifically prove the
 * stale-save gate must call `updateDraft` directly with a staging
 * token from `getStagedPreviewById.stagingUpdatedAt`.
 *
 * Consequence: every helper call now generates a `"publish"` revision
 * instead of `"manual_save"`. Tests asserting on revision reasons were
 * updated in this deploy to expect `"publish"`.
 *
 * Slug routing mirrors the retired mutation: the base `slug` is
 * written on the DEFAULT locale, and other locales set
 * `localizedSlugs[locale]`. Tests never invoke this helper before
 * completing onboarding with a non-`"en"` default locale, so hardcoding
 * `"en"` matches every existing caller (a stray non-`"en"` default
 * would surface as a slug-not-updated assertion, not a silent skew).
 */
async function callUpdateLocaleContent(
  asUser: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
  args: {
    pageId: Id<"pages">
    locale: string
    title: string
    slices?: Slice[]
    slug?: string
    metaTitle?: string
    metaDescription?: string
    expectedUpdatedAt?: number
  }
) {
  const stored = await asUser.query(api.cms.pages.getById, { id: args.pageId })
  if (!stored) throw new Error(`page ${args.pageId} not found`)
  const sliceBodyPageType = stored.pageType as Exclude<
    typeof stored.pageType,
    "testimonial"
  >
  await asUser.mutation(api.cms.pages.acquirePageEditorLock, {
    pageId: args.pageId,
    force: true,
  })
  // Per-locale slug routing — default locale writes the base `slug`;
  // other locales stage a `localizedSlugs[locale]` override.
  const defaultLocale = "en"
  const slugArgs: {
    slug?: string
    localizedSlugs?: Record<string, string>
  } = {}
  if (args.slug !== undefined) {
    if (args.locale === defaultLocale) {
      slugArgs.slug = args.slug
    } else {
      slugArgs.localizedSlugs = {
        ...(stored.localizedSlugs ?? {}),
        [args.locale]: args.slug,
      }
    }
  }
  const staged = await asUser.mutation(api.cms.pages.updateDraft, {
    pageId: args.pageId,
    ...slugArgs,
    content: {
      [args.locale]: {
        pageType: sliceBodyPageType,
        localized: {
          title: args.title,
          ...(args.metaTitle !== undefined
            ? { metaTitle: args.metaTitle }
            : {}),
          ...(args.metaDescription !== undefined
            ? { metaDescription: args.metaDescription }
            : {}),
        },
        slices: args.slices ?? [],
      },
    },
  })
  await asUser.mutation(api.cms.pages.publish, { pageId: args.pageId })
  return staged
}

describe("pages — slug uniqueness", () => {
  test("two pages cannot share the same slug", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    await asUser.mutation(api.cms.pages.create, {
      slug: "about",
      pageType: "landing-page",
      status: "draft",
      title: "About",
    })

    await expect(
      asUser.mutation(api.cms.pages.create, {
        slug: "about",
        pageType: "landing-page",
        status: "draft",
        title: "About 2",
      })
    ).rejects.toThrow("already taken")
  })

  test(
    "create keeps today's address for ASCII and Latin-accented titles",
    sliceProfile([]),
    async () => {
      const t = pageTest()
      const asUser = t.withIdentity(TEST_USER)
      const expected: Array<[string, string]> = [
        ["Hello World", "hello-world"],
        ["Résultats 2026", "resultats-2026"],
        ["a_b c", "a-b-c"],
        ["  --x--  ", "x"],
        ["Ça va?", "ca-va"],
        ["Иван 2", "2"],
      ]
      for (const [title, slug] of expected) {
        const id = await asUser.mutation(api.cms.pages.create, {
          pageType: "landing-page",
          status: "draft",
          title,
        })
        const page = await t.run((ctx) => ctx.db.get(id))
        expect(page?.slug, title).toBe(slug)
      }
    }
  )

  test(
    "create gives a non-Latin title a stable page-<hash> address",
    sliceProfile([]),
    async () => {
      const t = pageTest()
      const asUser = t.withIdentity(TEST_USER)
      const titles: Array<[string, string]> = [
        ["Иван", "page-114d4170"],
        ["東京", "page-06271ed0"],
        ["서울", "page-f1ca7419"],
        ["नमस्ते", "page-a4718a3d"],
      ]
      for (const [title, slug] of titles) {
        const id = await asUser.mutation(api.cms.pages.create, {
          pageType: "landing-page",
          status: "draft",
          title,
        })
        const page = await t.run((ctx) => ctx.db.get(id))
        expect(page?.slug, title).toBe(slug)
      }
    }
  )

  test(
    "two pages with the same non-Latin title collide like two ASCII pages do",
    sliceProfile([]),
    async () => {
      const t = pageTest()
      const asUser = t.withIdentity(TEST_USER)
      for (const title of ["Same title", "Иван"]) {
        const firstId = await asUser.mutation(api.cms.pages.create, {
          pageType: "landing-page",
          status: "draft",
          title,
        })
        await expect(
          asUser.mutation(api.cms.pages.create, {
            pageType: "landing-page",
            status: "draft",
            title,
          })
        ).rejects.toThrow("already taken")
        const first = await t.run((ctx) => ctx.db.get(firstId))
        expect(first?.slug).not.toBe("")
        const sameAddress = await t.run((ctx) =>
          ctx.db
            .query("pages")
            .collect()
            .then((rows) => rows.filter((row) => row.slug === first?.slug))
        )
        expect(sameAddress).toHaveLength(1)
      }
    }
  )

  // Publish validates every changed slug in ONE table scan instead of one scan
  // per slug. These cover the collision shapes that batching could have
  // regressed: a localized slug colliding with another page, and two locales
  // on the SAME page colliding with each other (only reachable once the checks
  // share a pass).
  test("publish rejects a localized slug that collides with another page", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    await asUser.mutation(api.cms.pages.create, {
      slug: "taken-by-other",
      pageType: "landing-page",
      status: "published",
      title: "Other",
    })
    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Mine",
      content: { en: { title: "Mine", slices: [] } },
    })

    await asUser.mutation(api.cms.pages.heartbeatPageEditor, { pageId })
    await asUser.mutation(api.cms.pages.updateDraft, {
      pageId,
      localizedSlugs: { fr: "taken-by-other" },
    })

    await expect(
      asUser.mutation(api.cms.pages.publish, { pageId })
    ).rejects.toThrow("already taken")
  })

  test("publish rejects two locales staging the same slug", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Dup locales",
      content: { en: { title: "Dup locales", slices: [] } },
    })

    await asUser.mutation(api.cms.pages.heartbeatPageEditor, { pageId })
    await asUser.mutation(api.cms.pages.updateDraft, {
      pageId,
      localizedSlugs: { fr: "same-slug", es: "same-slug" },
    })

    await expect(
      asUser.mutation(api.cms.pages.publish, { pageId })
    ).rejects.toThrow("already taken")
  })

  test("publish accepts distinct localized slugs", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Distinct locales",
      content: { en: { title: "Distinct locales", slices: [] } },
    })

    await asUser.mutation(api.cms.pages.heartbeatPageEditor, { pageId })
    await asUser.mutation(api.cms.pages.updateDraft, {
      pageId,
      localizedSlugs: { fr: "distinct-fr", es: "distinct-es" },
    })

    await asUser.mutation(api.cms.pages.publish, { pageId })
    const published = await asUser.query(api.cms.pages.getById, { id: pageId })
    expect(published?.status).toBe("published")
  })

  test("slug is auto-generated from title if not provided", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const id = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "My First Page",
    })

    const page = await asUser.query(api.cms.pages.getById, { id })
    expect(page?.slug).toBe("my-first-page")
  })
})

describe("pages — duplicate", () => {
  test("uses the confirmed title for the default locale without flattening translations", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const sourceId = await asUser.mutation(api.cms.pages.create, {
      pageType: "page",
      status: "draft",
      title: "About",
      content: {
        en: { title: "About", slices: [] },
        fr: { title: "À propos", slices: [] },
      },
    })

    const duplicateId = await asUser.mutation(api.cms.pages.duplicate, {
      id: sourceId,
      title: "  Our story  ",
    })
    const duplicate = await asUser.query(api.cms.pages.getStagedPreviewById, {
      id: duplicateId,
    })

    expect(duplicate?.page.content?.en.title).toBe("Our story")
    expect(duplicate?.page.content?.fr.title).toBe("À propos (Copy)")
  })

  test("rejects a blank confirmed title", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    const sourceId = await asUser.mutation(api.cms.pages.create, {
      pageType: "page",
      status: "draft",
      title: "About",
    })

    await expect(
      asUser.mutation(api.cms.pages.duplicate, {
        id: sourceId,
        title: "   ",
      })
    ).rejects.toThrow("Title is required")
  })
})

describe("pages — homepage locale resolution", () => {
  test("serves a published home/homepage landing page at default-locale root", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const id = await asUser.mutation(api.cms.pages.create, {
      slug: "home",
      pageType: "landing-page",
      status: "published",
      title: "Home",
      content: {
        en: { title: "Home", slices: [] },
      },
    })

    await expect(
      t.query(api.cms.pages.resolveLocalizedPathQuery, {
        languageVersion: 0,
        path: "/",
        locale: "en",
      })
    ).resolves.toBe(id)

    await expect(
      t.query(api.cms.settings.getSiteConfig, {})
    ).resolves.toMatchObject({
      homePageId: id,
    })

    await expect(
      t.query(api.cms.pages.getPublicLocaleAlternates, {
        languageVersion: 0,
        pageId: id,
      })
    ).resolves.toContainEqual(
      expect.objectContaining({ locale: "en", url: "/" })
    )
  })

  test("ignores a stale configured homePageId and falls back to the published homepage", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const staleId = await asUser.mutation(api.cms.pages.create, {
      slug: "old-home",
      pageType: "landing-page",
      status: "draft",
      title: "Old home",
      content: {
        en: { title: "Old home", slices: [] },
      },
    })
    const homeId = await asUser.mutation(api.cms.pages.create, {
      slug: "homepage",
      pageType: "landing-page",
      status: "published",
      title: "Home",
      content: {
        en: { title: "Home", slices: [] },
      },
    })

    await t.run((ctx) =>
      ctx.db.insert("siteSettings", {
        siteName: "Site",
        siteUrl: "",
        defaultLocale: "en",
        enabledLocales: ["en"],
        homePageId: staleId,
        timezone: "UTC",
        updatedAt: Date.now(),
      })
    )

    await expect(
      t.query(api.cms.settings.getSiteConfig, {})
    ).resolves.toMatchObject({
      homePageId: homeId,
    })

    await expect(
      t.query(api.cms.pages.getLocalizedPathsByIds, {
        languageVersion: 0,
        ids: [homeId],
        locale: "en",
      })
    ).resolves.toMatchObject({
      [homeId]: "/",
    })
  })

  test("serves a locale-specific home slug at the locale root", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    await asUser.mutation(api.cms.settings.completeOnboarding, {
      siteName: "Site",
      siteUrl: "https://example.com",
      timezone: "UTC",
      defaultLocale: "en",
      enabledLocales: ["en", "fr"],
    })

    const id = await asUser.mutation(api.cms.pages.create, {
      slug: "accuiel",
      pageType: "landing-page",
      status: "published",
      title: "Accueil",
      content: {
        en: { title: "Accueil", slices: [] },
        fr: { title: "Accueil", slices: [] },
      },
    })

    await expect(
      t.query(api.cms.pages.resolveLocalizedPathQuery, {
        languageVersion: 0,
        path: "/",
        locale: "fr",
      })
    ).resolves.toBe(id)

    await expect(
      t.query(api.cms.pages.getPublicLocaleAlternates, {
        languageVersion: 0,
        pageId: id,
      })
    ).resolves.toContainEqual(
      expect.objectContaining({ locale: "fr", url: "/fr" })
    )
  })

  test("hides default-locale Home content from an unavailable enabled locale", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const id = await asUser.mutation(api.cms.pages.create, {
      slug: "home",
      pageType: "landing-page",
      status: "published",
      title: "Home",
      content: { en: { title: "Home", slices: [] } },
    })
    await t.run((ctx) =>
      ctx.db.insert("siteSettings", {
        siteName: "Site",
        siteUrl: "",
        defaultLocale: "en",
        enabledLocales: ["en", "es"],
        homePageId: id,
        timezone: "UTC",
        updatedAt: Date.now(),
      })
    )

    await expect(
      t.query(api.cms.pages.resolveLocalizedPathQuery, {
        languageVersion: 0,
        path: "/",
        locale: "es",
      })
    ).resolves.toBeNull()

    // Authentication cannot turn the public resolver into a draft reader.
    await expect(
      asUser.query(api.cms.pages.resolveLocalizedPathQuery, {
        languageVersion: 0,
        path: "/",
        locale: "es",
      })
    ).resolves.toBeNull()
  })
})

describe("pages — public sitemap listing", () => {
  test("legacy authority lists published pages per locale without auth and exposes only sitemap fields", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    await asUser.mutation(api.cms.pages.create, {
      slug: "services",
      pageType: "page",
      status: "published",
      title: "Services",
      content: {
        en: { title: "Services", slices: [] },
        fr: { title: "Services FR", slices: [] },
      },
    })
    await asUser.mutation(api.cms.pages.create, {
      slug: "draft",
      pageType: "page",
      status: "draft",
      title: "Draft",
      content: {
        en: { title: "Draft", slices: [] },
      },
    })
    const deletedId = await asUser.mutation(api.cms.pages.create, {
      slug: "deleted",
      pageType: "page",
      status: "published",
      title: "Deleted",
      content: {
        en: { title: "Deleted", slices: [] },
      },
    })
    await t.run((ctx) => ctx.db.patch(deletedId, { deletedAt: Date.now() }))
    await t.run((ctx) =>
      ctx.db.insert("siteSettings", {
        siteName: "Site",
        siteUrl: "",
        defaultLocale: "en",
        enabledLocales: ["en", "fr"],
        timezone: "UTC",
        updatedAt: Date.now(),
      })
    )

    // M05 C5a: the legacy authority has one version-0 child per locale.
    const child = (locale: string) =>
      t.query(api.cms.pages.getSitemapChild, {
        languageVersion: 0,
        manifestVersion: 0,
        locale,
        ordinal: 0,
      })
    const en = await child("en")
    const fr = await child("fr")
    const alternates = [
      { locale: "en", url: "/services" },
      { locale: "fr", url: "/fr/services" },
    ]
    expect(en).toMatchObject({
      status: "ok",
      entries: [{ url: "/services", alternates }],
    })
    expect(fr).toMatchObject({
      status: "ok",
      entries: [{ url: "/fr/services", alternates }],
    })
    const entry = en.status === "ok" ? en.entries[0] : undefined
    expect(Object.keys(entry ?? {}).toSorted()).toEqual([
      "alternates",
      "lastModified",
      "priority",
      "url",
    ])
  })
})

describe("pages — bounded pilot envelope", () => {
  test("signals the 80% capacity warning before the 499-page maximum", sliceProfile([]), async () => {
    const t = pageTest()
    await insertPilotFixturePages(t, {
      start: 0,
      count: 399,
      status: "published",
    })

    await expect(
      t.query(api.cms.pages.getBoundedPilotEnvelope, {})
    ).resolves.toEqual({
      withinEnvelope: true,
      totalPagesBelowCap: true,
      publishedPagesBelowCap: true,
      totalPagesAtOrAboveWarningThreshold: false,
      publishedPagesAtOrAboveWarningThreshold: false,
    })

    await insertPilotFixturePages(t, {
      start: 399,
      count: 1,
      status: "published",
    })

    await expect(
      t.query(api.cms.pages.getBoundedPilotEnvelope, {})
    ).resolves.toEqual({
      withinEnvelope: true,
      totalPagesBelowCap: true,
      publishedPagesBelowCap: true,
      totalPagesAtOrAboveWarningThreshold: true,
      publishedPagesAtOrAboveWarningThreshold: true,
    })
  })

  test("reports the exact 500-row sentinel without exposing catalog counts", sliceProfile([]), async () => {
    const t = pageTest()
    await insertPilotFixturePages(t, {
      start: 0,
      count: 499,
      status: "published",
    })

    await expect(
      t.query(api.cms.pages.getBoundedPilotEnvelope, {})
    ).resolves.toEqual({
      withinEnvelope: true,
      totalPagesBelowCap: true,
      publishedPagesBelowCap: true,
      totalPagesAtOrAboveWarningThreshold: true,
      publishedPagesAtOrAboveWarningThreshold: true,
    })

    await insertPilotFixturePages(t, {
      start: 499,
      count: 1,
      status: "published",
    })
    await expect(
      t.query(api.cms.pages.getBoundedPilotEnvelope, {})
    ).resolves.toEqual({
      withinEnvelope: false,
      totalPagesBelowCap: false,
      publishedPagesBelowCap: false,
      totalPagesAtOrAboveWarningThreshold: true,
      publishedPagesAtOrAboveWarningThreshold: true,
    })
  })

  test("ordinary creation cannot make a bounded read reach 500 rows", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    await insertPilotFixturePages(t, {
      start: 0,
      count: 498,
      status: "draft",
    })

    await expect(
      asUser.mutation(api.cms.pages.create, {
        slug: "pilot-row-499",
        pageType: "page",
        status: "draft",
        title: "Row 499",
      })
    ).resolves.toBeDefined()
    await expect(
      asUser.mutation(api.cms.pages.create, {
        slug: "pilot-row-500",
        pageType: "page",
        status: "draft",
        title: "Row 500",
      })
    ).rejects.toThrow(/Bounded pilot envelope reached.*499 pages/)
  })

  test("ordinary promotion refuses a legacy tree that already reaches the sentinel", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    await insertPilotFixturePages(t, {
      start: 0,
      count: 499,
      status: "published",
    })
    const [draftId] = await insertPilotFixturePages(t, {
      start: 499,
      count: 1,
      status: "draft",
    })
    await t.run(async (ctx) => {
      await ctx.db.insert("pageStaging", {
        pageId: draftId!,
        pageType: "page",
        createdBy: TEST_USER.subject,
        updatedAt: Date.now(),
        content: { en: { title: "Legacy draft", slices: [] } },
      })
    })

    await expect(
      asUser.mutation(api.cms.pages.publish, { pageId: draftId! })
    ).rejects.toThrow(/Bounded pilot envelope reached.*499 pages/)
  })

  test("hard deletion releases the transactionally reserved page slot", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "page",
      status: "published",
      title: "Disposable pilot page",
      content: { en: { title: "Disposable pilot page", slices: [] } },
    })

    await asUser.mutation(api.cms.pages.remove, { id: pageId })
    await t.run(async (ctx) => {
      const ledger = await ctx.db.query("pilotEnvelope").first()
      expect(ledger).toMatchObject({
        totalPageCount: 0,
        publishedPageCount: 0,
      })
    })
  })
})

describe("pages — public read boundaries", () => {
  test("anonymous raw page reads stay private while the public reader admits only live rows", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const publishedId = await asUser.mutation(api.cms.pages.create, {
      slug: "public-page",
      pageType: "page",
      status: "published",
      title: "Public page",
      content: { en: { title: "Public page", slices: [] } },
    })
    const draftId = await asUser.mutation(api.cms.pages.create, {
      slug: "private-draft",
      pageType: "page",
      status: "draft",
      title: "Private Draft",
      content: { en: { title: "Private Draft", slices: [] } },
    })
    const archivedId = await asUser.mutation(api.cms.pages.create, {
      slug: "private-archived",
      pageType: "page",
      status: "archived",
      title: "Private Archived",
      content: { en: { title: "Private Archived", slices: [] } },
    })
    const deletedId = await asUser.mutation(api.cms.pages.create, {
      slug: "private-deleted",
      pageType: "page",
      status: "published",
      title: "Private Deleted",
      content: { en: { title: "Private Deleted", slices: [] } },
    })
    await t.run((ctx) => ctx.db.patch(deletedId, { deletedAt: Date.now() }))

    await expect(
      t.query(api.cms.pages.getById, { id: draftId })
    ).resolves.toBeNull()
    await expect(
      t.query(api.cms.pages.getById, { id: publishedId })
    ).resolves.toBeNull()
    await expect(
      t.query(api.cms.pages.getById, { id: archivedId })
    ).resolves.toBeNull()
    await expect(
      t.query(api.cms.pages.getPublishedById, { id: publishedId })
    ).resolves.toBeNull()
    await expect(
      t.query(api.cms.pages.getPublishedById, { id: deletedId })
    ).resolves.toBeNull()
    await expect(
      t.query(api.cms.pages.getPublicPageById, {
        languageVersion: 0,
        id: publishedId,
        locale: "en",
      })
    ).resolves.toMatchObject({
      _id: publishedId,
      pageType: "page",
      content: { en: { title: "Public page" } },
    })
    await expect(
      t.query(api.cms.pages.getPublicPageById, {
        languageVersion: 0,
        id: draftId,
        locale: "en",
      })
    ).resolves.toBeNull()
    await expect(
      t.query(api.cms.pages.getPublicPageById, {
        languageVersion: 0,
        id: archivedId,
        locale: "en",
      })
    ).resolves.toBeNull()
    await expect(
      t.query(api.cms.pages.getPublicPageById, {
        languageVersion: 0,
        id: deletedId,
        locale: "en",
      })
    ).resolves.toBeNull()
    await expect(
      asUser.query(api.cms.pages.getById, { id: draftId })
    ).resolves.toMatchObject({ status: "draft" })
  })

  test("public page projection is exact, locale-strict, and excludes private system fields", sliceProfile([]), async () => {
    const t = pageTest()
    const pageId = await t.run(async (ctx) => {
      const now = Date.now()
      return await ctx.db.insert("pages", {
        slug: "projection-boundary",
        pageType: "page",
        status: "published",
        createdAt: now,
        updatedAt: now,
        createdBy: "private-owner-id",
        template: "internal-template",
        ancestryPath: "/private-parent",
        hierarchyDepth: 4,
        showOnHomepage: true,
        displayMode: "both",
        cardExcerpt: "private card copy",
        seo: {
          metaTitle: "Public metadata",
          noIndex: true,
          focusKeyword: "private keyword",
          keywords: ["private", "taxonomy"],
          canonicalUrl: "https://private.example.test/override",
          seoScore: 100,
        },
        content: {
          en: {
            title: "Public English title",
            metaTitle: "Public English meta",
            metaDescription: "Public English description",
            slices: [],
          },
          fr: {
            title: "French title must not cross an English response",
            metaTitle: "French secret meta",
            metaDescription: "French secret description",
            slices: [],
          },
        },
      })
    })

    const projection = await t.query(api.cms.pages.getPublicPageById, {
      languageVersion: 0,
      id: pageId,
      locale: "en",
    })
    expect(projection).toEqual({
      _id: pageId,
      pageType: "page",
      updatedAt: expect.any(Number),
      seo: { metaTitle: "Public metadata", noIndex: true },
      content: {
        en: {
          title: "Public English title",
          metaTitle: "Public English meta",
          metaDescription: "Public English description",
          slices: [],
        },
      },
    })
    const serialized = JSON.stringify(projection)
    for (const privateValue of [
      "private-owner-id",
      "internal-template",
      "private-parent",
      "private card copy",
      "private keyword",
      "private.example.test",
      "French title must not cross an English response",
      "French secret meta",
    ]) {
      expect(serialized).not.toContain(privateValue)
    }
    await expect(
      t.query(api.cms.pages.getPublicPageById, {
        languageVersion: 0,
        id: pageId,
        locale: "fr",
      })
    ).resolves.toBeNull()
  })

  test("anonymous callers cannot opt into draft route resolution", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    await asUser.mutation(api.cms.pages.create, {
      slug: "draft-route",
      pageType: "page",
      status: "draft",
      title: "Draft Route",
      content: { en: { title: "Draft Route", slices: [] } },
    })

    await expect(
      t.query(api.cms.pages.resolveLocalizedPathQuery, {
        languageVersion: 0,
        path: "/draft-route",
        locale: "en",
        // @ts-expect-error — the public contract deliberately has no draft switch.
        includeDrafts: true,
      })
    ).rejects.toThrow()
    await expect(
      t.query(api.cms.pages.resolveLocalizedPathQuery, {
        languageVersion: 0,
        path: "/draft-route",
        locale: "en",
      })
    ).resolves.toBeNull()
  })

  test("public route resolution requires requested-locale content while preview may fall back", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    await asUser.mutation(api.cms.settings.completeOnboarding, {
      siteName: "Site",
      siteUrl: "https://example.com",
      timezone: "UTC",
      defaultLocale: "en",
      enabledLocales: ["en", "fr"],
    })

    const pageId = await asUser.mutation(api.cms.pages.create, {
      slug: "english-only",
      pageType: "page",
      status: "published",
      content: { en: { title: "English only", slices: [] } },
    })

    await expect(
      t.query(api.cms.pages.resolveLocalizedPathQuery, {
        languageVersion: 0,
        path: "/english-only",
        locale: "fr",
      })
    ).resolves.toBeNull()
    await expect(
      t.query(api.cms.pages.resolveLocalizedPathQuery, {
        languageVersion: 0,
        path: "/english-only",
        locale: "en",
      })
    ).resolves.toBe(pageId)
    await expect(
      t.query(api.cms.pages.getLocalizedPathsByIds, {
        languageVersion: 0,
        ids: [pageId],
        locale: "fr",
      })
    ).resolves.toEqual({})
    await expect(
      asUser.query(api.cms.pages.resolveLocalizedPathQuery, {
        languageVersion: 0,
        path: "/english-only",
        locale: "fr",
      })
    ).resolves.toBeNull()
  })

  test("public route resolution hides content for a disabled locale", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const pageId = await asUser.mutation(api.cms.pages.create, {
      slug: "disabled-french",
      pageType: "page",
      status: "published",
      content: {
        en: { title: "English", slices: [] },
        fr: { title: "Français", slices: [] },
      },
    })

    await expect(
      t.query(api.cms.pages.resolveLocalizedPathQuery, {
        languageVersion: 0,
        path: "/disabled-french",
        locale: "fr",
      })
    ).resolves.toBeNull()
    await expect(
      t.query(api.cms.pages.getLocalizedPathsByIds, {
        languageVersion: 0,
        ids: [pageId],
        locale: "fr",
      })
    ).resolves.toEqual({})
    await expect(
      asUser.query(api.cms.pages.resolveLocalizedPathQuery, {
        languageVersion: 0,
        path: "/disabled-french",
        locale: "fr",
      })
    ).resolves.toBeNull()
  })

  test("anonymous helper reads keep raw documents private and expose only public route metadata", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const publishedId = await asUser.mutation(api.cms.pages.create, {
      slug: "published-helper",
      pageType: "page",
      status: "published",
      title: "Published Helper",
      content: { en: { title: "Published Helper", slices: [] } },
    })
    const draftId = await asUser.mutation(api.cms.pages.create, {
      slug: "draft-helper",
      pageType: "page",
      status: "draft",
      title: "Draft Helper",
      content: { en: { title: "Draft Helper", slices: [] } },
    })
    const archivedId = await asUser.mutation(api.cms.pages.create, {
      slug: "archived-helper",
      pageType: "page",
      status: "archived",
      title: "Archived Helper",
      content: { en: { title: "Archived Helper", slices: [] } },
    })
    const deletedId = await asUser.mutation(api.cms.pages.create, {
      slug: "deleted-helper",
      pageType: "page",
      status: "published",
      title: "Deleted Helper",
      content: { en: { title: "Deleted Helper", slices: [] } },
    })
    await t.run((ctx) => ctx.db.patch(deletedId, { deletedAt: Date.now() }))

    await expect(
      t.query(api.cms.pages.getBySlug, { slug: "published-helper" })
    ).resolves.toBeNull()
    await expect(
      t.query(api.cms.pages.getBySlug, { slug: "draft-helper" })
    ).resolves.toBeNull()
    await expect(
      t.query(api.cms.pages.getBySlug, { slug: "archived-helper" })
    ).resolves.toBeNull()
    await expect(
      t.query(api.cms.pages.getBySlug, { slug: "deleted-helper" })
    ).resolves.toBeNull()

    const byIds = await t.query(api.cms.pages.getByIds, {
      ids: [publishedId, draftId, archivedId, deletedId],
    })
    expect(byIds).toEqual([])

    await expect(
      t.query(api.cms.pages.getPublicLocaleAlternates, {
        languageVersion: 0,
        pageId: publishedId,
      })
    ).resolves.toEqual([
      { locale: "en", url: "/published-helper", indexable: true },
    ])
    await expect(
      t.query(api.cms.pages.getPublicLocaleAlternates, {
        languageVersion: 0,
        pageId: draftId,
      })
    ).resolves.toEqual([])

    const paths = await t.query(api.cms.pages.getLocalizedPathsByIds, {
      languageVersion: 0,
      ids: [publishedId, draftId, archivedId, deletedId],
      locale: "en",
    })
    expect(paths).toEqual({ [publishedId]: "/published-helper" })

    await expect(
      t.query(api.cms.pages.getBreadcrumb, { pageId: draftId })
    ).resolves.toEqual([])
    await expect(
      t.query(api.cms.pages.getLocalizedBreadcrumb, {
        languageVersion: 0,
        pageId: draftId,
        locale: "en",
      })
    ).resolves.toEqual([])
  })

  test("authorized helper reads can access draft pages", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const draftId = await asUser.mutation(api.cms.pages.create, {
      slug: "authorized-draft-helper",
      pageType: "page",
      status: "draft",
      title: "Authorized Draft Helper",
      content: { en: { title: "Authorized Draft Helper", slices: [] } },
    })

    await expect(
      asUser.query(api.cms.pages.getBySlug, {
        slug: "authorized-draft-helper",
      })
    ).resolves.toMatchObject({ _id: draftId })

    const byIds = await asUser.query(api.cms.pages.getByIds, {
      ids: [draftId],
    })
    expect(byIds.map((page) => page._id)).toEqual([draftId])

    const paths = await asUser.query(api.cms.pages.getLocalizedPathsByIds, {
      languageVersion: 0,
      ids: [draftId],
      locale: "en",
    })
    expect(paths).toEqual({ [draftId]: "/authorized-draft-helper" })
  })

  test("anonymous callers cannot probe slug availability", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    await asUser.mutation(api.cms.pages.create, {
      slug: "private-slug-probe",
      pageType: "page",
      status: "draft",
      title: "Private Slug Probe",
    })

    await expect(
      t.query(api.cms.pages.isSlugAvailable, { slug: "private-slug-probe" })
    ).rejects.toThrow("UNAUTHENTICATED")
    await expect(
      asUser.query(api.cms.pages.isSlugAvailable, {
        slug: "private-slug-probe",
      })
    ).resolves.toEqual({ available: false, slug: "private-slug-probe" })
  })
})

describe("pages — soft delete", () => {
  test("soft-deleted pages do not appear in list", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const id = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Page to delete",
    })

    // Only archived pages can be moved to trash.
    await asUser.mutation(api.cms.pages.update, { id, status: "archived" })
    await asUser.mutation(api.cms.pages.softDelete, { id })

    const pages = await asUser.query(api.cms.pages.list, {})
    expect(pages.find((p) => p._id === id)).toBeUndefined()
  })

  test("non-archived pages cannot be moved to trash", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const id = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Still a draft",
    })

    await expect(
      asUser.mutation(api.cms.pages.softDelete, { id })
    ).rejects.toThrow(/archived/i)
  })

  test("soft-deleted pages can be restored", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const id = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Page to restore",
    })

    await asUser.mutation(api.cms.pages.update, { id, status: "archived" })
    await asUser.mutation(api.cms.pages.softDelete, { id })
    await asUser.mutation(api.cms.pages.restore, { id })

    const pages = await asUser.query(api.cms.pages.list, {})
    expect(pages.find((p) => p._id === id)).toBeDefined()
  })
})

describe("pages — permanent delete impact", () => {
  test("remove blocks a trashed page with a child page", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const parentId = await asUser.mutation(api.cms.pages.create, {
      slug: "parent",
      pageType: "landing-page",
      status: "draft",
      title: "Parent",
    })
    await asUser.mutation(api.cms.pages.create, {
      slug: "child",
      pageType: "page",
      status: "draft",
      title: "Child",
      parentId,
    })

    await asUser.mutation(api.cms.pages.update, {
      id: parentId,
      status: "archived",
    })
    await asUser.mutation(api.cms.pages.softDelete, { id: parentId })

    await expect(
      asUser.mutation(api.cms.pages.remove, { id: parentId })
    ).rejects.toThrow(/child page/i)
    const page = await asUser.query(api.cms.pages.getById, { id: parentId })
    expect(page).toBeDefined()
  })

  test("remove deletes redirects pointing to a trashed page", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    await enableRedirectsForTest(asUser)
    const pageId = await asUser.mutation(api.cms.pages.create, {
      slug: "target-page",
      pageType: "landing-page",
      status: "draft",
      title: "Target Page",
    })
    await asUser.mutation(api.cms.redirects.create, {
      fromPath: "/old-target",
      toPageId: pageId,
      statusCode: 301,
    })

    await asUser.mutation(api.cms.pages.update, {
      id: pageId,
      status: "archived",
    })
    await asUser.mutation(api.cms.pages.softDelete, { id: pageId })
    await asUser.mutation(api.cms.pages.remove, { id: pageId })

    const page = await asUser.query(api.cms.pages.getById, { id: pageId })
    expect(page).toBeNull()
    const redirects = await asUser.query(api.cms.redirects.list, {})
    expect(
      redirects.find((redirect) => redirect.fromPath === "/old-target")
    ).toBeUndefined()
  })

  test("remove blocks a live menu reference and succeeds after the link is removed", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const pageId = await asUser.mutation(api.cms.pages.create, {
      slug: "menu-target",
      pageType: "landing-page",
      status: "draft",
      title: "Menu Target",
    })
    // M05 C6: `saveCanonical` accepts only an enabled language, so the site
    // needs its settings row (a fresh install always has one).
    await t.run((ctx) =>
      ctx.db.insert("siteSettings", {
        siteName: "Site",
        siteUrl: "",
        defaultLocale: "en",
        enabledLocales: ["en"],
        updatedAt: 1,
      })
    )
    await asUser.mutation(api.cms.menus.createCanonical, { slug: "primary" })
    await asUser.mutation(api.cms.menus.saveCanonical, {
      slug: "primary",
      locale: "en",
      nav: [
        {
          id: "target",
          label: { en: "Target" },
          target: { type: "internal", pageId },
        },
      ],
    })
    await asUser.mutation(api.cms.pages.update, {
      id: pageId,
      status: "archived",
    })
    await asUser.mutation(api.cms.pages.softDelete, { id: pageId })

    await expect(
      asUser.mutation(api.cms.pages.remove, { id: pageId })
    ).rejects.toThrow(/primary/)
    expect(
      await asUser.query(api.cms.pages.getById, { id: pageId })
    ).not.toBeNull()

    await asUser.mutation(api.cms.menus.saveCanonical, {
      slug: "primary",
      locale: "en",
      nav: [],
    })
    await expect(
      asUser.mutation(api.cms.pages.remove, { id: pageId })
    ).resolves.toBeNull()
    expect(await asUser.query(api.cms.pages.getById, { id: pageId })).toBeNull()
  })

  test("remove succeeds after the referencing menu is soft-deleted", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const pageId = await asUser.mutation(api.cms.pages.create, {
      slug: "soft-deleted-menu-target",
      pageType: "landing-page",
      status: "draft",
      title: "Soft-deleted Menu Target",
    })
    // M05 C6: `saveCanonical` accepts only an enabled language, so the site
    // needs its settings row (a fresh install always has one).
    await t.run((ctx) =>
      ctx.db.insert("siteSettings", {
        siteName: "Site",
        siteUrl: "",
        defaultLocale: "en",
        enabledLocales: ["en"],
        updatedAt: 1,
      })
    )
    const menuId = await asUser.mutation(api.cms.menus.createCanonical, {
      slug: "footer",
    })
    await asUser.mutation(api.cms.menus.saveCanonical, {
      slug: "footer",
      locale: "en",
      nav: [
        {
          id: "target",
          label: { en: "Target" },
          target: { type: "internal", pageId },
        },
      ],
    })
    await asUser.mutation(api.cms.pages.update, {
      id: pageId,
      status: "archived",
    })
    await asUser.mutation(api.cms.pages.softDelete, { id: pageId })

    await expect(
      asUser.mutation(api.cms.pages.remove, { id: pageId })
    ).rejects.toThrow(/footer/)

    await asUser.mutation(api.cms.menus.softDelete, { id: menuId })
    await expect(
      asUser.mutation(api.cms.pages.remove, { id: pageId })
    ).resolves.toBeNull()
  })

  test("deleteImpact reports children, redirects, and menu slugs", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    await enableRedirectsForTest(asUser)
    const pageId = await asUser.mutation(api.cms.pages.create, {
      slug: "referenced-page",
      pageType: "landing-page",
      status: "draft",
      title: "Referenced Page",
    })
    const childId = await asUser.mutation(api.cms.pages.create, {
      slug: "referenced-child",
      pageType: "page",
      status: "draft",
      title: "Referenced Child",
      parentId: pageId,
    })
    await asUser.mutation(api.cms.redirects.create, {
      fromPath: "/old-referenced",
      toPageId: pageId,
      statusCode: 302,
    })
    // M05 C6: `saveCanonical` accepts only an enabled language, so the site
    // needs its settings row (a fresh install always has one).
    await t.run((ctx) =>
      ctx.db.insert("siteSettings", {
        siteName: "Site",
        siteUrl: "",
        defaultLocale: "en",
        enabledLocales: ["en"],
        updatedAt: 1,
      })
    )
    await asUser.mutation(api.cms.menus.createCanonical, { slug: "main" })
    await asUser.mutation(api.cms.menus.saveCanonical, {
      slug: "main",
      locale: "en",
      nav: [
        {
          id: "nav-1",
          label: { en: "Panel" },
          panel: {
            columns: 1,
            blocks: [
              {
                id: "links",
                kind: "linkGroup",
                links: [
                  {
                    id: "nested-reference",
                    label: { en: "Referenced" },
                    target: { type: "internal", pageId },
                  },
                ],
              },
            ],
          },
        },
      ],
    })

    const impact = await asUser.query(api.cms.pages.deleteImpact, {
      id: pageId,
    })
    expect(impact.children).toEqual([
      { _id: childId, title: "Referenced Child", slug: "referenced-child" },
    ])
    expect(impact.redirects).toBe(1)
    expect(impact.menus).toEqual(["main"])
  })

  // B8 (M01 recovery design): required delete impact and the purge ignore
  // Redirects module state. The M01d blocker refuses a disable while a rule
  // exists and deletes none, so the targeting rule is created while enabled,
  // the refused disable is proven, and the retained row is then re-seeded
  // after the owner removes it and disables.
  test("deleteImpact and remove still count and delete targeting redirects while Redirects is disabled", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    await enableRedirectsForTest(asUser)
    const pageId = await asUser.mutation(api.cms.pages.create, {
      slug: "disabled-redirects-target",
      pageType: "landing-page",
      status: "draft",
      title: "Disabled Redirects Target",
    })
    const ruleId = await asUser.mutation(api.cms.redirects.create, {
      fromPath: "/old-disabled-target",
      toPageId: pageId,
      statusCode: 301,
    })
    await expect(
      asUser.mutation(api.cms.modules.commit, {
        expectedConfigurationVersion: 1,
        changes: [{ moduleId: "redirects", enabled: false }],
      })
    ).rejects.toThrow("CMS_MODULE_TRANSITION_BLOCKED")
    await asUser.mutation(api.cms.redirects.remove, { id: ruleId })
    await expect(
      asUser.mutation(api.cms.modules.commit, {
        expectedConfigurationVersion: 1,
        changes: [{ moduleId: "redirects", enabled: false }],
      })
    ).resolves.toMatchObject({ committed: true, configurationVersion: 2 })
    // A retained targeting rule while disabled, which no guarded entry can
    // write (for example a pre-successor row on an adapted installation).
    await t.run(async (ctx) => {
      const now = Date.now()
      await ctx.db.insert("redirects", {
        fromPath: "/old-disabled-target",
        toPageId: pageId,
        statusCode: 301,
        createdAt: now,
        updatedAt: now,
        origin: "manual",
      })
    })
    await expect(asUser.query(api.cms.redirects.list, {})).rejects.toThrow(
      "CMS_MODULE_DISABLED"
    )
    const targeting = () =>
      t.run((ctx) =>
        ctx.db
          .query("redirects")
          .withIndex("by_fromPath", (q) =>
            q.eq("fromPath", "/old-disabled-target")
          )
          .take(2)
      )
    expect(await targeting()).toHaveLength(1)

    await expect(
      asUser.query(api.cms.pages.deleteImpact, { id: pageId })
    ).resolves.toMatchObject({ redirects: 1 })
    await asUser.mutation(api.cms.pages.update, {
      id: pageId,
      status: "archived",
    })
    await asUser.mutation(api.cms.pages.softDelete, { id: pageId })
    await asUser.mutation(api.cms.pages.remove, { id: pageId })

    expect(await asUser.query(api.cms.pages.getById, { id: pageId })).toBeNull()
    expect(await targeting()).toEqual([])
  })

  test("deleteImpact is empty for an unreferenced page", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const pageId = await asUser.mutation(api.cms.pages.create, {
      slug: "unreferenced",
      pageType: "landing-page",
      status: "draft",
      title: "Unreferenced",
    })

    const impact = await asUser.query(api.cms.pages.deleteImpact, {
      id: pageId,
    })
    expect(impact.children).toEqual([])
    expect(impact.redirects).toBe(0)
    expect(impact.menus).toEqual([])
  })
})

describe("pages — hierarchy", () => {
  test("child page gets ancestry path from parent", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const parentId = await asUser.mutation(api.cms.pages.create, {
      slug: "services",
      pageType: "landing-page",
      status: "published",
      title: "Services",
    })

    const childId = await asUser.mutation(api.cms.pages.create, {
      slug: "web-design",
      pageType: "landing-page",
      status: "draft",
      title: "Web Design",
      parentId,
    })

    const child = await asUser.query(api.cms.pages.getById, { id: childId })
    expect(child?.ancestryPath).toBe("/services")
    expect(child?.hierarchyDepth).toBe(1)
  })

  test("hierarchy depth is capped at 10 levels", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    let parentId = await asUser.mutation(api.cms.pages.create, {
      slug: "root",
      pageType: "landing-page",
      status: "published",
      title: "Root",
    })

    for (let i = 1; i <= 10; i++) {
      parentId = await asUser.mutation(api.cms.pages.create, {
        slug: `level-${i}`,
        pageType: "landing-page",
        status: "draft",
        title: `Level ${i}`,
        parentId,
      })
    }

    const deepPage = await asUser.query(api.cms.pages.getById, { id: parentId })
    expect(deepPage?.hierarchyDepth ?? 0).toBeLessThanOrEqual(10)
  })
})

describe("pages — relation cards", () => {
  test("projects published pages and hides drafts unless preview is enabled", sliceProfile(["hero-agency"]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const publishedId = await asUser.mutation(api.cms.pages.create, {
      slug: "published-post",
      pageType: "post",
      status: "published",
      title: "Published Post",
      cardExcerpt: "Published excerpt",
      content: {
        en: {
          title: "Published Post",
          slices: [createSampleSlice("hero-agency")],
        },
      },
    })
    const draftId = await asUser.mutation(api.cms.pages.create, {
      slug: "draft-post",
      pageType: "post",
      status: "draft",
      title: "Draft Post",
    })

    const publicCards = await t.query(
      api.cms.pages.getPublicRelationCardsByIds,
      { languageVersion: 0, ids: [publishedId, draftId], locale: "en" }
    )
    expect(publicCards[publishedId]?.title).toBe("Published Post")
    expect(publicCards[publishedId]).not.toHaveProperty("excerpt")
    expect(publicCards[draftId]).toBeNull()

    await expect(
      t.query(api.cms.pages.getRelationCardsByIds, {
        ids: [draftId],
        locale: "en",
        includeDrafts: true,
      })
    ).rejects.toThrow("UNAUTHENTICATED")

    const previewCards = await asUser.query(
      api.cms.pages.getRelationCardsByIds,
      {
        ids: [draftId],
        locale: "en",
        includeDrafts: true,
      }
    )
    expect(previewCards[draftId]?.title).toBe("Draft Post")
  })

  test("public relation cards respect active selection and descriptor exposure fields", sliceProfile([]), async () => {
    const t = pageTest()
    const testimonialId = await t.run(async (ctx) => {
      const now = Date.now()
      return await ctx.db.insert("pages", {
        slug: "internal-testimonial-handle",
        pageType: "testimonial",
        status: "published",
        createdAt: now,
        updatedAt: now,
        createdBy: "private-editor",
        cardExcerpt: "private generic excerpt",
        personName: "Ada Lovelace",
        content: {
          en: {
            title: "Internal testimonial label",
            quote: "Public quote for English readers",
          },
          fr: {
            title: "French internal label",
            quote: "Citation publique française",
          },
        },
      })
    })

    const cards = await t.query(api.cms.pages.getPublicRelationCardsByIds, {
      languageVersion: 0,
      ids: [testimonialId],
      locale: "en",
    })
    if (!testimonialActive) {
      expect(cards).toEqual({ [testimonialId]: null })
      return
    }
    expect(cards[testimonialId]).toEqual({
      pageId: testimonialId,
      pageType: "testimonial",
      title: "Ada Lovelace",
      excerpt: "Public quote for English readers",
    })
    const serialized = JSON.stringify(cards[testimonialId])
    expect(serialized).not.toContain("private-editor")
    expect(serialized).not.toContain("private generic excerpt")
    expect(serialized).not.toContain("Internal testimonial label")
    expect(serialized).not.toContain("French internal label")
    expect(serialized).not.toContain("Citation publique française")

    await expect(
      t.query(api.cms.pages.getPublicRelationCardsByIds, {
        languageVersion: 0,
        ids: [testimonialId],
        locale: "fr",
      })
    ).resolves.toEqual({ [testimonialId]: null })
  })

  test("recent public relation cards are bounded, newest-first, and locale-strict", sliceProfile([]), async () => {
    const t = pageTest()
    await t.run(async (ctx) => {
      await ctx.db.insert("siteSettings", {
        siteName: "Test",
        siteUrl: "https://example.test",
        defaultLocale: "en",
        enabledLocales: ["en", "fr"],
        updatedAt: 1,
      })
      for (const page of [
        { slug: "old", publishedAt: 100, en: "Old", fr: "Ancien" },
        { slug: "new", publishedAt: 300, en: "New" },
        { slug: "middle", publishedAt: 200, en: "Middle", fr: "Milieu" },
      ]) {
        await ctx.db.insert("pages", {
          slug: page.slug,
          pageType: "post",
          status: "published",
          createdAt: page.publishedAt,
          updatedAt: page.publishedAt,
          publishedAt: page.publishedAt,
          featured: false,
          promoteToFront: false,
          content: {
            en: { title: page.en, slices: [] },
            ...(page.fr ? { fr: { title: page.fr, slices: [] } } : {}),
          },
        })
      }
    })

    await expect(
      t.query(api.cms.pages.listRecentPublicRelationCards, {
        languageVersion: 0,
        pageType: "post",
        limit: 2,
        locale: "en",
      })
    ).resolves.toMatchObject([{ title: "New" }, { title: "Middle" }])
    await expect(
      t.query(api.cms.pages.listRecentPublicRelationCards, {
        languageVersion: 0,
        pageType: "post",
        limit: 3,
        locale: "fr",
      })
    ).resolves.toMatchObject([{ title: "Milieu" }, { title: "Ancien" }])
    await expect(
      t.query(api.cms.pages.listRecentPublicRelationCards, {
        languageVersion: 0,
        pageType: "post",
        limit: 3,
        locale: "de",
      })
    ).resolves.toEqual([])
    await expect(
      t.query(api.cms.pages.listRecentPublicRelationCards, {
        languageVersion: 0,
        pageType: "post",
        limit: 13,
        locale: "en",
      })
    ).rejects.toThrow(/integer.*1.*12/i)
  })
})

describe("pages — localized ancestry", () => {
  async function siteWithFr(t: ReturnType<typeof convexTest>) {
    const asUser = t.withIdentity(TEST_USER)
    await asUser.mutation(api.cms.settings.completeOnboarding, {
      siteName: "Site",
      siteUrl: "https://example.com",
      timezone: "UTC",
      defaultLocale: "en",
      enabledLocales: ["en", "fr"],
    })
    return asUser
  }

  test("create populates a child's per-locale ancestry from its parent", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = await siteWithFr(t)

    const parentId = await asUser.mutation(api.cms.pages.create, {
      slug: "my-products",
      pageType: "landing-page",
      status: "published",
      content: { en: { title: "My products" }, fr: { title: "Mes produits" } },
    })
    const childId = await asUser.mutation(api.cms.pages.create, {
      slug: "product-1",
      pageType: "page",
      status: "published",
      parentId,
      content: { en: { title: "Product 1" }, fr: { title: "Produit 1" } },
    })

    const child = await asUser.query(api.cms.pages.getById, { id: childId })
    // Parent has no FR slug yet → FR ancestry falls back to the base slug.
    expect(child?.ancestryPath).toBe("/my-products")
    expect(child?.localizedAncestryPaths?.fr).toBe("/my-products")
  })

  test("changing a parent's FR slug cascades to descendant localizedAncestryPaths", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = await siteWithFr(t)

    const parentId = await asUser.mutation(api.cms.pages.create, {
      slug: "my-products",
      pageType: "landing-page",
      status: "published",
      content: { en: { title: "My products" }, fr: { title: "Mes produits" } },
    })
    const childId = await asUser.mutation(api.cms.pages.create, {
      slug: "product-1",
      pageType: "page",
      status: "published",
      parentId,
      content: { en: { title: "Product 1" }, fr: { title: "Produit 1" } },
    })

    // Give the PARENT a French slug → cascade must rewrite the child's FR ancestry.
    await callUpdateLocaleContent(asUser, {
      pageId: parentId,
      locale: "fr",
      title: "Mes produits",
      slug: "mes-produits",
    })

    const child = await asUser.query(api.cms.pages.getById, { id: childId })
    expect(child?.ancestryPath).toBe("/my-products") // base unchanged
    expect(child?.localizedAncestryPaths?.fr).toBe("/mes-produits")

    // And the full localized public path reflects the localized ancestry.
    const paths = await t.query(api.cms.pages.getLocalizedPathsByIds, {
      languageVersion: 0,
      ids: [childId],
      locale: "fr",
    })
    expect(paths[childId]).toBe("/fr/mes-produits/product-1")

    const en = await t.query(api.cms.pages.getLocalizedPathsByIds, {
      languageVersion: 0,
      ids: [childId],
      locale: "en",
    })
    expect(en[childId]).toBe("/my-products/product-1") // default locale unaffected
  })
})

describe("pages — pre-publish checklist", () => {
  test("reports blockers and warnings with stable codes", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Untitled draft",
      content: { en: { title: "", slices: [] } },
    })

    const checklist = await asUser.query(api.cms.pages.getPrePublishChecklist, {
      pageId,
    })

    expect(checklist.canPublish).toBe(false)
    expect(checklist.blockers.map((item) => item.code)).toEqual([
      "missing_default_locale_title",
    ])
    expect(checklist.warnings.map((item) => item.code)).toEqual([
      "missing_default_locale_content",
      "missing_seo_title",
      "missing_seo_description",
    ])
  })

  test("checks the unpublished working draft of a published page", sliceProfile(["hero-agency"]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "published",
      title: "Published title",
      content: {
        en: {
          title: "Published title",
          slices: [
            {
              id: "hero-1",
              type: "hero-agency",
              enabled: true,
              primary: {
                eyebrow: "Agency",
                title: "Published title",
                description: canonicalBody("Published copy"),
              },
              items: [],
            },
          ],
        },
      },
    })

    await asUser.mutation(api.cms.pages.acquirePageEditorLock, {
      pageId,
      force: true,
    })
    await asUser.mutation(api.cms.pages.updateDraft, {
      pageId,
      content: {
        en: {
          pageType: "landing-page",
          localized: { title: "" },
          slices: [],
        },
      },
    })

    const checklist = await asUser.query(api.cms.pages.getPrePublishChecklist, {
      pageId,
    })
    expect(checklist.blockers.map((item) => item.code)).toContain(
      "missing_default_locale_title"
    )

    // The public/live row remains unchanged until Publish promotes staging.
    await expect(
      asUser.query(api.cms.pages.getById, { id: pageId })
    ).resolves.toMatchObject({
      content: { en: { title: "Published title" } },
    })
  })

  test("warns when default locale has no content sections", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Title only",
      content: { en: { title: "Title only", slices: [] } },
    })

    const checklist = await asUser.query(api.cms.pages.getPrePublishChecklist, {
      pageId,
    })

    expect(checklist.canPublish).toBe(true)
    expect(checklist.warnings.map((item) => item.code)).toContain(
      "missing_default_locale_content"
    )
  })

  test("does not warn when default locale has content sections", sliceProfile(["hero-agency"]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "With content",
      content: {
        en: {
          title: "With content",
          slices: [
            {
              id: "hero-1",
              type: "hero-agency",
              enabled: true,
              primary: {
                eyebrow: "Agency",
                title: "With content",
                description: canonicalBody("Copy"),
              },
              items: [],
            },
          ],
        },
      },
    })

    const checklist = await asUser.query(api.cms.pages.getPrePublishChecklist, {
      pageId,
    })

    expect(checklist.warnings.map((item) => item.code)).not.toContain(
      "missing_default_locale_content"
    )
  })

  test("warns when enabled locale content is missing", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    await asUser.mutation(api.cms.settings.completeOnboarding, {
      siteName: "Site",
      siteUrl: "https://example.com",
      timezone: "UTC",
      defaultLocale: "en",
      enabledLocales: ["en", "fr"],
    })

    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "English only",
      content: { en: { title: "English only", slices: [] } },
    })

    const checklist = await asUser.query(api.cms.pages.getPrePublishChecklist, {
      pageId,
    })

    expect(checklist.warnings.map((item) => item.code)).toContain(
      "missing_enabled_locale_translation"
    )
  })

  test("blocks publish when enabled slices have missing required fields", sliceProfile(["hero-agency"]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Incomplete slice",
      content: {
        en: {
          title: "Incomplete slice",
          slices: [
            {
              id: "hero-1",
              type: "hero-agency",
              enabled: true,
              primary: {
                eyebrow: "Agency",
                title: "",
                description: canonicalBody("Copy"),
              },
              items: [],
            },
          ],
        },
      },
    })

    const checklist = await asUser.query(api.cms.pages.getPrePublishChecklist, {
      pageId,
    })

    expect(checklist.canPublish).toBe(false)
    expect(checklist.blockers.map((item) => item.code)).toContain(
      "missing_required_slice_field"
    )
  })

  test("blocks publish when a real slice image has no alt text", sliceProfile(["hero-with-image"]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Image without alt",
      content: {
        en: {
          title: "Image without alt",
          slices: [
            {
              id: "hero-1",
              type: "hero-with-image",
              enabled: true,
              primary: {
                eyebrow: "Launch",
                eyebrowLink: { type: "none" },
                title: "Image without alt",
                description: canonicalBody("Copy"),
                image: { url: "https://example.com/image.jpg", alt: "" },
              },
              items: [],
            },
          ],
        },
      },
    })

    const checklist = await asUser.query(api.cms.pages.getPrePublishChecklist, {
      pageId,
    })

    expect(checklist.canPublish).toBe(false)
    expect(checklist.blockers.map((item) => item.code)).toContain(
      "missing_image_alt_text"
    )
  })

  test("blocks publish when slices link to unavailable pages", sliceProfile(["hero-agency"]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const targetId = await asUser.mutation(api.cms.pages.create, {
      pageType: "page",
      status: "draft",
      title: "Draft target",
    })
    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Linked page",
      content: {
        en: {
          title: "Linked page",
          slices: [
            {
              id: "hero-1",
              type: "hero-agency",
              enabled: true,
              primary: {
                eyebrow: "Agency",
                title: "Linked page",
                description: canonicalBody("Copy"),
              },
              items: [
                {
                  label: "Read more",
                  link: { type: "internal", pageId: targetId },
                  withIcon: false,
                  enabled: true,
                },
              ],
            },
          ],
        },
      },
    })

    const checklist = await asUser.query(api.cms.pages.getPrePublishChecklist, {
      pageId,
    })

    expect(checklist.canPublish).toBe(false)
    expect(checklist.blockers.map((item) => item.code)).toContain(
      "archived_relation_target"
    )
  })

  test("warnings do not block publish", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Publishable",
      content: { en: { title: "Publishable", slices: [] } },
    })
    // ADR-0041 Deploy 2 PR B item 3 — `create({status:"draft"})` seeds
    // staging; use `pages.publish` (promotes the seeded staging) instead
    // of the legacy `pages.update({status:"published"})` transition.
    await expect(
      asUser.mutation(api.cms.pages.publish, { pageId })
    ).resolves.toEqual(
      expect.objectContaining({ updatedAt: expect.any(Number) })
    )
  })

  test("hard blockers prevent immediate publish", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Untitled draft",
      content: { en: { title: "", slices: [] } },
    })

    // ADR-0041 Deploy 2 PR B item 3 — publish via `pages.publish`;
    // staging carries the seeded (empty-title) content, checklist blocks.
    await expect(
      asUser.mutation(api.cms.pages.publish, { pageId })
    ).rejects.toThrow(/Resolve pre-publish blockers/)

    await expect(
      asUser.query(api.cms.pages.getById, { id: pageId })
    ).resolves.toMatchObject({ status: "draft" })
  })

  test("scheduled publish rechecks blockers before going live", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    const now = Date.now()

    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Scheduled",
      content: { en: { title: "Scheduled", slices: [] } },
    })
    await scheduleViaDraft(asUser, pageId, now - 1_000)
    // Stage an empty-title content edit — the cron's publish call must
    // catch the checklist violation. Use `updateDraft` directly (no
    // publish) so the helper doesn't itself trip the checklist before
    // the cron runs.
    await asUser.mutation(api.cms.pages.acquirePageEditorLock, {
      pageId,
      force: true,
    })
    await asUser.mutation(api.cms.pages.updateDraft, {
      pageId,
      content: {
        en: {
          pageType: "landing-page",
          localized: { title: "" },
          slices: [],
        },
      },
    })

    await expect(
      t.mutation(internal.cms.pages.processScheduledTransitions, {})
    ).resolves.toMatchObject({ published: 0 })
    const afterTransition = await asUser.query(api.cms.pages.getById, {
      id: pageId,
    })
    expect(afterTransition?.status).toBe("draft")
    // ADR-0041 Deploy 2 PR B — the cron clears the staged scheduledAt on
    // a failed checklist so it doesn't hot-loop retrying every minute.
    // The staging row itself lives on — the editor can still fix the
    // blockers and reschedule.
    const stagedAfter = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("pageStaging")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .first()
      return row?.scheduledAt ?? null
    })
    expect(stagedAfter).toBeNull()
  })

  test("requiresBodyContent (post): empty slices is a blocker, not a warning", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "post",
      status: "draft",
      title: "Empty post",
      content: {
        en: { title: "Empty post", slices: [] },
      },
    })

    const checklist = await asUser.query(api.cms.pages.getPrePublishChecklist, {
      pageId,
    })

    expect(checklist.canPublish).toBe(false)
    expect(checklist.blockers.map((item) => item.code)).toContain(
      "missing_required_field"
    )
    const bodyBlocker = checklist.blockers.find(
      (item) => item.code === "missing_required_field" && item.field === "body"
    )
    expect(bodyBlocker).toBeDefined()
    // The soft warning MUST NOT co-exist with the strict blocker — the
    // requiresBodyContent branch replaces it entirely.
    expect(checklist.warnings.map((item) => item.code)).not.toContain(
      "missing_default_locale_content"
    )
  })

  test("requiresBodyContent (post): disabled-only slices still trip the blocker", sliceProfile(["hero-agency"]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "post",
      status: "draft",
      title: "Disabled-only post",
      content: {
        en: {
          title: "Disabled-only post",
          slices: [
            {
              id: "hero-1",
              type: "hero-agency",
              enabled: false,
              primary: {
                eyebrow: "Agency",
                title: "Disabled",
                description: canonicalBody("Copy"),
              },
              items: [],
            },
          ],
        },
      },
    })

    const checklist = await asUser.query(api.cms.pages.getPrePublishChecklist, {
      pageId,
    })

    const bodyBlocker = checklist.blockers.find(
      (item) => item.code === "missing_required_field" && item.field === "body"
    )
    expect(bodyBlocker).toBeDefined()
  })

  test("requiresBodyContent (post): one enabled slice clears the blocker", sliceProfile(["hero-agency"]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "post",
      status: "draft",
      title: "Filled post",
      content: {
        en: {
          title: "Filled post",
          slices: [
            {
              id: "hero-1",
              type: "hero-agency",
              enabled: true,
              primary: {
                eyebrow: "Agency",
                title: "Filled",
                description: canonicalBody("Copy"),
              },
              items: [],
            },
          ],
        },
      },
    })

    const checklist = await asUser.query(api.cms.pages.getPrePublishChecklist, {
      pageId,
    })

    const bodyBlocker = checklist.blockers.find(
      (item) => item.code === "missing_required_field" && item.field === "body"
    )
    expect(bodyBlocker).toBeUndefined()
  })

  test("requiresBodyContent (landing-page): empty slices stays a warning", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Empty landing",
      content: {
        en: { title: "Empty landing", slices: [] },
      },
    })

    const checklist = await asUser.query(api.cms.pages.getPrePublishChecklist, {
      pageId,
    })

    // Landing-page = requiresBodyContent:false, so the soft warning path
    // still fires — no blocker on `body`.
    expect(checklist.warnings.map((item) => item.code)).toContain(
      "missing_default_locale_content"
    )
    const bodyBlocker = checklist.blockers.find(
      (item) => item.code === "missing_required_field" && item.field === "body"
    )
    expect(bodyBlocker).toBeUndefined()
  })
})

describe("pages — revisions and restore", () => {
  test("saving content creates a recoverable previous revision", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    // ADR-0041 Deploy 3 (Narrow): create as `published` so the seed
    // content lands on `pages.content`. A draft create would seed
    // staging (leaving `pages.content` empty), and the subsequent
    // publish would archive an empty outgoing snapshot — the
    // `revisions[0].content?.en.title === "Original"` assertion needs
    // the outgoing snapshot to actually carry the original title.
    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "published",
      title: "Original",
      content: { en: { title: "Original", slices: [] } },
    })
    const page = await asUser.query(api.cms.pages.getById, { id: pageId })

    await callUpdateLocaleContent(asUser, {
      pageId,
      locale: "en",
      title: "Changed",
      slices: [],
      expectedUpdatedAt: page?.updatedAt,
    })

    const revisions = await readPageRevisions(t, pageId, 10)
    // The compatibility helper promotes each save through the canonical
    // publisher. Team's create-published fixture also leaves an initial
    // publish revision; Community's preserved direct-create path does not.
    // In both editions, the newest outgoing-live snapshot is the contract.
    expect(revisions.length).toBeGreaterThanOrEqual(1)
    expect(revisions[0].reason).toBe("publish")
    expect(revisions[0].content?.en.title).toBe("Original")
    expect(revisions[0].metadata.summary).toContain("Title changed in EN")
  })

  test("publishing snapshots the previous draft state", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Draft",
      content: { en: { title: "Draft", slices: [] } },
    })

    // ADR-0041 Deploy 2 PR B item 3 — `create` seeded staging; publish
    // via `pages.publish` to promote it.
    await asUser.mutation(api.cms.pages.publish, { pageId })

    const revisions = await readPageRevisions(t, pageId, 10)
    expect(revisions[0].reason).toBe("publish")
    expect(revisions[0].status).toBe("draft")
    expect(revisions[0].metadata.checklist).toMatchObject({
      blockerCount: 0,
      warningCount: 3,
    })
    expect(
      revisions[0].metadata.checklist?.warnings.map((item) => item.code)
    ).toEqual([
      "missing_default_locale_content",
      "missing_seo_title",
      "missing_seo_description",
    ])
  })

  // This cron fires every minute — 43,200 times a month. Convex's tightest
  // free-plan limit is database I/O, not function calls, so an idle tick has
  // to stay cheap: it must return before `getLocaleConfig`, which reads
  // `siteSettings` and can scan up to ~20 full page documents looking for a
  // default homepage. The guard is what keeps a doing-nothing tick at ~2
  // index reads instead of ~100 KB.
  test("an idle tick returns without doing any work", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    // A published page and an unscheduled draft: nothing is due either way.
    await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Not scheduled",
      content: { en: { title: "Not scheduled", slices: [] } },
    })

    await expect(
      t.mutation(internal.cms.pages.processScheduledTransitions, {})
    ).resolves.toEqual({ published: 0, expired: 0, hasMore: false })
  })

  test("scheduled publish flips due drafts and records a revision", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    const now = Date.now()

    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Scheduled Draft",
      content: { en: { title: "Scheduled Draft", slices: [] } },
    })
    await scheduleViaDraft(asUser, pageId, now - 1_000)

    await approveDueEditionPagesForTest(t)
    await t.mutation(internal.cms.pages.processScheduledTransitions, {})

    const published = await asUser.query(api.cms.pages.getById, { id: pageId })
    expect(published?.status).toBe("published")
    // Publish deletes the staging row (§9 path 1) so the staged
    // scheduledAt goes with it. This is the promoted-and-gone assertion.
    const stagedAfter = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("pageStaging")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .first()
      return row?.scheduledAt ?? null
    })
    expect(stagedAfter).toBeNull()
    expect(published?.publishedAt).toBeGreaterThanOrEqual(now)

    const revisions = await readPageRevisions(t, pageId, 10)
    expect(revisions[0].reason).toBe("scheduled_publish")
    expect(revisions[0].status).toBe("draft")
    expect(revisions[0].metadata.checklist).toMatchObject({
      blockerCount: 0,
      warningCount: 3,
    })
    expect(
      revisions[0].metadata.checklist?.warnings.map((item) => item.code)
    ).toEqual([
      "missing_default_locale_content",
      "missing_seo_title",
      "missing_seo_description",
    ])
  })

  test("scheduled transitions make bounded progress on large due pages", sliceProfile([]), async () => {
    const t = convexTest({
      schema,
      modules,
      transactionLimits: true,
      ownerIdentity: TEST_USER,
    })
    const asUser = t.withIdentity(TEST_USER)
    const ids: Id<"pages">[] = []

    for (let index = 0; index < 50; index += 1) {
      const id = await asUser.mutation(api.cms.pages.create, {
        pageType: "landing-page",
        status: "draft",
        title: `Scheduled large page ${index}`,
        content: {
          en: { title: `Scheduled large page ${index}`, slices: [] },
        },
      })
      await scheduleViaDraft(asUser, id, Date.now() - 1_000)
      await t.run(async (ctx) => {
        await ctx.db.patch(id, { cardExcerpt: "x".repeat(300_000) })
      })
      ids.push(id)
    }

    await approveDueEditionPagesForTest(t)
    await expect(
      t.mutation(internal.cms.pages.processScheduledTransitions, {})
    ).resolves.toEqual({ published: 1, expired: 0, hasMore: true })

    const statuses = await Promise.all(
      ids.map(
        async (id) =>
          (await asUser.query(api.cms.pages.getById, { id }))?.status
      )
    )
    expect(statuses.filter((status) => status === "published")).toHaveLength(1)
    expect(statuses.filter((status) => status === "draft")).toHaveLength(49)
  })

  // OD-1 (FR2.0 rev1 §3.1 row W): page webhooks leave the legacy writers.
  // Webhooks has no catalog module, and no successor publication path emits
  // page events, so an enabled, subscribed endpoint must receive nothing from
  // create, update, publish, or the scheduled-transition cron. The retrier is
  // registered so a regression fails on these delivery rows, not on a
  // missing component.
  test("legacy writers stop emitting page webhooks", sliceProfile([]), async () => {
    const t = pageTest()
    actionRetrierTest.register(t)
    const asUser = t.withIdentity(TEST_USER)
    const now = Date.now()
    await t.run((ctx) =>
      ctx.db.insert("webhookEndpoints", {
        url: "https://example.com/hooks/pages",
        secret: "secret-pages",
        events: ["page.published", "page.unpublished"],
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })
    )
    const deliveredEvents = () =>
      t.run(async (ctx) =>
        (await ctx.db.query("webhookDeliveries").collect()).map(
          (delivery) => delivery.event
        )
      )
    const eventsAfter: Record<string, string[]> = {}

    const createdId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "published",
      title: "Published on create",
      content: { en: { title: "Published on create", slices: [] } },
    })
    eventsAfter.create = await deliveredEvents()

    await asUser.mutation(api.cms.pages.update, {
      id: createdId,
      status: "archived",
    })
    eventsAfter.update = await deliveredEvents()

    const draftId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Published by publish",
      content: { en: { title: "Published by publish", slices: [] } },
    })
    await asUser.mutation(api.cms.pages.publish, { pageId: draftId })
    eventsAfter.publish = await deliveredEvents()

    const scheduledId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Published by schedule",
      content: { en: { title: "Published by schedule", slices: [] } },
    })
    await scheduleViaDraft(asUser, scheduledId, Date.now() - 1_000)
    const expiringId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "published",
      title: "Archived by expiry",
      content: { en: { title: "Archived by expiry", slices: [] } },
    })
    await asUser.mutation(api.cms.pages.update, {
      id: expiringId,
      expiresAt: Date.now() - 1_000,
    })
    await approveDueEditionPagesForTest(t)
    await expect(
      t.mutation(internal.cms.pages.processScheduledTransitions, {})
    ).resolves.toMatchObject({ published: 1, expired: 1 })
    eventsAfter.scheduledTransitions = await deliveredEvents()

    expect(eventsAfter).toEqual({
      create: [],
      update: [],
      publish: [],
      scheduledTransitions: [],
    })
  })

  test("scheduled transition continuation drains the due backlog", sliceProfile([]), async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-12T21:00:00Z"))
    try {
      const t = convexTest({
        schema,
        modules,
        transactionLimits: true,
        ownerIdentity: TEST_USER,
      })
      const asUser = t.withIdentity(TEST_USER)
      const ids: Id<"pages">[] = []

      for (let index = 0; index < 3; index += 1) {
        const id = await asUser.mutation(api.cms.pages.create, {
          pageType: "landing-page",
          status: "draft",
          title: `Scheduled continuation page ${index}`,
          content: {
            en: { title: `Scheduled continuation page ${index}`, slices: [] },
          },
        })
        await scheduleViaDraft(asUser, id, Date.now() - 1_000)
        ids.push(id)
      }

      await approveDueEditionPagesForTest(t)
      await t.mutation(internal.cms.pages.processScheduledTransitions, {})
      await t.finishAllScheduledFunctions(vi.runAllTimers)

      const statuses = await Promise.all(
        ids.map(
          async (id) =>
            (await asUser.query(api.cms.pages.getById, { id }))?.status
        )
      )
      expect(statuses).toEqual(["published", "published", "published"])
    } finally {
      vi.useRealTimers()
    }
  })

  test("scheduled expiry archives due published pages and records a revision", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    const now = Date.now()

    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "published",
      title: "Expiring Page",
      content: { en: { title: "Expiring Page", slices: [] } },
    })
    const page = await asUser.query(api.cms.pages.getById, { id: pageId })
    await asUser.mutation(api.cms.pages.update, {
      id: pageId,
      expiresAt: now - 1_000,
      expectedUpdatedAt: page?.updatedAt,
    })

    await t.mutation(internal.cms.pages.processScheduledTransitions, {})

    const expired = await asUser.query(api.cms.pages.getById, { id: pageId })
    expect(expired?.status).toBe("archived")
    expect(expired?.expiresAt).toBeUndefined()

    const revisions = await readPageRevisions(t, pageId, 10)
    expect(revisions[0].reason).toBe("scheduled_expiry")
    expect(revisions[0].status).toBe("published")
  })

  test("scheduled transitions ignore future publish and expiry times", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    const future = Date.now() + 60_000

    const draftId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Future Draft",
      content: { en: { title: "Future Draft", slices: [] } },
    })
    await scheduleViaDraft(asUser, draftId, future)

    const publishedId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "published",
      title: "Future Expiry",
      content: { en: { title: "Future Expiry", slices: [] } },
    })
    const published = await asUser.query(api.cms.pages.getById, {
      id: publishedId,
    })
    await asUser.mutation(api.cms.pages.update, {
      id: publishedId,
      expiresAt: future,
      expectedUpdatedAt: published?.updatedAt,
    })

    const result = await t.mutation(
      internal.cms.pages.processScheduledTransitions,
      {}
    )

    await expect(
      asUser.query(api.cms.pages.getById, { id: draftId })
    ).resolves.toMatchObject({
      status: "draft",
    })
    await expect(
      asUser.query(api.cms.pages.getById, { id: publishedId })
    ).resolves.toMatchObject({ status: "published" })
    expect(result).toMatchObject({ published: 0, expired: 0 })
  })

  test("scheduled transitions clear staged scheduledAt on non-draft pages (cron runaway guard)", sliceProfile([]), async () => {
    // ADR-0041 Deploy 2 PR B — `pageStaging.by_scheduledAt` has no status
    // filter (the old `by_status_and_scheduledAt` on `pages` did). Any
    // matched staging row on a non-draft page (published, archived, or
    // soft-deleted) MUST have its `scheduledAt` cleared during the tick,
    // not merely skipped. Otherwise the take(1) batch returns the same
    // smallest-`scheduledAt` row next tick, `published` stays 0,
    // `hasMore` stays true, and the cron reschedules itself immediately
    // forever — starving every legitimate scheduled publish behind it.
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    // Set up: a published page with a stray staged scheduledAt (the
    // reachable state = user edits schedule on a published page, or
    // schedules a draft then archives it).
    const publishedId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "published",
      title: "Published",
      content: { en: { title: "Published", slices: [] } },
    })
    await t.run(async (ctx) => {
      await ctx.db.insert("pageStaging", {
        pageId: publishedId,
        pageType: "landing-page",
        updatedAt: Date.now(),
        scheduledAt: Date.now() - 1_000,
      } as Parameters<typeof ctx.db.insert<"pageStaging">>[1])
    })

    const before = await t.run(async (ctx) =>
      ctx.db
        .query("pageStaging")
        .withIndex("by_pageId", (q) => q.eq("pageId", publishedId))
        .first()
    )
    expect(before?.scheduledAt).toBeDefined()

    const result = await t.mutation(
      internal.cms.pages.processScheduledTransitions,
      {}
    )
    expect(result.published).toBe(0)

    const after = await t.run(async (ctx) =>
      ctx.db
        .query("pageStaging")
        .withIndex("by_pageId", (q) => q.eq("pageId", publishedId))
        .first()
    )
    // Cleared — the staging row itself survives (an editor may still
    // reschedule), but the void schedule is gone.
    expect(after?.scheduledAt).toBeUndefined()
    // `hasMore` may still be true only if OTHER due rows exist; with a
    // single row we prove the batch drained by seeing the cleared field.
  })

  test("stale updates are rejected", sliceProfile([]), async () => {
    // ADR-0041 Deploy 3 (Narrow): the OCC token now gates against
    // `pageStaging.updatedAt` (via `assertStagingFresh`), not the live
    // `pages.updatedAt`. The rejection path is exercised by holding
    // a token against a staging row that subsequently advanced.
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Draft",
      content: { en: { title: "Draft", slices: [] } },
    })
    // Draft create seeds staging; capture the seeded staging updatedAt
    // as the "opened-at" token — this is what an editor session would
    // hold from its initial `getStagedPreviewById` read.
    const initialStaging = await asUser.query(
      api.cms.pages.getStagedPreviewById,
      { id: pageId }
    )
    const staleToken = initialStaging?.stagingUpdatedAt

    await asUser.mutation(api.cms.pages.acquirePageEditorLock, {
      pageId,
      force: true,
    })
    await asUser.mutation(api.cms.pages.updateDraft, {
      pageId,
      expectedUpdatedAt: staleToken,
      content: {
        en: {
          pageType: "landing-page",
          localized: { title: "Newer save" },
          slices: [],
        },
      },
    })

    // Staging updatedAt has advanced past `staleToken` — a second save
    // presenting the same token trips `assertStagingFresh`.
    await expect(
      asUser.mutation(api.cms.pages.updateDraft, {
        pageId,
        expectedUpdatedAt: staleToken,
        content: {
          en: {
            pageType: "landing-page",
            localized: { title: "Stale save" },
            slices: [],
          },
        },
      })
    ).rejects.toThrow(/took over editing/i)
  })

  test("page updates persist updatedAt for stale-save checks", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Draft",
      content: { en: { title: "Draft", slices: [] } },
    })
    const opened = await asUser.query(api.cms.pages.getById, { id: pageId })
    await new Promise((resolve) => setTimeout(resolve, 2))

    const result = await asUser.mutation(api.cms.pages.update, {
      id: pageId,
      title: "Renamed draft",
      expectedUpdatedAt: opened?.updatedAt,
    })
    const updated = await asUser.query(api.cms.pages.getById, { id: pageId })

    expect(updated?.updatedAt).toBe(result.updatedAt)
    await expect(
      asUser.mutation(api.cms.pages.update, {
        id: pageId,
        title: "Stale rename",
        expectedUpdatedAt: opened?.updatedAt,
      })
    ).rejects.toThrow(/changed since you opened it/i)
  })

  test("revision history retains only the newest fifty snapshots", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Draft 0",
      content: { en: { title: "Draft 0", slices: [] } },
    })

    for (let i = 1; i <= 55; i++) {
      const page = await asUser.query(api.cms.pages.getById, { id: pageId })
      await callUpdateLocaleContent(asUser, {
        pageId,
        locale: "en",
        title: `Draft ${i}`,
        slices: [],
        expectedUpdatedAt: page?.updatedAt,
      })
    }

    const revisions = await readPageRevisions(t, pageId, 50)
    expect(revisions).toHaveLength(50)
    expect(revisions[0].revisionNumber).toBe(55)
    expect(revisions.at(-1)?.revisionNumber).toBe(6)
  })

  test("hard page delete cascades its pageRevisions (no orphans)", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "published",
      title: "First",
      content: { en: { title: "First", slices: [] } },
    })
    const first = await asUser.query(api.cms.pages.getById, { id: pageId })
    await callUpdateLocaleContent(asUser, {
      pageId,
      locale: "en",
      title: "Second",
      slices: [],
      expectedUpdatedAt: first?.updatedAt,
    })

    const before = await t.run((ctx) =>
      ctx.db
        .query("pageRevisions")
        .withIndex("by_pageId_and_revisionNumber", (q) =>
          q.eq("pageId", pageId)
        )
        .collect()
    )
    expect(before.length).toBeGreaterThan(0)

    await asUser.mutation(api.cms.pages.remove, { id: pageId })

    const after = await t.run((ctx) =>
      ctx.db
        .query("pageRevisions")
        .withIndex("by_pageId_and_revisionNumber", (q) =>
          q.eq("pageId", pageId)
        )
        .collect()
    )
    expect(after).toHaveLength(0)
  })
})

describe("pages — owner presence and locks", () => {
  test("heartbeat refreshes one row per user", sliceProfile([]), async () => {
    const t = pageTest()
    const asOwner = t.withIdentity(TEST_USER)

    const pageId = await asOwner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Refresh presence",
    })

    await asOwner.mutation(api.cms.pages.touchPagePresence, { pageId })
    await asOwner.mutation(api.cms.pages.touchPagePresence, { pageId })

    const editors = await asOwner.query(api.cms.pages.listActiveEditors, {
      pageId,
    })
    expect(editors).toHaveLength(1)
    expect(editors[0].email).toBe(TEST_USER.email)
  })

  test("active editors expire quickly by heartbeat age", sliceProfile([]), async () => {
    const t = pageTest()
    const asOwner = t.withIdentity(TEST_USER)

    const pageId = await asOwner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Expire presence",
    })
    await asOwner.mutation(api.cms.pages.touchPagePresence, { pageId })

    const active = await asOwner.query(api.cms.pages.listActiveEditors, {
      pageId,
    })
    expect(active).toHaveLength(1)

    const expired = await asOwner.query(api.cms.pages.listActiveEditors, {
      pageId,
      now: active[0].lastActiveAt + 46_000,
    })
    expect(expired).toEqual([])
  })

  test("leaving the editor removes the user's presence", sliceProfile([]), async () => {
    const t = pageTest()
    const asOwner = t.withIdentity(TEST_USER)

    const pageId = await asOwner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Leave presence",
    })
    await asOwner.mutation(api.cms.pages.touchPagePresence, { pageId })
    await asOwner.mutation(api.cms.pages.leavePagePresence, { pageId })

    const editors = await asOwner.query(api.cms.pages.listActiveEditors, {
      pageId,
    })
    expect(editors).toEqual([])
  })

  // The editor beats ONE mutation, not two. Each beat reads the whole page
  // document to permission-check, and `pages` rows carry every slice body for
  // every locale — so merging halves the database I/O of an open editor tab,
  // which is the tightest Convex free-plan limit.
  test("one heartbeat establishes both presence and the lock", sliceProfile([]), async () => {
    const t = pageTest()
    const asOwner = t.withIdentity(TEST_USER)

    const pageId = await asOwner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Merged heartbeat",
    })

    await expect(
      asOwner.mutation(api.cms.pages.heartbeatPageEditor, { pageId })
    ).resolves.toMatchObject({
      status: "acquired",
      lock: { email: TEST_USER.email },
    })

    const editors = await asOwner.query(api.cms.pages.listActiveEditors, {
      pageId,
    })
    expect(editors.map((editor) => editor.email)).toEqual([TEST_USER.email])

    await expect(
      asOwner.query(api.cms.pages.getPageEditorLock, { pageId })
    ).resolves.toMatchObject({ status: "locked", isMine: true })
  })

  test("soft lock can be acquired and refreshed by the owner", sliceProfile([]), async () => {
    const t = pageTest()
    const asOwner = t.withIdentity(TEST_USER)

    const pageId = await asOwner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Acquire lock",
    })

    await expect(
      asOwner.mutation(api.cms.pages.acquirePageEditorLock, { pageId })
    ).resolves.toMatchObject({
      status: "acquired",
      lock: { email: TEST_USER.email },
    })
    await expect(
      asOwner.query(api.cms.pages.getPageEditorLock, { pageId })
    ).resolves.toMatchObject({
      status: "locked",
      isMine: true,
      lock: { email: TEST_USER.email },
    })

    await asOwner.mutation(api.cms.pages.acquirePageEditorLock, { pageId })
    const lock = await asOwner.query(api.cms.pages.getPageEditorLock, {
      pageId,
    })
    expect(lock.status).toBe("locked")
    expect(lock.lock?.email).toBe(TEST_USER.email)
  })

  test("soft lock expires by last active time", sliceProfile([]), async () => {
    const t = pageTest()
    const asOwner = t.withIdentity(TEST_USER)

    const pageId = await asOwner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Expire lock",
    })
    await asOwner.mutation(api.cms.pages.acquirePageEditorLock, { pageId })

    const current = await asOwner.query(api.cms.pages.getPageEditorLock, {
      pageId,
    })
    expect(current.status).toBe("locked")
    expect(
      await asOwner.query(api.cms.pages.getPageEditorLock, {
        pageId,
        now: (current.lock?.lastActiveAt ?? 0) + 91_000,
      })
    ).toEqual({ status: "available", lock: null, isMine: false })
  })

  test("releasing a soft lock clears only the owner lock", sliceProfile([]), async () => {
    const t = pageTest()
    const asOwner = t.withIdentity(TEST_USER)

    const pageId = await asOwner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Release lock",
    })
    await asOwner.mutation(api.cms.pages.acquirePageEditorLock, { pageId })
    await asOwner.mutation(api.cms.pages.releasePageEditorLock, { pageId })

    await expect(
      asOwner.query(api.cms.pages.getPageEditorLock, { pageId })
    ).resolves.toEqual({ status: "available", lock: null, isMine: false })
  })
})

// Frozen Team collaboration evidence; re-home under T01/T02 without
// weakening it into Community owner-only assertions. Each of these three
// needs a second concurrent editor identity, which fresh Community — one
// durable owner, no members — cannot produce.
describe.skip("pages — multi-editor presence", () => {
  const EDITOR_A = {
    subject: "editor-a",
    name: "Alex Editor",
    email: "alex@example.com",
  }
  const EDITOR_B = {
    subject: "editor-b",
    name: "Blair Editor",
    email: "blair@example.com",
  }

  test("heartbeat lists active editors for a page", async () => {
    const t = pageTest()
    const asAlex = t.withIdentity(EDITOR_A)
    const asBlair = t.withIdentity(EDITOR_B)

    const pageId = await asAlex.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Presence",
    })

    await asAlex.mutation(api.cms.pages.touchPagePresence, { pageId })
    await asBlair.mutation(api.cms.pages.touchPagePresence, { pageId })

    const editors = await asAlex.query(api.cms.pages.listActiveEditors, {
      pageId,
    })
    expect(editors.map((editor) => editor.email).sort()).toEqual([
      "alex@example.com",
      "blair@example.com",
    ])
  })

  test("a heartbeat never steals another editor's lock", async () => {
    const t = pageTest()
    const asAlex = t.withIdentity(EDITOR_A)
    const asBlair = t.withIdentity(EDITOR_B)

    const pageId = await asAlex.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Heartbeat never forces",
    })

    await asAlex.mutation(api.cms.pages.heartbeatPageEditor, { pageId })

    // Blair's heartbeat must report blocked, not take over — displacing an
    // editor is an explicit action routed through `acquirePageEditorLock`.
    await expect(
      asBlair.mutation(api.cms.pages.heartbeatPageEditor, { pageId })
    ).resolves.toMatchObject({
      status: "blocked",
      lock: { email: "alex@example.com" },
    })

    // Blair still registers as present even though the lock was refused.
    const editors = await asBlair.query(api.cms.pages.listActiveEditors, {
      pageId,
    })
    expect(editors.map((editor) => editor.email).sort()).toEqual([
      "alex@example.com",
      "blair@example.com",
    ])
  })

  test("soft lock blocks another editor until takeover", async () => {
    const t = pageTest()
    const asAlex = t.withIdentity(EDITOR_A)
    const asBlair = t.withIdentity(EDITOR_B)

    const pageId = await asAlex.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Takeover lock",
    })
    await asAlex.mutation(api.cms.pages.acquirePageEditorLock, { pageId })

    await expect(
      asBlair.mutation(api.cms.pages.acquirePageEditorLock, { pageId })
    ).resolves.toMatchObject({
      status: "blocked",
      lock: { email: "alex@example.com" },
    })

    await expect(
      asBlair.mutation(api.cms.pages.acquirePageEditorLock, {
        pageId,
        force: true,
      })
    ).resolves.toMatchObject({
      status: "acquired",
      lock: { email: "blair@example.com" },
    })
    await expect(
      asBlair.query(api.cms.pages.getPageEditorLock, { pageId })
    ).resolves.toMatchObject({
      status: "locked",
      isMine: true,
      lock: { email: "blair@example.com" },
    })
  })
})

describe("redirects — resolution", () => {
  test("redirect is resolved before page lookup", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    await enableRedirectsForTest(asUser)
    await asUser.mutation(api.cms.redirects.create, {
      fromPath: "/old-path",
      toPath: "/new-path",
      statusCode: 301,
    })

    const redirect = await t.query(api.cms.redirects.resolve, {
      languageVersion: 0,
      path: "/old-path",
    })

    expect(redirect?.destination).toBe("/new-path")
    expect(redirect?.statusCode).toBe(301)
  })

  test("returns null for unknown paths", sliceProfile([]), async () => {
    const t = pageTest()
    await enableRedirectsForTest(t.withIdentity(TEST_USER))

    const redirect = await t.query(api.cms.redirects.resolve, {
      languageVersion: 0,
      path: "/does-not-exist",
    })

    expect(redirect).toBeNull()
  })
})

describe("locale URLs — honor configured default locale", () => {
  test("default locale is unprefixed, other locales are prefixed", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    // Configure the site with a non-"en" default locale.
    await asUser.mutation(api.cms.settings.completeOnboarding, {
      siteName: "Site",
      siteUrl: "https://example.com",
      timezone: "UTC",
      defaultLocale: "fr",
      enabledLocales: ["fr", "en"],
    })

    const id = await asUser.mutation(api.cms.pages.create, {
      slug: "about",
      pageType: "landing-page",
      status: "published",
      content: {
        fr: { title: "À propos" },
        en: { title: "About" },
      },
      defaultLocale: "fr",
    })

    const alternates = await t.query(api.cms.pages.getPublicLocaleAlternates, {
      languageVersion: 0,
      pageId: id,
    })
    const urls = Object.fromEntries(
      alternates.map(({ locale, url }) => [locale, url])
    )

    expect(urls.fr).toBe("/about")
    expect(urls.en).toBe("/en/about")
  })

  test("a sole non-English locale resolves and stays unprefixed", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    await asUser.mutation(api.cms.settings.completeOnboarding, {
      siteName: "Site",
      siteUrl: "https://example.com",
      timezone: "UTC",
      defaultLocale: "fr",
      enabledLocales: ["fr"],
    })

    const pageId = await asUser.mutation(api.cms.pages.create, {
      slug: "a-propos",
      pageType: "page",
      status: "published",
      content: { fr: { title: "À propos", slices: [] } },
      defaultLocale: "fr",
    })

    await expect(
      t.query(api.cms.pages.resolveLocalizedPathQuery, {
        languageVersion: 0,
        path: "/a-propos",
        locale: "fr",
      })
    ).resolves.toBe(pageId)
    await expect(
      t.query(api.cms.pages.getPublicLocaleAlternates, {
        languageVersion: 0,
        pageId,
      })
    ).resolves.toEqual([{ locale: "fr", url: "/a-propos", indexable: true }])
    await expect(
      t.query(api.cms.pages.getAllLocalizedPageUrls, { languageVersion: 0 })
    ).resolves.toContainEqual({
      pageId,
      locale: "fr",
      url: "/a-propos",
    })
  })
})

function legacyIdentityHeroSlice(id: string, title: string): Slice {
  return {
    id,
    type: "hero-agency",
    enabled: true,
    primary: { eyebrow: "Agency", title, description: canonicalBody("Copy") },
    items: [],
  }
}

function identityHeroSlice(id: string, title: string): Slice {
  const raw = legacyIdentityHeroSlice(id, title)
  return {
    ...raw,
    primary: { ...raw.primary, description: canonicalBody("Copy") },
  } as Slice
}

const INVALID_SLICE_IDENTITY_ERROR =
  "Each block on a page must have its own non-empty ID. Refresh the editor and save again."

describe("pages — sibling Slice identity", () => {
  test("allows the same Slice ID in independent locale lists", sliceProfile(["hero-agency"]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    const localizedSlice = identityHeroSlice("locale-local", "Localized")

    await expect(
      asUser.mutation(api.cms.pages.create, {
        pageType: "landing-page",
        status: "draft",
        title: "Localized identity",
        content: {
          en: { title: "English", slices: [localizedSlice] },
          fr: { title: "Français", slices: [localizedSlice] },
        },
      })
    ).resolves.toEqual(expect.any(String))
  })

  test("rejects duplicate sibling Slice IDs on create", sliceProfile(["hero-agency"]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    const duplicateSlice = identityHeroSlice("duplicate-slice", "Duplicate")

    await expect(
      asUser.mutation(api.cms.pages.create, {
        pageType: "landing-page",
        status: "draft",
        title: "Duplicate slices",
        content: {
          en: {
            title: "Duplicate slices",
            slices: [duplicateSlice, duplicateSlice],
          },
        },
      })
    ).rejects.toThrow(INVALID_SLICE_IDENTITY_ERROR)
  })

  test("rejects empty sibling Slice IDs on the live editor save path", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Editor identity",
      content: { en: { title: "Editor identity", slices: [] } },
    })
    await asUser.mutation(api.cms.pages.acquirePageEditorLock, {
      pageId,
      force: true,
    })

    await expect(
      asUser.mutation(api.cms.pages.updateDraft, {
        pageId,
        content: {
          en: {
            pageType: "landing-page",
            localized: { title: "Editor identity" },
            slices: [identityHeroSlice("   ", "Editor identity")],
          },
        },
      })
    ).rejects.toThrow(INVALID_SLICE_IDENTITY_ERROR)
  })

  test("rejects duplicate sibling Slice IDs on the legacy update path", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Legacy identity",
      content: { en: { title: "Legacy identity", slices: [] } },
    })
    const duplicateSlice = identityHeroSlice(
      "legacy-duplicate",
      "Legacy identity"
    )

    await expect(
      asUser.mutation(api.cms.pages.update, {
        id: pageId,
        content: {
          en: {
            title: "Legacy identity",
            slices: [duplicateSlice, duplicateSlice],
          },
        },
      })
    ).rejects.toThrow(INVALID_SLICE_IDENTITY_ERROR)
  })

  test("repairs legacy staging IDs before interactive publish", sliceProfile(["hero-agency"]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Publish identity",
      content: { en: { title: "Publish identity", slices: [] } },
    })
    const duplicateSlice = legacyIdentityHeroSlice(
      "staged-duplicate",
      "Publish identity"
    )
    const legacyRows = [
      duplicateSlice,
      {
        ...duplicateSlice,
        primary: {
          ...duplicateSlice.primary,
          description: JSON.stringify({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Second " },
                  {
                    type: "text",
                    text: "body",
                    marks: [{ type: "link", attrs: { href: "/second" } }],
                  },
                ],
              },
            ],
          }),
        },
      },
      {
        ...duplicateSlice,
        id: "",
        primary: {
          ...duplicateSlice.primary,
          description: JSON.stringify({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Third " },
                  {
                    type: "text",
                    text: "body",
                    marks: [{ type: "link", attrs: { href: "/third" } }],
                  },
                ],
              },
            ],
          }),
        },
      },
    ] as Slice[]
    const sourceBytes = JSON.stringify(legacyRows)
    await t.run(async (ctx) => {
      const staging = await ctx.db
        .query("pageStaging")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique()
      if (!staging) throw new Error("Expected a staging row")
      await ctx.db.patch(staging._id, {
        content: {
          en: {
            title: "Publish identity",
            slices: legacyRows,
          },
        },
      })
    })

    await asUser.mutation(api.cms.pages.publish, { pageId })

    const published = await asUser.query(api.cms.pages.getById, { id: pageId })
    if (published?.pageType !== "landing-page") {
      throw new Error("Expected a published landing page")
    }
    const ids = published.content?.en.slices.map((slice) => slice.id) ?? []
    expect(ids[0]).toBe("staged-duplicate")
    expect(ids[1]).toEqual(expect.any(String))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(3)
    expect(
      published.content?.en.slices.map(
        (row) => (row.primary as { description: string }).description
      )
    ).toEqual(
      legacyRows.map(
        (row) => (row.primary as { description: string }).description
      )
    )
    expect(JSON.stringify(legacyRows)).toBe(sourceBytes)
  })

  test("repairs legacy live IDs when publishing unrelated staged fields", sliceProfile(["hero-agency"]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Legacy live identity",
      content: { en: { title: "Legacy live identity", slices: [] } },
    })
    const duplicateSlice = legacyIdentityHeroSlice(
      "live-duplicate",
      "Legacy live identity"
    )
    const legacyRows = [
      duplicateSlice,
      {
        ...duplicateSlice,
        primary: {
          ...duplicateSlice.primary,
          description: JSON.stringify({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Second " },
                  {
                    type: "text",
                    text: "body",
                    marks: [{ type: "link", attrs: { href: "/second" } }],
                  },
                ],
              },
            ],
          }),
        },
      },
      {
        ...duplicateSlice,
        id: "",
        primary: {
          ...duplicateSlice.primary,
          description: JSON.stringify({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Third " },
                  {
                    type: "text",
                    text: "body",
                    marks: [{ type: "link", attrs: { href: "/third" } }],
                  },
                ],
              },
            ],
          }),
        },
      },
    ] as Slice[]
    const sourceBytes = JSON.stringify(legacyRows)
    await t.run(async (ctx) => {
      await ctx.db.patch(pageId, {
        content: {
          en: {
            title: "Legacy live identity",
            slices: legacyRows,
          },
        },
      })
      const staging = await ctx.db
        .query("pageStaging")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique()
      if (!staging) throw new Error("Expected a staging row")
      await ctx.db.patch(staging._id, {
        content: undefined,
        slug: "legacy-live-identity-published",
      })
    })

    await asUser.mutation(api.cms.pages.publish, { pageId })

    const published = await asUser.query(api.cms.pages.getById, { id: pageId })
    if (published?.pageType !== "landing-page") {
      throw new Error("Expected a published landing page")
    }
    const ids = published.content?.en.slices.map((slice) => slice.id) ?? []
    expect(ids[0]).toBe("live-duplicate")
    expect(ids[1]).toEqual(expect.any(String))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(3)
    expect(
      published.content?.en.slices.map(
        (row) => (row.primary as { description: string }).description
      )
    ).toEqual(
      legacyRows.map(
        (row) => (row.primary as { description: string }).description
      )
    )
    expect(JSON.stringify(legacyRows)).toBe(sourceBytes)
  })

  test("repairs legacy staging IDs before scheduled publish", sliceProfile(["hero-agency"]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Scheduled identity",
      content: { en: { title: "Scheduled identity", slices: [] } },
    })
    const duplicateSlice = legacyIdentityHeroSlice(
      "scheduled-duplicate",
      "Scheduled identity"
    )
    const legacyRows = [
      duplicateSlice,
      {
        ...duplicateSlice,
        primary: {
          ...duplicateSlice.primary,
          description: JSON.stringify({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Second " },
                  {
                    type: "text",
                    text: "body",
                    marks: [{ type: "link", attrs: { href: "/second" } }],
                  },
                ],
              },
            ],
          }),
        },
      },
      {
        ...duplicateSlice,
        id: "",
        primary: {
          ...duplicateSlice.primary,
          description: JSON.stringify({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Third " },
                  {
                    type: "text",
                    text: "body",
                    marks: [{ type: "link", attrs: { href: "/third" } }],
                  },
                ],
              },
            ],
          }),
        },
      },
    ] as Slice[]
    const sourceBytes = JSON.stringify(legacyRows)
    await t.run(async (ctx) => {
      const staging = await ctx.db
        .query("pageStaging")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique()
      if (!staging) throw new Error("Expected a staging row")
      await ctx.db.patch(staging._id, {
        scheduledAt: Date.now() - 1_000,
        content: {
          en: {
            title: "Scheduled identity",
            slices: legacyRows,
          },
        },
      })
    })

    await approveDueEditionPagesForTest(t)
    await expect(
      t.mutation(internal.cms.pages.processScheduledTransitions, {})
    ).resolves.toMatchObject({ published: 1 })

    const published = await asUser.query(api.cms.pages.getById, { id: pageId })
    if (published?.pageType !== "landing-page") {
      throw new Error("Expected a published landing page")
    }
    const ids = published.content?.en.slices.map((slice) => slice.id) ?? []
    expect(ids[0]).toBe("scheduled-duplicate")
    expect(ids[1]).toEqual(expect.any(String))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(3)
    expect(
      published.content?.en.slices.map(
        (row) => (row.primary as { description: string }).description
      )
    ).toEqual(
      legacyRows.map(
        (row) => (row.primary as { description: string }).description
      )
    )
    expect(JSON.stringify(legacyRows)).toBe(sourceBytes)
  })
})

describe("pages — rich-text write-path gate", () => {
  const heroAgency = (description: unknown) => ({
    id: "s1",
    type: "hero-agency" as const,
    enabled: true,
    primary: {
      eyebrow: "Agency",
      title: "Valid",
      description:
        typeof description === "string"
          ? description
          : JSON.stringify(description),
    },
    items: [],
  })

  test("accepts an inline-profile document", sliceProfile(["hero-agency"]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const id = await asUser.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Valid",
      content: {
        en: {
          title: "Valid",
          slices: [
            heroAgency({
              type: "doc",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "ok" }] },
              ],
            }),
          ],
        },
      },
    })
    expect(id).toBeDefined()
  })

  test("rejects a slice with a node disallowed by the inline profile", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    await expect(
      asUser.mutation(api.cms.pages.create, {
        pageType: "landing-page",
        status: "draft",
        title: "Bad",
        content: {
          en: {
            title: "Bad",
            slices: [
              heroAgency({
                type: "doc",
                content: [
                  {
                    type: "table",
                    content: [
                      {
                        type: "tableRow",
                        content: [
                          {
                            type: "tableCell",
                            content: [{ type: "paragraph" }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              }),
            ],
          },
        },
      })
    ).rejects.toThrow("Invalid rich-text content")
  })

  test("refuses raw authored HTML and saves parent-prepared historical content", sliceProfile(["hero-agency"]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    const raw = heroAgency("<p>old content</p>")
    const authored = {
      pageType: "landing-page" as const,
      status: "draft" as const,
      title: "Legacy",
      content: { en: { title: "Legacy", slices: [raw] } },
    }
    const before = await t.run((ctx) => ctx.db.query("pages").collect())
    await expect(
      asUser.mutation(api.cms.pages.create, authored)
    ).rejects.toThrow("Invalid rich-text content")
    expect(await t.run((ctx) => ctx.db.query("pages").collect())).toEqual(
      before
    )
    const pageId = await asUser.mutation(api.cms.pages.create, {
      ...authored,
      content: { en: { title: "Legacy", slices: [] } },
    })
    // Historical bytes enter through the documented mock DB boundary, never create.
    await t.run(async (ctx) => {
      const staging = await ctx.db
        .query("pageStaging")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique()
      await ctx.db.patch(staging!._id, { content: authored.content })
    })
    const opened = await asUser.query(api.cms.pages.getStagedPreviewById, {
      id: pageId,
    })
    const { adoptHeroTitles } =
      await import("../lib/rich-text/adopt-hero-titles")
    if (opened?.page.pageType !== "landing-page")
      throw new Error("Expected a landing page")
    const prepared = adoptHeroTitles(opened.page.content!.en.slices, "en")
    await asUser.mutation(api.cms.pages.acquirePageEditorLock, {
      pageId,
      force: true,
    })
    await asUser.mutation(api.cms.pages.updateDraft, {
      pageId,
      content: {
        en: {
          pageType: "landing-page",
          localized: { title: "Legacy" },
          slices: prepared.value,
        },
      },
    })
    const saved = await asUser.query(api.cms.pages.getStagedPreviewById, {
      id: pageId,
    })
    if (saved?.page.pageType !== "landing-page")
      throw new Error("Expected a landing page")
    expect(saved.page.content!.en.slices[0].primary).toMatchObject({
      description: canonicalBody("old content"),
    })
    expect(raw.primary.description).toBe("<p>old content</p>")
  })
})

/**
 * C7 rerouted the byline projection through the central
 * `resolveReferenceCardForDoc` resolver + a new author `imageMediaId` on
 * `ReferenceCard`. The pre-C7 856-test baseline never exercised
 * `getPublicByline` directly; the browser was the only gate on the projection
 * shape and the "draft author never leaks through a published post" invariant
 * (ADR-0037 §4). These tests turn that browser gate into a deterministic one.
 */
describe("pages — getPublicByline (C7)", () => {
  test("published author with locale roleTitle → {name, roleTitle, avatarUrl}", sliceProfile([]), async () => {
    const t = pageTest()
    const authorId = await t.run(async (ctx) => {
      const now = Date.now()
      return await ctx.db.insert("pages", {
        slug: "jean-dupont",
        pageType: "author",
        status: "published",
        name: "Jean Dupont",
        content: {
          en: {
            title: "Jean Dupont",
            roleTitle: "Senior Editor",
            slices: [],
          },
          fr: {
            title: "Jean Dupont",
            roleTitle: "Rédacteur en chef",
            slices: [],
          },
        },
        createdAt: now,
        updatedAt: now,
      })
    })
    const result = await t.query(api.cms.pages.getPublicByline, {
      languageVersion: 0,
      authorPageId: authorId,
      locale: "en",
    })
    expect(result).toEqual({
      name: "Jean Dupont",
      roleTitle: "Senior Editor",
      avatarUrl: null,
    })
  })

  test("[locale] roleTitle missing stays absent instead of borrowing another locale", sliceProfile([]), async () => {
    const t = pageTest()
    await t.run(async (ctx) => {
      await ctx.db.insert("siteSettings", {
        siteName: "Site",
        siteUrl: "https://example.test",
        defaultLocale: "fr",
        enabledLocales: ["fr", "de"],
        updatedAt: Date.now(),
      })
    })
    const authorId = await t.run(async (ctx) => {
      const now = Date.now()
      return await ctx.db.insert("pages", {
        slug: "jean-dupont",
        pageType: "author",
        status: "published",
        name: "Jean Dupont",
        content: {
          fr: {
            title: "Jean Dupont",
            roleTitle: "Rédacteur en chef",
            slices: [],
          },
          de: { title: "Jean Dupont", slices: [] },
        },
        createdAt: now,
        updatedAt: now,
      })
    })
    const result = await t.query(api.cms.pages.getPublicByline, {
      languageVersion: 0,
      authorPageId: authorId,
      locale: "de",
    })
    expect(result?.name).toBe("Jean Dupont")
    expect(result?.roleTitle).toBeUndefined()
    expect(result?.avatarUrl).toBeNull()
  })

  test("draft author → null (no draft leaks through a published post's byline)", sliceProfile([]), async () => {
    const t = pageTest()
    const authorId = await t.run(async (ctx) => {
      const now = Date.now()
      return await ctx.db.insert("pages", {
        slug: "draft-author",
        pageType: "author",
        status: "draft",
        name: "Draft Author",
        content: { en: { title: "Draft Author", slices: [] } },
        createdAt: now,
        updatedAt: now,
      })
    })
    const result = await t.query(api.cms.pages.getPublicByline, {
      languageVersion: 0,
      authorPageId: authorId,
      locale: "en",
    })
    expect(result).toBeNull()
  })

  test("soft-deleted author → null", sliceProfile([]), async () => {
    const t = pageTest()
    const authorId = await t.run(async (ctx) => {
      const now = Date.now()
      return await ctx.db.insert("pages", {
        slug: "trashed-author",
        pageType: "author",
        status: "published",
        name: "Trashed Author",
        content: { en: { title: "Trashed Author", slices: [] } },
        deletedAt: now,
        createdAt: now,
        updatedAt: now,
      })
    })
    const result = await t.query(api.cms.pages.getPublicByline, {
      languageVersion: 0,
      authorPageId: authorId,
      locale: "en",
    })
    expect(result).toBeNull()
  })

  test("non-author target → null", sliceProfile([]), async () => {
    const t = pageTest()
    const postId = await t.run(async (ctx) => {
      const now = Date.now()
      return await ctx.db.insert("pages", {
        slug: "not-an-author",
        pageType: "post",
        status: "published",
        content: { en: { title: "Not An Author", slices: [] } },
        featured: false,
        promoteToFront: false,
        createdAt: now,
        updatedAt: now,
      })
    })
    const result = await t.query(api.cms.pages.getPublicByline, {
      languageVersion: 0,
      authorPageId: postId,
      locale: "en",
    })
    expect(result).toBeNull()
  })
})

describe("pages — updateDraft descriptor-shaped save (C8)", () => {
  test("rejects a cross-arm draft (draft.pageType !== stored)", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "page",
      status: "draft",
      title: "Regular page",
      content: { en: { title: "Regular page", slices: [] } },
    })
    const opened = await asUser.query(api.cms.pages.getById, { id: pageId })
    // Acquire lock BEFORE probing the cross-arm guard — `updateDraft`
    // checks the lock before the pageType guard, so an unlocked call
    // would throw the lock error instead of the guard we're testing.
    await asUser.mutation(api.cms.pages.acquirePageEditorLock, {
      pageId,
      force: true,
    })
    await expect(
      asUser.mutation(api.cms.pages.updateDraft, {
        pageId,
        expectedUpdatedAt: opened?.updatedAt,
        // WRONG arm — stored is `page`, `content.en.pageType` claims `post`.
        // Convex validates the discriminated union; the mutation guard also
        // rejects if the union somehow narrows through (belt-and-braces per
        // plan 029 §Phase 2 server invariant #2).
        content: {
          en: {
            pageType: "post",
            localized: { title: "Wrong arm" },
            slices: [],
          },
        },
      })
    ).rejects.toThrow(/Cannot save post content on a page/)
  })

  test("clearing an optional localized field round-trips (author roleTitle: '' → omitted from stored bag)", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    // `pages.create`'s `localizedContentInput` validator only accepts
    // title/meta/slices today; descriptor fields (roleTitle/bio) can only
    // be set via `pages.updateDraft` (C8) until C10 widens `create`.
    const authorId = await createTestAuthor(t, asUser, {
      status: "draft",
      title: "Ada Lovelace",
      name: "Ada Lovelace",
      content: { en: { title: "Ada Lovelace" } },
    })
    const created = await asUser.query(api.cms.pages.getById, { id: authorId })
    // ADR-0041 Deploy 3 (Narrow): the retired `updateLocaleContent` wrote
    // to `pages.content` synchronously; the new pipeline stages via
    // `updateDraft` and promotes with `publish`. The lock + publish pair
    // reproduces the "immediately live" semantic these assertions depend
    // on (Bucket A per the ADR triage).
    await asUser.mutation(api.cms.pages.acquirePageEditorLock, {
      pageId: authorId,
      force: true,
    })
    await asUser.mutation(api.cms.pages.updateDraft, {
      pageId: authorId,
      expectedUpdatedAt: created?.updatedAt,
      content: {
        en: {
          pageType: "author",
          localized: {
            title: "Ada Lovelace",
            roleTitle: "Mathematician",
          },
          slices: [],
        },
      },
    })
    await asUser.mutation(api.cms.pages.publish, { pageId: authorId })
    const opened = await asUser.query(api.cms.pages.getById, { id: authorId })
    expect(
      (opened as { content?: Record<string, { roleTitle?: string }> })?.content
        ?.en?.roleTitle
    ).toBe("Mathematician")

    // Clear roleTitle by sending empty string — the server's omit-empties
    // rule should drop it from stored content[locale].
    await asUser.mutation(api.cms.pages.acquirePageEditorLock, {
      pageId: authorId,
      force: true,
    })
    await asUser.mutation(api.cms.pages.updateDraft, {
      pageId: authorId,
      expectedUpdatedAt: opened?.updatedAt,
      content: {
        en: {
          pageType: "author",
          localized: {
            title: "Ada Lovelace",
            roleTitle: "",
          },
          slices: [],
        },
      },
    })
    await asUser.mutation(api.cms.pages.publish, { pageId: authorId })

    const reloaded = await asUser.query(api.cms.pages.getById, {
      id: authorId,
    })
    expect(
      (reloaded as { content?: Record<string, { roleTitle?: string }> })
        ?.content?.en?.roleTitle
    ).toBeUndefined()
  })

  test("persists a non-empty descriptor localized field (author roleTitle sets, reloads)", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    const authorId = await createTestAuthor(t, asUser, {
      status: "draft",
      title: "Grace Hopper",
      name: "Grace Hopper",
      content: { en: { title: "Grace Hopper" } },
    })
    const opened = await asUser.query(api.cms.pages.getById, { id: authorId })
    // ADR-0041 Deploy 3 (Narrow) Bucket A — `pages.content` reads only
    // reflect saved content after a publish promotes staging to live.
    await asUser.mutation(api.cms.pages.acquirePageEditorLock, {
      pageId: authorId,
      force: true,
    })
    await asUser.mutation(api.cms.pages.updateDraft, {
      pageId: authorId,
      expectedUpdatedAt: opened?.updatedAt,
      content: {
        en: {
          pageType: "author",
          localized: {
            title: "Grace Hopper",
            roleTitle: "Rear Admiral",
          },
          slices: [],
        },
      },
    })
    await asUser.mutation(api.cms.pages.publish, { pageId: authorId })
    const reloaded = await asUser.query(api.cms.pages.getById, {
      id: authorId,
    })
    const en = (
      reloaded as {
        content?: Record<string, { roleTitle?: string }>
      }
    ).content?.en
    expect(en?.roleTitle).toBe("Rear Admiral")
    // Plan 029 C10 task 6: `bio` deleted per ADR-0038 §Slices-as-body —
    // formatted intros are now a `rich-text-body` slice on the canvas.
  })

  test("author name / socials round-trip through pages.update (C8 shared-field save wiring)", sliceProfile([]), async () => {
    // Discriminating check for the advisor-flagged data-loss risk: the
    // generic Content panel edits `sharedFieldValues` which must reach
    // `pages.update`. If the wiring is missing, the toast says "Saved" but
    // the DB row is unchanged.
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    const authorId = await createTestAuthor(t, asUser, {
      status: "draft",
      title: "Original",
      name: "Original",
      content: { en: { title: "Original" } },
    })
    const opened = await asUser.query(api.cms.pages.getById, { id: authorId })
    await asUser.mutation(api.cms.pages.update, {
      id: authorId,
      name: "Renamed via update",
      socials: [{ platform: "GitHub", url: "https://github.com/x" }],
      expectedUpdatedAt: opened?.updatedAt,
    })
    const reloaded = await asUser.query(api.cms.pages.getById, {
      id: authorId,
    })
    expect((reloaded as { name?: string })?.name).toBe("Renamed via update")
    expect(
      (
        reloaded as {
          socials?: { platform: string; url: string }[]
        }
      ).socials
    ).toEqual([
      {
        platform: "GitHub",
        url: "https://github.com/x",
        itemId: expect.any(String),
      },
    ])
  })

  test("post category round-trips through pages.update", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    const postId = await asUser.mutation(api.cms.pages.create, {
      pageType: "post",
      status: "draft",
      title: "A post",
      content: { en: { title: "A post" } },
    })
    const opened = await asUser.query(api.cms.pages.getById, { id: postId })
    await asUser.mutation(api.cms.pages.update, {
      id: postId,
      category: "engineering",
      expectedUpdatedAt: opened?.updatedAt,
    })
    const reloaded = await asUser.query(api.cms.pages.getById, { id: postId })
    expect((reloaded as { category?: string })?.category).toBe("engineering")
  })

  test("null on pages.update clears optional descriptor sharedFields (category, socials)", sliceProfile([]), async () => {
    // Plan 029 C9a — the "cleared shared field is a no-op" C8 follow-up.
    // Convex serializes `undefined` args as omitted, so the generic panel's
    // spread of `{ ...changedSharedFields, id }` with a cleared key never
    // reached the server's clear branch. The widened args accept `null` as
    // the clear signal, and the handler translates it to `undefined` on
    // the patch (Convex's remove-field signal).
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    const postId = await asUser.mutation(api.cms.pages.create, {
      pageType: "post",
      status: "draft",
      title: "Cleared post",
      category: "engineering",
    })
    let opened = await asUser.query(api.cms.pages.getById, { id: postId })
    expect((opened as { category?: string })?.category).toBe("engineering")
    await asUser.mutation(api.cms.pages.update, {
      id: postId,
      category: null,
      expectedUpdatedAt: opened?.updatedAt,
    })
    opened = await asUser.query(api.cms.pages.getById, { id: postId })
    expect((opened as { category?: string })?.category).toBeUndefined()

    // Same clear semantics for author.socials.
    const authorId = await createTestAuthor(t, asUser, {
      status: "draft",
      title: "Author",
      name: "Author",
      socials: [{ platform: "GitHub", url: "https://github.com/x" }],
      content: { en: { title: "Author" } },
    })
    let author = await asUser.query(api.cms.pages.getById, { id: authorId })
    expect((author as { socials?: unknown[] }).socials?.length).toBe(1)
    await asUser.mutation(api.cms.pages.update, {
      id: authorId,
      socials: null,
      expectedUpdatedAt: author?.updatedAt,
    })
    author = await asUser.query(api.cms.pages.getById, { id: authorId })
    expect((author as { socials?: unknown[] }).socials).toBeUndefined()
  })

  test("post byline add-then-clear-then-add lifecycle keeps documentReferences honest", sliceProfile([]), async () => {
    // Plan 029 C9a — the references refresh coverage test. authorId is
    // the only live descriptor `relation()` today; each save should
    // emit exactly one shared-field row while the byline is set and
    // none while cleared.
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    const author1 = await createTestAuthor(t, asUser, {
      status: "published",
      title: "Author One",
      name: "Author One",
    })
    const author2 = await createTestAuthor(t, asUser, {
      status: "published",
      title: "Author Two",
      name: "Author Two",
    })
    const postId = await asUser.mutation(api.cms.pages.create, {
      pageType: "post",
      status: "draft",
      title: "Live post",
    })

    const countRefs = () =>
      t.run(async (ctx) => {
        const rows = await ctx.db
          .query("documentReferences")
          .withIndex("by_source", (q) => q.eq("sourceId", postId))
          .collect()
        return rows
      })

    expect(await countRefs()).toHaveLength(0)

    // Add byline → 1 row targeting author1.
    let opened = await asUser.query(api.cms.pages.getById, { id: postId })
    await asUser.mutation(api.cms.pages.update, {
      id: postId,
      authorIds: [author1],
      expectedUpdatedAt: opened?.updatedAt,
    })
    const afterAdd = await countRefs()
    expect(afterAdd).toHaveLength(1)
    expect(afterAdd[0].targetId).toBe(author1)
    expect(afterAdd[0].source).toBe("shared-field")
    // Plan 029 C10 — `authorIds` is a list, walker emits per-index path.
    expect(afterAdd[0].path).toBe("authorIds[0]")

    // Clear byline → 0 rows (empty array = clear).
    opened = await asUser.query(api.cms.pages.getById, { id: postId })
    await asUser.mutation(api.cms.pages.update, {
      id: postId,
      authorIds: [],
      expectedUpdatedAt: opened?.updatedAt,
    })
    expect(await countRefs()).toHaveLength(0)

    // Add a different byline → 1 row targeting author2.
    opened = await asUser.query(api.cms.pages.getById, { id: postId })
    await asUser.mutation(api.cms.pages.update, {
      id: postId,
      authorIds: [author2],
      expectedUpdatedAt: opened?.updatedAt,
    })
    const afterReadd = await countRefs()
    expect(afterReadd).toHaveLength(1)
    expect(afterReadd[0].targetId).toBe(author2)
  })

  test("checklist blocks publish on empty required descriptor shared field (author.name)", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    const authorId = await createTestAuthor(t, asUser, {
      status: "draft",
      title: "Placeholder",
      name: "Placeholder",
      content: { en: { title: "Placeholder" } },
    })
    // Directly zap `name` at the storage layer to exercise the shared
    // required-field check; the mutation path defends against this
    // (name.trim() must be non-empty) so we simulate legacy data.
    await t.run(async (ctx) => {
      await ctx.db.patch(authorId, { name: "" })
    })
    const checklist = await asUser.query(api.cms.pages.getPrePublishChecklist, {
      pageId: authorId,
    })
    expect(checklist.canPublish).toBe(false)
    const codes = checklist.blockers.map((item) => item.code)
    expect(codes).toContain("missing_required_field")
    const nameBlocker = checklist.blockers.find((item) => item.field === "name")
    expect(nameBlocker).toBeDefined()
    expect(nameBlocker?.locales).toBeUndefined()
  })

  test("scheduling a publish with a draft byline is caught by the scheduled-publish cron (intent='publish' fires)", sliceProfile(["hero-agency"]), async () => {
    // Plan 029 C9a — advisor-flagged scheduled-publish bug. The v1 gate
    // read `page.status === "published"` which is always false when
    // scheduling a draft AND when `processScheduledTransitions` fires
    // against the queued draft (still draft at that moment). Descriptor
    // byline check has to run at cron-time — that's what the explicit
    // `"publish"` intent arg accomplishes.
    //
    // ADR-0041 Deploy 2 PR B moved scheduling onto staging;
    // `pages.updateDraft` intentionally defers checklist validation to
    // publish/cron (the schedulingPublish permission gate still fires at
    // schedule time). This test now asserts the cron catch: schedule
    // succeeds, cron runs the checklist with intent="publish" against
    // the overlaid page, sees the draft-byline blocker, clears the
    // staged scheduledAt so the row doesn't hot-loop.
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    const draftAuthorId = await createTestAuthor(t, asUser, {
      status: "draft",
      title: "Draft Author",
      name: "Draft Author",
      content: { en: { title: "Draft Author" } },
    })
    const postId = await asUser.mutation(api.cms.pages.create, {
      pageType: "post",
      status: "draft",
      title: "Scheduled post",
      authorIds: [draftAuthorId],
      content: {
        en: {
          title: "Scheduled post",
          slices: [
            {
              id: "hero-1",
              type: "hero-agency",
              enabled: true,
              primary: {
                eyebrow: "News",
                title: "Scheduled post",
                description: canonicalBody("Body"),
              },
              items: [],
            },
          ],
        },
      },
    })
    // Schedule via the staging seam; make the schedule due immediately so
    // the cron picks it up in this tick.
    await scheduleViaDraft(asUser, postId, Date.now() - 1_000)

    const result = await t.mutation(
      internal.cms.pages.processScheduledTransitions,
      {}
    )
    expect(result.published).toBe(0)
    // Cron cleared the staged scheduledAt via the failed-checklist branch.
    const stagedAfter = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("pageStaging")
        .withIndex("by_pageId", (q) => q.eq("pageId", postId))
        .first()
      return row?.scheduledAt ?? null
    })
    expect(stagedAfter).toBeNull()
    // Page stays draft (never promoted).
    const after = await asUser.query(api.cms.pages.getById, { id: postId })
    expect(after?.status).toBe("draft")
  })

  test("descriptor byline relation blocker uses descriptor-aware wording, not slice-worded", sliceProfile(["hero-agency"]), async () => {
    // Plan 029 C9a — advisor-flagged post-C9a bug: descriptor byline
    // relations were feeding through the slice walk's shared referenced-
    // page loop, so a draft-author byline emitted "A slice references …"
    // Fixed by running descriptor relations through their own loop with
    // descriptor wording + field/locales metadata + publish-state gate.
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    // Draft author (so the post-publish flow would surface the target).
    const draftAuthorId = await createTestAuthor(t, asUser, {
      status: "draft",
      title: "Draft Author",
      name: "Draft Author",
      content: { en: { title: "Draft Author" } },
    })
    // Post that we'll publish — draft-author byline should block, with
    // descriptor wording and `field="authorIds"`.
    const postId = await asUser.mutation(api.cms.pages.create, {
      pageType: "post",
      status: "draft",
      title: "Live post",
      authorIds: [draftAuthorId],
      content: {
        en: {
          title: "Live post",
          slices: [
            {
              id: "hero-1",
              type: "hero-agency",
              enabled: true,
              primary: {
                eyebrow: "News",
                title: "Live post",
                description: canonicalBody("Body"),
              },
              items: [],
            },
          ],
        },
      },
    })
    // Attempt to publish → the owner-facing refusal should identify the
    // unpublished related page without exposing the internal field name or
    // calling it "a slice".
    // ADR-0041 Deploy 3 (Narrow): publish is `pages.publish` exclusively,
    // and it requires a staging row (assertPrePublishAllowed runs after
    // the staging load). Seed staging via updateDraft so publish reaches
    // the checklist branch we're asserting on.
    await asUser.mutation(api.cms.pages.acquirePageEditorLock, {
      pageId: postId,
      force: true,
    })
    await asUser.mutation(api.cms.pages.updateDraft, {
      pageId: postId,
      content: {
        en: {
          pageType: "post",
          localized: { title: "Live post" },
          slices: [
            {
              id: "hero-1",
              type: "hero-agency",
              enabled: true,
              primary: {
                eyebrow: "News",
                title: "Live post",
                description: canonicalBody("Body"),
              },
              items: [],
            },
          ],
        },
      },
    })
    await expect(
      asUser.mutation(api.cms.pages.publish, { pageId: postId })
    ).rejects.toThrow(/isn't published/i)
    // The checklist itself should surface the descriptor-wording blocker
    // with `field` metadata rather than the anonymous slice message.
    // Also confirm we did not double-fire the slice-worded variant.
    const checklist = await asUser.query(api.cms.pages.getPrePublishChecklist, {
      pageId: postId,
    })
    // The editor's readiness query is specifically the truth surface behind
    // the Publish button. It must block a guaranteed refusal before the owner
    // is offered "Publish anyway". Ordinary Save remains unaffected because
    // the checklist is queried separately from the save mutation.
    const bylineBlockers = checklist.blockers.filter((item) =>
      item.field?.startsWith("authorIds")
    )
    expect(bylineBlockers).toHaveLength(1)
    expect(bylineBlockers[0]).toMatchObject({
      code: "archived_relation_target",
      severity: "blocker",
      field: "authorIds[0]",
    })
    expect(bylineBlockers[0]?.message).not.toContain("A slice")
  })

  test("saves the localized bag independently per locale (≥3 locales, no leakage)", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    await asUser.mutation(api.cms.settings.completeOnboarding, {
      siteName: "Site",
      siteUrl: "https://example.com",
      timezone: "UTC",
      defaultLocale: "en",
      enabledLocales: ["en", "fr", "ar"],
    })
    const authorId = await createTestAuthor(t, asUser, {
      status: "draft",
      title: "Author",
      name: "Author",
      content: {
        en: { title: "Author" },
        fr: { title: "Auteur" },
        ar: { title: "المؤلف" },
      },
    })
    for (const locale of ["en", "fr", "ar"]) {
      const opened = await asUser.query(api.cms.pages.getById, { id: authorId })
      // ADR-0041 Deploy 3 (Narrow) Bucket A — publish each locale save so
      // the round-trip on `pages.content` is visible to the reload assertion.
      await asUser.mutation(api.cms.pages.acquirePageEditorLock, {
        pageId: authorId,
        force: true,
      })
      await asUser.mutation(api.cms.pages.updateDraft, {
        pageId: authorId,
        expectedUpdatedAt: opened?.updatedAt,
        content: {
          [locale]: {
            pageType: "author",
            localized: {
              title: `Author (${locale})`,
              roleTitle: `role-${locale}`,
            },
            slices: [],
          },
        },
      })
      await asUser.mutation(api.cms.pages.publish, { pageId: authorId })
    }
    const final = await asUser.query(api.cms.pages.getById, { id: authorId })
    const bags =
      (
        final as {
          content?: Record<string, { roleTitle?: string; title?: string }>
        }
      ).content ?? {}
    expect(bags.en?.roleTitle).toBe("role-en")
    expect(bags.fr?.roleTitle).toBe("role-fr")
    expect(bags.ar?.roleTitle).toBe("role-ar")
    expect(bags.en?.title).toBe("Author (en)")
    expect(bags.fr?.title).toBe("Author (fr)")
    expect(bags.ar?.title).toBe("Author (ar)")
  })
})

/**
 * Plan 029 C9b — descriptor row-level shared-field archival on
 * `pageRevisions.sharedFieldsJson`, drift-tolerant reader, null-as-clear
 * restore. ADR-0029 heterogeneous-by-design: legacy revisions with the
 * field absent restore safely.
 */
describe("pages — post.promoteToFront sticky auto-unset (C10 task 10)", () => {
  test("updating a second post to sticky demotes the first", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const postAId = await asUser.mutation(api.cms.pages.create, {
      slug: "post-a",
      pageType: "post",
      status: "draft",
      title: "Post A",
      promoteToFront: true,
    })
    const postBId = await asUser.mutation(api.cms.pages.create, {
      slug: "post-b",
      pageType: "post",
      status: "draft",
      title: "Post B",
    })

    // Sanity — A is sticky, B is not.
    const beforeA = await asUser.query(api.cms.pages.getById, { id: postAId })
    const beforeB = await asUser.query(api.cms.pages.getById, { id: postBId })
    expect((beforeA as { promoteToFront?: boolean }).promoteToFront).toBe(true)
    expect((beforeB as { promoteToFront?: boolean }).promoteToFront).toBe(false)

    // Flip B sticky — A should demote.
    await asUser.mutation(api.cms.pages.update, {
      id: postBId,
      promoteToFront: true,
    })
    const afterA = await asUser.query(api.cms.pages.getById, { id: postAId })
    const afterB = await asUser.query(api.cms.pages.getById, { id: postBId })
    expect((afterA as { promoteToFront?: boolean }).promoteToFront).toBe(false)
    expect((afterB as { promoteToFront?: boolean }).promoteToFront).toBe(true)
  })

  test("creating a sticky post demotes an existing sticky post", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    const oldStickyId = await asUser.mutation(api.cms.pages.create, {
      slug: "old-sticky",
      pageType: "post",
      status: "draft",
      title: "Old sticky",
      promoteToFront: true,
    })
    const newStickyId = await asUser.mutation(api.cms.pages.create, {
      slug: "new-sticky",
      pageType: "post",
      status: "draft",
      title: "New sticky",
      promoteToFront: true,
    })

    const oldRow = await asUser.query(api.cms.pages.getById, {
      id: oldStickyId,
    })
    const newRow = await asUser.query(api.cms.pages.getById, {
      id: newStickyId,
    })
    expect((oldRow as { promoteToFront?: boolean }).promoteToFront).toBe(false)
    expect((newRow as { promoteToFront?: boolean }).promoteToFront).toBe(true)
  })

  test("clearing sticky on the current post does not demote anyone else", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)

    // Even though only one post can be sticky at a time by design,
    // clearing your own sticky is a legal no-op for the demotion path:
    // nobody else is holding the flag, so nothing to unset.
    const postId = await asUser.mutation(api.cms.pages.create, {
      slug: "clearable",
      pageType: "post",
      status: "draft",
      title: "Clearable",
      promoteToFront: true,
    })
    await asUser.mutation(api.cms.pages.update, {
      id: postId,
      promoteToFront: false,
    })
    const row = await asUser.query(api.cms.pages.getById, { id: postId })
    expect((row as { promoteToFront?: boolean }).promoteToFront).toBe(false)
  })
})

describe("pages — testimonial pure-form editor (C10 task 13)", () => {
  activeTestimonialTest(
    "create seeds personName + testimonial content bag; localized quote/title round-trip",
    async () => {
      const t = pageTest()
      const asUser = t.withIdentity(TEST_USER)
      // `pages.create` widens to accept testimonial (task 13 fix). Title
      // seeds `personName` on the row; content bag carries `{title, quote:
      // ""}` per locale — no `slices` field on the pure-form arm.
      const id = await asUser.mutation(api.cms.pages.create, {
        pageType: "testimonial",
        status: "draft",
        title: "Grace Hopper @ Yale, 1980",
        defaultLocale: "en",
      })
      // ADR-0041 Deploy 2 PR B item 3 — the seeded testimonial content
      // bag now lives on `pageStaging`, not `pages.content`. Read the
      // overlaid view via `getForEdit`, which the editor also uses.
      const createdRow = await asUser.query(api.cms.pages.getById, { id })
      const createdEdit = await asUser.query(api.cms.pages.getForEdit, { id })
      const created = createdEdit?.page
      expect(createdRow?.pageType).toBe("testimonial")
      expect((createdRow as { personName?: string }).personName).toBe(
        "Grace Hopper @ Yale, 1980"
      )
      expect(
        (
          created as {
            content?: Record<string, { quote?: string; slices?: unknown }>
          }
        ).content?.en?.quote
      ).toBe("")
      expect(
        (created as { content?: Record<string, { slices?: unknown }> }).content
          ?.en?.slices
      ).toBeUndefined()

      // Save the descriptor localized bag — pure-form arm carries no
      // slices, no metaTitle/metaDescription. ADR-0041 Deploy 3 (Narrow)
      // Bucket A: publish so `pages.content` reflects the save.
      await asUser.mutation(api.cms.pages.acquirePageEditorLock, {
        pageId: id,
        force: true,
      })
      await asUser.mutation(api.cms.pages.updateDraft, {
        pageId: id,
        expectedUpdatedAt: created?.updatedAt,
        content: {
          en: {
            pageType: "testimonial",
            localized: {
              title: "Grace Hopper @ Yale, 1980",
              quote:
                "The most damaging phrase is 'we've always done it this way.'",
            },
          },
        },
      })
      await asUser.mutation(api.cms.pages.publish, { pageId: id })
      const reloaded = await asUser.query(api.cms.pages.getById, { id })
      expect(
        (reloaded as { content?: Record<string, { quote?: string }> }).content
          ?.en?.quote
      ).toBe("The most damaging phrase is 'we've always done it this way.'")
    }
  )

  activeTestimonialTest(
    "shared fields fan through pages.update (personName + optional siblings)",
    async () => {
      const t = pageTest()
      const asUser = t.withIdentity(TEST_USER)
      const id = await asUser.mutation(api.cms.pages.create, {
        pageType: "testimonial",
        status: "draft",
        title: "Grace Hopper",
        defaultLocale: "en",
      })
      const created = await asUser.query(api.cms.pages.getById, { id })
      await asUser.mutation(api.cms.pages.update, {
        id,
        expectedUpdatedAt: created?.updatedAt,
        personName: "Grace Hopper",
        personRole: "Rear Admiral",
        personCompany: "United States Navy",
        sourceUrl: "https://example.com/grace",
      })
      const reloaded = await asUser.query(api.cms.pages.getById, { id })
      const row = reloaded as {
        personName?: string
        personRole?: string
        personCompany?: string
        sourceUrl?: string
      }
      expect(row.personName).toBe("Grace Hopper")
      expect(row.personRole).toBe("Rear Admiral")
      expect(row.personCompany).toBe("United States Navy")
      expect(row.sourceUrl).toBe("https://example.com/grace")

      // Optional shared field clears via `null` (null-as-clear pattern).
      await asUser.mutation(api.cms.pages.update, {
        id,
        expectedUpdatedAt: reloaded?.updatedAt,
        personRole: null,
      })
      const cleared = await asUser.query(api.cms.pages.getById, { id })
      expect((cleared as { personRole?: string }).personRole).toBeUndefined()
    }
  )

  test("shared-field cross-arm gate: personName rejected on non-testimonial rows", sliceProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    const pageId = await asUser.mutation(api.cms.pages.create, {
      pageType: "page",
      status: "draft",
      title: "Regular page",
    })
    const created = await asUser.query(api.cms.pages.getById, { id: pageId })
    await expect(
      asUser.mutation(api.cms.pages.update, {
        id: pageId,
        expectedUpdatedAt: created?.updatedAt,
        personName: "Not a testimonial",
      })
    ).rejects.toThrow(/personName is only valid on pageType='testimonial'/)
  })

  activeTestimonialTest(
    "personImage set/clear via pages.update fans through refreshPageReferences → mediaReferences",
    async () => {
      const t = pageTest()
      const asUser = t.withIdentity(TEST_USER)
      const { mediaId, storageId } = await t.run(async (ctx) => {
        const storage = await ctx.storage.store(
          new Blob(["x"], { type: "image/png" })
        )
        const media = await ctx.db.insert("media", {
          filename: "person.png",
          storageId: storage,
          url: "https://example.com/person.png",
          size: 1,
          mimeType: "image/png",
          uploadedAt: Date.now(),
        })
        return { mediaId: media, storageId: storage }
      })
      const id = await asUser.mutation(api.cms.pages.create, {
        pageType: "testimonial",
        status: "draft",
        title: "Grace Hopper",
      })
      const created = await asUser.query(api.cms.pages.getById, { id })
      // Set personImage → refreshPageReferences (invoked by pages.update)
      // fans it into a mediaReferences row via the descriptor-image walker
      // (plan 029 C10 Unit A). This is the vertical integration test that
      // proves the pure-form writer preserves media orphan-safety.
      await asUser.mutation(api.cms.pages.update, {
        id,
        expectedUpdatedAt: created?.updatedAt,
        personImage: {
          storageId,
          url: "https://example.com/person.png",
        },
      })
      const rowsAfterSet = await t.run(async (ctx) =>
        ctx.db.query("mediaReferences").take(10)
      )
      const testimonialRows = rowsAfterSet.filter(
        (r) => r.source === "descriptor-image" && r.path === "personImage"
      )
      expect(testimonialRows.length).toBe(1)
      expect(testimonialRows[0].mediaId).toBe(mediaId)

      // Clear personImage via null-as-clear → row disappears.
      const reloaded = await asUser.query(api.cms.pages.getById, { id })
      await asUser.mutation(api.cms.pages.update, {
        id,
        expectedUpdatedAt: reloaded?.updatedAt,
        personImage: null,
      })
      const rowsAfterClear = await t.run(async (ctx) =>
        ctx.db
          .query("mediaReferences")
          .take(10)
          .then((rows) =>
            rows.filter(
              (r) => r.source === "descriptor-image" && r.path === "personImage"
            )
          )
      )
      expect(rowsAfterClear).toEqual([])
    }
  )

  activeTestimonialTest(
    "empty personName is rejected on testimonial row",
    async () => {
      const t = pageTest()
      const asUser = t.withIdentity(TEST_USER)
      const id = await asUser.mutation(api.cms.pages.create, {
        pageType: "testimonial",
        status: "draft",
        title: "Grace Hopper",
      })
      const created = await asUser.query(api.cms.pages.getById, { id })
      await expect(
        asUser.mutation(api.cms.pages.update, {
          id,
          expectedUpdatedAt: created?.updatedAt,
          personName: "   ",
        })
      ).rejects.toThrow(/Testimonial personName cannot be empty/)
    }
  )

  activeTestimonialTest(
    "public search index carries quote + personName but not the admin-only title",
    async () => {
      const t = pageTest()
      const asUser = t.withIdentity(TEST_USER)
      const id = await asUser.mutation(api.cms.pages.create, {
        pageType: "testimonial",
        status: "draft",
        // Admin-only internal identifier (localized title). The words
        // "Yale" + "1980" only appear here — they must NOT show up in the
        // public search index. `personName` starts equal to `title` after
        // create (task 13 seed), so we rename it below to prove the title
        // itself isn't crossing the exposure gate.
        title: "Grace Hopper @ Yale, 1980",
        defaultLocale: "en",
      })
      let created = await asUser.query(api.cms.pages.getById, { id })
      // Rename personName so no other public field shares the words we're
      // asserting against.
      await asUser.mutation(api.cms.pages.update, {
        id,
        expectedUpdatedAt: created?.updatedAt,
        personName: "Grace Hopper",
      })
      created = await asUser.query(api.cms.pages.getById, { id })
      // ADR-0041 Deploy 3 (Narrow) Bucket A — `pageSearch` syncs only on
      // publish (not on `updateDraft`), and the assertion further down
      // reads the `pageSearch` blob for "cobol is a language". Publishing
      // ensures the search row reflects the newly-saved quote.
      await asUser.mutation(api.cms.pages.acquirePageEditorLock, {
        pageId: id,
        force: true,
      })
      // No `expectedUpdatedAt` — draft-created testimonials seed
      // staging, so page.updatedAt and staging.updatedAt are on
      // different clocks after the `pages.update(personName)` above.
      await asUser.mutation(api.cms.pages.updateDraft, {
        pageId: id,
        content: {
          en: {
            pageType: "testimonial",
            localized: {
              title: "Grace Hopper @ Yale, 1980",
              quote: "COBOL is a language for the ages",
            },
          },
        },
      })
      await asUser.mutation(api.cms.pages.publish, { pageId: id })
      const rows = await t.run(async (ctx) => {
        return ctx.db
          .query("pageSearch")
          .withIndex("by_pageId", (q) => q.eq("pageId", id))
          .collect()
      })
      const enRows = rows.filter((r) => r.locale === "en")
      expect(enRows.length).toBe(1)
      const text = enRows[0].text.toLowerCase()
      expect(text).toContain("cobol is a language")
      expect(text).toContain("grace hopper")
      // Admin-only localized `title` must NOT leak into the public search
      // index — ADR-0038's exposure gate. The stored title is
      // "Grace Hopper @ Yale, 1980"; assert the admin-only "yale, 1980"
      // fragment is filtered out even though personName shares the name.
      expect(text).not.toContain("yale, 1980")
    }
  )
})


test.each([0, -1, 13, 1.5])("snapshot recent cards reject invalid limit %s before index reads", sliceProfile([]), async (limit) => {
  const t = pageTest()
  await t.run(async (ctx) => {
    const authority = await ctx.db.query("pagePublicationCutover").unique()
    if (authority) await ctx.db.patch("pagePublicationCutover", authority._id, { phase: "snapshot_active" })
  })
  await expect(t.query(api.cms.pages.listRecentPublicRelationCards, {
    languageVersion: 0, pageType: "post", locale: "en", limit,
  })).rejects.toThrow("integer from 1 to 12")
})

// Round A: exercise the same successor and menu writers as a fresh FR site.
// The explicit-admin harness establishes only the authenticated owner binding;
// publication authority and language setup below are ordinary UI commands.
describe("menu picker successor writer seam", () => {
  async function pickerSite() {
    const t = convexTest({
      schema,
      modules,
      ownerIdentity: TEST_USER,
      publicationAuthority: "missing",
      transactionLimits: { databaseQueries: 2048, documentsRead: 32000, bytesRead: 16 * 1024 * 1024 },
    })
    const owner = t.withIdentity(TEST_USER)
    await owner.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: "Menu picker",
      timezone: "UTC",
      defaultLocale: "fr",
    })
    const changes = [{ moduleId: "multilingual", enabled: true }]
    const preview = await owner.query(api.cms.modules.preview, { changes })
    await owner.mutation(api.cms.modules.commit, {
      changes,
      expectedConfigurationVersion: preview.configurationVersion,
    })
    const { commandTokens } = await owner.query(
      api.cms.multilingual.getMultilingualState,
      {}
    )
    if (commandTokens.settingsUpdatedAt === null) throw new Error("Missing bootstrapped settings")
    const added = await owner.mutation(api.cms.multilingual.addSiteLanguage, {
      locale: "en",
      expectedSettingsUpdatedAt: commandTokens.settingsUpdatedAt,
      expectedModuleConfigurationVersion:
        commandTokens.moduleConfigurationVersion,
      expectedAuthorityVersion: commandTokens.authorityVersion,
    })
    expect(added.ok).toBe(true)
    return { t, owner }
  }
  type PickerSite = Awaited<ReturnType<typeof pickerSite>>
  async function newPage(
    owner: PickerSite["owner"],
    slug: string,
    english = true
  ) {
    const pageId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      defaultLocale: "fr",
      slug,
      title: "Initial FR",
    })
    await owner.mutation(api.cms.publication.saveEditorDraft, {
      pageId,
      expectedLifecycleGeneration: 1,
      localized: {
        locale: "fr",
        slug,
        expectedGeneration: 1,
        draft: {
          pageType: "landing-page",
          localized: { title: `Titre ${slug}` },
          slices: [],
        },
      },
    })
    if (english)
      await owner.mutation(api.cms.publication.saveLocaleDraft, {
        pageId,
        locale: "en",
        slug: `english-${slug}`,
        expectedDraftGeneration: 0,
        expectedLifecycleGeneration: 1,
        draft: {
          pageType: "landing-page",
          localized: { title: `English ${slug}` },
          slices: [],
        },
      })
    return pageId
  }
  const publishFr = (owner: PickerSite["owner"], pageId: Id<"pages">) =>
    owner.mutation(api.cms.publication.publishLocale, {
      pageId,
      locale: "fr",
      expectedDraftGeneration: 2,
      expectedSharedDraftGeneration: 1,
      expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1,
      expectedReleaseGeneration: 0,
    })

  for (const incomplete of ["blank-title"] as const) {
    test.each(["list", "selection"] as const)(
      `picker_keeps_page_when_one_locale_draft_is_blank: ${incomplete} %s`,
      async (endpoint) => {
        const { owner } = await pickerSite()
        const pageId = await newPage(owner, "fr-published", false)
        await publishFr(owner, pageId)
        await owner.mutation(api.cms.publication.saveLocaleDraft, {
          pageId,
          locale: "en",
          slug: "english-draft",
          expectedDraftGeneration: 0,
          expectedLifecycleGeneration: 1,
          draft: {
            pageType: "landing-page",
            localized: { title: "   " },
            slices: [],
          },
        })
        const rows = endpoint === "list"
          ? await owner.query(api.cms.pages.listLinkablePages, { locale: "fr" })
          : await owner.query(api.cms.pages.getLinkablePageSelection, { pageId })
              .then((result) => result.status === "available" ? [result.page] : [])
        const row = rows.find((candidate) => candidate._id === pageId)
        expect(row).toBeDefined()
        expect(row!.localizedTitles).toEqual({ fr: "Titre fr-published" })
        expect(row!.localizedSlugs).toEqual({ fr: "fr-published" })
        expect(row!.localePublicationStates).toEqual({ fr: "published", en: "draft" })
      }
    )
  }

  test.each(["fr", "en"])(
    "picker_from_real_successor_drafts: %s list, search, selection and public resolution",
    async (locale) => {
      const { t, owner } = await pickerSite()
      const pageId = await newPage(owner, "cible")
      await publishFr(owner, pageId)
      const other = await newPage(owner, "sans-traduction", false)
      for (const endpoint of ["list", "selection"] as const) {
        const rows =
          endpoint === "list"
            ? await owner.query(api.cms.pages.listLinkablePages, {
                locale,
                limit: 100,
              })
            : await owner
                .query(api.cms.pages.getLinkablePageSelection, { pageId })
                .then((r) => (r.status === "available" ? [r.page] : []))
        const row = rows.find((r) => r._id === pageId)!
        expect(row).toMatchObject({
          slug: "cible",
          localizedSlugs: { en: "english-cible" },
          localizedTitles: { fr: "Titre cible", en: "English cible" },
          localePublicationStates: { fr: "published", en: "draft" },
        })
      }
      for (const search of [
        locale === "fr" ? "Titre cible" : "English cible",
        locale === "fr" ? "cible" : "english-cible",
      ]) {
        expect(
          (
            await owner.query(api.cms.pages.listLinkablePages, {
              locale,
              search,
            })
          ).map((r) => r._id)
        ).toContain(pageId)
      }
      const published = await owner.query(api.cms.pages.listLinkablePages, {
        locale,
        includeDrafts: false,
      })
      expect(published.some((r) => r._id === pageId)).toBe(locale === "fr")
      expect(
        (
          await owner.query(api.cms.pages.listLinkablePages, { locale: "en" })
        ).some((r) => r._id === other)
      ).toBe(false)
      await owner.mutation(api.cms.publication.saveEditorDraft, {
        pageId,
        expectedLifecycleGeneration: 1,
        localized: {
          locale: "fr",
          slug: "cible-modifiee",
          expectedGeneration: 2,
          draft: {
            pageType: "landing-page",
            localized: { title: "Titre modifié" },
            slices: [],
          },
        },
      })
      expect(
        await owner.query(api.cms.pages.listLinkablePages, {
          locale: "fr",
          includeDrafts: false,
          search: "modifié",
        })
      ).toEqual([
        expect.objectContaining({
          _id: pageId,
          localePublicationStates: { fr: "published", en: "draft" },
        }),
      ])
      const nav = [
        {
          id: "target",
          label: { fr: "Cible", en: "Target" },
          target: { type: "internal" as const, pageId },
        },
      ]
      await owner.mutation(api.cms.menus.saveCanonical, {
        slug: "primary",
        locale: "fr",
        nav: [{ ...nav[0]!, label: { fr: "Cible" } }],
      })
      await owner.mutation(api.cms.menus.saveCanonical, {
        slug: "primary",
        locale: "en",
        nav,
      })
      expect(
        (await owner.query(api.cms.menus.getCanonical, { slug: "primary" }))
          ?.nav
      ).toEqual(nav)
      const config = await owner.query(api.cms.settings.getSiteConfig, {})
      const resolved = await t.query(api.cms.menus.getWithResolvedLinks, {
        slug: "primary",
        locale,
        languageVersion: config.languageVersion,
      })
      expect(resolved?.nav[0]?.target).toEqual(
        locale === "fr"
          ? { type: "internal", url: "/cible" }
          : { type: "internal" }
      )
      // Discard is a real editor command: now title/slug must come from verified frozen fallback.
      await owner.mutation(api.cms.publication.discardLocaleDraft, {
        pageId,
        locale: "fr",
        expectedDraftGeneration: 3,
        expectedLifecycleGeneration: 1,
      })
      const selected = await owner.query(
        api.cms.pages.getLinkablePageSelection,
        { pageId }
      )
      expect(selected).toMatchObject({
        status: "available",
        page: { localizedTitles: { fr: "Titre cible" }, slug: "cible" },
      })
      expect(
        await owner.query(api.cms.pages.listLinkablePages, {
          locale: "fr",
          search: "Titre cible",
        })
      ).toEqual([expect.objectContaining({ _id: pageId })])
    }
  )

  test("picker lifecycle, type and permission exclusions; archived selection metadata survives", async () => {
    const { owner, t } = await pickerSite()
    const pageId = await newPage(owner, "archive")
    await owner.mutation(api.cms.publication.archivePage, {
      pageId,
      expectedLifecycleGeneration: 1,
    })
    expect(
      await owner.query(api.cms.pages.getLinkablePageSelection, { pageId })
    ).toMatchObject({
      status: "available",
      page: { status: "archived", localizedTitles: { fr: "Titre archive" } },
    })
    expect(
      (
        await owner.query(api.cms.pages.listLinkablePages, { locale: "fr" })
      ).some((r) => r._id === pageId)
    ).toBe(false)
    await owner.mutation(api.cms.publication.softDeletePage, {
      pageId,
      expectedLifecycleGeneration: 2,
    })
    expect(
      await owner.query(api.cms.pages.getLinkablePageSelection, { pageId })
    ).toEqual({ status: "missing" })
    expect(
      (
        await owner.query(api.cms.pages.listLinkablePages, { locale: "fr" })
      ).some((r) => r._id === pageId)
    ).toBe(false)
    await expect(
      owner.mutation(api.cms.pages.create, {
        pageType: "testimonial",
        status: "draft",
        slug: "excluded",
        title: "Hidden",
      })
    ).rejects.toThrow(/not active/)
    await expect(
      t
        .withIdentity({ subject: "unrelated" })
        .query(api.cms.pages.getLinkablePageSelection, { pageId })
    ).rejects.toThrow(/CMS_OWNER_REQUIRED/)
  })

  test("100 two-locale frozen projections fit the picker query budget", async () => {
    const { owner } = await pickerSite()
    let pageId!: Id<"pages">
    for (let i = 0; i < 100; i++) {
      pageId = await newPage(owner, `budget-${i}`)
      await publishFr(owner, pageId)
      await owner.mutation(api.cms.publication.publishLocale, {
        pageId, locale: "en", expectedDraftGeneration: 1, expectedSharedDraftGeneration: 1,
        expectedPublicGeneration: 0, expectedLifecycleGeneration: 1, expectedReleaseGeneration: 0,
      })
      for (const locale of ["fr", "en"]) await owner.mutation(api.cms.publication.discardLocaleDraft, {
        pageId, locale, expectedDraftGeneration: locale === "fr" ? 2 : 1, expectedLifecycleGeneration: 1,
      })
    }
    // Each transaction is constrained to half the provider's index-range cap.
    const published = await owner.query(api.cms.pages.listLinkablePages, { locale: "fr", includeDrafts: false, limit: 100 })
    expect(published).toHaveLength(100)
    expect(published.every((row) => row.localePublicationStates.fr === "published" && row.localePublicationStates.en === "published")).toBe(true)
    expect(await owner.query(api.cms.pages.listLinkablePages, { limit: 100 })).toHaveLength(100)
    expect(await owner.query(api.cms.pages.getLinkablePageSelection, { pageId })).toMatchObject({ status: "available", page: { localePublicationStates: { fr: "published", en: "published" } } })
  }, 120_000)

  test("catalogExclusionFixture withholds all selected metadata for a now-hidden type", async () => {
    const { owner } = await pickerSite()
    const pageId = await newPage(owner, "catalog-excluded")
    // Model a curated release hiding a previously stored type. Only the
    // catalog dependency changes; every stored row still came from UI writers.
    const index = CONTENT_TYPES.indexOf("landing-page")
    expect(index).toBeGreaterThanOrEqual(0)
    CONTENT_TYPES.splice(index, 1)
    try {
      expect(await owner.query(api.cms.pages.getLinkablePageSelection, { pageId })).toEqual({ status: "unavailable" })
      expect(await owner.query(api.cms.pages.listLinkablePages, { locale: "fr" })).toEqual([])
    } finally { CONTENT_TYPES.splice(index, 0, "landing-page") }
  })

  test("selected IDs resolve beyond both the 100-row and former 400-candidate windows", async () => {
    const { owner } = await pickerSite()
    let pageId!: Id<"pages">
    for (let i = 0; i < 401; i++) {
      pageId = await owner.mutation(api.cms.pages.create, {
        pageType: "landing-page",
        status: "draft",
        defaultLocale: "fr",
        slug: `window-${i}`,
        title: `Window ${i}`,
      })
    }
    expect(
      (
        await owner.query(api.cms.pages.listLinkablePages, {
          locale: "fr",
          limit: 100,
        })
      ).some((r) => r._id === pageId)
    ).toBe(false)
    expect(
      await owner.query(api.cms.pages.getLinkablePageSelection, { pageId })
    ).toMatchObject({
      status: "available",
      page: { localizedTitles: { fr: "Window 400" } },
    })
  }, 120_000)

  test("both endpoints reject invalid authority and selection never falls back to legacy content", async () => {
    const { owner, t } = await pickerSite()
    const pageId = await newPage(owner, "missing-state")
    // Fault injection only deletes authority metadata, never content/drafts/snapshots.
    await t.run(async (ctx) => {
      const state = await ctx.db
        .query("pagePublicationPageStates")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique()
      await ctx.db.delete("pagePublicationPageStates", state!._id)
    })
    expect(
      await owner.query(api.cms.pages.getLinkablePageSelection, { pageId })
    ).toEqual({ status: "unavailable" })
    await t.run(async (ctx) => {
      const authority = await ctx.db.query("pagePublicationCutover").unique()
      await ctx.db.delete("pagePublicationCutover", authority!._id)
    })
    for (const call of [
      () => owner.query(api.cms.pages.listLinkablePages, { locale: "fr" }),
      () => owner.query(api.cms.pages.getLinkablePageSelection, { pageId }),
    ])
      await expect(call()).rejects.toThrow(/PUBLISHED_SNAPSHOT_CUTOVER_INVALID/)
  })

  test("legacyAuthorityFixture lists staged drafts without claiming staged translations are published", async () => {
    // The explicit-admin harness's named legacy authority fixture is necessary:
    // bootstrapInstallation deliberately always establishes snapshot authority.
    const t = pageTest(),
      owner = t.withIdentity(TEST_USER)
    const pageId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "published",
      slug: "legacy",
      defaultLocale: "fr",
      content: { fr: { title: "Publié FR", slices: [] } },
    })
    await owner.mutation(api.cms.pages.acquirePageEditorLock, {
      pageId,
      force: true,
    })
    await owner.mutation(api.cms.pages.updateDraft, {
      pageId,
      content: {
        fr: {
          pageType: "landing-page",
          localized: { title: "Brouillon FR" },
          slices: [],
        },
        en: {
          pageType: "landing-page",
          localized: { title: "English staged" },
          slices: [],
        },
      },
    })
    for (const locale of ["fr", "en"]) {
      const rows = await owner.query(api.cms.pages.listLinkablePages, {
        locale,
      })
      const selected = await owner.query(
        api.cms.pages.getLinkablePageSelection,
        { pageId }
      )
      expect(rows).toEqual([
        expect.objectContaining({
          _id: pageId,
          localizedTitles: { fr: "Brouillon FR", en: "English staged" },
          localePublicationStates: { fr: "published", en: "draft" },
        }),
      ])
      expect(selected).toEqual({ status: "available", page: rows[0] })
      expect(
        (
          await owner.query(api.cms.pages.listLinkablePages, {
            locale,
            includeDrafts: false,
          })
        ).length
      ).toBe(locale === "fr" ? 1 : 0)
    }
  })

  test.each(["existing-empty", "copy-empty", "missing", "cleared", "typed-cleared"] as const)(
    "decorative_alt_survives_secondary_save_and_copy through real saveCanonical: %s",
    async (mode) => {
      const { t, owner } = await pickerSite()
      const featured = (
        id: string
      ): Extract<
        Extract<NonNullable<NavItem["panel"]>, { columns: number }>["blocks"][number],
        { kind: "featured" }
      > => ({
        id,
        kind: "featured",
        heading: { fr: "Titre" },
        image: { url: "https://example.com/image.jpg", alt: { fr: "" } },
        target: { type: "external", url: "https://example.com/feature" },
      })
      const nav: NavItem[] = [
        {
          id: "features",
          label: { fr: "Images" },
          panel: {
            columns: 1,
            blocks: [featured("main")],
            footer: { blocks: [featured("footer")] },
          },
        },
      ]
      await owner.mutation(api.cms.menus.saveCanonical, {
        slug: "primary",
        locale: "fr",
        nav,
      })
      const translation = projectLocale(
        nav,
        mode === "existing-empty" || mode === "cleared" ? "fr" : "en",
        "fr"
      )
      translation[0]!.label = "Images EN"
      for (const block of [
        ...legacyPanel(translation[0]!.panel!).blocks,
        ...translation[0]!.panel!.footer!.blocks,
      ]) {
        block.heading = "Heading"
        if (mode === "cleared" && block.kind === "featured")
          block.image!.alt = "Authored"
        if (mode === "typed-cleared" && block.kind === "featured") {
          Object.assign(block, withAuthoredAlt(block, "Typed before first EN save"))
          Object.assign(block, withAuthoredAlt(block, ""))
        }
      }
      await owner.mutation(api.cms.menus.saveCanonical, {
        slug: "primary",
        locale: "en",
        nav: mergeLocale(nav, "en", translation),
      })
      const loaded = (await owner.query(api.cms.menus.getCanonical, {
        slug: "primary",
      }))!.nav
      const edited = projectLocale(
        loaded,
        mode === "copy-empty" ? "fr" : "en",
        "fr"
      )
      edited[0]!.label = "An unrelated EN edit"
      for (const block of [
        ...legacyPanel(edited[0]!.panel!).blocks,
        ...edited[0]!.panel!.footer!.blocks,
      ]) {
        if (mode === "cleared" && block.kind === "featured")
          block.image!.alt = ""
      }
      await owner.mutation(api.cms.menus.saveCanonical, {
        slug: "primary",
        locale: "en",
        nav: mergeLocale(loaded, "en", edited),
      })
      const reloaded = (await owner.query(api.cms.menus.getCanonical, {
        slug: "primary",
      }))!.nav
      await owner.mutation(api.cms.menus.saveCanonical, {
        slug: "primary",
        locale: "en",
        nav: mergeLocale(reloaded, "en", projectLocale(reloaded, "en", "fr")),
      })
      const persisted = (await owner.query(api.cms.menus.getCanonical, {
        slug: "primary",
      }))!.nav
      for (const block of [
        ...legacyPanel(persisted[0]!.panel!).blocks,
        ...persisted[0]!.panel!.footer!.blocks,
      ]) {
        if (block.kind !== "featured") throw new Error("Expected featured")
        expect(Object.hasOwn(block.image!.alt, "en")).toBe(mode !== "missing")
        expect(block.image!.alt.fr).toBe("")
        if (mode !== "missing") expect(block.image!.alt.en).toBe("")
      }
      const config = await owner.query(api.cms.settings.getSiteConfig, {})
      const result = await t.query(api.cms.menus.getWithResolvedLinks, {
        slug: "primary",
        locale: "en",
        languageVersion: config.languageVersion,
      })
      expect(legacyPanel(result?.nav[0]?.panel).blocks).toHaveLength(
        mode === "missing" ? 0 : 1
      )
      expect(result?.nav[0]?.panel?.footer?.blocks).toHaveLength(
        mode === "missing" ? 0 : 1
      )
    }
  )
  describe("relation pickers read titles and states from snapshots", () => {
    const renameFr = (
      owner: PickerSite["owner"],
      pageId: Id<"pages">,
      title: string,
      pageType: "landing-page" | "author" = "landing-page",
      expectedGeneration = 2
    ) =>
      owner.mutation(api.cms.publication.saveEditorDraft, {
        pageId,
        expectedLifecycleGeneration: 1,
        localized: {
          locale: "fr",
          slug: "renamed",
          expectedGeneration,
          draft: { pageType, localized: { title }, slices: [] },
        },
      })

    test("listRelationCandidates returns snapshot titles, states and honours includeDrafts, types, limit and permissions", async () => {
      const { t, owner } = await pickerSite()
      const draftOnly = await newPage(owner, "brouillon", false)
      const published = await newPage(owner, "cible")
      await publishFr(owner, published)

      const all = await owner.query(api.cms.pages.listRelationCandidates, {
        pageTypes: ["landing-page"],
        includeDrafts: true,
      })
      expect(all.find((row) => row._id === draftOnly)).toMatchObject({
        slug: "brouillon",
        localizedTitles: { fr: "Titre brouillon" },
        localePublicationStates: { fr: "draft" },
        status: "draft",
        pageType: "landing-page",
      })
      expect(all.find((row) => row._id === published)).toMatchObject({
        localizedTitles: { fr: "Titre cible", en: "English cible" },
        localePublicationStates: { fr: "published", en: "draft" },
        status: "published",
      })

      // Before the fix this was empty: it selected by the stale `pages.status`.
      const onlyPublished = await owner.query(
        api.cms.pages.listRelationCandidates,
        { pageTypes: ["landing-page"], includeDrafts: false }
      )
      expect(onlyPublished.map((row) => row._id)).toEqual([published])

      await renameFr(owner, draftOnly, "Titre renommé")
      const renamed = await owner.query(api.cms.pages.listRelationCandidates, {
        pageTypes: ["landing-page"],
        includeDrafts: true,
      })
      expect(renamed.find((row) => row._id === draftOnly)?.localizedTitles).toEqual({
        fr: "Titre renommé",
      })

      expect(
        await owner.query(api.cms.pages.listRelationCandidates, {
          pageTypes: ["page"],
          includeDrafts: true,
        })
      ).toEqual([])
      expect(
        await owner.query(api.cms.pages.listRelationCandidates, {
          pageTypes: ["landing-page"],
          includeDrafts: true,
          limit: 1,
        })
      ).toHaveLength(1)
      expect(
        await owner.query(api.cms.pages.listRelationCandidates, {
          pageTypes: ["landing-page"],
          includeDrafts: true,
          tag: "news",
        })
      ).toEqual([])
      await expect(
        t.withIdentity({ subject: "unrelated" }).query(
          api.cms.pages.listRelationCandidates,
          { pageTypes: ["landing-page"], includeDrafts: true }
        )
      ).rejects.toThrow(/CMS_OWNER_REQUIRED/)
    })

    test("listRelationCandidates leaves archived and trashed pages out", async () => {
      const { owner } = await pickerSite()
      const archived = await newPage(owner, "archive", false)
      const trashed = await newPage(owner, "corbeille", false)
      await owner.mutation(api.cms.publication.archivePage, {
        pageId: archived,
        expectedLifecycleGeneration: 1,
      })
      await owner.mutation(api.cms.publication.softDeletePage, {
        pageId: trashed,
        expectedLifecycleGeneration: 1,
      })
      const ids = (
        await owner.query(api.cms.pages.listRelationCandidates, {
          pageTypes: ["landing-page"],
          includeDrafts: true,
        })
      ).map((row) => row._id)
      expect(ids).not.toContain(archived)
      expect(ids).not.toContain(trashed)
    })

    test("searchTargets and getReferenceCard take title and state from the snapshot row", async () => {
      const { owner } = await pickerSite()
      const draftOnly = await newPage(owner, "brouillon", false)
      const published = await newPage(owner, "cible", false)
      await publishFr(owner, published)

      const found = await owner.query(api.cms.relations.searchTargets, {
        pageTypes: ["landing-page"],
        locale: "fr",
        search: "titre cible",
      })
      expect(found).toHaveLength(1)
      expect(found[0]).toMatchObject({ id: published, title: "Titre cible" })
      expect(found[0]!.href).toBeDefined()
      expect(found[0]!.titleFallback).toBeUndefined()

      const draftCard = await owner.query(api.cms.relations.getReferenceCard, {
        id: draftOnly,
        locale: "fr",
      })
      expect(draftCard).toMatchObject({ id: draftOnly, title: "Titre brouillon" })
      expect(draftCard?.href).toBeUndefined()

      await renameFr(owner, draftOnly, "Titre renommé")
      expect(
        (
          await owner.query(api.cms.relations.searchTargets, {
            pageTypes: ["landing-page"],
            locale: "fr",
            search: "renommé",
          })
        ).map((card) => card.id)
      ).toEqual([draftOnly])
      expect(
        (
          await owner.query(api.cms.relations.searchTargets, {
            pageTypes: ["landing-page"],
            locale: "fr",
            search: "brouillon",
          })
        ).length
      ).toBe(0)
      // A language without text shows the translatable fallback, not a stale title.
      expect(
        await owner.query(api.cms.relations.getReferenceCard, {
          id: draftOnly,
          locale: "en",
        })
      ).toMatchObject({ titleFallback: "untitled" })
    })

    test("an author card shows the current name after a rename", async () => {
      const { owner } = await pickerSite()
      const authorId = await owner.mutation(api.cms.pages.create, {
        pageType: "author",
        status: "draft",
        defaultLocale: "fr",
        slug: "ada",
        title: "Ada",
      })
      await renameFr(owner, authorId, "Ada Lovelace", "author", 1)
      expect(
        await owner.query(api.cms.relations.getReferenceCard, {
          id: authorId,
          locale: "fr",
        })
      ).toMatchObject({ id: authorId, type: "author", title: "Ada Lovelace" })
      expect(
        (
          await owner.query(api.cms.relations.searchTargets, {
            pageTypes: ["author"],
            locale: "fr",
            search: "lovelace",
          })
        ).map((card) => card.title)
      ).toEqual(["Ada Lovelace"])
    })

    test("100 two-locale candidates fit the picker query budget", async () => {
      const { owner } = await pickerSite()
      for (let i = 0; i < 100; i++) await newPage(owner, `budget-${i}`)
      const rows = await owner.query(api.cms.pages.listRelationCandidates, {
        pageTypes: ["landing-page"],
        includeDrafts: true,
        limit: 100,
      })
      expect(rows).toHaveLength(100)
      expect(rows.every((row) => row.localizedTitles.fr && row.localizedTitles.en)).toBe(true)
    }, 120_000)
  })
})
