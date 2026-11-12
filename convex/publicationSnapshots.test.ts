import { createSampleSlice } from "@/convex/lib/slices/sample"
/// <reference types="vite/client" />

import { sliceProfile } from "@/test-utils/slice-profile"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { readFileSync } from "node:fs"
import { api } from "./_generated/api"
import { convexTest } from "../convexTestWithExplicitAdmin"
import { enableRedirectsForTest } from "../redirectsTestHelpers"
import type { Id } from "./_generated/dataModel"
import schema from "./schema"

import { publishPreparedTargetLocale, withdrawPreparedTargetLocale } from "./cms/publication"
import {
  serializeLocalePublicationCandidate,
  digestLocalePublicationCandidate,
} from "./lib/publishing/localeCandidate"

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
const OWNER = {
  subject: "f08a-owner",
  tokenIdentifier: "https://convex.test|f08a-owner",
}

function app() {
  return convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
    publicationAuthority: "missing",
  })
}

function publishedTitle(
  page: { content: Record<string, unknown> } | null,
  locale: string
): string | undefined {
  const localized = page?.content[locale]
  if (!localized || typeof localized !== "object" || !("title" in localized)) {
    return undefined
  }
  const title = (localized as { title: unknown }).title
  return typeof title === "string" ? title : undefined
}

async function installSnapshotFixture(
  t: ReturnType<typeof convexTest>,
  owner: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>
) {
  await owner.mutation(api.cms.publication.initializeEmptySnapshotAuthority, {})
  const homePageId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "home",
    title: "Home",
    content: { en: { title: "Home", slices: [] } },
  })
  const pageId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "snapshot-page",
    title: "Legacy mutable title",
    content: {
      en: {
        title: "English v1",
        slices: [
          {
            id: "snapshot-hero",
            type: "hero-agency",
            enabled: true,
            primary: {
              eyebrow: "Snapshot",
              title: "English v1",
              description: canonicalBody("Immutable"),
            },
            items: [],
          },
        ],
      },
      fr: { title: "Français v1", slices: [] },
    },
  })
  await t.run(async (ctx) => {
    const now = Date.now()
    await ctx.db.insert("siteSettings", {
      siteName: "Snapshot test",
      siteUrl: "",
      defaultLocale: "en",
      enabledLocales: ["en", "fr"],
      homePageId,
      updatedAt: now,
    })
  })
  return pageId
}

async function publicationState(
  t: ReturnType<typeof convexTest>,
  pageId: Id<"pages">,
  locale: string
) {
  return t.run((ctx) =>
    ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", locale)
      )
      .unique()
  )
}

