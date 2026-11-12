/// <reference types="vite/client" />
import { sliceProfile } from "@/test-utils/slice-profile"
import { convexTest } from "../convexTestWithExplicitAdmin"
import { describe, expect, test, vi } from "vitest"
import { api } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import type { Slice } from "./lib/slices"
import { IMAGE_DIMENSION_FIXTURES } from "./lib/media/imageDimensions.testFixtures"
import schema from "./schema"
import rateLimiterTest from "@convex-dev/rate-limiter/test"

const modules = import.meta.glob("./**/*.ts")

const TEST_USER = {
  subject: "test-user",
  tokenIdentifier: "https://convex.test|test-user",
  name: "Test User",
  email: "test@example.com",
}

function mediaTest() {
  return convexTest({
    schema,
    modules,
    ownerIdentity: TEST_USER,
  })
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

async function createStoredMedia(
  t: ReturnType<typeof convexTest>,
  filename = "image.png"
) {
  return t.run(async (ctx) => {
    const storageId = await ctx.storage.store(
      new Blob(["test image"], { type: "image/png" })
    )
    const mediaId = await ctx.db.insert("media", {
      filename,
      storageId,
      url: `https://example.com/${filename}`,
      size: 10,
      mimeType: "image/png",
      uploadedAt: Date.now(),
    })
    return { mediaId, storageId, url: `https://example.com/${filename}` }
  })
}

type HeroAgencySlice = Extract<Slice, { type: "hero-agency" }>
type HeroWithImageSlice = Extract<Slice, { type: "hero-with-image" }>

describe("media URL import", () => {
  test.each(IMAGE_DIMENSION_FIXTURES)(
    "persists $name intrinsic dimensions parsed from the downloaded image",
    async ({ filename, mimeType, width, height, bytes }) => {
      const t = mediaTest()
      rateLimiterTest.register(t)
      const asUser = t.withIdentity(TEST_USER)
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          return new Response(toArrayBuffer(bytes), {
            status: 200,
            headers: {
              "content-type": mimeType,
              "content-length": String(bytes.byteLength),
            },
          })
        })
      )

      try {
        const mediaId = await asUser.action(api.cms.media.importFromUrl, {
          url: `https://cdn.example.com/${filename}`,
        })

        const media = await t.run((ctx) => ctx.db.get(mediaId))
        expect(media).toMatchObject({
          mimeType,
          width,
          height,
        })
      } finally {
        vi.unstubAllGlobals()
      }
    }
  )

  test("rejects a redirect to a private address before fetching that hop", async () => {
    const t = mediaTest()
    rateLimiterTest.register(t)
    const asUser = t.withIdentity(TEST_USER)
    const fetchMock = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/private.png" },
      })
    })
    vi.stubGlobal("fetch", fetchMock)

    try {
      await expect(
        asUser.action(api.cms.media.importFromUrl, {
          url: "https://cdn.example.com/image.png",
        })
      ).rejects.toThrow("globally reachable")
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({ redirect: "manual" })
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test("rejects IPv4-mapped IPv6 before making a request", async () => {
    const t = mediaTest()
    rateLimiterTest.register(t)
    const asUser = t.withIdentity(TEST_USER)
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    try {
      await expect(
        asUser.action(api.cms.media.importFromUrl, {
          url: "https://[::ffff:127.0.0.1]/image.png",
        })
      ).rejects.toThrow("globally reachable")
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test("allows a legitimate CDN redirect and derives the final filename", async () => {
    const t = mediaTest()
    rateLimiterTest.register(t)
    const asUser = t.withIdentity(TEST_USER)
    const fixture = IMAGE_DIMENSION_FIXTURES[0]
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://assets.example.com:443/final.png" },
        })
      )
      .mockResolvedValueOnce(
        new Response(toArrayBuffer(fixture.bytes), {
          status: 200,
          headers: { "content-type": fixture.mimeType },
        })
      )
    vi.stubGlobal("fetch", fetchMock)

    try {
      const mediaId = await asUser.action(api.cms.media.importFromUrl, {
        url: "https://cdn.example.com/start",
      })
      await expect(t.run((ctx) => ctx.db.get(mediaId))).resolves.toMatchObject({
        filename: "final.png",
        width: fixture.width,
        height: fixture.height,
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test("enforces the three-transition redirect cap", async () => {
    const t = mediaTest()
    rateLimiterTest.register(t)
    const asUser = t.withIdentity(TEST_USER)
    const fetchMock = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: "https://cdn.example.com/next" },
      })
    })
    vi.stubGlobal("fetch", fetchMock)

    try {
      await expect(
        asUser.action(api.cms.media.importFromUrl, {
          url: "https://cdn.example.com/start",
        })
      ).rejects.toThrow("at most 3 redirects")
      expect(fetchMock).toHaveBeenCalledTimes(4)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe("media dimension backfill", () => {
  test("measures a stored legacy image and persists its dimensions", async () => {
    const t = mediaTest()
    const asUser = t.withIdentity(TEST_USER)
    const fixture = IMAGE_DIMENSION_FIXTURES[0]
    const mediaId = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(
        new Blob([toArrayBuffer(fixture.bytes)], { type: fixture.mimeType })
      )
      return await ctx.db.insert("media", {
        filename: fixture.filename,
        storageId,
        url: `https://example.com/${fixture.filename}`,
        size: fixture.bytes.byteLength,
        mimeType: fixture.mimeType,
        uploadedAt: Date.now(),
      })
    })

    const result = await asUser.action(api.cms.media.backfillImageDimensions, {
      batchSize: 10,
    })

    expect(result).toMatchObject({
      scanned: 1,
      measured: 1,
      skipped: 0,
      failures: [],
      nextCursor: null,
      isDone: true,
    })
    await expect(t.run((ctx) => ctx.db.get(mediaId))).resolves.toMatchObject({
      width: fixture.width,
      height: fixture.height,
    })

    await expect(
      asUser.action(api.cms.media.backfillImageDimensions, { batchSize: 10 })
    ).resolves.toMatchObject({
      scanned: 1,
      measured: 0,
      skipped: 0,
      failures: [],
      nextCursor: null,
      isDone: true,
    })
  })

  test("reports a typed failure without inventing dimensions", async () => {
    const t = mediaTest()
    const asUser = t.withIdentity(TEST_USER)
    const mediaId = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(
        new Blob(["not a PNG"], { type: "image/png" })
      )
      return await ctx.db.insert("media", {
        filename: "broken.png",
        storageId,
        url: "https://example.com/broken.png",
        size: 9,
        mimeType: "image/png",
        uploadedAt: Date.now(),
      })
    })

    const result = await asUser.action(
      api.cms.media.backfillImageDimensions,
      {}
    )

    expect(result.failures).toEqual([
      expect.objectContaining({
        mediaId,
        filename: "broken.png",
        code: "mime_mismatch",
      }),
    ])
    await expect(
      t.run((ctx) => ctx.db.get(mediaId))
    ).resolves.not.toMatchObject({
      width: expect.any(Number),
      height: expect.any(Number),
    })
  })

  test("returns a bounded continuation that advances across batches", async () => {
    const t = mediaTest()
    const asUser = t.withIdentity(TEST_USER)
    const fixture = IMAGE_DIMENSION_FIXTURES[0]
    await t.run(async (ctx) => {
      for (let index = 0; index < 3; index++) {
        const storageId = await ctx.storage.store(
          new Blob([toArrayBuffer(fixture.bytes)], {
            type: fixture.mimeType,
          })
        )
        await ctx.db.insert("media", {
          filename: `legacy-${index}.png`,
          storageId,
          url: `https://example.com/legacy-${index}.png`,
          size: fixture.bytes.byteLength,
          mimeType: fixture.mimeType,
          uploadedAt: Date.now() + index,
        })
      }
    })

    const first = await asUser.action(api.cms.media.backfillImageDimensions, {
      batchSize: 2,
    })
    expect(first).toMatchObject({
      scanned: 2,
      measured: 2,
      failures: [],
      isDone: false,
    })
    expect(first.nextCursor).toEqual(expect.any(String))

    const second = await asUser.action(api.cms.media.backfillImageDimensions, {
      batchSize: 2,
      cursor: first.nextCursor,
    })
    expect(second).toMatchObject({
      scanned: 1,
      measured: 1,
      failures: [],
      nextCursor: null,
      isDone: true,
    })
  })
})

