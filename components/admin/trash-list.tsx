"use client"

import { usePageAddressMessages } from "@/lib/admin/page-address-messages"

import {
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react"
import Image from "next/image"
import {
  useConvex,
  useMutation,
  usePaginatedQuery,
  useQuery,
} from "convex/react"
import type { FunctionReturnType } from "convex/server"
import { useRouter } from "next/navigation"
import { useLocale, useTranslations } from "next-intl"
import { Loader2, RotateCcw, Trash2 } from "lucide-react"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import { toast } from "sonner"

import { api } from "@/convex/_generated/api"
import type { Doc } from "@/convex/_generated/dataModel"
import type {
  PagePurgeDetail,
  PagePurgeReason,
} from "@/convex/lib/publishing/pagePurge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { RowTitle, RowUrlName } from "./list-row-text"
import { useConfirm } from "@/components/providers/confirm-provider"
import {
  adminContentTypeLabel,
  adminContentTypeSingularMessageKey,
} from "@/lib/admin/content-types"
import { cn } from "@/lib/utils"

// Reused from components/admin/email-settings.tsx (the theme has no success token).
const RESTORE_TINT =
  "bg-emerald-600/10 text-emerald-600 hover:bg-emerald-600/20 hover:text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-400 dark:hover:bg-emerald-400/20 dark:hover:text-emerald-400"
const PAGE_SIZE = 25
/** One delete call takes at most this many Pages or images (server limits). */
const PAGE_BATCH = 25
const IMAGE_BATCH = 50
/** The check before the confirm reads much more per Page, so it asks about
 *  a few Pages at a time to stay within one query's read limit. */
const IMPACT_BATCH = 5
// Visible checkbox border: the shadcn `--input` token is as pale as a divider,
// too faint for the row-selection boxes Trash depends on.
const VISIBLE_BOX =
  "border-neutral-400 data-checked:border-primary dark:border-neutral-500 dark:data-checked:border-primary"

type Tab = "pages" | "images"
type T = ReturnType<typeof useTranslations<"inventory.trash">>

type TrashPage = Pick<Doc<"pages">, "_id" | "pageType" | "slug"> & {
  content?: Doc<"pages">["content"]
  localizedTitles?: Record<string, string>
  deletedAt?: number
  updatedAt?: number
  lifecycleGeneration?: number
  purging?: boolean
  purgeStalled?: boolean
}

type PageRefusal = { reason?: PagePurgeReason; detail?: PagePurgeDetail }
type MediaResult = FunctionReturnType<
  typeof api.cms.media.purgeTrashedMedia
>[number]
type TrashImage = FunctionReturnType<
  typeof api.cms.media.listTrashed
>["page"][number]

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

function chunks<V>(items: V[], size: number): V[][] {
  const out: V[][] = []
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size))
  return out
}

function useNames() {
  const t = useTranslations("inventory.trash")
  return (parts: string[]) => {
    const [a = "", b = "", c = ""] = parts
    if (parts.length <= 1) return a
    if (parts.length === 2) return t("namesTwo", { a, b })
    if (parts.length === 3) return t("namesThree", { a, b, c })
    return t("namesMore", { a, b, c, count: parts.length - 3 })
  }
}

export function TrashList() {
  const t = useTranslations("inventory.trash")
  const [tab, setTab] = useState<Tab>("pages")
  const [selected, setSelected] = useState<string[]>([])

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        setTab(value as Tab)
        setSelected([])
      }}
      className="space-y-4"
    >
      <TabsList>
        <TabsTrigger value="pages">{t("tabPages")}</TabsTrigger>
        <TabsTrigger value="images">{t("tabImages")}</TabsTrigger>
      </TabsList>
      <TabsContent value="pages">
        <PagesTrash selected={selected} setSelected={setSelected} />
      </TabsContent>
      <TabsContent value="images">
        <ImagesTrash selected={selected} setSelected={setSelected} />
      </TabsContent>
    </Tabs>
  )
}

type SelectionProps = {
  selected: string[]
  setSelected: Dispatch<SetStateAction<string[]>>
}

type Row = {
  id: string
  title: string
  titleLocale?: string
  meta: ReactNode
  preview?: string
  deleting: boolean
  /** A permanent delete stopped: Delete retries it, Restore is refused. */
  stalled?: boolean
  pending: boolean
}