describe("F08a Published Snapshots", () => {
  test("publishes only the addressed locale and public reads ignore later mutable Page changes", sliceProfile(["hero-agency"]), async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const pageId = await installSnapshotFixture(t, owner)
    const beforeFr = await publicationState(t, pageId, "fr")

    const published = await owner.mutation(api.cms.publication.publishLocale, {
      pageId,
      locale: "en",
      expectedDraftGeneration: 1,
      expectedSharedDraftGeneration: 1,
      expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1,
      expectedReleaseGeneration: 0,
    })
    const afterFr = await publicationState(t, pageId, "fr")
    expect(afterFr).toEqual(beforeFr)

    const firstSnapshot = await t.run((ctx) => ctx.db.get(published.snapshotId))
    const firstCandidate = await t.run((ctx) =>
      ctx.db.get(published.candidateId)
    )
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("pagePublicationSliceReferences")
          .withIndex("by_sourceKind_and_sourceId", (q) =>
            q
              .eq("sourceKind", "candidate")
              .eq("sourceId", published.candidateId)
          )
          .collect()
      )
    ).toEqual([
      expect.objectContaining({
        pageId,
        locale: "en",
        sliceType: "hero-agency",
        count: 1,
      }),
    ])
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("pagePublicationSliceReferences")
          .withIndex("by_sourceKind_and_sourceId", (q) =>
            q
              .eq("sourceKind", "current_public")
              .eq("sourceId", published.snapshotId)
          )
          .collect()
      )
    ).toEqual([
      expect.objectContaining({
        pageId,
        locale: "en",
        sliceType: "hero-agency",
        count: 1,
      }),
    ])
    await t.run(async (ctx) => {
      const page = await ctx.db.get(pageId)
      if (!page) throw new Error("page fixture missing")
      await ctx.db.patch(pageId, {
        content: { en: { title: "MUTATED LEGACY PAGE", slices: [] } },
        slug: "mutated-legacy-slug",
      } as never)
      await ctx.db.insert("pageSearch", {
        pageId,
        locale: "en",
        status: "published",
        title: "MUTATED LEGACY PAGE",
        slug: "mutated-legacy-slug",
        text: "mutated legacy searchable leak",
        updatedAt: Date.now(),
      })
    })
    const publicPage = await t.query(api.cms.pages.getPublicPageById, {
      languageVersion: 0,
      id: pageId,
      locale: "en",
    })
    expect(publishedTitle(publicPage, "en")).toBe("English v1")
    expect(
      await t.query(api.cms.pages.resolveLocalizedPathQuery, {
        languageVersion: 0,
        path: "/snapshot-page",
        locale: "en",
      })
    ).toBe(pageId)
    // The public resolver exposes no draft-capable argument at all.
    await expect(
      t.query(api.cms.pages.resolveLocalizedPathQuery, {
        languageVersion: 0,
        path: "/mutated-legacy-slug",
        locale: "en",
        // @ts-expect-error — the public contract deliberately has no draft switch.
        includeDrafts: true,
      })
    ).rejects.toThrow()
    expect(
      await t.query(api.cms.pages.resolveLocalizedPathQuery, {
        languageVersion: 0,
        path: "/mutated-legacy-slug",
        locale: "en",
      })
    ).toBeNull()
    expect(
      await t.query(api.cms.pages.getLocalizedPathsByIds, {
        languageVersion: 0,
        ids: [pageId],
        locale: "en",
      })
    ).toEqual({ [pageId]: "/snapshot-page" })
    expect(
      await t.query(api.cms.pages.getPublicLocaleAlternates, {
        languageVersion: 0,
        pageId,
      })
    ).toEqual([{ locale: "en", url: "/snapshot-page", indexable: true }])
    expect(
      await t.query(api.cms.pages.getAllLocalizedPageUrls, {
        languageVersion: 0,
      })
    ).toEqual([{ pageId, locale: "en", url: "/snapshot-page" }])
    expect(
      await t.query(api.cms.pages.getPublicRelationCardsByIds, {
        languageVersion: 0,
        ids: [pageId],
        locale: "en",
      })
    ).toEqual({
      [pageId]: {
        pageId,
        pageType: "landing-page",
        title: "English v1",
        href: "/snapshot-page",
      },
    })
    expect(
      await t.query(api.cms.pages.getSitemapChild, {
        languageVersion: 0,
        manifestVersion: 0,
        locale: "en",
        ordinal: 0,
      })
    ).toMatchObject({
      status: "ok",
      entries: [expect.objectContaining({ url: "/snapshot-page" })],
    })
    expect(
      await t.query(api.cms.pages.getPublicPageById, {
        languageVersion: 0,
        id: pageId,
        locale: "fr",
      })
    ).toBeNull()
    expect(await t.run((ctx) => ctx.db.get(published.snapshotId))).toEqual(
      firstSnapshot
    )
    expect(await t.run((ctx) => ctx.db.get(published.candidateId))).toEqual(
      firstCandidate
    )
  })

  test("republish creates a new immutable generation, then withdrawal clears only that locale pointer", sliceProfile(["hero-agency"]), async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const pageId = await installSnapshotFixture(t, owner)
    const first = await owner.mutation(api.cms.publication.publishLocale, {
      pageId,
      locale: "en",
      expectedDraftGeneration: 1,
      expectedSharedDraftGeneration: 1,
      expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1,
      expectedReleaseGeneration: 0,
    })
    await t.run(async (ctx) => {
      const state = await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", "en")
        )
        .unique()
      const ownerRow = await ctx.db
        .query("cmsOwner")
        .withIndex("by_key", (q) => q.eq("key", "owner"))
        .unique()
      if (!state || !ownerRow) throw new Error("publication fixture missing")
      const now = Date.now()
      await ctx.db.insert("pageLocaleDrafts", {
        pageId,
        locale: "en",
        pageType: "landing-page",
        generation: 2,
        slug: "snapshot-page-v2",
        content: { title: "English v2", slices: [] },
        updatedBy: {
          kind: "owner",
          ownerId: ownerRow._id,
          authId: ownerRow.authId,
          tokenIdentifier: ownerRow.tokenIdentifier,
        },
        createdAt: now,
        updatedAt: now,
      })
      await ctx.db.patch(state._id, { draftGeneration: 2, updatedAt: now })
    })
    const second = await owner.mutation(api.cms.publication.publishLocale, {
      pageId,
      locale: "en",
      expectedDraftGeneration: 2,
      expectedSharedDraftGeneration: 1,
      expectedPublicGeneration: 1,
      expectedLifecycleGeneration: 1,
      expectedReleaseGeneration: 1,
    })
    expect(second.snapshotId).not.toBe(first.snapshotId)
    expect(second.publicGeneration).toBe(2)
    expect(
      (await publicationState(t, pageId, "en"))?.currentReleaseId
    ).toBeUndefined()
    expect(await t.run((ctx) => ctx.db.get(first.snapshotId))).not.toBeNull()
    expect(
      publishedTitle(
        await t.query(api.cms.pages.getPublicPageById, {
          languageVersion: 0,
          id: pageId,
          locale: "en",
        }),
        "en"
      )
    ).toBe("English v2")
    expect(
      await t.query(api.cms.pages.resolveHistoricalPublishedPath, {
        languageVersion: 0,
        locale: "en",
        path: "/snapshot-page",
      })
    ).toMatchObject({
      authority: "snapshot_active",
      disposition: "historical_redirect",
      pageId,
      locale: "en",
      snapshotId: second.snapshotId,
      publicGeneration: 2,
      destinationPath: "/snapshot-page-v2",
      statusCode: 307,
    })

    await owner.mutation(api.cms.publication.withdrawLocale, {
      pageId,
      locale: "en",
      expectedSnapshotId: second.snapshotId,
      expectedPublicGeneration: 2,
      expectedLifecycleGeneration: 1,
    })
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("pagePublicationSliceReferences")
          .withIndex("by_pageId_and_locale_and_sourceKind", (q) =>
            q
              .eq("pageId", pageId)
              .eq("locale", "en")
              .eq("sourceKind", "current_public")
          )
          .collect()
      )
    ).toEqual([])
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("pagePublicationSliceReferences")
          .withIndex("by_pageId_and_locale_and_sourceKind", (q) =>
            q
              .eq("pageId", pageId)
              .eq("locale", "en")
              .eq("sourceKind", "candidate")
          )
          .collect()
      )
    ).toHaveLength(1)
    expect(
      await t.query(api.cms.pages.getPublicPageById, {
        languageVersion: 0,
        id: pageId,
        locale: "en",
      })
    ).toBeNull()
    expect(await t.run((ctx) => ctx.db.get(second.snapshotId))).not.toBeNull()
    expect(
      await t.query(api.cms.pages.resolveHistoricalPublishedPath, {
        languageVersion: 0,
        locale: "en",
        path: "/snapshot-page",
      })
    ).toEqual({
      authority: "snapshot_active",
      disposition: "historical_unavailable",
    })
  })

  test("a child captures its selected same-locale ancestry and ignores later legacy parent changes", sliceProfile(["hero-agency"]), async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const childId = await installSnapshotFixture(t, owner)
    const parentId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "parent",
      title: "Parent",
      content: {
        en: { title: "Parent", slices: [] },
        fr: { title: "Parent français", slices: [] },
      },
    })
    const parentPublished = await owner.mutation(
      api.cms.publication.publishLocale,
      {
        pageId: parentId,
        locale: "en",
        expectedDraftGeneration: 1,
        expectedSharedDraftGeneration: 1,
        expectedPublicGeneration: 0,
        expectedLifecycleGeneration: 1,
        expectedReleaseGeneration: 0,
      }
    )
    await t.run(async (ctx) => {
      const shared = await ctx.db
        .query("pageSharedDrafts")
        .withIndex("by_pageId", (q) => q.eq("pageId", childId))
        .unique()
      if (!shared) throw new Error("child shared draft missing")
      await ctx.db.patch(shared._id, { system: { parentId } })
    })
    await owner.mutation(api.cms.publication.publishLocale, {
      pageId: childId,
      locale: "en",
      expectedDraftGeneration: 1,
      expectedSharedDraftGeneration: 1,
      expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1,
      expectedReleaseGeneration: 0,
    })
    await t.run((ctx) => ctx.db.patch(childId, { parentId: undefined }))
    expect(
      await t.query(api.cms.pages.resolveLocalizedPathQuery, {
        languageVersion: 0,
        path: "/parent/snapshot-page",
        locale: "en",
      })
    ).toBe(childId)
    expect(
      await t.query(api.cms.pages.getLocalizedBreadcrumb, {
        languageVersion: 0,
        pageId: childId,
        locale: "en",
      })
    ).toEqual([
      { name: "Parent", url: "/parent" },
      { name: "English v1", url: "/parent/snapshot-page" },
    ])
    await expect(
      owner.mutation(api.cms.publication.withdrawLocale, {
        pageId: parentId,
        locale: "en",
        expectedSnapshotId: parentPublished.snapshotId,
        expectedPublicGeneration: 1,
        expectedLifecycleGeneration: 1,
      })
    ).rejects.toThrow("PAGE_ANCESTRY_IN_USE")
    expect((await publicationState(t, parentId, "en"))?.currentSnapshotId).toBe(
      parentPublished.snapshotId
    )
    await owner.mutation(api.cms.publication.publishLocale, {
      pageId: parentId,
      locale: "fr",
      expectedDraftGeneration: 1,
      expectedSharedDraftGeneration: 1,
      expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1,
      expectedReleaseGeneration: 0,
    })
    await owner.mutation(api.cms.publication.publishLocale, {
      pageId: childId,
      locale: "fr",
      expectedDraftGeneration: 1,
      expectedSharedDraftGeneration: 1,
      expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1,
      expectedReleaseGeneration: 0,
    })
    expect(
      await t.query(api.cms.pages.getLocalizedBreadcrumb, {
        languageVersion: 0,
        pageId: childId,
        locale: "fr",
      })
    ).toEqual([
      { name: "Parent français", url: "/fr/parent" },
      { name: "Français v1", url: "/fr/parent/snapshot-page" },
    ])
  })

  test("public readers fail closed on candidate, release, pointer, or lifecycle linkage drift", sliceProfile(["hero-agency"]), async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const pageId = await installSnapshotFixture(t, owner)
    const published = await owner.mutation(api.cms.publication.publishLocale, {
      pageId,
      locale: "en",
      expectedDraftGeneration: 1,
      expectedSharedDraftGeneration: 1,
      expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1,
      expectedReleaseGeneration: 0,
    })
    const linked = await t.run(async (ctx) => {
      const snapshot = await ctx.db.get(published.snapshotId)
      const candidate = snapshot ? await ctx.db.get(snapshot.candidateId) : null
      const release = snapshot ? await ctx.db.get(snapshot.releaseId) : null
      const state = await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", "en")
        )
        .unique()
      if (!snapshot || !candidate || !release || !state) {
        throw new Error("linked publication fixture missing")
      }
      return { snapshot, candidate, release, state }
    })
    await t.run((ctx) =>
      ctx.db.patch(linked.candidate._id, { digest: "sha256:invalid" })
    )
    expect(
      await t.query(api.cms.pages.getPublicPageById, {
        languageVersion: 0,
        id: pageId,
        locale: "en",
      })
    ).toBeNull()
    await t.run((ctx) =>
      ctx.db.patch(linked.candidate._id, { digest: linked.candidate.digest })
    )
    await t.run((ctx) =>
      ctx.db.patch(linked.release._id, { expectedPublicGeneration: 99 })
    )
    expect(
      await t.query(api.cms.pages.getPublicPageById, {
        languageVersion: 0,
        id: pageId,
        locale: "en",
      })
    ).toBeNull()
    await t.run((ctx) =>
      ctx.db.patch(linked.release._id, {
        expectedPublicGeneration: linked.release.expectedPublicGeneration,
      })
    )
    await t.run((ctx) =>
      ctx.db.patch(linked.state._id, {
        currentPublishedAt: linked.state.currentPublishedAt! + 1,
      })
    )
    expect(
      await t.query(api.cms.pages.getPublicPageById, {
        languageVersion: 0,
        id: pageId,
        locale: "en",
      })
    ).toBeNull()
    await t.run((ctx) =>
      ctx.db.patch(linked.state._id, {
        currentPublishedAt: linked.state.currentPublishedAt,
      })
    )
    await t.run((ctx) =>
      ctx.db.patch(published.snapshotId, {
        sourceLifecycleGeneration: 99,
      })
    )
    expect(
      await t.query(api.cms.pages.getPublicPageById, {
        languageVersion: 0,
        id: pageId,
        locale: "en",
      })
    ).toBeNull()
    expect(
      await t.query(api.cms.pages.resolveLocalizedPathQuery, {
        languageVersion: 0,
        path: "/snapshot-page",
        locale: "en",
      })
    ).toBeNull()
  })

  test("current readers require the retained Page identity and exact Page type", sliceProfile(["hero-agency"]), async () => {
    const missingPageApp = app()
    const missingPageOwner = missingPageApp.withIdentity(OWNER)
    const missingPageId = await installSnapshotFixture(
      missingPageApp,
      missingPageOwner
    )
    await missingPageOwner.mutation(api.cms.publication.publishLocale, {
      pageId: missingPageId,
      locale: "en",
      expectedDraftGeneration: 1,
      expectedSharedDraftGeneration: 1,
      expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1,
      expectedReleaseGeneration: 0,
    })
    await missingPageApp.run((ctx) => ctx.db.delete(missingPageId))
    expect(
      await missingPageApp.query(api.cms.pages.getPublicPageById, {
        languageVersion: 0,
        id: missingPageId,
        locale: "en",
      })
    ).toBeNull()

    const wrongTypeApp = app()
    const wrongTypeOwner = wrongTypeApp.withIdentity(OWNER)
    const wrongTypePageId = await installSnapshotFixture(
      wrongTypeApp,
      wrongTypeOwner
    )
    await wrongTypeOwner.mutation(api.cms.publication.publishLocale, {
      pageId: wrongTypePageId,
      locale: "en",
      expectedDraftGeneration: 1,
      expectedSharedDraftGeneration: 1,
      expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1,
      expectedReleaseGeneration: 0,
    })
    await wrongTypeApp.run((ctx) =>
      ctx.db.patch(wrongTypePageId, { pageType: "page" } as never)
    )
    expect(
      await wrongTypeApp.query(api.cms.pages.getPublicPageById, {
        languageVersion: 0,
        id: wrongTypePageId,
        locale: "en",
      })
    ).toBeNull()
  })

  test("current readers enforce the next generation and accept valid candidate release history", sliceProfile(["hero-agency"]), async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const pageId = await installSnapshotFixture(t, owner)
    const published = await owner.mutation(api.cms.publication.publishLocale, {
      pageId,
      locale: "en",
      expectedDraftGeneration: 1,
      expectedSharedDraftGeneration: 1,
      expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1,
      expectedReleaseGeneration: 0,
    })
    const linked = await t.run(async (ctx) => {
      const snapshot = await ctx.db.get(published.snapshotId)
      const release = snapshot ? await ctx.db.get(snapshot.releaseId) : null
      const state = await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", "en")
        )
        .unique()
      if (!snapshot || !release || !state) {
        throw new Error("linked publication fixture missing")
      }
      return { snapshot, release, state }
    })

    // Keep the pointer/header agreement intact while breaking only the
    // snapshotGeneration === sourcePublicGeneration + 1 invariant.
    await t.run(async (ctx) => {
      await ctx.db.patch(linked.snapshot._id, { generation: 2 })
      await ctx.db.patch(linked.state._id, { publicGeneration: 2 })
    })
    expect(
      await t.query(api.cms.pages.getPublicPageById, {
        languageVersion: 0,
        id: pageId,
        locale: "en",
      })
    ).toBeNull()

    await t.run(async (ctx) => {
      const historyAt = linked.release.createdAt - 2
      await ctx.db.patch(linked.snapshot._id, { generation: 1 })
      await ctx.db.patch(linked.state._id, {
        publicGeneration: 1,
        releaseGeneration: 3,
      })
      await ctx.db.patch(linked.release._id, { generation: 3 })
      await ctx.db.insert("pageLocalePublicationReleases", {
        pageId,
        locale: "en",
        candidateId: linked.snapshot.candidateId,
        generation: 1,
        expectedPublicGeneration: 0,
        expectedLifecycleGeneration: 1,
        executeAt: historyAt,
        status: "cancelled",
        cancelledAt: historyAt,
        cancelReason: "OWNER_CANCELLED",
        attribution: linked.release.attribution,
        createdAt: historyAt,
        updatedAt: historyAt,
      })
      await ctx.db.insert("pageLocalePublicationReleases", {
        pageId,
        locale: "en",
        candidateId: linked.snapshot.candidateId,
        generation: 2,
        expectedPublicGeneration: 0,
        expectedLifecycleGeneration: 1,
        executeAt: historyAt + 1,
        status: "replaced",
        replacedAt: historyAt + 1,
        replacedByReleaseId: linked.release._id,
        attribution: linked.release.attribution,
        createdAt: historyAt + 1,
        updatedAt: historyAt + 1,
      })
    })
    expect(
      publishedTitle(
        await t.query(api.cms.pages.getPublicPageById, {
          languageVersion: 0,
          id: pageId,
          locale: "en",
        }),
        "en"
      )
    ).toBe("English v1")
  })

  test("menu, redirect, and public settings consumers stay on the selected locale snapshot", sliceProfile(["hero-agency"]), async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const pageId = await installSnapshotFixture(t, owner)
    await enableRedirectsForTest(owner)
    await owner.mutation(api.cms.publication.publishLocale, {
      pageId,
      locale: "en",
      expectedDraftGeneration: 1,
      expectedSharedDraftGeneration: 1,
      expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1,
      expectedReleaseGeneration: 0,
    })
    await t.run(async (ctx) => {
      const now = Date.now()
      const settings = await ctx.db.query("siteSettings").unique()
      if (!settings) throw new Error("settings fixture missing")
      await ctx.db.patch(settings._id, { updatedAt: now })
      await ctx.db.insert("menus", {
        slug: "primary",
        updatedAt: now,
        nav: [
          {
            id: "page",
            label: { en: "Page" },
            target: { type: "internal", pageId },
          },
        ],
      })
      await ctx.db.insert("redirects", {
        fromPath: "/old-page",
        toPageId: pageId,
        locale: "en",
        statusCode: 301,
        createdAt: now,
        updatedAt: now,
      })
      // Legacy data would otherwise synthesize a home and a different URL.
      await ctx.db.patch(pageId, {
        status: "published",
        slug: "legacy-mutated",
      })
    })
    expect(
      (await t.query(api.cms.settings.getSiteConfig, {})).homePageId
    ).not.toBe(pageId)
    expect(
      await t.query(api.cms.menus.getWithResolvedLinks, {
        languageVersion: 0,
        slug: "primary",
        locale: "en",
      })
    ).toMatchObject({
      nav: [
        expect.objectContaining({
          target: { type: "internal", url: "/snapshot-page" },
        }),
      ],
    })
    expect(
      await t.query(api.cms.redirects.resolve, {
        languageVersion: 0,
        path: "/old-page",
        locale: "en",
      })
    ).toEqual({ destination: "/snapshot-page", statusCode: 301 })
  })

  test("private preview is owner-bound and reports its authenticated locale fallback", sliceProfile(["hero-agency"]), async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const pageId = await installSnapshotFixture(t, owner)
    await expect(
      t.mutation(api.cms.preview.getPreviewPage, {
        pageId,
        locale: "en",
        allowFallback: true,
      })
    ).rejects.toThrow()
    await t.run(async (ctx) => {
      const frDraft = await ctx.db
        .query("pageLocaleDrafts")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", "fr")
        )
        .unique()
      if (frDraft) await ctx.db.delete(frDraft._id)
    })
    const fallbackSession = await owner.mutation(
      api.cms.preview.createPreviewSession,
      {
        pageId,
        locale: "fr",
      }
    )
    expect(
      await owner.mutation(api.cms.preview.getPreviewPage, {
        sessionToken: fallbackSession.sessionToken,
        allowFallback: true,
      })
    ).toMatchObject({ renderLocale: "en", isFallback: true })
    const enSession = await owner.mutation(
      api.cms.preview.createPreviewSession,
      {
        pageId,
        locale: "en",
      }
    )
    expect(
      await owner.mutation(api.cms.preview.resolvePreviewPath, {
        path: "/snapshot-page",
        sessionToken: enSession.sessionToken,
        allowFallback: false,
      })
    ).toMatchObject({ pageId, renderLocale: "en", isFallback: false })
    expect(
      await t.query(api.cms.pages.getPublicPageById, {
        languageVersion: 0,
        id: pageId,
        locale: "fr",
      })
    ).toBeNull()
  })

  test("Community immediate publication has no Team policy or review dependency", sliceProfile([]), async () => {
    const publicationSource = readFileSync(
      new URL("./cms/publication.ts", import.meta.url),
      "utf8"
    )
    const policySource = readFileSync(
      new URL("./lib/publishing/publicationPolicy.ts", import.meta.url),
      "utf8"
    )
    for (const source of [publicationSource, policySource]) {
      expect(source).not.toMatch(
        /ctx\.db\.(query|get)\("(?:teamReviewRounds|teamPublishingPolicies|cmsMemberships)"\)/
      )
      expect(source).not.toMatch(
        /from ["'][^"']*(?:\/team\/|\/memberships|\/entitlement)/
      )
    }
  })

  test("public layout and starter overlay share required locale authority", sliceProfile([]), () => {
    const source = readFileSync(
      new URL("../app/(public)/[locale]/layout.tsx", import.meta.url),
      "utf8"
    )
    expect(source).toContain('requiredCmsRead(readConfig, ["cms-config"]')
  })

  test("public route and starter overlay keep default-locale fallback inside preview only", sliceProfile([]), () => {
    const routeSources = [
      "../app/(public)/[locale]/[[...path]]/page.tsx",
    ].map((relativePath) =>
      readFileSync(new URL(relativePath, import.meta.url), "utf8")
    )
    for (const source of routeSources) {
      expect(source).toContain(
        "const publicLocaleContent = page.content?.[locale]"
      )
      expect(source).toMatch(
        /selectPublicLocaleContent\(\s*page\.content,\s*locale,\s*config\.defaultLocale,\s*true\s*\)/
      )
      expect(source).not.toContain("config.defaultLocale,\n    false")
      expect(source).toContain("api.cms.preview.resolvePreviewPath")
      expect(source).toContain("api.cms.preview.getPreviewPage")
      expect(source).not.toContain("includeDrafts: preview")
      // F08a (1639155a) removed an overlay-only helper absent from source to
      // close legacy-seam/parity drift, not to require swallowing failures.
      // U2 restores it in both copies: required public reads preserve outages,
      // while the preview-only fallback and snapshot/locale guards above stay.
      expect(source).toContain("requiredCmsRead")
    }
    const resolverSource = readFileSync(
      new URL("./cms/pages.ts", import.meta.url),
      "utf8"
    )
    const publicResolver = resolverSource.slice(
      resolverSource.indexOf("export const resolveLocalizedPathQuery"),
      resolverSource.indexOf(
        "// Mutations",
        resolverSource.indexOf("export const resolveLocalizedPathQuery")
      )
    )
    expect(publicResolver).not.toContain("includeDrafts")
  })
})

