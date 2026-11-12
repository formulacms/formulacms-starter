import { notFound } from "next/navigation"
import { formatLocalDateTime } from "@/lib/i18n/local-date-format"
import { getFormatter, getTranslations } from "next-intl/server"
import { fetchQuery } from "convex/nextjs"
import { api } from "@/convex/_generated/api"
import { fetchAuthQuery } from "@/lib/auth-server"
import type { Id } from "@/convex/_generated/dataModel"
import type { Slice } from "@/convex/lib/slices"
import { getContentTypeRenderer } from "@/components/content-types"
import { buildSliceRenderContext } from "@/lib/slices/render-context"
import { hasSliceBody } from "@/convex/lib/pages/sliceBodyContent"
import { isRoutableContentType } from "@/convex/lib/contentTypes/routing"
import type { ContentType } from "@/convex/lib/contentTypes"

/**
 * ADR-0041 §5 — primary admin staged-preview affordance.
 *
 * Reuses the public renderer components with a staging-overlaid page as
 * the data source. Admin-only (gated by `cms.pages.getStagedPreviewById`
 * which requires the page's `update` permission). Never reads through the
 * public path, so the "public renderer never reads pageStaging" invariant
 * stays intact.
 *
 * Non-routable / non-slice-body types render a message rather than the
 * public renderer — those pages have no public web presence and their
 * preview surface is a Deploy-2 concern.
 */

export const dynamic = "force-dynamic"

type PreviewProps = {
  params: Promise<{ id: string }>
  searchParams: Promise<{ locale?: string }>
}

function collectImageStorageIds(
  value: unknown,
  ids: Set<Id<"_storage">>
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectImageStorageIds(item, ids)
    return
  }
  if (value === null || typeof value !== "object") return
  const record = value as Record<string, unknown>
  const storageId = record.storageId
  if (typeof storageId === "string" && storageId.length > 0) {
    ids.add(storageId as Id<"_storage">)
  }
  for (const child of Object.values(record)) {
    collectImageStorageIds(child, ids)
  }
}

function applyFreshImageUrls(
  value: unknown,
  urls: Record<string, string>
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => applyFreshImageUrls(item, urls))
  }
  if (value === null || typeof value !== "object") return value
  const record = value as Record<string, unknown>
  const next: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(record)) {
    next[key] = applyFreshImageUrls(child, urls)
  }
  if (typeof record.storageId === "string") {
    const fresh = urls[record.storageId]
    if (fresh) next.url = fresh
  }
  return next
}

