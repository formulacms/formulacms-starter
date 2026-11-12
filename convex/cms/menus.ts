import { ConvexError, v } from "convex/values"
import { mutation, query } from "../_generated/server"
import type { MutationCtx, QueryCtx } from "../_generated/server"
import type { Id } from "../_generated/dataModel"
import { internal } from "../_generated/api"
import { requireOperationAccess } from "../lib/access/policy"
import {
  DEFAULT_MENU_SLUGS,
  mapPanelBlocks,
  panelBlocks,
  type LocaleBlock,
  type ResolvedBlock,
  canonicalResolvedNavItemValidator,
  navItemValidator,
  type CanonicalResolvedNavItem,
  type LocaleNavItem,
  type NavItem,
  type Target,
} from "../lib/menu"
import {
  countMenuNodesMissingText,
  localizeCanonicalNav,
  normalizeOptionalMenuText,
} from "../lib/menu/canonical"
import {
  clearMenuReferences,
  refreshMenuReferences,
} from "../lib/menu/references"
import { validateCanonicalWrite } from "../lib/menu/canonicalWrite"
import { validateCanonicalMenu } from "../lib/menu/validate"
import { getMenuBySlug } from "../lib/menu/key"
import { resolveEffectiveHomePageId } from "../lib/pages/home"
import { buildLocaleRelativePath } from "../lib/contentTypes/routing"
import {
  readCurrentSnapshotProjection,
  readPublicationAuthority,
} from "../lib/publishing/snapshots"
import {
  assertPublicLanguageVersion,
  publicLocaleEligibility,
  recordTargetMenuTextChange,
  resolveDraftLocaleEligibility,
} from "../lib/language/state"
import { recordPublicChange } from "../lib/language/freshness"

async function getDefaultLocale(ctx: QueryCtx | MutationCtx): Promise<string> {
  const settings = await ctx.db.query("siteSettings").first()
  return settings?.defaultLocale ?? "en"
}

async function scheduleMenuRevalidation(ctx: MutationCtx): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.cms.revalidate.revalidateMenus, {})
}

async function insertCanonicalMenu(
  ctx: MutationCtx,
  slug: string,
  nav: NavItem[],
  updatedBy: string
): Promise<Id<"menus">> {
  return await ctx.db.insert("menus", {
    slug,
    nav,
    updatedAt: Date.now(),
    // F01 invariant 8: authenticated token provenance, never an access key.
    updatedBy,
  })
}

export const getCanonical = query({
  args: { slug: v.string() },
  returns: v.union(
    v.object({
      slug: v.string(),
      nav: v.array(navItemValidator),
      updatedAt: v.number(),
    }),
    v.null()
  ),
  handler: async (ctx, { slug }) => {
    await requireOperationAccess(ctx)
    const menu = await getMenuBySlug(ctx, slug)
    if (!menu || menu.deletedAt !== undefined) return null
    return { slug: menu.slug, nav: menu.nav, updatedAt: menu.updatedAt }
  },
})

