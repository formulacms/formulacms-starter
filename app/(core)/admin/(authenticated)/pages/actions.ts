"use server"

import { revalidatePath, revalidateTag } from "next/cache"
import { fetchQuery } from "convex/nextjs"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { requireAuth } from "@/lib/auth-server"
import { CMS_TAGS } from "@/lib/cms/tags"
import { requireOperationAccess } from "@/lib/operation-server"

/**
 * Purge ISR caches for a page immediately after a status change (publish,
 * unpublish, archive).
 *
 * Two-layer purge:
 * 1. Data Cache (`revalidateTag`) — clears `unstable_cache` entries tagged
 *    with cms:pages. This resolves the "cached miss" where the path-resolution
 *    query still returns null after publication (the cache stored null when the
 *    page was a draft and hasn't expired yet).
 * 2. Full Route Cache (`revalidatePath`) — clears the pre-rendered HTML
 *    response. Called with the *internal* Next.js path (after middleware rewrite)
 *    because `/<slug>` is rewritten to `/<locale>/<slug>` and ISR keys the
 *    rewritten URL.
 *
 * The Convex `revalidatePage` action does the same thing via an HTTP POST to
 * `/api/revalidate`, but requires REVALIDATE_SECRET + SITE_URL — both absent
 * in local dev. This server action runs in the Next.js process and needs no
 * environment variables, so it works in all environments.
 */
export async function revalidatePagePaths(pageId: Id<"pages">) {
  await requireAuth("Sign in to publish.")
  await requireOperationAccess("You do not have access to publish pages.")

  const config = await fetchQuery(api.cms.settings.getSiteConfig, {})
  const alternates = await fetchQuery(api.cms.pages.getPublicLocaleAlternates, {
    pageId,
    languageVersion: config.languageVersion,
  })

  // Clear all pages Data Cache entries. The stale null for the new page's
  // path-resolution key can't be targeted by a page-scoped tag (the entry
  // didn't exist before publication), so we purge the entire pages tag.
  revalidateTag(CMS_TAGS.pages, { expire: 0 })
  revalidateTag(CMS_TAGS.menus, { expire: 0 })

  if (alternates.length > 0) {
    for (const { locale, url } of alternates) {
      // localizedUrlsForPage omits the locale prefix for the default locale
      // (the public-facing URL). The internal Next.js route always carries
      // the locale segment (the route file is [locale]/[[...path]]). We must
      // call revalidatePath on the internal path to clear the Full Route Cache.
      const internalPath = url.startsWith(`/${locale}`)
        ? url
        : `/${locale}${url === "/" ? "" : url}`
      revalidatePath(internalPath)
    }
  } else {
    // Page has no published content — clear the locale root so navigation
    // updates are still visible.
    revalidatePath(`/${config.defaultLocale}`, "layout")
  }
}
