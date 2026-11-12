import { ConvexError, v } from "convex/values"
import { paginationOptsValidator } from "convex/server"
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server"
import { api, internal } from "../_generated/api"
import type { QueryCtx, MutationCtx } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"
import { requireOperationAccess } from "../lib/access/policy"
import type { OwnerPrincipal } from "../lib/access/owner"
import { rateLimiter } from "../lib/rateLimits"
import { ensureTagsForLabels } from "./tags"
import { mediaDocValidator } from "../schema"
import {
  assertMediaSoftDeleteAllowed,
  assertMediaUnreferenced,
  getMediaUsage,
  ImageDimensionsError,
  readImageDimensions,
} from "../lib/domains/media"
import type { ImageDimensionsErrorCode } from "../lib/domains/media"
import { fetchWithSafeRedirects, OutboundUrlError } from "../lib/urlGuard"

const MAX_REMOTE_IMAGE_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_MEDIA_LIST_LIMIT = 100
const MEDIA_LIST_CANDIDATE_FACTOR = 4
const IMAGE_DIMENSION_BACKFILL_BATCH_SIZE = 10
const IMAGE_DIMENSION_BACKFILL_MAX_BATCH_SIZE = 25
const IMAGE_DIMENSION_BACKFILL_READ_CONCURRENCY = 2

/**
 * F03a compatibility adapter. Operation labels and historical uploadedBy
 * values remain diagnostics/attribution only; Community authorization comes
 * solely from F01's verified operation-access principal.
 */
async function requirePermission(
  ctx: QueryCtx | MutationCtx,
  _operation: string,
  _scope?: { ownerId?: string | null; prospectiveOwner?: boolean }
): Promise<OwnerPrincipal> {
  return requireOperationAccess(ctx)
}

const focalPointValidator = v.object({
  x: v.number(),
  y: v.number(),
})

const cropRectValidator = v.object({
  x: v.number(),
  y: v.number(),
  width: v.number(),
  height: v.number(),
})

const cropSizeValidator = v.object({
  width: v.number(),
  height: v.number(),
})

const mediaUsageValidator = v.object({
  settings: v.array(v.string()),
  pages: v.array(
    v.object({
      _id: v.id("pages"),
      title: v.string(),
      slug: v.string(),
    })
  ),
})

const imageDimensionsErrorCodeValidator = v.union(
  v.literal("unsupported_mime"),
  v.literal("mime_mismatch"),
  v.literal("truncated"),
  v.literal("malformed"),
  v.literal("dimensions_missing"),
  v.literal("invalid_dimensions"),
  v.literal("scan_limit"),
  v.literal("missing_blob"),
  v.literal("too_large")
)

const imageDimensionBackfillFailureValidator = v.object({
  mediaId: v.id("media"),
  filename: v.string(),
  code: imageDimensionsErrorCodeValidator,
  message: v.string(),
})

const imageDimensionBackfillResultValidator = v.object({
  scanned: v.number(),
  measured: v.number(),
  skipped: v.number(),
  failures: v.array(imageDimensionBackfillFailureValidator),
  nextCursor: v.union(v.string(), v.null()),
  isDone: v.boolean(),
})

type ImageDimensionBackfillFailureCode =
  ImageDimensionsErrorCode | "missing_blob" | "too_large"

type ImageDimensionBackfillFailure = {
  mediaId: Id<"media">
  filename: string
  code: ImageDimensionBackfillFailureCode
  message: string
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  map: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    const index = nextIndex
    nextIndex++
    if (index >= items.length) return
    results[index] = await map(items[index]!, index)
    return worker()
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () =>
      worker()
    )
  )
  return results
}

export const getStorageUrls = query({
  args: { storageIds: v.array(v.id("_storage")) },
  returns: v.record(v.string(), v.string()),
  handler: async (ctx, { storageIds }) => {
    const unique = [...new Set(storageIds)].slice(0, 100)
    const entries = await Promise.all(
      unique.map(async (storageId) => {
        const media = await ctx.db
          .query("media")
          .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
          .first()
        if (!media) return [storageId, null] as const
        const url = await ctx.storage.getUrl(storageId)
        return [storageId, url] as const
      })
    )
    return Object.fromEntries(
      entries.filter((entry): entry is readonly [Id<"_storage">, string] =>
        Boolean(entry[1])
      )
    )
  },
})

function filenameExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg"
    case "image/png":
      return "png"
    case "image/gif":
      return "gif"
    case "image/webp":
      return "webp"
    case "image/svg+xml":
      return "svg"
    case "image/avif":
      return "avif"
    default:
      return "image"
  }
}

