/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { ConvexError, type Value } from "convex/values"
import { api } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { convexTest } from "../convexTestWithExplicitAdmin"
import schema from "./schema"

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "b2b1-owner",
  tokenIdentifier: "b2b1-owner",
}

type Owner = ReturnType<ReturnType<typeof convexTest>["withIdentity"]>

async function fixture() {
  const t = convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
    publicationAuthority: "missing",
  })
  const owner = t.withIdentity(OWNER)
  await owner.mutation(api.cms.publication.initializeEmptySnapshotAuthority, {})
  const homeId = await createPage(owner, "home", ["en", "fr"])
  await t.run((ctx) =>
    ctx.db.insert("siteSettings", {
      siteName: "B2b-1",
      siteUrl: "",
      defaultLocale: "en",
      enabledLocales: ["en", "fr"],
      homePageId: homeId,
      updatedAt: Date.now(),
    })
  )
  return { t, owner, homeId }
}

function createPage(owner: Owner, slug: string, locales: string[]) {
  return owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug,
    title: `T ${slug}`,
    content: Object.fromEntries(
      locales.map((l) => [l, { title: `${l} ${slug}`, blocks: [] }])
    ),
  })
}

function publish(owner: Owner, pageId: Id<"pages">, locale: string) {
  return owner.mutation(api.cms.publication.publishLocale, {
    pageId,
    locale,
    expectedDraftGeneration: 1,
    expectedSharedDraftGeneration: 1,
    expectedPublicGeneration: 0,
    expectedLifecycleGeneration: 1,
    expectedReleaseGeneration: 0,
  })
}

async function row(owner: Owner, pageId: Id<"pages">, scope = "content") {
  const res = await owner.query(api.cms.publication.listAdminPages, {
    paginationOpts: { numItems: 50, cursor: null },
    scope: scope as "content",
  })
  const found = res.page.find((r) => r._id === pageId)
  if (!found) throw new Error("row missing")
  return found
}

const byLocale = <T extends { locale: string }>(rows: T[], locale: string) =>
  rows.find((r) => r.locale === locale)

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ConvexError)
    return (error as ConvexError<Value>).data
  }
  throw new Error("Expected rejection")
}

