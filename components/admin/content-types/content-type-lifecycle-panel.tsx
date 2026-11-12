"use client"

import { useState } from "react"
import { Archive, ArchiveRestore, Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useQuery } from "convex/react"
import { useTranslations } from "next-intl"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import {
  setContentTypeArchivedAction,
  setContentTypeStarterAction,
} from "@/app/(core)/admin/(authenticated)/content-types/actions"
import { useConfirm } from "@/components/providers/confirm-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export function ContentTypeLifecyclePanel({
  type,
  label,
  archived,
  starter,
}: {
  type: string
  label: string
  /** `null` means the authoritative lifecycle query is still loading. */
  archived: boolean | null
  /** Only exact built-in admin on the local engine receives this control. */
  starter: { included: boolean } | null
}) {
  const displayError = useCaughtError()
  const t = useTranslations("inventory.contentTypes.lifecycle")
  const router = useRouter()
  const confirm = useConfirm()
  const owner = useQuery(api.cms.owner.getOwnerSession)
  const [pending, setPending] = useState(false)
  const [starterPending, setStarterPending] = useState(false)
  const canArchive = owner !== undefined && owner !== null
  const ready = archived !== null

  async function toggleArchived() {
    if (!ready || !canArchive) return
    if (!archived) {
      const confirmed = await confirm({
        title: t("confirmTitle", { label }),
        description: t("confirmDescription"),
        confirmText: t("archive"),
      })
      if (!confirmed) return
    }

    setPending(true)
    void setContentTypeArchivedAction({ type, archived: !archived })
      .then(() => {
        toast.success(
          archived ? t("restored", { label }) : t("archived", { label })
        )
        router.refresh()
      })
      .catch((error) => {
        toast.error(
          displayError(error, t("updateFailed"))
        )
      })
      .finally(() => setPending(false))
  }

  function toggleStarter() {
    if (!starter || starterPending) return
    setStarterPending(true)
    void setContentTypeStarterAction({
      type,
      inStarter: !starter.included,
    })
      .then(() => {
        toast.success(
          starter.included
            ? t("removedFromStarter", { label })
            : t("addedToStarter", { label })
        )
        router.refresh()
      })
      .catch((error) => {
        toast.error(
          displayError(error, t("starterUpdateFailed"))
        )
      })
      .finally(() => setStarterPending(false))
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">{t("title")}</CardTitle>
            <CardDescription>
              {t("description")}
            </CardDescription>
          </div>
          <Badge
            variant={
              archived === null ? "outline" : archived ? "secondary" : "default"
            }
          >
            {archived === null
              ? t("loading")
              : archived
                ? t("archivedStatus")
                : t("active")}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {archived === null
            ? t("loadingDescription")
            : archived
              ? t("archivedDescription")
              : t("activeDescription")}
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => void toggleArchived()}
          disabled={!ready || !canArchive || pending}
          title={
            !canArchive
              ? t("permissionTitle")
              : !ready
                ? t("loadingTitle")
                : undefined
          }
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : archived === null ? (
            <Archive className="size-4" />
          ) : archived ? (
            <ArchiveRestore className="size-4" />
          ) : (
            <Archive className="size-4" />
          )}
          {archived === null
            ? t("loadingAction")
            : archived
              ? t("restore")
              : t("archive")}
        </Button>
        {!canArchive && (
          <p className="text-xs text-muted-foreground">
            {t("permissionDescription")}
          </p>
        )}
        {starter && (
          <div className="space-y-3 border-t pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">{t("starterTitle")}</p>
              <Badge variant="outline">
                {starter.included ? t("inStarter") : t("notInStarter")}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("starterDescription")}
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => void toggleStarter()}
              disabled={starterPending}
            >
              {starterPending && <Loader2 className="size-4 animate-spin" />}
              {starter.included
                ? t("removeFromStarter")
                : t("addToStarter")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
