import { unstable_cache } from "next/cache"
import { ConvexError } from "convex/values"
import type { CmsTag } from "./tags"

export { CMS_TAGS, ALL_CMS_TAGS } from "./tags"

// Convex's `fetchQuery` (convex/nextjs) is hardcoded to `cache: "no-store"`.
// On an ISR/SSG route that forces a request-time "static → dynamic" error in
// production (`next start`), 500-ing public pages. Wrapping published reads in
// `unstable_cache` gives Next a cacheable Data Cache boundary, so the public
// site can prerender and revalidate normally.
//
// Each read is tagged with the CMS content type(s) it depends on (see
// lib/cms/tags.ts) so an edit purges only the reads it can actually affect —
// purged via `revalidateTag` (see app/api/revalidate/route.ts), complementing
// the time-based `revalidate` floor.

const CMS_CACHE_REVALIDATE_SECONDS = 300

// Next 16 Turbopack has a known `performance.measure` bug that fires *inside*
// `unstable_cache` and gets swallowed by callers' try/catch as a silent 404.
// In dev we skip the cache entirely (correctness > caching) — the prod-only
// static/dynamic problem this guards against never occurs under `next dev`.
const isDev = process.env.NODE_ENV === "development"

export const SITE_LANGUAGE_VERSION_CHANGED =
  "SITE_LANGUAGE_VERSION_CHANGED" as const

/** Convex errors can cross the Next server boundary as data or rendered text. */
export function isSiteLanguageVersionChanged(error: unknown): boolean {
  if (
    error instanceof ConvexError &&
    error.data === SITE_LANGUAGE_VERSION_CHANGED
  ) {
    return true
  }
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .split(/\r?\n/)
    .some(
      (line) =>
        line.trim() ===
          `Uncaught ConvexError: ${SITE_LANGUAGE_VERSION_CHANGED}` ||
        line.trim() === SITE_LANGUAGE_VERSION_CHANGED
    )
}

export function withCmsCache<T>(
  fn: () => Promise<T>,
  key: string[],
  tags: readonly CmsTag[]
): Promise<T> {
  if (isDev) return fn()
  return unstable_cache(fn, key, {
    revalidate: CMS_CACHE_REVALIDATE_SECONDS,
    tags: [...tags],
  })()
}

// Required public reads distinguish confirmed absence (for example null) from
// an outage. Only fulfilled results enter the Data Cache; failures propagate
// unchanged to the route's error boundary, never to its not-found decision.
export function requiredCmsRead<T>(
  fn: () => Promise<T>,
  key: string[],
  tags: readonly CmsTag[]
): Promise<T> {
  return withCmsCache(fn, key, tags)
}

// Cache successes (and legitimate "not found" results); on a transient Convex
// error, return `fallback` WITHOUT caching it, so a blip can't poison the
// cache for the whole revalidate window. Mirrors the graceful-degradation the
// public reads already relied on, but cache-safe.
export async function cachedCmsRead<T>(
  fn: () => Promise<T>,
  key: string[],
  fallback: T,
  tags: readonly CmsTag[]
): Promise<T> {
  try {
    return await withCmsCache(fn, key, tags)
  } catch (error) {
    // A version mismatch is a coordination signal, not backend unavailability.
    // Returning or caching a fallback here could combine two language releases.
    if (isSiteLanguageVersionChanged(error)) throw error
    const keyLabel = key.join(":")
    if (isDev) {
      if (keyLabel === "cms-config") {
        console.warn(
          `CMS read failed in development (using fallback): ${keyLabel}`
        )
        return fallback
      }
      throw new Error(`CMS read failed in development: ${keyLabel}`)
    }
    return fallback
  }
}
