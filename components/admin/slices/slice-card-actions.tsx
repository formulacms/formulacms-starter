"use client"

import { useTranslations } from "next-intl"
import { useState } from "react"
import { Archive, ArchiveRestore, Check, Loader2, Ship } from "lucide-react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import {
  setSliceArchivedAction,
  setStarterShippedAction,
} from "@/app/(core)/admin/(authenticated)/slices/actions"
import { useConfirm } from "@/components/providers/confirm-provider"
import { Button } from "@/components/ui/button"

/**
 * The two lifecycle actions the catalog can honestly offer.
 *
 * Both states are already loaded by /admin/slices for every tile (the Active /
 * Archived split and the "In starter" badge are rendered from them), so acting
 * on them here costs no extra read. Rename and Delete stay on the detail route:
 * Delete's eligibility depends on the per-type saved/staged usage summary, and
 * loading that for every tile is the full-table scan the catalog must not do.
 */
export function SliceCardActions({
  type,
  label,
  archived,
  canArchive,
  canShip,
  shipped,
}: {
  type: string
  label: string
  archived: boolean
  /** `settings:update` — archiving is a settings change, not a file write. */
  canArchive: boolean
  /** Engine-only: the ship-list resolves *and* this is a local dev server. */
  canShip: boolean
  shipped: boolean
}) {
  const t = useTranslations("slices.lifecycle")
  const caughtError = useCaughtError()
  const router = useRouter()
  const confirm = useConfirm()
  const [pendingAction, setPendingAction] = useState<"archive" | "ship" | null>(
    null
  )
  const isPending = pendingAction !== null

  if (!canArchive && !canShip) return null

  async function toggleArchived() {
    if (!archived) {
      const ok = await confirm({
        title: t("archiveTitle", { label }),
        description: t("archiveCatalogDescription"),
        confirmText: t("archive"),
      })
      if (!ok) return
    }

    setPendingAction("archive")
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler 1.0 cannot lower try/finally here; the finalizer is required to clear pending state on every outcome.
    try {
      await setSliceArchivedAction({ type, archived: !archived })
      toast.success(
        archived ? t("restored", { label }) : t("archivedToast", { label })
      )
      router.refresh()
    } catch (error) {
      toast.error(caughtError(error, t("updateFailed")))
    } finally {
      setPendingAction(null)
    }
  }

  // Reversible selection, not a destructive change — no confirmation step.
  async function toggleShipped() {
    setPendingAction("ship")
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler 1.0 cannot lower try/finally here; the finalizer is required to clear pending state on every outcome.
    try {
      await setStarterShippedAction({ type, shipped: !shipped })
      toast.success(
        shipped ? t("removedStarter", { label }) : t("willShip", { label })
      )
      router.refresh()
    } catch (error) {
      toast.error(caughtError(error, t("shipFailed")))
    } finally {
      setPendingAction(null)
    }
  }

  return (
    <>
      {canArchive && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void toggleArchived()}
          disabled={isPending}
          title={archived ? t("restoreCatalogHint") : t("archiveCatalogHint")}
        >
          {pendingAction === "archive" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : archived ? (
            <ArchiveRestore className="size-4" />
          ) : (
            <Archive className="size-4" />
          )}
          {archived ? t("restore") : t("archive")}
        </Button>
      )}

      {canShip && (
        <Button
          type="button"
          size="sm"
          variant={shipped ? "secondary" : "outline"}
          onClick={() => void toggleShipped()}
          disabled={isPending}
          title={shipped ? t("stopShipCatalogHint") : t("shipCatalogHint")}
        >
          {pendingAction === "ship" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : shipped ? (
            <Check className="size-4" />
          ) : (
            <Ship className="size-4" />
          )}
          {shipped ? t("removeStarter") : t("ship")}
        </Button>
      )}
    </>
  )
}
