import { ConvexError, v } from "convex/values"
import { mutation, query } from "../_generated/server"
import { requireOperationAccess } from "../lib/access/policy"
import { resolveOwnerPrincipal } from "../lib/access/owner"
import { hasAdminDictionary } from "../../lib/i18n/admin-dictionaries"

/**
 * The signed-in caller's stored admin-UI language preference, or `null` if they
 * have never set one. The (core)/layout uses this to pick the next-intl bundle;
 * unset → fall back to siteSettings.defaultLocale → "en".
 */
export const getAdminLocale = query({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) return null
    try {
      const owner = await resolveOwnerPrincipal(ctx)
      if (!owner) return null
    } catch {
      return null
    }
    const row = await ctx.db
      .query("userPreferences")
      .withIndex("by_authId", (q) => q.eq("authId", identity.subject))
      .unique()
    return row?.adminLocale ?? null
  },
})

/**
 * Persist the caller's admin-UI language only when its dictionary ships.
 * Existing unsupported saved values remain readable until the owner changes
 * the preference; new writes cannot select an untranslated admin UI.
 */
export const setAdminLocale = mutation({
  args: { locale: v.string() },
  returns: v.null(),
  handler: async (ctx, { locale }) => {
    const owner = await requireOperationAccess(ctx)
    if (!hasAdminDictionary(locale)) {
      throw new ConvexError(`Unsupported locale: ${locale}`)
    }
    const row = await ctx.db
      .query("userPreferences")
      .withIndex("by_authId", (q) => q.eq("authId", owner.authId))
      .unique()
    if (row) {
      await ctx.db.patch(row._id, { adminLocale: locale })
    } else {
      await ctx.db.insert("userPreferences", {
        authId: owner.authId,
        adminLocale: locale,
      })
    }
    return null
  },
})