describe("public media storage URL resolution", () => {
  test("omits an existing storage object that has no media row", async () => {
    const t = mediaTest()
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["foreign object"], { type: "text/plain" }))
    )

    await expect(
      t.query(api.cms.media.getStorageUrls, { storageIds: [storageId] })
    ).resolves.toEqual({})
  })

  test("keeps trashed media resolvable through restore and revokes it on permanent deletion", async () => {
    const t = mediaTest()
    const asUser = t.withIdentity(TEST_USER)
    const media = await createStoredMedia(t)
    const resolve = () =>
      t.query(api.cms.media.getStorageUrls, {
        storageIds: [media.storageId],
      })

    await expect(resolve()).resolves.toEqual({
      [media.storageId]: expect.any(String),
    })

    await asUser.mutation(api.cms.media.softDelete, { id: media.mediaId })
    await expect(resolve()).resolves.toEqual({
      [media.storageId]: expect.any(String),
    })

    await asUser.mutation(api.cms.media.restore, { id: media.mediaId })
    await expect(resolve()).resolves.toEqual({
      [media.storageId]: expect.any(String),
    })

    await asUser.mutation(api.cms.media.remove, { id: media.mediaId })
    await expect(resolve()).resolves.toEqual({})
  })
})

function heroAgencyWithRichTextStorageReference(
  storageId: string
): HeroAgencySlice {
  return {
    id: "hero-1",
    type: "hero-agency",
    enabled: true,
    primary: {
      eyebrow: "Media",
      title: "Image Page",
      description: JSON.stringify({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: `Storage reference ${storageId}` }],
          },
        ],
      }),
    },
    items: [],
  }
}

