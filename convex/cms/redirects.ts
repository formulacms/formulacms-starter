import { requireOwnerAndOptionalModule } from "../lib/modules/state"
import { ConvexError, v } from "convex/values"
import { paginationOptsValidator } from "convex/server"
import type { Doc, Id } from "../_generated/dataModel"
import type { QueryCtx } from "../_generated/server"
import { mutation, query } from "../_generated/server"
import { requireOperationAccess } from "../lib/access/policy"
import { buildLocaleRelativePath } from "../lib/contentTypes/routing"
import { resolveModuleGuardState } from "../lib/modules/state"
import {
  readCurrentSnapshotProjection,
  readPublicationAuthority,
} from "../lib/publishing/snapshots"
import { assertPublicLanguageVersion } from "../lib/language/state"
import { recordPublicChange } from "../lib/language/freshness"

// Inline locale config: Convex modules can't share helpers freely, and pages.ts
// keeps its `getLocaleConfig` private. Reads the same settings row.
async function getLocaleConfig(ctx: QueryCtx) {
  const settings = await ctx.db.query("siteSettings").first()
  return {
    defaultLocale: settings?.defaultLocale ?? "en",
    enabledLocales:
      settings?.enabledLocales && settings.enabledLocales.length > 0
        ? settings.enabledLocales
        : ["en"],
    homePageId: settings?.homePageId ?? null,
  }
}

// Delegates the `pageType`-aware body build to the shared routing seam
// (`convex/lib/contentTypes/routing.ts`) so this helper stays in sync with the
// other five URL-builder mirrors (`localizedUrlsForPage` /
// `getLocalizedPathsByIds` / `getLocalizedBreadcrumb` / `publicPathForPage` /
// `canonicalPathForPage`). Picks the URL for one locale, falling back to the
// default locale if the page isn't translated into the target.
async function urlForPageInLocale(
  ctx: QueryCtx,
  pageId: Id<"pages">,
  locale: string,
  cfg: { defaultLocale: string; homePageId: Id<"pages"> | null }
): Promise<string | null> {
  const authority = await readPublicationAuthority(ctx)
  if (authority === "invalid") return null
  if (authority === "snapshot_active") {
    const projection = await readCurrentSnapshotProjection(ctx, pageId, locale)
    if (!projection?.path) return null
    const prefix = locale === cfg.defaultLocale ? "" : `/${locale}`
    if (pageId === cfg.homePageId) return prefix || "/"
    return `${prefix}${projection.path}`
  }
  const page = await ctx.db.get(pageId)
  if (!page || page.deletedAt !== undefined) return null
  const targetLocale = page.content?.[locale] ? locale : cfg.defaultLocale
  if (!page.content?.[targetLocale]) return null
  const localePrefix =
    targetLocale === cfg.defaultLocale ? "" : `/${targetLocale}`
  if (page._id === cfg.homePageId) return localePrefix || "/"
  const slug =
    (targetLocale !== cfg.defaultLocale &&
      page.localizedSlugs?.[targetLocale]) ||
    page.slug
  const ancestry =
    (targetLocale !== cfg.defaultLocale &&
      page.localizedAncestryPaths?.[targetLocale]) ||
    page.ancestryPath ||
    ""
  const body = buildLocaleRelativePath({
    pageType: page.pageType,
    slug,
    ancestry,
  })
  // Non-routable content types have no public URL — a redirect that targets
  // one drops to null (caller skips the row).
  if (body === null) return null
  return `${localePrefix}${body}`
}

export type RedirectRuleOrigin = "manual" | "unresolved"

// The one interpretation point for stored rule provenance (M01a). It reads only
// the explicit `origin` field, so a row's paths, locale, or destination can
// never decide its origin. Rows written before provenance existed stay
// "unresolved"; they are preserved as-is, not reclassified. Matching in
// `resolve`/`listActiveKeys` does not read provenance.
export function redirectRuleOrigin(
  row: Pick<Doc<"redirects">, "origin">
): RedirectRuleOrigin {
  return row.origin === "manual" ? "manual" : "unresolved"
}