function TrashRows({
  rows,
  selected,
  setSelected,
  onRestore,
  onDelete,
  onBarDelete,
  onLoadMore,
}: SelectionProps & {
  rows: Row[]
  onRestore: (ids: string[]) => void
  onDelete: (id: string) => void
  onBarDelete: (ids: string[]) => void
  onLoadMore?: () => void
}) {
  const t = useTranslations("inventory.trash")

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center">
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      </div>
    )
  }

  const selectable = rows.filter((row) => !row.deleting).map((row) => row.id)
  const picked = selected.filter((id) => selectable.includes(id))
  const allState =
    picked.length === 0
      ? false
      : picked.length === selectable.length
        ? true
        : "indeterminate"
  const restorable = picked.filter(
    (id) => !rows.some((row) => row.id === id && row.stalled)
  )
  const toggleRow = (id: string) =>
    setSelected(
      picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id]
    )

  return (
    <div className="space-y-3">
      <div>
        <div
          data-testid="trash-bar"
          className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 rounded-t-lg border border-b-0 bg-muted/50 px-4 py-2"
        >
          <div className="flex items-center gap-2">
            <Checkbox
              id="trash-select-all"
              className={VISIBLE_BOX}
              checked={allState}
              disabled={selectable.length === 0}
              onCheckedChange={(checked) =>
                setSelected(checked === true ? selectable : [])
              }
            />
            <Label htmlFor="trash-select-all" className="font-normal">
              {t("selectAll")}
            </Label>
          </div>
          <span className="text-sm font-semibold" aria-live="polite">
            {picked.length > 0 && t("selected", { count: picked.length })}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <RestoreButton
              disabled={restorable.length === 0}
              label={t("restoreSelected", { count: restorable.length })}
              onClick={() => onRestore(restorable)}
            />
            <DeleteButton
              disabled={picked.length === 0}
              label={t("deleteSelected", { count: picked.length })}
              onClick={() => onBarDelete(picked)}
            />
          </div>
        </div>
        <div className="divide-y rounded-b-lg border bg-card">
          {rows.map((row) => {
            const isSelected = picked.includes(row.id)
            return (
              // A click on the row's empty area ticks it too (pointer
              // shortcut only; the checkbox stays the keyboard control).
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
              <div
                key={row.id}
                data-testid={`row-${row.id}`}
                className={cn(
                  "flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3",
                  !row.deleting && "cursor-pointer",
                  isSelected && "bg-muted/50"
                )}
                onClick={(event) => {
                  if (row.deleting) return
                  if (
                    (event.target as HTMLElement).closest(
                      "button, a, input, label"
                    )
                  )
                    return
                  toggleRow(row.id)
                }}
              >
                <div className="flex min-w-[140px] flex-1 items-start gap-3">
                  <Checkbox
                    className={cn("mt-0.5", VISIBLE_BOX)}
                    aria-label={row.title}
                    checked={isSelected}
                    disabled={row.deleting}
                    onCheckedChange={() => toggleRow(row.id)}
                  />
                  {row.preview && (
                    <div
                      aria-hidden
                      data-testid="thumb"
                      className={cn(
                        "relative h-9 w-12 shrink-0 overflow-hidden rounded-md border bg-muted",
                        row.deleting && "opacity-50"
                      )}
                    >
                      <Image
                        src={row.preview}
                        alt=""
                        fill
                        className="object-cover"
                        sizes="48px"
                      />
                    </div>
                  )}
                  <div
                    data-testid="rowbody"
                    className={cn(
                      "min-w-0 flex-1",
                      row.deleting && "text-muted-foreground opacity-60"
                    )}
                  >
                    <RowTitle locale={row.titleLocale} muted={row.deleting}>
                      {row.title}
                    </RowTitle>
                    <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                      {row.meta}
                      {row.deleting && (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Loader2
                            className="size-3 animate-spin"
                            aria-hidden
                          />
                          {t("deleting")}
                        </span>
                      )}
                      {row.stalled && (
                        <span className="text-xs text-muted-foreground">
                          {t("deleteStopped")}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2 sm:-mt-1.5">
                  <RestoreButton
                    disabled={row.deleting || row.stalled || row.pending}
                    onClick={() => onRestore([row.id])}
                  />
                  <DeleteButton
                    disabled={row.deleting || row.pending}
                    onClick={() => onDelete(row.id)}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>
      {onLoadMore && (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onLoadMore}
          >
            {t("loadMore")}
          </Button>
        </div>
      )}
    </div>
  )
}

function RestoreButton({
  onClick,
  disabled,
  label,
}: {
  onClick: () => void
  disabled?: boolean
  label?: string
}) {
  const t = useTranslations("inventory.trash")
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled}
      className={RESTORE_TINT}
      onClick={onClick}
    >
      <RotateCcw data-icon="inline-start" />
      {label ?? t("restore")}
    </Button>
  )
}

function DeleteButton({
  onClick,
  disabled,
  label,
}: {
  onClick: () => void
  disabled?: boolean
  label?: string
}) {
  const t = useTranslations("inventory.trash")
  return (
    <Button
      type="button"
      variant="destructive"
      size="sm"
      disabled={disabled}
      onClick={onClick}
    >
      <Trash2 data-icon="inline-start" />
      {label ?? t("delete")}
    </Button>
  )
}

const confirmIcon = <Trash2 data-icon="inline-start" />

// ---------------------------------------------------------------- Pages

/** Refusals that say why in a whole sentence, never inside "was not deleted". */
const PAGE_CHANGED_REASONS = new Set<PageRefusal["reason"]>([
  "stale",
  "not_trashed",
  "home",
])

function pageSentenceRefusal(refusal: PageRefusal, title: string, t: T) {
  if (PAGE_CHANGED_REASONS.has(refusal.reason))
    return t("changedRefusal", { title })
  if (refusal.reason === "language_operation") return t("languageRefusal")
  return null
}

/** One-row refusal, shown in place of the confirm. */
function pageStandaloneRefusal(refusal: PageRefusal, title: string, t: T) {
  const count = refusal.detail?.count ?? 1
  switch (refusal.reason) {
    case "children":
      return t("childBlocker", { count })
    case "menus":
      return t("menuBlocker", {
        count,
        menus: (refusal.detail?.menus ?? []).join(", "),
      })
    case "incoming_links":
      return t("linkBlocker", {
        first: refusal.detail?.titles?.[0] ?? "",
        others: Math.max(count - 1, 0),
      })
    case "revalidation_pending":
      return t("removingBlocker")
    default:
      return pageSentenceRefusal(refusal, title, t) ?? t("deleteFailed")
  }
}

/** The {reason} in "“{title}” was not deleted: {reason}". */
function pageRefusalReason(refusal: PageRefusal, t: T) {
  const count = refusal.detail?.count ?? 1
  switch (refusal.reason) {
    case "children":
      return t("childReason", { count })
    case "menus":
      return t("menuReason", {
        count,
        menus: (refusal.detail?.menus ?? []).join(", "),
      })
    case "incoming_links":
      return t("linkReason", {
        first: refusal.detail?.titles?.[0] ?? "",
        others: Math.max(count - 1, 0),
      })
    case "revalidation_pending":
      return t("removingReason")
    default:
      return t("deleteFailed")
  }
}

function PagesTrash({ selected, setSelected }: SelectionProps) {
  const displayError = useCaughtError()
  const t = useTranslations("inventory.trash")
  const tContentType = useTranslations("sidebar.contentType")
  const locale = useLocale()
  const router = useRouter()
  const convex = useConvex()
  const confirm = useConfirm()
  const names = useNames()
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
    { initialNumItems: PAGE_SIZE }
  )
  const restoreLegacy = useMutation(api.cms.pages.restore)
  const restoreSnapshot = useMutation(
    api.cms.publication.restoreSoftDeletedPage
  )
  const remove = useMutation(api.cms.pages.remove)
  const purge = useMutation(api.cms.publication.purgeTrashedPages)
  const [pendingIds, setPendingIds] = useState<string[]>([])

  const items: TrashPage[] =
    authority === "snapshot_active"
      ? snapshotItems.results
      : (legacyItems ?? []).filter((page) => page.deletedAt !== undefined)
  const isLoading =
    authority === undefined ||
    (authority === "legacy" && legacyItems === undefined) ||
    (authority === "snapshot_active" &&
      snapshotItems.status === "LoadingFirstPage")

  const titleOf = (page: TrashPage) =>
    pageTitle(page, defaultLocale, t("untitled")).title
  const byId = (ids: string[]) => items.filter((p) => ids.includes(p._id))
  const markPending = (ids: string[], on: boolean) =>
    setPendingIds((current) =>
      on ? [...current, ...ids] : current.filter((id) => !ids.includes(id))
    )
  const unselect = (ids: string[]) =>
    setSelected((current) => current.filter((id) => !ids.includes(id)))

  function generation(page: TrashPage) {
    if (page.lifecycleGeneration === undefined)
      throw new Error(t("lifecycleUnavailable"))
    return page.lifecycleGeneration
  }

  /** Restores one Page; returns the messages today's single restore shows. */
  async function restoreOne(page: TrashPage) {
    const title = titleOf(page)
    const fallback = t("restored", { title })
    if (authority === "snapshot_active") {
      const result = await restoreSnapshot({
        pageId: page._id,
        expectedLifecycleGeneration: generation(page),
      })
      return {
        fallback,
        messages: addressMessages.restored(
          result.addressNotices,
          "S5",
          fallback,
          title,
          page.pageType,
          page.localizedTitles
        ),
      }
    }
    if (authority === "legacy") {
      await restoreLegacy({ id: page._id })
      return { fallback, messages: [fallback] }
    }
    throw new Error(t("authorityIncomplete"))
  }

  async function handleRestore(ids: string[]) {
    const targets = byId(ids)
    if (targets.length === 0) return
    markPending(ids, true)
    // One Page at a time. Every address notice is shown, never only the count.
    const restored: Array<{ title: string; notices: string[] }> = []
    for (const page of targets) {
      try {
        const { fallback, messages } = await restoreOne(page)
        restored.push({
          title: titleOf(page),
          notices:
            targets.length === 1
              ? messages
              : messages.filter((message) => message !== fallback),
        })
      } catch (error) {
        toast.error(displayError(error, t("restoreFailed")))
      }
    }
    markPending(ids, false)
    unselect(ids)
    if (restored.length === 0) return
    if (targets.length > 1)
      toast.success(
        restored.length === 1
          ? t("restored", { title: restored[0]!.title })
          : t("restoredMany", { count: restored.length })
      )
    for (const { notices } of restored)
      for (const message of notices) toast.success(message)
    router.refresh()
  }

  /**
   * Refusals known before the confirm, and the redirect count. With
   * `tolerant` (the bar), a group whose check fails is skipped: the delete
   * call makes the real checks.
   */
  async function checkImpact(targets: TrashPage[], tolerant = false) {
    const refusals = new Map<string, PageRefusal>()
    let redirects = 0
    if (authority === "snapshot_active") {
      for (const group of chunks(targets, IMPACT_BATCH)) {
        let impact
        try {
          impact = await convex.query(api.cms.publication.pagePurgeImpact, {
            pageIds: group.map((page) => page._id),
          })
        } catch (error) {
          if (tolerant) continue
          throw error
        }
        for (const row of impact) {
          redirects += row.redirects
          if (!row.canPurge)
            refusals.set(row.pageId, { reason: row.reason, detail: row.detail })
        }
      }
    } else if (authority === "legacy") {
      for (const page of targets) {
        const impact = await convex.query(api.cms.pages.deleteImpact, {
          id: page._id,
        })
        redirects += impact.redirects
        if (impact.children.length > 0)
          refusals.set(page._id, {
            reason: "children",
            detail: { count: impact.children.length },
          })
        else if (impact.menus.length > 0)
          refusals.set(page._id, {
            reason: "menus",
            detail: { count: impact.menus.length, menus: impact.menus },
          })
      }
    } else {
      throw new Error(t("authorityIncomplete"))
    }
    return { refusals, redirects }
  }

  /**
   * Starts the delete of every selected Page. A Page refused because a
   * selected child or linking Page was not queued yet is sent again, round
   * after round, until a round starts no new Page; only the final refusals
   * are kept. Legacy sites delete at once and skip the refusals known before.
   */
  async function runDelete(
    targets: TrashPage[],
    known: Map<string, PageRefusal>
  ) {
    const accepted: TrashPage[] = []
    if (authority === "snapshot_active") {
      const refused = new Map<string, PageRefusal>()
      let round = targets
      while (round.length > 0) {
        let started = 0
        const retry: TrashPage[] = []
        for (const group of chunks(round, PAGE_BATCH)) {
          const results = await purge({
            items: group.map((page) => ({
              pageId: page._id,
              expectedLifecycleGeneration: generation(page),
            })),
          })
          for (const result of results) {
            const page = group.find((p) => p._id === result.pageId)
            if (!page) continue
            if (result.status === "started") {
              started += 1
              accepted.push(page)
              refused.delete(page._id)
            } else {
              refused.set(page._id, {
                reason: result.reason,
                detail: result.detail,
              })
              if (
                result.reason === "children" ||
                result.reason === "incoming_links"
              )
                retry.push(page)
            }
          }
        }
        if (started === 0) break
        round = retry
      }
      return { accepted, refused }
    }
    const refused = new Map(known)
    const eligible = targets.filter((page) => !known.has(page._id))
    for (const page of eligible) {
      try {
        await remove({ id: page._id })
        accepted.push(page)
      } catch {
        refused.set(page._id, {})
      }
    }
    return { accepted, refused }
  }

  function report(
    targets: TrashPage[],
    accepted: TrashPage[],
    refused: Map<string, PageRefusal>
  ) {
    // Snapshot sites queue the delete; it finishes in the background.
    const done = (count: number) =>
      authority === "snapshot_active"
        ? t("pagesDeleting", { count })
        : t("deletedMany", { count })
    if (refused.size === 0) {
      toast.success(done(accepted.length))
      return
    }
    if (targets.length === 1) {
      toast.error(
        pageStandaloneRefusal(
          refused.get(targets[0]!._id)!,
          titleOf(targets[0]!),
          t
        )
      )
      return
    }
    const parts = accepted.length ? [done(accepted.length)] : []
    for (const page of targets) {
      const refusal = refused.get(page._id)
      if (!refusal) continue
      const sentence = pageSentenceRefusal(refusal, titleOf(page), t)
      if (sentence) {
        if (!parts.includes(sentence)) parts.push(sentence)
      } else
        parts.push(
          t("notDeleted", {
            title: titleOf(page),
            reason: pageRefusalReason(refusal, t),
          })
        )
    }
    toast.error(parts.join(" "))
  }

  async function deletePages(
    targets: TrashPage[],
    known: Map<string, PageRefusal>
  ) {
    const ids = targets.map((page) => page._id)
    markPending(ids, true)
    try {
      const { accepted, refused } = await runDelete(targets, known)
      unselect(ids)
      report(targets, accepted, refused)
      router.refresh()
    } catch (error) {
      toast.error(displayError(error, t("deleteFailed")))
    }
    markPending(ids, false)
  }

  // One row: like today, refusals show before the confirm.
  async function handleDelete(id: string) {
    const page = byId([id])[0]
    if (!page) return
    let impact
    try {
      impact = await checkImpact([page])
    } catch (error) {
      toast.error(displayError(error, t("referenceCheckFailed")))
      return
    }
    // A stopped delete is retried by the server, whatever the check says.
    const refusal = page.purgeStalled
      ? undefined
      : impact.refusals.get(page._id)
    if (refusal) {
      toast.error(pageStandaloneRefusal(refusal, titleOf(page), t))
      return
    }
    const description = [
      t("deleteDescription", { title: titleOf(page) }),
      impact.redirects ? t("redirectImpact", { count: impact.redirects }) : "",
    ]
      .filter(Boolean)
      .join(" ")
    const ok = await confirm({
      title: t("confirmTitle"),
      description,
      confirmText: t("confirm"),
      destructive: true,
      filled: true,
      icon: confirmIcon,
    })
    if (ok) await deletePages([page], new Map())
  }

  // Several rows: confirm first; refused pages are named in one toast after.
  async function handleBarDelete(ids: string[]) {
    const targets = byId(ids)
    if (targets.length === 0) return
    if (targets.length === 1) return handleDelete(targets[0]!._id)
    let impact
    try {
      impact = await checkImpact(targets, true)
    } catch (error) {
      toast.error(displayError(error, t("referenceCheckFailed")))
      return
    }
    const description = [
      t("deleteDescriptionMany", {
        names: names(
          targets.map((page) => t("quoted", { title: titleOf(page) }))
        ),
      }),
      impact.redirects ? t("redirectImpact", { count: impact.redirects }) : "",
    ]
      .filter(Boolean)
      .join(" ")
    const ok = await confirm({
      title: t("confirmTitleMany", { count: targets.length }),
      description,
      confirmText: t("confirmMany", { count: targets.length }),
      destructive: true,
      filled: true,
      icon: confirmIcon,
    })
    if (ok) await deletePages(targets, impact.refusals)
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

  const rows: Row[] = items.map((page) => {
    const row = pageTitle(page, defaultLocale, t("untitled"))
    const changedAt = page.deletedAt ?? page.updatedAt
    const changedLabel = changedAt
      ? new Date(changedAt).toLocaleDateString(locale)
      : "—"
    const typeKey = adminContentTypeSingularMessageKey(page.pageType)
    const typeLabel = typeKey
      ? tContentType(typeKey)
      : adminContentTypeLabel(page.pageType).singular
    const deleting = page.purging === true
    const stalled = page.purgeStalled === true
    return {
      id: page._id,
      title: row.title,
      titleLocale: row.titleLocale,
      deleting,
      stalled,
      pending: pendingIds.includes(page._id),
      meta: (
        <>
          <RowUrlName value={row.slug} locale={row.slugLocale} />
          <Badge variant="outline" className="text-xs">
            {typeLabel}
          </Badge>
          {!deleting && !stalled && (
            <span className="text-xs text-muted-foreground">
              {t("moved", { date: changedLabel })}
            </span>
          )}
        </>
      ),
    }
  })

  return (
    <TrashRows
      rows={rows}
      selected={selected}
      setSelected={setSelected}
      onRestore={(ids) => void handleRestore(ids)}
      onDelete={(id) => void handleDelete(id)}
      onBarDelete={(ids) => void handleBarDelete(ids)}
      onLoadMore={
        authority === "snapshot_active" &&
        snapshotItems.status === "CanLoadMore"
          ? () => snapshotItems.loadMore(PAGE_SIZE)
          : undefined
      }
    />
  )
}

// ---------------------------------------------------------------- Images

/** Site-setting uses arrive as plain names; show the Settings label. */
const SETTING_LABEL_KEYS: Record<string, "logo" | "favicon" | "og"> = {
  logo: "logo",
  favicon: "favicon",
  "default OG image": "og",
}

function ImagesTrash({ selected, setSelected }: SelectionProps) {
  const displayError = useCaughtError()
  const t = useTranslations("inventory.trash")
  const tBranding = useTranslations("settings.general.branding")
  const locale = useLocale()
  const confirm = useConfirm()
  const names = useNames()
  const trashed = usePaginatedQuery(
    api.cms.media.listTrashed,
    {},
    { initialNumItems: PAGE_SIZE }
  )
  const restoreMedia = useMutation(api.cms.media.restore)
  const purgeMedia = useMutation(api.cms.media.purgeTrashedMedia)
  const [pendingIds, setPendingIds] = useState<string[]>([])

  const images: TrashImage[] = trashed.results
  const byId = (ids: string[]) => images.filter((i) => ids.includes(i._id))
  const markPending = (ids: string[], on: boolean) =>
    setPendingIds((current) =>
      on ? [...current, ...ids] : current.filter((id) => !ids.includes(id))
    )
  const unselect = (ids: string[]) =>
    setSelected((current) => current.filter((id) => !ids.includes(id)))

  function uses(result: MediaResult) {
    return names(
      (result.detail?.uses ?? []).map((use) => {
        if (use.kind === "menu") return t("imageMenuUse", { menu: use.name })
        const settingKey =
          use.kind === "setting" ? SETTING_LABEL_KEYS[use.name] : undefined
        return t("quoted", {
          title: settingKey ? tBranding(settingKey) : use.name,
        })
      })
    )
  }

  function olderVersionText(image: TrashImage, result: MediaResult) {
    return t("imageOlderVersionOnly", {
      filename: image.filename,
      page: result.detail?.uses[0]?.name ?? "",
    })
  }

  function standaloneRefusal(image: TrashImage, result: MediaResult) {
    if (result.reason === "index_pending") return t("imageDeletePending")
    if (result.reason === "in_use")
      return result.detail?.olderVersionsOnly
        ? olderVersionText(image, result)
        : t("imageInUse", { uses: uses(result) })
    if (result.reason === "not_found" || result.reason === "not_trashed")
      return t("changedRefusal", { title: image.filename })
    return t("deleteFailed")
  }

  function report(targets: TrashImage[], results: MediaResult[]) {
    const refused = results.filter((result) => result.status === "refused")
    const purged = results.length - refused.length
    if (refused.length === 0) {
      toast.success(t("imagesDeleted", { count: purged }))
      return
    }
    if (targets.length === 1) {
      toast.error(standaloneRefusal(targets[0]!, refused[0]!))
      return
    }
    const parts = purged ? [t("imagesDeleted", { count: purged })] : []
    let pendingShown = false
    for (const result of refused) {
      const image = targets.find((i) => i._id === result.id)
      if (!image) continue
      if (result.reason === "index_pending") {
        if (!pendingShown) parts.push(t("imageDeletePending"))
        pendingShown = true
      } else if (result.reason === "in_use" && result.detail?.olderVersionsOnly)
        parts.push(olderVersionText(image, result))
      else if (result.reason === "not_found" || result.reason === "not_trashed")
        parts.push(t("changedRefusal", { title: image.filename }))
      else
        parts.push(
          t("notDeleted", {
            title: image.filename,
            reason:
              result.reason === "in_use"
                ? t("imageInUseReason", { uses: uses(result) })
                : t("deleteFailed"),
          })
        )
    }
    toast.error(parts.join(" "))
  }

  async function deleteImages(targets: TrashImage[]) {
    const ids = targets.map((image) => image._id)
    markPending(ids, true)
    try {
      const results: MediaResult[] = []
      for (const group of chunks(ids, IMAGE_BATCH))
        results.push(...(await purgeMedia({ ids: group })))
      unselect(ids)
      report(targets, results)
    } catch (error) {
      toast.error(displayError(error, t("deleteFailed")))
    }
    markPending(ids, false)
  }

  // No usage check exists to call first, so a refusal shows after the confirm.
  async function handleDelete(id: string) {
    const image = byId([id])[0]
    if (!image) return
    const ok = await confirm({
      title: t("confirmTitle"),
      description: t("imageDeleteDescription", { title: image.filename }),
      confirmText: t("confirm"),
      destructive: true,
      filled: true,
      icon: confirmIcon,
    })
    if (ok) await deleteImages([image])
  }

  async function handleBarDelete(ids: string[]) {
    const targets = byId(ids)
    if (targets.length === 0) return
    if (targets.length === 1) return handleDelete(targets[0]!._id)
    const ok = await confirm({
      title: t("imageConfirmTitleMany", { count: targets.length }),
      description: t("imageDeleteDescriptionMany", {
        names: names(targets.map((i) => t("quoted", { title: i.filename }))),
      }),
      confirmText: t("imageConfirmMany", { count: targets.length }),
      destructive: true,
      filled: true,
      icon: confirmIcon,
    })
    if (ok) await deleteImages(targets)
  }

  async function handleRestore(ids: string[]) {
    const targets = byId(ids)
    if (targets.length === 0) return
    markPending(ids, true)
    const restored: TrashImage[] = []
    for (const image of targets) {
      try {
        await restoreMedia({ id: image._id })
        restored.push(image)
      } catch (error) {
        toast.error(displayError(error, t("restoreFailed")))
      }
    }
    markPending(ids, false)
    unselect(ids)
    if (restored.length === 0) return
    toast.success(
      restored.length === 1
        ? t("restored", { title: restored[0]!.filename })
        : t("imagesRestored", { count: restored.length })
    )
  }

  if (trashed.status === "LoadingFirstPage") {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        {t("loading")}
      </div>
    )
  }

  const rows: Row[] = images.map((image) => ({
    id: image._id,
    title: image.filename,
    preview: image.url,
    deleting: false,
    pending: pendingIds.includes(image._id),
    meta: (
      <>
        {image.width !== undefined && image.height !== undefined && (
          <span className="text-xs text-muted-foreground">
            {t("imageSize", { width: image.width, height: image.height })}
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          {t("moved", {
            date: new Date(image.deletedAt).toLocaleDateString(locale),
          })}
        </span>
      </>
    ),
  }))

  return (
    <TrashRows
      rows={rows}
      selected={selected}
      setSelected={setSelected}
      onRestore={(ids) => void handleRestore(ids)}
      onDelete={(id) => void handleDelete(id)}
      onBarDelete={(ids) => void handleBarDelete(ids)}
      onLoadMore={
        trashed.status === "CanLoadMore"
          ? () => trashed.loadMore(PAGE_SIZE)
          : undefined
      }
    />
  )
}
