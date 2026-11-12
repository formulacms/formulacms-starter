import type { MetadataRoute } from "next"
import { fetchQuery } from "convex/nextjs"
import { resolveRouteData } from "next/dist/build/webpack/loaders/metadata/resolve-route-data"
import { api } from "@/convex/_generated/api"
import { cachedCmsRead, CMS_TAGS } from "@/lib/cms/cache"
import {
  PUBLIC_READ_RETRY_AFTER_SECONDS,
  PublicLanguageVersionUnavailableError,
  withVersionPinnedConfig,
} from "@/lib/cms/versioned-read"
import { resolveSiteUrl } from "@/lib/seo/site-url"

// M05 C5a sitemap route handlers (contract "Index handler", "Child
// handler"). Both pin the language version, retry once on a mismatch and
// answer a second one with a no-store 503. The partition reads skip the Data
// Cache: a manifest becoming ready purges no tag, so a cached index could keep
// listing version-0 children that already answer 404.

const CONFIG_FALLBACK = {
  onboardingCompletedAt: null as number | null,
  defaultLocale: "en",
  enabledLocales: ["en"],
  homePageId: null as string | null,
  siteUrl: "",
  timezone: "UTC",
  languageVersion: 0,
}

type SiteConfig = typeof CONFIG_FALLBACK

/** Runs `read` against one committed language version. */
export function withPinnedSitemapConfig<Result>(
  read: (config: SiteConfig) => Promise<Result>
): Promise<Result> {
  return withVersionPinnedConfig({
    loadConfig: () =>
      cachedCmsRead(
        () => fetchQuery(api.cms.settings.getSiteConfig, {}),
        ["cms-sitemap-config"],
        CONFIG_FALLBACK,
        [CMS_TAGS.settings]
      ),
    loadFreshConfig: () => fetchQuery(api.cms.settings.getSiteConfig, {}),
    run: read,
  })
}

const XML_HEADERS = {
  "Content-Type": "application/xml",
  "Cache-Control": "public, max-age=0, must-revalidate",
}

export function xmlResponse(body: string): Response {
  return new Response(body, { headers: XML_HEADERS })
}

/** 404 the crawler must not cache, so it refetches the index. */
export function sitemapNotFound(): Response {
  return new Response("Not found.", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  })
}

/** No-store 503 with `Retry-After`: a version change, overflow or budget. */
export function sitemapUnavailable(
  retryAfter = PUBLIC_READ_RETRY_AFTER_SECONDS
): Response {
  return new Response("The sitemap is being updated. Try again shortly.", {
    status: 503,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": String(retryAfter),
    },
  })
}

/** Maps a repeated language-version mismatch to its 503; rethrows the rest. */
export async function answerSitemap(
  respond: () => Promise<Response>
): Promise<Response> {
  try {
    return await respond()
  } catch (error) {
    if (!(error instanceof PublicLanguageVersionUnavailableError)) throw error
    return sitemapUnavailable(error.retryAfter)
  }
}

export function sitemapBaseUrl(config: SiteConfig): string {
  return resolveSiteUrl(config.siteUrl)
}

export function sitemapChildPath(
  manifestVersion: number,
  locale: string,
  ordinal: number
): string {
  return `/sitemaps/${manifestVersion}/${encodeURIComponent(locale)}/${ordinal}.xml`
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

export function sitemapIndexXml(locations: readonly string[]): string {
  const entries = locations
    .map(
      (location) => `<sitemap>\n<loc>${escapeXml(location)}</loc>\n</sitemap>`
    )
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>\n`
}

/**
 * A child's entries as a urlset, serialized like Next's generated sitemap.
 * `x-default` is the default language's URL, emitted only when the entry has
 * that (indexable) alternate, matching the page metadata.
 */
export function sitemapUrlsetXml(
  baseUrl: string,
  defaultLocale: string,
  entries: ReadonlyArray<{
    url: string
    lastModified: number
    priority: number
    alternates: ReadonlyArray<{ locale: string; url: string }>
  }>
): string {
  const sitemap: MetadataRoute.Sitemap = entries.map((entry) => ({
    url: `${baseUrl}${entry.url}`,
    lastModified: new Date(entry.lastModified),
    priority: entry.priority,
    ...(entry.alternates.length > 0
      ? {
          alternates: {
            languages: Object.fromEntries([
              ...entry.alternates.map(({ locale, url }) => [
                locale,
                `${baseUrl}${url}`,
              ]),
              ...entry.alternates
                .filter(({ locale }) => locale === defaultLocale)
                .map(({ url }) => ["x-default", `${baseUrl}${url}`]),
            ]),
          },
        }
      : {}),
  }))
  return resolveRouteData(sitemap, "sitemap")
}
