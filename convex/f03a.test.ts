import { createSampleSlice } from "@/convex/lib/slices/sample"
/// <reference types="vite/client" />

import { sliceProfile } from "@/test-utils/slice-profile"
import { readFile } from "node:fs/promises"
import { convexTest } from "../convexTestWithExplicitAdmin"
import { describe, expect, test } from "vitest"
import { api } from "./_generated/api"
import { isActiveContentType } from "./lib/contentTypes"

import schema from "./schema"
import { readSlicePresentationCatalog } from "./lib/slices/presentations"

const modules = import.meta.glob("./**/*.ts")
const owner = {
  subject: "f03a-owner",
  tokenIdentifier: "https://issuer.test|f03a-owner",
  email: "owner@example.test",
}
const unrelated = {
  subject: "f03a-unrelated",
  tokenIdentifier: "https://issuer.test|f03a-unrelated",
  email: "unrelated@example.test",
}

async function makeOwnerTest() {
  const t = convexTest(schema, modules)
  await t.run((ctx) =>
    ctx.db.insert("cmsOwner", {
      key: "owner",
      authId: owner.subject,
      tokenIdentifier: owner.tokenIdentifier,
      establishedAt: 1,
      updatedAt: 1,
    })
  )
  return t
}

describe("F03a owner operation access", () => {
  test("guards the current presentation catalog and returns the owned source snapshot", sliceProfile([]), async () => {
    const t = await makeOwnerTest()
    await expect(
      t.query(api.cms.slices.getPresentationCatalog, {})
    ).rejects.toThrow("UNAUTHENTICATED")
    await expect(
      t.withIdentity(unrelated).query(api.cms.slices.getPresentationCatalog, {})
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
    const catalog = await t
      .withIdentity(owner)
      .query(api.cms.slices.getPresentationCatalog, {})
    expect(catalog).toEqual(await readSlicePresentationCatalog())
    expect(
      catalog.entries
        .filter((entry) => entry.type === "hero-with-image")
        .map((entry) => entry.id)
    ).toEqual(["default", "centered"])
  })
  test("inventory routes the F03a private boundary through operation access", async () => {
    for (const file of [
      "convex/cms/pages.ts",
      "convex/cms/media.ts",
      "convex/cms/settings.ts",
      "convex/cms/contentTypes.ts",
      "convex/cms/relations.ts",
      "convex/cms/slices.ts",
      "convex/lib/slices/permissions.ts",
    ]) {
      const source = await readFile(file, "utf8")
      expect(source).toContain("requireOperationAccess")
      expect(source).not.toContain('from "../lib/authHelpers"')
      expect(source).not.toContain("auth.permissions")
    }
  })

  test("denies unrelated private content and settings operations while the owner succeeds", async () => {
    const t = await makeOwnerTest()
    const asOwner = t.withIdentity(owner)
    const asUnrelated = t.withIdentity(unrelated)

    const pageId = await asOwner.mutation(api.cms.pages.create, {
      pageType: "page",
      status: "draft",
      title: "Private draft",
    })
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["image"], { type: "image/png" }))
    )
    const mediaId = await asOwner.mutation(api.cms.media.create, {
      filename: "private.png",
      storageId,
      size: 5,
      mimeType: "image/png",
    })

    await expect(
      asUnrelated.query(api.cms.pages.getById, { id: pageId })
    ).resolves.toBeNull()
    await expect(
      asUnrelated.mutation(api.cms.pages.update, {
        id: pageId,
        expectedUpdatedAt: 0,
        title: "Denied",
      })
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
    await expect(
      asUnrelated.query(api.cms.media.getById, { id: mediaId })
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
    await expect(
      asUnrelated.mutation(api.cms.settings.markOnboardingStep, {
        step: "account",
      })
    ).rejects.toThrow("CMS_OWNER_REQUIRED")

    await expect(
      asOwner.mutation(api.cms.settings.markOnboardingStep, {
        step: "account",
      })
    ).resolves.toBeNull()
    await expect(
      asOwner.query(api.cms.media.getById, { id: mediaId })
    ).resolves.toMatchObject({ _id: mediaId })
    await expect(
      asUnrelated.query(api.cms.contentTypes.getContentTypeUsage, {})
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
    await expect(
      asUnrelated.query(api.cms.slices.getArchivedSliceTypes, {})
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
    await expect(
      asUnrelated.query(api.cms.relations.getReferenceCard, {
        id: pageId,
        locale: "en",
      })
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
    await expect(
      asUnrelated.query(api.cms.relations.searchTargets, {
        pageTypes: ["page"],
        locale: "en",
      })
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
    await expect(
      t.query(api.cms.relations.searchTargets, {
        pageTypes: [],
        locale: "en",
      })
    ).rejects.toThrow("UNAUTHENTICATED")
    await expect(
      asUnrelated.query(api.cms.relations.searchTargets, {
        pageTypes: [],
        locale: "en",
      })
    ).rejects.toThrow("CMS_OWNER_REQUIRED")

    await expect(
      asOwner.mutation(api.cms.contentTypes.setContentTypeArchived, {
        type: "post",
        archived: true,
      })
    ).resolves.toContain("post")
    await expect(
      asOwner.query(api.cms.relations.getReferenceCard, {
        id: pageId,
        locale: "en",
      })
    ).resolves.toMatchObject({ id: pageId })
    await expect(
      asOwner.query(api.cms.relations.searchTargets, {
        pageTypes: ["page"],
        locale: "en",
      })
    ).resolves.toEqual([expect.objectContaining({ id: pageId })])
    await t.run((ctx) => ctx.db.patch(pageId, { deletedAt: Date.now() }))
    await expect(
      t.query(api.cms.relations.getReferenceCard, {
        id: pageId,
        locale: "en",
      })
    ).rejects.toThrow("UNAUTHENTICATED")
    await expect(
      asUnrelated.query(api.cms.relations.getReferenceCard, {
        id: pageId,
        locale: "en",
      })
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
  })

  test("keeps published projection public and keeps an unpublished page private", async () => {
    const t = await makeOwnerTest()
    const { publishedId, draftId } = await t.run(async (ctx) => {
      const now = Date.now()
      const publishedId = await ctx.db.insert("pages", {
        slug: "f03a-published",
        pageType: "page",
        status: "published",
        createdAt: now,
        updatedAt: now,
        publishedAt: now,
        content: { en: { title: "Public page", slices: [] } },
      })
      const draftId = await ctx.db.insert("pages", {
        slug: "f03a-draft",
        pageType: "page",
        status: "draft",
        createdAt: now,
        updatedAt: now,
        content: { en: { title: "Private draft", slices: [] } },
      })
      return { publishedId, draftId }
    })

    await expect(
      t.query(api.cms.pages.getPublicPageById, {
        languageVersion: 0,
        id: publishedId,
        locale: "en",
      })
    ).resolves.toMatchObject({ _id: publishedId })
    await expect(
      t.query(api.cms.pages.getPublicPageById, {
        languageVersion: 0,
        id: draftId,
        locale: "en",
      })
    ).resolves.toBeNull()
  })

  test("denies missing private media before revealing whether its row exists", async () => {
    const t = await makeOwnerTest()
    const asOwner = t.withIdentity(owner)
    const asUnrelated = t.withIdentity(unrelated)
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["image"], { type: "image/png" }))
    )
    const mediaId = await asOwner.mutation(api.cms.media.create, {
      filename: "removed.png",
      storageId,
      size: 5,
      mimeType: "image/png",
    })
    await t.run((ctx) => ctx.db.delete(mediaId))

    await expect(
      t.query(api.cms.media.getById, { id: mediaId })
    ).rejects.toThrow("UNAUTHENTICATED")
    await expect(
      asUnrelated.query(api.cms.media.getById, { id: mediaId })
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
    await expect(
      asUnrelated.mutation(api.cms.media.softDelete, { id: mediaId })
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
  })

  test("gates missing private page queries and mutations before lookup", async () => {
    const t = await makeOwnerTest()
    const asUnrelated = t.withIdentity(unrelated)
    const missingPageId = await t.run(async (ctx) => {
      const now = Date.now()
      const id = await ctx.db.insert("pages", {
        slug: "f03a-deleted-page",
        pageType: "page",
        status: "draft",
        createdAt: now,
        updatedAt: now,
        content: { en: { title: "Deleted page", slices: [] } },
      })
      await ctx.db.delete(id)
      return id
    })

    await expect(
      t.mutation(api.cms.pages.softDelete, { id: missingPageId })
    ).rejects.toThrow("UNAUTHENTICATED")
    await expect(
      asUnrelated.mutation(api.cms.pages.softDelete, { id: missingPageId })
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
  })

  test("does not expose inactive content-type storage arms through ordinary private readers", async () => {
    expect(isActiveContentType("testimonial")).toBe(false)
    const t = await makeOwnerTest()
    const asOwner = t.withIdentity(owner)
    const testimonialId = await t.run(async (ctx) => {
      const now = Date.now()
      return await ctx.db.insert("pages", {
        slug: "f03a-inactive-testimonial",
        pageType: "testimonial",
        status: "draft",
        personName: "Archived storage arm",
        content: {
          en: { title: "Private testimonial", quote: "Not listable" },
        },
        createdAt: now,
        updatedAt: now,
      })
    })

    await expect(
      asOwner.query(api.cms.pages.list, { pageType: "testimonial" })
    ).rejects.toThrow('Content Type "testimonial" is not active')
    await expect(
      asOwner.query(api.cms.pages.getByIds, { ids: [testimonialId] })
    ).resolves.toEqual([])
    await expect(
      asOwner.query(api.cms.pages.getById, { id: testimonialId })
    ).resolves.toBeNull()
    await expect(
      asOwner.query(api.cms.pages.getBySlug, {
        slug: "f03a-inactive-testimonial",
      })
    ).resolves.toBeNull()

    const publishedTestimonialId = await t.run(async (ctx) => {
      const now = Date.now()
      return await ctx.db.insert("pages", {
        slug: "f03a-inactive-published-testimonial",
        pageType: "testimonial",
        status: "published",
        personName: "Archived published storage arm",
        content: {
          en: { title: "Published testimonial", quote: "Still private" },
        },
        createdAt: now,
        updatedAt: now,
        publishedAt: now,
      })
    })
    await expect(
      asOwner.query(api.cms.pages.getPublishedById, {
        id: publishedTestimonialId,
      })
    ).resolves.toBeNull()
  })

  test("keeps archived slice types out of owner-authored content", sliceProfile(["hero-agency"]), async () => {
    const t = await makeOwnerTest()
    const asOwner = t.withIdentity(owner)
    await asOwner.mutation(api.cms.settings.markOnboardingStep, {
      step: "account",
    })
    await t.run(async (ctx) => {
      const settings = await ctx.db.query("siteSettings").first()
      if (!settings) throw new Error("settings fixture missing")
      await ctx.db.patch(settings._id, {
        archivedSliceTypes: ["hero-agency"],
      })
    })

    await expect(
      asOwner.mutation(api.cms.pages.create, {
        pageType: "page",
        status: "draft",
        title: "Archived slice rejection",
        content: {
          en: {
            title: "Archived slice rejection",
            slices: [createSampleSlice("hero-agency")],
          },
        },
      })
    ).rejects.toThrow('Archived Block Type "hero-agency" cannot be added')
  })
})