// Module guard (M01b). Every entry below checks Redirects state: public entries
// withhold their whole effect while disabled, private entries reject after the
// owner check. Invalid module state propagates as `CMS_MODULE_STATE_INVALID`.
// Neither reads row provenance or path shape.
async function redirectsEnabled(ctx: QueryCtx): Promise<boolean> {
  return (await resolveModuleGuardState(ctx, "redirects")).effective
}


// Admin route status read (M01c). Owner first, then only the narrow guard, so
// another module's readiness (a corrupt Email row) can never hide this route.
// Returns one sanitized fact; invalid state throws `CMS_MODULE_STATE_INVALID`.
function isExternal(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

// Locale-scoped match first (`locale` exact), then locale-agnostic fallback
// (`locale === undefined` rows). Returns null if neither matched.
async function findMatch(
  ctx: QueryCtx,
  path: string,
  locale: string | undefined
): Promise<Doc<"redirects"> | null> {
  if (locale) {
    const scoped = await ctx.db
      .query("redirects")
      .withIndex("by_locale_fromPath", (q) =>
        q.eq("locale", locale).eq("fromPath", path)
      )
      .first()
    if (scoped) return scoped
  }
  return ctx.db
    .query("redirects")
    .withIndex("by_locale_fromPath", (q) =>
      q.eq("locale", undefined).eq("fromPath", path)
    )
    .first()
}

// Resolves a redirect to a final destination URL, including locale prefix for
// internal paths. Called by `proxy.ts` on every public request — keep it cheap.
export const resolve = query({
  args: {
    path: v.string(),
    locale: v.optional(v.string()),
    languageVersion: v.number(),
  },
  returns: v.union(
    v.object({
      destination: v.string(),
      statusCode: v.union(v.literal(301), v.literal(302)),
    }),
    v.null()
  ),
  handler: async (ctx, { path, locale, languageVersion }) => {
    await assertPublicLanguageVersion(ctx, languageVersion)
    if (!(await redirectsEnabled(ctx))) return null
    const authority = await readPublicationAuthority(ctx)
    if (authority === "invalid") return null
    const cfg = await getLocaleConfig(ctx)
    if (
      authority === "snapshot_active" &&
      (!locale || !cfg.enabledLocales.includes(locale))
    )
      return null
    const row =
      authority === "snapshot_active"
        ? await ctx.db
            .query("redirects")
            .withIndex("by_locale_fromPath", (q) =>
              q.eq("locale", locale).eq("fromPath", path)
            )
            .first()
        : await findMatch(ctx, path, locale)
    if (!row) return null
    const targetLocale = locale ?? cfg.defaultLocale

    let destination: string | null = null
    if (row.toPageId) {
      destination = await urlForPageInLocale(
        ctx,
        row.toPageId,
        targetLocale,
        cfg
      )
    }
    if (!destination && row.toPath) {
      if (isExternal(row.toPath)) {
        destination = row.toPath
      } else {
        // Stored as locale-stripped path; re-add locale prefix per i18n rule
        // (default locale unprefixed, others prefixed).
        const localePrefix =
          targetLocale === cfg.defaultLocale ? "" : `/${targetLocale}`
        const body = row.toPath === "/" ? "" : row.toPath
        destination = `${localePrefix}${body}` || "/"
      }
    }
    if (!destination) return null

    return { destination, statusCode: row.statusCode }
  },
})

// Public key index for the middleware redirect gate. Returns only the match
// keys (`fromPath` + optional `locale`) for every redirect, so `proxy.ts` can
// TTL-cache the set and skip the heavier `resolve` round-trip on the (common)
// no-redirect path.
//
// Tradeoff (accepted): `fromPath` existence is enumerable by design. Redirect
// sources are retired public URLs, so leaking their existence is low-risk; the
// destinations (toPath/toPageId) and statusCode are deliberately NOT exposed
// here. A future "secret redirects" requirement would gate this query behind
// auth or drop it in favor of a hashed/bloom probe.
//
// The gate MUST see every key or it would fail CLOSED (skip `resolve`) and break
// a redirect beyond the cap. Redirects are an operator-curated, low-cardinality
// table, so `REDIRECT_KEY_CAP` is set generously high; if a deployment somehow
// exceeds it the cache layer detects the full page and fails OPEN instead (see
// `REDIRECT_KEY_CAP` in `lib/i18n/redirect-keys.ts`, which must match).
const REDIRECT_KEY_CAP = 5000

export const listActiveKeys = query({
  args: { languageVersion: v.number() },
  returns: v.array(
    v.object({
      fromPath: v.string(),
      locale: v.optional(v.string()),
    })
  ),
  handler: async (ctx, { languageVersion }) => {
    await assertPublicLanguageVersion(ctx, languageVersion)
    if (!(await redirectsEnabled(ctx))) return []
    if ((await readPublicationAuthority(ctx)) === "invalid") return []
    const rows = await ctx.db.query("redirects").take(REDIRECT_KEY_CAP)
    return rows.map((r) => ({ fromPath: r.fromPath, locale: r.locale }))
  },
})

// Admin list: returns redirects sorted by fromPath, with display labels for the
// destination resolved server-side so the UI doesn't have to re-fetch pages.
export const list = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("redirects"),
      fromPath: v.string(),
      toPath: v.optional(v.string()),
      toPageId: v.optional(v.id("pages")),
      locale: v.optional(v.string()),
      statusCode: v.union(v.literal(301), v.literal(302)),
      createdAt: v.number(),
      toLabel: v.string(),
      toPageTitle: v.union(v.string(), v.null()),
    })
  ),
  handler: async (ctx) => {
    await requireOperationAccess(ctx)
    await requireOwnerAndOptionalModule(ctx, "redirects")
    const rows: Doc<"redirects">[] = await ctx.db.query("redirects").take(500)
    rows.sort((a, b) => a.fromPath.localeCompare(b.fromPath))

    const cfg = await getLocaleConfig(ctx)
    return await Promise.all(rows.map((r) => enrichRedirectRow(ctx, r, cfg)))
  },
})

