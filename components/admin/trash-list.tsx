"use client"

import { usePageAddressMessages } from "@/lib/admin/page-address-messages"

import { useState } from "react"
import {
  useConvex,
  useMutation,
  usePaginatedQuery,
  useQuery,
} from "convex/react"
import { useRouter } from "next/navigation"
import { useLocale, useTranslations } from "next-intl"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import { toast } from "sonner"

import { api } from "@/convex/_generated/api"
import type { Doc, Id } from "@/convex/_generated/dataModel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { RowTitle, RowUrlName } from "./list-row-text"
import { useConfirm } from "@/components/providers/confirm-provider"
import {
  adminContentTypeLabel,
  adminContentTypeSingularMessageKey,
} from "@/lib/admin/content-types"

type TrashPage = Pick<Doc<"pages">, "_id" | "pageType" | "slug"> & {
  content?: Doc<"pages">["content"]
  localizedTitles?: Record<string, string>
  deletedAt?: number
  updatedAt?: number
  lifecycleGeneration?: number
}

function pageTitle(
  page: TrashPage,
  defaultLocale: string | undefined,
  untitled: string
) {
  const urlName = {
    slug: page.slug,
    slugLocale: page.slug ? defaultLocale : undefined,
  }
  for (const [locale, localized] of Object.entries(page.content ?? {})) {
    const title = localized?.title?.trim()
    if (title) return { ...urlName, title, titleLocale: locale }
  }
  for (const [locale, title] of Object.entries(page.localizedTitles ?? {})) {
    if (title.trim())
      return { ...urlName, title: title.trim(), titleLocale: locale }
  }
  return {
    ...urlName,
    title: page.slug || untitled,
    titleLocale: page.slug ? defaultLocale : undefined,
  }
}

export function TrashList() {
  const displayError = useCaughtError()
  const t = useTranslations("inventory.trash")
  const tContentType = useTranslations("sidebar.contentType")
  const locale = useLocale()
  const router = useRouter()
  const convex = useConvex()
  const confirm = useConfirm()
  const defaultLocale = useQuery(api.cms.settings.getSiteConfig)?.defaultLocale
  const addressMessages = usePageAddressMessages(defaultLocale ?? "en")
  const authority = useQuery(api.cms.publication.getAdminAuthority)
  const legacyItems = useQuery(
    api.cms.pages.list,
    authority === "legacy" ? { includeDeleted: true } : "skip"
  )
  const snapshotItems = usePaginatedQuery(
    api.cms.publication.listAdminPages,
    authority === "snapshot_active" ? { scope: "trash" } : "skip",
    { initialNumItems: 25 }
  )
  const restoreLegacy = useMutation(api.cms.pages.restore)
  const restoreSnapshot = useMutation(
    api.cms.publication.restoreSoftDeletedPage
  )
  const remove = useMutation(api.cms.pages.remove)
  const [pendingId, setPendingId] = useState<Id<"pages"> | null>(null)

  const items: TrashPage[] =
    authority === "snapshot_active"
      ? snapshotItems.results
      : (legacyItems ?? []).filter((page) => page.deletedAt !== undefined)
  const isLoading =
    authority === undefined ||
    (authority === "legacy" && legacyItems === undefined) ||
    (authority === "snapshot_active" &&
      snapshotItems.status === "LoadingFirstPage")

  async function handleRestore(page: TrashPage) {
    const { title } = pageTitle(page, defaultLocale, t("untitled"))
    setPendingId(page._id)
    try {
      let restoredMessages = [t("restored", { title })]
      if (authority === "snapshot_active") {
        if (page.lifecycleGeneration === undefined) {
          throw new Error(t("lifecycleUnavailable"))
        }
        const result = await restoreSnapshot({
          pageId: page._id,
          expectedLifecycleGeneration: page.lifecycleGeneration,
        })
        restoredMessages = addressMessages.restored(
          result.addressNotices,
          "S5",
          restoredMessages[0]!,
          title,
          page.pageType,
          page.localizedTitles
        )
      } else if (authority === "legacy") {
        await restoreLegacy({ id: page._id })
      } else {
        throw new Error(t("authorityIncomplete"))
      }
      for (const message of restoredMessages) toast.success(message)
      router.refresh()
    } catch (error) {
      toast.error(displayError(error, t("restoreFailed")))
    }
    setPendingId(null)
  }

  async function handlePermanentDelete(page: TrashPage) {
    if (authority !== "legacy") return
    const { title } = pageTitle(page, defaultLocale, t("untitled"))
    let impact
    try {
      impact = await convex.query(api.cms.pages.deleteImpact, { id: page._id })
    } catch (error) {
      toast.error(displayError(error, t("referenceCheckFailed")))
      return
    }
    if (impact.children.length > 0) {
      toast.error(t("childBlocker", { count: impact.children.length }))
      return
    }
    if (impact.menus.length > 0) {
      toast.error(
        t("menuBlocker", {
          count: impact.menus.length,
          menus: impact.menus.join(", "),
        })
      )
      return
    }
    const description = [
      t("deleteDescription", { title }),
      impact.redirects > 0
        ? t("redirectImpact", { count: impact.redirects })
        : "",
    ]
      .filter(Boolean)
      .join(" ")
    const ok = await confirm({
      title: t("confirmTitle"),
      description,
      confirmText: t("confirm"),
      destructive: true,
    })
    if (!ok) return
    setPendingId(page._id)
    try {
      await remove({ id: page._id })
      toast.success(t("deleted", { title }))
      router.refresh()
    } catch (error) {
      toast.error(displayError(error, t("deleteFailed")))
    }
    setPendingId(null)
  }

  if (authority === "invalid") {
    return (
      <div
        role="alert"
        className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-sm"
      >
        {t("authorityIncomplete")}
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        {t("loading")}
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center">
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="divide-y rounded-lg border bg-card">
        {items.map((page) => {
          const row = pageTitle(page, defaultLocale, t("untitled"))
          const changedAt = page.deletedAt ?? page.updatedAt
          const changedLabel = changedAt
            ? new Date(changedAt).toLocaleDateString(locale)
            : "—"
          const isPending = pendingId === page._id
          const typeKey = adminContentTypeSingularMessageKey(page.pageType)
          const typeLabel = typeKey
            ? tContentType(typeKey)
            : adminContentTypeLabel(page.pageType).singular
          return (
            <div
              key={page._id}
              className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3"
            >
              <div className="min-w-[140px] flex-1">
                <RowTitle locale={row.titleLocale}>{row.title}</RowTitle>
                <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  <RowUrlName value={row.slug} locale={row.slugLocale} />
                  <Badge variant="outline" className="text-xs">
                    {typeLabel}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {t("moved", { date: changedLabel })}
                  </span>
                </div>
              </div>
              <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2 sm:-mt-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isPending}
                  onClick={() => void handleRestore(page)}
                >
                  {t("restore")}
                </Button>
                {authority === "legacy" && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isPending}
                    className="text-destructive hover:text-destructive"
                    onClick={() => void handlePermanentDelete(page)}
                  >
                    {t("deleteForever")}
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {authority === "snapshot_active" &&
        snapshotItems.status === "CanLoadMore" && (
          <div className="flex justify-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => snapshotItems.loadMore(25)}
            >
              {t("loadMore")}
            </Button>
          </div>
        )}
    </div>
  )
}
