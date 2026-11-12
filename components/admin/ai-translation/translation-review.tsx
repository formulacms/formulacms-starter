"use client"

import { useId, useState } from "react"
import { useMutation, useQueries } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import { ConvexError } from "convex/values"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"
import { Check, X } from "lucide-react"
import { api } from "@/convex/_generated/api"
import { Button } from "@/components/ui/button"
import type { Locale } from "@/lib/i18n/config"
import type { LocaleContentSummary } from "../page-editor/lib/types"
import type { PageJob } from "../ai-writing/page-jobs"
import type { AdminAiTranslationHostInput } from "../contributions/ai-translation"

type PageJobResult = FunctionReturnType<typeof api.cms.aiJobs.pageJobResult>

/** A language's name in the interface language ("French", "français"). */
export function useLanguageName() {
  const interfaceLocale = useLocale()
  return (code: string) => {
    try {
      return (
        new Intl.DisplayNames([interfaceLocale], { type: "language" }).of(
          code
        ) ?? code
      )
    } catch {
      return code
    }
  }
}

/** French elides its article before a vowel ("L'anglais", "Le français"). */
const elided = (name: string) =>
  /^[aeiouàâäéèêëîïôöùûü]/i.test(name) ? "yes" : "no"

const isCode = (error: unknown, code: string) =>
  error instanceof ConvexError && error.data === code

/**
 * The review list under a done translation card. One Accept saves the whole
 * page into the target language's draft; nothing is published.
 */
export function TranslationReview({
  job,
  dismiss,
  getLocaleSummary,
  ensureSaved,
  beginSavedLanguage,
}: {
  job: PageJob
  dismiss: () => Promise<void>
  getLocaleSummary: (locale: Locale) => LocaleContentSummary
  ensureSaved: () => Promise<boolean>
  beginSavedLanguage?: AdminAiTranslationHostInput["beginSavedLanguage"]
}) {
  const t = useTranslations("pages.aiTranslate.review")
  const tWrite = useTranslations("pages.aiWrite.review")
  const languageName = useLanguageName()
  const headingId = useId()
  const accept = useMutation(api.cms.aiJobs.acceptPageJob)
  // Created once: the card renders this list keyed by job id (see page-jobs).
  const [request] = useState(() => ({
    result: { query: api.cms.aiJobs.pageJobResult, args: { jobId: job.jobId } },
  }))
  const { result } = useQueries(request) as {
    result?: PageJobResult | Error
  }
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  if (result === undefined || result instanceof Error) return null
  const target = (result.targetLocale ?? job.targetLocale ?? job.locale) as Locale
  const source = result.sourceLocale ?? job.sourceLocale ?? ""
  const targetName = languageName(target)
  const sourceName = languageName(source)
  const knownLabels: Record<string, string> = {
    Title: t("title"),
    "Meta title": t("metaTitle"),
    "Meta description": t("metaDescription"),
  }
  const rows: { label: string; lines: string[] }[] = [
    ...(result.pageFields ?? []).map((field) => ({
      label: knownLabels[field.label] ?? field.label,
      lines: [field.text],
    })),
    ...result.sections.map((section) => ({
      label: t("section", { number: section.index + 1 }),
      lines: section.fields.map((field) => field.text),
    })),
  ]

  async function acceptAll() {
    // Text typed in the target language and not yet saved would be lost.
    if (getLocaleSummary(target).hasAny) {
      setConflict(true)
      return
    }
    setSaving(true)
    setSaveFailed(false)
    // Started at the press: text typed from now on is kept by the reload.
    const reload = beginSavedLanguage?.(target)
    // Save the open tab first: the reload after Accept starts from saved text.
    const editorSaved = await ensureSaved().catch(() => false)
    if (!editorSaved) {
      setSaving(false)
      setSaveFailed(true)
      return
    }
    // .then with two arms, not try: the React Compiler skips some try blocks.
    const outcome = await accept({ jobId: job.jobId, chosen: [] }).then(
      (saved) => ({ saved, error: undefined }),
      (error: unknown) => ({ saved: undefined, error })
    )
    setSaving(false)
    if (outcome.saved === undefined) {
      if (isCode(outcome.error, "AI_JOB_TARGET_CHANGED")) setConflict(true)
      else setSaveFailed(true)
      return
    }
    toast.success(t("saved"))
    const generation = outcome.saved.draftGeneration
    if (generation !== undefined) reload?.complete(generation)
  }

  return (
    <section
      data-testid="translation-review"
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-md border p-3 text-sm"
    >
      <div>
        <h3 id={headingId} className="font-medium">
          {t("heading", { language: targetName })}
        </h3>
        {result.sourceChanged && (
          <p data-testid="source-changed" className="text-muted-foreground">
            {t("sourceChanged", {
              language: sourceName,
              elided: elided(sourceName),
            })}
          </p>
        )}
      </div>
      <ul className="divide-y border-y">
        {rows.map((row, index) => (
          <li
            key={index}
            data-testid="review-row"
            className="flex flex-col gap-1 py-3"
          >
            <span className="text-sm leading-none font-medium">
              {row.label}
            </span>
            {row.lines.map((line, lineIndex) => (
              <p
                key={lineIndex}
                data-testid="review-text"
                className="break-words"
              >
                {line}
              </p>
            ))}
          </li>
        ))}
      </ul>
      {conflict && (
        <p
          role="alert"
          data-testid="target-changed"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive"
        >
          {t("targetChanged", {
            language: targetName,
            elided: elided(targetName),
          })}
        </p>
      )}
      {saveFailed && (
        <p
          role="alert"
          data-testid="save-error"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive"
        >
          {tWrite("saveFailed")}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-testid="accept-translation"
          disabled={conflict || saving}
          onClick={acceptAll}
        >
          <Check />
          {t("accept")}
        </Button>
        <Button
          variant="outline"
          data-testid="dismiss-translation"
          onClick={dismiss}
        >
          <X />
          {t("dismiss")}
        </Button>
      </div>
    </section>
  )
}