export default async function AdminPreviewPage({
  params,
  searchParams,
}: PreviewProps) {
  const [{ id }, sp, config, t] = await Promise.all([
    params,
    searchParams,
    fetchQuery(api.cms.settings.getSiteConfig, {}),
    getTranslations("editor.preview"),
  ])

  const preview = await fetchAuthQuery(api.cms.pages.getStagedPreviewById, {
    id: id as Id<"pages">,
  })
  if (!preview) notFound()

  const { page, hasStaging, stagingUpdatedAt } = preview

  const requestedLocale =
    sp.locale && config.enabledLocales.includes(sp.locale)
      ? sp.locale
      : config.defaultLocale

  if (!isRoutableContentType(page.pageType)) {
    return (
      <PreviewShell
        title={pickAnyTitle(page, t("untitled"))}
        hasStaging={hasStaging}
        stagingUpdatedAt={stagingUpdatedAt}
        locale={requestedLocale}
      >
        <PreviewNotice>{t("notRoutable")}</PreviewNotice>
      </PreviewShell>
    )
  }

  if (!hasSliceBody(page)) {
    return (
      <PreviewShell
        title={pickAnyTitle(page, t("untitled"))}
        hasStaging={hasStaging}
        stagingUpdatedAt={stagingUpdatedAt}
        locale={requestedLocale}
      >
        <PreviewNotice>{t("formOnly")}</PreviewNotice>
      </PreviewShell>
    )
  }

  const localeContent = page.content?.[requestedLocale]
  const content = localeContent ?? page.content?.[config.defaultLocale]
  if (!content) {
    return (
      <PreviewShell
        title={pickAnyTitle(page, t("untitled"))}
        hasStaging={hasStaging}
        stagingUpdatedAt={stagingUpdatedAt}
        locale={requestedLocale}
      >
        <PreviewNotice>
          {t("noStagedContent", { locale: requestedLocale })}
        </PreviewNotice>
      </PreviewShell>
    )
  }
  const renderLocale = localeContent ? requestedLocale : config.defaultLocale

  // Resolve storageId → URL so image fields reflect fresh media. Same
  // shape as the public renderer's `refreshSliceImageUrls`.
  const rawSlices = content.slices ?? []
  const storageIds = new Set<Id<"_storage">>()
  collectImageStorageIds(rawSlices, storageIds)
  const freshUrls =
    storageIds.size > 0
      ? await fetchQuery(api.cms.media.getStorageUrls, {
          storageIds: [...storageIds],
        })
      : ({} as Record<string, string>)
  const slices = (
    Object.keys(freshUrls).length > 0
      ? applyFreshImageUrls(rawSlices, freshUrls)
      : rawSlices
  ) as Slice[]

  const ctx = await buildSliceRenderContext({
    slices,
    renderLocale,
    presentationLocale: requestedLocale,
    defaultLocale: config.defaultLocale,
    isPreview: true,
    languageVersion: config.languageVersion,
  })

  const renderer = getContentTypeRenderer(page.pageType as ContentType)
  if (renderer.kind !== "sliceBody") {
    return (
      <PreviewShell
        title={pickAnyTitle(page, t("untitled"))}
        hasStaging={hasStaging}
        stagingUpdatedAt={stagingUpdatedAt}
        locale={requestedLocale}
      >
        <PreviewNotice>{t("noRenderer")}</PreviewNotice>
      </PreviewShell>
    )
  }
  const RenderContentType = renderer.Component

  return (
    <PreviewShell
      title={content.title || pickAnyTitle(page, t("untitled"))}
      hasStaging={hasStaging}
      stagingUpdatedAt={stagingUpdatedAt}
      locale={requestedLocale}
    >
      {!localeContent && (
        <p className="px-6 py-2 text-sm text-muted-foreground">
          {t("fallbackContent", {
            requestedLocale,
            defaultLocale: config.defaultLocale,
          })}
        </p>
      )}
      <RenderContentType
        page={page}
        content={content}
        slices={slices}
        ctx={ctx}
        locale={requestedLocale}
        renderLocale={renderLocale}
        defaultLocale={config.defaultLocale}
        bylines={[]}
      />
    </PreviewShell>
  )
}

function pickAnyTitle(
  page: { content?: Record<string, { title?: string }> },
  untitled: string
): string {
  const first = Object.values(page.content ?? {})[0]
  return first?.title ?? untitled
}

async function PreviewShell({
  title,
  hasStaging,
  stagingUpdatedAt,
  locale,
  children,
}: {
  title: string
  hasStaging: boolean
  stagingUpdatedAt?: number
  locale: string
  children: React.ReactNode
}) {
  const [t, format] = await Promise.all([
    getTranslations("editor.preview"),
    getFormatter(),
  ])

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b border-border bg-card px-4 py-2 text-xs">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="font-semibold">{t("title")}</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">{title}</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">
              {t("locale", { locale })}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {hasStaging ? (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-900 dark:bg-amber-500/20 dark:text-amber-100">
                {t("unpublishedChanges")}
                {stagingUpdatedAt !== undefined
                  ? ` · ${t("edited", {
                      date: formatLocalDateTime(format, stagingUpdatedAt),
                    })}`
                  : ""}
              </span>
            ) : (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-900 dark:bg-emerald-500/20 dark:text-emerald-100">
                {t("showingLive")}
              </span>
            )}
          </div>
        </div>
      </header>
      <main>{children}</main>
    </div>
  )
}

function PreviewNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16 text-sm text-muted-foreground">
      {children}
    </div>
  )
}
