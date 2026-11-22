import { fetchQuery } from "convex/nextjs"
import { api } from "@/convex/_generated/api"
import { cachedCmsRead, CMS_TAGS } from "@/lib/cms/cache"
import {
  collectDynamicListSources,
  dynamicListSourceKey,
  type MenuCardsBySource,
} from "@/convex/lib/menu"
import type { PublicSiteShellProps } from "@/components/public/public-site-shell"

/** The public layout and private editor frame share one resolved shell. */
export async function loadPublicSiteShell(
  locale: string,
  config: {
    defaultLocale: string
    enabledLocales: string[]
    languageVersion: number
  }
): Promise<Omit<PublicSiteShellProps, "children">> {
  const [mainMenu, branding, footerMenu, chrome] = await Promise.all([
    cachedCmsRead(
      () =>
        fetchQuery(api.cms.menus.getWithResolvedLinks, {
          slug: "primary",
          locale,
          languageVersion: config.languageVersion,
        }),
      ["cms-menu", "primary", locale, String(config.languageVersion)],
      null,
      [CMS_TAGS.menus]
    ),
    cachedCmsRead(
      () => fetchQuery(api.cms.settings.getBrandingUrls, {}),
      ["cms-branding"],
      null,
      [CMS_TAGS.settings]
    ),
    cachedCmsRead(
      () =>
        fetchQuery(api.cms.menus.getWithResolvedLinks, {
          slug: "footer",
          locale,
          languageVersion: config.languageVersion,
        }),
      ["cms-menu", "footer", locale, String(config.languageVersion)],
      null,
      [CMS_TAGS.menus]
    ),
    cachedCmsRead(
      () => fetchQuery(api.cms.settings.getPublicChrome, {}),
      ["cms-chrome"],
      null,
      [CMS_TAGS.settings]
    ),
  ])

  const dynamicSources = collectDynamicListSources(
    mainMenu?.nav ?? [],
    footerMenu?.nav ?? []
  )
  const dynamicEntries = await Promise.all(
    dynamicSources.map(async (source) => {
      const cards = await cachedCmsRead(
        () =>
          fetchQuery(api.cms.pages.listRecentPublicRelationCards, {
            pageType: source.pageType,
            limit: source.limit,
            locale,
            languageVersion: config.languageVersion,
          }),
        [
          "cms-recent",
          source.pageType,
          String(source.limit),
          locale,
          String(config.languageVersion),
        ],
        [],
        [CMS_TAGS.pages]
      )
      return [dynamicListSourceKey(source), cards] as const
    })
  )
  const cardsBySource = Object.fromEntries(dynamicEntries) as MenuCardsBySource

  const enabledLocales = config.enabledLocales
  const defaultLocale = config.defaultLocale

  return {
    header: {
      logoUrl: branding?.logo ?? null,
      siteName: chrome?.siteName,
      mainMenuItems: mainMenu?.nav ?? [],
      locale,
      defaultLocale,
      enabledLocales,
      languageVersion: config.languageVersion,
      cardsBySource,
    },
    footer: {
      footerMenu,
      chrome,
      logoUrl: branding?.logo ?? null,
      locale,
      defaultLocale,
      cardsBySource,
    },
  }
}