export const saveCanonical = mutation({
  args: {
    slug: v.string(),
    locale: v.string(),
    nav: v.array(navItemValidator),
    expectedUpdatedAt: v.optional(v.union(v.number(), v.null())),
  },
  returns: v.object({ id: v.id("menus"), updatedAt: v.number() }),
  handler: async (
    ctx,
    { slug, locale, nav: submittedNav, expectedUpdatedAt }
  ) => {
    const auth = await requireOperationAccess(ctx)
    // M05 C6: only an enabled language, or the F09 target while its
    // transition can still be prepared, may carry menu text.
    await resolveDraftLocaleEligibility(ctx, locale)
    const [defaultLocale, menu] = await Promise.all([
      getDefaultLocale(ctx),
      getMenuBySlug(ctx, slug),
    ])
    if (menu?.deletedAt !== undefined) {
      throw new ConvexError(`Menu "${slug}" was deleted; restore it first`)
    }
    if (
      !menu &&
      !DEFAULT_MENU_SLUGS.some((defaultSlug) => defaultSlug === slug)
    ) {
      throw new ConvexError(`Menu "${slug}" must have exactly one live row`)
    }
    if (
      expectedUpdatedAt !== undefined &&
      expectedUpdatedAt !== (menu?.updatedAt ?? null)
    ) {
      throw new Error("Menu changed since editing started")
    }
    const nav = normalizeOptionalMenuText(submittedNav)
    validateCanonicalMenu(nav)
    validateCanonicalWrite(menu?.nav ?? [], nav, locale, defaultLocale)
    let id: Id<"menus">
    if (menu) {
      id = menu._id
      await ctx.db.patch("menus", id, {
        nav,
        updatedAt: Math.max(Date.now(), menu.updatedAt + 1),
        // F01 invariant 8: authenticated token provenance, never an access key.
        updatedBy: auth.tokenIdentifier,
        schemaVersion: undefined,
      })
    } else {
      id = await insertCanonicalMenu(ctx, slug, nav, auth.tokenIdentifier)
    }
    const saved = await ctx.db.get("menus", id)
    if (!saved) throw new ConvexError("Menu not found after save")
    await refreshMenuReferences(ctx, saved)
    // F09 invariants 6/7: target-locale-only text is prepared; every other
    // live Menu save advances the source public set.
    if (!(await recordTargetMenuTextChange(ctx, locale))) {
      // M05 domain B: a non-default save changes only that locale's text
      // (`validateCanonicalWrite`); a default save may change structure.
      await recordPublicChange(ctx, {
        scopes: [
          locale === defaultLocale
            ? { domains: ["publication_set"] }
            : { locale, domains: ["publication_set"] },
        ],
      })
    }
    await scheduleMenuRevalidation(ctx)
    return { id, updatedAt: saved.updatedAt }
  },
})

export const createCanonical = mutation({
  args: { slug: v.string() },
  returns: v.id("menus"),
  handler: async (ctx, { slug }) => {
    const auth = await requireOperationAccess(ctx)
    const existing = await getMenuBySlug(ctx, slug)
    if (existing && existing.deletedAt === undefined) {
      throw new ConvexError(`Menu "${slug}" already exists`)
    }
    if (existing) {
      throw new ConvexError(`Menu "${slug}" was deleted; restore it first`)
    }
    const id = await insertCanonicalMenu(ctx, slug, [], auth.tokenIdentifier)
    await recordPublicChange(ctx, {
      scopes: [{ domains: ["publication_set"] }],
    })
    await scheduleMenuRevalidation(ctx)
    return id
  },
})

export const listSlugs = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    await requireOperationAccess(ctx)
    const slugs: string[] = []
    for await (const menu of ctx.db.query("menus").withIndex("by_slug")) {
      if (menu.deletedAt === undefined) slugs.push(menu.slug)
    }
    return slugs
  },
})

/** Same bound the language transition reads menus with. */
const MENU_TEXT_STATUS_LIMIT = 64

/**
 * How many menu items have no text yet in each given language, over the live
 * menus. The Languages screen shows it as a quiet status line; it never
 * blocks anything (switching the default language does not refuse on menus).
 */
export const countMenuTextMissing = query({
  args: { locales: v.array(v.string()) },
  returns: v.record(v.string(), v.number()),
  handler: async (ctx, args) => {
    await requireOperationAccess(ctx)
    const menus = await ctx.db
      .query("menus")
      .withIndex("by_slug")
      .take(MENU_TEXT_STATUS_LIMIT)
    const counts: Record<string, number> = {}
    for (const locale of new Set(args.locales)) {
      counts[locale] = 0
      for (const menu of menus) {
        if (menu.deletedAt !== undefined) continue
        counts[locale] += countMenuNodesMissingText(menu.nav, locale)
      }
    }
    return counts
  },
})

export const softDelete = mutation({
  args: { id: v.id("menus") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    await requireOperationAccess(ctx)
    const menu = await ctx.db.get(id)
    if (!menu) throw new ConvexError("Menu not found")
    await ctx.db.patch(id, { deletedAt: Date.now() })
    await clearMenuReferences(ctx, id)
    await recordPublicChange(ctx, {
      scopes: [{ domains: ["publication_set"] }],
    })
    await scheduleMenuRevalidation(ctx)
    return null
  },
})

