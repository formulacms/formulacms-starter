/**
 * Routing seam for the content-type registry (plan 028 C3).
 *
 * Six places in the codebase mirror the "locale-relative body path" rule that
 * turns a `pages` document into a public URL: `localizedUrlsForPage` and
 * `getLocalizedPathsByIds` and `getLocalizedBreadcrumb` in `convex/cms/pages.ts`,
 * `urlForPageInLocale` in `convex/cms/redirects.ts`, `publicPathForPage` in
 * `convex/cms/menus.ts`, and `canonicalPathForPage` in `lib/pages/url.ts`.
 * Convex can't share runtime helpers across module boundaries the way Next can,
 * so the historical solution has been to copy the rule into each module and
 * assert cross-module agreement in tests.
 *
 * This module is the one place all six can reach — Convex modules import
 * `convex/lib/*` freely, and Next.js can import them too — so the `pathPrefix`
 * logic lands here once and the six sites delegate.
 *
 * Scope is deliberately narrow: this module owns *just* "prepend a path prefix
 * from the descriptor + skip ancestry for non-empty-prefix types," returning
 * the locale-relative body. Each call site keeps its own home detection, locale
 * prefix wrapping, and null-check plumbing — collapsing that shared surface
 * across the six mirrors is a separate refactor.
 *
 * Contract (also asserted by tests):
 *
 *   - Non-routable content type (`descriptor.routing` absent) → the URL builder
 *     returns null and callers skip URL emission (sitemap, revalidate, menu
 *     link resolution). Plan 028 §C1/C2 decision #4: non-routable types have
 *     no public entry.
 *   - Non-empty `pathPrefix` → flat `/<prefix>/<slug>`, ignoring `ancestry`.
 *     Plan 028 §C1/C2 decision #6: a non-empty prefix acts as a virtual root,
 *     so this type opts OUT of `parentId` hierarchy.
 *   - Empty `pathPrefix` → `/<ancestry?>/<slug>`, honoring the parent chain
 *     (today's behavior for `page` / `landing-page` / `post`).
 *
 * The functions accept an optional `defs` parameter so tests can pass a
 * synthetic registry (a real non-empty prefix + a real non-routable type) to
 * exercise the two branches that don't fire against the three shipped
 * descriptors. Production callers omit the parameter and bind the registry.
 */

import { contentTypeDefs as defaultDefs, isActiveContentType } from "./index"
import type { ContentTypeDescriptor } from "./types"
import type { Id } from "../../_generated/dataModel"
import type { QueryCtx, MutationCtx } from "../../_generated/server"
import { ConvexError } from "convex/values"

type DefsMap = Record<string, ContentTypeDescriptor>

export type FuturePageAddressInput = {
  pageId?: Id<"pages">
  pageType: string
  locale: string
  slug: string
  parentId?: Id<"pages"> | null
  homePageId?: Id<"pages">
  parentPathOverride?: { pageId: Id<"pages">; path: string }
}

/** Draft routes follow the parent's selected path, never its pending draft. */
export async function futurePageAddress(
  ctx: QueryCtx | MutationCtx,
  input: FuturePageAddressInput
): Promise<string | null> {
  const prefix = pathPrefixForContentType(input.pageType)
  if (prefix === null) return null
  if (input.pageId && input.homePageId === input.pageId) return "/"
  if (prefix || !input.parentId) return buildLocaleRelativePath(input)
  if (input.parentId === input.pageId)
    throw new ConvexError("PAGE_ANCESTRY_CYCLE")
  if (input.parentPathOverride?.pageId === input.parentId)
    return buildLocaleRelativePath({
      ...input,
      ancestry: input.parentPathOverride.path,
    })
  const states = await ctx.db
    .query("pageLocalePublicationStates")
    .withIndex("by_pageId_and_locale", (q) =>
      q.eq("pageId", input.parentId!).eq("locale", input.locale)
    )
    .take(2)
  const lifecycle = await ctx.db
    .query("pagePublicationPageStates")
    .withIndex("by_pageId", (q) => q.eq("pageId", input.parentId!))
    .take(2)
  if (states.length > 1 || lifecycle.length > 1)
    throw new ConvexError("PAGE_ADDRESS_STATE_INVALID")
  const parent = states[0]
  // An unpublished parent does not promise a future public address.
  if (
    lifecycle[0]?.lifecycleState !== "active" ||
    !parent?.hasCurrentSnapshot ||
    !parent.currentSnapshotId ||
    !parent.currentPath
  )
    return null
  return buildLocaleRelativePath({ ...input, ancestry: parent.currentPath })
}

