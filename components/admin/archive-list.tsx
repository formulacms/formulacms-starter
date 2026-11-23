"use client"

import { Component, useState, type ReactNode } from "react"
import { useMutation, usePaginatedQuery, useQuery } from "convex/react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import { Loader2, RotateCcw, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Doc } from "@/convex/_generated/dataModel"
import {
  adminContentTypeLabel,
  adminContentTypeSingularMessageKey,
} from "@/lib/admin/content-types"
import { destructiveRefusalMessage } from "@/lib/admin/destructive-refusal"
import { cn } from "@/lib/utils"
import { useConfirm } from "@/components/providers/confirm-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"

// Same classes as the Trash list (components/admin/trash-list.tsx), so the
// two lists share one header and one row look.
const RESTORE_TINT =
  "bg-emerald-600/10 text-emerald-600 hover:bg-emerald-600/20 hover:text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-400 dark:hover:bg-emerald-400/20 dark:hover:text-emerald-400"
const VISIBLE_BOX =
  "border-neutral-400 data-checked:border-primary dark:border-neutral-500 dark:data-checked:border-primary"

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

type PendingAction = "restore" | "trash"

function ArchiveListContent() {
  const displayError = useCaughtError()
  const t = useTranslations("inventory.archive")
  const tList = useTranslations("pages.list")
  const tContentType = useTranslations("sidebar.contentType")
  const router = useRouter()
  const confirm = useConfirm()
  const authority = useQuery(api.cms.publication.getAdminAuthority)
  const restoreSnapshot = useMutation(api.cms.publication.restorePage)
  const trashSnapshot = useMutation(api.cms.publication.softDeletePage)
  const paginated = usePaginatedQuery(
    api.cms.publication.listAdminPages,
    authority === "snapshot_active" ? { scope: "archive" } : "skip",
    { initialNumItems: 25 }
  )
  const [selected, setSelected] = useState<string[]>([])
  const [pending, setPending] = useState<Record<string, PendingAction>>({})

  const isLoading = paginated.status === "LoadingFirstPage"
  const isLoadingMore = paginated.status === "LoadingMore"
  const canLoadMore = paginated.status === "CanLoadMore"
  const pages = paginated.results as ArchivePage[]
  const busy = Object.keys(pending).length > 0

  const titleOf = (page: ArchivePage) => getTitle(page, t("untitled"))
  const byId = (ids: string[]) => pages.filter((p) => ids.includes(p._id))
  const markPending = (ids: string[], action: PendingAction | null) =>
    setPending((current) => {
      const next = { ...current }
      for (const id of ids) {
        if (action) next[id] = action
        else delete next[id]
      }
      return next
    })
  const unselect = (ids: string[]) =>
    setSelected((current) => current.filter((id) => !ids.includes(id)))

  function generation(page: ArchivePage) {
    if (page.lifecycleGeneration === undefined)
      throw new Error(t("lifecycleUnavailable"))
    return page.lifecycleGeneration
  }

  function restoreOne(page: ArchivePage) {
    return restoreSnapshot({
      pageId: page._id,
      expectedLifecycleGeneration: generation(page),
    })
  }

  /** Same calls and refusal messages as the Content list's "Move to trash". */
  function trashOne(page: ArchivePage) {
    return trashSnapshot({
      pageId: page._id,
      expectedLifecycleGeneration: generation(page),
    })
  }

  function trashRefusal(error: unknown) {
    return destructiveRefusalMessage(error, tList("toast.deleteFailed"), {
      PAGE_HOME_LIFECYCLE_REFUSED: tList("actions.homeNoArchive"),
      PAGE_SOFT_DELETE_MENU_REFERENCE: tList("toast.menuReference"),
      PAGE_SOFT_DELETE_PUBLISHED_POST_REFERENCE: tList(
        "toast.publishedPostReference"
      ),
    })
  }

  // One Page at a time, like the Trash list; a failed Page gets its own toast.
  async function handleRestore(ids: string[]) {
    const targets = byId(ids)
    if (targets.length === 0) return
    markPending(ids, "restore")
    const restored: ArchivePage[] = []
    for (const page of targets) {
      try {
        await restoreOne(page)
        restored.push(page)
      } catch (error) {
        toast.error(displayError(error, t("restoreFailed")))
      }
    }
    markPending(ids, null)
    unselect(ids)
    if (restored.length === 0) return
    toast.success(
      restored.length === 1
        ? t("restored", { title: titleOf(restored[0]!) })
        : t("restoredMany", { count: restored.length })
    )
    router.refresh()
  }

  async function handleTrash(ids: string[]) {
    const targets = byId(ids)
    if (targets.length === 0) return
    const ok = await confirm(
      targets.length === 1
        ? {
            title: tList("trashDialog.title"),
            description: tList("trashDialog.description"),
            confirmText: tList("trashDialog.confirm"),
            destructive: true,
          }
        : {
            title: t("trashManyTitle", { count: targets.length }),
            description: t("trashManyDescription"),
            confirmText: tList("trashDialog.confirm"),
            destructive: true,
          }
    )
    if (!ok) return
    markPending(ids, "trash")
    let moved = 0
    const refusals: string[] = []
    for (const page of targets) {
      try {
        await trashOne(page)
        moved += 1
      } catch (error) {
        refusals.push(
          targets.length === 1
            ? trashRefusal(error)
            : t("notMoved", {
                title: titleOf(page),
                reason: trashRefusal(error),
              })
        )
      }
    }
    markPending(ids, null)
    unselect(ids)
    // Refused Pages stay in the list; one toast names each, like the Trash list.
    if (refusals.length === 0)
      toast.success(
        moved === 1
          ? tList("toast.movedToTrash")
          : t("movedMany", { count: moved })
      )
    else
      toast.error(
        [moved > 0 ? t("movedMany", { count: moved }) : "", ...refusals]
          .filter(Boolean)
          .join(" ")
      )
    if (moved > 0) router.refresh()
  }

  if (authority === "invalid") {
    return (
      <ArchiveListUnavailable>
        <p className="mt-2 text-muted-foreground">{t("authorityIncomplete")}</p>
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

  const selectable = pages.map((page) => page._id as string)
  const picked = selected.filter((id) => selectable.includes(id))
  const allState =
    picked.length === 0
      ? false
      : picked.length === selectable.length
        ? true
        : "indeterminate"
  const toggleRow = (id: string) =>
    setSelected(
      picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id]
    )

  return (
    <div className="space-y-3">
      <div>
        <div
          data-testid="archive-bar"
          className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 rounded-t-lg border border-b-0 bg-muted/50 px-4 py-2"
        >
          <div className="flex items-center gap-2">
            <Checkbox
              id="archive-select-all"
              className={VISIBLE_BOX}
              checked={allState}
              onCheckedChange={(checked) =>
                setSelected(checked === true ? selectable : [])
              }
            />
            <Label htmlFor="archive-select-all" className="font-normal">
              {t("selectAll")}
            </Label>
          </div>
          <span className="text-sm font-semibold" aria-live="polite">
            {picked.length > 0 && t("selected", { count: picked.length })}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={RESTORE_TINT}
              disabled={picked.length === 0 || busy}
              onClick={() => void handleRestore(picked)}
            >
              <RotateCcw data-icon="inline-start" />
              {t("restoreSelected", { count: picked.length })}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={picked.length === 0 || busy}
              onClick={() => void handleTrash(picked)}
            >
              <Trash2 data-icon="inline-start" />
              {t("trashSelected", { count: picked.length })}
            </Button>
          </div>
        </div>
        <div className="divide-y rounded-b-lg border bg-card">
          {pages.map((page) => {
            const title = titleOf(page)
            const labelKey = adminContentTypeSingularMessageKey(page.pageType)
            const label = labelKey
              ? tContentType(labelKey)
              : adminContentTypeLabel(page.pageType).singular
            const action = pending[page._id]
            const isSelected = picked.includes(page._id)

            return (
              // A click on the row's empty area ticks it too (pointer
              // shortcut only; the checkbox stays the keyboard control).
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
              <div
                key={page._id}
                data-testid={`row-${page._id}`}
                className={cn(
                  "flex cursor-pointer flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3",
                  isSelected && "bg-muted/50"
                )}
                onClick={(event) => {
                  if (
                    (event.target as HTMLElement).closest(
                      "button, a, input, label"
                    )
                  )
                    return
                  toggleRow(page._id)
                }}
              >
                <div className="flex min-w-[140px] flex-1 items-start gap-3">
                  <Checkbox
                    className={cn("mt-0.5", VISIBLE_BOX)}
                    aria-label={title}
                    checked={isSelected}
                    onCheckedChange={() => toggleRow(page._id)}
                  />
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
                </div>
                <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={RESTORE_TINT}
                    onClick={() => void handleRestore([page._id])}
                    disabled={action !== undefined}
                  >
                    {action === "restore" ? (
                      <Loader2
                        data-icon="inline-start"
                        className="animate-spin"
                      />
                    ) : (
                      <RotateCcw data-icon="inline-start" />
                    )}
                    {action === "restore" ? t("restoring") : t("restore")}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => void handleTrash([page._id])}
                    disabled={action !== undefined}
                  >
                    {action === "trash" ? (
                      <Loader2
                        data-icon="inline-start"
                        className="animate-spin"
                      />
                    ) : (
                      <Trash2 data-icon="inline-start" />
                    )}
                    {tList("actions.moveToTrash")}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
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
        <p className="text-center text-xs text-muted-foreground">{t("end")}</p>
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