const redirectRowValidator = v.object({
  _id: v.id("redirects"),
  fromPath: v.string(),
  toPath: v.optional(v.string()),
  toPageId: v.optional(v.id("pages")),
  locale: v.optional(v.string()),
  statusCode: v.union(v.literal(301), v.literal(302)),
  createdAt: v.number(),
  toLabel: v.string(),
  toPageTitle: v.union(v.string(), v.null()),
})

const paginatedRedirectsValidator = v.object({
  page: v.array(redirectRowValidator),
  isDone: v.boolean(),
  continueCursor: v.string(),
  splitCursor: v.optional(v.union(v.string(), v.null())),
  pageStatus: v.optional(
    v.union(v.literal("SplitRecommended"), v.literal("SplitRequired"), v.null())
  ),
})

/**
 * Cursor-paginated admin redirects list (plan 023 Phase 4 #2) for
 * `usePaginatedQuery`, sorted by source path via `by_fromPath` — the same
 * display order the bounded `list` produced in memory, minus the 500-row cap.
 */
export const listPaginated = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginatedRedirectsValidator,
  handler: async (ctx, args) => {
    await requireOperationAccess(ctx)
    await requireOwnerAndOptionalModule(ctx, "redirects")
    const result = await ctx.db
      .query("redirects")
      .withIndex("by_fromPath")
      .paginate(args.paginationOpts)

    const cfg = await getLocaleConfig(ctx)
    const enriched = await Promise.all(
      result.page.map((r) => enrichRedirectRow(ctx, r, cfg))
    )
    return { ...result, page: enriched }
  },
})

