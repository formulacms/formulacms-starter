"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { Archive, ArchiveRestore, LockKeyhole, ShieldCheck } from "lucide-react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import {
  resolveSlicePresentation,
  type SlicePresentationCatalog,
} from "@/convex/lib/slices/presentationResolution"
import { setPresentationArchivedAction } from "@/app/(core)/admin/(authenticated)/slices/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import { SlicePresentationPreview } from "./slice-presentation-preview"
import { ArchivedContentTypesErrorBoundary } from "../content-types/use-archived-content-types"

type Change = {
  type: string
  presentationId: string
  archived: boolean
  expectedCatalogRevision: string
}

/** The approved curation surface currently covers only the owned Hero choices. */
export function SlicePresentationPanel({ type }: { type: string }) {
  if (type !== "hero-with-image") return null
  return <OwnerPresentationPanel key={type} type={type} />
}

function OwnerPresentationPanel({ type }: { type: string }) {
  const t = useTranslations("slices.presentations")
  const router = useRouter()
  const owner = useQuery(api.cms.owner.getOwnerSession)
  const catalog = useQuery(
    api.cms.slices.getPresentationCatalog,
    owner ? {} : "skip"
  )
  const [pending, startTransition] = useTransition()
  const [failed, setFailed] = useState(false)
  const alive = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  function confirm(change: Change) {
    if (
      !owner ||
      !catalog ||
      pending ||
      change.expectedCatalogRevision !== catalog.revision
    )
      return
    setFailed(false)
    startTransition(async () => {
      try {
        await setPresentationArchivedAction(change)
        if (alive.current) router.refresh()
      } catch {
        if (alive.current) setFailed(true)
      }
    })
  }

  const available =
    owner &&
    catalog &&
    catalog.entries
      .filter((entry) => entry.type === type)
      .every(
        (entry) =>
          resolveSlicePresentation(catalog, {
            type,
            presentationId: entry.id,
            intent: "existing",
          }).status === "resolved"
      ) &&
    resolveSlicePresentation(catalog, {
      type,
      presentationId: "default",
      intent: "new-assignment",
      expectedCatalogRevision: catalog.revision,
    }).status === "resolved"

  return (
    <section aria-label={t("title")} className="flex min-w-0 flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      {available ? (
        <PresentationCards
          key={`${owner.ownerId}:${catalog.revision}`}
          type={type}
          catalog={catalog}
          pending={pending}
          confirm={confirm}
        />
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {t("unavailable")}
        </p>
      )}
      {failed && (
        <p role="status" className="text-sm text-destructive">
          {t("failed")}
        </p>
      )}
    </section>
  )
}

