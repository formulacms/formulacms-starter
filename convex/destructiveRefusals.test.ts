/// <reference types="vite/client" />

import { sliceProfile } from "@/test-utils/slice-profile"
import { ConvexError, type Value } from "convex/values"
import { describe, expect, test } from "vitest"
import { api } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { refreshMenuReferences } from "./lib/menu/references"
import type { Slice } from "./lib/slices"
import { convexTest } from "../convexTestWithExplicitAdmin"
import schema from "./schema"

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "destructive-refusal-owner",
  tokenIdentifier: "https://convex.test|destructive-refusal-owner",
}

function app() {
  return convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
    publicationAuthority: "missing",
  })
}

async function activeFixture() {
  const t = app()
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
      siteName: "Deletion guard test",
      siteUrl: "",
      defaultLocale: "en",
      enabledLocales: ["en"],
      homePageId,
      updatedAt: Date.now(),
    })
  )
  return { t, owner }
}

async function publishEn(
  owner: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
  pageId: Id<"pages">
) {
  return owner.mutation(api.cms.publication.publishLocale, {
    pageId,
    locale: "en",
    expectedDraftGeneration: 1,
    expectedSharedDraftGeneration: 1,
    expectedPublicGeneration: 0,
    expectedLifecycleGeneration: 1,
    expectedReleaseGeneration: 0,
  })
}

async function rejectionData(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ConvexError)
    return (error as ConvexError<Value>).data
  }
  throw new Error("Expected mutation to reject")
}

async function createStoredMedia(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const storageId = await ctx.storage.store(
      new Blob(["test image"], { type: "image/png" })
    )
    const mediaId = await ctx.db.insert("media", {
      filename: "reference.png",
      storageId,
      url: "https://example.test/reference.png",
      size: 10,
      mimeType: "image/png",
      width: 1200,
      height: 800,
      uploadedAt: Date.now(),
    })
    return { mediaId, storageId }
  })
}

function imageSlice(storageId: Id<"_storage">): Slice {
  return {
    id: "image",
    type: "hero-with-image",
    enabled: true,
    primary: {
      eyebrow: "Media",
      eyebrowLink: { type: "none" },
      title: "Referenced image",
      description: JSON.stringify({
        type: "doc",
        content: [{ type: "paragraph" }],
      }),
      image: {
        storageId,
        url: "https://example.test/reference.png",
        width: 1200,
        height: 800,
        alt: "Referenced image",
      },
    },
    items: [],
  } as Slice
}