// Current authoritative history boundary: legacy staging is never involved.
describe("historical Published Snapshot restoration", () => {
  async function restoreArgs(
    t: ReturnType<typeof convexTest>,
    pageId: Id<"pages">,
    snapshotId: Id<"pagePublishedSnapshots">
  ) {
    return t.run(async (ctx) => {
      const state = (await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", "en")
        )
        .unique())!
      const shared = (await ctx.db
        .query("pageSharedDrafts")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique())!
      const pageState = (await ctx.db
        .query("pagePublicationPageStates")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique())!
      return {
        pageId,
        locale: "en",
        snapshotId,
        expectedDraftGeneration: state.draftGeneration,
        expectedSharedDraftGeneration: shared.generation,
        expectedLifecycleGeneration: pageState.lifecycleGeneration,
        expectedPublicGeneration: state.publicGeneration,
        expectedReleaseGeneration: state.releaseGeneration,
      }
    })
  }
  async function fixture() {
    const t = app(),
      owner = t.withIdentity(OWNER)
    const pageId = await installSnapshotFixture(t, owner)
    await owner.mutation(api.cms.publication.saveLocaleDraft, {
      pageId,
      locale: "en",
      slug: "historical",
      expectedDraftGeneration: 1,
      expectedLifecycleGeneration: 1,
      draft: {
        pageType: "landing-page",
        localized: { title: "Historical", metaTitle: "Old SEO" },
        slices: [
          {
            id: "one",
            type: "hero-agency",
            enabled: true,
            primary: {
              eyebrow: "First",
              title: "First title",
              description: canonicalBody("First body"),
            },
            items: [],
          },
          {
            id: "two",
            type: "hero-agency",
            enabled: false,
            primary: {
              eyebrow: "Second",
              title: "Second title",
              description: canonicalBody("Second body"),
            },
            items: [],
          },
        ],
      },
    })
    const old = await owner.mutation(api.cms.publication.publishLocale, {
      pageId,
      locale: "en",
      expectedDraftGeneration: 2,
      expectedSharedDraftGeneration: 1,
      expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1,
      expectedReleaseGeneration: 0,
    })
    return {
      t,
      owner,
      pageId,
      old,
      args: await restoreArgs(t, pageId, old.snapshotId),
    }
  }
  async function persisted(t: ReturnType<typeof convexTest>) {
    return t.run(async (ctx) => {
      const tables = [
        "pages",
        "pageLocaleDrafts",
        "pageSharedDrafts",
        "pageLocalePublicationStates",
        "pagePublishedSnapshots",
        "pageLocalePublicationCandidates",
        "pageLocalePublicationReleases",
        "pagePublicationDocumentReferences",
        "pagePublicationMediaReferences",
        "pagePublicationSliceReferences",
        "pageRevisions",
        "pageStaging",
      ] as const
      return Promise.all(tables.map((table) => ctx.db.query(table).collect()))
    })
  }
  test("keeps media immutable through draft Save, stale publish refusal, historical restore and explicit republish", sliceProfile(["hero-agency","hero-with-image"]), async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const pageId = await installSnapshotFixture(t, owner)
    const firstImage = {
      url: "/delivery-v1.jpg",
      alt: "Façade <courtyard>",
      width: 1600,
      height: 900,
      crop: { x: 25, y: 0, width: 50, height: 100 },
      cropSize: { width: 800, height: 900 },
      focal: { x: 40, y: 60 },
    }
    const secondImage = {
      ...firstImage,
      url: "/delivery-v2.jpg",
      alt: "Second & later",
      crop: { x: 0, y: 0, width: 75, height: 100 },
      cropSize: { width: 1200, height: 900 },
      focal: { x: 30, y: 70 },
    }
    const save = (image: typeof firstImage, expectedGeneration: number) =>
      owner.mutation(api.cms.publication.saveEditorDraft, {
        pageId,
        expectedLifecycleGeneration: 1,
        localized: {
          locale: "en",
          slug: "snapshot-page",
          expectedGeneration,
          draft: {
            pageType: "landing-page",
            localized: { title: "Delivery" },
            slices: [
              {
                id: "delivery-hero",
                type: "hero-with-image",
                enabled: true,
                primary: {
                  eyebrow: "Delivery",
                  eyebrowLink: { type: "none" },
                  title: canonicalBody("Delivery"),
                  description: canonicalBody("Literal <media> & content"),
                  image,
                },
                items: [],
              },
            ],
          },
        },
      })
    const readPublic = (locale: string) =>
      t.query(api.cms.pages.getPublicPageById, {
        languageVersion: 0,
        id: pageId,
        locale,
      })
    const readDraft = (locale: string) =>
      t.run((ctx) =>
        ctx.db
          .query("pageLocaleDrafts")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", pageId).eq("locale", locale)
          )
          .unique()
      )
    await owner.mutation(api.cms.publication.publishLocale, {
      pageId,
      locale: "fr",
      expectedDraftGeneration: 1,
      expectedSharedDraftGeneration: 1,
      expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1,
      expectedReleaseGeneration: 0,
    })
    const peer = {
      public: await readPublic("fr"),
      draft: await readDraft("fr"),
      state: await publicationState(t, pageId, "fr"),
    }
    const publishFirst = {
      pageId,
      locale: "en",
      expectedDraftGeneration: 2,
      expectedSharedDraftGeneration: 1,
      expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1,
      expectedReleaseGeneration: 0,
    }
    await save(firstImage, 1)
    const first = await owner.mutation(
      api.cms.publication.publishLocale,
      publishFirst
    )
    const immutable = await t.run(async (ctx) => {
      const snapshot = (await ctx.db.get(first.snapshotId))!
      return { snapshot, candidate: await ctx.db.get(snapshot.candidateId) }
    })
    const originalPublic = await readPublic("en")
    expect(originalPublic).toMatchObject({
      content: {
        en: {
          slices: [{ id: "delivery-hero", primary: { image: firstImage } }],
        },
      },
    })
    await save(secondImage, 2)
    expect((await readPublic("en"))?.content).toEqual(originalPublic?.content)
    const beforeRefusal = await persisted(t)
    await expect(
      owner.mutation(api.cms.publication.publishLocale, publishFirst)
    ).rejects.toThrow(/STALE/)
    expect(await persisted(t)).toEqual(beforeRefusal)
    const second = await owner.mutation(api.cms.publication.publishLocale, {
      ...publishFirst,
      expectedDraftGeneration: 3,
      expectedPublicGeneration: 1,
      expectedReleaseGeneration: 1,
    })
    expect(second.snapshotId).not.toBe(first.snapshotId)
    const secondPublic = await readPublic("en")
    expect(secondPublic).toMatchObject({
      content: { en: { slices: [{ primary: { image: secondImage } }] } },
    })
    await owner.mutation(
      api.cms.publication.restoreSnapshotAsDraft,
      await restoreArgs(t, pageId, first.snapshotId)
    )
    expect(await readDraft("en")).toMatchObject({
      content: {
        slices: [{ id: "delivery-hero", primary: { image: firstImage } }],
      },
    })
    expect((await readPublic("en"))?.content).toEqual(secondPublic?.content)
    const { snapshotId: omittedSnapshot, ...republish } = await restoreArgs(
      t,
      pageId,
      first.snapshotId
    )
    void omittedSnapshot
    await owner.mutation(api.cms.publication.publishLocale, republish)
    expect((await readPublic("en"))?.content).toEqual(originalPublic?.content)
    expect(
      await t.run(async (ctx) => ({
        snapshot: await ctx.db.get(first.snapshotId),
        candidate: await ctx.db.get(immutable.snapshot.candidateId),
      }))
    ).toEqual(immutable)
    expect({
      public: await readPublic("fr"),
      draft: await readDraft("fr"),
      state: await publicationState(t, pageId, "fr"),
    }).toEqual(peer)
  })
  test("restores both complete drafts and occurrence identities while public/history/FR stay unchanged until explicit publish", sliceProfile(["hero-agency"]), async () => {
    const { t, owner, pageId, old, args } = await fixture()
    await owner.mutation(api.cms.publication.saveSharedDraft, {
      pageId,
      expectedSharedDraftGeneration: 1,
      expectedLifecycleGeneration: 1,
      template: "later",
      cardExcerpt: "later",
      seo: { noIndex: true },
    })
    const before = await persisted(t)
    const history = await owner.query(api.cms.publication.listSnapshotHistory, {
      pageId,
      locale: "en",
    })
    expect(history).toHaveLength(1)
    const payload = JSON.parse(history[0]!.payloadJson)
    const result = await owner.mutation(
      api.cms.publication.restoreSnapshotAsDraft,
      { ...args, expectedSharedDraftGeneration: 2 }
    )
    const after = await persisted(t)
    const [draft] = after[1].filter(
      (row) =>
        "locale" in row &&
        row.locale === "en" &&
        "pageId" in row &&
        row.pageId === pageId
    )
    const shared = after[2].find(
      (row) => "pageId" in row && row.pageId === pageId
    )!
    expect(draft).toMatchObject({
      content: payload.localized.content,
      slug: payload.localized.slug,
      generation: result.draftGeneration,
    })
    expect(shared).toMatchObject({
      system: payload.shared.system,
      descriptor: payload.shared.descriptor,
    })
    expect((shared as { system: unknown }).system).toEqual(
      payload.shared.system
    ) // No residual template/SEO/card fields.
    expect(
      after[1].filter((row) => "locale" in row && row.locale === "fr")
    ).toEqual(before[1].filter((row) => "locale" in row && row.locale === "fr"))
    expect(
      after[3].filter((row) => "locale" in row && row.locale === "fr")
    ).toEqual(before[3].filter((row) => "locale" in row && row.locale === "fr"))
    for (const index of [0, 4, 5, 6, 10, 11])
      expect(after[index]).toEqual(before[index])
    expect(
      after[3].find(
        (row) =>
          "locale" in row &&
          row.locale === "en" &&
          "pageId" in row &&
          row.pageId === pageId
      )
    ).toMatchObject({
      currentSnapshotId: old.snapshotId,
      publicGeneration: 1,
      releaseGeneration: 1,
    })
    const { snapshotId: _snapshotId, ...publishArgs } = args
    void _snapshotId
    const published = await owner.mutation(api.cms.publication.publishLocale, {
      ...publishArgs,
      expectedDraftGeneration: result.draftGeneration,
      expectedSharedDraftGeneration: result.sharedDraftGeneration,
    })
    expect(published.snapshotId).not.toBe(old.snapshotId)
  })
  test.each([
    "expectedDraftGeneration",
    "expectedSharedDraftGeneration",
    "expectedLifecycleGeneration",
    "expectedPublicGeneration",
    "expectedReleaseGeneration",
  ] as const)("refuses stale %s without any partial state", sliceProfile(["hero-agency"]), async (key) => {
    const { t, owner, args } = await fixture()
    const before = await persisted(t)
    await expect(
      owner.mutation(api.cms.publication.restoreSnapshotAsDraft, {
        ...args,
        [key]: args[key] + 1,
      })
    ).rejects.toThrow(/STALE/)
    expect(await persisted(t)).toEqual(before)
  })
  test.each([
    ["disabled locale", "fr", ["fr"], "LOCALE_NOT_ENABLED"],
    [
      "invalid language state",
      "nl",
      ["en", "fr"],
      "SITE_LANGUAGE_AUTHORITY_INVALID",
    ],
  ] as const)(
    "refuses %s without changing drafts, public state or history", sliceProfile(["hero-agency"]),
    async (_name, defaultLocale, enabledLocales, error) => {
      const { t, owner, args } = await fixture()
      await t.run(async (ctx) => {
        const settings = (await ctx.db.query("siteSettings").unique())!
        await ctx.db.patch(settings._id, {
          defaultLocale,
          enabledLocales: [...enabledLocales],
        })
      })
      const before = await persisted(t)
      await expect(
        owner.mutation(api.cms.publication.restoreSnapshotAsDraft, args)
      ).rejects.toThrow(error)
      expect(await persisted(t)).toEqual(before)
    }
  )
  test("refuses non-owner, wrong locale and archived-Type new usage without changing history or drafts", sliceProfile(["hero-agency"]), async () => {
    const { t, owner, args, pageId } = await fixture()
    await expect(
      t
        .withIdentity({
          subject: "stranger",
          tokenIdentifier: "https://convex.test|stranger",
        })
        .mutation(api.cms.publication.restoreSnapshotAsDraft, args)
    ).rejects.toThrow()
    await expect(
      owner.mutation(api.cms.publication.restoreSnapshotAsDraft, {
        ...args,
        locale: "de",
      })
    ).rejects.toThrow()
    // Remove the admitted occurrences: restoring now would resurrect them.
    await owner.mutation(api.cms.publication.saveLocaleDraft, {
      pageId,
      locale: "en",
      slug: "historical",
      expectedDraftGeneration: args.expectedDraftGeneration,
      expectedLifecycleGeneration: args.expectedLifecycleGeneration,
      draft: {
        pageType: "landing-page",
        localized: { title: "Removed" },
        slices: [],
      },
    })
    const removalArgs = await restoreArgs(t, pageId, args.snapshotId)
    const before = await persisted(t)
    await t.run(async (ctx) => {
      const settings = (await ctx.db.query("siteSettings").first())!
      await ctx.db.patch(settings._id, { archivedSliceTypes: ["hero-agency"] })
    })
    await expect(
      owner.mutation(api.cms.publication.restoreSnapshotAsDraft, removalArgs)
    ).rejects.toThrow(/Archived Block Type/)
    expect(await persisted(t)).toEqual(before)
  })
  test("mixed supported/absent-Type history remains inspectable and whole restore refuses before writes", sliceProfile(["hero-agency"]), async () => {
    const { t, owner, args, old } = await fixture()
    await t.run(async (ctx) => {
      const candidate = (await ctx.db.get(old.candidateId))!
      const payload = JSON.parse(candidate.payloadJson)
      payload.localized.content.slices[1].type = "absent-profile-type"
      const serialized = serializeLocalePublicationCandidate(payload)
      const digest = await digestLocalePublicationCandidate(
        serialized.payloadJson
      )
      await ctx.db.patch(candidate._id, { ...serialized, digest })
      await ctx.db.patch(old.snapshotId, { candidateDigest: digest })
    })
    const before = await persisted(t)
    const history = await owner.query(api.cms.publication.listSnapshotHistory, {
      pageId: args.pageId,
      locale: "en",
    })
    expect(history[0]!.unavailablePaths).toEqual(["content.en.slices[1]"])
    expect(
      JSON.parse(history[0]!.payloadJson).localized.content.slices
    ).toHaveLength(2)
    await expect(
      owner.mutation(api.cms.publication.restoreSnapshotAsDraft, args)
    ).rejects.toThrow(/installed block code is unavailable/)
    expect(await persisted(t)).toEqual(before)
  })
  test("preserves image metadata and document bindings, and rolls back the whole restore when media is missing", sliceProfile(["hero-agency","hero-with-image"]), async () => {
    const { t, owner, pageId, args } = await fixture()
    const media = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(
        new Blob(["image"], { type: "image/png" })
      )
      const mediaId = await ctx.db.insert("media", {
        filename: "restore.png",
        storageId,
        url: "https://example.test/restore.png",
        size: 5,
        mimeType: "image/png",
        uploadedAt: Date.now(),
      })
      return { storageId, mediaId }
    })
    const targetId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "reference-target",
      title: "Reference",
      content: { en: { title: "Reference", slices: [] } },
    })
    await owner.mutation(api.cms.publication.publishLocale, {
      pageId: targetId,
      locale: "en",
      expectedDraftGeneration: 1,
      expectedSharedDraftGeneration: 1,
      expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1,
      expectedReleaseGeneration: 0,
    })
    const slices = [
      {
        id: "image-one",
        type: "hero-with-image" as const,
        enabled: true,
        primary: {
          eyebrow: "Image",
          eyebrowLink: { type: "internal" as const, pageId: targetId },
          title: "Media history",
          description: canonicalBody("Description"),
          image: {
            storageId: media.storageId,
            url: "https://example.test/restore.png",
            alt: "Historical alternative",
            focal: { x: 0.2, y: 0.8 },
            crop: { x: 1, y: 2, width: 3, height: 4 },
          },
        },
        items: [],
      },
    ]
    await owner.mutation(api.cms.publication.saveLocaleDraft, {
      pageId,
      locale: "en",
      slug: "historical",
      expectedDraftGeneration: args.expectedDraftGeneration,
      expectedLifecycleGeneration: 1,
      draft: {
        pageType: "landing-page",
        localized: { title: "Media" },
        slices,
      },
    })
    const next = await restoreArgs(t, pageId, args.snapshotId)
    const { snapshotId: ignored, ...publishArgs } = next
    void ignored
    const published = await owner.mutation(
      api.cms.publication.publishLocale,
      publishArgs
    )
    const restore = await restoreArgs(t, pageId, published.snapshotId)
    await owner.mutation(api.cms.publication.restoreSnapshotAsDraft, restore)
    const drafts = await t.run((ctx) =>
      ctx.db
        .query("pageLocaleDrafts")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", "en")
        )
        .unique()
    )
    expect(drafts).toMatchObject({
      content: {
        slices: [
          {
            ...slices[0],
            primary: {
              ...slices[0].primary,
              title: JSON.stringify({
                type: "doc",
                content: [
                  {
                    type: "heading",
                    attrs: { level: 2 },
                    content: [{ type: "text", text: "Media history" }],
                  },
                ],
              }),
            },
          },
        ],
      },
    })
    const mediaReferences = await t.run((ctx) =>
      ctx.db
        .query("pagePublicationMediaReferences")
        .withIndex("by_sourceKind_and_sourceId", (q) =>
          q.eq("sourceKind", "locale_draft").eq("sourceId", drafts!._id)
        )
        .collect()
    )
    expect(mediaReferences).toEqual([
      expect.objectContaining({
        mediaId: media.mediaId,
        storageId: media.storageId,
      }),
    ])
    await t.run((ctx) => ctx.db.delete(media.mediaId))
    const before = await persisted(t)
    await expect(
      owner.mutation(
        api.cms.publication.restoreSnapshotAsDraft,
        await restoreArgs(t, pageId, published.snapshotId)
      )
    ).rejects.toThrow(/MEDIA_REFERENCE_MISSING/)
    expect(await persisted(t)).toEqual(before)
  })
  test("restores complete shared descriptor references and refuses missing targets transactionally", sliceProfile(["hero-agency"]), async () => {
    const { t, owner } = await fixture()
    const authorId = await owner.mutation(api.cms.pages.create, {
      pageType: "author",
      status: "draft",
      slug: "restored-author",
      title: "Author",
      name: "Author",
      content: { en: { title: "Author", slices: [] } },
    })
    await owner.mutation(api.cms.publication.publishLocale, {
      pageId: authorId,
      locale: "en",
      expectedDraftGeneration: 1,
      expectedSharedDraftGeneration: 1,
      expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1,
      expectedReleaseGeneration: 0,
    })
    const pageId = await owner.mutation(api.cms.pages.create, {
      pageType: "post",
      status: "draft",
      slug: "restored-post",
      title: "Post",
      authorIds: [authorId],
      tags: ["historical"],
      content: { en: { title: "Post", slices: [] } },
    })
    const published = await owner.mutation(api.cms.publication.publishLocale, {
      pageId,
      locale: "en",
      expectedDraftGeneration: 1,
      expectedSharedDraftGeneration: 1,
      expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1,
      expectedReleaseGeneration: 0,
    })
    await owner.mutation(api.cms.publication.saveSharedDraft, {
      pageId,
      expectedSharedDraftGeneration: 1,
      expectedLifecycleGeneration: 1,
      authorIds: [],
      tags: ["new"],
    })
    await owner.mutation(
      api.cms.publication.restoreSnapshotAsDraft,
      await restoreArgs(t, pageId, published.snapshotId)
    )
    const shared = await t.run((ctx) =>
      ctx.db
        .query("pageSharedDrafts")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique()
    )
    expect(shared).toMatchObject({
      descriptor: { authorIds: [{ pageId: authorId }], tags: ["historical"] },
    })
    const refs = await t.run((ctx) =>
      ctx.db
        .query("pagePublicationDocumentReferences")
        .withIndex("by_sourceKind_and_sourceId", (q) =>
          q.eq("sourceKind", "shared_draft").eq("sourceId", shared!._id)
        )
        .collect()
    )
    expect(refs).toEqual([expect.objectContaining({ targetId: authorId })])
    await t.run((ctx) => ctx.db.delete(authorId))
    const before = await persisted(t)
    await expect(
      owner.mutation(
        api.cms.publication.restoreSnapshotAsDraft,
        await restoreArgs(t, pageId, published.snapshotId)
      )
    ).rejects.toThrow(/REFERENCE_TARGET_MISSING/)
    expect(await persisted(t)).toEqual(before)
  })
})