function filenameFromUrl(url: URL, mimeType: string): string {
  const pathname = decodeURIComponent(url.pathname)
  const finalSegment = pathname.split("/").filter(Boolean).pop()
  const fallback = `remote-image.${filenameExtension(mimeType)}`
  const filename = finalSegment?.trim() || fallback

  return /\.[a-z0-9]+$/i.test(filename)
    ? filename
    : `${filename}.${filenameExtension(mimeType)}`
}

export const getById = query({
  args: { id: v.id("media") },
  returns: v.union(mediaDocValidator, v.null()),
  handler: async (ctx, { id }) => {
    await requireOperationAccess(ctx)
    const media = await ctx.db.get(id)
    if (!media) return null
    return media
  },
})

export const getByName = query({
  args: { name: v.string() },
  returns: v.union(mediaDocValidator, v.null()),
  handler: async (ctx, { name }) => {
    await requirePermission(ctx, "media:view")
    const row = await ctx.db
      .query("media")
      .withIndex("by_filename", (q) => q.eq("filename", name))
      .first()
    if (!row || row.deletedAt !== undefined) return null
    return row
  },
})

export const list = query({
  args: {
    folder: v.optional(v.string()),
    mimeType: v.optional(v.string()),
    limit: v.optional(v.number()),
    includeDeleted: v.optional(v.boolean()),
  },
  returns: v.array(mediaDocValidator),
  handler: async (ctx, { folder, mimeType, limit = 50, includeDeleted }) => {
    await requirePermission(ctx, "media:view")
    const boundedLimit = Math.min(
      Math.max(Math.floor(limit), 1),
      MAX_MEDIA_LIST_LIMIT
    )
    const candidateLimit = boundedLimit * MEDIA_LIST_CANDIDATE_FACTOR
    let media

    if (folder !== undefined) {
      media = await ctx.db
        .query("media")
        .withIndex("by_folder_and_uploadedAt", (q) => q.eq("folder", folder))
        .order("desc")
        .take(candidateLimit)
    } else {
      media = await ctx.db.query("media").take(candidateLimit)
    }

    if (!includeDeleted) {
      media = media.filter((m) => m.deletedAt === undefined)
    }

    if (mimeType) {
      if (mimeType.endsWith("/*")) {
        const prefix = mimeType.slice(0, -1)
        media = media.filter((m) => m.mimeType.startsWith(prefix))
      } else {
        media = media.filter((m) => m.mimeType === mimeType)
      }
    }

    return media.slice(0, boundedLimit)
  },
})

const paginatedMediaValidator = v.object({
  page: v.array(mediaDocValidator),
  isDone: v.boolean(),
  continueCursor: v.string(),
  splitCursor: v.optional(v.union(v.string(), v.null())),
  pageStatus: v.optional(
    v.union(v.literal("SplitRecommended"), v.literal("SplitRequired"), v.null())
  ),
})

/**
 * Cursor-paginated media list (plan 023 Phase 4 #2) for `usePaginatedQuery`,
 * newest first. Soft-deleted assets are filtered out of each page; mime-type
 * filtering stays client-side (it would shrink pages unpredictably here).
 */
export const listPaginated = query({
  args: {
    paginationOpts: paginationOptsValidator,
    folder: v.optional(v.string()),
  },
  returns: paginatedMediaValidator,
  handler: async (ctx, args) => {
    await requirePermission(ctx, "media:view")
    const dbQuery =
      args.folder !== undefined
        ? ctx.db
            .query("media")
            .withIndex("by_folder_and_uploadedAt", (q) =>
              q.eq("folder", args.folder)
            )
        : ctx.db.query("media")
    const result = await dbQuery.order("desc").paginate(args.paginationOpts)
    return {
      ...result,
      page: result.page.filter((m) => m.deletedAt === undefined),
    }
  },
})

export const listFolders = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    await requirePermission(ctx, "media:view")
    const folders = await ctx.db.query("folders").collect()
    return folders.map((f) => f.name).sort()
  },
})

export const usage = query({
  args: { id: v.id("media") },
  returns: mediaUsageValidator,
  handler: async (ctx, { id }) => {
    await requireOperationAccess(ctx)
    const media = await ctx.db.get(id)
    if (!media) throw new ConvexError("Media not found")
    return getMediaUsage(ctx, media)
  },
})

export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    await requirePermission(ctx, "media:upload")
    return ctx.storage.generateUploadUrl()
  },
})