describe("snapshot Page destructive refusals", () => {
  test("live Menu references refuse before writes while archive and restore remain available", async () => {
    const { t, owner } = await activeFixture()
    const pageId = await owner.mutation(api.cms.pages.create, {
      pageType: "page",
      status: "draft",
      slug: "menu-target",
      title: "Menu target",
      content: { en: { title: "Menu target", slices: [] } },
    })
    const menuId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("menus", {
        slug: "primary",
        nav: [
          {
            id: "menu-target",
            label: { en: "Menu target" },
            target: { type: "internal", pageId },
          },
        ],
        updatedAt: 1,
      })
      const menu = await ctx.db.get(id)
      if (!menu) throw new Error("Menu fixture missing")
      await refreshMenuReferences(ctx, menu)
      return id
    })

    const archived = await owner.mutation(api.cms.publication.archivePage, {
      pageId,
      expectedLifecycleGeneration: 1,
    })
    const restored = await owner.mutation(api.cms.publication.restorePage, {
      pageId,
      expectedLifecycleGeneration: archived.lifecycleGeneration,
    })
    const before = await t.run(async (ctx) => ({
      pageState: await ctx.db
        .query("pagePublicationPageStates")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique(),
      menu: await ctx.db.get(menuId),
      references: await ctx.db
        .query("menuReferences")
        .withIndex("by_target", (q) => q.eq("targetId", pageId))
        .collect(),
      intents: await ctx.db
        .query("pagePublicationRevalidationIntents")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId)
        )
        .collect(),
    }))

    expect(
      await rejectionData(
        owner.mutation(api.cms.publication.softDeletePage, {
          pageId,
          expectedLifecycleGeneration: restored.lifecycleGeneration,
        })
      )
    ).toEqual({
      code: "PAGE_SOFT_DELETE_MENU_REFERENCE",
      menus: [{ menuId, slug: "primary" }],
      truncated: false,
    })

    const after = await t.run(async (ctx) => ({
      pageState: await ctx.db
        .query("pagePublicationPageStates")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique(),
      menu: await ctx.db.get(menuId),
      references: await ctx.db
        .query("menuReferences")
        .withIndex("by_target", (q) => q.eq("targetId", pageId))
        .collect(),
      intents: await ctx.db
        .query("pagePublicationRevalidationIntents")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId)
        )
        .collect(),
    }))
    expect(after).toEqual(before)

    await owner.mutation(api.cms.menus.softDelete, { id: menuId })
    await expect(
      owner.mutation(api.cms.publication.softDeletePage, {
        pageId,
        expectedLifecycleGeneration: restored.lifecycleGeneration,
      })
    ).resolves.toEqual({
      pageId,
      lifecycleGeneration: restored.lifecycleGeneration + 1,
    })
  })

  test("a current published Post byline refuses Author deletion without treating candidate history as current", async () => {
    const { t, owner } = await activeFixture()
    const authorId = await owner.mutation(api.cms.pages.create, {
      pageType: "author",
      status: "draft",
      slug: "ada",
      title: "Ada",
      name: "Ada",
      content: { en: { title: "Ada", slices: [] } },
    })
    const postId = await owner.mutation(api.cms.pages.create, {
      pageType: "post",
      status: "draft",
      slug: "proof",
      title: "Proof",
      authorIds: [authorId],
      content: { en: { title: "Proof", slices: [] } },
    })
    await publishEn(owner, authorId)
    const postPublication = await publishEn(owner, postId)
    const before = await t.run(async (ctx) => ({
      authorState: await ctx.db
        .query("pagePublicationPageStates")
        .withIndex("by_pageId", (q) => q.eq("pageId", authorId))
        .unique(),
      references: await ctx.db
        .query("pagePublicationDocumentReferences")
        .withIndex("by_targetId", (q) => q.eq("targetId", authorId))
        .collect(),
      intents: await ctx.db
        .query("pagePublicationRevalidationIntents")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", authorId)
        )
        .collect(),
    }))

    expect(
      await rejectionData(
        owner.mutation(api.cms.publication.softDeletePage, {
          pageId: authorId,
          expectedLifecycleGeneration: 1,
        })
      )
    ).toEqual({
      code: "PAGE_SOFT_DELETE_PUBLISHED_POST_REFERENCE",
      posts: [
        {
          pageId: postId,
          locale: "en",
          sourcePath: "authorIds[0]",
        },
      ],
      truncated: false,
    })

    const after = await t.run(async (ctx) => ({
      authorState: await ctx.db
        .query("pagePublicationPageStates")
        .withIndex("by_pageId", (q) => q.eq("pageId", authorId))
        .unique(),
      references: await ctx.db
        .query("pagePublicationDocumentReferences")
        .withIndex("by_targetId", (q) => q.eq("targetId", authorId))
        .collect(),
      intents: await ctx.db
        .query("pagePublicationRevalidationIntents")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", authorId)
        )
        .collect(),
    }))
    expect(after).toEqual(before)

    await owner.mutation(api.cms.publication.withdrawLocale, {
      pageId: postId,
      locale: "en",
      expectedSnapshotId: postPublication.snapshotId,
      expectedPublicGeneration: postPublication.publicGeneration,
      expectedLifecycleGeneration: 1,
    })
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("pagePublicationDocumentReferences")
          .withIndex("by_targetId_and_sourceKind_and_locale", (q) =>
            q.eq("targetId", authorId).eq("sourceKind", "candidate")
          )
          .take(1)
      )
    ).toHaveLength(1)
    await expect(
      owner.mutation(api.cms.publication.softDeletePage, {
        pageId: authorId,
        expectedLifecycleGeneration: 1,
      })
    ).resolves.toEqual({ pageId: authorId, lifecycleGeneration: 2 })
  })
})