describe("archived-Type Working Draft admission", () => {
  type T = ReturnType<typeof app>
  type Owner = ReturnType<T["withIdentity"]>
  const refusal =
    'Archived Block Type "hero-with-image" cannot be added to a Page.'
  const hero = (id = "admitted-hero", eyebrow = "Admitted") => {
    const slice = createSampleSlice("hero-with-image")
    return { ...slice, id, primary: { ...slice.primary, eyebrow } }
  }

  async function clocks(t: T, pageId: Id<"pages">, locale = "en") {
    return t.run(async (ctx) => {
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
      return {
        pageId,
        locale,
        expectedDraftGeneration: state?.draftGeneration ?? 0,
        expectedSharedDraftGeneration: shared.generation,
        expectedLifecycleGeneration: page.lifecycleGeneration,
        expectedPublicGeneration: state?.publicGeneration ?? 0,
        expectedReleaseGeneration: state?.releaseGeneration ?? 0,
      }
    })
  }
  async function save(
    t: T,
    owner: Owner,
    pageId: Id<"pages">,
    slices: ReturnType<typeof hero>[],
    locale = "en"
  ) {
    const c = await clocks(t, pageId, locale)
    return owner.mutation(api.cms.publication.saveLocaleDraft, {
      pageId,
      locale,
      slug: "archived-page",
      expectedDraftGeneration: c.expectedDraftGeneration,
      expectedLifecycleGeneration: c.expectedLifecycleGeneration,
      draft: {
        pageType: "landing-page",
        localized: { title: "Archived Page" },
        slices,
      },
    })
  }
  async function publish(
    t: T,
    owner: Owner,
    pageId: Id<"pages">,
    locale = "en"
  ) {
    return owner.mutation(
      api.cms.publication.publishLocale,
      await clocks(t, pageId, locale)
    )
  }
  async function archive(t: T) {
    await t.run(async (ctx) => {
      const settings = (await ctx.db.query("siteSettings").unique())!
      await ctx.db.patch(settings._id, {
        archivedSliceTypes: ["hero-with-image"],
      })
    })
  }
  async function fixture() {
    const t = app(),
      owner = t.withIdentity(OWNER)
    await owner.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: "Archived admission",
      timezone: "UTC",
      defaultLocale: "en",
    })
    const pageId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "archived-page",
      content: { en: { title: "Archived Page", slices: [hero()] } },
    })
    return { t, owner, pageId }
  }
  async function persisted(t: T) {
    return t.run(async (ctx) => {
      const tables = [
        "pages",
        "pageLocaleDrafts",
        "pageSharedDrafts",
        "pageLocalePublicationStates",
        "pagePublishedSnapshots",
        "pageLocalePublicationCandidates",
        "pageLocalePublicationReleases",
        "pagePublicationSliceReferences",
        "pagePublicationDocumentReferences",
        "pagePublicationMediaReferences",
        "pageRevisions",
      ] as const
      return Promise.all(tables.map((table) => ctx.db.query(table).collect()))
    })
  }
  async function snapshotSlices(
    t: T,
    candidateId: Id<"pageLocalePublicationCandidates">
  ) {
    const candidate = (await t.run((ctx) => ctx.db.get(candidateId)))!
    return JSON.parse(candidate.payloadJson).localized.content.slices
  }

  test("F09 publishes an edited and saved retained occurrence after archival", sliceProfile(["hero-with-image"]), async () => {
    const { t, owner, pageId } = await fixture()
    await publish(t, owner, pageId)
    await archive(t)
    await save(t, owner, pageId, [
      hero("admitted-hero", "Edited after archive"),
    ])
    const result = await publish(t, owner, pageId)
    expect(await snapshotSlices(t, result.candidateId)).toEqual([
      expect.objectContaining({
        id: "admitted-hero",
        primary: expect.objectContaining({ eyebrow: "Edited after archive" }),
      }),
    ])
    const languageVersion = (await t.run((ctx) =>
      ctx.db.query("siteLanguageAuthority").unique()
    ))!.version
    const publicPage = await t.query(api.cms.pages.getPublicPageById, {
      id: pageId,
      locale: "en",
      languageVersion,
    })
    expect(publicPage?.content.en).toEqual(
      expect.objectContaining({
        slices: await snapshotSlices(t, result.candidateId),
      })
    )
  })
  test("first Publish retains an occurrence added and saved while active", sliceProfile(["hero-with-image"]), async () => {
    const { t, owner, pageId } = await fixture()
    await save(t, owner, pageId, [])
    await save(t, owner, pageId, [hero("saved-before-archive")])
    await archive(t)
    const result = await publish(t, owner, pageId)
    expect(await snapshotSlices(t, result.candidateId)).toEqual([
      expect.objectContaining({ id: "saved-before-archive" }),
    ])
  })
  test("Save refuses a fresh archived occurrence with the exact message and no writes", sliceProfile(["hero-with-image"]), async () => {
    const { t, owner, pageId } = await fixture()
    await archive(t)
    const before = await persisted(t)
    await expect(
      save(t, owner, pageId, [hero(), hero("new-hero")])
    ).rejects.toThrow(refusal)
    expect(await persisted(t)).toEqual(before)
  })
  test("shared-only Publish uses the admitted fallback after its draft row was removed", sliceProfile(["hero-with-image"]), async () => {
    const { t, owner, pageId } = await fixture()
    await publish(t, owner, pageId)
    await archive(t)
    await owner.mutation(api.cms.publication.saveSharedDraft, {
      pageId,
      expectedSharedDraftGeneration: 1,
      expectedLifecycleGeneration: 1,
      cardExcerpt: "Shared edit",
    })
    const drafts = await t.run((ctx) =>
      ctx.db
        .query("pageLocaleDrafts")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", "en")
        )
        .collect()
    )
    expect(drafts).toEqual([])
    const result = await publish(t, owner, pageId)
    expect(await snapshotSlices(t, result.candidateId)).toEqual([
      expect.objectContaining({ id: "admitted-hero" }),
    ])
  })
  test.each([false, true])(
    "restore retains an archived occurrence with draft row=%s", sliceProfile(["hero-with-image"]),
    async (withDraft) => {
      const { t, owner, pageId } = await fixture()
      const first = await publish(t, owner, pageId)
      await archive(t)
      if (withDraft)
        await save(t, owner, pageId, [hero("admitted-hero", "Current edit")])
      await owner.mutation(api.cms.publication.restoreSnapshotAsDraft, {
        ...(await clocks(t, pageId)),
        snapshotId: first.snapshotId,
      })
      const draft = await t.run((ctx) =>
        ctx.db
          .query("pageLocaleDrafts")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", pageId).eq("locale", "en")
          )
          .unique()
      )
      expect(draft?.content).toEqual(
        expect.objectContaining({
          slices: await snapshotSlices(t, first.candidateId),
        })
      )
    }
  )
  test("restore refuses resurrection of an occurrence removed from the working copy", sliceProfile(["hero-with-image"]), async () => {
    const { t, owner, pageId } = await fixture()
    const first = await publish(t, owner, pageId)
    await archive(t)
    await save(t, owner, pageId, [])
    const before = await persisted(t)
    await expect(
      owner.mutation(api.cms.publication.restoreSnapshotAsDraft, {
        ...(await clocks(t, pageId)),
        snapshotId: first.snapshotId,
      })
    ).rejects.toThrow(refusal)
    expect(await persisted(t)).toEqual(before)
  })
  test("M05 admission is per locale even when the same occurrence ID exists in EN", sliceProfile(["hero-with-image"]), async () => {
    const { t, owner, pageId } = await fixture()
    // Use the existing module/adoption commands, then add FR without content.
    await owner.mutation(api.cms.modules.commit, {
      expectedConfigurationVersion: 0,
      changes: [{ moduleId: "multilingual", enabled: true }],
    })
    const preview = await owner.query(api.cms.multilingual.previewAdoption, {})
    if (!preview.canAdopt)
      throw new Error(preview.blockerCode ?? "Cannot adopt")
    const { canAdopt, defaultLocale, enabledLocales, ...tokens } = preview
    expect(canAdopt).toBe(true)
    void defaultLocale
    void enabledLocales
    await owner.mutation(
      api.cms.multilingual.adoptMultilingualAuthority,
      tokens
    )
    const versions = await t.run(async (ctx) => ({
      authority: (await ctx.db.query("siteLanguageAuthority").unique())!
        .version,
      module: (await ctx.db.query("cmsModuleState").first())!
        .configurationVersion,
    }))
    await owner.mutation(api.cms.multilingual.addLanguage, {
      locale: "fr",
      expectedAuthorityVersion: versions.authority,
      expectedModuleConfigurationVersion: versions.module,
    })
    await archive(t)
    await save(t, owner, pageId, [hero("admitted-hero", "EN retained")])
    const en = await publish(t, owner, pageId)
    expect(await snapshotSlices(t, en.candidateId)).toHaveLength(1)
    const before = await persisted(t)
    await expect(save(t, owner, pageId, [hero()], "fr")).rejects.toThrow(
      refusal
    )
    expect(await persisted(t)).toEqual(before)
    expect(await publicationState(t, pageId, "fr")).toBeNull()
  })

  describe("transition publication", () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())
    test.each(["draft", "frozen"] as const)(
      "%s arm preserves its own admission boundary", sliceProfile(["hero-with-image"]),
      async (arm) => {
        const { t, owner, pageId } = await fixture()
        const settings = (await t.run((ctx) =>
          ctx.db.query("siteSettings").unique()
        ))!
        await publish(t, owner, settings.homePageId!)
        const source = await publish(t, owner, pageId)
        const authority = (await t.run((ctx) =>
          ctx.db.query("siteLanguageAuthority").unique()
        ))!
        const transitionId = await owner.mutation(
          api.cms.language.startLanguageTransition,
          {
            mode: arm === "draft" ? "replace_content" : "correct_label",
            sourceLocale: "en",
            targetLocale: "fr",
            expectedSettingsUpdatedAt: settings.updatedAt,
            expectedAuthorityVersion: authority.version,
          }
        )
        await t.finishAllScheduledFunctions(vi.runAllTimers)
        if (arm === "draft") await save(t, owner, pageId, [hero()], "fr")
        await archive(t)
        const c = await clocks(t, pageId, "fr")
        const before = await persisted(t)
        const result = t.run((ctx) =>
          publishPreparedTargetLocale(ctx, {
            transitionId,
            pageId,
            expectedTargetPublicGeneration: c.expectedPublicGeneration,
            expectedLifecycleGeneration: c.expectedLifecycleGeneration,
            expectedReleaseGeneration: c.expectedReleaseGeneration,
            ...(arm === "draft"
              ? {
                  arm,
                  expectedTargetDraftGeneration: c.expectedDraftGeneration,
                  expectedSharedDraftGeneration:
                    c.expectedSharedDraftGeneration,
                }
              : {
                  arm,
                  sourceSnapshotId: source.snapshotId,
                  sourcePublicGeneration: 1,
                }),
          })
        )
        if (arm === "frozen") {
          await expect(result).rejects.toThrow(refusal)
          expect(await persisted(t)).toEqual(before)
        } else {
          const prepared = await result
          expect(await snapshotSlices(t, prepared.candidateId)).toEqual([
            expect.objectContaining({ id: "admitted-hero" }),
          ])
          const first = (await publicationState(t, pageId, "fr"))!
          expect(first).toMatchObject({ pageType: "landing-page", publicSince: first.currentPublishedAt })
          await save(t, owner, pageId, [hero()], "fr")
          const next = await clocks(t, pageId, "fr")
          const republished = await t.run((ctx) => publishPreparedTargetLocale(ctx, {
            transitionId, pageId, arm: "draft",
            expectedTargetPublicGeneration: next.expectedPublicGeneration,
            expectedLifecycleGeneration: next.expectedLifecycleGeneration,
            expectedReleaseGeneration: next.expectedReleaseGeneration,
            expectedTargetDraftGeneration: next.expectedDraftGeneration,
            expectedSharedDraftGeneration: next.expectedSharedDraftGeneration,
          }))
          expect((await publicationState(t, pageId, "fr"))?.publicSince).toBe(first.publicSince)
          await t.run((ctx) => withdrawPreparedTargetLocale(ctx, {
            transitionId, pageId, expectedSnapshotId: republished.snapshotId,
            expectedPublicGeneration: republished.publicGeneration,
          }))
          expect((await publicationState(t, pageId, "fr"))?.pageType).toBeUndefined()
          expect((await publicationState(t, pageId, "fr"))?.publicSince).toBeUndefined()
        }
      }
    )
  })
})