export const restore = mutation({
  args: { id: v.id("menus") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    await requireOperationAccess(ctx)
    const menu = await ctx.db.get(id)
    if (!menu) throw new ConvexError("Menu not found")
    const nav = normalizeOptionalMenuText(menu.nav)
    validateCanonicalMenu(nav)
    const existing = await getMenuBySlug(ctx, menu.slug)
    if (existing && existing._id !== id && existing.deletedAt === undefined) {
      throw new ConvexError(
        `Cannot restore menu because another live row exists for "${menu.slug}"`
      )
    }
    await ctx.db.patch("menus", id, { deletedAt: undefined, nav })
    const restored = await ctx.db.get(id)
    if (!restored) throw new ConvexError("Menu not found after restore")
    await refreshMenuReferences(ctx, restored)
    await recordPublicChange(ctx, {
      scopes: [{ domains: ["publication_set"] }],
    })
    await scheduleMenuRevalidation(ctx)
    return null
  },
})

export const remove = mutation({
  args: { id: v.id("menus") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    await requireOperationAccess(ctx)
    const menu = await ctx.db.get(id)
    if (!menu) throw new ConvexError("Menu not found")
    await clearMenuReferences(ctx, id)
    await ctx.db.delete(id)
    await recordPublicChange(ctx, {
      scopes: [{ domains: ["publication_set"] }],
    })
    await scheduleMenuRevalidation(ctx)
    return null
  },
})

async function publicPathForPage(
  ctx: QueryCtx,
  pageId: Id<"pages">,
  locale: string,
  defaultLocale: string,
  homePageId: Id<"pages"> | null
): Promise<string | null> {
  const authority = await readPublicationAuthority(ctx)
  if (authority === "invalid") return null
  if (authority === "snapshot_active") {
    const projection = await readCurrentSnapshotProjection(ctx, pageId, locale)
    if (!projection?.path) return null
    const prefix = locale === defaultLocale ? "" : `/${locale}`
    // Home selection is configuration, but its URL still requires that exact
    // locale's selected snapshot; never infer it from the mutable Page row.
    if (pageId === homePageId) return prefix || "/"
    return `${prefix}${projection.path}`
  }
  const page = await ctx.db.get(pageId)
  if (!page) return null
  // A Public Link exists only when the target has a current Published
  // Snapshot in this locale. Archived and draft rows may retain content for
  // admin/recovery flows, but that content is not a Public Projection.
  if (
    page.deletedAt !== undefined ||
    page.status !== "published" ||
    !page.content?.[locale]
  ) {
    return null
  }
  const prefix = locale === defaultLocale ? "" : `/${locale}`
  if (page._id === homePageId) return prefix || "/"
  const slug =
    (locale !== defaultLocale && page.localizedSlugs?.[locale]) || page.slug
  const ancestry =
    (locale !== defaultLocale && page.localizedAncestryPaths?.[locale]) ||
    page.ancestryPath ||
    ""
  const body = buildLocaleRelativePath({
    pageType: page.pageType,
    slug,
    ancestry,
  })
  return body === null ? null : `${prefix}${body}`
}

