import { draftMode } from "next/headers"
import { fetchQuery } from "convex/nextjs"
import { api } from "@/convex/_generated/api"
import { PublicSiteShell } from "@/components/public/public-site-shell"
import { loadPublicSiteShell } from "@/lib/slices/public-site-shell.server"
import { Providers } from "@/components/providers"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "sonner"
import { fontClassName } from "@/lib/fonts"
import { cachedCmsRead, requiredCmsRead, CMS_TAGS } from "@/lib/cms/cache"
import {
  readFreshConfig,
  withVersionPinnedConfig,
} from "@/lib/cms/versioned-read"
import { HydrationExtensionAttributeCleanup } from "@/components/hydration-extension-attribute-cleanup"
import { PresentationLocaleProvider } from "@/components/public/presentation-locale"
import { resolvePresentationLocale } from "@/lib/i18n/presentation-locale"
import { getLocaleDirection } from "@/lib/i18n/config"
import "../../globals.css"

// Root layout for the public, localized site. Owns the document shell so the
// `<html lang>` tracks the active locale (the non-localized admin/auth area has
// its own root layout in `(core)`). The header's nav + locale switcher are
// rebuilt on the ISR floor below (matches the page renderer).
export const revalidate = 300

const CONFIG_FALLBACK = {
  onboardingCompletedAt: null as number | null,
  defaultLocale: "en",
  enabledLocales: ["en"],
  homePageId: null,
  siteUrl: "",
  timezone: "UTC",
  languageVersion: 0,
}

export default async function PublicLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ locale: string }>
}) {
  const { locale: requestedLocale } = await params
  const isPreview = (await draftMode()).isEnabled
  const readConfig = () => fetchQuery(api.cms.settings.getSiteConfig, {})

  return withVersionPinnedConfig({
    // A public shell must use real locale authority too; preview retains its
    // existing graceful config policy alongside the route's private reads.
    loadConfig: () =>
      isPreview
        ? cachedCmsRead(readConfig, ["cms-config"], CONFIG_FALLBACK, [
            CMS_TAGS.settings,
          ])
        : requiredCmsRead(readConfig, ["cms-config"], [CMS_TAGS.settings]),
    loadFreshConfig: (staleVersion) =>
      readFreshConfig(
        () => fetchQuery(api.cms.settings.getSiteConfig, {}),
        staleVersion
      ),
    refreshWhen: (config) => !config.enabledLocales.includes(requestedLocale),
    run: async (config) => {
      // M05 M20: one presentation language for the whole document. A disabled
      // language segment (for example `/fr/x` while French is off) 404s in
      // the default language chosen in Admin → Languages.
      const locale = resolvePresentationLocale(
        requestedLocale,
        config.enabledLocales,
        config.defaultLocale
      )
      const direction = getLocaleDirection(locale)
      // Degrade gracefully if Convex is briefly unreachable — render the shell
      // without nav rather than 500-ing. All language-sensitive reads below
      // share the exact configuration version used for this render attempt.
      const shell = await loadPublicSiteShell(locale, config)

      return (
        <html
          lang={locale}
          dir={direction}
          suppressHydrationWarning
          className={fontClassName}
        >
          <body suppressHydrationWarning>
            <HydrationExtensionAttributeCleanup />
            <Providers>
              <PresentationLocaleProvider
                value={{ locale, defaultLocale: config.defaultLocale }}
              >
                <ThemeProvider>
                  <PublicSiteShell {...shell}>{children}</PublicSiteShell>
                </ThemeProvider>
              </PresentationLocaleProvider>
              <Toaster richColors closeButton duration={5000} />
            </Providers>
          </body>
        </html>
      )
    },
  })
}