async function enrichRedirectRow(
  ctx: QueryCtx,
  r: Doc<"redirects">,
  cfg: Awaited<ReturnType<typeof getLocaleConfig>>
) {
  let toLabel: string
  let toPageTitle: string | null = null
  if (r.toPageId) {
    const page = await ctx.db.get(r.toPageId)
    if (page && page.deletedAt === undefined) {
      const previewLocale = r.locale ?? cfg.defaultLocale
      toLabel =
        (await urlForPageInLocale(ctx, page._id, previewLocale, cfg)) ??
        "(page missing)"
      toPageTitle =
        page.content?.[previewLocale]?.title ??
        page.content?.[cfg.defaultLocale]?.title ??
        null
    } else {
      toLabel = "(page deleted)"
    }
  } else {
    toLabel = r.toPath ?? "(missing)"
  }
  return {
    _id: r._id,
    fromPath: r.fromPath,
    toPath: r.toPath,
    toPageId: r.toPageId,
    locale: r.locale,
    statusCode: r.statusCode,
    createdAt: r.createdAt,
    toLabel,
    toPageTitle,
  }
}

function validateFromPath(p: string): string {
  const trimmed = p.trim()
  if (!trimmed.startsWith("/")) {
    throw new ConvexError("Source path must start with /")
  }
  if (trimmed.length > 1 && trimmed.endsWith("/")) {
    return trimmed.slice(0, -1)
  }
  return trimmed
}

function validateToPath(p: string): string {
  const trimmed = p.trim()
  if (!isExternal(trimmed) && !trimmed.startsWith("/")) {
    throw new ConvexError("Destination must be an absolute path or full URL")
  }
  if (trimmed.length > 1 && !isExternal(trimmed) && trimmed.endsWith("/")) {
    return trimmed.slice(0, -1)
  }
  return trimmed
}

export const create = mutation({
  args: {
    fromPath: v.string(),
    toPath: v.optional(v.string()),
    toPageId: v.optional(v.id("pages")),
    locale: v.optional(v.string()),
    statusCode: v.union(v.literal(301), v.literal(302)),
  },
  returns: v.id("redirects"),
  handler: async (ctx, args) => {
    await requireOperationAccess(ctx)
    await requireOwnerAndOptionalModule(ctx, "redirects")
    if (!args.toPath && !args.toPageId) {
      throw new ConvexError({ code: "REDIRECT_DESTINATION_REQUIRED", message: "Destination required: pick a page or enter a URL" })
    }
    if (args.toPath && args.toPageId) {
      throw new ConvexError({ code: "REDIRECT_DESTINATION_AMBIGUOUS", message: "Specify either a page or a URL, not both" })
    }
    const fromPath = validateFromPath(args.fromPath)
    const toPath = args.toPath ? validateToPath(args.toPath) : undefined

    if (toPath && fromPath === toPath && !args.locale) {
      throw new ConvexError({ code: "REDIRECT_SAME_PATH", message: "Source and destination must differ" })
    }

    // Reject duplicates on (fromPath, locale): the resolver returns the first
    // match per scope, so a duplicate would silently shadow.
    const existing = await findMatch(ctx, fromPath, args.locale)
    if (existing) {
      throw new ConvexError({
        code: "REDIRECT_EXISTS",
        message: args.locale
          ? `A redirect from ${fromPath} for locale ${args.locale} already exists`
          : `A redirect from ${fromPath} already exists`,
      })
    }

    const now = Date.now()
    const id = await ctx.db.insert("redirects", {
      fromPath,
      toPath,
      toPageId: args.toPageId,
      locale: args.locale,
      statusCode: args.statusCode,
      createdAt: now,
      updatedAt: now,
      // Server-stamped: callers cannot choose provenance.
      origin: "manual",
    })
    // M05 domain A: scoped rules advance their locale, unscoped ones the site.
    // F09 never recorded redirect writes, so its part stays off.
    await recordPublicChange(ctx, {
      source: false,
      scopes: [{ locale: args.locale, domains: ["route_claims"] }],
    })
    return id
  },
})

export const remove = mutation({
  args: { id: v.id("redirects") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    await requireOperationAccess(ctx)
    await requireOwnerAndOptionalModule(ctx, "redirects")
    const rule = await ctx.db.get(id)
    await ctx.db.delete(id)
    await recordPublicChange(ctx, {
      source: false,
      scopes: [{ locale: rule?.locale, domains: ["route_claims"] }],
    })
    return null
  },
})
