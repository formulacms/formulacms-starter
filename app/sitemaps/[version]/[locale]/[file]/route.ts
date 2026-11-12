import { fetchQuery } from "convex/nextjs"
import { api } from "@/convex/_generated/api"
import {
  answerSitemap,
  sitemapBaseUrl,
  sitemapNotFound,
  sitemapUnavailable,
  sitemapUrlsetXml,
  withPinnedSitemapConfig,
  xmlResponse,
} from "@/lib/seo/sitemap"

// M05 C5a sitemap child: `/sitemaps/<manifestVersion>/<locale>/<ordinal>.xml`
// (contract "Child handler"). It pins the language version like the index,
// answers an unknown locale, manifest or partition with a no-store 404 so the
// crawler refetches the index, and an overflow or oversized partition with a
// no-store 503. It lists SEO alternates only.
export const dynamic = "force-dynamic"

const WHOLE_NUMBER = /^(0|[1-9]\d{0,8})$/

export async function GET(
  _request: Request,
  {
    params,
  }: { params: Promise<{ version: string; locale: string; file: string }> }
): Promise<Response> {
  const { version, locale, file } = await params
  const ordinalText = file.endsWith(".xml") ? file.slice(0, -".xml".length) : ""
  if (!WHOLE_NUMBER.test(version) || !WHOLE_NUMBER.test(ordinalText)) {
    return sitemapNotFound()
  }
  const manifestVersion = Number(version)
  const ordinal = Number(ordinalText)
  return answerSitemap(async () => {
    const { result, baseUrl, defaultLocale } = await withPinnedSitemapConfig(
      async (config) => ({
        result: await fetchQuery(api.cms.pages.getSitemapChild, {
          languageVersion: config.languageVersion,
          manifestVersion,
          locale,
          ordinal,
        }),
        baseUrl: sitemapBaseUrl(config),
        defaultLocale: config.defaultLocale,
      })
    )
    if (result.status === "not_found") return sitemapNotFound()
    if (result.status === "unavailable") return sitemapUnavailable()
    return xmlResponse(sitemapUrlsetXml(baseUrl, defaultLocale, result.entries))
  })
}