describe("per-language page states", () => {
  test("draft locales carry state, title, slug and a prospective path; the home page is /", async () => {
    const { owner, homeId } = await fixture()
    const pageId = await createPage(owner, "about", ["en", "fr"])
    const r = await row(owner, pageId)
    expect(r.sharedDraftGeneration).toBe(1)
    expect(byLocale(r.locales, "en")).toMatchObject({
      state: "draft",
      title: "en about",
      slug: "about",
      path: "/about",
      draftGeneration: 1,
      publicGeneration: 0,
    })
    expect(byLocale(r.locales, "en")?.currentSnapshotId).toBeUndefined()
    expect(byLocale(r.locales, "fr")?.state).toBe("draft")
    const home = await row(owner, homeId)
    expect(byLocale(home.locales, "en")).toMatchObject({
      state: "draft",
      path: "/",
    })
  })

  test("published keeps its state with unpublished edits and uses the stored current path", async () => {
    const { owner } = await fixture()
    const pageId = await createPage(owner, "about", ["en", "fr"])
    const published = await publish(owner, pageId, "en")
    const r = await row(owner, pageId)
    expect(byLocale(r.locales, "en")).toMatchObject({
      state: "published",
      path: "/about",
      publicGeneration: 1,
      currentSnapshotId: published.snapshotId,
    })
    expect(byLocale(r.locales, "fr")).toMatchObject({
      state: "draft",
      path: "/about",
    })
    expect(r.status).toBe("published")
  })

  test("withdrawn locale is a draft again even without a draft row", async () => {
    const { t, owner } = await fixture()
    const pageId = await createPage(owner, "about", ["en", "fr"])
    const published = await publish(owner, pageId, "en")
    await owner.mutation(api.cms.publication.withdrawLocale, {
      pageId,
      locale: "en",
      expectedSnapshotId: published.snapshotId,
      expectedPublicGeneration: 1,
      expectedLifecycleGeneration: 1,
    })
    const drafts = await t.run((ctx) =>
      ctx.db
        .query("pageLocaleDrafts")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", "en")
        )
        .collect()
    )
    // Force the "no working draft row" shape: only the draft base remains.
    await t.run(async (ctx) => {
      for (const d of drafts) await ctx.db.delete("pageLocaleDrafts", d._id)
    })
    const r = await row(owner, pageId)
    expect(byLocale(r.locales, "en")).toMatchObject({
      state: "draft",
      slug: "about",
      path: "/about",
    })
    expect(byLocale(r.locales, "en")?.currentSnapshotId).toBeUndefined()
  })

  test("a locale without content is not translated, has no path, and never borrows another language's address", async () => {
    const { owner } = await fixture()
    const pageId = await createPage(owner, "about", ["en", "fr"])
    await owner.mutation(api.cms.publication.deleteLocaleContent, {
      pageId,
      locale: "fr",
      expectedDraftGeneration: 1,
      expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1,
    })
    const fr = byLocale((await row(owner, pageId)).locales, "fr")
    expect(fr?.state).toBe("not_translated")
    expect(fr?.path).toBeUndefined()
    expect(fr?.slug).toBeUndefined()
    expect(fr?.title).toBeUndefined()
    expect(byLocale((await row(owner, pageId)).locales, "en")?.state).toBe(
      "draft"
    )
  })

  test("a child draft path uses the parent's published path in the same language only", async () => {
    const { t, owner } = await fixture()
    const parentId = await createPage(owner, "parent", ["en", "fr"])
    const childId = await createPage(owner, "child", ["en", "fr"])
    await t.run(async (ctx) => {
      const shared = await ctx.db
        .query("pageSharedDrafts")
        .withIndex("by_pageId", (q) => q.eq("pageId", childId))
        .unique()
      await ctx.db.patch("pageSharedDrafts", shared!._id, { system: { parentId } })
    })
    await publish(owner, parentId, "en")
    const locales = (await row(owner, childId)).locales
    expect(byLocale(locales, "en")).toMatchObject({
      state: "draft",
      path: "/parent/child",
    })
    // Parent is not published in fr: path is not knowable, not a fallback.
    expect(byLocale(locales, "fr")?.state).toBe("draft")
    expect(byLocale(locales, "fr")?.path).toBeUndefined()
  })

  test("a child draft has no address while its parent is archived", async () => {
    const { t, owner } = await fixture()
    const parentId = await createPage(owner, "parent", ["en"])
    const childId = await createPage(owner, "child", ["en"])
    await t.run(async (ctx) => {
      const shared = await ctx.db
        .query("pageSharedDrafts")
        .withIndex("by_pageId", (q) => q.eq("pageId", childId))
        .unique()
      await ctx.db.patch("pageSharedDrafts", shared!._id, { system: { parentId } })
    })
    await publish(owner, parentId, "en")
    expect(byLocale((await row(owner, childId)).locales, "en")?.path).toBe(
      "/parent/child"
    )
    await owner.mutation(api.cms.publication.archivePage, {
      pageId: parentId,
      expectedLifecycleGeneration: 1,
    })
    // publishLocale refuses under a non-active parent, so no address is shown.
    expect(
      byLocale((await row(owner, childId)).locales, "en")?.path
    ).toBeUndefined()
  })

  test("the editor and the list project identical locale entries, archived pages included", async () => {
    const { owner } = await fixture()
    const pageId = await createPage(owner, "about", ["en", "fr"])
    await publish(owner, pageId, "en")
    const listed = await row(owner, pageId)
    const edit = await owner.query(api.cms.pages.getForEdit, { id: pageId })
    expect(edit?.publication?.locales).toEqual(listed.locales)
    expect(edit?.publication?.sharedDraftGeneration).toBe(
      listed.sharedDraftGeneration
    )
    const archived = await owner.mutation(api.cms.publication.archivePage, {
      pageId,
      expectedLifecycleGeneration: 1,
    })
    expect(archived.lifecycleGeneration).toBe(2)
    const inArchive = await row(owner, pageId, "archive")
    expect(inArchive.status).toBe("archived")
    expect(byLocale(inArchive.locales, "en")?.state).toBe("published")
    const edit2 = await owner.query(api.cms.pages.getForEdit, { id: pageId })
    expect(edit2?.publication?.locales).toEqual(inArchive.locales)
  })

  test("listSummaries still returns its existing shape", async () => {
    const { owner } = await fixture()
    const pageId = await createPage(owner, "about", ["en"])
    const rows = await owner.query(api.cms.pages.listSummaries, {})
    const found = rows.find((r) => r._id === pageId)
    expect(found).toMatchObject({ slug: "about", status: "draft" })
    expect(found).not.toHaveProperty("locales")
  })
})