// E1: two tabs of one owner. Each tab reads `getForEdit` for its base. The
// server compares each expected generation for strict equality, so a tab that
// sends the base it loaded is refused after the other tab saved. The editor's
// job (components/admin/page-editor tests) is to keep sending that base.
describe("E1 two tabs of one owner on one Page", () => {
  async function openTab(
    t: ReturnType<typeof convexTest>,
    pageId: Id<"pages">
  ) {
    const tab = t.withIdentity(OWNER)
    const view = await tab.query(api.cms.pages.getForEdit, { id: pageId })
    return { tab, base: view!.publication! }
  }
  type Opened = Awaited<ReturnType<typeof openTab>>
  const enGeneration = (opened: Opened) =>
    opened.base.locales.find((entry) => entry.locale === "en")!.draftGeneration
  function saveLocale(opened: Opened, pageId: Id<"pages">, title: string) {
    return opened.tab.mutation(api.cms.publication.saveEditorDraft, {
      pageId,
      expectedLifecycleGeneration: opened.base.lifecycleGeneration,
      localized: {
        locale: "en",
        slug: "snapshot-page",
        expectedGeneration: enGeneration(opened),
        draft: {
          pageType: "landing-page",
          localized: { title },
          slices: [],
        },
      },
    })
  }
  function saveShared(opened: Opened, pageId: Id<"pages">, ogTitle: string) {
    return opened.tab.mutation(api.cms.publication.saveEditorDraft, {
      pageId,
      expectedLifecycleGeneration: opened.base.lifecycleGeneration,
      shared: {
        expectedGeneration: opened.base.sharedDraftGeneration,
        seo: { ogTitle },
      },
    })
  }
  async function stored(t: ReturnType<typeof convexTest>) {
    return t.run(async (ctx) =>
      Promise.all(
        (
          [
            "pageLocaleDrafts",
            "pageSharedDrafts",
            "pageLocalePublicationStates",
            "pagePublishedSnapshots",
            "pageRevisions",
          ] as const
        ).map((table) => ctx.db.query(table).collect())
      )
    )
  }
  async function enDraftTitle(
    t: ReturnType<typeof convexTest>,
    pageId: Id<"pages">
  ) {
    const row = await t.run((ctx) =>
      ctx.db
        .query("pageLocaleDrafts")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", "en")
        )
        .unique()
    )
    return (row?.content as { title?: string } | undefined)?.title
  }

  test("a locale save from a stale base is refused, changes nothing and keeps the other tab's text; a re-read is accepted", sliceProfile([]), async () => {
    const t = app()
    const pageId = await installSnapshotFixture(t, t.withIdentity(OWNER))
    const tabA = await openTab(t, pageId)
    const tabB = await openTab(t, pageId)
    await saveLocale(tabB, pageId, "Written by B")
    const before = await stored(t)
    await expect(saveLocale(tabA, pageId, "Written by A")).rejects.toThrow(
      /PAGE_LOCALE_DRAFT_STALE/
    )
    expect(await stored(t)).toEqual(before)
    expect(await enDraftTitle(t, pageId)).toBe("Written by B")
    // Contrast: a tab that read the current state first is accepted.
    const reread = await openTab(t, pageId)
    await saveLocale(reread, pageId, "Written by A after a re-read")
    expect(await enDraftTitle(t, pageId)).toBe("Written by A after a re-read")
  })

  test("a shared save from a stale base is refused and changes nothing", sliceProfile([]), async () => {
    const t = app()
    const pageId = await installSnapshotFixture(t, t.withIdentity(OWNER))
    const tabA = await openTab(t, pageId)
    const tabB = await openTab(t, pageId)
    await saveShared(tabB, pageId, "B social title")
    const before = await stored(t)
    await expect(saveShared(tabA, pageId, "A social title")).rejects.toThrow(
      /PAGE_SHARED_DRAFT_STALE/
    )
    expect(await stored(t)).toEqual(before)
    // A language save does not send the shared base, so B's shared save does
    // not refuse it. That is why the editor must keep its shared base too.
    await saveLocale(tabA, pageId, "A title")
    expect(await enDraftTitle(t, pageId)).toBe("A title")
  })

  test("a publish after the other tab saved is refused and publishes nothing", sliceProfile([]), async () => {
    const t = app()
    const pageId = await installSnapshotFixture(t, t.withIdentity(OWNER))
    const tabA = await openTab(t, pageId)
    // A's Save resolves, then B (which read A's result) saves, then A publishes
    // from the generations of A's own Save.
    const saved = await saveLocale(tabA, pageId, "Written by A")
    const tabB = await openTab(t, pageId)
    await saveLocale(tabB, pageId, "Written by B")
    const before = await stored(t)
    await expect(
      tabA.tab.mutation(api.cms.publication.publishLocale, {
        pageId,
        locale: "en",
        expectedDraftGeneration: saved.draftGeneration!,
        expectedSharedDraftGeneration: tabA.base.sharedDraftGeneration,
        expectedPublicGeneration: 0,
        expectedLifecycleGeneration: tabA.base.lifecycleGeneration,
        expectedReleaseGeneration: 0,
      })
    ).rejects.toThrow(/STALE/)
    expect(await stored(t)).toEqual(before)
    expect(await enDraftTitle(t, pageId)).toBe("Written by B")
  })
})

