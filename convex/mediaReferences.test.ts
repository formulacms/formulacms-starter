/// <reference types="vite/client" />
import { sliceProfile } from "@/test-utils/slice-profile"
import { convexTest } from "convex-test"
import { describe, expect, test, vi } from "vitest"
import schema from "./schema"
import { collectMediaReferences, refreshMediaReferencesForPage } from "./lib/mediaReferences"
import type { Doc } from "./_generated/dataModel"
import * as slices from "./lib/slices"
import { group, image, link, list, text } from "./lib/slices/primitives"

const modules = import.meta.glob("./**/*.ts")

/**
 * Plan 029 C10 — descriptor-image walker in `collectMediaReferences`.
 *
 * Testimonial's `personImage` is the first descriptor-level `image()`
 * field (`sliceBody: false`, no card image path, no slice canvas). The
 * walker must emit a `descriptor-image` reference row for it or the
 * media asset gets orphan-swept when task 13 wires the pure-form writer.
 *
 * The regression scenarios:
 * 1. Testimonial with `personImage` mediaId → one row, source
 *    `descriptor-image`, path `personImage`.
 * 2. Clearing `personImage` on refresh → row removed.
 * 3. Slice-body arm without descriptor-level images → no descriptor rows
 *    (regression guard: pre-C10 the walker only saw card + slice images).
 */

async function createTestImage(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const storageId = await ctx.storage.store(
      new Blob(["x"], { type: "image/png" }),
    )
    const mediaId = await ctx.db.insert("media", {
      filename: "person.png",
      storageId,
      url: "https://example.com/person.png",
      size: 1,
      mimeType: "image/png",
      uploadedAt: Date.now(),
    })
    return { mediaId, storageId }
  })
}