describe("safe recovery", () => {
  test("recovery leaves an already-draft language's public generation unchanged", async () => {
    const { t, owner } = await fixture()
    const pageId = await createPage(owner, "about", ["en", "fr"])
    await publish(owner, pageId, "en")
    await owner.mutation(api.cms.publication.archivePage, { pageId, expectedLifecycleGeneration: 1 })
    await owner.mutation(api.cms.publication.restorePage, { pageId, expectedLifecycleGeneration: 2 })
    expect(byLocale((await row(owner, pageId)).locales, "fr")?.publicGeneration).toBe(0)
    const intents = await t.run((ctx) => ctx.db.query("pagePublicationRevalidationIntents")
      .withIndex("by_pageId_and_locale", (q) => q.eq("pageId", pageId).eq("locale", "fr")).collect())
    expect(intents.find((intent) => intent.operationKind === "restore")).toMatchObject({
      oldPublicGeneration: 0, newPublicGeneration: 0,
    })
  })

  test.each(["unarchive", "trash", "archived-trash"] as const)(
    "%s returns every selected language as a draft with one withdrawal generation",
    async (operation) => {
      const { t, owner } = await fixture()
      const pageId = await createPage(owner, "about", ["en", "fr"])
      await publish(owner, pageId, "en")
      await publish(owner, pageId, "fr")
      const readStates = () => t.run((ctx) => ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId)).collect())
      const before = await readStates()
      let generation = 1
      if (operation !== "trash") {
        await owner.mutation(api.cms.publication.archivePage, {
          pageId, expectedLifecycleGeneration: generation++,
        })
      }
      if (operation !== "unarchive") {
        await owner.mutation(api.cms.publication.softDeletePage, {
          pageId, expectedLifecycleGeneration: generation++,
        })
        // An already-trashed page may still store the previous archived target.
        if (operation === "archived-trash") await t.run(async (ctx) => {
          const state = await ctx.db.query("pagePublicationPageStates")
            .withIndex("by_pageId", (q) => q.eq("pageId", pageId)).unique()
          await ctx.db.patch("pagePublicationPageStates", state!._id, {
            restoreLifecycleState: "archived",
          })
        })
      }
      // A persisted menu link may outlive lifecycle changes; it must fail closed.
      await t.run((ctx) => ctx.db.insert("menus", {
        slug: "primary", updatedAt: Date.now(),
        nav: [{ id: "about", label: { en: "About", fr: "À propos" },
          target: { type: "internal", pageId } }],
      }))
      await owner.mutation(operation === "unarchive"
        ? api.cms.publication.restorePage : api.cms.publication.restoreSoftDeletedPage, {
        pageId, expectedLifecycleGeneration: generation,
      })
      const after = await readStates()
      for (const old of before) {
        const current = after.find((entry) => entry.locale === old.locale)!
        expect(current).toMatchObject({
          hasCurrentSnapshot: false, publicGeneration: old.publicGeneration + 1,
          draftGeneration: old.draftGeneration, draftBaseSnapshotId: old.draftBaseSnapshotId,
        })
        for (const key of ["currentSnapshotId", "currentReleaseId", "currentPath",
          "currentPublishedAt", "pageType", "publicSince"] as const)
          expect(current[key]).toBeUndefined()
        expect(await t.query(api.cms.pages.getPublicPageById, {
          id: pageId, locale: old.locale, languageVersion: 0,
        })).toBeNull()
        const menu = await t.query(api.cms.menus.getWithResolvedLinks, {
          slug: "primary", locale: old.locale, languageVersion: 0,
        })
        expect(menu?.nav.flatMap((item) => item.target?.url ? [item.target.url] : []) ?? []).toEqual([])
        const edit = await owner.query(api.cms.pages.getForEdit, { id: pageId })
        expect(edit?.page.content?.[old.locale]).toMatchObject({ title: `${old.locale} about` })
        const intents = await t.run((ctx) => ctx.db.query("pagePublicationRevalidationIntents")
          .withIndex("by_pageId_and_locale", (q) => q.eq("pageId", pageId).eq("locale", old.locale)).collect())
        expect(intents.find((intent) => intent.operationKind ===
          (operation === "unarchive" ? "restore" : "restore_soft_deleted"))).toMatchObject({
          oldPublicGeneration: old.publicGeneration,
          newPublicGeneration: old.publicGeneration + 1,
          oldSnapshotId: old.currentSnapshotId, oldPath: old.currentPath,
        })
        const refs = await t.run(async (ctx) => ({
          documents: await ctx.db.query("pagePublicationDocumentReferences").collect(),
          media: await ctx.db.query("pagePublicationMediaReferences").collect(),
          blocks: await ctx.db.query("pagePublicationBlockReferences").collect(),
        }))
        for (const rows of Object.values(refs))
          expect(rows.filter((ref) => ref.pageId === pageId && ref.sourceKind === "current_public")).toEqual([])
      }
      expect((await row(owner, pageId)).status).toBe("draft")
      expect((await row(owner, pageId)).lifecycleState).toBe("active")
      for (const current of after) {
        await owner.mutation(api.cms.publication.publishLocale, {
          pageId, locale: current.locale,
          expectedDraftGeneration: current.draftGeneration,
          expectedSharedDraftGeneration: 1,
          expectedPublicGeneration: current.publicGeneration,
          expectedLifecycleGeneration: generation + 1,
          expectedReleaseGeneration: current.releaseGeneration,
        })
        expect(await t.query(api.cms.pages.getPublicPageById, {
          id: pageId, locale: current.locale, languageVersion: 0,
        })).not.toBeNull()
        const menu = await t.query(api.cms.menus.getWithResolvedLinks, {
          slug: "primary", locale: current.locale, languageVersion: 0,
        })
        expect(menu?.nav[0]?.target?.url).toBeTruthy()
      }
    }
  )
})