// ED1REC literal server controls: no client/mock oracle supplies expectations.
describe("ED1REC real snapshot save refusal", () => {
  test(
    "R7 generation literals and missing-row sentinel are accepted by validators and refused atomically",
    sliceProfile(["hero-agency"]),
    async () => {
      const t = app()
      const owner = t.withIdentity(OWNER)
      const pageId = await installSnapshotFixture(t, owner)
      await t.run(async (ctx) => {
        const state = await ctx.db
          .query("pageLocalePublicationStates")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", pageId).eq("locale", "en")
          )
          .unique()
        const shared = await ctx.db
          .query("pageSharedDrafts")
          .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
          .unique()
        const life = await ctx.db
          .query("pagePublicationPageStates")
          .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
          .unique()
        await ctx.db.patch("pageLocalePublicationStates", state!._id, { draftGeneration: 5 })
        await ctx.db.patch("pageSharedDrafts", shared!._id, { generation: 6 })
        await ctx.db.patch("pagePublicationPageStates", life!._id, { lifecycleGeneration: 3 })
      })
      const stored = () =>
        t.run(async (ctx) =>
          Promise.all([
            ctx.db.query("pageLocaleDrafts").collect(),
            ctx.db.query("pageLocalePublicationStates").collect(),
            ctx.db.query("pageSharedDrafts").collect(),
            ctx.db.query("pagePublishedSnapshots").collect(),
          ])
        )
      const before = await stored()
      const localized = {
        locale: "en",
        slug: "snapshot-page",
        expectedGeneration: 4,
        draft: {
          pageType: "landing-page" as const,
          localized: { title: "Recovered" },
          slices: [],
        },
      }
      await expect(
        owner.mutation(api.cms.publication.saveEditorDraft, {
          pageId,
          expectedLifecycleGeneration: 3,
          localized,
        })
      ).rejects.toThrow("PAGE_LOCALE_DRAFT_STALE")
      // These are exactly R2's post-Restore expectations, including the common guard.
      await expect(
        owner.mutation(api.cms.publication.saveEditorDraft, {
          pageId,
          expectedLifecycleGeneration: -1,
          localized,
          shared: {
            expectedGeneration: 6,
            seo: { ogTitle: "Recovered social" },
          },
        })
      ).rejects.toThrow("PAGE_PUBLICATION_LIFECYCLE_STALE")
      await expect(
        owner.mutation(api.cms.publication.saveEditorDraft, {
          pageId,
          expectedLifecycleGeneration: 3,
          shared: {
            expectedGeneration: 5,
            seo: { ogTitle: "Recovered social" },
          },
        })
      ).rejects.toThrow("PAGE_SHARED_DRAFT_STALE")
      // Exactly R4's missing-base literals; v.number accepts -1 (not a validator error).
      await expect(
        owner.mutation(api.cms.publication.saveEditorDraft, {
          pageId,
          expectedLifecycleGeneration: -1,
          localized: { ...localized, expectedGeneration: -1 },
          shared: {
            expectedGeneration: -1,
            seo: { ogTitle: "Recovered social" },
          },
        })
      ).rejects.toThrow("PAGE_PUBLICATION_LIFECYCLE_STALE")
      await expect(
        owner.mutation(api.cms.publication.saveLocaleDraft, {
          pageId,
          expectedLifecycleGeneration: -1,
          locale: "en",
          slug: "snapshot-page",
          draft: localized.draft,
          expectedDraftGeneration: 5,
        })
      ).rejects.toThrow("PAGE_PUBLICATION_LIFECYCLE_STALE")
      await expect(
        owner.mutation(api.cms.publication.saveSharedDraft, {
          pageId,
          expectedLifecycleGeneration: -1,
          expectedSharedDraftGeneration: 6,
          seo: { ogTitle: "Recovered social" },
        })
      ).rejects.toThrow("PAGE_PUBLICATION_LIFECYCLE_STALE")
      expect(await stored()).toEqual(before)
      // Missing locale state must still compare against 0, never accept any token.
      await t.run(async (ctx) => {
        const state = await ctx.db
          .query("pageLocalePublicationStates")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", pageId).eq("locale", "en")
          )
          .unique()
        await ctx.db.delete("pageLocalePublicationStates", state!._id)
      })
      await expect(
        owner.mutation(api.cms.publication.saveEditorDraft, {
          pageId,
          expectedLifecycleGeneration: 3,
          localized: { ...localized, expectedGeneration: -1 },
        })
      ).rejects.toThrow("PAGE_LOCALE_DRAFT_STALE")
      await expect(
        owner.mutation(api.cms.publication.saveLocaleDraft, {
          pageId,
          expectedLifecycleGeneration: 3,
          locale: "en",
          slug: "snapshot-page",
          draft: localized.draft,
          expectedDraftGeneration: -1,
        })
      ).rejects.toThrow("PAGE_LOCALE_DRAFT_STALE")
    }
  )
})
