import { ConvexError } from "convex/values"
import type { Doc, Id } from "../../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../../_generated/server"
import { readAuthorityRows, recordSourcePublicChange } from "./state"

/**
 * M05 freshness domains A and B (contract Freshness domains) and the
 * Language-domain recording seam. Domain C is the authority version plus the
 * module configuration version and has no row here.
 */

export type FreshnessDomain = "route_claims" | "publication_set"

/** A scope with no locale is the site row. */
export type FreshnessScope = Readonly<{
  locale?: string
  domains: readonly FreshnessDomain[]
}>

export type FreshnessCounters = {
  routeClaimVersion: number
  publicationSetVersion: number
}

export type FreshnessTokens = {
  site: FreshnessCounters
  locale: FreshnessCounters
}

export const BOTH_FRESHNESS_DOMAINS: readonly FreshnessDomain[] = [
  "route_claims",
  "publication_set",
]

type FreshnessRow = Doc<"siteLanguageFreshness">

async function readFreshnessRow(
  ctx: QueryCtx | MutationCtx,
  locale: string | undefined
): Promise<FreshnessRow | null> {
  const rows = await ctx.db
    .query("siteLanguageFreshness")
    .withIndex("by_scope_and_locale", (q) =>
      locale === undefined
        ? q.eq("scope", "site").eq("locale", undefined)
        : q.eq("scope", "locale").eq("locale", locale)
    )
    .take(2)
  if (rows.length > 1) throw new ConvexError("SITE_LANGUAGE_FRESHNESS_INVALID")
  return rows[0] ?? null
}

function countersOf(row: FreshnessRow | null): FreshnessCounters {
  return {
    routeClaimVersion: row?.routeClaimVersion ?? 0,
    publicationSetVersion: row?.publicationSetVersion ?? 0,
  }
}

/** Site and locale counters for a capture or a comparison (two point reads). */
export async function readFreshnessTokens(
  ctx: QueryCtx | MutationCtx,
  locale: string
): Promise<FreshnessTokens> {
  const [site, localeRow] = await Promise.all([
    readFreshnessRow(ctx, undefined),
    readFreshnessRow(ctx, locale),
  ])
  return { site: countersOf(site), locale: countersOf(localeRow) }
}

/** One locale-scoped counter row for a second preview freshness domain. */
export async function readLocaleFreshnessCounters(
  ctx: QueryCtx | MutationCtx,
  locale: string
): Promise<FreshnessCounters> {
  return countersOf(await readFreshnessRow(ctx, locale))
}

/**
 * Site, source and target counters for a default migration (three point
 * reads; contract `siteDefaultLanguageMigrations.captured`).
 */
export async function readMigrationFreshnessTokens(
  ctx: QueryCtx | MutationCtx,
  fromLocale: string,
  toLocale: string
): Promise<{
  site: FreshnessCounters
  from: FreshnessCounters
  to: FreshnessCounters
}> {
  const [site, from, to] = await Promise.all([
    readFreshnessRow(ctx, undefined),
    readFreshnessRow(ctx, fromLocale),
    readFreshnessRow(ctx, toLocale),
  ])
  return { site: countersOf(site), from: countersOf(from), to: countersOf(to) }
}

export function freshnessTokensEqual(
  left: FreshnessTokens,
  right: FreshnessTokens
): boolean {
  return (
    left.site.routeClaimVersion === right.site.routeClaimVersion &&
    left.site.publicationSetVersion === right.site.publicationSetVersion &&
    left.locale.routeClaimVersion === right.locale.routeClaimVersion &&
    left.locale.publicationSetVersion === right.locale.publicationSetVersion
  )
}

/**
 * The one recording seam (contract Domain C "Recording seam"). It reads the
 * authority rows once and:
 * - unless `source` is false, preserves F09 invariant 6 exactly through
 *   `recordSourcePublicChange` over the same rows;
 * - under a stored multilingual authority, advances each named counter once
 *   per distinct scope in the caller's transaction.
 *
 * Under no row, a `single` row or v0 it adds no read beyond F09's and no
 * write, so module-off read and write sets are unchanged (P1). A stored
 * multilingual row whose module is disabled still advances counters: they are
 * monotonic and only ever stale a preview (ledger C2b.1).
 */
export async function recordPublicChange(
  ctx: MutationCtx,
  change: Readonly<{
    pageId?: Id<"pages">
    /** False only for writers F09 never recorded (`redirects`). */
    source?: boolean
    scopes: readonly FreshnessScope[]
  }>
): Promise<Doc<"siteLanguageAuthority">[]> {
  const authorityRows = await readAuthorityRows(ctx)
  if (change.source !== false) {
    await recordSourcePublicChange(ctx, change.pageId, authorityRows)
  } else if (authorityRows.length > 1) {
    throw new ConvexError("SITE_LANGUAGE_AUTHORITY_INVALID")
  }
  if (authorityRows.length !== 1 || authorityRows[0]!.mode !== "multilingual")
    return authorityRows

  const merged = new Map<string, Set<FreshnessDomain>>()
  for (const scope of change.scopes) {
    if (scope.domains.length === 0) continue
    const key = scope.locale === undefined ? "" : `locale:${scope.locale}`
    const domains = merged.get(key) ?? new Set<FreshnessDomain>()
    for (const domain of scope.domains) domains.add(domain)
    merged.set(key, domains)
  }
  const now = Date.now()
  for (const [key, domains] of merged) {
    const locale = key === "" ? undefined : key.slice("locale:".length)
    const row = await readFreshnessRow(ctx, locale)
    const counters = countersOf(row)
    const next = {
      routeClaimVersion:
        counters.routeClaimVersion + (domains.has("route_claims") ? 1 : 0),
      publicationSetVersion:
        counters.publicationSetVersion +
        (domains.has("publication_set") ? 1 : 0),
      updatedAt: now,
    }
    if (row) {
      await ctx.db.patch(row._id, next)
    } else {
      await ctx.db.insert("siteLanguageFreshness", {
        scope: locale === undefined ? "site" : "locale",
        ...(locale === undefined ? {} : { locale }),
        ...next,
      })
    }
  }
  return authorityRows
}
