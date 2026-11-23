/// <reference types="vite/client" />
import { convexTest } from "../convexTestWithExplicitAdmin"
import { describe, expect, test, vi } from "vitest"
import { api } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { IMAGE_DIMENSION_FIXTURES } from "./lib/media/imageDimensions.testFixtures"
import schema from "./schema"
import rateLimiterTest from "@convex-dev/rate-limiter/test"
import migrationsTest from "@convex-dev/migrations/test"
import {
  finishMediaUsageBackfill,
} from "@/test-utils/media-usage-backfill"

const modules = import.meta.glob("./**/*.ts")

const TEST_USER = {
  subject: "test-user",
  tokenIdentifier: "test-user",
  name: "Test User",
  email: "test@example.com",
}

function mediaTest(publicationAuthority?: "missing") {
  const t = convexTest({
    publicationAuthority,
    schema,
    modules,
    ownerIdentity: TEST_USER,
  })
  migrationsTest.register(t)
  return t
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

        const media = await t.run((ctx) => ctx.db.get("media", mediaId))
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
      await expect(t.run((ctx) => ctx.db.get("media", mediaId))).resolves.toMatchObject({
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
    await expect(t.run((ctx) => ctx.db.get("media", mediaId))).resolves.toMatchObject({
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
      t.run((ctx) => ctx.db.get("media", mediaId))
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

  test("hides trashed media from public URLs, restores them, and keeps permanent deletion refused outside snapshot authority", async () => {
    const t = mediaTest("missing")
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
    await expect(resolve()).resolves.toEqual({})

    await asUser.mutation(api.cms.media.restore, { id: media.mediaId })
    await expect(resolve()).resolves.toEqual({
      [media.storageId]: expect.any(String),
    })

    await asUser.mutation(api.cms.media.softDelete, { id: media.mediaId })
    await finishMediaUsageBackfill(t)
    // Permanent delete is available on snapshot-authority sites only (the
    // usage index covers nothing else); see mediaPurge.test.ts.
    await expect(
      asUser.mutation(api.cms.media.remove, { id: media.mediaId })
    ).rejects.toThrow(/MEDIA_PURGE_NOT_AVAILABLE/)
    await expect(resolve()).resolves.toEqual({})
  })

  async function storeMany(t: ReturnType<typeof mediaTest>, count: number) {
    return t.run(async (ctx) => {
      const storageIds: Id<"_storage">[] = []
      for (let index = 0; index < count; index += 1) {
        const storageId = await ctx.storage.store(
          new Blob([`image ${index}`], { type: "image/png" })
        )
        await ctx.db.insert("media", {
          filename: `m${index}.png`,
          storageId,
          url: `https://example.com/m${index}.png`,
          size: 10,
          mimeType: "image/png",
          uploadedAt: Date.now(),
        })
        storageIds.push(storageId)
      }
      return storageIds
    })
  }

  test("resolves 50 storage ids in one call", async () => {
    const t = mediaTest()
    const storageIds = await storeMany(t, 50)
    const result = await t.query(api.cms.media.getStorageUrls, { storageIds })
    expect(Object.keys(result)).toHaveLength(50)
    expect(result[storageIds[49]!]).toEqual(expect.any(String))
  })

  test("rejects 51 storage ids with TOO_MANY_IDS", async () => {
    const t = mediaTest()
    const storageIds = await storeMany(t, 51)
    await expect(
      t.query(api.cms.media.getStorageUrls, { storageIds })
    ).rejects.toThrow(/TOO_MANY_IDS/)
  })

  test("rejects 51 copies of one storage id with TOO_MANY_IDS", async () => {
    const t = mediaTest()
    const [storageId] = await storeMany(t, 1)
    await expect(
      t.query(api.cms.media.getStorageUrls, {
        storageIds: Array.from({ length: 51 }, () => storageId!),
      })
    ).rejects.toThrow(/TOO_MANY_IDS/)
  })
})

describe("media usage", () => {
  test("usage reports branding settings slots", async () => {
    const t = mediaTest()
    const asUser = t.withIdentity(TEST_USER)

    await asUser.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: "Site",
      siteUrl: "https://example.com",
      timezone: "UTC",
      defaultLocale: "en",
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

  test("remove refuses outside snapshot authority and deletes nothing", async () => {
    const t = mediaTest("missing")
    const asUser = t.withIdentity(TEST_USER)
    const media = await createStoredMedia(t)

    await asUser.mutation(api.cms.media.softDelete, { id: media.mediaId })
    await finishMediaUsageBackfill(t)
    await expect(
      asUser.mutation(api.cms.media.remove, { id: media.mediaId })
    ).rejects.toThrow(/MEDIA_PURGE_NOT_AVAILABLE/)
    await expect(
      asUser.mutation(api.cms.media.purgeTrashedMedia, { ids: [media.mediaId] })
    ).rejects.toThrow(/MEDIA_PURGE_NOT_AVAILABLE/)

    const stillThere = await t.run((ctx) => ctx.db.get("media", media.mediaId))
    const blobStored = await t.run(
      async (ctx) =>
        (await ctx.storage.get(media.storageId as Id<"_storage">)) !== null
    )
    expect(stillThere).not.toBeNull()
    expect(blobStored).toBe(true)
  })
})

describe("media update keeps what the call does not name", () => {
  async function createFolderedMedia(t: ReturnType<typeof mediaTest>) {
    const media = await createStoredMedia(t)
    await t.run((ctx) =>
      ctx.db.patch("media", media.mediaId, { folder: "Photos" })
    )
    return media
  }

  test("a tags-only update keeps the folder", async () => {
    const t = mediaTest()
    const asUser = t.withIdentity(TEST_USER)
    const media = await createFolderedMedia(t)

    await asUser.mutation(api.cms.media.update, {
      id: media.mediaId,
      tags: ["Summer"],
    })

    const after = await t.run((ctx) => ctx.db.get("media", media.mediaId))
    expect(after?.folder).toBe("Photos")
    expect(after?.tags).toEqual(["summer"])
  })

  test.each([
    ["null", null],
    ["a blank string", "  "],
  ])("folder: %s clears the folder", async (_name, folder) => {
    const t = mediaTest()
    const asUser = t.withIdentity(TEST_USER)
    const media = await createFolderedMedia(t)

    await asUser.mutation(api.cms.media.update, { id: media.mediaId, folder })

    const after = await t.run((ctx) => ctx.db.get("media", media.mediaId))
    expect(after?.folder).toBeUndefined()
  })

  test("a named folder is stored trimmed", async () => {
    const t = mediaTest()
    const asUser = t.withIdentity(TEST_USER)
    const media = await createFolderedMedia(t)

    await asUser.mutation(api.cms.media.update, {
      id: media.mediaId,
      folder: "  Events ",
    })

    const after = await t.run((ctx) => ctx.db.get("media", media.mediaId))
    expect(after?.folder).toBe("Events")
  })
})
