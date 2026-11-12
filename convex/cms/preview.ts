import { ConvexError, v } from "convex/values"
import { mutation } from "../_generated/server"
import type { MutationCtx, QueryCtx } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"
import { pageDocValidator } from "../schema"
import { requireOperationAccess } from "../lib/access/policy"
import {
  readFrozenSnapshotProjection,
  readPublicationAuthority,
} from "../lib/publishing/snapshots"
import { assertOrdinaryLocale } from "../lib/language/state"

const previewResult = v.object({
  page: pageDocValidator,
  requestedLocale: v.string(),
  renderLocale: v.string(),
  isFallback: v.boolean(),
})

const previewSessionResult = v.object({
  sessionToken: v.string(),
  pageId: v.id("pages"),
  requestedLocale: v.string(),
  expiresAt: v.number(),
})

type PreviewCtx = QueryCtx | MutationCtx

async function oneDraft(ctx: PreviewCtx, pageId: Id<"pages">, locale: string) {
  const rows = await ctx.db.query("pageLocaleDrafts")
    .withIndex("by_pageId_and_locale", (q) => q.eq("pageId", pageId).eq("locale", locale)).take(2)
  return rows.length === 1 ? rows[0]! : null
}

type PreviewLocaleInput = {
  pageId: Id<"pages">
  pageType: Doc<"pages">["pageType"]
  slug: string
  content: Record<string, unknown>
}

/** Resolve only this locale's mutable draft or its exact frozen draft base. */
async function previewLocaleInput(
  ctx: PreviewCtx,
  pageId: Id<"pages">,
  locale: string
): Promise<PreviewLocaleInput | null> {
  const draft = await oneDraft(ctx, pageId, locale)
  if (draft) {
    return {
      pageId,
      pageType: draft.pageType,
      slug: draft.slug,
      content: draft.content as unknown as Record<string, unknown>,
    }
  }
  const states = await ctx.db.query("pageLocalePublicationStates")
    .withIndex("by_pageId_and_locale", (q) =>
      q.eq("pageId", pageId).eq("locale", locale)
    ).take(2)
  if (states.length !== 1 || !states[0]!.draftBaseSnapshotId) return null
  const base = await readFrozenSnapshotProjection(
    ctx,
    states[0]!.draftBaseSnapshotId,
    pageId,
    locale
  )
  if (!base) return null
  return {
    pageId,
    pageType: base.payload.page.pageType,
    slug: base.payload.localized.slug,
    content: base.payload.localized.content,
  }
}

async function oneSession(ctx: PreviewCtx, token: string) {
  const rows = await ctx.db.query("pagePublicationPreviewSessions")
    .withIndex("by_sessionToken", (q) => q.eq("sessionToken", token)).take(2)
  return rows.length === 1 ? rows[0]! : null
}

async function requirePreviewSession(
  ctx: PreviewCtx,
  token: string,
  pageId: Id<"pages"> | undefined,
  locale: string | undefined
) {
  const owner = await requireOperationAccess(ctx)
  const session = await oneSession(ctx, token)
  if (!session || session.expiresAt <= Date.now()) {
    throw new ConvexError("PREVIEW_SESSION_INVALID")
  }
  if (
    session.ownerId !== owner.ownerId ||
    session.authId !== owner.authId ||
    session.tokenIdentifier !== owner.tokenIdentifier ||
    (pageId !== undefined && session.pageId !== pageId) ||
    (locale !== undefined && session.requestedLocale !== locale)
  ) {
    throw new ConvexError("PREVIEW_SESSION_OWNER_MISMATCH")
  }
  return { owner, session }
}

/** Establish the only successor preview boundary. */
export const createPreviewSession = mutation({
  args: {
    pageId: v.id("pages"),
    locale: v.string(),
    ttlMs: v.optional(v.number()),
  },
  returns: previewSessionResult,
  handler: async (ctx, args) => {
    if ((await readPublicationAuthority(ctx)) !== "snapshot_active") {
      throw new ConvexError("PUBLISHED_SNAPSHOT_AUTHORITY_REQUIRED")
    }
    const owner = await requireOperationAccess(ctx)
    const page = await ctx.db.get(args.pageId)
    if (!page) throw new ConvexError("PAGE_NOT_FOUND")
    const states = await ctx.db.query("pagePublicationPageStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", args.pageId)).take(2)
    if (states.length !== 1 || states[0]!.lifecycleState !== "active") {
      throw new ConvexError("PAGE_NOT_PREVIEWABLE")
    }
    // F09 invariant 3: current language only, failing closed without settings.
    // Owner preview of an open transition's target is F09c consumer work.
    await assertOrdinaryLocale(ctx, args.locale)
    const ttl = args.ttlMs ?? 15 * 60 * 1000
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 60 * 60 * 1000) {
      throw new ConvexError("PREVIEW_SESSION_TTL_INVALID")
    }
    const now = Date.now()
    const sessionToken = crypto.randomUUID()
    const expiresAt = now + ttl
    await ctx.db.insert("pagePublicationPreviewSessions", {
      sessionToken,
      ownerId: owner.ownerId,
      authId: owner.authId,
      tokenIdentifier: owner.tokenIdentifier,
      pageId: args.pageId,
      requestedLocale: args.locale,
      expiresAt,
      createdAt: now,
    })
    return { sessionToken, pageId: args.pageId, requestedLocale: args.locale, expiresAt }
  },
})

