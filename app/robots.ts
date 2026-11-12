import { MetadataRoute } from "next"
import { fetchQuery } from "convex/nextjs"
import { api } from "@/convex/_generated/api"
import { cachedCmsRead, CMS_TAGS } from "@/lib/cms/cache"
import { resolveSiteUrl } from "@/lib/seo/site-url"

export const dynamic = "force-dynamic"

export default async function robots(): Promise<MetadataRoute.Robots> {
  const config = await cachedCmsRead(
    () => fetchQuery(api.cms.settings.getSiteConfig, {}),
    ["cms-robots-config"],
    null,
    [CMS_TAGS.settings]
  )
  const baseUrl = resolveSiteUrl(config?.siteUrl ?? "")
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin/", "/api/", "/sign-in"],
    },
    sitemap: `${baseUrl}/sitemap.xml`,
  }
}
