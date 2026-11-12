/// <reference types="vite/client" />

import { describe, expect, test } from "vitest"
import { api } from "./_generated/api"
import { convexTest } from "../convexTestWithExplicitAdmin"
import schema from "./schema"
import { slugify } from "../components/admin/page-editor/lib/content"

// Under snapshot authority the retained Page `slug`/`localizedSlugs` are
// legacy-only (F08 contract § Shared Draft). Route uniqueness is the
// `(locale, path)` claim allocated for saved drafts and checked at Publish.
// Never consult legacy slugs through the unbounded whole-table scan.

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "f08a-slug-uniqueness-owner",
  tokenIdentifier: "https://convex.test|f08a-slug-uniqueness-owner",
}

async function activeApp() {
  const t = convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
    publicationAuthority: "missing",
  })
  const owner = t.withIdentity(OWNER)
  await owner.mutation(api.cms.publication.initializeEmptySnapshotAuthority, {})
  const homePageId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "home",
    title: "Home",
    content: { en: { title: "Home", slices: [] } },
  })
  await t.run((ctx) =>
    ctx.db.insert("siteSettings", {
      siteName: "Slug uniqueness",
      siteUrl: "",
      defaultLocale: "en",
      enabledLocales: ["en"],
      homePageId,
      updatedAt: Date.now(),
    })
  )
  return { t, owner }
}

const createCafe = (owner: Awaited<ReturnType<typeof activeApp>>["owner"]) =>
  owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "cafe",
    title: "Café",
    content: { en: { title: "Café", slices: [] } },
  })

const firstPublish = (pageId: Awaited<ReturnType<typeof createCafe>>) => ({
  pageId,
  locale: "en",
  expectedDraftGeneration: 1,
  expectedSharedDraftGeneration: 1,
  expectedPublicGeneration: 0,
  expectedLifecycleGeneration: 1,
  expectedReleaseGeneration: 0,
})

describe("snapshot-active slug uniqueness", () => {
  test("creation numbers a held address; a typed duplicate is refused", async () => {
    const { owner } = await activeApp()
    const first = await createCafe(owner)
    // A legacy-slug match no longer blocks a private successor draft.
    const second = await createCafe(owner)
    expect(second).not.toBe(first)

    await owner.mutation(api.cms.publication.publishLocale, firstPublish(first))
    const created = await owner.query(api.cms.pages.getForEdit, { id: second })
    expect(created?.page.slug).toBe("cafe-2")
    await expect(
      owner.mutation(api.cms.publication.saveEditorDraft, {
        pageId: second,
        expectedLifecycleGeneration: 1,
        localized: {
          locale: "en",
          slug: "cafe",
          expectedGeneration: 1,
          draft: {
            pageType: "landing-page",
            localized: { title: "Café" },
            slices: [],
          },
        },
      })
    ).rejects.toThrow("PAGE_ADDRESS_TAKEN")
    await owner.mutation(
      api.cms.publication.publishLocale,
      firstPublish(second)
    )
  })

  test("legacy slug availability fails closed after authentication", async () => {
    const { t, owner } = await activeApp()
    await createCafe(owner)
    await expect(
      t.query(api.cms.pages.isSlugAvailable, { slug: "cafe" })
    ).rejects.toThrow("UNAUTHENTICATED")
    await expect(
      owner.query(api.cms.pages.isSlugAvailable, { slug: "cafe" })
    ).rejects.toThrow("PUBLISHED_SNAPSHOT_USE_PUBLISH_LOCALE")
  })
})

