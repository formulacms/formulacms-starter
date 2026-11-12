import { fetchQuery } from "convex/nextjs"
import { notFound } from "next/navigation"
import { getLocale, getMessages } from "next-intl/server"
import { NextIntlClientProvider } from "next-intl"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { fetchAuthQuery } from "@/lib/auth-server"
import { loadPublicSiteShell } from "@/lib/slices/public-site-shell.server"
import { withVersionPinnedConfig } from "@/lib/cms/versioned-read"
import { isLivePreviewPage } from "@/components/admin/live-preview-page-type"
import { LivePreviewFrameRuntime } from "@/components/admin/live-preview-frame-runtime"
import { readSlicePresentationCatalog } from "@/convex/lib/slices/presentations"

export const dynamic = "force-dynamic"

/** Private frame bootstrap; draft values arrive only from its bound editor. */
export default async function LiveFramePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; locale: string }>
  searchParams: Promise<{ session?: string }>
}) {
  const [{ id, locale }, { session }, adminLocale, messages] =
    await Promise.all([params, searchParams, getLocale(), getMessages()])
  if (!session || !/^[a-zA-Z0-9-]{16,80}$/.test(session)) notFound()
  const view = await fetchAuthQuery(api.cms.pages.getForEdit, {
    id: id as Id<"pages">,
  })
  if (!view || !isLivePreviewPage(view.page)) notFound()
  const page = view.page
  return withVersionPinnedConfig({
    loadConfig: () => fetchAuthQuery(api.cms.settings.getSiteConfig, {}),
    loadFreshConfig: () => fetchAuthQuery(api.cms.settings.getSiteConfig, {}),
    run: async (config) => {
      if (!config.enabledLocales.includes(locale)) notFound()
      // This read stays anonymous: a private draft path is not a public Page path.
      const [shell, publicPaths] = await Promise.all([
        loadPublicSiteShell(locale, config),
        fetchQuery(api.cms.pages.getLocalizedPathsByIds, {
          ids: [id as Id<"pages">],
          locale,
          languageVersion: config.languageVersion,
        }),
      ])
      return (
        <NextIntlClientProvider locale={adminLocale} messages={messages}>
          <LivePreviewFrameRuntime
            identity={{ pageId: id, locale, sessionId: session }}
            page={page}
            config={config}
            shell={shell}
            publicPath={publicPaths[id] ?? null}
            presentationCatalog={await readSlicePresentationCatalog()}
          />
        </NextIntlClientProvider>
      )
    },
  })
}
