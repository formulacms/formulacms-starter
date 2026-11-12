"use client"

import { useTranslations } from "next-intl"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import { useState } from "react"
import { toast } from "sonner"
import { replaceSourceImageAction } from "@/app/(sim)/slice-sim/[type]/actions"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  MAX_MEDIA_FILE_SIZE,
  formatBytes,
} from "@/lib/media/snapshot-image-client"
import {
  parseDesignWidth,
  readDesignForUpload,
  type DesignUpload,
} from "@/lib/slices/authoring/design-upload"
import type { SliceReferenceVariant } from "@/lib/slices/authoring/reference"

/**
 * The shared "replace a slice's design" interaction (slice-fidelity plan §5 B2,
 * "Interactive semantics"). Both replace surfaces use it so the width question
 * is asked identically and neither can save a design without one.
 *
 * Nothing is uploaded until the width is answered: the file is held in the
 * browser, the prompt shows its pixel width, and only then does the single
 * ingestion path run.
 */
export function useDesignReplace({
  type,
  variant,
  onSaved,
}: {
  type: string
  variant: SliceReferenceVariant
  onSaved: (url: string) => void
}) {
  const t = useTranslations("slices.design")
  const caughtError = useCaughtError()
  const [pending, setPending] = useState<DesignUpload | null>(null)
  const [widthAnswer, setWidthAnswer] = useState("")
  const [widthError, setWidthError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  async function acceptFile(file: File | null | undefined) {
    if (!file) return
    if (!file.type.startsWith("image/")) {
      toast.error(t("chooseImage"))
      return
    }
    if (file.size > MAX_MEDIA_FILE_SIZE) {
      toast.error(t("smallerImage", { max: formatBytes(MAX_MEDIA_FILE_SIZE) }))
      return
    }
    try {
      const upload = await readDesignForUpload(file)
      setWidthAnswer("")
      setWidthError(null)
      setPending(upload)
    } catch (error) {
      toast.error(caughtError(error, t("readFailed")))
    }
  }

  async function save() {
    if (!pending) return
    const width = parseDesignWidth(widthAnswer)
    if (!width.ok) {
      setWidthError(
        t(widthAnswer.trim() === "" ? "widthRequired" : "widthInvalid")
      )
      return
    }

    setIsSaving(true)
    try {
      const result = await replaceSourceImageAction({
        type,
        variant,
        dataUrl: pending.dataUrl,
        mediaType: pending.mediaType,
        cssWidth: width.cssWidth,
      })
      if (result.ok) {
        setPending(null)
        onSaved(result.url)
        toast.success(
          t(variant === "mobile" ? "mobileUpdated" : "desktopUpdated"),
          {
            description: result.note ? t("scaleWarning") : undefined,
          }
        )
      } else {
        toast.error(t("saveFailed"), {
          description: t(
            result.reason === "rollback-failed"
              ? "rollbackFailed"
              : result.reason === "rolled-back"
                ? "rolledBack"
                : "saveRefused"
          ),
        })
      }
    } catch (error) {
      toast.error(caughtError(error, t("saveFailed")))
    }
    setIsSaving(false)
  }

  const prompt = (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open && !isSaving) setPending(null)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("widthQuestion")}</DialogTitle>
          <DialogDescription>
            {pending
              ? t("widthDescription", { width: pending.pixelWidth })
              : null}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={`design-css-width-${type}-${variant}`}>
            {t("widthLabel")}
          </Label>
          <Input
            id={`design-css-width-${type}-${variant}`}
            inputMode="numeric"
            placeholder="1440"
            value={widthAnswer}
            disabled={isSaving}
            onChange={(event) => {
              setWidthAnswer(event.target.value)
              setWidthError(null)
            }}
          />
          {widthError && (
            <p className="text-sm text-destructive">{widthError}</p>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={isSaving}
            onClick={() => setPending(null)}
          >
            {t("cancel")}
          </Button>
          <Button type="button" disabled={isSaving} onClick={() => void save()}>
            {isSaving
              ? t("saving")
              : t(variant === "mobile" ? "saveMobile" : "saveDesktop")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  return { acceptFile, isSaving, prompt }
}
