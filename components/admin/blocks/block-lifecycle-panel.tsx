"use client"

import { useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import {
  Archive,
  ArchiveRestore,
  Check,
  CircleAlert,
  ExternalLink,
  Loader2,
  Pencil,
  Ship,
  Trash2,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { useQuery } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import { toast } from "sonner"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import {
  renameBlockAction,
  setBlockArchivedAction,
  setStarterShippedAction,
} from "@/app/(core)/admin/(authenticated)/blocks/actions"
import { api } from "@/convex/_generated/api"
import { useConfirm, usePrompt } from "@/components/providers/confirm-provider"
import { useBlockDeletion } from "@/components/providers/deletion-overlay-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/** The live usage summary, exactly as the backend returns it. */
export type BlockLifecycleSummary = FunctionReturnType<
  typeof api.cms.blockLibrary.getBlockUsageSummary
>
type BlockUse = BlockLifecycleSummary["pages"][number]["uses"][number]
type BlockUseStatus = BlockUse["status"]

/** Pages in Trash or being erased carry the red badge. */
const TRASH_STATUSES: ReadonlySet<BlockUseStatus> = new Set([
  "in_trash",
  "being_erased",
])

/** One badge per distinct status; a switched-off language names its locale. */
function statusGroups(uses: BlockUse[]) {
  const groups = new Map<string, { status: BlockUseStatus; locale: string }>()
  for (const use of uses) {
    const key =
      use.status === "language_off" ? `${use.status}:${use.locale}` : use.status
    if (!groups.has(key))
      groups.set(key, { status: use.status, locale: use.locale })
  }
  return [...groups.values()]
}

export function BlockLifecyclePanel({
  type,
  label,
  origin,
  summary,
  starterState,
  canMutate,
  canShip,
}: {
  type: string
  label: string
  origin: "system" | "user"
  summary: BlockLifecycleSummary | null
  /** `null` means this install has no inspectable engine ship list. */
  starterState: "included" | "not-included" | null
  canMutate: boolean
  canShip: boolean
}) {
  const t = useTranslations("blocks")
  const tRow = useTranslations("pages.list.rowStatus")
  const caughtError = useCaughtError()
  const router = useRouter()
  const confirm = useConfirm()
  const prompt = usePrompt()
  const { startDeletion } = useBlockDeletion()
  const [pendingAction, setPendingAction] = useState<
    "rename" | "archive" | "ship" | null
  >(null)

  const owner = useQuery(api.cms.owner.getOwnerSession)
  const canArchive = owner !== undefined && owner !== null
  const lifecycleReady = summary !== null
  // System blocks are never deleted (ADR-0045 amendment, 2026-11-22).
  const deletable = origin === "user"
  const deleteEligible =
    deletable &&
    canMutate &&
    lifecycleReady &&
    summary.archived &&
    summary.complete &&
    summary.usageCount === 0
  const isPending = pendingAction !== null

  async function toggleArchived() {
    if (!summary || !canArchive) return
    if (!summary.archived) {
      const ok = await confirm({
        title: t("lifecycle.archiveTitle", { label }),
        description: t("lifecycle.archiveDescription"),
        confirmText: t("lifecycle.archive"),
      })
      if (!ok) return
    }

    setPendingAction("archive")
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler 1.0 cannot lower try/finally here; the finalizer is required to clear pending state on every outcome.
    try {
      await setBlockArchivedAction({
        type,
        archived: !summary.archived,
      })
      toast.success(
        summary.archived
          ? t("lifecycle.restored", { label })
          : t("lifecycle.archivedToast", { label })
      )
      router.refresh()
    } catch (error) {
      toast.error(caughtError(error, t("lifecycle.updateFailed")))
    } finally {
      setPendingAction(null)
    }
  }

  async function toggleShipped() {
    if (!canShip || starterState === null || !lifecycleReady) return
    const shipped = starterState === "included"
    setPendingAction("ship")
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler 1.0 cannot lower try/finally here; the finalizer is required to clear pending state on every outcome.
    try {
      await setStarterShippedAction({ type, shipped: !shipped })
      toast.success(
        shipped
          ? t("lifecycle.removedStarter", { label })
          : t("lifecycle.willShip", { label })
      )
      router.refresh()
    } catch (error) {
      toast.error(caughtError(error, t("lifecycle.shipFailed")))
    } finally {
      setPendingAction(null)
    }
  }

  async function renameBlock() {
    if (!canMutate || !lifecycleReady) return
    const nextLabel = await prompt({
      title: t("lifecycle.renameTitle"),
      description: t("lifecycle.renameDescription"),
      label: t("lifecycle.name"),
      defaultValue: label,
      confirmText: t("lifecycle.rename"),
    })
    if (!nextLabel || nextLabel === label) return

    setPendingAction("rename")
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler 1.0 cannot lower try/finally here; the finalizer is required to clear pending state on every outcome.
    try {
      const result = await renameBlockAction({ type, label: nextLabel })
      toast.success(t("lifecycle.renamed", { label: result.label }))
      router.refresh()
    } catch (error) {
      toast.error(caughtError(error, t("lifecycle.renameFailed")))
    } finally {
      setPendingAction(null)
    }
  }

  async function deleteBlock() {
    if (!deleteEligible) return
    const ok = await confirm({
      title: t("lifecycle.deleteTitle", { label, type }),
      description: t("lifecycle.deleteDescription"),
      confirmText: t("lifecycle.deleteConfirm"),
      destructive: true,
    })
    if (ok) startDeletion({ type, label })
  }

  const shownLocales = summary
    ? [...new Set(summary.pages.flatMap((page) => page.locales))].sort()
    : []
  // At zero uses after a finished check the usage part disappears (4b).
  const showUsage =
    summary !== null && (summary.usageCount > 0 || !summary.complete)

  const statusLabel: Record<BlockUseStatus, (locale: string) => string> = {
    draft: () => tRow("draft"),
    published: () => tRow("published"),
    published_version: () => t("lifecycle.useStatus.publishedVersion"),
    withdrawn: () => t("lifecycle.useStatus.withdrawn"),
    archived: () => tRow("archived"),
    in_trash: () => t("lifecycle.useStatus.inTrash"),
    being_erased: () => t("lifecycle.useStatus.beingErased"),
    language_off: (locale) =>
      t("lifecycle.useStatus.languageOff", { locale: locale.toUpperCase() }),
    ai_job_running: () => t("lifecycle.useStatus.aiJobRunning"),
    ai_suggestion: () => t("lifecycle.useStatus.aiSuggestion"),
  }

  // Every action states what it does; a blocked action states why instead, so
  // the panel body never has to carry a to-do list.
  const archiveHint = !lifecycleReady
    ? t("lifecycle.unavailable")
    : summary.archived
      ? t("lifecycle.restoreHint")
      : t("lifecycle.archiveHint")
  const shipHint = !lifecycleReady
    ? t("lifecycle.unavailable")
    : starterState === "included"
      ? t("lifecycle.stopShipHint")
      : t("lifecycle.shipHint")
  const renameHint = !lifecycleReady
    ? t("lifecycle.unavailable")
    : t("lifecycle.renameHint")
  const deleteHint = !lifecycleReady
    ? t("lifecycle.unavailable")
    : !summary.archived
      ? t("lifecycle.archiveFirst")
      : !summary.complete
        ? t("lifecycle.usageCheckIncomplete")
        : summary.usageCount > 0
          ? t("lifecycle.inUse", { count: summary.pageCount })
          : t("lifecycle.deleteHint")

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{t("lifecycle.title")}</CardTitle>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline">
              {origin === "system"
                ? t("lifecycle.system")
                : t("lifecycle.yourBlock")}
            </Badge>
            {summary && (
              <Badge variant={summary.archived ? "secondary" : "default"}>
                {summary.archived
                  ? t("lifecycle.archived")
                  : t("lifecycle.active")}
              </Badge>
            )}
          </div>
        </div>
        <CardDescription>{t("lifecycle.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!summary ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/5 p-3"
          >
            <p className="flex items-center gap-2 text-sm font-medium">
              <CircleAlert className="size-4 text-destructive" />
              {t("lifecycle.unavailableTitle")}{" "}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("lifecycle.unavailableDescription")}{" "}
            </p>
          </div>
        ) : (
          showUsage && (
            <>
              <dl className="grid grid-cols-2 gap-2">
                <SummaryStat
                  label={t("lifecycle.pages")}
                  value={summary.pageCount}
                />
                <SummaryStat
                  label={t("lifecycle.liveUses")}
                  value={summary.usageCount}
                />
                <SummaryStat
                  label={t("lifecycle.trashPages")}
                  value={summary.deletedPageCount}
                />
              </dl>
              {!summary.complete && (
                <p className="text-xs text-muted-foreground">
                  {t("lifecycle.usageCheckUnfinished")}
                </p>
              )}

              {summary.pages.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium">
                    {t("lifecycle.usage")}
                  </h3>
                  <ul className="space-y-2">
                    {summary.pages.map((page) => (
                      <li key={page.pageId}>
                        <Link
                          href={`/admin/pages/${page.pageId}`}
                          className="block rounded-lg border p-3 transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">
                                {page.title}
                              </p>
                              <p className="truncate text-xs text-muted-foreground">
                                {page.slug || t("lifecycle.noSlug")}
                              </p>
                            </div>
                            <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
                          </div>
                          <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
                            {/* Status labels say how to clear a use; a system
                                block is never deleted, so its rows carry none
                                (picture 7). */}
                            {deletable &&
                              statusGroups(page.uses).map(
                                ({ status, locale }) => (
                                  <Badge
                                    key={`${status}:${locale}`}
                                    variant={
                                      TRASH_STATUSES.has(status)
                                        ? "destructive"
                                        : "outline"
                                    }
                                    className="h-auto shrink whitespace-normal"
                                  >
                                    {statusLabel[status](locale)}
                                  </Badge>
                                )
                              )}
                            <span>
                              {t("lifecycle.uses", { count: page.count })} ·{" "}
                              {page.locales
                                .map((locale) => locale.toUpperCase())
                                .join(", ")}
                            </span>
                          </p>
                        </Link>
                      </li>
                    ))}
                  </ul>
                  {summary.pageCount > summary.pages.length && (
                    <p className="text-xs text-muted-foreground">
                      {t("lifecycle.morePages", {
                        count: summary.pageCount - summary.pages.length,
                      })}
                    </p>
                  )}
                  {shownLocales.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {t("lifecycle.locales", {
                        locales: shownLocales
                          .map((locale) => locale.toUpperCase())
                          .join(", "),
                      })}
                    </p>
                  )}
                </div>
              )}
            </>
          )
        )}

        {starterState && (
          <div className="rounded-lg border p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">{t("lifecycle.starter")}</span>
              <Badge
                variant={starterState === "included" ? "secondary" : "outline"}
              >
                {starterState === "included"
                  ? t("lifecycle.included")
                  : t("lifecycle.notIncluded")}
              </Badge>
            </div>
          </div>
        )}

        {/* The archive/usage preconditions are not listed here: they are not
            chores for the reader, so the reason a given action is
            unavailable rides on that action's own tooltip. */}
        <div className="flex flex-wrap gap-2 border-t pt-4">
          {canArchive && (
            <ActionTooltip hint={archiveHint}>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void toggleArchived()}
                aria-disabled={!lifecycleReady || undefined}
                disabled={isPending}
                className={BLOCKED_CLASS}
              >
                {pendingAction === "archive" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : summary?.archived ? (
                  <ArchiveRestore className="size-4" />
                ) : (
                  <Archive className="size-4" />
                )}
                {summary?.archived
                  ? t("lifecycle.restore")
                  : t("lifecycle.archive")}
              </Button>
            </ActionTooltip>
          )}
          {canShip && starterState && (
            <ActionTooltip hint={shipHint}>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void toggleShipped()}
                aria-disabled={!lifecycleReady || undefined}
                disabled={isPending}
                className={BLOCKED_CLASS}
              >
                {pendingAction === "ship" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : starterState === "included" ? (
                  <Check className="size-4" />
                ) : (
                  <Ship className="size-4" />
                )}
                {starterState === "included"
                  ? t("lifecycle.removeStarter")
                  : t("lifecycle.ship")}
              </Button>
            </ActionTooltip>
          )}
          {canMutate && (
            <>
              <ActionTooltip hint={renameHint}>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void renameBlock()}
                  aria-disabled={!lifecycleReady || undefined}
                  disabled={isPending}
                  className={BLOCKED_CLASS}
                >
                  {pendingAction === "rename" ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Pencil className="size-4" />
                  )}
                  {t("lifecycle.rename")}
                </Button>
              </ActionTooltip>
              {deletable && (
                <ActionTooltip hint={deleteHint}>
                  <Button
                    type="button"
                    size="sm"
                    variant={deleteEligible ? "destructive" : "outline"}
                    onClick={() => void deleteBlock()}
                    aria-disabled={!deleteEligible || undefined}
                    disabled={isPending}
                    className={`text-destructive hover:text-destructive ${BLOCKED_CLASS}`}
                  >
                    <Trash2 className="size-4" />
                    {t("lifecycle.delete")}{" "}
                  </Button>
                </ActionTooltip>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * Wraps one lifecycle action in its explanation.
 *
 * The button it wraps is never natively `disabled` while it is merely blocked:
 * a disabled button drops out of the tab order and receives no pointer events,
 * which would put the reason it is blocked out of reach of exactly the readers
 * who need it. It carries `aria-disabled` instead, so it stays hoverable and
 * focusable, `aria-describedby` lands on the button itself, and the trigger
 * needs no focusable wrapper. Every handler already refuses the work when its
 * own preconditions fail, so a click that lands anyway is a no-op.
 */
function ActionTooltip({
  hint,
  children,
}: {
  hint: string
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  )
}

/** Blocked actions keep the disabled look without the disabled semantics. */
const BLOCKED_CLASS =
  "aria-disabled:pointer-events-auto aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"

function SummaryStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  )
}