describe("media soft-delete destructive refusals", () => {
  test("a snapshot Working Draft reference refuses before changing media or reference rows", sliceProfile(["hero-with-image"]), async () => {
    const { t, owner } = await activeFixture()
    const media = await createStoredMedia(t)
    const pageId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "draft-image",
      title: "Draft image",
      content: {
        en: {
          title: "Draft image",
          slices: [imageSlice(media.storageId)],
        },
      },
    })
    const before = await t.run(async (ctx) => ({
      media: await ctx.db.get(media.mediaId),
      references: await ctx.db
        .query("pagePublicationMediaReferences")
        .withIndex("by_mediaId", (q) => q.eq("mediaId", media.mediaId))
        .collect(),
    }))

    expect(
      await rejectionData(
        owner.mutation(api.cms.media.softDelete, { id: media.mediaId })
      )
    ).toEqual({
      code: "MEDIA_SOFT_DELETE_REFERENCED",
      pageIds: [],
      settings: [],
      snapshotReferences: [
        {
          pageId,
          locale: "en",
          sourceKind: "locale_draft",
          sourcePath: "content.en.slices[0].primary.image",
        },
      ],
      truncated: false,
    })

    const after = await t.run(async (ctx) => ({
      media: await ctx.db.get(media.mediaId),
      references: await ctx.db
        .query("pagePublicationMediaReferences")
        .withIndex("by_mediaId", (q) => q.eq("mediaId", media.mediaId))
        .collect(),
    }))
    expect(after).toEqual(before)
  })

  test("a current snapshot refuses, then candidate-only history permits the owner control", sliceProfile(["hero-with-image"]), async () => {
    const { t, owner } = await activeFixture()
    const media = await createStoredMedia(t)
    const pageId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "published-image",
      title: "Published image",
      content: {
        en: {
          title: "Published image",
          slices: [imageSlice(media.storageId)],
        },
      },
    })
    const publication = await publishEn(owner, pageId)
    await owner.mutation(api.cms.publication.saveLocaleDraft, {
      pageId,
      locale: "en",
      slug: "published-image",
      draft: {
        pageType: "landing-page",
        localized: { title: "Published image" },
        slices: [],
      },
      expectedDraftGeneration: 1,
      expectedLifecycleGeneration: 1,
    })
    const before = await t.run(async (ctx) => ({
      media: await ctx.db.get(media.mediaId),
      references: await ctx.db
        .query("pagePublicationMediaReferences")
        .withIndex("by_mediaId", (q) => q.eq("mediaId", media.mediaId))
        .collect(),
    }))

    expect(
      await rejectionData(
        owner.mutation(api.cms.media.softDelete, { id: media.mediaId })
      )
    ).toEqual({
      code: "MEDIA_SOFT_DELETE_REFERENCED",
      pageIds: [],
      settings: [],
      snapshotReferences: [
        {
          pageId,
          locale: "en",
          sourceKind: "current_public",
          sourcePath: "content.en.slices[0].primary.image",
        },
      ],
      truncated: false,
    })
    const after = await t.run(async (ctx) => ({
      media: await ctx.db.get(media.mediaId),
      references: await ctx.db
        .query("pagePublicationMediaReferences")
        .withIndex("by_mediaId", (q) => q.eq("mediaId", media.mediaId))
        .collect(),
    }))
    expect(after).toEqual(before)

    await owner.mutation(api.cms.publication.withdrawLocale, {
      pageId,
      locale: "en",
      expectedSnapshotId: publication.snapshotId,
      expectedPublicGeneration: publication.publicGeneration,
      expectedLifecycleGeneration: 1,
    })
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("pagePublicationMediaReferences")
          .withIndex("by_mediaId", (q) => q.eq("mediaId", media.mediaId))
          .collect()
      )
    ).toEqual([
      expect.objectContaining({
        pageId,
        sourceKind: "candidate",
      }),
    ])
    await owner.mutation(api.cms.media.softDelete, { id: media.mediaId })
    await expect(t.run((ctx) => ctx.db.get(media.mediaId))).resolves.toMatchObject({
      deletedAt: expect.any(Number),
    })
  })
})
