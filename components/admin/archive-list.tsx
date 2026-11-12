"use client"

import { Component, useState, type ReactNode } from "react"
import { useMutation, usePaginatedQuery, useQuery } from "convex/react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import { ArchiveRestore, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Doc, Id } from "@/convex/_generated/dataModel"
import {
  adminContentTypeLabel,
  adminContentTypeSingularMessageKey,
} from "@/lib/admin/content-types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

type ArchivePage = Pick<Doc<"pages">, "_id" | "pageType" | "slug"> & {
  content?: Doc<"pages">["content"]
  effectiveTitles?: Record<string, string>
  localizedTitles?: Record<string, string>
  lifecycleGeneration?: number
}

function getTitle(page: ArchivePage, untitled: string): string {
  const content = page.content as
    Record<string, { title?: string } | undefined> | undefined
  for (const value of Object.values(content ?? {})) {
    const title = value?.title?.trim()
    if (title) return title
  }
  for (const value of Object.values(
    page.localizedTitles ?? page.effectiveTitles ?? {}
  )) {
    const title = value?.trim()
    if (title) return title
  }
  return page.slug || untitled
}

function ArchiveListUnavailable({ children }: { children?: ReactNode }) {
  const t = useTranslations("inventory.archive")

  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-sm"
    >
      <p className="font-medium">{t("unavailableTitle")}</p>
      <p className="mt-1 text-muted-foreground">
        {t("unavailableDescription")}
      </p>
      {children}
    </div>
  )
}

class ArchiveListErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  render() {
    return this.state.hasError ? (
      <ArchiveListUnavailable />
    ) : (
      this.props.children
    )
  }
}

function ArchiveListContent() {
  const displayError = useCaughtError()
  const t = useTranslations("inventory.archive")
  const tContentType = useTranslations("sidebar.contentType")
  const router = useRouter()
  const authority = useQuery(api.cms.publication.getAdminAuthority)
  const restoreLegacy = useMutation(api.cms.pages.update)
  const restoreSnapshot = useMutation(api.cms.publication.restorePage)
  const legacyPaginated = usePaginatedQuery(
    api.cms.pages.listPaginated,
    authority === "legacy" ? { status: "archived" } : "skip",
    { initialNumItems: 25 }
  )
  const snapshotPaginated = usePaginatedQuery(
    api.cms.publication.listAdminPages,
    authority === "snapshot_active" ? { scope: "archive" } : "skip",
    { initialNumItems: 25 }
  )
  const [pendingId, setPendingId] = useState<Id<"pages"> | null>(null)

  const paginated =
    authority === "snapshot_active" ? snapshotPaginated : legacyPaginated

  const isLoading = paginated.status === "LoadingFirstPage"
  const isLoadingMore = paginated.status === "LoadingMore"
  const canLoadMore = paginated.status === "CanLoadMore"
  const pages = paginated.results as ArchivePage[]

  function handleRestore(page: ArchivePage) {
    setPendingId(page._id)
    const request =
      authority === "snapshot_active"
        ? page.lifecycleGeneration === undefined
          ? Promise.reject(new Error(t("lifecycleUnavailable")))
          : restoreSnapshot({
              pageId: page._id,
              expectedLifecycleGeneration: page.lifecycleGeneration,
            })
        : restoreLegacy({ id: page._id, status: "draft" })
    void request
      .then(() => {
        toast.success(t("restored", { title: getTitle(page, t("untitled")) }))
        router.refresh()
      })
      .catch((error: unknown) => {
        toast.error(
          displayError(error, t("restoreFailed"))
        )
      })
      .finally(() => setPendingId(null))
  }

  if (authority === "invalid") {
    return (
      <ArchiveListUnavailable>
        <p className="mt-2 text-muted-foreground">
          {t("authorityIncomplete")}
        </p>
      </ArchiveListUnavailable>
    )
  }

  if (isLoading) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        {t("loading")}
      </div>
    )
  }

  if (pages.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center">
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="divide-y overflow-hidden rounded-lg border bg-card">
        {pages.map((page) => {
          const title = getTitle(page, t("untitled"))
          const labelKey = adminContentTypeSingularMessageKey(page.pageType)
          const label = labelKey
            ? tContentType(labelKey)
            : adminContentTypeLabel(page.pageType).singular
          const isPending = pendingId === page._id

          return (
            <div
              key={page._id}
              className="flex items-center justify-between gap-4 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{title}</p>
                <div className="mt-0.5 flex flex-wrap items-center gap-2">
                  <span className="truncate text-xs text-muted-foreground">
                    {page.slug || t("noSlug")}
                  </span>
                  <Badge variant="outline" className="text-xs">
                    {label}
                  </Badge>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => handleRestore(page)}
                disabled={isPending}
              >
                {isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ArchiveRestore className="size-4" />
                )}
                {isPending ? t("restoring") : t("restore")}
              </Button>
            </div>
          )
        })}
      </div>

      {canLoadMore ? (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => paginated.loadMore(25)}
            disabled={isLoadingMore}
          >
            {isLoadingMore ? t("loadingMore") : t("loadMore")}
          </Button>
        </div>
      ) : (
        <p className="text-center text-xs text-muted-foreground">
          {t("end")}
        </p>
      )}
    </div>
  )
}

export function ArchiveList() {
  return (
    <ArchiveListErrorBoundary>
      <ArchiveListContent />
    </ArchiveListErrorBoundary>
  )
}