describe("home page lifecycle guard", () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })
  async function snapshot(t: Awaited<ReturnType<typeof fixture>>["t"], id: Id<"pages">) {
    return t.run(async (ctx) => ({
      drafts: await ctx.db.query("pageLocaleDrafts").collect(),
      shared: await ctx.db.query("pageSharedDrafts").collect(),
      snapshots: await ctx.db.query("pagePublishedSnapshots").collect(),
      candidates: await ctx.db.query("pageLocalePublicationCandidates").collect(),
      references: await ctx.db.query("pagePublicationDocumentReferences").collect(),
      state: await ctx.db
        .query("pagePublicationPageStates")
        .withIndex("by_pageId", (q) => q.eq("pageId", id))
        .unique(),
      locales: await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId", (q) => q.eq("pageId", id))
        .collect(),
      intents: await ctx.db
        .query("pagePublicationRevalidationIntents")
        .withIndex("by_pageId_and_locale", (q) => q.eq("pageId", id))
        .collect(),
    }))
  }

  test("archive and soft-delete of the home page are refused with nothing written", async () => {
    const { t, owner, homeId } = await fixture()
    const before = await snapshot(t, homeId)
    for (const ref of [
      api.cms.publication.archivePage,
      api.cms.publication.softDeletePage,
    ]) {
      expect(
        await rejection(
          owner.mutation(ref, {
            pageId: homeId,
            expectedLifecycleGeneration: 1,
          })
        )
      ).toBe("PAGE_HOME_LIFECYCLE_REFUSED")
    }
    expect(await snapshot(t, homeId)).toEqual(before)
  })

  test("recovery returns even a previously trashed home with an archived target to active", async () => {
    const { t, owner, homeId } = await fixture()
    // Pre-existing data only: put the home page in other lifecycle states.
    const setState = (
      lifecycleState: "archived" | "trashed",
      restoreLifecycleState?: "active" | "archived"
    ) =>
      t.run(async (ctx) => {
        const s = await ctx.db
          .query("pagePublicationPageStates")
          .withIndex("by_pageId", (q) => q.eq("pageId", homeId))
          .unique()
        await ctx.db.patch("pagePublicationPageStates", s!._id, {
          lifecycleState,
          restoreLifecycleState,
        })
      })
    await setState("trashed", "archived")
    await expect(
      owner.mutation(api.cms.publication.restoreSoftDeletedPage, {
        pageId: homeId,
        expectedLifecycleGeneration: 1,
      })
    ).resolves.toEqual({ pageId: homeId, lifecycleGeneration: 2 })
    expect((await snapshot(t, homeId)).state?.lifecycleState).toBe("active")

    await setState("archived")
    await expect(
      owner.mutation(api.cms.publication.restorePage, {
        pageId: homeId,
        expectedLifecycleGeneration: 2,
      })
    ).resolves.toEqual({ pageId: homeId, lifecycleGeneration: 3 })
  })

  test.each(["en", "fr"])("home Unpublish in %s is refused before stale checks with nothing written", async (locale) => {
    const { t, owner, homeId } = await fixture()
    const published = await publish(owner, homeId, locale)
    const before = await snapshot(t, homeId)
    for (const generation of [1, 99]) {
      expect(await rejection(owner.mutation(api.cms.publication.withdrawLocale, {
        pageId: homeId,
        locale,
        expectedSnapshotId: published.snapshotId,
        expectedPublicGeneration: generation,
        expectedLifecycleGeneration: generation,
      }))).toBe("PAGE_HOME_LIFECYCLE_REFUSED")
      expect(await snapshot(t, homeId)).toEqual(before)
    }
  })

  test("a non-home Landing page can still be unpublished, archived and trashed", async () => {
    const { owner } = await fixture()
    const other = await createPage(owner, "other", ["en"])
    const published = await publish(owner, other, "en")
    await expect(owner.mutation(api.cms.publication.withdrawLocale, {
      pageId: other,
      locale: "en",
      expectedSnapshotId: published.snapshotId,
      expectedPublicGeneration: 1,
      expectedLifecycleGeneration: 1,
    })).resolves.toMatchObject({ pageId: other })
    const archived = await owner.mutation(api.cms.publication.archivePage, {
      pageId: other,
      expectedLifecycleGeneration: 1,
    })
    await expect(
      owner.mutation(api.cms.publication.softDeletePage, {
        pageId: other,
        expectedLifecycleGeneration: archived.lifecycleGeneration,
      })
    ).resolves.toMatchObject({ pageId: other })
  })
})
