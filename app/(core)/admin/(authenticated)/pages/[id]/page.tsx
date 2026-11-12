import { notFound, redirect } from "next/navigation"
import { fetchQuery } from "convex/nextjs"
import { api } from "@/convex/_generated/api"
import { fetchAuthQuery } from "@/lib/auth-server"
import { PageEditor } from "@/components/admin/page-editor"
import { resolveRequestedEditorLocale } from "@/components/admin/page-editor/lib/requested-locale"
import { ADMIN_AI_TRANSLATION_SERVER_BINDING } from "@/components/admin/contributions/ai-translation.server"
import { ADMIN_AI_WRITING_SERVER_BINDING } from "@/components/admin/contributions/ai-writing.server"
import { ADMIN_AUTHORING_TOOLS_SERVER_BINDING } from "@/components/admin/contributions/authoring-tools.server"
import type { Id } from "@/convex/_generated/dataModel"

export const dynamic = "force-dynamic"

export default async function PageEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams?: Promise<{
    verify?: string | string[]
    language?: string | string[]
    locale?: string | string[]
  }>
}) {
  const { id } = await params
  const query = await searchParams
  const verificationScenario =
    ADMIN_AUTHORING_TOOLS_SERVER_BINDING?.resolveVerificationScenario(
      query?.verify
    ) ?? null
  // ADR-0041 §Migration step 2 (item 1): the editor reads the page as
  // it would look post-publish (live overlaid with staging). The public
  // path continues to use `getById` / `getPublishedById` — staging is
  // admin-only.
  const [view, siteConfig] = await Promise.all([
    fetchAuthQuery(api.cms.pages.getForEdit, { id: id as Id<"pages"> }),
    fetchQuery(api.cms.settings.getSiteConfig, {}),
  ])

  if (!view) notFound()

  // F09b: `?language=new` opens the owner's new-language version of this page
  // during a content replacement. The language comes from the open change on
  // the server, never from the address.
  const notice = view.publication
    ? await fetchAuthQuery(api.cms.language.getSourcePublicationNotice, {
        pageId: id as Id<"pages">,
      })
    : null
  const writingTarget = query?.language === "new"
  if (writingTarget) {
    // A change being cancelled no longer accepts new-language drafts.
    const language = notice
      ? await fetchAuthQuery(api.cms.language.getLanguageState, {})
      : null
    if (!language?.transition || language.transition.phase === "cancelling") {
      redirect(`/admin/pages/${id}`)
    }
  }

  const [aiWritingRouteData, aiTranslationRouteData] = await Promise.all([
    ADMIN_AI_WRITING_SERVER_BINDING?.loadRouteData(),
    ADMIN_AI_TRANSLATION_SERVER_BINDING?.loadRouteData(),
  ])

  return (
    <PageEditor
      key={view.page._id}
      page={view.page}
      requestedLocale={resolveRequestedEditorLocale(
        query?.locale,
        siteConfig.enabledLocales
      )}
      routeDefaultLocale={siteConfig.defaultLocale}
      routeEnabledLocales={siteConfig.enabledLocales}
      {...(siteConfig.homePageId ? { routeHomePageId: siteConfig.homePageId } : {})}
      hasStaging={view.hasStaging}
      stagingUpdatedAt={
        "stagingUpdatedAt" in view ? view.stagingUpdatedAt : undefined
      }
      publication={view.publication}
      {...(aiWritingRouteData === undefined ? {} : { aiWritingRouteData })}
      {...(aiTranslationRouteData === undefined
        ? {}
        : { aiTranslationRouteData })}
      archiveStateVerificationFailure={
        verificationScenario === "archive-read-failure"
      }
      {...(notice
        ? writingTarget
          ? { targetDraftLocale: notice.targetLocale }
          : { replacementTargetLocale: notice.targetLocale }
        : {})}
    />
  )
}
