import { ConvexError, v } from "convex/values"
import { mutation, query, type MutationCtx } from "../_generated/server"
import { requireOperationAccess } from "../lib/access/policy"
import { recordPublicChange } from "../lib/language/freshness"
import {
  CONTENT_TYPES,
  isActiveContentType,
  type ContentType,
} from "../lib/contentTypes"

export const CONTENT_TYPE_USAGE_CAP = 25
const CONTENT_TYPE_USAGE_READ_LIMIT = CONTENT_TYPE_USAGE_CAP + 1

const contentTypeUsageValidator = v.object({
  type: v.string(),
  count: v.number(),
  capped: v.boolean(),
})

function sortedActiveArchivedTypes(values: readonly string[]): string[] {
  return [...new Set(values)].filter(isActiveContentType).sort()
}

/** Approximate usage deliberately reads one sentinel row beyond the display cap. */
export const getContentTypeUsage = query({
  args: {},
  returns: v.array(contentTypeUsageValidator),
  handler: async (ctx) => {
    await requireOperationAccess(ctx)

    return Promise.all(
      CONTENT_TYPES.map(async (type) => {
        const rows = await ctx.db
          .query("pages")
          .withIndex("by_pageType_status", (q) => q.eq("pageType", type))
          .take(CONTENT_TYPE_USAGE_READ_LIMIT)
        return {
          type,
          count: Math.min(rows.length, CONTENT_TYPE_USAGE_CAP),
          capped: rows.length > CONTENT_TYPE_USAGE_CAP,
        }
      })
    )
  },
})

/** Every owner-authorized creation surface needs this operational metadata. */
export const getArchivedContentTypes = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    await requireOperationAccess(ctx)
    const settings = await ctx.db.query("siteSettings").first()
    return sortedActiveArchivedTypes(settings?.archivedContentTypes ?? [])
  },
})

export const setContentTypeArchived = mutation({
  args: { type: v.string(), archived: v.boolean() },
  returns: v.array(v.string()),
  handler: async (ctx, { type, archived }) => {
    await requireOperationAccess(ctx)
    if (!isActiveContentType(type)) {
      throw new ConvexError(`Unknown active Content Type "${type}".`)
    }
    const settings = await ctx.db.query("siteSettings").first()
    if (!settings) {
      throw new ConvexError("Site settings are not initialized yet.")
    }

    const next = new Set(
      sortedActiveArchivedTypes(settings.archivedContentTypes ?? [])
    )
    if (archived) next.add(type)
    else next.delete(type)
    const result = [...next].sort()
    await ctx.db.patch(settings._id, {
      archivedContentTypes: result,
      updatedAt: Date.now(),
    })
    await recordPublicChange(ctx, { scopes: [] })
    return result
  },
})

/**
 * Shared backend guard for ordinary editor-facing creation paths. System seed,
 * migration, and fixture code writes directly through their explicit internal
 * paths and never calls this helper.
 */
export async function assertContentTypeAcceptsCreation(
  ctx: MutationCtx,
  type: ContentType
): Promise<void> {
  assertContentTypeIsActive(type, "create")
  const settings = await ctx.db.query("siteSettings").first()
  if (settings?.archivedContentTypes?.includes(type)) {
    throw new ConvexError(
      `Content Type "${type}" is archived and cannot be used for new documents. Restore it before creating or duplicating documents.`
    )
  }
}

/**
 * Selection is a lifecycle boundary, not merely an admin-menu filter. Keep
 * stored inactive arms available for explicit migrations, but reject them at
 * every ordinary create/publish entry point.
 */
export function assertContentTypeIsActive(
  type: ContentType,
  operation: "create" | "publish" | "edit" | "delete"
): void {
  if (isActiveContentType(type)) return
  throw new ConvexError(
    `Content Type "${type}" is not active in this starter and cannot be used to ${operation} documents.`
  )
}
