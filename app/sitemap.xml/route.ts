import { fetchQuery } from "convex/nextjs"
import { api } from "@/convex/_generated/api"
import {
  answerSitemap,
  sitemapBaseUrl,
  sitemapChildPath,
  sitemapIndexXml,
  withPinnedSitemapConfig,
  xmlResponse,
} from "@/lib/seo/sitemap"

// An explicit route handler rather than the `app/sitemap.ts` metadata
// convention: Next wraps that convention in a handler that maps any thrown
// error to HTTP 500, so a repeated language-version mismatch could never
// reach the wire as the F09 contract's no-store 503 with `Retry-After`. The
// proxy matcher skips dotted paths, so it cannot answer for this URL either.
//
// M05 C5a: this is the sitemap index. It lists the children of the ready
// manifest built for the pinned language version, or one version-0 child per
// enabled locale until that manifest exists (contract "Index handler").
export const dynamic = "force-dynamic"

export async function GET(): Promise<Response> {
  return answerSitemap(async () => {
    const locations = await withPinnedSitemapConfig(async (config) => {
      const index = await fetchQuery(api.cms.pages.getSitemapIndex, {
        languageVersion: config.languageVersion,
      })
      const baseUrl = sitemapBaseUrl(config)
      return index.locales.flatMap(({ locale, partitions }) =>
        Array.from(
          { length: partitions },
          (_, ordinal) =>
            `${baseUrl}${sitemapChildPath(index.manifestVersion, locale, ordinal)}`
        )
      )
    })
    return xmlResponse(sitemapIndexXml(locations))
  })
}
