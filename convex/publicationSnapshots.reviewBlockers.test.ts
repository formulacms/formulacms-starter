/// <reference types="vite/client" />

import { describe, expect, test } from "vitest"
import { api } from "./_generated/api"
import { convexTest } from "../convexTestWithExplicitAdmin"
import schema from "./schema"

// Focused proof for the six blockers in the Sol / High rejection of e181c632.
// Every case drives a registered command and asserts the failure path writes
// nothing; broad regression suites are not counted as this coverage.

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "f08a-review-blocker-owner",
  tokenIdentifier: "https://convex.test|f08a-review-blocker-owner",
}

type TestApp = ReturnType<typeof convexTest>

function app() {
  return convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
    publicationAuthority: "missing",
  })
}

const PUBLICATION_TABLES = [
  "pages",
  "siteSettings",
  "pagePublicationCutover",
  "pagePublicationPageStates",
  "pageSharedDrafts",
  "pageLocaleDrafts",
  "pageLocalePublicationStates",
  "pageLocalePublicationCandidates",
  "pageLocalePublicationReleases",
  "pagePublishedSnapshots",
  "pagePublicationDocumentReferences",
  "pagePublicationMediaReferences",
  "pagePublicationSliceReferences",
  "pageHistoricalLocaleRoutes",
  "pagePublicationRevalidationIntents",
  "pagePublicationMigrationPages",
] as const

/** Byte-for-byte dump of every publication family, for rollback assertions. */
function dumpPublicationState(t: TestApp) {
  return t.run(async (ctx) => {
    const dump: Record<string, unknown[]> = {}
    for (const table of PUBLICATION_TABLES)
      dump[table] = await ctx.db.query(table).collect()
    return dump
  })
}

async function activeFixture() {
  const t = app()
  const owner = t.withIdentity(OWNER)
  await owner.mutation(api.cms.publication.initializeEmptySnapshotAuthority, {})
  const homeId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "home",
    title: "Home",
    content: { en: { title: "Home", slices: [] } },
  })
  const pageId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "cafe",
    title: "Café",
    content: {
      en: { title: "Café", slices: [] },
      fr: { title: "Café français", slices: [] },
    },
  })
  await t.run(async (ctx) => {
    await ctx.db.insert("siteSettings", {
      siteName: "Blockers",
      siteUrl: "",
      defaultLocale: "en",
      enabledLocales: ["en", "fr"],
      homePageId: homeId,
      updatedAt: Date.now(),
    })
  })
  return { t, owner, pageId }
}

/** Two published legacy Pages, both prepared under one migration run. */