describe("mediaReferences descriptor-image walker", () => {
  test("job applyUrl media link is retained by the shared descriptor walker", async () => {
    const t = convexTest(schema, modules)
    const media = await createTestImage(t)
    await t.run(async (ctx) => {
      const pageId = await ctx.db.insert("pages", {
        slug: "job", pageType: "job", status: "draft",
        remoteType: "remote", employmentType: "full-time", salaryCurrency: "USD",
        salaryMin: 0, salaryMax: 0, jobStatus: "open",
        applyUrl: { type: "media", mediaId: media.mediaId },
        content: { en: { title: "Job", slices: [] } },
        createdAt: Date.now(), updatedAt: Date.now(),
      })
      await refreshMediaReferencesForPage(ctx, (await ctx.db.get(pageId))!)
      expect(await ctx.db.query("mediaReferences")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId)).take(10))
        .toEqual([expect.objectContaining({
          mediaId: media.mediaId, storageId: media.storageId, path: "applyUrl",
          source: "slice-media-link",
        })])
    })
  })

  // hero-with-image.items[].icon is a shipped item image. Named primary lists
  // use this fixture to exercise the same walker without changing the schema.
  test("named primary list links and item images share the media leaf rule", sliceProfile([]), async () => {
    const t = convexTest(schema, modules)
    const media = await createTestImage(t)
    const row = group({ destination: link(), picture: image().optional(), caption: text() })
    const descriptor = {
      ...slices.heroWithImageDef,
      primary: group({ downloads: list(row, { max: 50 }) }),
      items: list(row, { max: 50 }),
    }
    const spy = vi.spyOn(slices, "readSliceDefinition").mockReturnValue(descriptor)
    try {
      const page = {
        pageType: "landing-page",
        content: { en: { title: "Downloads", slices: [{
          id: "downloads", type: "hero-with-image", enabled: true,
          primary: { downloads: [
            { destination: { type: "media", mediaId: media.mediaId }, caption: "Download" },
            { destination: { type: "external", url: "https://example.com" }, caption: JSON.stringify(media) },
            { destination: { type: "none" }, caption: "Cleared" },
          ] },
          items: [{ destination: { type: "none" }, picture: { storageId: media.storageId }, caption: "Legacy row without ID" }],
        }] } },
      } as unknown as Doc<"pages">
      expect(collectMediaReferences(page)).toEqual([
        expect.objectContaining({ mediaId: media.mediaId, locale: "en", path: "content.en.slices[0].primary.downloads[0].destination", source: "slice-media-link" }),
        { storageId: media.storageId, locale: "en", path: "content.en.slices[0].items[0].picture", source: "slice-image" },
      ])
    } finally {
      spy.mockRestore()
    }
  })

  test("testimonial with personImage emits a descriptor-image row at path personImage", async () => {
    const t = convexTest(schema, modules)
    const { mediaId, storageId } = await createTestImage(t)

    await t.run(async (ctx) => {
      const now = Date.now()
      const pageId = await ctx.db.insert("pages", {
        slug: "grace-hopper",
        pageType: "testimonial",
        status: "published",
        personName: "Grace Hopper",
        personImage: { storageId, url: "https://example.com/person.png" },
        content: {
          en: { title: "GH internal", quote: "Something." },
          fr: { title: "GH interne", quote: "Quelque chose." },
          ar: { title: "GH داخلي", quote: "شيء ما." },
        },
        localizedSlugs: { en: "grace-hopper" },
        createdAt: now,
        updatedAt: now,
      })
      const doc = await ctx.db.get(pageId)
      expect(doc).not.toBeNull()

      await refreshMediaReferencesForPage(ctx, doc!)

      const rows = await ctx.db.query("mediaReferences").take(10)
      expect(rows.length).toBe(1)
      expect(rows[0]!.source).toBe("descriptor-image")
      expect(rows[0]!.path).toBe("personImage")
      expect(rows[0]!.mediaId).toBe(mediaId)
      expect(rows[0]!.locale).toBeUndefined()
    })
  })

  test("clearing personImage on refresh removes the row", async () => {
    const t = convexTest(schema, modules)
    const { storageId } = await createTestImage(t)

    await t.run(async (ctx) => {
      const now = Date.now()
      const pageId = await ctx.db.insert("pages", {
        slug: "grace-hopper",
        pageType: "testimonial",
        status: "published",
        personName: "Grace Hopper",
        personImage: { storageId, url: "https://example.com/person.png" },
        content: {
          en: { title: "GH internal", quote: "Something." },
          fr: { title: "GH interne", quote: "Quelque chose." },
          ar: { title: "GH داخلي", quote: "شيء ما." },
        },
        localizedSlugs: { en: "grace-hopper" },
        createdAt: now,
        updatedAt: now,
      })
      const doc = await ctx.db.get(pageId)
      await refreshMediaReferencesForPage(ctx, doc!)
      expect((await ctx.db.query("mediaReferences").take(5)).length).toBe(1)

      await ctx.db.patch(pageId, { personImage: undefined })
      const cleared = await ctx.db.get(pageId)
      await refreshMediaReferencesForPage(ctx, cleared!)

      const rows = await ctx.db.query("mediaReferences").take(5)
      expect(rows).toEqual([])
    })
  })

  test("slice-body arm without descriptor-level images emits no descriptor-image rows", async () => {
    const t = convexTest(schema, modules)

    await t.run(async (ctx) => {
      const now = Date.now()
      const pageId = await ctx.db.insert("pages", {
        slug: "a-post",
        pageType: "post",
        status: "draft",
        content: {
          en: { title: "Post", slices: [] },
          fr: { title: "Article", slices: [] },
          ar: { title: "مقال", slices: [] },
        },
        localizedSlugs: { en: "a-post" },
        featured: false,
        promoteToFront: false,
        createdAt: now,
        updatedAt: now,
      })
      const doc = await ctx.db.get(pageId)
      await refreshMediaReferencesForPage(ctx, doc!)

      const rows = await ctx.db.query("mediaReferences").take(5)
      expect(rows.filter((r) => r.source === "descriptor-image")).toEqual([])
    })
  })
})