// Synthetic descriptor maps are part of this module's unit-test contract.
// Runtime selection only applies to the production registry; callers that
// deliberately supply a test registry still exercise its declared routes.
function isActiveForDefs(pageType: string, defs: DefsMap): boolean {
  return defs !== defaultDefs || isActiveContentType(pageType)
}

/** Descriptors that appear on the public web — sitemap + revalidate iterate this. */
export function routableContentTypes(
  defs: DefsMap = defaultDefs
): ContentTypeDescriptor[] {
  return Object.values(defs).filter(
    (d) => d.routing !== undefined && isActiveForDefs(d.type, defs)
  )
}

/** Slugs of the routable content types (a small helper for filter predicates). */
export function routableContentTypeSlugs(
  defs: DefsMap = defaultDefs
): string[] {
  return routableContentTypes(defs).map((d) => d.type)
}

/** True when the descriptor for `pageType` opts in to public routing. */
export function isRoutableContentType(
  pageType: string,
  defs: DefsMap = defaultDefs
): boolean {
  return (
    isActiveForDefs(pageType, defs) && defs[pageType]?.routing !== undefined
  )
}

/**
 * The URL segment mounted immediately under the locale for this content type,
 * or null when the type is non-routable. Empty string is legal ("mounted at
 * the locale root" — the shape all three shipped descriptors carry today).
 */
export function pathPrefixForContentType(
  pageType: string,
  defs: DefsMap = defaultDefs
): string | null {
  if (!isActiveForDefs(pageType, defs)) return null
  const routing = defs[pageType]?.routing
  return routing ? routing.pathPrefix : null
}

/**
 * Build the locale-relative body path for a page. No locale prefix — callers
 * apply that (they own home detection and the `""`/`"/<locale>"` rule).
 *
 * Returns null when the content type is non-routable so callers can skip URL
 * emission uniformly.
 */
export function buildLocaleRelativePath(
  args: {
    pageType: string
    slug: string
    ancestry?: string
  },
  defs: DefsMap = defaultDefs
): string | null {
  const prefix = pathPrefixForContentType(args.pageType, defs)
  if (prefix === null) return null
  if (prefix.length > 0) {
    // Non-empty prefix = virtual root; skip ancestry (plan 028 decision #6).
    return `/${prefix}/${args.slug}`
  }
  const anc = args.ancestry || ""
  return anc ? `${anc}/${args.slug}` : `/${args.slug}`
}

/**
 * Resolve which content-type descriptor owns a URL, based on its path segments
 * (locale prefix already stripped by the caller).
 *
 *   - Non-empty pathPrefix match → the unique routable descriptor + the leaf
 *     slug taken from the last remaining segment. Cross-prefix collisions are
 *     impossible: a non-empty prefix maps to at most one descriptor (checked
 *     by {@link assertNoDuplicatePathPrefixes} at module load).
 *   - No non-empty prefix match → null. The caller falls through to the
 *     root-mount slug lookup, where the type is decided by the doc's stored
 *     `pageType`, not by the URL. Multiple descriptors share the empty
 *     prefix today (page / landing-page / post all at `""`), so the URL alone
 *     cannot identify the type — that ambiguity is intentional, and the
 *     global slug-uniqueness invariant guarantees at most one matching doc.
 */