describe("CVX-REPRO-1 historical reservation", () => {
  test.each(["arrival", "departure"] as const)(
    "F04 refuses pre-existing duplicate claims on %s without backfill",
    async (direction) => {
      const { t, owner } = await activeApp()
      const pageId = await createCafe(owner)
      await owner.mutation(
        api.cms.publication.publishLocale,
        firstPublish(pageId)
      )
      async function stageAndPublish(slug: string) {
        const state = (await t.run((ctx) =>
          ctx.db
            .query("pageLocalePublicationStates")
            .withIndex("by_pageId_and_locale", (q) =>
              q.eq("pageId", pageId).eq("locale", "en")
            )
            .unique()
        ))!
        const saved = await owner.mutation(
          api.cms.publication.saveEditorDraft,
          {
            pageId,
            expectedLifecycleGeneration: 1,
            localized: {
              locale: "en",
              slug,
              expectedGeneration: state.draftGeneration,
              draft: {
                pageType: "landing-page",
                localized: { title: "Café" },
                slices: [],
              },
            },
          }
        )
        return owner.mutation(api.cms.publication.publishLocale, {
          ...firstPublish(pageId),
          expectedDraftGeneration: saved.draftGeneration!,
          expectedPublicGeneration: state.publicGeneration,
          expectedReleaseGeneration: state.releaseGeneration,
        })
      }
      await stageAndPublish("b")
      if (direction === "departure") await stageAndPublish("cafe")
      await t.run(async (ctx) => {
        const claim = (await ctx.db
          .query("pageHistoricalLocaleRoutes")
          .withIndex("by_locale_and_fromPath", (q) =>
            q.eq("locale", "en").eq("fromPath", "/cafe")
          )
          .unique())!
        await ctx.db.insert("pageHistoricalLocaleRoutes", {
          pageId: claim.pageId,
          locale: claim.locale,
          fromPath: claim.fromPath,
          createdFromSnapshotId: claim.createdFromSnapshotId,
          createdAt: claim.createdAt,
        })
      })
      const history = await t.run((ctx) =>
        ctx.db.query("pageHistoricalLocaleRoutes").collect()
      )
      const states = await t.run((ctx) =>
        ctx.db.query("pageLocalePublicationStates").collect()
      )
      const snapshots = await t.run((ctx) =>
        ctx.db.query("pagePublishedSnapshots").collect()
      )
      await expect(
        stageAndPublish(direction === "arrival" ? "cafe" : "c")
      ).rejects.toThrow("PUBLISHED_LOCALE_ROUTE_RESERVED")
      expect(
        await t.run((ctx) =>
          ctx.db.query("pageHistoricalLocaleRoutes").collect()
        )
      ).toEqual(history)
      expect(
        await t.run((ctx) => ctx.db.query("pagePublishedSnapshots").collect())
      ).toEqual(snapshots)
      expect(
        (
          await t.run((ctx) =>
            ctx.db.query("pageLocalePublicationStates").collect()
          )
        ).map((row) => [
          row._id,
          row.currentSnapshotId,
          row.publicGeneration,
          row.releaseGeneration,
        ])
      ).toEqual(
        states.map((row) => [
          row._id,
          row.currentSnapshotId,
          row.publicGeneration,
          row.releaseGeneration,
        ])
      )
    }
  )

  test("F04 /a → /b → /a → /c keeps one claim and resolves to /c", async () => {
    const { t, owner } = await activeApp()
    const pageId = await createCafe(owner)
    async function select(slug: string) {
      const { state, shared } = await t.run(async (ctx) => ({
        state: (await ctx.db
          .query("pageLocalePublicationStates")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", pageId).eq("locale", "en")
          )
          .unique())!,
        shared: (await ctx.db
          .query("pageSharedDrafts")
          .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
          .unique())!,
      }))
      const saved = await owner.mutation(api.cms.publication.saveEditorDraft, {
        pageId,
        expectedLifecycleGeneration: 1,
        localized: {
          locale: "en",
          slug,
          expectedGeneration: state.draftGeneration,
          draft: {
            pageType: "landing-page",
            localized: { title: "Café" },
            slices: [],
          },
        },
      })
      return owner.mutation(api.cms.publication.publishLocale, {
        ...firstPublish(pageId),
        expectedDraftGeneration: saved.draftGeneration!,
        expectedSharedDraftGeneration: shared.generation,
        expectedPublicGeneration: state.publicGeneration,
        expectedReleaseGeneration: state.releaseGeneration,
      })
    }
    const first = await select("a")
    await select("b")
    await select("a")
    expect(
      await t.query(api.cms.pages.resolveHistoricalPublishedPath, {
        locale: "en",
        path: "/a",
        languageVersion: 0,
      })
    ).toMatchObject({ disposition: "current" })
    const original = await t.run((ctx) =>
      ctx.db
        .query("pageHistoricalLocaleRoutes")
        .withIndex("by_locale_and_fromPath", (q) =>
          q.eq("locale", "en").eq("fromPath", "/a")
        )
        .unique()
    )
    expect(original?.createdFromSnapshotId).toBe(first.snapshotId)
    await select("c")
    const history = await t.run((ctx) =>
      ctx.db
        .query("pageHistoricalLocaleRoutes")
        .withIndex("by_locale_and_fromPath", (q) =>
          q.eq("locale", "en").eq("fromPath", "/a")
        )
        .collect()
    )
    expect(history).toEqual([original])
    expect(
      await t.query(api.cms.pages.resolveHistoricalPublishedPath, {
        locale: "en",
        path: "/a",
        languageVersion: 0,
      })
    ).toMatchObject({
      disposition: "historical_redirect",
      destinationPath: "/c",
    })
    const other = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "a",
      title: "Other",
      content: { en: { title: "Other", slices: [] } },
    })
    expect(
      (await owner.query(api.cms.pages.getForEdit, { id: other }))?.page.slug
    ).toBe("a-2")
    await owner.mutation(api.cms.publication.publishLocale, firstPublish(other))
  })
})

describe("ED3 server/editor slug parity (literal addresses)", () => {
  test.each([
    ["L'été d’Ada", "lete-dada"],
    ["Café", "cafe"],
    ["Cafe\u0301", "cafe"],
    ["İstanbul", "istanbul"],
    ["one_two", "one-two"],
    ["東京", "page-06271ed0"],
    ["Иван", "page-114d4170"],
    [
      "Rénovation énergétique d’une maison ancienne à Lyon : isolation, chauffage, ventilation et aides financières en 2026-2027",
      "renovation-energetique-dune-maison-ancienne-a-lyon-isolation-chauffage-ventilation-et-aides-financieres-en-2026-2027",
    ],
  ])(
    "creates the same new address as the editor: %s",
    async (title, expected) => {
      const { t, owner } = await activeApp()
      const id = await owner.mutation(api.cms.pages.create, {
        pageType: "landing-page",
        status: "draft",
        title,
        content: { en: { title, slices: [] } },
      })
      expect((await t.run((ctx) => ctx.db.get("pages", id)))?.slug).toBe(
        expected
      )
      expect(slugify(title)).toBe(expected)
    }
  )
  test("blank remains blank and an explicit stored address is preserved", async () => {
    expect(slugify("   ")).toBe("")
    const { t, owner } = await activeApp()
    const id = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "one_two",
      slug: "kept",
      content: { en: { title: "one_two", slices: [] } },
    })
    expect((await t.run((ctx) => ctx.db.get("pages", id)))?.slug).toBe("kept")
  })
})