/** A new trusted revision discards pending Archive or Restore consent. */
function PresentationCards({
  type,
  catalog,
  pending,
  confirm,
}: {
  type: string
  catalog: SlicePresentationCatalog
  pending: boolean
  confirm: (change: Change) => void
}) {
  const t = useTranslations("slices.presentations")
  const labels = useTranslations("editor.sliceEditor.presentation")
  const presentationLabel = (entry: { id: string; label: string }) =>
    entry.id === "default" || entry.id === "centered"
      ? labels(entry.id)
      : entry.label
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const changing = catalog.entries.find(
    (entry) =>
      entry.type === type &&
      entry.id === confirmation &&
      entry.id !== "default" &&
      (entry.state === "active" || entry.state === "archived")
  )
  const restoring = changing?.state === "archived"
  const ConfirmationIcon = restoring ? ArchiveRestore : Archive
  return (
    <>
      <div className="grid min-w-0 gap-4 min-[761px]:grid-cols-2">
        {catalog.entries
          .filter((entry) => entry.type === type)
          .map((entry) => {
            const label = presentationLabel(entry)
            const required = entry.id === "default"
            const archived = entry.state === "archived"
            const actionLabel = t(archived ? "restore" : "archive", { label })
            const ActionIcon = archived ? ArchiveRestore : Archive
            return (
              <Card key={entry.id} className="gap-4 pt-0">
                <SlicePresentationPreview
                  presentationId={entry.id}
                  label={label}
                />
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle>{label}</CardTitle>
                    <Badge
                      variant={!required && !archived ? "default" : "outline"}
                    >
                      {required && (
                        <LockKeyhole
                          aria-hidden={true}
                          data-icon="inline-start"
                        />
                      )}
                      {t(
                        required ? "required" : archived ? "archived" : "active"
                      )}
                    </Badge>
                  </div>
                  <CardDescription>
                    {required ? (
                      t("available")
                    ) : archived ? (
                      t("archivedDescription")
                    ) : (
                      <ArchivedContentTypesErrorBoundary
                        key={`${type}:${entry.id}:${catalog.revision}`}
                        fallback={
                          <span role="status">{t("countUnavailable")}</span>
                        }
                      >
                        <PresentationOccurrenceCount
                          type={type}
                          presentationId={entry.id}
                        />
                      </ArchivedContentTypesErrorBoundary>
                    )}
                  </CardDescription>
                </CardHeader>
                {required && (
                  <CardContent>
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      <LockKeyhole
                        className="size-4 shrink-0"
                        aria-hidden={true}
                      />
                      {t("fallback")}
                    </p>
                  </CardContent>
                )}
                <CardFooter className="justify-end">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={required ? t("locked") : actionLabel}
                        disabled={required || pending}
                        onClick={
                          required ? undefined : () => setConfirmation(entry.id)
                        }
                      >
                        <ActionIcon aria-hidden={true} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {required ? t("locked") : actionLabel}
                    </TooltipContent>
                  </Tooltip>
                </CardFooter>
              </Card>
            )
          })}
      </div>
      {changing && (
        <div
          role="group"
          aria-label={t(restoring ? "restoreQuestion" : "archiveQuestion", {
            label: presentationLabel(changing),
          })}
          className="space-y-3 rounded-lg border bg-muted/30 p-4"
        >
          <h3 className="flex items-center justify-between gap-2 font-semibold">
            {t(restoring ? "restoreQuestion" : "archiveQuestion", {
              label: presentationLabel(changing),
            })}
            <ConfirmationIcon className="size-4" aria-hidden={true} />
          </h3>
          <p className="text-sm text-muted-foreground">
            {t(restoring ? "restoreConsequence" : "archiveConsequence", {
              label: presentationLabel(changing),
            })}
          </p>
          <p className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
            <ShieldCheck className="size-4 shrink-0" aria-hidden={true} />
            {t("noContentChange")}
          </p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => setConfirmation(null)}
            >
              {t("cancel")}
            </Button>
            <Button
              type="button"
              aria-label={t(restoring ? "confirmRestore" : "confirmArchive", {
                label: presentationLabel(changing),
              })}
              disabled={pending}
              onClick={() =>
                confirm({
                  type,
                  presentationId: changing.id,
                  archived: !restoring,
                  expectedCatalogRevision: catalog.revision,
                })
              }
            >
              <ConfirmationIcon aria-hidden={true} data-icon="inline-start" />
              {t(restoring ? "restoreButton" : "archiveButton")}
            </Button>
          </div>
        </div>
      )}
    </>
  )
}

/** Count subscription failures cannot disable the containing curation card. */
function PresentationOccurrenceCount({
  type,
  presentationId,
}: {
  type: string
  presentationId: string
}) {
  const t = useTranslations("slices.presentations")
  const summary = useQuery(
    api.cms.sliceLibrary.getSlicePresentationUsageSummary,
    {
      type,
      presentationIds: [presentationId],
    }
  )
  if (summary === undefined)
    return <span role="status">{t("countLoading")}</span>
  const count =
    summary.status === "ready" ? summary.counts[presentationId] : undefined
  return (
    <span role="status">
      {count === undefined ? t("countUnavailable") : t("count", { count })}
    </span>
  )
}