export function resolveContentTypeByPath(
  segments: string[],
  defs: DefsMap = defaultDefs
): {
  descriptor: ContentTypeDescriptor
  slug: string
  remainingSegments: string[]
} | null {
  if (segments.length === 0) return null
  const first = segments[0]
  for (const d of Object.values(defs)) {
    if (!isActiveForDefs(d.type, defs)) continue
    if (!d.routing) continue
    if (d.routing.pathPrefix.length === 0) continue
    if (d.routing.pathPrefix !== first) continue
    const remaining = segments.slice(1)
    // Flat mount per plan 028 §C1/C2 decision #6 — the URL shape is exactly
    // `/<prefix>/<slug>` (one trailing segment). `/authors` alone or
    // `/authors/foo/bar` must NOT resolve; otherwise a canonical-guard
    // redirect masks a malformed URL as a synonym for a real page.
    if (remaining.length !== 1) return null
    return {
      descriptor: d,
      slug: remaining[0],
      remainingSegments: remaining,
    }
  }
  return null
}

/**
 * SEO type mapping for a content type — the schema.org `@type` and Open Graph
 * `og:type` values the public renderer emits.
 *
 * Descriptor override: `descriptor.seo?.schemaOrgType` / `descriptor.seo?.ogType`.
 * Defaults: `WebPage` / `website`. Post opts in to `Article` / `article`.
 *
 * Kept as a helper so consumers (json-ld.tsx, generateMetadata) never do
 * `pageType === "post"` and future descriptors can declare their own type
 * (C5 will add author → `Person`/`profile` here, not by branching on strings).
 */
export type OgType = NonNullable<
  NonNullable<ContentTypeDescriptor["seo"]>["ogType"]
>

export function seoTypesForContentType(
  pageType: string,
  defs: DefsMap = defaultDefs
): { schemaOrgType: string; ogType: OgType } {
  const seo = defs[pageType]?.seo
  return {
    schemaOrgType: seo?.schemaOrgType ?? "WebPage",
    ogType: seo?.ogType ?? "website",
  }
}

/**
 * Slug fallback for titles the ASCII slug generators cannot read.
 *
 * Page addresses stay ASCII (no publication, routing, proxy or sitemap
 * contract carries Unicode). A title written only in Cyrillic, CJK, Hangul,
 * Devanagari, Arabic, … therefore generates an empty slug, which the first
 * save refuses. This returns a deterministic, non-empty address instead:
 * `page-<8 lowercase hex>` where the hex is a 32-bit FNV-1a hash of the
 * NFC-normalized, trimmed title (UTF-16 code units). The same title gives the
 * same address on the server (`generateSlug`) and in the editor (`slugify`);
 * two pages with one title then collide through the normal uniqueness path,
 * exactly like two ASCII pages with one title.
 *
 * Returns "" for a blank title. Readable non-Latin URLs are a recorded
 * release-1 limit.
 */
export function slugFallbackForTitle(title: string): string {
  const normalized = title.normalize("NFC").trim()
  if (!normalized) return ""
  let hash = 0x811c9dc5
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `page-${(hash >>> 0).toString(16).padStart(8, "0")}`
}

/**
 * Apply {@link slugFallbackForTitle} when a generator produced no address for
 * a non-blank title. A non-empty generated slug passes through untouched.
 */
export function withSlugFallback(title: string, generated: string): string {
  return generated || slugFallbackForTitle(title)
}

export function slugify(text: string): string {
  // NFD-decompose then drop combining marks so accented letters fold to their
  // ASCII base (`résultats` → `resultats`), rather than being stripped entirely
  // (`rsultats`) by the next character class — Friction G in the handoff.
  const generated = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  // Titles with no ASCII letters (Cyrillic, CJK, …) get a stable `page-<hash>`
  // address instead of an empty one; see `slugFallbackForTitle`.
  return withSlugFallback(text, generated)
}