function heroWithImageStorageReference(
  storageId: Id<"_storage">,
  url: string
): HeroWithImageSlice {
  return {
    id: "hero-with-image-1",
    type: "hero-with-image",
    enabled: true,
    primary: {
      eyebrow: "Media",
      eyebrowLink: { type: "none" },
      title: "Image Page",
      description: JSON.stringify({
        type: "doc",
        content: [{ type: "paragraph" }],
      }),
      image: {
        storageId,
        url,
        width: 1200,
        height: 800,
        alt: "Example image",
      },
    },
    items: [],
  }
}

describe("media usage", () => {
  test("removing one of two primary-link pages retains the other page's asset", sliceProfile(["hero-with-image"]), async () => {
    const t = mediaTest()
    const owner = t.withIdentity(TEST_USER)
    const media = await createStoredMedia(t)
    const slice = heroWithImageStorageReference(media.storageId, media.url)
    slice.primary.image = { url: "/placeholder.png", width: 1, height: 1, alt: "" }
    slice.primary.eyebrowLink = { type: "media", storageId: media.storageId }
    const pageIds: Id<"pages">[] = []
    for (const slug of ["first-download", "second-download"]) {
      pageIds.push(await owner.mutation(api.cms.pages.create, {
        slug, pageType: "landing-page", status: "draft",
        content: { en: { title: slug, slices: [slice] } },
      }))
    }
    await owner.mutation(api.cms.pages.remove, { id: pageIds[0]! })
    expect((await owner.query(api.cms.media.usage, { id: media.mediaId })).pages)
      .toEqual([{ _id: pageIds[1], title: "second-download", slug: "second-download" }])
    await expect(owner.mutation(api.cms.media.softDelete, { id: media.mediaId }))
      .rejects.toThrow("MEDIA_SOFT_DELETE_REFERENCED")
    await expect(owner.mutation(api.cms.media.remove, { id: media.mediaId }))
      .rejects.toThrow(/used by/i)
    expect(await t.run(async (ctx) => (await ctx.storage.get(media.storageId))?.text()))
      .toBe("test image")
    await owner.mutation(api.cms.pages.remove, { id: pageIds[1]! })
    await owner.mutation(api.cms.media.remove, { id: media.mediaId })
    expect(await t.run((ctx) => ctx.storage.get(media.storageId))).toBeNull()
  })

  test.each(["items link", "primary image", "external link"] as const)(
    "%s keeps its existing media usage behavior", sliceProfile(["hero-with-image"]), async (field) => {
      const t = mediaTest()
      const owner = t.withIdentity(TEST_USER)
      const media = await createStoredMedia(t)
      const slice = heroWithImageStorageReference(media.storageId, media.url)
      if (field !== "primary image") {
        slice.primary.image = { url: "/placeholder.png", width: 1, height: 1, alt: "" }
      }
      if (field === "items link") {
        slice.items = [{
          id: "download", label: "Download", variant: "primary", withIcon: false, enabled: true,
          link: { type: "media", mediaId: media.mediaId },
        }]
      }
      if (field === "external link") {
        slice.primary.eyebrowLink = { type: "external", url: media.url }
      }
      const pageId = await owner.mutation(api.cms.pages.create, {
        slug: "usage-regression", pageType: "landing-page", status: "draft",
        content: { en: { title: "Usage", slices: [slice] } },
      })
      const usage = await owner.query(api.cms.media.usage, { id: media.mediaId })
      expect(usage.pages).toEqual(field === "external link" ? [] : [
        { _id: pageId, title: "Usage", slug: "usage-regression" },
      ])
    }
  )

  test("primary media link alone blocks both deletion mutations and retains storage", sliceProfile(["hero-with-image"]), async () => {
    const t = mediaTest()
    const owner = t.withIdentity(TEST_USER)
    const media = await createStoredMedia(t)
    const slice = heroWithImageStorageReference(media.storageId, media.url)
    slice.primary.image = { url: "/placeholder.png", width: 1, height: 1, alt: "" }
    slice.primary.eyebrowLink = { type: "media", mediaId: media.mediaId }
    const pageId = await owner.mutation(api.cms.pages.create, {
      slug: "primary-link",
      pageType: "landing-page",
      status: "draft",
      content: { en: { title: "Primary link", slices: [slice] } },
    })

    await expect(owner.query(api.cms.media.usage, { id: media.mediaId }))
      .resolves.toMatchObject({ pages: [{ _id: pageId }] })
    const refs = await t.run((ctx) => ctx.db.query("mediaReferences")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId)).take(10))
    expect(refs).toEqual([expect.objectContaining({
      mediaId: media.mediaId,
      storageId: media.storageId,
      source: "slice-media-link",
      path: "content.en.slices[0].primary.eyebrowLink",
    })])
    await expect(owner.mutation(api.cms.media.softDelete, { id: media.mediaId }))
      .rejects.toThrow("MEDIA_SOFT_DELETE_REFERENCED")
    await expect(owner.mutation(api.cms.media.remove, { id: media.mediaId }))
      .rejects.toThrow(/used by/i)
    expect(await t.run((ctx) => ctx.db.get(media.mediaId))).toMatchObject({ storageId: media.storageId })
    expect((await t.run((ctx) => ctx.db.get(media.mediaId)))?.deletedAt).toBeUndefined()
    expect(await t.run(async (ctx) => (await ctx.storage.get(media.storageId))?.text()))
      .toBe("test image")
  })

  test("usage reports a page whose slice image references the media", sliceProfile(["hero-with-image"]), async () => {
    const t = mediaTest()
    const asUser = t.withIdentity(TEST_USER)
    const media = await createStoredMedia(t)

    const pageId = await asUser.mutation(api.cms.pages.create, {
      slug: "image-page",
      pageType: "landing-page",
      status: "draft",
      content: {
        en: {
          title: "Image Page",
          slices: [heroWithImageStorageReference(media.storageId, media.url)],
        },
      },
    })

    const usage = await asUser.query(api.cms.media.usage, { id: media.mediaId })
    expect(usage.pages).toEqual([
      { _id: pageId, title: "Image Page", slug: "image-page" },
    ])
    expect(usage.settings).toEqual([])
  })

  test("usage ignores storage-id text that is not a media field", sliceProfile(["hero-agency"]), async () => {
    const t = mediaTest()
    const asUser = t.withIdentity(TEST_USER)
    const media = await createStoredMedia(t)

    await asUser.mutation(api.cms.pages.create, {
      slug: "text-page",
      pageType: "landing-page",
      status: "draft",
      content: {
        en: {
          title: "Text Page",
          slices: [heroAgencyWithRichTextStorageReference(media.storageId)],
        },
      },
    })

    const usage = await asUser.query(api.cms.media.usage, { id: media.mediaId })
    expect(usage.pages).toEqual([])
  })

  test("backfill populates references for existing pages", sliceProfile([]), async () => {
    const t = mediaTest()
    const asUser = t.withIdentity(TEST_USER)
    const media = await createStoredMedia(t)
    const pageId = await t.run((ctx) =>
      ctx.db.insert("pages", {
        slug: "legacy-image-page",
        pageType: "landing-page",
        status: "draft",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        content: {
          en: {
            title: "Legacy Image Page",
            slices: [heroWithImageStorageReference(media.storageId, media.url)],
          },
        },
      })
    )

    expect(
      await asUser.query(api.cms.media.usage, { id: media.mediaId })
    ).toEqual({
      settings: [],
      pages: [],
    })

    await asUser.mutation(api.cms.pages.backfillMediaReferences, {})

    const usage = await asUser.query(api.cms.media.usage, { id: media.mediaId })
    expect(usage.pages).toEqual([
      { _id: pageId, title: "Legacy Image Page", slug: "legacy-image-page" },
    ])
  })

  test("usage reports branding settings slots", async () => {
    const t = mediaTest()
    const asUser = t.withIdentity(TEST_USER)

    await asUser.mutation(api.cms.settings.completeOnboarding, {
      siteName: "Site",
      siteUrl: "https://example.com",
      timezone: "UTC",
      defaultLocale: "en",
      enabledLocales: ["en"],
    })
    const media = await createStoredMedia(t, "logo.png")
    await asUser.mutation(api.cms.settings.setBrandingImage, {
      slot: "logo",
      mediaId: media.mediaId,
    })

    const usage = await asUser.query(api.cms.media.usage, { id: media.mediaId })
    expect(usage.settings).toEqual(["logo"])
    expect(usage.pages).toEqual([])
  })

  test("remove throws for in-use media and keeps the document", sliceProfile(["hero-with-image"]), async () => {
    const t = mediaTest()
    const asUser = t.withIdentity(TEST_USER)
    const media = await createStoredMedia(t)

    await asUser.mutation(api.cms.pages.create, {
      slug: "referencing-page",
      pageType: "landing-page",
      status: "draft",
      content: {
        en: {
          title: "Referencing Page",
          slices: [heroWithImageStorageReference(media.storageId, media.url)],
        },
      },
    })

    await expect(
      asUser.mutation(api.cms.media.remove, { id: media.mediaId })
    ).rejects.toThrow(/used by/i)
    const stillThere = await t.run((ctx) => ctx.db.get(media.mediaId))
    expect(stillThere).toBeDefined()
  })

  test("remove succeeds for unused media", async () => {
    const t = mediaTest()
    const asUser = t.withIdentity(TEST_USER)
    const media = await createStoredMedia(t)

    await asUser.mutation(api.cms.media.remove, { id: media.mediaId })

    const deletedDoc = await t.run((ctx) => ctx.db.get(media.mediaId))
    const deletedBlob = await t.run((ctx) =>
      ctx.storage.get(media.storageId as Id<"_storage">)
    )
    expect(deletedDoc).toBeNull()
    expect(deletedBlob).toBeNull()
  })
})