/** Private owner-only draft reader. A mutation makes wall-clock expiry authoritative. */
export const getPreviewPage = mutation({
  args: {
    pageId: v.optional(v.id("pages")),
    locale: v.optional(v.string()),
    allowFallback: v.optional(v.boolean()),
    sessionToken: v.optional(v.string()),
  },
  returns: v.union(previewResult, v.null()),
  handler: async (ctx, args) => {
    const authority = await readPublicationAuthority(ctx)
    let pageId = args.pageId
    let locale = args.locale
    if (authority === "snapshot_active") {
      if (!args.sessionToken) throw new ConvexError("PREVIEW_SESSION_REQUIRED")
      const { session } = await requirePreviewSession(ctx, args.sessionToken, pageId, locale)
      pageId = session.pageId
      locale = session.requestedLocale
    } else {
      await requireOperationAccess(ctx)
    }
    if (!pageId || !locale) return null
    const [page, sharedRows] = await Promise.all([
      ctx.db.get(pageId),
      ctx.db.query("pageSharedDrafts").withIndex("by_pageId", (q) => q.eq("pageId", pageId!)).take(2),
    ])
    if (!page || sharedRows.length !== 1) return null
    const requested = await previewLocaleInput(ctx, pageId, locale)
    let draft = requested
    let renderLocale = locale
    if (!draft && args.allowFallback) {
      const settings = await ctx.db.query("siteSettings").first()
      const fallbackLocale = settings?.defaultLocale ?? "en"
      draft = await previewLocaleInput(ctx, pageId, fallbackLocale)
      renderLocale = fallbackLocale
    }
    if (!draft || draft.pageType !== page.pageType) return null
    const shared = sharedRows[0]!
    if (shared.pageType !== page.pageType) return null
    return {
      page: {
        ...page,
        ...shared.descriptor,
        ...shared.system,
        slug: draft.slug,
        content: { [renderLocale]: draft.content },
      } as Doc<"pages">,
      requestedLocale: locale,
      renderLocale,
      isFallback: renderLocale !== locale,
    }
  },
})

/** Authenticated, session-bound path lookup; draft slugs are never anonymous. */
export const resolvePreviewPath = mutation({
  args: {
    path: v.string(),
    locale: v.optional(v.string()),
    allowFallback: v.optional(v.boolean()),
    sessionToken: v.optional(v.string()),
  },
  returns: v.union(v.object({ pageId: v.id("pages"), renderLocale: v.string(), isFallback: v.boolean() }), v.null()),
  handler: async (ctx, args) => {
    const authority = await readPublicationAuthority(ctx)
    let session: Doc<"pagePublicationPreviewSessions"> | null = null
    if (authority === "snapshot_active") {
      if (!args.sessionToken) throw new ConvexError("PREVIEW_SESSION_REQUIRED")
      session = (await requirePreviewSession(ctx, args.sessionToken, undefined, args.locale)).session
    } else {
      await requireOperationAccess(ctx)
    }
    const requestedLocale = session?.requestedLocale ?? args.locale
    if (!requestedLocale) return null
    const leaf = args.path.split("/").filter(Boolean).at(-1)
    let drafts = session
      ? [await previewLocaleInput(ctx, session.pageId, requestedLocale)].filter(
          (draft): draft is PreviewLocaleInput => draft !== null
        )
      : leaf
          ? await ctx.db.query("pageLocaleDrafts")
            .withIndex("by_locale_and_slug", (q) => q.eq("locale", requestedLocale).eq("slug", leaf)).take(2)
        : []
    let renderLocale = requestedLocale
    if (drafts.length === 0 && args.allowFallback) {
      const settings = await ctx.db.query("siteSettings").first()
      renderLocale = settings?.defaultLocale ?? "en"
      drafts = session
        ? [await previewLocaleInput(ctx, session.pageId, renderLocale)].filter(
            (draft): draft is PreviewLocaleInput => draft !== null
          )
        : leaf
          ? await ctx.db.query("pageLocaleDrafts")
              .withIndex("by_locale_and_slug", (q) => q.eq("locale", renderLocale).eq("slug", leaf)).take(2)
          : []
    }
    if (drafts.length !== 1 || (session && drafts[0]!.pageId !== session.pageId)) return null
    if (session) {
      const settings = await ctx.db.query("siteSettings").first()
      const isBoundHome = settings?.homePageId === session.pageId
      if ((args.path === "/") !== isBoundHome) return null
      if (!isBoundHome && (!leaf || drafts[0]!.slug !== leaf)) return null
    }
    return { pageId: drafts[0]!.pageId, renderLocale, isFallback: renderLocale !== requestedLocale }
  },
})