async function resolveCanonicalNav(
  ctx: QueryCtx,
  nav: readonly NavItem[],
  locale: string,
  language: { defaultLocale: string; publicLocales: readonly string[] }
): Promise<CanonicalResolvedNavItem[]> {
  const settings = await ctx.db.query("siteSettings").first()
  const authority = await readPublicationAuthority(ctx)
  if (authority === "invalid") return []
  const { defaultLocale, publicLocales } = language
  if (
    authority === "snapshot_active" &&
    !publicLocales.includes(locale)
  ) {
    return []
  }
  const homePageId =
    authority === "snapshot_active"
      ? (settings?.homePageId ?? null)
      : await resolveEffectiveHomePageId(ctx, settings?.homePageId)
  // M05 C6 (owner decision, 2026-09-15): untranslated nodes are omitted
  // with their subtree before any target is resolved, so an omitted node
  // costs no read and nothing falls back to the default language.
  const localized = localizeCanonicalNav(nav, locale)
  const blocksOf = (item: LocaleNavItem) =>
    panelBlocks(item.panel).map((entry) => entry.block)
  const internalIds = new Set<Id<"pages">>()
  const storageIds = new Set<Id<"_storage">>()
  const visitTarget = (value: Target | undefined) => {
    if (value?.type === "internal") internalIds.add(value.pageId)
  }
  for (const item of localized) {
    visitTarget(item.target)
    for (const block of blocksOf(item)) {
      if (block.kind === "linkGroup") {
        for (const link of block.links) visitTarget(link.target)
      } else if (block.kind === "dynamicList") {
        visitTarget(block.seeAll?.target)
      } else {
        visitTarget(block.target)
        visitTarget(block.link?.target)
        if (block.image?.storageId) storageIds.add(block.image.storageId)
      }
    }
  }

  const urlByPageId = new Map<Id<"pages">, string>()
  await Promise.all(
    [...internalIds].map(async (id) => {
      const url = await publicPathForPage(
        ctx,
        id,
        locale,
        defaultLocale,
        homePageId
      )
      if (url) urlByPageId.set(id, url)
    })
  )
  const urlByStorageId = new Map<Id<"_storage">, string>()
  await Promise.all(
    [...storageIds].map(async (id) => {
      const url = await ctx.storage.getUrl(id)
      if (url) urlByStorageId.set(id, url)
    })
  )

  const target = (value: Target) => {
    if (value.type === "internal") {
      return { type: "internal" as const, url: urlByPageId.get(value.pageId) }
    }
    if (value.type === "external") {
      return {
        type: "external" as const,
        url: value.url,
        ...(value.openInNewTab !== undefined
          ? { openInNewTab: value.openInNewTab }
          : {}),
      }
    }
    if (value.type === "placeholder")
      return { type: "placeholder" as const, url: "#" as const }
    return {
      type: "anchor" as const,
      url: value.anchor.startsWith("#") ? value.anchor : `#${value.anchor}`,
    }
  }
  const blocks = (values: LocaleBlock[]): ResolvedBlock[] =>
    values.map((block) => {
      if (block.kind === "linkGroup") {
        return {
          ...block,
          links: block.links.map((link) => ({
            ...link,
            target: target(link.target),
          })),
        }
      }
      if (block.kind === "dynamicList") {
        return {
          ...block,
          seeAll: block.seeAll
            ? { label: block.seeAll.label, target: target(block.seeAll.target) }
            : undefined,
        }
      }
      return {
        ...block,
        image: block.image
          ? {
              url:
                block.image.url ??
                (block.image.storageId
                  ? urlByStorageId.get(block.image.storageId)
                  : undefined),
              alt: block.image.alt,
            }
          : undefined,
        target: block.target ? target(block.target) : undefined,
        link: block.link
          ? { label: block.link.label, target: target(block.link.target) }
          : undefined,
      }
    })

  return localized.map((item) => ({
    ...item,
    target: item.target ? target(item.target) : undefined,
    panel: item.panel ? mapPanelBlocks(item.panel, blocks) : undefined,
  }))
}

export const getWithResolvedLinks = query({
  args: {
    slug: v.string(),
    locale: v.string(),
    languageVersion: v.number(),
  },
  returns: v.union(
    v.object({
      slug: v.string(),
      nav: v.array(canonicalResolvedNavItemValidator),
    }),
    v.null()
  ),
  handler: async (ctx, { slug, locale, languageVersion }) => {
    const state = await assertPublicLanguageVersion(ctx, languageVersion)
    if ((await readPublicationAuthority(ctx)) === "invalid") return null
    const menu = await getMenuBySlug(ctx, slug)
    if (!menu || menu.deletedAt !== undefined) return null
    const language = publicLocaleEligibility(state)
    return {
      slug,
      nav: await resolveCanonicalNav(ctx, menu.nav, locale, {
        ...language,
        // Preserve the legacy "en" fallback before language configuration.
        defaultLocale: language.defaultLocale ?? "en",
      }),
    }
  },
})