export const assertCanUpload = internalMutation({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    await requirePermission(ctx, "media:upload")
    return true
  },
})

export const assertCanBackfillImageDimensions = internalMutation({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    await requirePermission(ctx, "media:update")
    return true
  },
})

export const getImageDimensionBackfillBatch = internalQuery({
  args: {
    cursor: v.union(v.string(), v.null()),
    batchSize: v.number(),
  },
  returns: v.object({
    scanned: v.number(),
    candidates: v.array(
      v.object({
        mediaId: v.id("media"),
        storageId: v.id("_storage"),
        filename: v.string(),
        mimeType: v.string(),
      })
    ),
    nextCursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (ctx, { cursor, batchSize }) => {
    const page = await ctx.db
      .query("media")
      .paginate({ numItems: batchSize, cursor })
    return {
      scanned: page.page.length,
      candidates: page.page.flatMap((media) =>
        media.width === undefined || media.height === undefined
          ? [
              {
                mediaId: media._id,
                storageId: media.storageId,
                filename: media.filename,
                mimeType: media.mimeType,
              },
            ]
          : []
      ),
      nextCursor: page.isDone ? null : page.continueCursor,
      isDone: page.isDone,
    }
  },
})

export const applyImageDimensionBackfill = internalMutation({
  args: {
    updates: v.array(
      v.object({
        mediaId: v.id("media"),
        storageId: v.id("_storage"),
        width: v.number(),
        height: v.number(),
      })
    ),
  },
  returns: v.object({
    patched: v.number(),
    skipped: v.number(),
  }),
  handler: async (ctx, { updates }) => {
    const seen = new Set<Id<"media">>()
    const uniqueUpdates: typeof updates = []
    let skipped = 0
    for (const update of updates) {
      if (seen.has(update.mediaId)) {
        skipped++
        continue
      }
      seen.add(update.mediaId)
      uniqueUpdates.push(update)
    }
    const outcomes = await Promise.all(
      uniqueUpdates.map(async (update) => {
        const media = await ctx.db.get(update.mediaId)
        if (
          !media ||
          media.storageId !== update.storageId ||
          (media.width !== undefined && media.height !== undefined)
        ) {
          return "skipped" as const
        }
        await ctx.db.patch(update.mediaId, {
          width: update.width,
          height: update.height,
        })
        return "patched" as const
      })
    )
    return {
      patched: outcomes.filter((outcome) => outcome === "patched").length,
      skipped:
        skipped + outcomes.filter((outcome) => outcome === "skipped").length,
    }
  },
})

export const backfillImageDimensions = action({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
  },
  returns: imageDimensionBackfillResultValidator,
  handler: async (ctx, args) => {
    const allowed: boolean = await ctx.runMutation(
      internal.cms.media.assertCanBackfillImageDimensions,
      {}
    )
    if (!allowed) throw new ConvexError("UNAUTHORIZED")

    const batchSize = Math.min(
      IMAGE_DIMENSION_BACKFILL_MAX_BATCH_SIZE,
      Math.max(
        1,
        Math.trunc(args.batchSize ?? IMAGE_DIMENSION_BACKFILL_BATCH_SIZE)
      )
    )
    const batch: {
      scanned: number
      candidates: Array<{
        mediaId: Id<"media">
        storageId: Id<"_storage">
        filename: string
        mimeType: string
      }>
      nextCursor: string | null
      isDone: boolean
    } = await ctx.runQuery(internal.cms.media.getImageDimensionBackfillBatch, {
      cursor: args.cursor ?? null,
      batchSize,
    })
    const outcomes = await mapWithConcurrency(
      batch.candidates,
      IMAGE_DIMENSION_BACKFILL_READ_CONCURRENCY,
      async (
        candidate
      ): Promise<
        | {
            kind: "update"
            mediaId: Id<"media">
            storageId: Id<"_storage">
            width: number
            height: number
          }
        | ({ kind: "failure" } & ImageDimensionBackfillFailure)
      > => {
        const blob = await ctx.storage.get(candidate.storageId)
        if (!blob) {
          return {
            kind: "failure",
            mediaId: candidate.mediaId,
            filename: candidate.filename,
            code: "missing_blob",
            message: "Stored image data is missing",
          }
        }
        if (blob.size > MAX_REMOTE_IMAGE_SIZE) {
          return {
            kind: "failure",
            mediaId: candidate.mediaId,
            filename: candidate.filename,
            code: "too_large",
            message: "Stored image is larger than 10MB",
          }
        }
        try {
          const dimensions = readImageDimensions(
            await blob.arrayBuffer(),
            candidate.mimeType
          )
          return {
            kind: "update",
            mediaId: candidate.mediaId,
            storageId: candidate.storageId,
            ...dimensions,
          }
        } catch (error) {
          if (!(error instanceof ImageDimensionsError)) throw error
          return {
            kind: "failure",
            mediaId: candidate.mediaId,
            filename: candidate.filename,
            code: error.code,
            message: error.message.slice(0, 200),
          }
        }
      }
    )
    const updates = outcomes.flatMap((outcome) =>
      outcome.kind === "update"
        ? [
            {
              mediaId: outcome.mediaId,
              storageId: outcome.storageId,
              width: outcome.width,
              height: outcome.height,
            },
          ]
        : []
    )
    const failures = outcomes.flatMap((outcome) =>
      outcome.kind === "failure"
        ? [
            {
              mediaId: outcome.mediaId,
              filename: outcome.filename,
              code: outcome.code,
              message: outcome.message,
            },
          ]
        : []
    )

    const persisted: { patched: number; skipped: number } =
      updates.length === 0
        ? { patched: 0, skipped: 0 }
        : await ctx.runMutation(
            internal.cms.media.applyImageDimensionBackfill,
            { updates }
          )
    return {
      scanned: batch.scanned,
      measured: persisted.patched,
      skipped: persisted.skipped,
      failures,
      nextCursor: batch.nextCursor,
      isDone: batch.isDone,
    }
  },
})

export const create = mutation({
  args: {
    filename: v.string(),
    storageId: v.id("_storage"),
    size: v.number(),
    mimeType: v.string(),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    folder: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
  },
  returns: v.id("media"),
  handler: async (ctx, args) => {
    const auth = await requirePermission(ctx, "media:upload")
    const url = await ctx.storage.getUrl(args.storageId)
    if (!url) throw new ConvexError("Failed to get storage URL")

    const tags = args.tags
      ? await ensureTagsForLabels(ctx, args.tags)
      : undefined

    return ctx.db.insert("media", {
      filename: args.filename,
      storageId: args.storageId,
      size: args.size,
      mimeType: args.mimeType,
      width: args.width,
      height: args.height,
      folder: args.folder,
      tags,
      url,
      uploadedAt: Date.now(),
      uploadedBy: auth.tokenIdentifier,
    })
  },
})

export const update = mutation({
  args: {
    id: v.id("media"),
    folder: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    focal: v.optional(v.union(focalPointValidator, v.null())),
    crop: v.optional(v.union(cropRectValidator, v.null())),
    cropSize: v.optional(v.union(cropSizeValidator, v.null())),
  },
  returns: v.null(),
  handler: async (ctx, { id, ...updates }) => {
    await requireOperationAccess(ctx)
    const media = await ctx.db.get(id)
    if (!media) throw new ConvexError("Media not found")
    const patch: Partial<Doc<"media">> = { folder: updates.folder }
    if (updates.tags !== undefined) {
      patch.tags = await ensureTagsForLabels(ctx, updates.tags)
    }
    if (updates.focal !== undefined) {
      patch.focal = updates.focal ?? undefined
    }
    if (updates.crop !== undefined) {
      patch.crop = updates.crop ?? undefined
    }
    if (updates.cropSize !== undefined) {
      patch.cropSize = updates.cropSize ?? undefined
    }
    await ctx.db.patch(id, patch)
    return null
  },
})

export const importFromUrl = action({
  args: {
    url: v.string(),
    folder: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
  },
  returns: v.id("media"),
  handler: async (ctx, args) => {
    const allowed: boolean = await ctx.runMutation(
      internal.cms.media.assertCanUpload,
      {}
    )
    if (!allowed) throw new ConvexError("UNAUTHORIZED")

    // Charge after the permission gate. Each call is an outbound fetch plus up
    // to 10 MB into file storage, so an authed `media:upload` holder could
    // otherwise loop this into the storage quota.
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new ConvexError("Unauthenticated")
    await rateLimiter.limit(ctx, "mediaImportPerUser", {
      key: identity.tokenIdentifier,
      throws: true,
    })

    // DNS rebinding remains an accepted residual risk for the restricted
    // pilot: the shared guard validates URL syntax and literal addresses but
    // does not resolve and pin hostname addresses.
    let response: Response
    let url: URL
    try {
      const fetched = await fetchWithSafeRedirects(args.url)
      response = fetched.response
      url = fetched.url
    } catch (error) {
      if (error instanceof OutboundUrlError) {
        throw new ConvexError({ code: error.code, message: error.message })
      }
      throw error
    }
    if (!response.ok) {
      throw new ConvexError({ code: "MEDIA_FETCH_FAILED", message: `Could not fetch image (${response.status})` })
    }

    const contentType = response.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase()
    if (!contentType?.startsWith("image/")) {
      throw new ConvexError({ code: "MEDIA_NOT_IMAGE", message: "The URL did not return an image" })
    }

    const contentLength = Number(response.headers.get("content-length") ?? 0)
    if (contentLength > MAX_REMOTE_IMAGE_SIZE) {
      throw new ConvexError({ code: "MEDIA_TOO_LARGE", message: "Remote image must be smaller than 10MB" })
    }

    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > MAX_REMOTE_IMAGE_SIZE) {
      throw new ConvexError({ code: "MEDIA_TOO_LARGE", message: "Remote image must be smaller than 10MB" })
    }
    let dimensions: { width: number; height: number }
    try {
      dimensions = readImageDimensions(bytes, contentType)
    } catch (error) {
      if (error instanceof ImageDimensionsError) {
        throw new ConvexError({
          code: "INVALID_IMAGE_DIMENSIONS",
          reason: error.code,
          message: error.message,
        })
      }
      throw error
    }

    const storageId = await ctx.storage.store(
      new Blob([bytes], { type: contentType })
    )
    const mediaId: Id<"media"> = await ctx.runMutation(api.cms.media.create, {
      filename: filenameFromUrl(url, contentType),
      storageId,
      size: bytes.byteLength,
      mimeType: contentType,
      width: dimensions.width,
      height: dimensions.height,
      folder: args.folder,
      tags: args.tags,
    })

    return mediaId
  },
})

