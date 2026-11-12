"use client"

import { usePageAddressMessages } from "@/lib/admin/page-address-messages"

import { useMutation, useQuery } from "convex/react"
import { useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { toast } from "sonner"
import type { AdminPageHistoryHostProps } from "@/components/admin/contributions/history"
import { useConfirm } from "@/components/providers/confirm-provider"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { formatLocalDateTime } from "@/lib/i18n/local-date-format"
import { useCaughtError } from "@/lib/i18n/use-caught-error"

/** Published Snapshot history is part of core Publication, independently of M06. */
export function SnapshotHistoryPanelSlot(props: AdminPageHistoryHostProps) {
  if (!props.snapshotRestore) return null
  return (
    <SnapshotHistoryPanel {...props} snapshotRestore={props.snapshotRestore} />
  )
}

function SnapshotHistoryPanel({
  pageId,
  pageType,
  snapshotRestore,
  restoreDisabled,
  readSnapshotRestore,
  onRestored,
  onSnapshotRestored,
  captureEditorScope,
  captureRestoreReconciliation,
}: AdminPageHistoryHostProps & {
  snapshotRestore: NonNullable<AdminPageHistoryHostProps["snapshotRestore"]>
}) {
  const t = useTranslations("editor.page.snapshotHistory")
  const format = useFormatter()
  const caughtError = useCaughtError()
  const confirm = useConfirm()
  const snapshots = useQuery(api.cms.publication.listSnapshotHistory, {
    pageId,
    locale: snapshotRestore.locale,
  })
  const restore = useMutation(api.cms.publication.restoreSnapshotAsDraft)
  const site = useQuery(api.cms.settings.getSiteConfig)
  const addressMessages = usePageAddressMessages(site?.defaultLocale ?? "en")
  const [restoring, setRestoring] = useState(false)
  async function handleRestore(snapshotId: Id<"pagePublishedSnapshots">) {
    const isCurrent = captureEditorScope?.() ?? (() => true)
    const reconcile = captureRestoreReconciliation?.()
    if (restoreDisabled || restoring) return
    // Capture the reviewed generations before the asynchronous confirmation,
    // from the editor's own base. Without one there is nothing safe to send.
    const expectations = readSnapshotRestore?.()
    if (!expectations) {
      toast.error(t("failed"))
      return
    }
    const reviewed = {
      pageId,
      snapshotId,
      locale: snapshotRestore.locale,
      ...expectations,
    }
    if (
      !(await confirm({
        title: t("confirmTitle"),
        description: t("confirmDescription"),
        confirmText: t("restore"),
        cancelText: t("cancel"),
      }))
    )
      return
    if (!isCurrent()) return
    setRestoring(true)
    try {
      const result = await restore(reviewed)
      reconcile?.(result)
      if (!isCurrent()) return
      onSnapshotRestored?.(result)
      onRestored(result.updatedAt, result.removedTitleLinks)
      toast.success(
        addressMessages.restored(
          result.addressNotices,
          "S4",
          t("restored"),
          "",
          pageType ?? "page"
        )
      )
    } catch (err) {
      if (!isCurrent()) return
      toast.error(caughtError(err, t("failed")))
    } finally {
      setRestoring(false)
    }
  }
  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <h2 className="text-sm font-medium">
        {t("title", { locale: snapshotRestore.locale.toUpperCase() })}
      </h2>
      <p className="text-xs text-muted-foreground">{t("description")}</p>
      {restoreDisabled && <p className="text-sm">{t("saveFirst")}</p>}
      {!snapshots ? (
        <p>{t("loading")}</p>
      ) : snapshots.length === 0 ? (
        <p>{t("empty")}</p>
      ) : (
        snapshots.map((snapshot) => (
          <article key={snapshot.snapshotId} className="rounded-md border p-4">
            <p>{t("version", { generation: snapshot.generation })}</p>
            <p className="text-xs text-muted-foreground">
              {formatLocalDateTime(format, snapshot.publishedAt)}
            </p>
            {snapshot.unavailablePaths.length > 0 && (
              <p className="text-sm text-destructive">
                {t("unavailable", {
                  paths: snapshot.unavailablePaths.join(", "),
                })}
              </p>
            )}
            <button
              type="button"
              disabled={
                restoreDisabled ||
                restoring ||
                snapshot.unavailablePaths.length > 0
              }
              onClick={() => void handleRestore(snapshot.snapshotId)}
              className="mt-2 rounded-md border px-2.5 py-1 text-xs disabled:opacity-50"
            >
              {t("restore")}
            </button>
          </article>
        ))
      )}
    </div>
  )
}