describe("F08a review blockers on e181c632", () => {
  test("bootstrap rejects an existing active epoch that already holds a Page", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await owner.mutation(
      api.cms.publication.initializeEmptySnapshotAuthority,
      {}
    )
    await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "early",
      title: "Early",
      content: { en: { title: "Early", slices: [] } },
    })
    const before = await dumpPublicationState(t)
    await expect(
      owner.mutation(api.cms.settings.bootstrapInstallation, {
        siteName: "Late bootstrap",
        timezone: "UTC",
        defaultLocale: "en",
      })
    ).rejects.toThrow("PUBLISHED_SNAPSHOT_CUTOVER_REQUIRES_MIGRATION")
    expect(await dumpPublicationState(t)).toEqual(before)

    // A non-zero epoch is never treated as the empty install either.
    const counted = app()
    const countedOwner = counted.withIdentity(OWNER)
    await countedOwner.mutation(
      api.cms.publication.initializeEmptySnapshotAuthority,
      {}
    )
    await counted.run(async (ctx) => {
      const cutover = await ctx.db.query("pagePublicationCutover").unique()
      if (!cutover) throw new Error("cutover missing")
      await ctx.db.patch(cutover._id, { preparedPageCount: 1 })
    })
    const countedBefore = await dumpPublicationState(counted)
    await expect(
      countedOwner.mutation(api.cms.settings.bootstrapInstallation, {
        siteName: "Counted",
        timezone: "UTC",
        defaultLocale: "en",
      })
    ).rejects.toThrow("PUBLISHED_SNAPSHOT_CUTOVER_NOT_EMPTY_INSTALL")
    expect(await dumpPublicationState(counted)).toEqual(countedBefore)
  })

  test("a cleared parent stays cleared on editor reload despite the legacy row", async () => {
    const { t, owner, pageId } = await activeFixture()
    const parentId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "parent",
      title: "Parent",
      content: { en: { title: "Parent", slices: [] } },
    })
    // The retained legacy row still carries a hierarchy value.
    await t.run((ctx) => ctx.db.patch(pageId, { parentId }))
    await owner.mutation(api.cms.publication.saveEditorDraft, {
      pageId,
      expectedLifecycleGeneration: 1,
      shared: { expectedGeneration: 1, parentId },
    })
    expect(
      (await owner.query(api.cms.pages.getForEdit, { id: pageId }))?.page
    ).toMatchObject({ parentId })

    await owner.mutation(api.cms.publication.saveEditorDraft, {
      pageId,
      expectedLifecycleGeneration: 1,
      shared: { expectedGeneration: 2, clearParent: true },
    })
    const reloaded = await owner.query(api.cms.pages.getForEdit, {
      id: pageId,
    })
    expect(reloaded?.publication?.sharedDraftGeneration).toBe(3)
    expect(reloaded?.page).not.toHaveProperty("parentId")
    expect(reloaded?.page).toMatchObject({ _id: pageId, slug: "cafe" })
  })

  test("soft-delete authenticates first and never re-trashes a trashed Page", async () => {
    const { t, owner, pageId } = await activeFixture()
    // A Page with no successor state distinguishes auth-first from read-first.
    const bareId = await t.run((ctx) =>
      ctx.db.insert("pages", {
        slug: "bare",
        pageType: "landing-page",
        status: "draft",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        content: {},
      })
    )
    await expect(
      t.mutation(api.cms.publication.softDeletePage, {
        pageId: bareId,
        expectedLifecycleGeneration: 1,
      })
    ).rejects.toThrow("UNAUTHENTICATED")

    await owner.mutation(api.cms.publication.archivePage, {
      pageId,
      expectedLifecycleGeneration: 1,
    })
    await owner.mutation(api.cms.publication.softDeletePage, {
      pageId,
      expectedLifecycleGeneration: 2,
    })
    const before = await dumpPublicationState(t)
    await expect(
      owner.mutation(api.cms.publication.softDeletePage, {
        pageId,
        expectedLifecycleGeneration: 3,
      })
    ).rejects.toThrow("PAGE_PUBLICATION_LIFECYCLE_STALE")
    expect(await dumpPublicationState(t)).toEqual(before)
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("pagePublicationPageStates")
          .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
          .unique()
      )
    ).toMatchObject({
      lifecycleState: "trashed",
      restoreLifecycleState: "archived",
      lifecycleGeneration: 3,
    })
  })

  test("the editor read rejects a locale-state fan-out above the reviewed ceiling", async () => {
    const { t, owner, pageId } = await activeFixture()
    await t.run(async (ctx) => {
      const now = Date.now()
      for (let index = 0; index < 511; index += 1) {
        await ctx.db.insert("pageLocalePublicationStates", {
          pageId,
          locale: `x-${index}`,
          draftGeneration: 0,
          publicGeneration: 0,
          releaseGeneration: 0,
          hasCurrentSnapshot: false,
          updatedAt: now,
        })
      }
    })
    await expect(
      owner.query(api.cms.pages.getForEdit, { id: pageId })
    ).rejects.toThrow("PUBLICATION_LOCALE_LIMIT")
  })

  test("releases require executeAt and open releases are found through the status index", async () => {
    const { t, owner, pageId } = await activeFixture()
    const published = await owner.mutation(api.cms.publication.publishLocale, {
      pageId,
      locale: "en",
      expectedDraftGeneration: 1,
      expectedSharedDraftGeneration: 1,
      expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1,
      expectedReleaseGeneration: 0,
    })
    const release = await t.run((ctx) =>
      ctx.db
        .query("pageLocalePublicationReleases")
        .withIndex("by_candidateId", (q) =>
          q.eq("candidateId", published.candidateId)
        )
        .unique()
    )
    expect(release?.executeAt).toBe(release?.createdAt)

    const insertRelease = (
      status: "cancelled" | "held" | "pending",
      generation: number
    ) =>
      t.run((ctx) => {
        const now = Date.now()
        return ctx.db.insert("pageLocalePublicationReleases", {
          pageId,
          locale: "fr",
          candidateId: published.candidateId,
          generation,
          expectedPublicGeneration: 0,
          expectedLifecycleGeneration: 1,
          executeAt: now,
          status,
          attribution: { kind: "migration", migrationRunId: "fixture" },
          createdAt: now,
          updatedAt: now,
        })
      })
    await expect(
      t.run((ctx) =>
        ctx.db.insert("pageLocalePublicationReleases", {
          pageId,
          locale: "fr",
          candidateId: published.candidateId,
          generation: 9,
          expectedPublicGeneration: 0,
          expectedLifecycleGeneration: 1,
          status: "cancelled",
          attribution: { kind: "migration", migrationRunId: "fixture" },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } as never)
      )
    ).rejects.toThrow()

    // Two older historical rows precede the held release; a two-row scan of
    // the Page+locale history would miss it.
    await insertRelease("cancelled", 1)
    await insertRelease("cancelled", 2)
    const heldId = await insertRelease("held", 3)
    const deleteFr = {
      pageId,
      locale: "fr",
      expectedDraftGeneration: 1,
      expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1,
    }
    const before = await dumpPublicationState(t)
    await expect(
      owner.mutation(api.cms.publication.deleteLocaleContent, deleteFr)
    ).rejects.toThrow("LOCALE_HAS_PENDING_RELEASE")
    expect(await dumpPublicationState(t)).toEqual(before)

    await t.run((ctx) => ctx.db.patch(heldId, { status: "cancelled" }))
    expect(
      await owner.mutation(api.cms.publication.deleteLocaleContent, deleteFr)
    ).toMatchObject({ pageId, locale: "fr", generation: 2 })

    const pendingId = await insertRelease("pending", 4)
    await owner.mutation(api.cms.publication.softDeletePage, {
      pageId,
      expectedLifecycleGeneration: 1,
    })
    expect(await t.run((ctx) => ctx.db.get(pendingId))).toMatchObject({
      status: "cancelled",
      cancelReason: "PAGE_SOFT_DELETED",
    })
  })
})