export const softDelete = mutation({
  args: { id: v.id("media") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    await requireOperationAccess(ctx)
    const media = await ctx.db.get(id)
    if (!media) throw new ConvexError("Media not found")
    await assertMediaSoftDeleteAllowed(ctx, media)
    await ctx.db.patch(id, { deletedAt: Date.now() })
    return null
  },
})

export const restore = mutation({
  args: { id: v.id("media") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    await requireOperationAccess(ctx)
    const media = await ctx.db.get(id)
    if (!media) throw new ConvexError("Media not found")
    await ctx.db.patch(id, { deletedAt: undefined })
    return null
  },
})

export const remove = mutation({
  args: { id: v.id("media") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    await requireOperationAccess(ctx)
    const media = await ctx.db.get(id)
    if (media) {
      await assertMediaUnreferenced(ctx, media)
      await ctx.storage.delete(media.storageId)
      await ctx.db.delete(id)
    }
    return null
  },
})

export const createFolder = mutation({
  args: {
    name: v.string(),
    parentFolder: v.optional(v.string()),
  },
  returns: v.object({ name: v.string() }),
  handler: async (ctx, { name, parentFolder }) => {
    await requirePermission(ctx, "media:update")
    const cleanName = name.trim().toLowerCase().replace(/\//g, "-")
    if (!cleanName) throw new ConvexError({ code: "FOLDER_NAME_REQUIRED", message: "Folder name cannot be empty" })

    const fullPath = parentFolder ? `${parentFolder}/${cleanName}` : cleanName

    const existing = await ctx.db
      .query("folders")
      .withIndex("by_name", (q) => q.eq("name", fullPath))
      .first()

    if (existing) throw new ConvexError({ code: "FOLDER_EXISTS", message: `Folder "${fullPath}" already exists` })

    await ctx.db.insert("folders", {
      name: fullPath,
      createdAt: Date.now(),
    })

    return { name: fullPath }
  },
})

export const deleteFolder = mutation({
  args: {
    name: v.string(),
    moveToFolder: v.optional(v.string()),
  },
  returns: v.object({ success: v.boolean(), count: v.number() }),
  handler: async (ctx, { name, moveToFolder }) => {
    await requirePermission(ctx, "media:update")
    const folderDoc = await ctx.db
      .query("folders")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first()

    if (folderDoc) await ctx.db.delete(folderDoc._id)

    const mediaInFolder = await ctx.db
      .query("media")
      .withIndex("by_folder", (q) => q.eq("folder", name))
      .collect()

    await Promise.all(
      mediaInFolder.map((m) => ctx.db.patch(m._id, { folder: moveToFolder }))
    )

    return { success: true, count: mediaInFolder.length }
  },
})
