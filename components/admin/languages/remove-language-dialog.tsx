"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { getLocaleDisplayName } from "@/lib/i18n/config"
import { useLanguageRun, languagesErrorMessage } from "./errors"
import {
  PreviewCounts,
  PreviewReview,
  recordReceipts,
  useReviewPages,
  Working,
} from "./impact-review"
import { commandTokenArgs } from "./tokens"
import type {
  ImpactPreview,
  LanguagesActions,
  LanguagesQueries,
  LanguagesState,
} from "./types"

/**
 * Remove a language. The existing removal preview supplies the counts and the
 * list to check; nothing is deleted. Two languages go through the combined
 * command that also returns the site to one language.
 */
export function RemoveLanguageDialog({
  locale,
  state,
  actions,
  queries,
  needsAdoption = false,
  onClose,
}: {
  locale: string
  state: LanguagesState
  actions: LanguagesActions
  queries: LanguagesQueries
  /**
   * The site has several languages but is not adopted yet. The counting
   * preview needs it adopted, so that step waits for the owner's click here
   * and nothing is written when the menu item is chosen.
   */
  needsAdoption?: boolean
  onClose: () => void
}) {
  const t = useTranslations("settings.multilingualLanguages")
  const run = useLanguageRun()
  const language = getLocaleDisplayName(locale)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewId, setPreviewId] = useState<ImpactPreview["previewId"] | null>(
    null
  )
  const [adopted, setAdopted] = useState(!needsAdoption)
  const started = useRef(false)
  const preview =
    previewId === null
      ? undefined
      : state.latestPreviews.find((entry) => entry.previewId === previewId)
  const review = useReviewPages(
    preview?.pageCount ?? 0,
    (preview?.reviewedThroughOrdinal ?? -1) + 1
  )
  const reviewReady =
    preview !== undefined && preview.phase === "complete" && review.status.ready
  const lastExtra = state.enabledLocales.length === 2

  // Two kinds of expiring impact preview start here, and neither removes a
  // language or touches the Modules switch before "Remove" is confirmed:
  // - on an adopted site, opening the dialog starts the preview;
  // - on an older unadopted multi-language site, "Count what is affected"
  //   adopts the site first (multi-language sites run under Multilingual),
  //   then starts it.
  useEffect(() => {
    if (!adopted || started.current) return
    started.current = true
    run(() => actions.startLanguageImpactPreview({ kind: "remove", locale }))
      .then((result) => {
        if (result) setPreviewId(result.previewId)
      })
      .catch((caught: unknown) => setError(languagesErrorMessage(t, caught)))
  }, [actions, locale, t, adopted, run])

  async function prepare() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const prepared = await run(() =>
        actions.prepareLanguageChange(commandTokenArgs(state))
      )
      if (!prepared) return
      setAdopted(true)
    } catch (caught) {
      setError(languagesErrorMessage(t, caught))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (busy || !preview || !reviewReady) return
    setBusy(true)
    setError(null)
    const claim = {
      previewId: preview.previewId,
      expectedDigest: preview.digest,
      expectedCount: preview.count,
    }
    try {
      const recorded = await recordReceipts(review.status.receipts, (receipt) =>
        run(() =>
          actions.recordLanguageImpactReview({
            previewId: preview.previewId,
            ...receipt,
          })
        ).then((result) => result ?? { stale: true as const })
      )
      if (!recorded) {
        setError(t("errors.stale"))
        return
      }
      const removed = lastExtra
        ? await run(() => actions.removeLastExtraLanguage(claim))
        : await run(() => actions.removeLanguage(claim))
      if (!removed) return
      toast.success(t("remove.removed", { language }))
      onClose()
    } catch (caught) {
      setError(languagesErrorMessage(t, caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("remove.title", { language })}</DialogTitle>
          <DialogDescription>
            {t("remove.description", { language, locale })}
          </DialogDescription>
        </DialogHeader>

        {!adopted ? null : preview === undefined ? (
          error ? null : (
            <Working label={t("remove.counting")} />
          )
        ) : (
          <div className="space-y-4">
            <PreviewCounts count={preview.count} />
            <PreviewReview
              preview={preview}
              queries={queries}
              review={review}
              addressContext={{
                locale,
                defaultLocale: state.defaultLocale ?? locale,
              }}
            />
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("cancel")}
          </Button>
          {adopted ? (
            <Button
              variant="destructive"
              disabled={busy || !reviewReady}
              onClick={() => void remove()}
            >
              {t("remove.confirm")}
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => void prepare()}>
              {t("remove.continue")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
